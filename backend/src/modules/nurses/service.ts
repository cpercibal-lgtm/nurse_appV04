// Employee master (spec §3.1, §8.1 "Employee Master" row; rules E1–E10).
//
// Onboarding is contract-first and atomic (E10, D-17: one Prisma transaction):
// employee + Draft contract (D-3) + audit + eligibility state, or nothing.
// The contract provides no coverage until a second HR person approves it (C1, D-30).
//
// Views (§8.1): scoped HR / System Admin see every field; a scoped Supervisor
// sees the assigned-unit baseline with private fields suppressed (owner list,
// D-36); an employee sees their own profile and may update their own phone
// numbers (D-35).

import { z } from 'zod';
import type { Employee } from '../../generated/prisma/client.js';
import { appendAudit } from '../../lib/audit.js';
import { dbDate, isIsoDate, toDbDate } from '../../lib/dates.js';
import { toHijriIso } from '../../lib/hijri.js';
import { conflict, HttpError, notFound, unprocessable } from '../../lib/http-errors.js';
import { Prisma, type Db, type DbClient } from '../../lib/prisma.js';
import { refreshEligibility } from '../eligibility/state.service.js';
import { HR_ROLES, inScope, viewerOf, type Viewer } from '../credentials/access.js';
import { unitScope, type AuthContext } from '../users/access.js';
import { assertActiveContractType, ContractTypeCode } from '../contracts/contract-types.js';
import { assertNationality, NationalityCode } from '../workforce/nationalities.js';
import { assertActiveRankGrade, RankGradeCode } from '../workforce/rank-grades.js';
import { assertActiveSpecialty, SpecialtyCode } from '../workforce/specialties.js';
import { assertJobPost, JobPostFields } from '../workforce/locations.js';
import { assertActiveFacility, FacilityId } from '../workforce/facilities.js';

const Text = (max: number) => z.string().trim().max(max);
const Req = (max: number) => z.string().trim().min(1).max(max);
const IsoDate = z.string().refine(isIsoDate, 'YYYY-MM-DD');
/** D-35: E.164 — "+", no leading zero, 8–15 digits. Spaces, hyphens and brackets are removed first. */
export const PHONE_E164 = /^\+[1-9]\d{7,14}$/;
const Phone = z.string().transform((v) => v.replace(/[\s\-()]/g, '')).pipe(z.string().regex(PHONE_E164, 'Phone: international format, e.g. +966501234567'));
/** SAR, NUMERIC(12,2), non-negative (E7). */
const Salary = z.union([z.number(), z.string().trim().regex(/^\d+(\.\d{1,2})?$/)])
  .transform((v) => new Prisma.Decimal(v))
  .refine((d) => d.gte(0) && d.lt(1e10) && d.decimalPlaces() <= 2, 'Salary: a non-negative amount with at most 2 decimals');

/** Source fields HR maintains (E1–E8). Position has its own endpoint (E9); full name is derived (E3). */
const SourceFields = {
  jobNumber: Req(40), // E1: no format rule
  firstName: Req(80),
  middleName: Text(80).nullable(),
  lastName: Req(80),
  jobTitle: Text(120).nullable(),
  fileNo: Text(40).nullable(), // E8: not unique, may be blank
  rankGradeCode: RankGradeCode, // owner decision 2026-10-03: the SCFHS classification from the Rank/Grade master, required
  nationalityCode: NationalityCode, // owner decision 2026-10-03: a listed code (ISO 3166-1 alpha-3), required
  ...JobPostFields, // owner decision 2026-10-03: Job Post (City) = a Saudi region + one of its cities, required
  facilityId: FacilityId, // owner decision 2026-10-03: Actual Work Place / Facility from the Facility master, required
  specialtyCode: SpecialtyCode, // owner decision 2026-10-03: from the Nursing Specialty master, required
  maritalStatus: z.enum(['Single', 'Married', 'Others']).nullable(),
  salary: Salary.nullable(),
  contactEmail: z.string().trim().toLowerCase().pipe(z.email()),
  primaryPhone: Phone.nullable(),
  emergencyContactPhone: Phone.nullable(),
  unitId: z.number().int().positive().nullable(), // null = Unassigned (E5)
  hireDate: IsoDate.nullable(),
};

