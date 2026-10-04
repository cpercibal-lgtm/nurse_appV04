// Credential records, verification and renewal lifecycle (spec §5.1.5, §5.2;
// rules L1–L3, L8, D1–D5). Every change re-evaluates eligibility in the same
// transaction (L6).
//
// Who sees what (spec §8.1 Credentials, §5.2):
//   OWN        — full record, own evidence, may submit and stage a renewal
//   HR / SA    — scoped: full record, evidence, verify / suspend / revoke / renewal decisions
//   SUPERVISOR — scoped compliance view only: no tracking data (private identity
//                numbers), no pending values, no documents (D5)

import { z } from 'zod';
import type { Credential, CredentialTemplate } from '../../generated/prisma/client.js';
import { appendAudit } from '../../lib/audit.js';
import { daysBetween, dbDate, isIsoDate, riyadhDate, toDbDate, type IsoDate } from '../../lib/dates.js';
import { fromHijriIso, toHijriIso } from '../../lib/hijri.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import { Prisma, type Db, type DbClient } from '../../lib/prisma.js';
import { scanOrReject, type UploadScanner } from '../../lib/scanner.js';
import { checkUpload } from '../../lib/uploads.js';
import type { DocumentAccess } from '../documents/access.js';
import type { Protection } from '../pdpl/protection.js';
import { refreshEligibility } from '../eligibility/state.service.js';
import { unitScope, type AuthContext } from '../users/access.js';
import { HR_ROLES, viewerOf, type Viewer } from './access.js';
import type { FieldDef } from './catalog.js';
import { presentTemplate, toFieldDefs, WITH_FIELDS } from './fields.js';
import { assertActiveRankGrade, CLASSIFICATION_FIELD_KEY } from '../workforce/rank-grades.js';
import { appliesToNationality } from './nationality-rule.js';

/** Spec §5.2: "Subject to Renew" = within 60 days of expiry (confirmed by the owner, D-39). Also the first credential reminder milestone. */
export const RENEWAL_WINDOW_DAYS = 60;

const DateStr = z.string().refine(isIsoDate, 'YYYY-MM-DD');
const TrackingData = z.record(z.string(), z.union([z.string().max(500), z.number()]));

export const RecordBody = z.strictObject({
  employeeId: z.number().int().positive(),
  templateId: z.number().int().positive(),
  trackingData: TrackingData.default({}),
  issueDate: DateStr.optional(),
  expiryDate: DateStr.optional(),
});
export const SelfRecordBody = RecordBody.omit({ employeeId: true });
export const VerifyBody = z.strictObject({ documentId: z.number().int().positive().optional() });
export const DecisionBody = z.strictObject({ reason: z.string().trim().min(1).max(1000) });
export const RenewalBody = z.strictObject({ trackingData: TrackingData.default({}), issueDate: DateStr.optional(), expiryDate: DateStr.optional() });
export const ApproveRenewalBody = z.strictObject({ documentId: z.number().int().positive().optional() });
export const ListQuery = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
  templateId: z.coerce.number().int().positive().optional(),
  status: z.enum(['PendingVerification', 'Valid', 'ExpiringSoon', 'Expired', 'Suspended', 'Revoked']).optional(),
  queue: z.enum(['review']).optional(),
  /** D-54: exact match on an Iqama, passport or SCFHS number (blind index). HR scope only. */
  identifier: z.string().trim().min(3).max(40).optional(),
});

/** Stored status for a verified credential on a given day (L1). */
export function deriveStatus(expiry: IsoDate | null, today: IsoDate): 'Valid' | 'ExpiringSoon' | 'Expired' {
  if (!expiry) return 'Valid';
  if (expiry < today) return 'Expired';
  return daysBetween(today, expiry) <= RENEWAL_WINDOW_DAYS ? 'ExpiringSoon' : 'Valid';
}

