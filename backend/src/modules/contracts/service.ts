// Contracts (spec §4; rules C1–C12, D1–D5; owner decisions D-3, D-29, D-30).
//
// Transition map (D-29):
//   Draft ─submit→ PendingApproval ─approve→ Approved (future) / Active (covers today)
//   PendingApproval ─return→ Draft
//   Approved | Active ─suspend→ Suspended ─reinstate→ Approved / Active (by date)
//   Approved | Active ─terminate→ Terminated (final)
//   Expired: set only by the daily job when the end date passes (jobs/daily-transition.ts).
//   Superseded: never set by hand ("silent superseding has been removed", §4.2).
// The creator and the submitter may not approve (D-30), and nobody acts on
// their own contract. Every change re-evaluates eligibility in its transaction (L6).
//
// Renewal timing (owner decision D-41): a renewal may be created and approved
// while the current contract still covers — the next period sits next to it
// (§4.2, C12). V03's C7 (renew only after coverage lapsed) is not used.
//
// Renewal needs valid credentials (owner decision, 2026-10-02): a contract for
// someone who has had a contract before — a renewal, or a new contract after
// the old one ended — is neither created nor approved while a MANDATORY
// credential of their unit and position is missing, expired, unverified,
// suspended or revoked (or they have no unit, so none can be checked). Only the
// credential reasons count: the contract-coverage reason is ignored, or an
// expired contract could never be renewed. Grace, waivers and transition
// warnings pass, as they do for eligibility. A first contract is not gated.
//
// Employment contract type (owner decision 2026-10-03): every new contract and
// renewal names an active type from the hospital's list (contract-types.ts). A
// renewal keeps the previous contract's type unless another is chosen. There is
// no editing afterwards: the approver approves the type with the contract.
// Contracts from before the field stay unclassified (null). Information only —
// eligibility, renewal and approval rules do not read it.

import { z } from 'zod';
import type { Contract, ContractStatus } from '../../generated/prisma/client.js';
import { appendAudit } from '../../lib/audit.js';
import { addDays, daysBetween, dbDate, isIsoDate, riyadhDate, toDbDate } from '../../lib/dates.js';
import { toHijriIso } from '../../lib/hijri.js';
import { conflict, HttpError, notFound, unprocessable } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { scanOrReject, type UploadScanner } from '../../lib/scanner.js';
import { checkUpload } from '../../lib/uploads.js';
import type { DocumentAccess } from '../documents/access.js';
import { evaluateFor, refreshEligibility } from '../eligibility/state.service.js';
import { HR_ROLES, inScope, viewerOf, type Viewer } from '../credentials/access.js';
import { unitScope, type AuthContext } from '../users/access.js';
import { assertActiveContractType, ContractTypeCode as TypeCode } from './contract-types.js';

const IsoDate = z.string().refine(isIsoDate, 'YYYY-MM-DD');
const Reason = z.string().trim().min(5, 'A reason of at least 5 characters is required').max(500);

