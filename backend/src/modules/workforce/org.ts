// Organisation structure (spec §2.9, §3.1.1, §6.3; rules W1–W8).
//
// Departments, units, positions and the CSV import are one hospital-wide
// configuration, so only system-wide HR / System Admins change them (the same
// principle as the credential catalog, D-25). Bed counts and coverage targets
// belong to a unit, so a unit-scoped HR Admin may change them for their units.
// Every bed change is logged with actor, reason, before and after (W4).

import { inTransaction, type Transaction } from '../../lib/transaction.js';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { assertUnchanged } from '../../lib/concurrency.js';
import { conflict, HttpError, notFound, unprocessable } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { refreshEligibility } from '../eligibility/state.service.js';
import { unitScope, type AuthContext, type UnitScope } from '../users/access.js';

const HR_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'] as const;
/** W4, and the chk bed_count BETWEEN 0 AND 500 constraint. */
export const MAX_BEDS = 500;

export const Code = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/, 'Code: letters, digits and _ (max 20), starting with a letter'));
export const Name = z.string().trim().min(1).max(120);
export const NameAr = z.string().trim().max(120);
export const Description = z.string().trim().max(500);
const Reason = z.string().trim().min(3, 'A reason is required for every bed-capacity change (W4)').max(200);
export const Beds = z.number().int().min(0).max(MAX_BEDS);

export const DepartmentCreateBody = z.strictObject({ code: Code, name: Name, nameAr: NameAr.optional(), description: Description.optional() });
export const DepartmentUpdateBody = z.strictObject({ name: Name.optional(), nameAr: NameAr.nullable().optional(), description: Description.nullable().optional(), isActive: z.boolean().optional() });

export const UnitsQuery = z.object({
  departmentId: z.coerce.number().int().positive().optional(),
  includeInactive: z.enum(['true', 'false']).default('false'),
});
/** MoH Ada'a critical area for nurse-to-bed KPI A (D-11); null = not a critical area.
 *  patientCareArea / inpatientBeds (units) and countsAsNurse (positions) are the KPI basis (D-70). */
export const CriticalAreaValue = z.enum(['ICU', 'ER', 'OR']);
export const UnitCreateBody = z.strictObject({
  code: Code, name: Name, nameAr: NameAr.optional(), description: Description.optional(),
  departmentId: z.number().int().positive(), bedCount: Beds.default(0), criticalArea: CriticalAreaValue.nullable().default(null),
  patientCareArea: z.boolean().default(true), inpatientBeds: z.boolean().default(false),
});
export const UnitUpdateBody = z.strictObject({
  name: Name.optional(), nameAr: NameAr.nullable().optional(), description: Description.nullable().optional(),
  departmentId: z.number().int().positive().optional(), isActive: z.boolean().optional(), criticalArea: CriticalAreaValue.nullable().optional(),
  patientCareArea: z.boolean().optional(), inpatientBeds: z.boolean().optional(),
});
export const BedCountBody = z.strictObject({ bedCount: Beds, reason: Reason });
// Row values are checked per row (W5 reports REJECTED rows instead of failing the batch).
export const BulkBedsBody = z.strictObject({
  rows: z.array(z.strictObject({ unitCode: z.string().trim().min(1).max(20), bedCount: z.number() })).min(1).max(500),
  reason: Reason,
});
export const ImportBody = z.strictObject({ csv: z.string().min(1).max(500_000), dryRun: z.boolean().default(true) });

/** Spec §3.1.1 position tiers. */
export const TIERS = ['Executive', 'Administrative', 'Management', 'Specialist', 'Advanced Practice', 'Clinical Lead', 'Clinical', 'Clinical Specialist', 'Support'] as const;
export const PositionCreateBody = z.strictObject({
  code: Code, title: Name, titleAr: NameAr.optional(), tier: z.enum(TIERS), description: Description.optional(),
  isSchedulable: z.boolean(), countsAsNurse: z.boolean().default(false), displayOrder: z.number().int().min(0).default(0),
});
export const PositionUpdateBody = z.strictObject({
  title: Name.optional(), titleAr: NameAr.nullable().optional(), tier: z.enum(TIERS).optional(), description: Description.nullable().optional(),
  isSchedulable: z.boolean().optional(), countsAsNurse: z.boolean().optional(), isActive: z.boolean().optional(), displayOrder: z.number().int().min(0).optional(),
});

