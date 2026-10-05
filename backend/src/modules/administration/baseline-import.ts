// Hospital baseline import (database-first migration, approval P7).
//
// Hospital master data — departments, units and beds, positions, credential
// categories and credential types with their fields — enters PostgreSQL through
// this controlled process, never through source code:
//
//   upload file → validate → preview (per row: CREATE / UNCHANGED / CONFLICT /
//   REJECTED) → request (system-wide administrator, reason) → a SECOND
//   system-wide administrator approves → re-checked against the database as it
//   is now → applied in ONE transaction with the approval → audited.
//
// Rules:
//   - Rows are matched by stable business code, never by name or id.
//   - Existing records are never changed: a code that exists with different
//     values is a CONFLICT to resolve through the normal screens (which have
//     their own four-eyes and audit). Identical rows are UNCHANGED, so running
//     the same file twice creates nothing (idempotent).
//   - Any REJECTED or CONFLICT row blocks the whole import — there is never a
//     half-imported hospital.
//   - Break-glass applies at once (spec §3.6), like every other four-eyes path.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { HttpError, unprocessable } from '../../lib/http-errors.js';
import { Prisma, type Db, type DbClient } from '../../lib/prisma.js';
import { sameValue } from '../../lib/same.js';
import { FieldDefs } from '../credentials/catalog.js';
import { canonicalField, fieldRows, toFieldDefs, WITH_FIELDS } from '../credentials/fields.js';
import { NationalityCodesSchema, NationalityRuleSchema } from '../credentials/nationality-rule.js';
import { unitScope, type AuthContext } from '../users/access.js';
import { Beds, Code, CriticalAreaValue, Description, Name, NameAr, TIERS } from '../workforce/org.js';

const TemplateCode = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/));
const Order = z.number().int().min(0);

const DepartmentRow = z.strictObject({ code: Code, name: Name, nameAr: NameAr.optional(), description: Description.optional() });
const UnitRow = z.strictObject({
  code: Code, name: Name, nameAr: NameAr.optional(), description: Description.optional(),
  departmentCode: Code, bedCount: Beds, criticalArea: CriticalAreaValue.optional(),
});
const PositionRow = z.strictObject({
  code: Code, title: Name, titleAr: NameAr.optional(), tier: z.enum(TIERS), description: Description.optional(),
  isSchedulable: z.boolean(), isActive: z.boolean().default(true), displayOrder: Order.default(0), replacedBy: Code.optional(),
});
const CategoryRow = z.strictObject({ code: TemplateCode, name: Name, description: Description.optional(), displayOrder: Order.default(0) });
const TemplateRow = z.strictObject({
  code: TemplateCode, name: Name, nameAr: NameAr.optional(), categoryCode: TemplateCode, description: Description.optional(),
  hasExpiry: z.boolean(), requiresUpload: z.boolean(), gracePeriodDays: z.number().int().min(0).max(90).default(0),
  displayOrder: Order.default(0), isActive: z.boolean().default(true), fields: FieldDefs,
  // Owner decision 2026-10-04: who the type applies to; left out = every nationality (and not compared).
  nationalityRule: NationalityRuleSchema.optional(), nationalityCodes: NationalityCodesSchema.optional(),
  // D-64: checked with SCFHS, and suspended at once on an adverse answer; left out = off (and not compared).
  scfhsEnabled: z.boolean().optional(), scfhsAutoSuspend: z.boolean().optional(),
});

export const BaselineFile = z.strictObject({
  format: z.literal('aigh-hospital-baseline'),
  version: z.literal(1),
  description: z.string().max(500).optional(),
  departments: z.array(DepartmentRow).max(200).default([]),
  units: z.array(UnitRow).max(1000).default([]),
  positions: z.array(PositionRow).max(200).default([]),
  credentialCategories: z.array(CategoryRow).max(100).default([]),
  credentialTemplates: z.array(TemplateRow).max(500).default([]),
});
export type BaselineFile = z.infer<typeof BaselineFile>;

export const BaselineRequestBody = z.strictObject({
  file: z.unknown(),
  reason: z.string().trim().min(10, 'An import needs a reason of at least 10 characters').max(1000),
});
export const BaselinePreviewBody = z.strictObject({ file: z.unknown() });