export const OnboardBody = z.strictObject({
  ...SourceFields,
  middleName: SourceFields.middleName.default(null),
  jobTitle: SourceFields.jobTitle.default(null),
  fileNo: SourceFields.fileNo.default(null),
  maritalStatus: SourceFields.maritalStatus.default(null),
  salary: SourceFields.salary.default(null),
  primaryPhone: SourceFields.primaryPhone.default(null),
  emergencyContactPhone: SourceFields.emergencyContactPhone.default(null),
  unitId: SourceFields.unitId.default(null), // E6: Unassigned
  hireDate: SourceFields.hireDate.default(null),
  positionCode: z.string().min(1).max(20).optional(), // omitted → rule E6 default, when that position exists
  contractStart: IsoDate,
  contractEnd: IsoDate,
  contractTypeCode: ContractTypeCode, // owner decision 2026-10-03: the Draft contract's employment contract type
});
// Written out without defaults so a partial update never overwrites omitted fields.
export const UpdateBody = z.strictObject({
  jobNumber: SourceFields.jobNumber.optional(),
  firstName: SourceFields.firstName.optional(),
  middleName: SourceFields.middleName.optional(),
  lastName: SourceFields.lastName.optional(),
  jobTitle: SourceFields.jobTitle.optional(),
  fileNo: SourceFields.fileNo.optional(),
  rankGradeCode: SourceFields.rankGradeCode.optional(), // can be changed, never cleared
  nationalityCode: SourceFields.nationalityCode.optional(), // can be changed, never cleared
  jobPostRegionCode: SourceFields.jobPostRegionCode.optional(), // both together; can be changed, never cleared
  jobPostCityId: SourceFields.jobPostCityId.optional(),
  facilityId: SourceFields.facilityId.optional(), // can be changed, never cleared
  specialtyCode: SourceFields.specialtyCode.optional(), // can be changed, never cleared
  maritalStatus: SourceFields.maritalStatus.optional(),
  salary: SourceFields.salary.optional(),
  contactEmail: SourceFields.contactEmail.optional(),
  primaryPhone: SourceFields.primaryPhone.optional(),
  emergencyContactPhone: SourceFields.emergencyContactPhone.optional(),
  unitId: SourceFields.unitId.optional(),
  hireDate: SourceFields.hireDate.optional(),
});
/** D-35: the only fields an employee maintains on their own record. */
export const OwnContactBody = z.strictObject({
  primaryPhone: SourceFields.primaryPhone.optional(),
  emergencyContactPhone: SourceFields.emergencyContactPhone.optional(),
});
/** Rule E6 (V03 commit 4f51b22): onboarding places a new employee in this position unless another is chosen. */
export const DEFAULT_ONBOARDING_POSITION = 'SN';

