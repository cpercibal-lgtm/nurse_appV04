// Staff import (D-72): HR loads up to 1,000 people from the staff import template.
// Each row becomes exactly what onboarding creates (employee + Draft contract),
// through the same onboardInTx, so the two can never apply different rules.
//
// The spreadsheet is read in the browser; this module receives JSON rows only
// (it never parses an uploaded file and stores none). `check` writes nothing and
// reports every row; `commit` re-checks inside one transaction and writes every
// row or none (all or nothing). The import only creates people: an existing job
// number is UNCHANGED when every imported field already matches, else CONFLICT;
// it is never overwritten.
//
// Responses hold row numbers, job numbers and codes only, never names, e-mails or
// phones: the idempotency store keeps the commit response.

import { inTransaction, type Transaction } from '../../lib/transaction.js';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { dbDate } from '../../lib/dates.js';
import { HttpError, unprocessable } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { HR_ROLES, inScope } from '../credentials/access.js';
import { unitScope, type AuthContext } from '../users/access.js';
import { DEFAULT_ONBOARDING_POSITION, OnboardBody, type NurseService } from './service.js';

export const IMPORT_MAX_ROWS = 1000;
/** Template versions this importer reads (version 2 still had a Salary column: refused in the browser). */
export const IMPORT_TEMPLATE_VERSIONS = [3] as const;

// Loose on purpose: a wrong value in one row is reported against that row (REJECTED), not as a 400 for the file.
const Cell = z.string().max(300).nullable();
export const ImportRow = z.strictObject({
  rowNumber: z.number().int().min(2).max(100_000),
  jobNumber: Cell, firstName: Cell, middleName: Cell, lastName: Cell,
  nationalityCode: Cell, contactEmail: Cell, primaryPhone: Cell, emergencyContactPhone: Cell,
  unitCode: Cell, positionCode: Cell, jobTitle: Cell, rankGradeCode: Cell, specialtyCode: Cell,
  jobPostRegionCode: Cell, jobPostCity: Cell, facility: Cell, fileNo: Cell, maritalStatus: Cell,
  hireDate: Cell, contractTypeCode: Cell, contractStart: Cell, contractEnd: Cell,
});
export type ImportRowInput = z.infer<typeof ImportRow>;

export const ImportBody = z.strictObject({
  templateVersion: z.literal(3),
  /** SHA-256 of the file, computed in the browser: recorded in the audit entry instead of the file. */
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  rows: z.array(ImportRow).min(1).max(IMPORT_MAX_ROWS),
});
export type ImportBodyInput = z.infer<typeof ImportBody>;

export type RowStatus = 'CREATE' | 'UNCHANGED' | 'CONFLICT' | 'REJECTED';
export interface Problem { column: string | null; code: string; message: string }
export interface RowReport { rowNumber: number; jobNumber: string | null; status: RowStatus; problems: Problem[] }

/** Compared for UNCHANGED (the contract is not: later contracts may differ from the first one). */
const COMPARED = ['firstName', 'middleName', 'lastName', 'jobTitle', 'fileNo', 'rankGradeCode', 'nationalityCode', 'jobPostRegionCode',
  'jobPostCityId', 'facilityId', 'specialtyCode', 'maritalStatus', 'contactEmail', 'primaryPhone', 'emergencyContactPhone', 'unitId', 'positionCode', 'hireDate'] as const;
/** The template column each API field comes from, for messages. */
const COLUMN: Record<string, string> = {
  jobNumber: 'Job Number', firstName: 'First Name', middleName: 'Middle Name', lastName: 'Last Name', nationalityCode: 'Nationality',
  contactEmail: 'Contact E-mail', primaryPhone: 'Mobile Phone', emergencyContactPhone: 'Emergency Contact Phone', unitId: 'Unit', unitCode: 'Unit',
  positionCode: 'Position', jobTitle: 'Job Title', rankGradeCode: 'Rank/Grade', specialtyCode: 'Nursing Specialty',
  jobPostRegionCode: 'Job Post Region', jobPostCityId: 'Job Post City', jobPostCity: 'Job Post City', facilityId: 'Facility', facility: 'Facility',
  fileNo: 'File No.', maritalStatus: 'Marital Status', hireDate: 'Hire Date', contractTypeCode: 'Contract Type',
  contractStart: 'Contract Start', contractEnd: 'Contract End',
};
const col = (field: string) => COLUMN[field] ?? field;
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const blank = (v: string | null) => (v === null || v.trim() === '' ? null : v.trim());