/** Display label (spec §5.2). Never authorizes scheduling on its own. */
export function lifecycleLabel(c: { status: string; expiryDate: Date | null; pendingData: unknown }, hasPendingDocument: boolean, today: IsoDate) {
  const expiry = c.expiryDate ? dbDate(c.expiryDate) : null;
  if (expiry && expiry < today) return 'Expired';
  if (c.pendingData != null || hasPendingDocument) return 'OnProcess';
  if (expiry && daysBetween(today, expiry) <= RENEWAL_WINDOW_DAYS) return 'SubjectToRenew';
  return 'Active';
}

/** Validates tracking data against the template's field definitions and extracts issue/expiry dates. */
/** The SCFHS licence's classification (a `select` field keyed "classification") is a Rank/Grade code (owner decision 2026-10-03). */
async function assertClassification(tx: DbClient, defs: FieldDef[], data: Record<string, string | number>) {
  for (const d of defs) {
    const v = data[d.key];
    if (d.type === 'select' && d.key === CLASSIFICATION_FIELD_KEY && v !== undefined && v !== '') await assertActiveRankGrade(tx, String(v));
  }
}

export function readTrackingData(tpl: { fieldDefs: FieldDef[]; hasExpiry: boolean }, data: Record<string, string | number>, explicit: { issueDate?: string; expiryDate?: string }) {
  const defs = tpl.fieldDefs;
  const known = new Set(defs.map((d) => d.key));
  const problems: string[] = [];
  const hijriDates = new Map<string, string>();
  for (const key of Object.keys(data)) if (!known.has(key)) problems.push(`${key}: not a field of this template`);
  for (const d of defs) {
    const v = data[d.key];
    const empty = v === undefined || v === '';
    if (empty) { if (d.required) problems.push(`${d.key}: required`); continue; }
    if (d.type === 'date' && !(typeof v === 'string' && isIsoDate(v))) problems.push(`${d.key}: must be YYYY-MM-DD`);
    if (d.type === 'date_hijri') {
      try {
        if (typeof v !== 'string') throw new RangeError('not a Hijri date');
        hijriDates.set(d.key, fromHijriIso(v));
      } catch {
        problems.push(`${d.key}: must be a valid Umm al-Qura date YYYY-MM-DD`);
      }
    }
    if (d.type === 'number' && !(typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v)))) problems.push(`${d.key}: must be a number`);
  }
  const readDate = (field: FieldDef | undefined, given: string | undefined, label: string): string | null => {
    if (given && !isIsoDate(given)) problems.push(`${label}: must be a Gregorian YYYY-MM-DD date`);
    if (field && field.type !== 'date' && field.type !== 'date_hijri') problems.push(`${field.key}: not a date field`);
    const fromField = field && (field.type === 'date_hijri' ? hijriDates.get(field.key) : data[field.key]);
    // An explicit Gregorian date may accompany a Hijri value, but it must
    // represent the SAME day. Never let it silently override the evidence.
    if (given && fromField && given !== fromField) problems.push(`${label}: disagrees with ${field!.key}`);
    return given ?? (typeof fromField === 'string' ? fromField : null);
  };
  const issueDate = readDate(defs.find((d) => d.isIssueDate), explicit.issueDate, 'issueDate');
  const expiryDate = readDate(defs.find((d) => d.isExpiryDate), explicit.expiryDate, 'expiryDate');
  if (issueDate && expiryDate && expiryDate < issueDate) problems.push('expiry date is before issue date');
  if (problems.length > 0) throw new HttpError(400, 'TRACKING_DATA_INVALID', 'The credential details are invalid', problems);
  return { issueDate, expiryDate };
}

type WithRelations = Credential & {
  template: Pick<CredentialTemplate, 'id' | 'code' | 'name' | 'hasExpiry' | 'requiresUpload'>;
  documents: Array<{ id: number; reviewStatus: string; scanStatus: string }>;
  employee: { id: number; fullName: string; jobNumber: string; unitId: number | null };
};

const withRelations = {
  template: { select: { id: true, code: true, name: true, hasExpiry: true, requiresUpload: true } },
  documents: { select: { id: true, reviewStatus: true, scanStatus: true } },
  employee: { select: { id: true, fullName: true, jobNumber: true, unitId: true } },
} satisfies Prisma.CredentialInclude;