type Section = 'departments' | 'units' | 'positions' | 'credentialCategories' | 'credentialTemplates';
const SECTIONS: Section[] = ['departments', 'units', 'positions', 'credentialCategories', 'credentialTemplates'];
type RowStatus = 'CREATE' | 'UNCHANGED' | 'CONFLICT' | 'REJECTED';
export interface RowResult { section: Section; code: string; status: RowStatus; issues: string[] }
export interface BaselineReport {
  fileHash: string;
  counts: Record<Section, Record<RowStatus, number>>;
  totals: Record<RowStatus, number> & { beds: number; fields: number };
  rows: RowResult[];
  canImport: boolean;
}

export interface BaselineApprovalPayload { kind: 'BASELINE_IMPORT'; file: BaselineFile; fileHash: string; totals: BaselineReport['totals']; reason: string }
export const isBaselinePayload = (p: { kind: string }): p is BaselineApprovalPayload => p.kind === 'BASELINE_IMPORT';

// ── Helpers ─────────────────────────────────────────────────────────────────

const orNull = (v: unknown) => (v === undefined ? null : v);
/** Key order is not compared: stored approval payloads come back from jsonb with their keys re-sorted. */
const same = sameValue;
/** Keys whose values differ between the file row and the stored record. */
function differences(fileRow: Record<string, unknown>, stored: Record<string, unknown>) {
  return Object.keys(fileRow).filter((k) => !same(fileRow[k], stored[k])).map((k) => `${k}: stored ${JSON.stringify(stored[k] ?? null)}, file ${JSON.stringify(fileRow[k] ?? null)}`);
}

export function parseBaseline(raw: unknown): BaselineFile {
  const r = BaselineFile.safeParse(raw);
  if (!r.success) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'The file is not a valid hospital baseline', r.error.issues.slice(0, 50).map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return r.data;
}

const hashOf = (file: BaselineFile) => createHash('sha256').update(JSON.stringify(file)).digest('hex');

// ── Preview: validate every row against the file and the database ──────────