/** The master data one check needs, loaded once (in-memory checks keep 1,000 rows fast). */
async function loadMasters(tx: DbClient) {
  const [units, positions, nationalities, ranks, specialties, regions, cities, facilities, types] = await Promise.all([
    tx.unit.findMany({ select: { id: true, code: true, isActive: true } }),
    tx.position.findMany({ select: { code: true, isActive: true } }),
    tx.nationality.findMany({ select: { code: true, isActive: true } }),
    tx.rankGrade.findMany({ select: { code: true, isActive: true } }),
    tx.nursingSpecialty.findMany({ select: { code: true, isActive: true } }),
    tx.saudiRegion.findMany({ select: { code: true, isActive: true } }),
    tx.saudiCity.findMany({ select: { id: true, regionCode: true, name: true, isActive: true } }),
    tx.facility.findMany({ select: { id: true, name: true, isActive: true } }),
    tx.contractType.findMany({ select: { code: true, isActive: true } }),
  ]);
  const byCode = <T extends { code: string }>(xs: T[]) => new Map(xs.map((x) => [x.code.toUpperCase(), x]));
  return {
    units: byCode(units), positions: byCode(positions), nationalities: byCode(nationalities), ranks: byCode(ranks),
    specialties: byCode(specialties), regions: byCode(regions), types: byCode(types),
    cities, facilities: new Map(facilities.map((f) => [norm(f.name), f])),
  };
}
type Masters = Awaited<ReturnType<typeof loadMasters>>;

/** Listed and active, with the onboarding error codes (`<PREFIX>_INVALID` / `<PREFIX>_INACTIVE`). */
function listed(map: Map<string, { isActive: boolean }>, code: string, field: string, prefix: string, label: string, problems: Problem[]) {
  const hit = map.get(code.toUpperCase());
  if (!hit) problems.push({ column: col(field), code: prefix === 'NATIONALITY' ? 'NATIONALITY_INVALID' : `${prefix}_INVALID`, message: `Not a listed ${label}: ${code}` });
  else if (!hit.isActive) problems.push({ column: col(field), code: prefix === 'NATIONALITY' ? 'NATIONALITY_INVALID' : `${prefix}_INACTIVE`, message: `The ${label} ${code} is no longer in use` });
}