function present(c: WithRelations & { personalDataErased?: boolean }, viewer: Viewer, today: IsoDate) {
  const pendingDoc = c.documents.some((d) => d.reviewStatus === 'PENDING_REVIEW' && d.scanStatus !== 'INFECTED');
  const base = {
    id: c.id, employeeId: c.employeeId, employee: { fullName: c.employee.fullName, jobNumber: c.employee.jobNumber, unitId: c.employee.unitId },
    templateId: c.templateId, template: { code: c.template.code, name: c.template.name },
    status: c.status, lifecycle: lifecycleLabel(c, pendingDoc, today),
    issueDate: c.issueDate ? dbDate(c.issueDate) : null, expiryDate: c.expiryDate ? dbDate(c.expiryDate) : null,
    expiryDateHijri: c.expiryDateHijri, graceExpiryDate: c.graceExpiryDate ? dbDate(c.graceExpiryDate) : null,
  };
  if (viewer === 'SUPERVISOR') return base; // compliance view (spec §5.2)
  return {
    ...base, trackingData: c.trackingData, pendingData: c.pendingData, statusReason: c.statusReason,
    ...(c.personalDataErased ? { personalDataErased: true } : {}), // D-54: sensitive values erased (§8.3.3)
    latestEvidenceId: c.latestEvidenceId, verifiedAt: c.verifiedAt, documentsPendingReview: c.documents.filter((d) => d.reviewStatus === 'PENDING_REVIEW').length,
  };
}