export async function previewBaseline(tx: DbClient, file: BaselineFile): Promise<BaselineReport> {
  const rows: RowResult[] = [];
  const push = (section: Section, code: string, status: RowStatus, issues: string[] = []) => rows.push({ section, code, status, issues });
  const dupes = (list: Array<{ code: string }>) => {
    const seen = new Set<string>(); const d = new Set<string>();
    for (const r of list) (seen.has(r.code) ? d : seen).add(r.code);
    return d;
  };

  // Sequential on purpose: `tx` may be an interactive transaction, which pins a
  // single pg client — concurrent queries on it are deprecated (removed in pg 9).
  const depts = await tx.department.findMany();
  const units = await tx.unit.findMany({ include: { department: { select: { code: true } } } });
  const positions = await tx.position.findMany();
  const cats = await tx.credentialCategory.findMany();
  const tpls = await tx.credentialTemplate.findMany({ include: WITH_FIELDS });
  const nationalityCodes = new Set((await tx.nationality.findMany({ select: { code: true } })).map((n) => n.code));
  const dbDept = new Map(depts.map((d) => [d.code, d]));
  const dbUnit = new Map(units.map((u) => [u.code, u]));
  const dbPos = new Map(positions.map((p) => [p.code, p]));
  const dbCat = new Map(cats.map((c) => [c.code, c]));
  const dbTpl = new Map(tpls.map((t) => [t.code, t]));
  const fileDept = new Set(file.departments.map((d) => d.code));
  const filePos = new Set(file.positions.map((p) => p.code));
  const fileCat = new Set(file.credentialCategories.map((c) => c.code));

  let d = dupes(file.departments);
  for (const r of file.departments) {
    if (d.has(r.code)) { push('departments', r.code, 'REJECTED', ['code appears more than once in the file']); continue; }
    const s = dbDept.get(r.code);
    if (!s) { push('departments', r.code, 'CREATE'); continue; }
    const diff = differences({ name: r.name, nameAr: orNull(r.nameAr), description: orNull(r.description) }, s);
    push('departments', r.code, diff.length ? 'CONFLICT' : 'UNCHANGED', diff);
  }

  d = dupes(file.units);
  for (const r of file.units) {
    if (d.has(r.code)) { push('units', r.code, 'REJECTED', ['code appears more than once in the file']); continue; }
    if (!fileDept.has(r.departmentCode) && !dbDept.has(r.departmentCode)) { push('units', r.code, 'REJECTED', [`department ${r.departmentCode} is neither in the file nor in the database`]); continue; }
    const s = dbUnit.get(r.code);
    if (!s) { push('units', r.code, 'CREATE'); continue; }
    const diff = differences(
      { name: r.name, nameAr: orNull(r.nameAr), description: orNull(r.description), departmentCode: r.departmentCode, bedCount: r.bedCount, criticalArea: orNull(r.criticalArea) },
      { ...s, departmentCode: s.department.code },
    );
    push('units', r.code, diff.length ? 'CONFLICT' : 'UNCHANGED', diff);
  }

  d = dupes(file.positions);
  for (const r of file.positions) {
    if (d.has(r.code)) { push('positions', r.code, 'REJECTED', ['code appears more than once in the file']); continue; }
    if (r.replacedBy !== undefined) {
      if (r.replacedBy === r.code) { push('positions', r.code, 'REJECTED', ['a position cannot replace itself']); continue; }
      if (!filePos.has(r.replacedBy) && !dbPos.has(r.replacedBy)) { push('positions', r.code, 'REJECTED', [`replacement ${r.replacedBy} is neither in the file nor in the database`]); continue; }
    }
    const s = dbPos.get(r.code);
    if (!s) { push('positions', r.code, 'CREATE'); continue; }
    const diff = differences(
      { title: r.title, titleAr: orNull(r.titleAr), tier: r.tier, description: orNull(r.description), isSchedulable: r.isSchedulable, isActive: r.isActive, displayOrder: r.displayOrder, replacedBy: orNull(r.replacedBy) },
      s,
    );
    push('positions', r.code, diff.length ? 'CONFLICT' : 'UNCHANGED', diff);
  }

  d = dupes(file.credentialCategories);
  for (const r of file.credentialCategories) {
    if (d.has(r.code)) { push('credentialCategories', r.code, 'REJECTED', ['code appears more than once in the file']); continue; }
    const s = dbCat.get(r.code);
    if (!s) { push('credentialCategories', r.code, 'CREATE'); continue; }
    const diff = differences({ name: r.name, description: orNull(r.description), displayOrder: r.displayOrder }, s);
    push('credentialCategories', r.code, diff.length ? 'CONFLICT' : 'UNCHANGED', diff);
  }

  d = dupes(file.credentialTemplates);
  for (const r of file.credentialTemplates) {
    if (d.has(r.code)) { push('credentialTemplates', r.code, 'REJECTED', ['code appears more than once in the file']); continue; }
    if (!fileCat.has(r.categoryCode) && !dbCat.has(r.categoryCode)) { push('credentialTemplates', r.code, 'REJECTED', [`category ${r.categoryCode} is neither in the file nor in the database`]); continue; }
    const rule = r.nationalityRule ?? 'ALL';
    const codes = r.nationalityCodes ?? [];
    if ((rule === 'ALL') !== (codes.length === 0)) { push('credentialTemplates', r.code, 'REJECTED', [rule === 'ALL' ? 'nationalityCodes must be empty for nationalityRule ALL' : `nationalityRule ${rule} needs at least one nationality code`]); continue; }
    const unknownCodes = codes.filter((c) => !nationalityCodes.has(c));
    if (unknownCodes.length) { push('credentialTemplates', r.code, 'REJECTED', [`not on the nationality list: ${unknownCodes.join(', ')}`]); continue; }
    if (r.scfhsAutoSuspend && !r.scfhsEnabled) { push('credentialTemplates', r.code, 'REJECTED', ['scfhsAutoSuspend needs scfhsEnabled']); continue; }
    if (r.scfhsEnabled && !r.fields.some((f) => f.pdplCategory === 'SCFHS_REG')) { push('credentialTemplates', r.code, 'REJECTED', ['scfhsEnabled needs a field with pdplCategory SCFHS_REG']); continue; }
    const s = dbTpl.get(r.code);
    if (!s) { push('credentialTemplates', r.code, 'CREATE'); continue; }
    const diff = differences(
      {
        name: r.name, categoryCode: r.categoryCode, description: orNull(r.description), hasExpiry: r.hasExpiry, requiresUpload: r.requiresUpload, gracePeriodDays: r.gracePeriodDays, displayOrder: r.displayOrder, isActive: r.isActive, fields: r.fields.map(canonicalField),
        ...(r.nationalityRule !== undefined ? { nationalityRule: rule, nationalityCodes: codes } : {}),
        ...(r.scfhsEnabled !== undefined ? { scfhsEnabled: r.scfhsEnabled } : {}),
        ...(r.nameAr !== undefined ? { nameAr: r.nameAr } : {}),
        ...(r.scfhsAutoSuspend !== undefined ? { scfhsAutoSuspend: r.scfhsAutoSuspend } : {}),
      },
      { ...s, fields: toFieldDefs(s.fields) },
    );
    push('credentialTemplates', r.code, diff.length ? 'CONFLICT' : 'UNCHANGED', diff);
  }

  const zero = (): Record<RowStatus, number> => ({ CREATE: 0, UNCHANGED: 0, CONFLICT: 0, REJECTED: 0 });
  const counts = Object.fromEntries(SECTIONS.map((s) => [s, zero()])) as BaselineReport['counts'];
  for (const r of rows) counts[r.section][r.status] += 1;
  const totals = { ...zero(), beds: file.units.reduce((n, u) => n + u.bedCount, 0), fields: file.credentialTemplates.reduce((n, t) => n + t.fields.length, 0) };
  for (const r of rows) totals[r.status] += 1;
  return { fileHash: hashOf(file), counts, totals, rows, canImport: totals.REJECTED === 0 && totals.CONFLICT === 0 && totals.CREATE > 0 };
}