// The type is chosen at Onboard employee (owner decision 2026-10-04): a new contract or renewal carries the
// employee's previous type unless one is given (the API still accepts it).
export const CreateBody = z.strictObject({ employeeId: z.number().int().positive(), startDate: IsoDate, endDate: IsoDate, contractTypeCode: TypeCode.optional() });
export const RenewBody = z.strictObject({ startDate: IsoDate.optional(), endDate: IsoDate.optional(), contractTypeCode: TypeCode.optional() });
export const TransitionBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('submit') }),
  z.strictObject({ action: z.literal('approve') }),
  z.strictObject({ action: z.literal('return'), reason: Reason }),
  z.strictObject({ action: z.literal('suspend'), reason: Reason }),
  z.strictObject({ action: z.literal('reinstate'), reason: Reason }),
  z.strictObject({ action: z.literal('terminate'), reason: Reason }),
]);
const STATUSES = ['Draft', 'PendingApproval', 'Approved', 'Active', 'Expired', 'Suspended', 'Terminated', 'Superseded'] as const;
/** Employee pickers: server-side search by job number or name, a page of matches. */
export const PickerQuery = z.object({
  q: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const pickerMatch = (q: string | undefined) =>
  q ? { OR: [{ jobNumber: { contains: q, mode: 'insensitive' as const } }, { fullName: { contains: q, mode: 'insensitive' as const } }] } : {};

export const ListQuery = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
  status: z.enum(STATUSES).optional(),
  contractTypeCode: z.string().trim().min(1).max(20).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type Action = z.infer<typeof TransitionBody>['action'];
const COVERING: readonly ContractStatus[] = ['Approved', 'Active'];

/** D-29 as data: which statuses each action accepts. */
export const TRANSITIONS: Record<Action, readonly ContractStatus[]> = {
  submit: ['Draft'],
  return: ['PendingApproval'],
  approve: ['PendingApproval'],
  suspend: ['Approved', 'Active'],
  reinstate: ['Suspended'],
  terminate: ['Approved', 'Active'],
};

/** C2: a period covering today is Active; a future one stays Approved until its start. */
export function coveringStatus(start: string, end: string, today: string): 'Active' | 'Approved' | null {
  if (end < today) return null;
  return start <= today ? 'Active' : 'Approved';
}

/** C8: the day after the previous end, same length (inclusive dates). */
export function renewalPeriodAfter(prior: { startDate: string; endDate: string }) {
  const start = addDays(prior.endDate, 1);
  return { start, end: addDays(start, daysBetween(prior.startDate, prior.endDate)) };
}

type TypeRef = { code: string; name: string; nameAr: string | null } | null;
type WithRefs = Contract & { employee: { fullName: string; unitId: number | null; positionCode: string; unit: { code: string } | null }; contractType: TypeRef };
const INCLUDE = {
  employee: { select: { fullName: true, unitId: true, positionCode: true, unit: { select: { code: true } } } },
  contractType: { select: { code: true, name: true, nameAr: true } },
} as const;

function dates(c: Contract) {
  return { startDate: dbDate(c.startDate), endDate: dbDate(c.endDate), startDateHijri: c.startDateHijri, endDateHijri: c.endDateHijri };
}

/** §4.1: Supervisor and own view = identifiers, employee/position, unit, status, dates. */
function reducedView(c: WithRefs) {
  return {
    id: c.id, employeeId: c.employeeId, jobNumber: c.jobNumber, employeeName: c.employee.fullName,
    positionCode: c.employee.positionCode, unitCode: c.employee.unit?.code ?? null, status: c.status, ...dates(c),
    contractTypeCode: c.contractTypeCode, contractTypeName: c.contractType?.name ?? null, contractTypeNameAr: c.contractType?.nameAr ?? null,
    view: 'REDUCED' as const,
  };
}
function fullView(c: WithRefs) {
  return {
    ...reducedView(c), createdById: c.createdById, submittedById: c.submittedById, approvedById: c.approvedById,
    approvedAt: c.approvedAt, createdAt: c.createdAt, updatedAt: c.updatedAt, view: 'FULL' as const,
  };
}
const shape = (c: WithRefs, viewer: Viewer) => (viewer === 'HR' ? fullView(c) : reducedView(c));

export function createContractService(db: Db, documents: DocumentAccess, scanner: UploadScanner, maxUploadBytes: number) {
  const hrScope = (tx: DbClient, auth: AuthContext) => unitScope(tx, auth, HR_ROLES);

  async function loadForHr(tx: DbClient, auth: AuthContext, id: number) {
    const c = await tx.contract.findUnique({ where: { id }, include: { employee: { select: { unitId: true, deletedAt: true } } } });
    if (!c) throw notFound('Contract not found');
    if (!inScope(await hrScope(tx, auth), c.employee.unitId)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This employee is outside your assigned scope');
    return c;
  }

  /** C4 before the database: explains the clash instead of a constraint error. */
  async function assertNoOverlap(tx: DbClient, c: { id: number; employeeId: number; startDate: Date; endDate: Date }) {
    const clash = await tx.contract.findFirst({
      where: { employeeId: c.employeeId, id: { not: c.id }, status: { in: [...COVERING] }, startDate: { lte: c.endDate }, endDate: { gte: c.startDate } },
      select: { id: true, startDate: true, endDate: true },
    });
    if (clash) {
      throw conflict('CONTRACT_PERIOD_OVERLAP', `This period overlaps contract #${clash.id} (${dbDate(clash.startDate)} → ${dbDate(clash.endDate)}), which is approved or active`, { contractId: clash.id });
    }
  }

  async function assertEmployee(tx: DbClient, auth: AuthContext, employeeId: number) {
    const emp = await tx.employee.findUnique({ where: { id: employeeId }, select: { id: true, jobNumber: true, unitId: true, deletedAt: true } });
    if (!emp || emp.deletedAt) throw notFound('Employee not found'); // C5: EMPLOYEE_NOT_FOUND
    if (!inScope(await hrScope(tx, auth), emp.unitId)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This employee is outside your assigned scope');
    if (auth.user.employeeId === employeeId) throw new HttpError(403, 'SELF_ACTION_FORBIDDEN', 'You cannot manage your own contract');
    return emp;
  }

  /** Owner decision 2026-10-02: no renewal while the credentials are not valid (see the header). */
  async function assertCredentialsAllowRenewal(tx: DbClient, employeeId: number, exceptContractId?: number) {
    const before = await tx.contract.findFirst({ where: { employeeId, ...(exceptContractId ? { id: { not: exceptContractId } } : {}) }, select: { id: true } });
    if (!before) return; // a first contract
    const result = await evaluateFor(tx, employeeId, riyadhDate());
    const blocking = result.reasons.filter((r) => r.severity === 'BLOCK' && (r.templateId !== undefined || r.code === 'UNIT_NOT_ASSIGNED'));
    if (blocking.length > 0) {
      throw unprocessable('CREDENTIALS_BLOCK_RENEWAL', `Renew or verify these credentials before renewing the contract: ${blocking.map((r) => r.message).join('; ')}`,
        { reasons: blocking.map((r) => ({ code: r.code, templateCode: r.templateCode ?? null, message: r.message })) });
    }
  }

  /** A type given in the request must be active; otherwise the previous contract's type carries over while it is
   *  still in use, else the contract is "Not classified" (a deactivated type is hidden from new contracts). */
  async function typeFor(tx: DbClient, given: string | undefined, previous: string | null | undefined) {
    if (given) return assertActiveContractType(tx, given);
    if (!previous) return null;
    return (await tx.contractType.findUnique({ where: { code: previous }, select: { isActive: true } }))?.isActive ? previous : null;
  }

  async function createDraft(tx: DbClient, auth: AuthContext, emp: { id: number; jobNumber: string }, start: string, end: string, contractTypeCode: string | null, event: string, extra: Record<string, unknown>, requestId?: string) {
    if (end <= start) throw unprocessable('CONTRACT_DATES_INVALID', 'The contract end must be after its start (C5)');
    const c = await tx.contract.create({
      data: {
        employeeId: emp.id, jobNumber: emp.jobNumber, status: 'Draft', createdById: auth.user.id, contractTypeCode,
        startDate: toDbDate(start), endDate: toDbDate(end), startDateHijri: toHijriIso(start), endDateHijri: toHijriIso(end),
      },
    });
    await appendAudit(tx, { actorUserId: auth.user.id, action: event, resource: 'contract', resourceId: c.id, changes: { employeeId: emp.id, startDate: start, endDate: end, contractTypeCode, status: 'Draft', ...extra }, requestId });
    return c;
  }

  return {
    async list(auth: AuthContext, q: z.infer<typeof ListQuery>) {
      const [hr, sup] = await Promise.all([hrScope(db, auth), unitScope(db, auth, ['SUPERVISOR'])]);
      const scopes = [hr, sup].filter((s) => s.all || s.unitIds.size > 0);
      if (scopes.length === 0) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
      const where = {
        AND: [
          { OR: scopes.map((s) => (s.all ? {} : { employee: { unitId: { in: [...s.unitIds] } } })) },
          { employee: { deletedAt: null } },
          ...(q.employeeId ? [{ employeeId: q.employeeId }] : []),
          ...(q.status ? [{ status: q.status }] : []),
          ...(q.contractTypeCode ? [{ contractTypeCode: q.contractTypeCode }] : []),
        ],
      };
      const [rows, total] = await Promise.all([
        db.contract.findMany({ where, include: INCLUDE, orderBy: [{ employeeId: 'asc' }, { startDate: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
        db.contract.count({ where }),
      ]);
      return { items: rows.map((c) => shape(c, inScope(hr, c.employee.unitId) ? 'HR' : 'SUPERVISOR')), total, page: q.page, pageSize: q.pageSize };
    },

    async listOwn(auth: AuthContext) {
      if (auth.user.employeeId === null) return { items: [], total: 0 };
      const rows = await db.contract.findMany({ where: { employeeId: auth.user.employeeId }, include: INCLUDE, orderBy: { startDate: 'desc' } });
      return { items: rows.map(reducedView), total: rows.length };
    },

    async get(auth: AuthContext, id: number) {
      const c = await db.contract.findUnique({ where: { id }, include: INCLUDE });
      if (!c) throw notFound('Contract not found');
      const { viewer } = await viewerOf(db, auth, c.employeeId, ['OWN', 'HR', 'SUPERVISOR']);
      return shape(c, viewer);
    },

    /** C10: in-scope employees without any Approved/Active contract (the "new contract" picker). */
    async creatable(auth: AuthContext, q: z.infer<typeof PickerQuery>) {
      const scope = await hrScope(db, auth);
      const where = { deletedAt: null, ...(scope.all ? {} : { unitId: { in: [...scope.unitIds] } }), contracts: { none: { status: { in: [...COVERING] } } }, ...pickerMatch(q.q) };
      const [rows, total] = await Promise.all([
        db.employee.findMany({ where, select: { id: true, jobNumber: true, fullName: true }, orderBy: { jobNumber: 'asc' }, take: q.limit }),
        db.employee.count({ where }),
      ]);
      return { items: rows, total };
    },

    /** Renewal picker: each in-scope employee's latest contract with the C8 prefill. */
    async renewable(auth: AuthContext, q: z.infer<typeof PickerQuery>) {
      const scope = await hrScope(db, auth);
      const where = { deletedAt: null, ...(scope.all ? {} : { unitId: { in: [...scope.unitIds] } }), contracts: { some: {} }, ...pickerMatch(q.q) };
      const [rows, total] = await Promise.all([
        db.employee.findMany({
          where, select: { id: true, jobNumber: true, fullName: true, contracts: { orderBy: { endDate: 'desc' }, take: 1 } },
          orderBy: { jobNumber: 'asc' }, take: q.limit,
        }),
        db.employee.count({ where }),
      ]);
      const items = rows.map((e) => {
        const prior = e.contracts[0]!;
        const p = { startDate: dbDate(prior.startDate), endDate: dbDate(prior.endDate) };
        return { employeeId: e.id, jobNumber: e.jobNumber, fullName: e.fullName, prior: { id: prior.id, status: prior.status, contractTypeCode: prior.contractTypeCode, ...dates(prior) }, prefill: renewalPeriodAfter(p) };
      });
      return { items, total };
    },

    async create(auth: AuthContext, body: z.infer<typeof CreateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const emp = await assertEmployee(tx, auth, body.employeeId);
        // C6/C10: a second, concurrent contract is never created this way — renew instead.
        if (await tx.contract.findFirst({ where: { employeeId: emp.id, status: { in: [...COVERING] } }, select: { id: true } })) {
          throw conflict('EMPLOYEE_HAS_CONTRACT', 'This employee already has an approved or active contract — use renewal for the next period (C10)');
        }
        const previous = await tx.contract.findFirst({ where: { employeeId: emp.id }, orderBy: [{ endDate: 'desc' }, { id: 'desc' }], select: { contractTypeCode: true } });
        const type = await typeFor(tx, body.contractTypeCode, previous?.contractTypeCode);
        await assertCredentialsAllowRenewal(tx, emp.id);
        const c = await createDraft(tx, auth, emp, body.startDate, body.endDate, type, 'CONTRACT_CREATED', {}, requestId);
        return { id: c.id };
      });
    },

    /** C8 prefill from the prior contract; the dates stay editable. The approval overlap check (C4) still applies. */
    async renew(auth: AuthContext, priorId: number, body: z.infer<typeof RenewBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const prior = await tx.contract.findUnique({ where: { id: priorId } });
        if (!prior) throw notFound('Contract not found');
        const emp = await assertEmployee(tx, auth, prior.employeeId);
        const latest = await tx.contract.findFirst({ where: { employeeId: prior.employeeId }, orderBy: { endDate: 'desc' }, select: { id: true } });
        if (latest?.id !== prior.id) throw unprocessable('NOT_LATEST_CONTRACT', 'Renew from the employee\'s latest contract');
        const type = await typeFor(tx, body.contractTypeCode, prior.contractTypeCode);
        await assertCredentialsAllowRenewal(tx, emp.id);
        const pre = renewalPeriodAfter({ startDate: dbDate(prior.startDate), endDate: dbDate(prior.endDate) });
        const c = await createDraft(tx, auth, emp, body.startDate ?? pre.start, body.endDate ?? pre.end, type, 'CONTRACT_RENEWAL_CREATED', { renewedFromId: prior.id }, requestId);
        return { id: c.id };
      });
    },

    async transition(auth: AuthContext, id: number, body: z.infer<typeof TransitionBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const c = await loadForHr(tx, auth, id);
        if (c.employee.deletedAt) throw notFound('Employee not found');
        if (auth.user.employeeId === c.employeeId) throw new HttpError(403, 'SELF_ACTION_FORBIDDEN', 'You cannot manage your own contract');
        if (!TRANSITIONS[body.action].includes(c.status)) {
          throw conflict('TRANSITION_NOT_ALLOWED', `A ${c.status} contract cannot be ${body.action === 'return' ? 'returned' : `${body.action}${body.action.endsWith('e') ? 'd' : 'ed'}`}`, { status: c.status, allowedFrom: TRANSITIONS[body.action] });
        }
        const today = riyadhDate();
        const start = dbDate(c.startDate);
        const end = dbDate(c.endDate);
        let next: ContractStatus;
        const data: Record<string, unknown> = {};

        switch (body.action) {
          case 'submit': {
            // C11: a clean contract copy must be on file before it can be approved.
            const copy = await tx.documentVersion.findFirst({ where: { contractId: id, scanStatus: 'CLEAN' }, select: { id: true } });
            if (!copy) throw unprocessable('CONTRACT_COPY_REQUIRED', 'Upload the signed contract copy (PDF) before submitting (C11)');
            next = 'PendingApproval';
            data.submittedById = auth.user.id;
            break;
          }
          case 'return':
            next = 'Draft';
            data.submittedById = null;
            break;
          case 'approve':
          case 'reinstate': {
            if (body.action === 'approve' && (c.createdById === auth.user.id || c.submittedById === auth.user.id)) {
              throw new HttpError(403, 'SELF_APPROVAL_FORBIDDEN', 'A contract must be approved by a different HR administrator than the one who created or submitted it (D-30)');
            }
            const status = coveringStatus(start, end, today);
            if (!status) throw unprocessable('CONTRACT_PERIOD_ENDED', 'This contract period has already ended');
            await assertNoOverlap(tx, c);
            if (body.action === 'approve') await assertCredentialsAllowRenewal(tx, c.employeeId, c.id);
            next = status;
            if (body.action === 'approve') { data.approvedById = auth.user.id; data.approvedAt = new Date(); }
            break;
          }
          case 'suspend': next = 'Suspended'; break;
          case 'terminate': next = 'Terminated'; break;
        }

        await tx.contract.update({ where: { id }, data: { ...data, status: next } });
        const reason = 'reason' in body ? body.reason : undefined;
        await appendAudit(tx, {
          actorUserId: auth.user.id, action: `CONTRACT_${body.action.toUpperCase()}`, resource: 'contract', resourceId: id,
          changes: { employeeId: c.employeeId, from: c.status, to: next, reason }, requestId,
          priority: body.action === 'submit' || body.action === 'return' ? 'NORMAL' : 'HIGH',
        });
        const eligibility = await refreshEligibility(tx, c.employeeId, `CONTRACT_${body.action.toUpperCase()}`, { actorUserId: auth.user.id, requestId });
        return { id, status: next, eligibility: eligibility?.status ?? null };
      });
    },

    // ── Contract copy (D1–D5): PDF only; HR uploads; HR and the employee download CLEAN files. ──
    async upload(auth: AuthContext, id: number, bytes: Buffer, contentType: string | undefined, fileName: string | undefined, requestId?: string) {
      const c = await loadForHr(db, auth, id);
      if (auth.user.employeeId === c.employeeId) throw new HttpError(403, 'SELF_ACTION_FORBIDDEN', 'You cannot manage your own contract');
      const checked = checkUpload('CONTRACT_COPY', bytes, contentType, fileName, maxUploadBytes);
      const scannedBy = await scanOrReject(scanner, db, bytes, { actorUserId: auth.user.id, resource: 'contract', resourceId: id, ...checked, requestId });
      const storageKey = await documents.vault.put(bytes);
      return db.$transaction(async (tx) => {
        const last = await tx.documentVersion.aggregate({ where: { contractId: id }, _max: { version: true } });
        const doc = await tx.documentVersion.create({
          data: {
            contractId: id, version: (last._max.version ?? 0) + 1, fileName: checked.fileName, mimeType: checked.mimeType, sizeBytes: checked.sizeBytes,
            sha256: checked.sha256, storageKey, scanStatus: 'CLEAN', uploadedById: auth.user.id, // D-10: scanned clean (lib/scanner.ts)
          },
        });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'DOCUMENT_UPLOADED', resource: 'contract', resourceId: id, changes: { documentId: doc.id, version: doc.version, sizeBytes: doc.sizeBytes, sha256: doc.sha256, scanner: scannedBy }, requestId });
        return { id: doc.id, version: doc.version };
      });
    },

    async listDocuments(auth: AuthContext, id: number) {
      const c = await db.contract.findUnique({ where: { id }, select: { employeeId: true } });
      if (!c) throw notFound('Contract not found');
      await viewerOf(db, auth, c.employeeId, ['OWN', 'HR']); // supervisors never (D5)
      const items = await db.documentVersion.findMany({
        where: { contractId: id }, orderBy: { version: 'desc' },
        select: { id: true, version: true, fileName: true, mimeType: true, sizeBytes: true, scanStatus: true, uploadedAt: true },
      });
      return { items, total: items.length };
    },

    async download(auth: AuthContext, id: number, documentId: number, requestId?: string) {
      return documents.read(await readable(auth, id, documentId), auth.user.id, requestId);
    },

    /** A 60-second single-use link (D-53), after the same checks as a download. */
    async link(auth: AuthContext, id: number, documentId: number, inline: boolean, requestId?: string) {
      return documents.issueLink(await readable(auth, id, documentId), auth.user.id, inline, requestId);
    },
  };

  /** The document, when the caller may read it and it passed scanning (D4, D5). */
  async function readable(auth: AuthContext, id: number, documentId: number) {
    const c = await db.contract.findUnique({ where: { id }, select: { employeeId: true } });
    if (!c) throw notFound('Contract not found');
    await viewerOf(db, auth, c.employeeId, ['OWN', 'HR']);
    const doc = await db.documentVersion.findFirst({ where: { id: documentId, contractId: id } });
    if (!doc) throw notFound('Document not found');
    if (doc.scanStatus !== 'CLEAN') throw new HttpError(409, 'DOCUMENT_NOT_CLEAN', 'This file has not passed scanning and cannot be downloaded (D4)');
    return doc;
  }
}

export type ContractService = ReturnType<typeof createContractService>;