export const PositionBody = z.strictObject({ positionCode: z.string().min(1).max(20), reason: z.string().trim().min(3).max(500) });
export const DeleteBody = z.strictObject({ reason: z.string().trim().min(10, 'Deleting an employee needs a reason of at least 10 characters').max(500) });
export const ListQuery = z.object({
  unitId: z.coerce.number().int().positive().optional(),
  unassigned: z.enum(['true', 'false']).optional(),
  positionCode: z.string().min(1).optional(),
  q: z.string().trim().min(1).max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

type WithRefs = Employee & {
  unit: { code: string; name: string } | null; position: { code: string; title: string };
  nationalityRef: { name: string; nameAr: string | null } | null; rankGradeRef: { name: string; isActive: boolean } | null;
  specialtyRef: { name: string; nameAr: string | null; isActive: boolean } | null;
  jobPostRegion: { name: string; nameAr: string | null } | null; jobPostCity: { name: string; nameAr: string | null } | null;
  facility: { name: string; nameAr: string | null; isActive: boolean } | null;
};
const INCLUDE = {
  unit: { select: { code: true, name: true } }, position: { select: { code: true, title: true } },
  nationalityRef: { select: { name: true, nameAr: true } },
  rankGradeRef: { select: { name: true, isActive: true } },
  specialtyRef: { select: { name: true, nameAr: true, isActive: true } },
  jobPostRegion: { select: { name: true, nameAr: true } }, jobPostCity: { select: { name: true, nameAr: true } },
  facility: { select: { name: true, nameAr: true, isActive: true } },
} as const;

/** Actual Work Place / Facility as every view shows it (supervisors too); `actualWorkPlace` is free text from before the master, kept only when unmatched. */
function facilityFields(e: WithRefs) {
  return {
    actualWorkPlace: e.actualWorkPlace, facilityId: e.facilityId, facilityName: e.facility?.name ?? null,
    facilityNameAr: e.facility?.nameAr ?? null, facilityActive: e.facility?.isActive ?? null,
  };
}

/** The specialty as every view shows it; `specialty` is free text from before the master, kept only when unmatched. */
function specialtyFields(e: WithRefs) {
  return {
    specialty: e.specialty, specialtyCode: e.specialtyCode, specialtyName: e.specialtyRef?.name ?? null,
    specialtyNameAr: e.specialtyRef?.nameAr ?? null, specialtyActive: e.specialtyRef?.isActive ?? null,
  };
}

/** Every field (HR, own profile). Dates as YYYY-MM-DD, salary as a string. */
function fullView(full: WithRefs) {
  const { nationalityRef, rankGradeRef, specialtyRef: _specialtyRef, jobPostRegion, jobPostCity, facility: _facility, ...e } = full;
  return {
    ...e,
    ...facilityFields(full),
    // Job Post (City) as "Region - City"; `jobPostLocation` is free text from before the location master, kept only when unmatched.
    jobPostRegionName: jobPostRegion?.name ?? null, jobPostRegionNameAr: jobPostRegion?.nameAr ?? null,
    jobPostCityName: jobPostCity?.name ?? null, jobPostCityNameAr: jobPostCity?.nameAr ?? null,
    ...specialtyFields(full),
    // Likewise `rankGrade` is free text from before the Rank/Grade master, kept only when unmatched.
    rankGradeName: rankGradeRef?.name ?? null, rankGradeActive: rankGradeRef?.isActive ?? null,
    // `nationality` is free text from before the list, kept only when it matched no listed nationality.
    nationalityName: nationalityRef?.name ?? null, nationalityNameAr: nationalityRef?.nameAr ?? null,
    salary: e.salary === null ? null : e.salary.toFixed(2),
    hireDate: e.hireDate ? dbDate(e.hireDate) : null,
    view: 'FULL' as const,
  };
}

/**
 * Supervisor baseline (§8.1; owner list D-36): identity, placement, role and the
 * operational contact fields. Hidden: salary, marital status, nationality, rank,
 * file number, job post location and the next-of-kin phone (D-35).
 */
function baselineView(e: WithRefs) {
  return {
    id: e.id, jobNumber: e.jobNumber, firstName: e.firstName, middleName: e.middleName, lastName: e.lastName, fullName: e.fullName,
    jobTitle: e.jobTitle, ...specialtyFields(e), unitId: e.unitId, unit: e.unit, positionCode: e.positionCode, position: e.position,
    contactEmail: e.contactEmail, primaryPhone: e.primaryPhone, ...facilityFields(e),
    status: e.status, hireDate: e.hireDate ? dbDate(e.hireDate) : null, view: 'BASELINE' as const,
  };
}

/**
 * Values kept out of the audit trail — only the fact that they changed: salary,
 * and the next-of-kin phone, which is a third person's data (D-35).
 */
function redact(changed: Record<string, unknown>) {
  for (const k of ['salary', 'emergencyContactPhone']) if (k in changed) changed[k] = { from: '(redacted)', to: '(redacted)' };
  return changed;
}

const shape = (e: WithRefs, viewer: Viewer) => (viewer === 'SUPERVISOR' ? baselineView(e) : fullView(e));

export function createNurseService(db: Db) {
  const hrScope = (tx: DbClient, auth: AuthContext) => unitScope(tx, auth, HR_ROLES);

  /** HR may place an employee only in a unit it covers; Unassigned needs system-wide scope. */
  async function assertPlaceable(tx: DbClient, auth: AuthContext, unitId: number | null) {
    const scope = await hrScope(tx, auth);
    if (!inScope(scope, unitId)) {
      throw new HttpError(403, 'SCOPE_NOT_COVERED', unitId === null ? 'Only system-wide HR can leave an employee Unassigned' : 'This unit is outside your assigned scope');
    }
    if (unitId !== null) {
      const unit = await tx.unit.findUnique({ where: { id: unitId }, select: { isActive: true } });
      if (!unit || !unit.isActive) throw unprocessable('UNIT_NOT_ACTIVE', 'The unit does not exist or is inactive (E5)');
    }
  }

  async function assertPosition(tx: DbClient, code: string) {
    const p = await tx.position.findUnique({ where: { code }, select: { isActive: true } });
    if (!p) throw unprocessable('POSITION_NOT_FOUND', 'The position does not exist (E4)');
    if (!p.isActive) throw unprocessable('POSITION_NOT_ACTIVE', 'The position is not active (E4)');
  }

  /** E1: unique regardless of case (the database index employees_job_number_ci_key is final). */
  async function assertJobNumberFree(tx: DbClient, jobNumber: string, exceptId?: number) {
    const clash = await tx.employee.findFirst({ where: { jobNumber: { equals: jobNumber, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (clash) throw conflict('JOB_NUMBER_TAKEN', 'An employee with this job number already exists');
  }

  async function loadForHr(tx: DbClient, auth: AuthContext, id: number) {
    const e = await tx.employee.findFirst({ where: { id, deletedAt: null } });
    if (!e) throw notFound('Employee not found');
    if (!inScope(await hrScope(tx, auth), e.unitId)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This employee is outside your assigned scope');
    return e;
  }

  return {
    async list(auth: AuthContext, q: z.infer<typeof ListQuery>) {
      const [hr, sup] = await Promise.all([hrScope(db, auth), unitScope(db, auth, ['SUPERVISOR'])]);
      const unitFilter = (s: typeof hr) => (s.all ? {} : { unitId: { in: [...s.unitIds] } });
      const scopes = [hr, sup].filter((s) => s.all || s.unitIds.size > 0);
      if (scopes.length === 0) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
      const and: Prisma.EmployeeWhereInput[] = [{ deletedAt: null }, { OR: scopes.map(unitFilter) }];
      if (q.unitId) and.push({ unitId: q.unitId });
      if (q.unassigned === 'true') and.push({ unitId: null });
      if (q.positionCode) and.push({ positionCode: q.positionCode });
      if (q.q) and.push({ OR: [{ jobNumber: { contains: q.q, mode: 'insensitive' } }, { fullName: { contains: q.q, mode: 'insensitive' } }] });
      const where: Prisma.EmployeeWhereInput = { AND: and };
      const [rows, total] = await Promise.all([
        db.employee.findMany({ where, include: INCLUDE, orderBy: { jobNumber: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
        db.employee.count({ where }),
      ]);
      return { items: rows.map((e) => shape(e, inScope(hr, e.unitId) ? 'HR' : 'SUPERVISOR')), total, page: q.page, pageSize: q.pageSize };
    },

    async get(auth: AuthContext, id: number) {
      const { viewer } = await viewerOf(db, auth, id, ['OWN', 'HR', 'SUPERVISOR']);
      return shape(await db.employee.findUniqueOrThrow({ where: { id }, include: INCLUDE }), viewer);
    },

    async me(auth: AuthContext) {
      if (auth.user.employeeId === null) throw new HttpError(404, 'NO_EMPLOYEE_RECORD', 'Your account is not linked to an employee record');
      const e = await db.employee.findFirst({ where: { id: auth.user.employeeId, deletedAt: null }, include: INCLUDE });
      if (!e) throw notFound('Employee not found');
      return fullView(e);
    },

    /** D-35: an employee updates their own phone numbers; nothing else on the record. */
    async updateOwnContact(auth: AuthContext, body: z.infer<typeof OwnContactBody>, requestId?: string) {
      if (Object.keys(body).length === 0) throw new HttpError(400, 'NO_CHANGES', 'Nothing to update');
      if (auth.user.employeeId === null) throw new HttpError(404, 'NO_EMPLOYEE_RECORD', 'Your account is not linked to an employee record');
      const id = auth.user.employeeId;
      return db.$transaction(async (tx) => {
        const before = await tx.employee.findFirst({ where: { id, deletedAt: null } });
        if (!before) throw notFound('Employee not found');
        await tx.employee.update({ where: { id }, data: body });
        const changed = Object.fromEntries(Object.keys(body).map((k) => [k, { from: (before as Record<string, unknown>)[k] ?? null, to: (body as Record<string, unknown>)[k] }]));
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'EMPLOYEE_CONTACT_UPDATED', resource: 'employee', resourceId: id, changes: redact(changed), requestId });
        return fullView(await tx.employee.findUniqueOrThrow({ where: { id }, include: INCLUDE }));
      });
    },

    /** Rule E6 defaults for the onboarding form: Unassigned, and the default position when it exists and is active. */
    async onboardingDefaults() {
      const p = await db.position.findUnique({ where: { code: DEFAULT_ONBOARDING_POSITION }, select: { isActive: true } });
      return { unitId: null, positionCode: p?.isActive ? DEFAULT_ONBOARDING_POSITION : null, rule: 'E6' };
    },

    /** E10 + D-3: employee, Draft contract, audit and eligibility state in one transaction. Returns identifiers only ([I]). */
    async onboard(auth: AuthContext, input: z.infer<typeof OnboardBody>, requestId?: string) {
      if (input.contractEnd <= input.contractStart) throw unprocessable('CONTRACT_DATES_INVALID', 'Contract end must be after its start (C5)');
      return db.$transaction(async (tx) => {
        // E6: no position given → the default, but only if the hospital has it (an empty database may not).
        const positionCode = input.positionCode ?? (await tx.position.findFirst({ where: { code: DEFAULT_ONBOARDING_POSITION, isActive: true }, select: { code: true } }))?.code;
        if (!positionCode) throw unprocessable('POSITION_REQUIRED', `Choose a position: the default position ${DEFAULT_ONBOARDING_POSITION} (rule E6) does not exist or is inactive`);
        const body = { ...input, positionCode };
        await assertPlaceable(tx, auth, body.unitId);
        await assertPosition(tx, body.positionCode);
        await assertJobNumberFree(tx, body.jobNumber);
        await assertNationality(tx, body.nationalityCode);
        await assertActiveRankGrade(tx, body.rankGradeCode);
        await assertActiveSpecialty(tx, body.specialtyCode);
        await assertJobPost(tx, body.jobPostRegionCode, body.jobPostCityId);
        await assertActiveFacility(tx, body.facilityId);
        const { contractStart, contractEnd, contractTypeCode, hireDate, ...fields } = body;
        await assertActiveContractType(tx, contractTypeCode);
        const emp = await tx.employee.create({
          // full_name is composed by the database trigger (E3); the placeholder never survives the insert.
          data: { ...fields, fullName: '', hireDate: hireDate ? toDbDate(hireDate) : null },
        });
        const contract = await tx.contract.create({
          data: {
            employeeId: emp.id, jobNumber: emp.jobNumber, status: 'Draft', createdById: auth.user.id, contractTypeCode,
            startDate: toDbDate(contractStart), endDate: toDbDate(contractEnd),
            startDateHijri: toHijriIso(contractStart), endDateHijri: toHijriIso(contractEnd),
          },
        });
        await appendAudit(tx, {
          actorUserId: auth.user.id, action: 'EMPLOYEE_ONBOARDED', resource: 'employee', resourceId: emp.id,
          changes: { jobNumber: emp.jobNumber, unitId: emp.unitId, positionCode: emp.positionCode, contractId: contract.id, contractStart, contractEnd, contractTypeCode, contractStatus: 'Draft' },
          requestId, priority: 'HIGH',
        });
        await refreshEligibility(tx, emp.id, 'EMPLOYEE_ONBOARDED', { actorUserId: auth.user.id, requestId });
        return { employeeId: emp.id, contractId: contract.id };
      });
    },

    async update(auth: AuthContext, id: number, body: z.infer<typeof UpdateBody>, requestId?: string) {
      if (Object.keys(body).length === 0) throw new HttpError(400, 'NO_CHANGES', 'Nothing to update');
      return db.$transaction(async (tx) => {
        const before = await loadForHr(tx, auth, id);
        if (body.unitId !== undefined && body.unitId !== before.unitId) await assertPlaceable(tx, auth, body.unitId);
        if (body.jobNumber !== undefined && body.jobNumber !== before.jobNumber) await assertJobNumberFree(tx, body.jobNumber, id);
        if (body.nationalityCode !== undefined) await assertNationality(tx, body.nationalityCode);
        // An unchanged Rank/Grade may have been deactivated since; only a new choice must be active.
        if (body.rankGradeCode !== undefined && body.rankGradeCode !== before.rankGradeCode) await assertActiveRankGrade(tx, body.rankGradeCode);
        if (body.specialtyCode !== undefined && body.specialtyCode !== before.specialtyCode) await assertActiveSpecialty(tx, body.specialtyCode);
        if (body.facilityId !== undefined && body.facilityId !== before.facilityId) await assertActiveFacility(tx, body.facilityId);
        if ((body.jobPostRegionCode === undefined) !== (body.jobPostCityId === undefined)) {
          throw unprocessable('JOB_POST_INCOMPLETE', 'Job Post (City) needs both the region and the city');
        }
        if (body.jobPostRegionCode !== undefined && body.jobPostCityId !== undefined) {
          await assertJobPost(tx, body.jobPostRegionCode, body.jobPostCityId, body.jobPostRegionCode === before.jobPostRegionCode && body.jobPostCityId === before.jobPostCityId);
        }
        const { hireDate, ...rest } = body;
        const data = {
          ...rest, ...(hireDate !== undefined ? { hireDate: hireDate ? toDbDate(hireDate) : null } : {}),
          // A listed nationality replaces any unmatched free text from before the list.
          ...(body.nationalityCode !== undefined ? { nationality: null } : {}),
          ...(body.rankGradeCode !== undefined ? { rankGrade: null } : {}),
          ...(body.specialtyCode !== undefined ? { specialty: null } : {}),
          ...(body.jobPostCityId !== undefined ? { jobPostLocation: null } : {}),
          ...(body.facilityId !== undefined ? { actualWorkPlace: null } : {}),
        };
        await tx.employee.update({ where: { id }, data });
        const changed = Object.fromEntries(Object.keys(body).map((k) => [k, { from: (before as Record<string, unknown>)[k] ?? null, to: (body as Record<string, unknown>)[k] }]));
        redact(changed);
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'EMPLOYEE_UPDATED', resource: 'employee', resourceId: id, changes: changed, requestId });
        // The unit decides which credential requirements apply (§5.1.4): re-evaluate (L6).
        if (body.unitId !== undefined && body.unitId !== before.unitId) await refreshEligibility(tx, id, 'EMPLOYEE_UNIT_CHANGED', { actorUserId: auth.user.id, requestId });
        // So does the nationality, for credential types limited by nationality (owner decision 2026-10-04).
        else if (body.nationalityCode !== undefined && body.nationalityCode !== before.nationalityCode) await refreshEligibility(tx, id, 'EMPLOYEE_NATIONALITY_CHANGED', { actorUserId: auth.user.id, requestId });
        return fullView(await tx.employee.findUniqueOrThrow({ where: { id }, include: INCLUDE }));
      });
    },

    /** E9: HR_ADMIN only (route permission); rejects inactive or unchanged positions; audited from → to. */
    async assignPosition(auth: AuthContext, id: number, body: z.infer<typeof PositionBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const before = await loadForHr(tx, auth, id);
        if (before.positionCode === body.positionCode) throw unprocessable('POSITION_UNCHANGED', 'The employee already holds this position');
        await assertPosition(tx, body.positionCode);
        await tx.employee.update({ where: { id }, data: { positionCode: body.positionCode } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'EMPLOYEE_POSITION_CHANGED', resource: 'employee', resourceId: id, changes: { from: before.positionCode, to: body.positionCode, reason: body.reason }, requestId, priority: 'HIGH' });
        await refreshEligibility(tx, id, 'EMPLOYEE_POSITION_CHANGED', { actorUserId: auth.user.id, requestId });
        return { id, positionCode: body.positionCode };
      });
    },

    /** Soft delete (deletedAt). The record, its contracts and credentials stay for history; eligibility becomes INELIGIBLE. */
    async remove(auth: AuthContext, id: number, reason: string, requestId?: string) {
      return db.$transaction(async (tx) => {
        const e = await loadForHr(tx, auth, id);
        if (auth.user.employeeId === id) throw new HttpError(403, 'SELF_ACTION_FORBIDDEN', 'You cannot delete your own employee record');
        await tx.employee.update({ where: { id }, data: { deletedAt: new Date() } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'EMPLOYEE_DELETED', resource: 'employee', resourceId: id, changes: { jobNumber: e.jobNumber, reason }, requestId, priority: 'HIGH' });
        await refreshEligibility(tx, id, 'EMPLOYEE_DELETED', { actorUserId: auth.user.id, requestId });
        return { id, deleted: true };
      });
    },
  };
}

export type NurseService = ReturnType<typeof createNurseService>;