// ── Apply (inside the approval's transaction) ───────────────────────────────

export async function applyBaseline(tx: DbClient, actorUserId: number, file: BaselineFile, reason: string, approvalRequestId: number | null, requestId?: string) {
  const report = await previewBaseline(tx, file);
  if (report.totals.REJECTED || report.totals.CONFLICT) {
    throw new HttpError(409, 'BASELINE_CHANGED_SINCE_REQUEST', 'The database has changed since this import was requested — reject it and preview the file again', report.rows.filter((r) => r.status === 'REJECTED' || r.status === 'CONFLICT'));
  }
  const creates = new Set(report.rows.filter((r) => r.status === 'CREATE').map((r) => `${r.section}:${r.code}`));
  const isNew = (section: Section, code: string) => creates.has(`${section}:${code}`);

  for (const r of file.departments.filter((x) => isNew('departments', x.code))) {
    await tx.department.create({ data: { code: r.code, name: r.name, nameAr: orNull(r.nameAr) as string | null, description: orNull(r.description) as string | null } });
  }
  const deptId = new Map((await tx.department.findMany({ select: { id: true, code: true } })).map((d) => [d.code, d.id]));
  for (const r of file.units.filter((x) => isNew('units', x.code))) {
    const unit = await tx.unit.create({
      data: { code: r.code, name: r.name, nameAr: r.nameAr ?? null, description: r.description ?? null, departmentId: deptId.get(r.departmentCode)!, bedCount: r.bedCount, criticalArea: r.criticalArea ?? null },
    });
    // W4: every bed count has a history, starting with the import.
    await tx.bedCapacityLog.create({ data: { unitId: unit.id, previousCount: 0, newCount: r.bedCount, reason: `Baseline import (approval #${approvalRequestId ?? 'break-glass'})`, changedById: actorUserId } });
  }
  // Positions in two passes, so a replacement may appear later in the file.
  const newPositions = file.positions.filter((x) => isNew('positions', x.code));
  for (const r of newPositions) {
    await tx.position.create({ data: { code: r.code, title: r.title, titleAr: r.titleAr ?? null, tier: r.tier, description: r.description ?? null, isSchedulable: r.isSchedulable, isActive: r.isActive, displayOrder: r.displayOrder } });
  }
  for (const r of newPositions.filter((x) => x.replacedBy)) await tx.position.update({ where: { code: r.code }, data: { replacedBy: r.replacedBy } });
  for (const r of file.credentialCategories.filter((x) => isNew('credentialCategories', x.code))) {
    await tx.credentialCategory.create({ data: { code: r.code, name: r.name, description: r.description ?? null, displayOrder: r.displayOrder } });
  }
  for (const r of file.credentialTemplates.filter((x) => isNew('credentialTemplates', x.code))) {
    const t = await tx.credentialTemplate.create({
      data: {
        code: r.code, name: r.name, nameAr: r.nameAr ?? null, categoryCode: r.categoryCode, description: r.description ?? null, hasExpiry: r.hasExpiry, requiresUpload: r.requiresUpload, gracePeriodDays: r.gracePeriodDays, displayOrder: r.displayOrder, isActive: r.isActive,
        nationalityRule: r.nationalityRule ?? 'ALL', nationalityCodes: r.nationalityCodes ?? [],
        scfhsEnabled: r.scfhsEnabled ?? false, scfhsAutoSuspend: r.scfhsAutoSuspend ?? false,
      },
    });
    await tx.credentialTemplateField.createMany({ data: fieldRows(t.id, r.fields) });
  }

  const created = Object.fromEntries(SECTIONS.map((s) => [s, report.rows.filter((r) => r.section === s && r.status === 'CREATE').map((r) => r.code)]));
  await appendAudit(tx, {
    actorUserId, action: 'BASELINE_IMPORTED', resource: 'system', priority: 'HIGH', requestId,
    changes: { fileHash: report.fileHash, reason, approvalRequestId, created, unchanged: report.totals.UNCHANGED, beds: report.totals.beds, fields: report.totals.fields },
  });
  return report;
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createBaselineImportService(db: Db) {
  async function assertSystemWide(tx: DbClient, auth: AuthContext) {
    if (!(await unitScope(tx, auth, ['HR_ADMIN', 'SYSTEM_ADMIN'])).all) {
      throw new HttpError(403, 'SCOPE_NOT_COVERED', 'Only hospital-wide administrators can import hospital master data');
    }
  }

  return {
    async preview(auth: AuthContext, raw: unknown) {
      await assertSystemWide(db, auth);
      return previewBaseline(db, parseBaseline(raw));
    },

    /** Validates, then queues the import for a second administrator (or applies it for break-glass). */
    async request(auth: AuthContext, raw: unknown, reason: string, requestId?: string) {
      await assertSystemWide(db, auth);
      const file = parseBaseline(raw);
      const report = await previewBaseline(db, file);
      if (!report.canImport) {
        throw unprocessable(report.totals.CREATE === 0 && !report.totals.REJECTED && !report.totals.CONFLICT ? 'NOTHING_TO_IMPORT' : 'BASELINE_NOT_IMPORTABLE',
          report.totals.CREATE === 0 && !report.totals.REJECTED && !report.totals.CONFLICT ? 'Every row already exists unchanged — nothing to import' : 'Rejected or conflicting rows must be resolved before importing', report);
      }
      if (auth.breakGlass) {
        const applied = await db.$transaction((tx) => applyBaseline(tx, auth.user.id, file, reason, null, requestId), { timeout: 120_000 });
        return { status: 'APPLIED' as const, report: applied };
      }
      const payload: BaselineApprovalPayload = { kind: 'BASELINE_IMPORT', file, fileHash: report.fileHash, totals: report.totals, reason };
      const req = await db.$transaction(async (tx) => {
        const r = await tx.approvalRequest.create({ data: { initiatorId: auth.user.id, actionType: `BASELINE_IMPORT:${report.fileHash.slice(0, 16)}`, payload: payload as unknown as Prisma.InputJsonObject } });
        await appendAudit(tx, {
          actorUserId: auth.user.id, action: 'APPROVAL_INITIATED', resource: 'approval_request', resourceId: r.id, requestId, priority: 'HIGH',
          changes: { actionType: 'BASELINE_IMPORT', fileHash: report.fileHash, totals: report.totals, reason },
        });
        return r;
      });
      return { status: 'PENDING_APPROVAL' as const, requestId: req.id, report };
    },

    /** Runs as the approver inside the approval's transaction; any failure rolls everything back. */
    async executeApproved(tx: DbClient, approver: AuthContext, payload: BaselineApprovalPayload, approvalRequestId: number, requestId?: string) {
      await assertSystemWide(tx, approver);
      await applyBaseline(tx, approver.user.id, parseBaseline(payload.file), payload.reason, approvalRequestId, requestId);
      return approvalRequestId;
    },
  };
}

export type BaselineImportService = ReturnType<typeof createBaselineImportService>;