const ShiftType = z.enum(['Morning', 'Evening', 'Night']);
export const CoverageQuery = z.object({ unitId: z.coerce.number().int().positive().optional() });
/** `minimumStaff: null` removes the target: the unit/shift becomes "unspecified", never zero (W8). */
export const CoverageBody = z.strictObject({ unitId: z.number().int().positive(), shiftType: ShiftType, minimumStaff: z.number().int().min(0).max(999).nullable() });

export type BulkRowResult = { unitCode: string; status: 'UPDATED' | 'UNCHANGED' | 'REJECTED'; reason?: string; previous?: number; next?: number };
export type ImportRowResult = { line: number; unitCode: string; status: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED'; reason?: string };

// ── CSV ─────────────────────────────────────────────────────────────────────

const IMPORT_HEADER = ['unit_code', 'name', 'department_code', 'beds'] as const;

/** RFC 4180 fields: commas and doubled quotes inside quoted fields (V03 split on every comma). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (quoted) throw new HttpError(400, 'CSV_INVALID', 'Unclosed quote in CSV');
  out.push(cur.trim());
  return out;
}

/** Spreadsheet exports often start with a UTF-8 byte-order mark. */
const BOM = String.fromCharCode(0xfeff);

interface CsvRow { line: number; unitCode: string; name: string; departmentCode: string; beds: number; description?: string }

export function parseUnitsCsv(csv: string): CsvRow[] {
  const lines = (csv.startsWith(BOM) ? csv.slice(1) : csv).split(/\r?\n/).map((l, i) => ({ text: l, line: i + 1 })).filter((l) => l.text.trim() !== '');
  if (lines.length === 0) throw new HttpError(400, 'CSV_INVALID', 'The CSV is empty');
  const header = parseCsvLine(lines[0]!.text).map((h) => h.toLowerCase());
  const missing = IMPORT_HEADER.filter((h) => !header.includes(h));
  if (missing.length) throw new HttpError(400, 'CSV_INVALID', `CSV header is missing: ${missing.join(', ')}`);
  if (lines.length - 1 > 500) throw new HttpError(400, 'CSV_INVALID', 'At most 500 rows per import');
  const col = (cells: string[], name: string) => (header.indexOf(name) >= 0 ? cells[header.indexOf(name)] ?? '' : undefined);
  return lines.slice(1).map(({ text, line }) => {
    const cells = parseCsvLine(text);
    const beds = col(cells, 'beds')!;
    return {
      line,
      unitCode: col(cells, 'unit_code')!.toUpperCase(),
      name: col(cells, 'name')!,
      departmentCode: col(cells, 'department_code')!.toUpperCase(),
      beds: /^\d+$/.test(beds) ? Number(beds) : Number.NaN,
      description: col(cells, 'description') || undefined,
    };
  });
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createOrgService(db: Db) {
  async function assertSystemWide(tx: DbClient, auth: AuthContext) {
    if (!(await unitScope(tx, auth, HR_ROLES)).all) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'Only system-wide administrators can change the hospital organisation structure');
  }
  const hrScope = (tx: DbClient, auth: AuthContext) => unitScope(tx, auth, HR_ROLES);
  const covers = (scope: UnitScope, unitId: number) => scope.all || scope.unitIds.has(unitId);
  async function assertUnitInScope(tx: DbClient, auth: AuthContext, unitId: number) {
    if (!covers(await hrScope(tx, auth), unitId)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This unit is outside your assigned scope');
  }

  async function setBeds(tx: DbClient, auth: AuthContext, unit: { id: number; bedCount: number }, bedCount: number, reason: string) {
    await tx.bedCapacityLog.create({ data: { unitId: unit.id, previousCount: unit.bedCount, newCount: bedCount, reason, changedById: auth.user.id } });
    await tx.unit.update({ where: { id: unit.id }, data: { bedCount } });
  }

  const activeEmployees = (tx: DbClient, where: object) => tx.employee.count({ where: { ...where, deletedAt: null } });

  return {
    // ── Departments ──
    async listDepartments(includeInactive: boolean) {
      const items = await db.department.findMany({ where: includeInactive ? {} : { isActive: true }, orderBy: { code: 'asc' } });
      return { items, total: items.length };
    },

    async createDepartment(auth: AuthContext, body: z.infer<typeof DepartmentCreateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        if (await tx.department.findUnique({ where: { code: body.code } })) throw conflict('DEPARTMENT_EXISTS', `A department with code ${body.code} already exists`);
        const d = await tx.department.create({ data: body });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'DEPARTMENT_CREATED', resource: 'department', resourceId: d.id, changes: body, requestId });
        return d;
      });
    },

    // `expected` on the updates below: the version the caller loaded (If-Match); a newer one is refused (STALE_RECORD).
    async updateDepartment(auth: AuthContext, id: number, body: z.infer<typeof DepartmentUpdateBody>, requestId?: string, expected: Date | null = null) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        await tx.$queryRaw`SELECT id FROM departments WHERE id = ${id} FOR UPDATE`;
        const before = await tx.department.findUnique({ where: { id } });
        if (!before) throw notFound('Department not found');
        assertUnchanged(expected, before);
        if (body.isActive === false && before.isActive && (await tx.unit.count({ where: { departmentId: id, isActive: true } })) > 0) {
          throw conflict('DEPARTMENT_HAS_ACTIVE_UNITS', 'Deactivate or move its active units first (W1)');
        }
        const d = await tx.department.update({ where: { id }, data: body });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'DEPARTMENT_UPDATED', resource: 'department', resourceId: id, changes: { before, after: body }, requestId });
        return d;
      });
    },

    // ── Units ──
    async listUnits(q: z.infer<typeof UnitsQuery>) {
      const items = await db.unit.findMany({
        where: { ...(q.departmentId ? { departmentId: q.departmentId } : {}), ...(q.includeInactive === 'true' ? {} : { isActive: true }) },
        orderBy: { code: 'asc' },
      });
      return { items, total: items.length };
    },

    /** Live bed totals (active units). The seeded 582 is a baseline, not a constant (W3). */
    async summary() {
      const [units, departments] = await Promise.all([
        db.unit.findMany({ where: { isActive: true }, select: { departmentId: true, bedCount: true } }),
        db.department.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
      ]);
      const byDepartment = departments.map((d) => {
        const mine = units.filter((u) => u.departmentId === d.id);
        return { ...d, units: mine.length, beds: mine.reduce((s, u) => s + u.bedCount, 0) };
      }).filter((d) => d.units > 0);
      return { unitCount: units.length, totalBeds: units.reduce((s, u) => s + u.bedCount, 0), byDepartment };
    },

    async createUnit(auth: AuthContext, body: z.infer<typeof UnitCreateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        const dept = await tx.department.findUnique({ where: { id: body.departmentId } });
        if (!dept || !dept.isActive) throw unprocessable('DEPARTMENT_NOT_ACTIVE', 'The department does not exist or is inactive');
        if (await tx.unit.findUnique({ where: { code: body.code } })) throw conflict('UNIT_EXISTS', `A unit with code ${body.code} already exists`);
        const u = await tx.unit.create({ data: body });
        if (body.bedCount > 0) await tx.bedCapacityLog.create({ data: { unitId: u.id, previousCount: 0, newCount: body.bedCount, reason: 'Unit created', changedById: auth.user.id } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'UNIT_CREATED', resource: 'unit', resourceId: u.id, changes: body, requestId });
        return u;
      });
    },

    async updateUnit(auth: AuthContext, id: number, body: z.infer<typeof UnitUpdateBody>, requestId?: string, expected: Date | null = null) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        await tx.$queryRaw`SELECT id FROM units WHERE id = ${id} FOR UPDATE`;
        const before = await tx.unit.findUnique({ where: { id } });
        if (!before) throw notFound('Unit not found');
        assertUnchanged(expected, before);
        if (body.departmentId !== undefined && body.departmentId !== before.departmentId) {
          const dept = await tx.department.findUnique({ where: { id: body.departmentId } });
          if (!dept || !dept.isActive) throw unprocessable('DEPARTMENT_NOT_ACTIVE', 'The department does not exist or is inactive');
        }
        if (body.isActive === false && before.isActive && (await activeEmployees(tx, { unitId: id })) > 0) {
          throw conflict('UNIT_HAS_ACTIVE_EMPLOYEES', 'Move its employees to another unit first (W2)');
        }
        if (body.isActive === true && !before.isActive) {
          const dept = await tx.department.findUniqueOrThrow({ where: { id: body.departmentId ?? before.departmentId } });
          if (!dept.isActive) throw unprocessable('DEPARTMENT_NOT_ACTIVE', 'Reactivate the department first');
        }
        const u = await tx.unit.update({ where: { id }, data: body });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'UNIT_UPDATED', resource: 'unit', resourceId: id, changes: { before, after: body }, requestId });
        return u;
      });
    },

    async setBedCount(auth: AuthContext, id: number, body: z.infer<typeof BedCountBody>, requestId?: string, expected: Date | null = null) {
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM units WHERE id = ${id} FOR UPDATE`;
        const unit = await tx.unit.findUnique({ where: { id } });
        if (!unit) throw notFound('Unit not found');
        await assertUnitInScope(tx, auth, id);
        assertUnchanged(expected, unit);
        if (unit.bedCount === body.bedCount) return { status: 'UNCHANGED' as const, bedCount: unit.bedCount };
        await setBeds(tx, auth, unit, body.bedCount, body.reason);
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'BED_CAPACITY_CHANGED', resource: 'unit', resourceId: id, changes: { previous: unit.bedCount, next: body.bedCount, reason: body.reason }, requestId });
        return { status: 'UPDATED' as const, bedCount: body.bedCount, previous: unit.bedCount };
      });
    },

    /** W5: per-row result; one log row per changed unit; all applied changes commit together. */
    async bulkBeds(auth: AuthContext, body: z.infer<typeof BulkBedsBody>, requestId?: string, transaction?: Transaction) {
      return inTransaction(db, transaction, async (tx) => {
        const scope = await hrScope(tx, auth);
        const results: BulkRowResult[] = [];
        const seen = new Set<string>();
        for (const row of body.rows) {
          const code = row.unitCode.toUpperCase();
          if (seen.has(code)) { results.push({ unitCode: code, status: 'REJECTED', reason: 'Duplicate unit code in this batch' }); continue; }
          seen.add(code);
          const unit = await tx.unit.findFirst({ where: { code: { equals: code, mode: 'insensitive' } } });
          if (!unit) { results.push({ unitCode: code, status: 'REJECTED', reason: 'Unknown unit code' }); continue; }
          if (!covers(scope, unit.id)) { results.push({ unitCode: code, status: 'REJECTED', reason: 'Outside your assigned scope' }); continue; }
          if (!Beds.safeParse(row.bedCount).success) { results.push({ unitCode: code, status: 'REJECTED', reason: `Bed count must be a whole number from 0 to ${MAX_BEDS}` }); continue; }
          if (unit.bedCount === row.bedCount) { results.push({ unitCode: code, status: 'UNCHANGED', next: row.bedCount }); continue; }
          await setBeds(tx, auth, unit, row.bedCount, body.reason);
          results.push({ unitCode: code, status: 'UPDATED', previous: unit.bedCount, next: row.bedCount });
        }
        const count = (s: BulkRowResult['status']) => results.filter((r) => r.status === s).length;
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'BED_CAPACITY_BULK_UPDATED', resource: 'unit', changes: { updated: count('UPDATED'), unchanged: count('UNCHANGED'), rejected: count('REJECTED'), reason: body.reason }, requestId });
        return { results, updated: count('UPDATED'), unchanged: count('UNCHANGED'), rejected: count('REJECTED') };
      }, { timeout: 60_000 });
    },

    /** CSV import of units and beds. Dry run by default; never deletes or deactivates a unit. */
    async importUnits(auth: AuthContext, body: z.infer<typeof ImportBody>, requestId?: string, transaction?: Transaction) {
      await assertSystemWide(transaction ?? db, auth);
      const rows = parseUnitsCsv(body.csv);
      return inTransaction(db, transaction, async (tx) => {
        // Sequential: inside a transaction (one pinned pg connection; no concurrent queries).
        const departments = await tx.department.findMany();
        const units = await tx.unit.findMany();
        // Codes compare without case (the API stores them upper-case; older rows may not be).
        const deptByCode = new Map(departments.map((d) => [d.code.toUpperCase(), d]));
        const unitByCode = new Map(units.map((u) => [u.code.toUpperCase(), u]));
        const results: ImportRowResult[] = [];
        const seen = new Set<string>();
        const apply: Array<() => Promise<void>> = [];
        for (const row of rows) {
          const reject = (reason: string) => results.push({ line: row.line, unitCode: row.unitCode, status: 'REJECTED', reason });
          if (!Code.safeParse(row.unitCode).success) { reject('Invalid unit_code'); continue; }
          if (seen.has(row.unitCode)) { reject('Duplicate unit_code in file'); continue; }
          seen.add(row.unitCode);
          if (!Name.safeParse(row.name).success) { reject('name is required (max 120)'); continue; }
          const dept = deptByCode.get(row.departmentCode);
          if (!dept || !dept.isActive) { reject(`Unknown or inactive department_code ${row.departmentCode}`); continue; }
          if (!Beds.safeParse(row.beds).success) { reject(`beds must be a whole number from 0 to ${MAX_BEDS}`); continue; }
          if (row.description !== undefined && !Description.safeParse(row.description).success) { reject('description is too long (max 500)'); continue; }
          const existing = unitByCode.get(row.unitCode);
          if (!existing) {
            results.push({ line: row.line, unitCode: row.unitCode, status: 'CREATED' });
            apply.push(async () => {
              const u = await tx.unit.create({ data: { code: row.unitCode, name: row.name, description: row.description, departmentId: dept.id, bedCount: row.beds } });
              if (row.beds > 0) await tx.bedCapacityLog.create({ data: { unitId: u.id, previousCount: 0, newCount: row.beds, reason: 'CSV import: unit created', changedById: auth.user.id } });
            });
            continue;
          }
          const changed = existing.name !== row.name || existing.departmentId !== dept.id || existing.bedCount !== row.beds
            || (row.description !== undefined && existing.description !== row.description);
          if (!changed) { results.push({ line: row.line, unitCode: row.unitCode, status: 'UNCHANGED' }); continue; }
          results.push({ line: row.line, unitCode: row.unitCode, status: 'UPDATED' });
          apply.push(async () => {
            if (existing.bedCount !== row.beds) await setBeds(tx, auth, existing, row.beds, 'CSV import: bed capacity');
            await tx.unit.update({ where: { id: existing.id }, data: { name: row.name, departmentId: dept.id, ...(row.description !== undefined ? { description: row.description } : {}) } });
          });
        }
        const count = (s: ImportRowResult['status']) => results.filter((r) => r.status === s).length;
        const out = { dryRun: body.dryRun, results, created: count('CREATED'), updated: count('UPDATED'), unchanged: count('UNCHANGED'), rejected: count('REJECTED') };
        if (body.dryRun || apply.length === 0) return out;
        for (const fn of apply) await fn();
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'UNITS_IMPORTED', resource: 'unit', changes: { created: out.created, updated: out.updated, unchanged: out.unchanged, rejected: out.rejected }, requestId });
        return out;
      }, { timeout: 60_000 });
    },

    async bedHistory(auth: AuthContext, id: number) {
      const unit = await db.unit.findUnique({ where: { id }, select: { id: true } });
      if (!unit) throw notFound('Unit not found');
      if (!covers(await unitScope(db, auth, ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR']), id)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This unit is outside your assigned scope');
      const rows = await db.bedCapacityLog.findMany({ where: { unitId: id }, orderBy: { changedAt: 'desc' }, take: 200 });
      const actors = await db.user.findMany({ where: { id: { in: rows.flatMap((r) => (r.changedById ? [r.changedById] : [])) } }, select: { id: true, displayName: true } });
      const name = new Map(actors.map((a) => [a.id, a.displayName]));
      return { items: rows.map((r) => ({ ...r, changedBy: r.changedById ? name.get(r.changedById) ?? null : null })), total: rows.length };
    },

    // ── Positions (§3.1.1) ──
    async listPositions(includeInactive: boolean) {
      const items = await db.position.findMany({ where: includeInactive ? {} : { isActive: true }, orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }] });
      return { items, total: items.length };
    },

    async getPosition(code: string) {
      const p = await db.position.findUnique({ where: { code } });
      if (!p) throw notFound('Position not found');
      return p;
    },

    async createPosition(auth: AuthContext, body: z.infer<typeof PositionCreateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        if (await tx.position.findUnique({ where: { code: body.code } })) throw conflict('POSITION_EXISTS', `A position with code ${body.code} already exists`);
        const p = await tx.position.create({ data: body });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'POSITION_CREATED', resource: 'position', resourceId: p.code, changes: body, requestId });
        return p;
      });
    },

    async updatePosition(auth: AuthContext, code: string, body: z.infer<typeof PositionUpdateBody>, requestId?: string, expected: Date | null = null) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        await tx.$queryRaw`SELECT code FROM positions WHERE code = ${code} FOR UPDATE`;
        const before = await tx.position.findUnique({ where: { code } });
        if (!before) throw notFound('Position not found');
        assertUnchanged(expected, before);
        if (body.isActive === false && before.isActive && (await activeEmployees(tx, { positionCode: code })) > 0) {
          throw conflict('POSITION_IN_USE', 'Active employees hold this position — reassign them first (W6)');
        }
        const p = await tx.position.update({ where: { code }, data: body });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'POSITION_UPDATED', resource: 'position', resourceId: code, changes: { before, after: body }, requestId, priority: body.isSchedulable !== undefined ? 'HIGH' : 'NORMAL' });
        // Schedulability is eligibility check 2 (§6.1): re-evaluate holders in this transaction (L6).
        if (body.isSchedulable !== undefined && body.isSchedulable !== before.isSchedulable) {
          const holders = await tx.employee.findMany({ where: { positionCode: code, deletedAt: null }, select: { id: true } });
          for (const h of holders) await refreshEligibility(tx, h.id, 'POSITION_UPDATED', { actorUserId: auth.user.id, requestId });
        }
        return p;
      }, { timeout: 60_000 });
    },

    // ── Coverage targets (§6.3, W8) ──
    async listCoverage(q: z.infer<typeof CoverageQuery>) {
      const items = await db.coverageTarget.findMany({ where: q.unitId ? { unitId: q.unitId } : {}, orderBy: [{ unitId: 'asc' }, { shiftType: 'asc' }] });
      return { items, total: items.length };
    },

    async setCoverage(auth: AuthContext, body: z.infer<typeof CoverageBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        if (!(await tx.unit.findUnique({ where: { id: body.unitId }, select: { id: true } }))) throw notFound('Unit not found');
        await assertUnitInScope(tx, auth, body.unitId);
        const key = { unitId_shiftType: { unitId: body.unitId, shiftType: body.shiftType } };
        const before = await tx.coverageTarget.findUnique({ where: key });
        let after = null;
        if (body.minimumStaff === null) { if (before) await tx.coverageTarget.delete({ where: key }); }
        else after = await tx.coverageTarget.upsert({ where: key, create: { ...body, minimumStaff: body.minimumStaff, updatedById: auth.user.id }, update: { minimumStaff: body.minimumStaff, updatedById: auth.user.id } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'COVERAGE_TARGET_SET', resource: 'unit', resourceId: body.unitId, changes: { shiftType: body.shiftType, previous: before?.minimumStaff ?? null, next: body.minimumStaff }, requestId });
        return after ?? { unitId: body.unitId, shiftType: body.shiftType, minimumStaff: null };
      });
    },
  };
}

export type OrgService = ReturnType<typeof createOrgService>;