export function createStaffImportService(db: Db, nurses: NurseService) {
  /**
   * One row → the onboarding body, or the reasons it cannot be. Codes resolve to ids here (unit, city, facility);
   * everything else is validated by OnboardBody itself, so the field rules are not written twice.
   */
  function prepare(r: ImportRowInput, m: Masters, scope: Awaited<ReturnType<typeof unitScope>>) {
    const problems: Problem[] = [];
    let unitId: number | null = null;
    const unitCode = blank(r.unitCode);
    if (unitCode) {
      const u = m.units.get(unitCode.toUpperCase());
      if (!u) problems.push({ column: col('unitCode'), code: 'VALUE_NOT_LISTED', message: `Not a listed unit: ${unitCode}` });
      else if (!u.isActive) problems.push({ column: col('unitCode'), code: 'UNIT_NOT_ACTIVE', message: `The unit ${unitCode} is inactive (E5)` });
      else unitId = u.id;
    }
    if (!unitCode || unitId !== null) {
      if (!inScope(scope, unitId)) {
        problems.push({ column: col('unitId'), code: 'SCOPE_NOT_COVERED', message: unitId === null ? 'Only system-wide HR can leave an employee Unassigned' : 'This unit is outside your assigned scope' });
      }
    }

    const regionCode = blank(r.jobPostRegionCode)?.toUpperCase() ?? null;
    const cityName = blank(r.jobPostCity);
    let jobPostCityId: number | undefined;
    if (regionCode && cityName) {
      const inRegion = m.cities.find((c) => c.regionCode === regionCode && norm(c.name) === norm(cityName));
      if (inRegion) jobPostCityId = inRegion.id;
      else if (m.cities.some((c) => norm(c.name) === norm(cityName))) problems.push({ column: col('jobPostCity'), code: 'CITY_NOT_IN_REGION', message: `${cityName} is not in region ${regionCode}` });
      else problems.push({ column: col('jobPostCity'), code: 'VALUE_NOT_LISTED', message: `Not a listed city: ${cityName}` });
    }

    const facilityName = blank(r.facility);
    let facilityId: number | undefined;
    if (facilityName) {
      const f = m.facilities.get(norm(facilityName));
      if (!f) problems.push({ column: col('facility'), code: 'VALUE_NOT_LISTED', message: `Not a listed facility: ${facilityName}` });
      else facilityId = f.id;
    }

    const positionCode = blank(r.positionCode)?.toUpperCase();
    const candidate = {
      jobNumber: blank(r.jobNumber) ?? undefined, firstName: blank(r.firstName) ?? undefined, middleName: blank(r.middleName),
      lastName: blank(r.lastName) ?? undefined, jobTitle: blank(r.jobTitle), fileNo: blank(r.fileNo),
      rankGradeCode: blank(r.rankGradeCode) ?? undefined, nationalityCode: blank(r.nationalityCode) ?? undefined,
      jobPostRegionCode: regionCode ?? undefined, jobPostCityId, facilityId,
      specialtyCode: blank(r.specialtyCode) ?? undefined, maritalStatus: blank(r.maritalStatus),
      contactEmail: blank(r.contactEmail) ?? undefined, primaryPhone: blank(r.primaryPhone), emergencyContactPhone: blank(r.emergencyContactPhone),
      unitId, hireDate: blank(r.hireDate), positionCode: positionCode ?? DEFAULT_ONBOARDING_POSITION,
      contractStart: blank(r.contractStart) ?? undefined, contractEnd: blank(r.contractEnd) ?? undefined,
      contractTypeCode: blank(r.contractTypeCode) ?? undefined,
    };
    // A city or facility already reported above is not reported again as "required".
    const reported = new Set(problems.map((p) => p.column));
    const parsed = OnboardBody.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '');
        if (reported.has(col(field))) continue;
        problems.push({ column: field ? col(field) : null, code: 'INVALID_VALUE', message: issue.message });
      }
      return { problems, parsed: null };
    }
    const input = parsed.data;
    const p = input.positionCode ?? DEFAULT_ONBOARDING_POSITION;
    const pos = m.positions.get(p);
    if (!pos) problems.push({ column: col('positionCode'), code: positionCode ? 'POSITION_NOT_FOUND' : 'POSITION_REQUIRED', message: positionCode ? `The position ${p} does not exist (E4)` : `Choose a position: the default position ${DEFAULT_ONBOARDING_POSITION} (rule E6) does not exist` });
    else if (!pos.isActive) problems.push({ column: col('positionCode'), code: positionCode ? 'POSITION_NOT_ACTIVE' : 'POSITION_REQUIRED', message: `The position ${p} is not active (E4)` });
    listed(m.nationalities, input.nationalityCode, 'nationalityCode', 'NATIONALITY', 'nationality', problems);
    listed(m.ranks, input.rankGradeCode, 'rankGradeCode', 'RANK_GRADE', 'Rank/Grade', problems);
    listed(m.specialties, input.specialtyCode, 'specialtyCode', 'SPECIALTY', 'nursing specialty', problems);
    listed(m.regions, input.jobPostRegionCode, 'jobPostRegionCode', 'REGION', 'region', problems);
    listed(m.types, input.contractTypeCode, 'contractTypeCode', 'CONTRACT_TYPE', 'contract type', problems);
    const city = m.cities.find((c) => c.id === input.jobPostCityId);
    if (city && !city.isActive) problems.push({ column: col('jobPostCityId'), code: 'CITY_INACTIVE', message: `${city.name} is no longer in use` });
    const facility = [...m.facilities.values()].find((f) => f.id === input.facilityId);
    if (facility && !facility.isActive) problems.push({ column: col('facilityId'), code: 'FACILITY_INACTIVE', message: 'This facility is no longer in use' });
    if (input.contractEnd <= input.contractStart) problems.push({ column: col('contractEnd'), code: 'CONTRACT_DATES_INVALID', message: 'Contract end must be after its start (C5)' });
    return { problems, parsed: input };
  }

  /** Every row's status; `inputs` holds the onboarding bodies of the CREATE rows. */
  async function evaluate(tx: DbClient, auth: AuthContext, body: ImportBodyInput) {
    const [m, scope] = await Promise.all([loadMasters(tx), unitScope(tx, auth, HR_ROLES)]);
    // Job numbers are unique ignoring case (E1), in the file and against every employee, deleted ones included.
    const key = (r: ImportRowInput) => blank(r.jobNumber)?.toLowerCase() ?? null;
    const seen = new Map<string, number>();
    for (const r of body.rows) { const k = key(r); if (k) seen.set(k, (seen.get(k) ?? 0) + 1); }
    const lowers = [...seen.keys()];
    const existing = lowers.length === 0 ? [] : await tx.$queryRaw<Array<{ id: number }>>`SELECT id FROM employees WHERE lower(job_number) = ANY(${lowers})`;
    const current = existing.length === 0 ? [] : await tx.employee.findMany({ where: { id: { in: existing.map((e) => e.id) } } });
    const byJob = new Map(current.map((e) => [e.jobNumber.toLowerCase(), e]));

    const rows: RowReport[] = [];
    const inputs = new Map<number, z.infer<typeof OnboardBody>>();
    for (const r of body.rows) {
      const jobNumber = blank(r.jobNumber);
      const report: RowReport = { rowNumber: r.rowNumber, jobNumber, status: 'CREATE', problems: [] };
      rows.push(report);
      const k = key(r);
      if (k && (seen.get(k) ?? 0) > 1) {
        report.status = 'REJECTED';
        report.problems.push({ column: col('jobNumber'), code: 'DUPLICATE_IN_FILE', message: 'This job number appears more than once in the file' });
        continue;
      }
      const { problems, parsed } = prepare(r, m, scope);
      const emp = k ? byJob.get(k) : undefined;
      if (emp) {
        if (emp.deletedAt) { report.status = 'CONFLICT'; report.problems.push({ column: col('jobNumber'), code: 'JOB_NUMBER_TAKEN', message: 'This job number belongs to a deleted employee' }); continue; }
        if (!inScope(scope, emp.unitId)) { report.status = 'CONFLICT'; report.problems.push({ column: col('jobNumber'), code: 'SCOPE_NOT_COVERED', message: 'An employee with this job number exists outside your scope' }); continue; }
        if (!parsed) { report.status = 'REJECTED'; report.problems.push(...problems); continue; }
        // The person exists: compare what the row would set with what is stored (blank Position means SN, as for a new person).
        const stored = { ...emp, hireDate: emp.hireDate ? dbDate(emp.hireDate) : null } as Record<string, unknown>;
        const differs = COMPARED.filter((f) => (stored[f] ?? null) !== ((parsed as Record<string, unknown>)[f] ?? null));
        if (differs.length === 0) report.status = 'UNCHANGED';
        else {
          report.status = 'CONFLICT';
          report.problems.push({ column: null, code: 'JOB_NUMBER_TAKEN', message: `An employee with this job number exists with different values in: ${[...new Set(differs.map(col))].join(', ')}. The import never changes existing staff; edit them in the application.` });
        }
        continue;
      }
      if (!parsed || problems.length) { report.status = 'REJECTED'; report.problems.push(...problems); continue; }
      inputs.set(r.rowNumber, parsed);
    }
    const totals = { create: 0, unchanged: 0, conflict: 0, rejected: 0 };
    for (const r of rows) totals[r.status.toLowerCase() as keyof typeof totals]++;
    return { rows, inputs, totals, canImport: totals.conflict === 0 && totals.rejected === 0 && totals.create > 0 };
  }

  return {
    /** Writes nothing: the report the screen shows before the import. */
    async check(auth: AuthContext, body: ImportBodyInput) {
      const { rows, totals, canImport } = await evaluate(db, auth, body);
      return { totals, canImport, rows };
    },

    /** All or nothing, under one lock: re-checks every row, then onboards each CREATE row with onboardInTx. */
    async commit(auth: AuthContext, body: ImportBodyInput, requestId?: string, transaction?: Transaction) {
      return inTransaction(db, transaction, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('employees:import'))`;
        const { rows, inputs, totals, canImport } = await evaluate(tx, auth, body);
        if (!canImport) {
          if (totals.conflict === 0 && totals.rejected === 0) throw unprocessable('NOTHING_TO_IMPORT', 'Every person in the file already exists with the same details');
          throw new HttpError(409, 'STAFF_IMPORT_NOT_CLEAN', 'Some rows cannot be imported; nothing was written', { totals, rows });
        }
        const created: Array<{ rowNumber: number; employeeId: number; contractId: number }> = [];
        for (const [rowNumber, input] of inputs) created.push({ rowNumber, ...(await nurses.onboardInTx(tx, auth, input, requestId)) });
        await appendAudit(tx, {
          actorUserId: auth.user.id, action: 'STAFF_IMPORTED', resource: 'staff_import', resourceId: null,
          changes: { templateVersion: body.templateVersion, fileSha256: body.fileSha256, rows: body.rows.length, ...totals },
          requestId, priority: 'HIGH',
        });
        return { totals, created, rows };
      }, { timeout: 120_000, maxWait: 10_000 });
    },

    /** The live lists for "Download the current template" (D-72): active values only, units within the caller's scope. */
    async lists(auth: AuthContext) {
      const scope = await unitScope(db, auth, HR_ROLES);
      const [units, positions, nationalities, ranks, specialties, regions, cities, facilities, types] = await Promise.all([
        db.unit.findMany({ where: { isActive: true, ...(scope.all ? {} : { id: { in: [...scope.unitIds] } }) }, select: { code: true, name: true }, orderBy: { code: 'asc' } }),
        db.position.findMany({ where: { isActive: true }, select: { code: true, title: true }, orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }] }),
        db.nationality.findMany({ where: { isActive: true }, select: { code: true, name: true }, orderBy: { sortOrder: 'asc' } }),
        db.rankGrade.findMany({ where: { isActive: true }, select: { code: true, name: true }, orderBy: { sortOrder: 'asc' } }),
        db.nursingSpecialty.findMany({ where: { isActive: true }, select: { code: true, name: true }, orderBy: { sortOrder: 'asc' } }),
        db.saudiRegion.findMany({ where: { isActive: true }, select: { code: true, name: true }, orderBy: { sortOrder: 'asc' } }),
        db.saudiCity.findMany({ where: { isActive: true, region: { isActive: true } }, select: { regionCode: true, name: true }, orderBy: [{ regionCode: 'asc' }, { sortOrder: 'asc' }] }),
        db.facility.findMany({ where: { isActive: true }, select: { name: true }, orderBy: { sortOrder: 'asc' } }),
        db.contractType.findMany({ where: { isActive: true }, select: { code: true, name: true }, orderBy: { displayOrder: 'asc' } }),
      ]);
      return {
        templateVersion: IMPORT_TEMPLATE_VERSIONS[IMPORT_TEMPLATE_VERSIONS.length - 1], maxRows: IMPORT_MAX_ROWS,
        unassignedAllowed: scope.all, generatedAt: new Date().toISOString(),
        units, positions, nationalities, rankGrades: ranks, specialties, regions,
        citiesByRegion: Object.fromEntries(regions.map((r) => [r.code, cities.filter((c) => c.regionCode === r.code).map((c) => c.name)])),
        facilities: facilities.map((f) => f.name), contractTypes: types, maritalStatuses: ['Single', 'Married', 'Others'],
      };
    },
  };
}
export type StaffImportService = ReturnType<typeof createStaffImportService>;