export function createRecordService(db: Db, documents: DocumentAccess, scanner: UploadScanner, maxUploadBytes: number, protection: Protection) {
  /** The credential with its sensitive values opened (D-54) — for viewers who see tracking data. */
  async function revealed<T extends { employeeId: number; trackingData: unknown; pendingData: unknown }>(c: T, cache = new Map<number, Buffer | null>()) {
    const tracking = await protection.reveal(db, c.employeeId, c.trackingData, cache);
    const pending = c.pendingData && typeof c.pendingData === 'object' && 'trackingData' in c.pendingData
      ? await protection.reveal(db, c.employeeId, (c.pendingData as { trackingData: unknown }).trackingData, cache)
      : { data: undefined, erased: false };
    return {
      ...c,
      trackingData: tracking.data as T['trackingData'],
      pendingData: (pending.data === undefined ? c.pendingData : { ...(c.pendingData as object), trackingData: pending.data }) as T['pendingData'],
      personalDataErased: tracking.erased || pending.erased,
    };
  }

  async function load(tx: DbClient, id: number) {
    const c = await tx.credential.findUnique({ where: { id }, include: withRelations });
    if (!c) throw notFound('Credential not found');
    return c;
  }
  const noSelfReview = (auth: AuthContext, c: { employeeId: number }) => {
    // Separation of duties (the R2/R11 principle): nobody verifies their own credential.
    if (auth.user.employeeId === c.employeeId) throw new HttpError(403, 'SELF_REVIEW_FORBIDDEN', 'You cannot review or decide on your own credential');
  };
  const refresh = (tx: DbClient, employeeId: number, event: string, auth: AuthContext, requestId?: string) =>
    refreshEligibility(tx, employeeId, event, { actorUserId: auth.user.id, requestId });

  return {
    async list(auth: AuthContext, q: z.infer<typeof ListQuery>, requestId?: string) {
      const today = riyadhDate();
      const hr = await unitScope(db, auth, HR_ROLES);
      const sup = await unitScope(db, auth, ['SUPERVISOR']);
      let byIdentifier: number[] | undefined;
      if (q.identifier) {
        // Searching by a sensitive identifier is an HR task (D-54); the value is never stored or logged.
        if (!hr.all && hr.unitIds.size === 0) throw new HttpError(403, 'FORBIDDEN', 'Searching by identifier number is limited to HR');
        byIdentifier = await protection.findByIdentifier(db, q.identifier);
        await appendAudit(db, { actorUserId: auth.user.id, action: 'IDENTIFIER_SEARCHED', resource: 'credential', changes: { matches: byIdentifier.length }, requestId });
      }
      const scopeAll = hr.all || sup.all;
      const units = new Set([...(hr.all ? [] : hr.unitIds), ...(sup.all ? [] : sup.unitIds)]);
      const rows = await db.credential.findMany({
        where: {
          ...(q.employeeId ? { employeeId: q.employeeId } : {}), ...(q.templateId ? { templateId: q.templateId } : {}), ...(q.status ? { status: q.status } : {}),
          ...(q.queue === 'review' ? { OR: [{ status: 'PendingVerification' as const }, { pendingData: { not: Prisma.DbNull } }, { documents: { some: { reviewStatus: 'PENDING_REVIEW' as const } } }] } : {}),
          ...(byIdentifier ? { id: { in: byIdentifier } } : {}),
          employee: { deletedAt: null, ...(byIdentifier ? (hr.all ? {} : { unitId: { in: [...hr.unitIds] } }) : scopeAll ? {} : { unitId: { in: [...units] } }) },
        },
        include: withRelations,
        orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
        take: 1000,
      });
      // Each row is shaped by how the caller relates to that employee; only HR rows carry (opened) tracking data.
      const cache = new Map<number, Buffer | null>();
      const items = [];
      for (const c of rows) {
        const viewer = hr.all || (c.employee.unitId !== null && hr.unitIds.has(c.employee.unitId)) ? 'HR' : 'SUPERVISOR';
        items.push(present(viewer === 'HR' ? await revealed(c, cache) : c, viewer, today));
      }
      return { items, total: items.length };
    },

    async listOwn(auth: AuthContext) {
      if (auth.user.employeeId === null) return { items: [], total: 0 };
      const rows = await db.credential.findMany({ where: { employeeId: auth.user.employeeId }, include: withRelations, orderBy: { id: 'asc' } });
      const cache = new Map<number, Buffer | null>();
      const items = [];
      for (const c of rows) items.push(present(await revealed(c, cache), 'OWN', riyadhDate()));
      return { items, total: items.length };
    },

    /**
     * The requirements that apply to the caller (their unit and position). A credential type that
     * does not apply to their nationality is OPTIONAL for them, flagged `optionalByNationality`
     * (owner decision 2026-10-04).
     */
    async ownRequirements(auth: AuthContext) {
      if (auth.user.employeeId === null) return { items: [], total: 0 };
      const emp = await db.employee.findUnique({ where: { id: auth.user.employeeId }, select: { unitId: true, positionCode: true, nationalityCode: true } });
      if (!emp?.unitId) return { items: [], total: 0 };
      const rows = await db.credentialRequirement.findMany({
        where: { unitId: emp.unitId, OR: [{ positionCode: null }, { positionCode: emp.positionCode }] },
        include: { template: { select: { id: true, code: true, name: true, requiresUpload: true, nationalityRule: true, nationalityCodes: true, ...WITH_FIELDS } } },
      });
      const items = rows.map(({ template: { fields, ...t }, ...r }) => {
        const optionalByNationality = !appliesToNationality(t.nationalityRule, t.nationalityCodes, emp.nationalityCode);
        return { ...r, policyStatus: optionalByNationality ? 'OPTIONAL' as const : r.policyStatus, optionalByNationality, template: { ...t, fieldDefs: toFieldDefs(fields) } };
      });
      return { items, total: items.length };
    },

    async get(auth: AuthContext, id: number) {
      const c = await load(db, id);
      const { viewer } = await viewerOf(db, auth, c.employeeId, ['OWN', 'HR', 'SUPERVISOR']);
      return present(viewer === 'SUPERVISOR' ? c : await revealed(c), viewer, riyadhDate());
    },

    /** Records a credential as PendingVerification (HR for a scoped employee, or the employee themselves). */
    async record(auth: AuthContext, body: z.infer<typeof RecordBody>, selfService: boolean, requestId?: string) {
      await viewerOf(db, auth, body.employeeId, selfService ? ['OWN'] : ['HR']);
      const found = await db.credentialTemplate.findUnique({ where: { id: body.templateId }, include: WITH_FIELDS });
      const tpl = found ? presentTemplate(found) : null;
      if (!tpl) throw new HttpError(422, 'TEMPLATE_NOT_FOUND', 'The credential template does not exist');
      if (!tpl.isActive) throw new HttpError(422, 'TEMPLATE_INACTIVE', 'The credential template is inactive');
      const dates = readTrackingData(tpl, body.trackingData, body);
      return db.$transaction(async (tx) => {
        await assertClassification(tx, tpl.fieldDefs, body.trackingData);
        const sealed = await protection.seal(tx, body.employeeId, tpl.fieldDefs, body.trackingData);
        const c = await tx.credential.create({
          data: {
            employeeId: body.employeeId, templateId: body.templateId, status: 'PendingVerification', trackingData: sealed,
            issueDate: dates.issueDate ? toDbDate(dates.issueDate) : null, expiryDate: dates.expiryDate ? toDbDate(dates.expiryDate) : null,
            expiryDateHijri: dates.expiryDate ? toHijriIso(dates.expiryDate) : null,
          },
        });
        await protection.index(tx, c.id, tpl.fieldDefs, body.trackingData);
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'CREDENTIAL_RECORDED', resource: 'credential', resourceId: c.id, changes: { employeeId: body.employeeId, templateId: body.templateId, ...dates, selfService }, requestId });
        await refresh(tx, body.employeeId, 'CREDENTIAL_RECORDED', auth, requestId);
        return { id: c.id };
      });
    },

    /** PendingVerification → Valid / ExpiringSoon / Expired by date (spec §5.2, L1). */
    async verify(auth: AuthContext, id: number, body: z.infer<typeof VerifyBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const c = await load(tx, id);
        await viewerOf(tx, auth, c.employeeId, ['HR']);
        noSelfReview(auth, c);
        if (c.status !== 'PendingVerification') throw new HttpError(409, 'CREDENTIAL_NOT_PENDING', `Only a credential awaiting verification can be verified (it is ${c.status})`);
        if (c.template.hasExpiry && !c.expiryDate) throw new HttpError(422, 'EXPIRY_DATE_REQUIRED', 'This credential type expires: record its expiry date before verifying');
        const evidenceId = await pickEvidence(tx, c, body.documentId);
        const now = new Date();
        const status = deriveStatus(c.expiryDate ? dbDate(c.expiryDate) : null, riyadhDate(now));
        await tx.credential.update({ where: { id }, data: { status, verifiedById: auth.user.id, verifiedAt: now, statusReason: null, ...(evidenceId ? { latestEvidenceId: evidenceId } : {}) } });
        if (evidenceId) await tx.documentVersion.update({ where: { id: evidenceId }, data: { reviewStatus: 'APPROVED', reviewedById: auth.user.id, reviewedAt: now } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'CREDENTIAL_VERIFIED', resource: 'credential', resourceId: id, changes: { employeeId: c.employeeId, status, evidenceId }, requestId });
        await refresh(tx, c.employeeId, 'CREDENTIAL_VERIFIED', auth, requestId);
        return { id, status };
      });
    },

    /** Suspension / revocation invalidate eligibility immediately (L3), grace included. */
    async decide(auth: AuthContext, id: number, to: 'Suspended' | 'Revoked', reason: string, requestId?: string) {
      return db.$transaction(async (tx) => {
        const c = await load(tx, id);
        await viewerOf(tx, auth, c.employeeId, ['HR']);
        noSelfReview(auth, c);
        if (c.status === 'Revoked') throw new HttpError(409, 'CREDENTIAL_REVOKED', 'A revoked credential cannot change');
        if (c.status === to) throw new HttpError(409, 'CREDENTIAL_ALREADY_IN_STATE', `The credential is already ${to}`);
        await tx.credential.update({ where: { id }, data: { status: to, statusReason: reason } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: to === 'Revoked' ? 'CREDENTIAL_REVOKED' : 'CREDENTIAL_SUSPENDED', resource: 'credential', resourceId: id, changes: { employeeId: c.employeeId, from: c.status, reason }, requestId, priority: 'HIGH' });
        if (c.graceCycleId && !c.graceCycleId.endsWith(':closed')) await closeGrace(tx, auth, c, to === 'Revoked' ? 'REVOKED' : 'SUSPENDED', requestId);
        await refresh(tx, c.employeeId, to === 'Revoked' ? 'CREDENTIAL_REVOKED' : 'CREDENTIAL_SUSPENDED', auth, requestId);
        return { id, status: to };
      });
    },

    /** Stages replacement values (spec §5.2): the approved credential stays usable until its own expiry (L2). */
    async stageRenewal(auth: AuthContext, id: number, body: z.infer<typeof RenewalBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const c = await load(tx, id);
        await viewerOf(tx, auth, c.employeeId, ['OWN', 'HR']);
        if (!['Valid', 'ExpiringSoon', 'Expired'].includes(c.status)) throw new HttpError(409, 'RENEWAL_NOT_ALLOWED', `A ${c.status} credential cannot be renewed`);
        const tpl = presentTemplate(await tx.credentialTemplate.findUniqueOrThrow({ where: { id: c.templateId }, include: WITH_FIELDS }));
        const dates = readTrackingData(tpl, body.trackingData, body);
        if (tpl.hasExpiry && !dates.expiryDate) throw new HttpError(422, 'EXPIRY_DATE_REQUIRED', 'A renewal must state the new expiry date');
        await assertClassification(tx, tpl.fieldDefs, body.trackingData);
        const sealed = await protection.seal(tx, c.employeeId, tpl.fieldDefs, body.trackingData);
        const pendingData = { trackingData: sealed, ...dates, submittedById: auth.user.id, submittedAt: new Date().toISOString() };
        await tx.credential.update({ where: { id }, data: { pendingData } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'CREDENTIAL_RENEWAL_SUBMITTED', resource: 'credential', resourceId: id, changes: { employeeId: c.employeeId, ...dates }, requestId });
        await refresh(tx, c.employeeId, 'CREDENTIAL_RENEWAL_SUBMITTED', auth, requestId);
        return { id };
      });
    },

    /** Approval promotes the reviewed data and the selected pending document (spec §5.2); it closes any grace (L8). */
    async approveRenewal(auth: AuthContext, id: number, body: z.infer<typeof ApproveRenewalBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const c = await load(tx, id);
        await viewerOf(tx, auth, c.employeeId, ['HR']);
        noSelfReview(auth, c);
        const pending = c.pendingData as { trackingData: Record<string, string | number>; issueDate: string | null; expiryDate: string | null } | null;
        if (!pending) throw new HttpError(409, 'NO_RENEWAL_PENDING', 'There is no staged renewal to approve');
        if (c.status === 'Suspended' || c.status === 'Revoked') throw new HttpError(409, 'RENEWAL_NOT_ALLOWED', `A ${c.status} credential cannot be renewed`);
        const evidenceId = await pickEvidence(tx, c, body.documentId);
        const now = new Date();
        const status = deriveStatus(pending.expiryDate, riyadhDate(now));
        await tx.credential.update({
          where: { id },
          data: {
            status, trackingData: pending.trackingData, pendingData: Prisma.DbNull,
            issueDate: pending.issueDate ? toDbDate(pending.issueDate) : null, expiryDate: pending.expiryDate ? toDbDate(pending.expiryDate) : null,
            expiryDateHijri: pending.expiryDate ? toHijriIso(pending.expiryDate) : null,
            verifiedById: auth.user.id, verifiedAt: now, statusReason: null,
            ...(evidenceId ? { latestEvidenceId: evidenceId } : {}),
            // A completed renewal ends the grace cycle, so a future expiry may use grace again (L8).
            graceActivatedAt: null, graceExpiryDate: null, graceCycleId: null,
          },
        });
        if (evidenceId) await tx.documentVersion.update({ where: { id: evidenceId }, data: { reviewStatus: 'APPROVED', reviewedById: auth.user.id, reviewedAt: now } });
        await tx.documentVersion.updateMany({ where: { credentialId: id, reviewStatus: 'PENDING_REVIEW' }, data: { reviewStatus: 'REJECTED', reviewedById: auth.user.id, reviewedAt: now } });
        // The approved values replace the searchable identifiers (D-54).
        const tpl = presentTemplate(await tx.credentialTemplate.findUniqueOrThrow({ where: { id: c.templateId }, include: WITH_FIELDS }));
        const opened = await protection.reveal(tx, c.employeeId, pending.trackingData);
        await protection.index(tx, id, tpl.fieldDefs, opened.data as Record<string, string | number>);
        if (c.graceCycleId && !c.graceCycleId.endsWith(':closed')) {
          await appendAudit(tx, { actorUserId: auth.user.id, action: 'GRACE_COMPLETED', resource: 'credential', resourceId: id, changes: { employeeId: c.employeeId, cycleId: c.graceCycleId, reason: 'RENEWAL_APPROVED' }, requestId, priority: 'HIGH' });
        }
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'CREDENTIAL_RENEWAL_APPROVED', resource: 'credential', resourceId: id, changes: { employeeId: c.employeeId, status, issueDate: pending.issueDate, expiryDate: pending.expiryDate, evidenceId }, requestId });
        await refresh(tx, c.employeeId, 'CREDENTIAL_RENEWAL_APPROVED', auth, requestId);
        return { id, status };
      });
    },

    /** Rejection clears staged changes without touching the approved credential; grace ends at once (L8). */
    async rejectRenewal(auth: AuthContext, id: number, reason: string, requestId?: string) {
      return db.$transaction(async (tx) => {
        const c = await load(tx, id);
        await viewerOf(tx, auth, c.employeeId, ['HR']);
        noSelfReview(auth, c);
        const hasPendingDoc = c.documents.some((d) => d.reviewStatus === 'PENDING_REVIEW');
        if (!c.pendingData && !hasPendingDoc) throw new HttpError(409, 'NO_RENEWAL_PENDING', 'There is no staged renewal to reject');
        const now = new Date();
        await tx.credential.update({ where: { id }, data: { pendingData: Prisma.DbNull } });
        await tx.documentVersion.updateMany({ where: { credentialId: id, reviewStatus: 'PENDING_REVIEW' }, data: { reviewStatus: 'REJECTED', reviewedById: auth.user.id, reviewedAt: now } });
        if (c.graceCycleId && !c.graceCycleId.endsWith(':closed')) await closeGrace(tx, auth, c, 'RENEWAL_REJECTED', requestId);
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'CREDENTIAL_RENEWAL_REJECTED', resource: 'credential', resourceId: id, changes: { employeeId: c.employeeId, reason }, requestId });
        await refresh(tx, c.employeeId, 'CREDENTIAL_RENEWAL_REJECTED', auth, requestId);
        return { id };
      });
    },

    /** Evidence upload (spec §5.1.5): a new version, never overwriting; HR review decides approval. */
    async upload(auth: AuthContext, id: number, bytes: Buffer, contentType: string | undefined, fileName: string | undefined, requestId?: string) {
      const c = await load(db, id);
      await viewerOf(db, auth, c.employeeId, ['OWN', 'HR']);
      if (c.status === 'Revoked') throw new HttpError(409, 'CREDENTIAL_REVOKED', 'Evidence cannot be added to a revoked credential');
      const checked = checkUpload('CREDENTIAL_EVIDENCE', bytes, contentType, fileName, maxUploadBytes);
      const scannedBy = await scanOrReject(scanner, db, bytes, { actorUserId: auth.user.id, resource: 'credential', resourceId: id, ...checked, requestId });
      const storageKey = await documents.vault.put(bytes);
      return db.$transaction(async (tx) => {
        const last = await tx.documentVersion.aggregate({ where: { credentialId: id }, _max: { version: true } });
        const doc = await tx.documentVersion.create({
          data: {
            credentialId: id, version: (last._max.version ?? 0) + 1, fileName: checked.fileName, mimeType: checked.mimeType, sizeBytes: checked.sizeBytes,
            sha256: checked.sha256, storageKey,
            // D-10: only bytes the scanner reported clean reach this point (lib/scanner.ts).
            scanStatus: 'CLEAN', uploadedById: auth.user.id,
          },
        });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'DOCUMENT_UPLOADED', resource: 'credential', resourceId: id, changes: { documentId: doc.id, version: doc.version, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes, sha256: doc.sha256, scanner: scannedBy }, requestId });
        await refresh(tx, c.employeeId, 'DOCUMENT_UPLOADED', auth, requestId);
        return { id: doc.id, version: doc.version };
      });
    },

    async listDocuments(auth: AuthContext, id: number) {
      const c = await load(db, id);
      await viewerOf(db, auth, c.employeeId, ['OWN', 'HR']); // supervisors never (D5)
      const docs = await db.documentVersion.findMany({
        where: { credentialId: id },
        select: { id: true, version: true, fileName: true, mimeType: true, sizeBytes: true, scanStatus: true, reviewStatus: true, uploadedAt: true, reviewedAt: true, erasedAt: true },
        orderBy: { version: 'desc' },
      });
      return { items: docs.map((d) => ({ ...d, isCurrentEvidence: d.id === c.latestEvidenceId })), total: docs.length };
    },

    /** Only CLEAN files are served (D4); only the owner and scoped HR/System Admin (D5). */
    async download(auth: AuthContext, id: number, documentId: number, requestId?: string) {
      return documents.read(await readable(auth, id, documentId), auth.user.id, requestId);
    },

    /** A 60-second single-use link (D-53), after the same checks as a download. */
    async link(auth: AuthContext, id: number, documentId: number, inline: boolean, requestId?: string) {
      return documents.issueLink(await readable(auth, id, documentId), auth.user.id, inline, requestId);
    },
  };

  /** The document, when the caller may read it and it passed scanning. */
  async function readable(auth: AuthContext, id: number, documentId: number) {
    const c = await load(db, id);
    await viewerOf(db, auth, c.employeeId, ['OWN', 'HR']);
    const doc = await db.documentVersion.findFirst({ where: { id: documentId, credentialId: id } });
    if (!doc) throw notFound('Document not found');
    if (doc.scanStatus !== 'CLEAN') throw new HttpError(409, 'DOCUMENT_NOT_CLEAN', 'This file has not passed scanning and cannot be downloaded');
    return doc;
  }

  /** The evidence to approve: the chosen or newest CLEAN pending version; required when the template requires upload. */
  async function pickEvidence(tx: DbClient, c: WithRelations, documentId: number | undefined): Promise<number | null> {
    const candidates = await tx.documentVersion.findMany({
      where: { credentialId: c.id, reviewStatus: 'PENDING_REVIEW', scanStatus: 'CLEAN', erasedAt: null, ...(documentId ? { id: documentId } : {}) },
      orderBy: { version: 'desc' }, take: 1, select: { id: true },
    });
    if (documentId && candidates.length === 0) throw new HttpError(422, 'DOCUMENT_NOT_REVIEWABLE', 'The selected document is not a clean version awaiting review');
    if (candidates.length === 0 && c.template.requiresUpload) throw new HttpError(422, 'EVIDENCE_REQUIRED', 'This credential type requires evidence: upload a document first');
    return candidates[0]?.id ?? null;
  }

  async function closeGrace(tx: DbClient, auth: AuthContext, c: WithRelations, reason: string, requestId?: string) {
    // The cycle is marked closed so the same expiry cannot re-enter grace (L8: no stacking).
    await tx.credential.update({ where: { id: c.id }, data: { graceCycleId: `${c.graceCycleId}:closed` } });
    await appendAudit(tx, { actorUserId: auth.user.id, action: 'GRACE_CLOSED', resource: 'credential', resourceId: c.id, changes: { employeeId: c.employeeId, cycleId: c.graceCycleId, reason }, requestId, priority: 'HIGH' });
  }
}

export type RecordService = ReturnType<typeof createRecordService>;
