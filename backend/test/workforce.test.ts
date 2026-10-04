// Workforce, employee master and contracts through the HTTP API against
// PostgreSQL: rules W1–W8 (org structure, beds, positions, coverage), E1–E10
// (onboarding, views, position), C1–C11 and owner decisions D-3, D-29, D-30.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { findChainBreaks } from '../src/lib/audit.js';
import { addDays, riyadhDate, toDbDate } from '../src/lib/dates.js';
import type { Db } from '../src/lib/prisma.js';
import { FILES, makeEmployee, makeNurse, makeOrg, makeTemplate, makeUser, openDb, signIn, TEST_URL, testApp, uniq, jobPost } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const today = () => riyadhDate();
type Client = Awaited<ReturnType<typeof signIn>>;
const idem = <T extends { set: (k: string, v: string) => T }>(req: T) => req.set('Idempotency-Key', randomUUID());

describeDb('workforce, employees and contracts', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let hr: Client; // system-wide HR
  let hr2: Client; // a second system-wide HR (approver)
  let scoped: Client; // HR for unit A only
  let buraydah = 0; // Qassim Region - Buraydah (location master)
  let alIman = 0; // Al Iman General Hospital (facility master)

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    org = await makeOrg(db);
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    hr2 = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    scoped = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
    ({ jobPostCityId: buraydah, facilityId: alIman } = await jobPost(db));
  });
  afterAll(async () => { await db.$disconnect(); });

  describe('organisation structure (W1–W3)', () => {
    it('only system-wide HR changes departments and units; deactivation guards hold', async () => {
      const code = uniq('D').toUpperCase().slice(0, 20);
      expect((await scoped.post('/departments', { code, name: 'Scoped try' })).body.error.code).toBe('SCOPE_NOT_COVERED');
      const dept = await hr.post('/departments', { code, name: 'New department' });
      expect(dept.status).toBe(201);
      expect((await hr.post('/departments', { code, name: 'Again' })).body.error.code).toBe('DEPARTMENT_EXISTS');

      const unitCode = uniq('U').toUpperCase().slice(0, 20);
      const unit = await hr.post('/units', { code: unitCode, name: 'New unit', departmentId: dept.body.id, bedCount: 12 });
      expect(unit.status).toBe(201);
      expect(await db.bedCapacityLog.count({ where: { unitId: unit.body.id, newCount: 12 } })).toBe(1);

      expect((await hr.patch(`/departments/${dept.body.id}`, { isActive: false })).body.error.code).toBe('DEPARTMENT_HAS_ACTIVE_UNITS');
      await makeEmployee(db, unit.body.id);
      expect((await hr.patch(`/units/${unit.body.id}`, { isActive: false })).body.error.code).toBe('UNIT_HAS_ACTIVE_EMPLOYEES');

      const summary = await hr.get('/units/summary');
      expect(summary.body.totalBeds).toBe(summary.body.byDepartment.reduce((s: number, d: { beds: number }) => s + d.beds, 0));
    });
  });

  describe('bed capacity (W4, W5)', () => {
    it('a single change needs a reason, follows unit scope and is logged before → after', async () => {
      expect((await scoped.put(`/units/${org.unitA.id}/bed-capacity`, { bedCount: 20 })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await scoped.put(`/units/${org.unitA.id}/bed-capacity`, { bedCount: 501, reason: 'Expansion' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await scoped.put(`/units/${org.unitC.id}/bed-capacity`, { bedCount: 5, reason: 'Expansion' })).body.error.code).toBe('SCOPE_NOT_COVERED');
      const before = (await db.unit.findUniqueOrThrow({ where: { id: org.unitA.id } })).bedCount;
      const done = await scoped.put(`/units/${org.unitA.id}/bed-capacity`, { bedCount: before + 4, reason: 'Ward expansion' });
      expect(done.body).toMatchObject({ status: 'UPDATED', previous: before, bedCount: before + 4 });
      expect((await scoped.put(`/units/${org.unitA.id}/bed-capacity`, { bedCount: before + 4, reason: 'Again' })).body.status).toBe('UNCHANGED');
      const log = await db.bedCapacityLog.findFirstOrThrow({ where: { unitId: org.unitA.id }, orderBy: { id: 'desc' } });
      expect(log).toMatchObject({ previousCount: before, newCount: before + 4, reason: 'Ward expansion' });
      const history = await scoped.get(`/units/${org.unitA.id}/bed-history`);
      expect(history.body.items[0].changedBy).toBe('Test User');
    });

    it('bulk reports each row and needs an Idempotency-Key', async () => {
      const body = {
        reason: 'Annual re-baseline',
        rows: [
          { unitCode: org.unitA.code, bedCount: 7 }, { unitCode: org.unitC.code, bedCount: 7 },
          { unitCode: 'NO_SUCH_UNIT', bedCount: 7 }, { unitCode: org.unitA.code, bedCount: 8 }, { unitCode: org.unitB.code, bedCount: 2.5 },
        ],
      };
      expect((await scoped.put('/units/bed-capacity/bulk', body)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const res = await idem(scoped.put('/units/bed-capacity/bulk', body));
      expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['UPDATED', 'REJECTED', 'REJECTED', 'REJECTED', 'REJECTED']);
      expect(res.body.results[1].reason).toBe('Outside your assigned scope');
      expect((await db.unit.findUniqueOrThrow({ where: { id: org.unitA.id } })).bedCount).toBe(7);
    });
  });

  describe('CSV import', () => {
    it('dry run changes nothing; applying creates and updates with logs; quoted fields work', async () => {
      const newCode = uniq('IMP').toUpperCase().slice(0, 20);
      const csv = [
        'unit_code,name,department_code,beds,description',
        `${newCode},"Ward, East",${org.dept.code},14,"New ""east"" ward"`,
        `${org.unitB.code},Unit B renamed,${org.dept.code},9,`,
        `BAD CODE,Nope,${org.dept.code},1,`,
        `${newCode},Duplicate,${org.dept.code},1,`,
        `${uniq('X').toUpperCase().slice(0, 20)},No dept,NOPE,1,`,
      ].join('\n');
      expect((await scoped.post('/units/import', { csv })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await idem(scoped.post('/units/import', { csv }))).body.error.code).toBe('SCOPE_NOT_COVERED');
      const dry = await idem(hr.post('/units/import', { csv }));
      expect(dry.body).toMatchObject({ dryRun: true, created: 1, updated: 1, rejected: 3 });
      expect(await db.unit.findUnique({ where: { code: newCode } })).toBeNull();

      const applied = await idem(hr.post('/units/import', { csv, dryRun: false }));
      expect(applied.body).toMatchObject({ dryRun: false, created: 1, updated: 1 });
      const created = await db.unit.findUniqueOrThrow({ where: { code: newCode } });
      expect(created).toMatchObject({ name: 'Ward, East', description: 'New "east" ward', bedCount: 14 });
      expect((await db.unit.findUniqueOrThrow({ where: { id: org.unitB.id } })).bedCount).toBe(9);
      expect(await db.bedCapacityLog.count({ where: { unitId: org.unitB.id, newCount: 9, reason: 'CSV import: bed capacity' } })).toBe(1);
      expect((await idem(hr.post('/units/import', { csv: 'unit_code,name\nX,Y' }))).body.error.code).toBe('CSV_INVALID');
    });
  });

  describe('positions (W6, W7) and coverage targets (W8)', () => {
    it('a held position cannot be deactivated; turning off schedulability re-evaluates holders', async () => {
      const code = uniq('P').toUpperCase().slice(0, 20);
      expect((await hr.post('/positions', { code, title: 'Test position', tier: 'Clinical', isSchedulable: true })).status).toBe(201);
      expect((await hr.post('/positions', { code: uniq('P').toUpperCase().slice(0, 20), title: 'Bad tier', tier: 'Imaginary', isSchedulable: true })).body.error.code).toBe('VALIDATION_FAILED');
      const { emp } = await makeNurse(db, org.unitA.id);
      await db.employee.update({ where: { id: emp.id }, data: { positionCode: code } });
      expect((await hr.patch(`/positions/${code}`, { isActive: false })).body.error.code).toBe('POSITION_IN_USE');
      await hr.patch(`/positions/${code}`, { isSchedulable: false });
      const state = await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: emp.id } });
      expect(state.status).toBe('INELIGIBLE');
      expect(JSON.stringify(state.reasons)).toContain('POSITION_NOT_SCHEDULABLE');
    });

    it('a target can be set and removed (unspecified, never zero), within unit scope', async () => {
      expect((await scoped.put('/coverage-targets', { unitId: org.unitC.id, shiftType: 'Night', minimumStaff: 3 })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await scoped.put('/coverage-targets', { unitId: org.unitA.id, shiftType: 'Night', minimumStaff: 3 })).body.minimumStaff).toBe(3);
      expect((await hr.get(`/coverage-targets?unitId=${org.unitA.id}`)).body.items).toHaveLength(1);
      expect((await scoped.put('/coverage-targets', { unitId: org.unitA.id, shiftType: 'Night', minimumStaff: null })).body.minimumStaff).toBeNull();
      expect((await hr.get(`/coverage-targets?unitId=${org.unitA.id}`)).body.items).toHaveLength(0);
    });

    it('the KPI answers with bands and says its thresholds are not sourced in the repository (D-11)', async () => {
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      const res = await sup.get(`/kpi/nurse-to-bed?date=${today()}&shift=Morning`);
      expect(res.status).toBe(200);
      expect(res.body.kpiA.areas).toHaveLength(3);
      expect(res.body.thresholdSource).toMatch(/not in the repository/);

      // KPI A areas come from units.critical_area, set by system-wide HR — not from unit codes in the code.
      const icu = await hr.post('/units', { code: uniq('KICU').toUpperCase().slice(0, 20), name: 'KPI ICU', departmentId: org.dept.id, bedCount: 4, criticalArea: 'ICU' });
      expect(icu.body.criticalArea).toBe('ICU');
      const withIcu = await sup.get(`/kpi/nurse-to-bed?date=${today()}&shift=Morning`);
      expect(withIcu.body.areaUnits[icu.body.code]).toBe('ICU');
      expect(withIcu.body.kpiA.areas.find((a: { area: string }) => a.area === 'ICU').beds).toBe(res.body.kpiA.areas.find((a: { area: string }) => a.area === 'ICU').beds + 4);
      expect((await hr.patch(`/units/${icu.body.id}`, { criticalArea: null })).body.criticalArea).toBeNull();
      expect((await sup.get(`/kpi/nurse-to-bed?date=${today()}&shift=Morning`)).body.areaUnits[icu.body.code]).toBeUndefined();
      expect((await (await signIn(app, (await makeUser(db)).email)).get(`/kpi/nurse-to-bed?date=${today()}&shift=Morning`)).status).toBe(403);
    });
  });

  describe('onboarding (E1–E10, D-3)', () => {
    const onboardBody = (over: object = {}) => ({
      jobNumber: uniq('OB'), firstName: ' Mona ', middleName: '', lastName: 'Saleh', contactEmail: 'Mona@Example.SA',
      unitId: org.unitA.id, salary: '12500.50', maritalStatus: 'Single',
      contractStart: today(), contractEnd: addDays(today(), 364), contractTypeCode: 'DIRECT_HOSPITAL', nationalityCode: 'SAU', rankGradeCode: 'N03', specialtyCode: 'NS003', jobPostRegionCode: 'SA-05', jobPostCityId: buraydah, facilityId: alIman, ...over,
    });

    it('rule E6: the server supplies the default position; omitting it at onboarding uses it (P4)', async () => {
      expect((await scoped.get('/employees/onboarding-defaults')).body).toEqual({ unitId: null, positionCode: 'SN', rule: 'E6' });
      const nurse = await signIn(app, (await makeUser(db)).email);
      expect((await nurse.get('/employees/onboarding-defaults')).status).toBe(403);
      const body = onboardBody(); // no positionCode
      const res = await idem(scoped.post('/employees/onboard', body));
      expect(res.status).toBe(201);
      expect((await db.employee.findUniqueOrThrow({ where: { id: res.body.employeeId } })).positionCode).toBe('SN');
    });

    it('nationality comes from the fixed list: required, validated on the server, returned by name, hidden from supervisors (owner decision 2026-10-03)', async () => {
      const list = (await scoped.get('/nationalities')).body.items as Array<{ code: string; name: string; nameAr: string | null }>;
      expect(list).toHaveLength(200);
      expect(list.map((n) => n.name)).toEqual([...list.map((n) => n.name)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
      expect(new Set(list.map((n) => n.code)).size).toBe(200);
      expect(list.find((n) => n.code === 'SAU')).toMatchObject({ name: 'Saudi', nameAr: 'سعودي' });

      const { nationalityCode: _omit, ...withoutNationality } = onboardBody();
      const missing = await idem(scoped.post('/employees/onboard', withoutNationality));
      expect(missing.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(missing.body)).toContain('Nationality is required.');
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ nationalityCode: 'XYZ' })))).body.error.code).toBe('NATIONALITY_INVALID');
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ nationality: 'Martian' })))).body.error.code).toBe('VALIDATION_FAILED');

      const made = await idem(scoped.post('/employees/onboard', onboardBody({ nationalityCode: 'phl' })));
      expect(made.status).toBe(201);
      const id = made.body.employeeId as number;
      expect((await scoped.get(`/employees/${id}`)).body).toMatchObject({ nationalityCode: 'PHL', nationalityName: 'Filipino', nationalityNameAr: 'فلبيني', nationality: null });
      // An edit without the field keeps it; it can be changed but never cleared.
      await scoped.patch(`/employees/${id}`, { jobTitle: 'Staff Nurse II' });
      expect((await db.employee.findUniqueOrThrow({ where: { id } })).nationalityCode).toBe('PHL');
      expect((await scoped.patch(`/employees/${id}`, { nationalityCode: null })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await scoped.patch(`/employees/${id}`, { nationalityCode: 'IND' })).body.nationalityName).toBe('Indian');

      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      const seen = (await sup.get(`/employees/${id}`)).body;
      expect(seen.view).toBe('BASELINE');
      expect(seen).not.toHaveProperty('nationalityCode');
      expect(seen).not.toHaveProperty('nationalityName');
    });

    it('Rank/Grade comes from the master: required, active, validated on the server, kept when deactivated later (owner decision 2026-10-03)', async () => {
      const list = (await scoped.get('/rank-grades')).body.items as Array<{ code: string; name: string }>;
      // The starting records in their sort order (other tests add records of their own to the shared database).
      const start = list.filter((r) => /^N0[1-5]$/.test(r.code));
      expect(start.map((r) => r.code)).toEqual(['N01', 'N02', 'N03', 'N04', 'N05']);
      expect(start[2]).toMatchObject({ code: 'N03', name: 'Specialist Nurse', meaning: 'Professional nurse classification' });
      expect((await scoped.get('/rank-grades?q=technician')).body.items.map((r: { code: string }) => r.code)).toEqual(['N04']);

      const { rankGradeCode: _omit, ...withoutRank } = onboardBody();
      const missing = await idem(scoped.post('/employees/onboard', withoutRank));
      expect(JSON.stringify(missing.body)).toContain('Rank/Grade is required.');
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ rankGradeCode: 'Grade 7' })))).body.error.code).toBe('RANK_GRADE_INVALID');
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ rankGrade: 'Grade 7' })))).body.error.code).toBe('VALIDATION_FAILED');

      const code = uniq('RG').toUpperCase().slice(0, 20);
      await hr.post('/rank-grades', { code, name: 'Test classification', sortOrder: 99 });
      const made = await idem(scoped.post('/employees/onboard', onboardBody({ rankGradeCode: code.toLowerCase() })));
      expect(made.status).toBe(201);
      const id = made.body.employeeId as number;
      expect((await scoped.get(`/employees/${id}`)).body).toMatchObject({ rankGradeCode: code, rankGradeName: 'Test classification', rankGradeActive: true, rankGrade: null });

      // Deactivated later: existing employees keep it and can still be edited; new choices cannot take it.
      await hr.patch(`/rank-grades/${code}`, { isActive: false });
      expect((await scoped.patch(`/employees/${id}`, { rankGradeCode: code, jobTitle: 'Staff Nurse II' })).body).toMatchObject({ rankGradeCode: code, rankGradeActive: false });
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ rankGradeCode: code })))).body.error.code).toBe('RANK_GRADE_INACTIVE');
      expect((await scoped.get('/rank-grades')).body.items.map((r: { code: string }) => r.code)).not.toContain(code);
      expect((await scoped.patch(`/employees/${id}`, { rankGradeCode: null })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await scoped.patch(`/employees/${id}`, { rankGradeCode: 'N02' })).body.rankGradeName).toBe('Senior Specialist Nurse');

      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      expect((await sup.get(`/employees/${id}`)).body).not.toHaveProperty('rankGradeCode');
    });

    it('Rank/Grade master: system-wide HR adds, edits, deactivates and reactivates; a record in use cannot be deleted; all audited', async () => {
      const code = uniq('RM').toUpperCase().slice(0, 20);
      const nurse = await signIn(app, (await makeUser(db)).email);
      expect((await nurse.post('/rank-grades', { code, name: 'x' })).status).toBe(403);
      expect((await scoped.post('/rank-grades', { code, name: 'Scoped try' })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await hr.post('/rank-grades', { code, name: '   ' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await hr.post('/rank-grades', { code: ` ${code.toLowerCase()} `, name: ' Charge Classification ', meaning: 'Test', sortOrder: 6 })).body).toMatchObject({ code, name: 'Charge Classification', isActive: true });
      expect((await hr.post('/rank-grades', { code, name: 'Again' })).body.error.code).toBe('RANK_GRADE_EXISTS');
      expect((await hr.patch(`/rank-grades/${code}`, { code: 'X1', name: 'y' })).body.error.code).toBe('VALIDATION_FAILED'); // the code never changes
      expect((await hr.patch(`/rank-grades/${code}`, { name: 'Senior Charge Classification' })).body.name).toBe('Senior Charge Classification');
      await hr.patch(`/rank-grades/${code}`, { isActive: false });
      expect((await hr.get('/rank-grades?includeInactive=true')).body.items.find((r: { code: string }) => r.code === code)).toMatchObject({ isActive: false });
      await hr.patch(`/rank-grades/${code}`, { isActive: true });

      // In use by an employee: refused with the counts. Unused: deleted.
      const emp = await makeEmployee(db, org.unitA.id);
      await db.employee.update({ where: { id: emp.id }, data: { rankGradeCode: code } });
      const refused = await hr.del(`/rank-grades/${code}`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatchObject({ code: 'RANK_GRADE_IN_USE', details: { employees: 1, credentials: 0 } });
      await db.employee.update({ where: { id: emp.id }, data: { rankGradeCode: 'N03' } });
      expect((await hr.del(`/rank-grades/${code}`)).body).toEqual({ code, deleted: true });

      const actions = (await db.auditEntry.findMany({ where: { resource: 'rank_grade', resourceId: code }, orderBy: { id: 'asc' } })).map((a) => a.action);
      expect(actions).toEqual(['RANK_GRADE_CREATED', 'RANK_GRADE_UPDATED', 'RANK_GRADE_DEACTIVATED', 'RANK_GRADE_REACTIVATED', 'RANK_GRADE_DELETED']);
      const renamed = await db.auditEntry.findFirstOrThrow({ where: { resource: 'rank_grade', resourceId: code, action: 'RANK_GRADE_UPDATED' } });
      expect(renamed.changes).toMatchObject({ name: { from: 'Charge Classification', to: 'Senior Charge Classification' } });
    });

    it('the SCFHS licence classification is a Rank/Grade code, and a licence using one keeps it from being deleted', async () => {
      const tpl = await makeTemplate(db);
      await db.credentialTemplateField.create({ data: { templateId: tpl.id, ordinal: 4, key: 'classification', label: 'Professional Classification', type: 'select', required: false, displayOrder: 4 } });
      const emp = await makeEmployee(db, org.unitA.id);
      const body = (classification: string) => ({ employeeId: emp.id, templateId: tpl.id, trackingData: { licence_number: 'DEMO-1', issue_date: addDays(today(), -10), expiry_date: addDays(today(), 400), classification } });
      expect((await hr.post('/credentials', body('Nursing Specialist'))).body.error.code).toBe('RANK_GRADE_INVALID');
      const code = uniq('RC').toUpperCase().slice(0, 20);
      await hr.post('/rank-grades', { code, name: 'Licence classification' });
      expect((await hr.post('/credentials', body(code))).status).toBe(201);
      expect((await hr.del(`/rank-grades/${code}`)).body.error).toMatchObject({ code: 'RANK_GRADE_IN_USE', details: { employees: 0, credentials: 1 } });
    });

    it('Specialty comes from the Nursing Specialty master: sort order, search, required, active, visible to supervisors (owner decision 2026-10-03)', async () => {
      const list = (await scoped.get('/nursing-specialties')).body.items as Array<{ code: string; name: string; sortOrder: number }>;
      const start = list.filter((s) => /^NS0\d\d$/.test(s.code));
      expect(start).toHaveLength(34);
      expect(start.map((s) => s.sortOrder)).toEqual(Array.from({ length: 34 }, (_, i) => i + 1));
      expect(start[0]).toMatchObject({ code: 'NS001', name: 'Clinical Nursing' });
      expect(start[33]).toMatchObject({ code: 'NS034', name: 'General / Unspecified' });
      const search = async (q: string) => (await scoped.get(`/nursing-specialties?q=${encodeURIComponent(q)}`)).body.items.map((s: { code: string }) => s.code);
      expect(await search('ICU')).toEqual(expect.arrayContaining(['NS003', 'NS006'])); // "NICU" contains "ICU"
      expect(await search('NICU')).toEqual(['NS006']);
      expect(await search('cardiac')).toEqual(['NS010']);
      expect(await search('ns032')).toEqual(['NS032']);

      const { specialtyCode: _omit, ...without } = onboardBody();
      expect(JSON.stringify((await idem(scoped.post('/employees/onboard', without))).body)).toContain('Specialty is required.');
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ specialtyCode: 'ICU' })))).body.error.code).toBe('SPECIALTY_INVALID');
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ specialty: 'Critical Care' })))).body.error.code).toBe('VALIDATION_FAILED');

      const code = uniq('SP').toUpperCase().slice(0, 20);
      await hr.post('/nursing-specialties', { code, name: `Test specialty ${code}`, sortOrder: 99 });
      const made = await idem(scoped.post('/employees/onboard', onboardBody({ specialtyCode: code.toLowerCase() })));
      expect(made.status).toBe(201);
      const id = made.body.employeeId as number;
      expect((await scoped.get(`/employees/${id}`)).body).toMatchObject({ specialtyCode: code, specialtyName: `Test specialty ${code}`, specialtyActive: true, specialty: null });

      // Deactivated later: kept on the employee and editable; refused as a new choice; gone from the active list.
      await hr.patch(`/nursing-specialties/${code}`, { isActive: false });
      expect((await scoped.patch(`/employees/${id}`, { specialtyCode: code, jobTitle: 'Staff Nurse II' })).body).toMatchObject({ specialtyCode: code, specialtyActive: false });
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ specialtyCode: code })))).body.error.code).toBe('SPECIALTY_INACTIVE');
      expect(await search(code)).toEqual([]);
      expect((await scoped.patch(`/employees/${id}`, { specialtyCode: null })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await scoped.patch(`/employees/${id}`, { specialtyCode: 'NS034' })).body.specialtyName).toBe('General / Unspecified');

      // Supervisors see the specialty (as before), not the private fields.
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      const seen = (await sup.get(`/employees/${id}`)).body;
      expect(seen).toMatchObject({ view: 'BASELINE', specialtyCode: 'NS034', specialtyName: 'General / Unspecified' });
      expect(seen).not.toHaveProperty('rankGradeCode');
    });

    it('Nursing Specialty master: add, edit, deactivate, reactivate, delete; codes and names unique; in-use cannot be deleted; audited', async () => {
      const code = uniq('SM').toUpperCase().slice(0, 20);
      const nurse = await signIn(app, (await makeUser(db)).email);
      expect((await nurse.post('/nursing-specialties', { code, name: 'x' })).status).toBe(403);
      expect((await scoped.post('/nursing-specialties', { code, name: 'Scoped try' })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await hr.post('/nursing-specialties', { code, name: ' ' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await hr.post('/nursing-specialties', { code, name: 'critical care nursing / icu' })).body.error.code).toBe('SPECIALTY_NAME_EXISTS');
      const name = `Advanced Practice ${code}`;
      expect((await hr.post('/nursing-specialties', { code: ` ${code.toLowerCase()} `, name, nameAr: 'تمريض متقدم', description: 'Test', sortOrder: 35 })).body).toMatchObject({ code, name, isActive: true });
      expect((await hr.post('/nursing-specialties', { code, name: 'Another' })).body.error.code).toBe('SPECIALTY_EXISTS');
      expect((await hr.patch(`/nursing-specialties/${code}`, { name: 'Emergency Nursing' })).body.error.code).toBe('SPECIALTY_NAME_EXISTS');
      expect((await hr.patch(`/nursing-specialties/${code}`, { code: 'X1' })).body.error.code).toBe('VALIDATION_FAILED'); // the code never changes
      expect((await hr.patch(`/nursing-specialties/${code}`, { name: `${name} II`, sortOrder: 36 })).body).toMatchObject({ name: `${name} II`, sortOrder: 36 });
      await hr.patch(`/nursing-specialties/${code}`, { isActive: false });
      await hr.patch(`/nursing-specialties/${code}`, { isActive: true });

      const emp = await makeEmployee(db, org.unitA.id);
      await db.employee.update({ where: { id: emp.id }, data: { specialtyCode: code } });
      const refused = await hr.del(`/nursing-specialties/${code}`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatchObject({ code: 'SPECIALTY_IN_USE', details: { employees: 1 } });
      await db.employee.update({ where: { id: emp.id }, data: { specialtyCode: 'NS001' } });
      expect((await hr.del(`/nursing-specialties/${code}`)).body).toEqual({ code, deleted: true });

      const actions = (await db.auditEntry.findMany({ where: { resource: 'nursing_specialty', resourceId: code }, orderBy: { id: 'asc' } })).map((a) => a.action);
      expect(actions).toEqual(['SPECIALTY_CREATED', 'SPECIALTY_UPDATED', 'SPECIALTY_DEACTIVATED', 'SPECIALTY_REACTIVATED', 'SPECIALTY_DELETED']);
    });

    it('the migration maps clear free-text specialties to codes and keeps ambiguous ones for review', async () => {
      const sql = readFileSync(resolve(__dirname, '../prisma/migrations/20261019090000_nursing_specialties/migration.sql'), 'utf8');
      const normalise = sql.slice(sql.indexOf('WITH alias'));
      const make = async (specialty: string) => (await db.employee.update({ where: { id: (await makeEmployee(db, org.unitA.id)).id }, data: { specialty, specialtyCode: null } })).id;
      const ids = {
        name: await make(' midwifery '), code: await make('ns020'), icu: await make('ICU'), cc: await make('Critical Care'), medsurg: await make('Medical-Surgical'),
        obs: await make('Obstetrics'), surgical: await make('Surgical'), management: await make('Management'), general: await make('General'),
      };
      await db.$executeRawUnsafe(normalise);
      const code = async (id: number) => (await db.employee.findUniqueOrThrow({ where: { id }, select: { specialtyCode: true } })).specialtyCode;
      expect(await code(ids.name)).toBe('NS032');
      expect(await code(ids.code)).toBe('NS020');
      expect(await code(ids.icu)).toBe('NS003');
      expect(await code(ids.cc)).toBe('NS003');
      expect(await code(ids.medsurg)).toBe('NS002');
      expect(await code(ids.obs)).toBe('NS008');
      for (const [id, text] of [[ids.surgical, 'Surgical'], [ids.management, 'Management'], [ids.general, 'General']] as const) {
        expect(await db.employee.findUniqueOrThrow({ where: { id }, select: { specialty: true, specialtyCode: true } })).toEqual({ specialty: text, specialtyCode: null });
      }
    });

    it('Job Post (City) is a Saudi region + one of its cities: required, consistent, active, hidden from supervisors (owner decision 2026-10-03)', async () => {
      const regions = (await scoped.get('/saudi-regions')).body.items as Array<{ code: string; name: string }>;
      expect(regions.filter((r) => r.code.startsWith('SA-')).map((r) => r.name)).toEqual([
        'Riyadh Region', 'Makkah Region', 'Madinah Region', 'Eastern Province', 'Qassim Region', 'Asir Region', 'Tabuk Region',
        'Hail Region', 'Northern Borders Region', 'Jazan Region', 'Najran Region', 'Al-Baha Region', 'Al-Jouf Region',
      ]);
      const qassim = (await scoped.get('/saudi-cities?regionCode=SA-05')).body.items as Array<{ id: number; name: string; regionCode: string }>;
      // The starting cities in their order (other tests add test towns of their own to the shared database).
      const start = ['Buraydah', 'Unaizah', 'Ar Rass', 'Al Bukayriyah', 'Al Mithnab', 'Al Badai', 'Riyadh Al Khabra', 'Uyun Al Jawa'];
      expect(qassim.filter((c) => start.includes(c.name)).map((c) => c.name)).toEqual(start);
      expect(qassim.every((c) => c.regionCode === 'SA-05')).toBe(true);
      expect((await scoped.get('/saudi-cities?regionCode=SA-01&q=kharj')).body.items.map((c: { name: string }) => c.name)).toEqual(['Al Kharj']);
      const jeddah = (await scoped.get('/saudi-cities?regionCode=SA-02&q=jeddah')).body.items[0].id as number;

      const { jobPostRegionCode: _r, jobPostCityId: _c, ...without } = onboardBody();
      expect(JSON.stringify((await idem(scoped.post('/employees/onboard', without))).body)).toContain('Job Post (City) is required.');
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ jobPostCityId: jeddah })))).body.error.code).toBe('CITY_NOT_IN_REGION'); // Qassim + Jeddah
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ jobPostRegionCode: 'SA-99' })))).body.error.code).toBe('REGION_INVALID');
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ jobPostCityId: 999999 })))).body.error.code).toBe('CITY_INVALID');
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ jobPostLocation: 'Buraydah' })))).body.error.code).toBe('VALIDATION_FAILED');

      const made = await idem(scoped.post('/employees/onboard', onboardBody()));
      expect(made.status).toBe(201);
      const id = made.body.employeeId as number;
      expect((await scoped.get(`/employees/${id}`)).body).toMatchObject({
        jobPostRegionCode: 'SA-05', jobPostCityId: buraydah, jobPostRegionName: 'Qassim Region', jobPostCityName: 'Buraydah', jobPostCityNameAr: 'بريدة', jobPostLocation: null,
      });
      expect((await scoped.patch(`/employees/${id}`, { jobPostCityId: jeddah })).body.error.code).toBe('JOB_POST_INCOMPLETE');
      expect((await scoped.patch(`/employees/${id}`, { jobPostRegionCode: 'SA-02', jobPostCityId: jeddah })).body).toMatchObject({ jobPostRegionName: 'Makkah Region', jobPostCityName: 'Jeddah' });

      // A city deactivated later stays on the employee and the record stays editable; new choices cannot take it.
      const spare = await hr.post('/saudi-cities', { regionCode: 'SA-05', name: `Test town ${uniq('T')}`, sortOrder: 99 });
      await scoped.patch(`/employees/${id}`, { jobPostRegionCode: 'SA-05', jobPostCityId: spare.body.id });
      await hr.patch(`/saudi-cities/${spare.body.id}`, { isActive: false });
      expect((await scoped.patch(`/employees/${id}`, { jobPostRegionCode: 'SA-05', jobPostCityId: spare.body.id, jobTitle: 'Staff Nurse II' })).status).toBe(200);
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ jobPostCityId: spare.body.id })))).body.error.code).toBe('CITY_INACTIVE');
      expect((await scoped.get('/saudi-cities?regionCode=SA-05')).body.items.map((c: { id: number }) => c.id)).not.toContain(spare.body.id);

      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      const seen = (await sup.get(`/employees/${id}`)).body;
      expect(seen).not.toHaveProperty('jobPostCityId');
      expect(seen).not.toHaveProperty('jobPostLocation');
    });

    it('Saudi location master: regions and cities — add, edit, deactivate, reactivate, safe delete; unique names; audited', async () => {
      const code = `T-${uniq('').slice(-6).toUpperCase()}`.slice(0, 10);
      const nurse = await signIn(app, (await makeUser(db)).email);
      expect((await nurse.post('/saudi-regions', { code, name: 'x' })).status).toBe(403);
      expect((await scoped.post('/saudi-regions', { code, name: 'Scoped' })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await hr.post('/saudi-regions', { code, name: 'qassim region' })).body.error.code).toBe('REGION_NAME_EXISTS');
      expect((await hr.post('/saudi-regions', { code: code.toLowerCase(), name: `Future Region ${code}`, sortOrder: 14 })).body).toMatchObject({ code, isActive: true });
      expect((await hr.post('/saudi-regions', { code, name: 'Again' })).body.error.code).toBe('REGION_EXISTS');

      const city = await hr.post('/saudi-cities', { regionCode: code, name: 'New City', nameAr: 'مدينة جديدة', sortOrder: 1 });
      expect(city.status).toBe(201);
      expect((await hr.post('/saudi-cities', { regionCode: code, name: 'new city' })).body.error.code).toBe('CITY_NAME_EXISTS');
      expect((await hr.post('/saudi-cities', { regionCode: 'SA-99', name: 'Nowhere' })).body.error.code).toBe('REGION_INVALID');
      // The same name in another region is fine (it is a different place).
      const twin = await hr.post('/saudi-cities', { regionCode: 'SA-05', name: `New City ${code}`, sortOrder: 99 });
      expect(twin.status).toBe(201);
      await hr.del(`/saudi-cities/${twin.body.id}`);

      // A region with cities cannot be deleted; a city held by an employee cannot be deleted or moved.
      expect((await hr.del(`/saudi-regions/${code}`)).body.error).toMatchObject({ code: 'REGION_IN_USE', details: { cities: 1, employees: 0 } });
      const emp = await makeEmployee(db, org.unitA.id);
      await db.employee.update({ where: { id: emp.id }, data: { jobPostRegionCode: code, jobPostCityId: city.body.id } });
      expect((await hr.del(`/saudi-cities/${city.body.id}`)).body.error).toMatchObject({ code: 'CITY_IN_USE', details: { employees: 1 } });
      expect((await hr.patch(`/saudi-cities/${city.body.id}`, { regionCode: 'SA-05' })).body.error.code).toBe('CITY_IN_USE');
      await hr.patch(`/saudi-cities/${city.body.id}`, { name: 'New City Renamed' });
      await hr.patch(`/saudi-cities/${city.body.id}`, { isActive: false });
      await hr.patch(`/saudi-cities/${city.body.id}`, { isActive: true });
      await hr.patch(`/saudi-regions/${code}`, { isActive: false });
      expect((await hr.get('/saudi-regions')).body.items.map((r: { code: string }) => r.code)).not.toContain(code);
      expect((await hr.get(`/saudi-cities?regionCode=${code}`)).body.items).toEqual([]); // cities of an inactive region are hidden
      await hr.patch(`/saudi-regions/${code}`, { isActive: true });

      await db.employee.update({ where: { id: emp.id }, data: { jobPostRegionCode: 'SA-05', jobPostCityId: buraydah } });
      expect((await hr.del(`/saudi-cities/${city.body.id}`)).body).toEqual({ id: city.body.id, deleted: true });
      expect((await hr.del(`/saudi-regions/${code}`)).body).toEqual({ code, deleted: true });

      const cityActions = (await db.auditEntry.findMany({ where: { resource: 'saudi_city', resourceId: String(city.body.id) }, orderBy: { id: 'asc' } })).map((a) => a.action);
      expect(cityActions).toEqual(['CITY_CREATED', 'CITY_UPDATED', 'CITY_DEACTIVATED', 'CITY_REACTIVATED', 'CITY_DELETED']);
      const regionActions = (await db.auditEntry.findMany({ where: { resource: 'saudi_region', resourceId: code }, orderBy: { id: 'asc' } })).map((a) => a.action);
      expect(regionActions).toEqual(['REGION_CREATED', 'REGION_DEACTIVATED', 'REGION_REACTIVATED', 'REGION_DELETED']);
    });

    it('the migration maps old free-text job post cities to Region + City and keeps what it cannot match', async () => {
      const sql = readFileSync(resolve(__dirname, '../prisma/migrations/20261020090000_saudi_locations/migration.sql'), 'utf8');
      const normalise = sql.slice(sql.indexOf('WITH matched'));
      const make = async (jobPostLocation: string) => (await db.employee.update({ where: { id: (await makeEmployee(db, org.unitA.id)).id }, data: { jobPostLocation, jobPostRegionCode: null, jobPostCityId: null } })).id;
      const ids = { plain: await make(' buraydah '), pair: await make('Makkah Region - Jeddah'), arabic: await make('عنيزة'), other: await make('Riyadh - Al Iman Hospital') };
      await db.$executeRawUnsafe(normalise);
      const loc = async (id: number) => db.employee.findUniqueOrThrow({ where: { id }, select: { jobPostLocation: true, jobPostRegionCode: true, jobPostCity: { select: { name: true } } } });
      expect(await loc(ids.plain)).toEqual({ jobPostLocation: null, jobPostRegionCode: 'SA-05', jobPostCity: { name: 'Buraydah' } });
      expect(await loc(ids.pair)).toEqual({ jobPostLocation: null, jobPostRegionCode: 'SA-02', jobPostCity: { name: 'Jeddah' } });
      expect(await loc(ids.arabic)).toEqual({ jobPostLocation: null, jobPostRegionCode: 'SA-05', jobPostCity: { name: 'Unaizah' } });
      expect(await loc(ids.other)).toEqual({ jobPostLocation: 'Riyadh - Al Iman Hospital', jobPostRegionCode: null, jobPostCity: null });
    });

    it('Actual Work Place / Facility comes from the Facility master: required, active, shown to supervisors (owner decision 2026-10-03)', async () => {
      const list = (await scoped.get('/facilities')).body.items as Array<{ id: number; name: string }>;
      const start = ['Al Iman General Hospital', 'King Saud Medical City', 'King Salman Hospital', 'Imam Abdulrahman Alfaisal Hospital', 'King Fahd Hospital',
        'King Faisal Specialist Hospital & Research Centre', 'Security Forces Hospital - Main Building', 'National Guard Hospital',
        'Prince Sultan Military Medical City', 'King Abdullah bin Abdulaziz University Hospital'];
      expect(list.filter((f) => start.includes(f.name)).map((f) => f.name)).toEqual(start);
      expect((await scoped.get('/facilities?q=guard')).body.items.map((f: { name: string }) => f.name)).toContain('National Guard Hospital');

      const { facilityId: _f, ...without } = onboardBody();
      expect(JSON.stringify((await idem(scoped.post('/employees/onboard', without))).body)).toContain('Actual Work Place / Facility is required.');
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ facilityId: 999999 })))).body.error.code).toBe('FACILITY_INVALID');
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ actualWorkPlace: 'ICU Main' })))).body.error.code).toBe('VALIDATION_FAILED');

      const temp = await hr.post('/facilities', { name: `Test Clinic ${uniq('F')}` });
      const made = await idem(scoped.post('/employees/onboard', onboardBody({ facilityId: temp.body.id })));
      expect(made.status).toBe(201);
      const id = made.body.employeeId as number;
      expect((await scoped.get(`/employees/${id}`)).body).toMatchObject({ facilityId: temp.body.id, facilityName: temp.body.name, facilityActive: true, actualWorkPlace: null });

      // Renamed: the employee shows the new name (same id). Deactivated: kept and editable; refused as a new choice.
      await hr.patch(`/facilities/${temp.body.id}`, { name: `${temp.body.name} North` });
      expect((await scoped.get(`/employees/${id}`)).body.facilityName).toBe(`${temp.body.name} North`);
      await hr.patch(`/facilities/${temp.body.id}`, { isActive: false });
      expect((await scoped.patch(`/employees/${id}`, { facilityId: temp.body.id, jobTitle: 'Staff Nurse II' })).body).toMatchObject({ facilityId: temp.body.id, facilityActive: false });
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ facilityId: temp.body.id })))).body.error.code).toBe('FACILITY_INACTIVE');
      expect((await scoped.get('/facilities')).body.items.map((f: { id: number }) => f.id)).not.toContain(temp.body.id);
      expect((await scoped.patch(`/employees/${id}`, { facilityId: null })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await scoped.patch(`/employees/${id}`, { facilityId: alIman })).body.facilityName).toBe('Al Iman General Hospital');

      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      expect((await sup.get(`/employees/${id}`)).body).toMatchObject({ view: 'BASELINE', facilityId: alIman, facilityName: 'Al Iman General Hospital' });
    });

    it('Facility master: names trimmed and unique ignoring case and spaces; edit keeps the id; delete only when unused; permissions; audited', async () => {
      const nurse = await signIn(app, (await makeUser(db)).email);
      const name = `Riyadh Care ${uniq('F')}`;
      expect((await nurse.post('/facilities', { name })).status).toBe(403);
      expect((await scoped.post('/facilities', { name })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await hr.post('/facilities', { name: '   ' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await hr.post('/facilities', { name: '  king   saud  MEDICAL city ' })).body.error.code).toBe('FACILITY_NAME_EXISTS');
      const made = await hr.post('/facilities', { name: `  ${name.replace(' ', '   ')}  `, nameAr: ' مستشفى  تجريبي ' });
      expect(made.body).toMatchObject({ name, nameAr: 'مستشفى تجريبي', isActive: true });
      expect(made.body.sortOrder).toBeGreaterThanOrEqual(11); // appended after the starting list
      expect((await hr.patch(`/facilities/${made.body.id}`, { name: 'National Guard Hospital' })).body.error.code).toBe('FACILITY_NAME_EXISTS');
      const renamed = await hr.patch(`/facilities/${made.body.id}`, { name: `${name} East` });
      expect(renamed.body).toMatchObject({ id: made.body.id, name: `${name} East` });
      await hr.patch(`/facilities/${made.body.id}`, { isActive: false });
      await hr.patch(`/facilities/${made.body.id}`, { isActive: true });

      const emp = await makeEmployee(db, org.unitA.id);
      await db.employee.update({ where: { id: emp.id }, data: { facilityId: made.body.id } });
      const refused = await hr.del(`/facilities/${made.body.id}`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatchObject({ code: 'FACILITY_IN_USE', details: { employees: 1 } });
      expect(refused.body.error.message).toContain(`${name} East`);
      await db.employee.update({ where: { id: emp.id }, data: { facilityId: alIman } });
      expect((await hr.del(`/facilities/${made.body.id}`)).body).toEqual({ id: made.body.id, deleted: true });

      const actions = (await db.auditEntry.findMany({ where: { resource: 'facility', resourceId: String(made.body.id) }, orderBy: { id: 'asc' } })).map((a) => a.action);
      expect(actions).toEqual(['FACILITY_CREATED', 'FACILITY_UPDATED', 'FACILITY_DEACTIVATED', 'FACILITY_REACTIVATED', 'FACILITY_DELETED']);
    });

    it('the migration maps old free-text work places that are a listed facility and keeps everything else', async () => {
      const sql = readFileSync(resolve(__dirname, '../prisma/migrations/20261021090000_facilities/migration.sql'), 'utf8');
      const normalise = sql.slice(sql.lastIndexOf('UPDATE "employees"'));
      const make = async (actualWorkPlace: string) => (await db.employee.update({ where: { id: (await makeEmployee(db, org.unitA.id)).id }, data: { actualWorkPlace, facilityId: null } })).id;
      const ids = { exact: await make('  king  fahd hospital '), arabic: await make('مستشفى الحرس الوطني'), ward: await make('ICU Main'), near: await make('Riyadh - Al Iman Hospital') };
      await db.$executeRawUnsafe(normalise);
      const fac = async (id: number) => db.employee.findUniqueOrThrow({ where: { id }, select: { actualWorkPlace: true, facility: { select: { name: true } } } });
      expect(await fac(ids.exact)).toEqual({ actualWorkPlace: null, facility: { name: 'King Fahd Hospital' } });
      expect(await fac(ids.arabic)).toEqual({ actualWorkPlace: null, facility: { name: 'National Guard Hospital' } });
      expect(await fac(ids.ward)).toEqual({ actualWorkPlace: 'ICU Main', facility: null });
      expect(await fac(ids.near)).toEqual({ actualWorkPlace: 'Riyadh - Al Iman Hospital', facility: null });
    });

    it('the migration maps old free-text Rank/Grade to codes and keeps what it cannot match', async () => {
      const sql = readFileSync(resolve(__dirname, '../prisma/migrations/20261018090000_rank_grades/migration.sql'), 'utf8');
      const normalise = sql.slice(sql.lastIndexOf('UPDATE "employees"'));
      const make = async (rankGrade: string) => (await db.employee.update({ where: { id: (await makeEmployee(db, org.unitA.id)).id }, data: { rankGrade, rankGradeCode: null } })).id;
      const ids = { code: await make(' n04 '), name: await make('specialist nurse'), grade: await make('Grade 7') };
      await db.$executeRawUnsafe(normalise);
      const after = async (id: number) => db.employee.findUniqueOrThrow({ where: { id }, select: { rankGrade: true, rankGradeCode: true } });
      expect(await after(ids.code)).toEqual({ rankGrade: null, rankGradeCode: 'N04' });
      expect(await after(ids.name)).toEqual({ rankGrade: null, rankGradeCode: 'N03' });
      expect(await after(ids.grade)).toEqual({ rankGrade: 'Grade 7', rankGradeCode: null }); // a pay grade is not a classification: kept for HR
    });

    it('the migration maps old free-text nationalities to codes and keeps what it cannot match', async () => {
      const sql = readFileSync(resolve(__dirname, '../prisma/migrations/20261017090000_nationalities/migration.sql'), 'utf8');
      const normalise = sql.slice(sql.indexOf('WITH alias'));
      const make = async (nationality: string) => (await db.employee.update({ where: { id: (await makeEmployee(db, org.unitA.id)).id }, data: { nationality, nationalityCode: null } })).id;
      const ids = { saudi: await make('  saudi '), country: await make('Egypt'), code: await make('jor'), arabic: await make('هندي'), alias: await make('UAE'), unknown: await make('Kanadian') };
      await db.$executeRawUnsafe(normalise);
      const after = async (id: number) => db.employee.findUniqueOrThrow({ where: { id }, select: { nationality: true, nationalityCode: true } });
      expect(await after(ids.saudi)).toEqual({ nationality: null, nationalityCode: 'SAU' });
      expect(await after(ids.country)).toEqual({ nationality: null, nationalityCode: 'EGY' });
      expect(await after(ids.code)).toEqual({ nationality: null, nationalityCode: 'JOR' });
      expect(await after(ids.arabic)).toEqual({ nationality: null, nationalityCode: 'IND' });
      expect(await after(ids.alias)).toEqual({ nationality: null, nationalityCode: 'ARE' });
      expect(await after(ids.unknown)).toEqual({ nationality: 'Kanadian', nationalityCode: null }); // kept for HR, never guessed
      expect((await scoped.get(`/employees/${ids.unknown}`)).body).toMatchObject({ nationality: 'Kanadian', nationalityCode: null, nationalityName: null });
    });

    it('creates the employee, a Draft contract with Hijri dates, an audit row and an INELIGIBLE state atomically', async () => {
      const body = onboardBody();
      expect((await scoped.post('/employees/onboard', body)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const key = randomUUID();
      const res = await scoped.post('/employees/onboard', body).set('Idempotency-Key', key);
      expect(res.status).toBe(201);
      const replay = await scoped.post('/employees/onboard', body).set('Idempotency-Key', key);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(res.body);

      const emp = await db.employee.findUniqueOrThrow({ where: { id: res.body.employeeId } });
      expect(emp).toMatchObject({ fullName: 'Mona Saleh', positionCode: 'SN', contactEmail: 'mona@example.sa' });
      const contract = await db.contract.findUniqueOrThrow({ where: { id: res.body.contractId } });
      expect(contract.status).toBe('Draft');
      expect(contract.contractTypeCode).toBe('DIRECT_HOSPITAL');
      expect(contract.startDateHijri).toMatch(/^14\d\d-\d\d-\d\d$/);
      const state = await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: emp.id } });
      expect(JSON.stringify(state.reasons)).toContain('NO_CONTRACT_COVERAGE');
      expect(await db.auditEntry.count({ where: { action: 'EMPLOYEE_ONBOARDED', resourceId: String(emp.id) } })).toBe(1);
    });

    it('rolls back everything on a duplicate job number (any case) and guards scope', async () => {
      const jobNumber = uniq('DUP');
      await idem(hr.post('/employees/onboard', onboardBody({ jobNumber })));
      const before = await db.contract.count();
      const dup = await idem(hr.post('/employees/onboard', onboardBody({ jobNumber: jobNumber.toLowerCase() })));
      expect(dup.body.error.code).toBe('JOB_NUMBER_TAKEN');
      expect(await db.contract.count()).toBe(before);
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ unitId: null })))).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ unitId: org.unitC.id })))).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await idem(hr.post('/employees/onboard', onboardBody({ contractEnd: today() })))).body.error.code).toBe('CONTRACT_DATES_INVALID');
      expect((await idem(hr.post('/employees/onboard', onboardBody({ salary: -1 })))).body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('employee views and changes (§8.1, E9)', () => {
    it('HR sees every field, a Supervisor the baseline (D-36), the employee their own profile', async () => {
      const { emp, user } = await makeNurse(db, org.unitA.id, { account: true });
      await db.employee.update({
        where: { id: emp.id },
        data: { salary: 9000, nationality: 'SA', maritalStatus: 'Married', rankGrade: 'G5', fileNo: 'F-77', jobPostLocation: 'Post A', actualWorkPlace: 'Ward 3', primaryPhone: '+966501234567', emergencyContactPhone: '+639171234567' },
      });
      expect((await hr.get(`/employees/${emp.id}`)).body).toMatchObject({ view: 'FULL', salary: '9000.00', nationality: 'SA', emergencyContactPhone: '+639171234567' });
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      const seen = await sup.get(`/employees/${emp.id}`);
      expect(seen.body).toMatchObject({ view: 'BASELINE', contactEmail: emp.contactEmail, primaryPhone: '+966501234567', actualWorkPlace: 'Ward 3' });
      for (const hidden of ['salary', 'maritalStatus', 'nationality', 'rankGrade', 'fileNo', 'jobPostLocation', 'emergencyContactPhone']) {
        expect(seen.body, hidden).not.toHaveProperty(hidden);
      }
      const listed = (await sup.get(`/employees?unitId=${org.unitA.id}`)).body.items;
      expect(listed.every((e: { view: string }) => e.view === 'BASELINE')).toBe(true);
      const outside = await makeEmployee(db, org.unitC.id);
      expect((await sup.get(`/employees/${outside.id}`)).status).toBe(403);
      const self = await signIn(app, user!.email);
      expect((await self.get('/employees/me')).body).toMatchObject({ id: emp.id, view: 'FULL' });
      expect((await self.get('/employees')).status).toBe(403);
    });

    it('a unit move re-evaluates eligibility; position change is HR_ADMIN only and audited', async () => {
      const emp = await makeEmployee(db, org.unitA.id);
      expect((await scoped.patch(`/employees/${emp.id}`, { unitId: org.unitC.id })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await hr.patch(`/employees/${emp.id}`, { unitId: org.unitB.id, fileNo: 'F-1' })).body).toMatchObject({ unitId: org.unitB.id, fileNo: 'F-1', firstName: 'Test' });
      expect((await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: emp.id } })).updatedByEvent).toBe('EMPLOYEE_UNIT_CHANGED');

      await db.position.upsert({ where: { code: 'CN' }, update: { isActive: true }, create: { code: 'CN', title: 'Charge Nurse', tier: 'Clinical Lead', isSchedulable: true } });
      const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
      expect((await sa.post(`/employees/${emp.id}/position`, { positionCode: 'CN', reason: 'Promotion' })).status).toBe(403);
      expect((await hr.post(`/employees/${emp.id}/position`, { positionCode: 'SN', reason: 'No change' })).body.error.code).toBe('POSITION_UNCHANGED');
      expect((await hr.post(`/employees/${emp.id}/position`, { positionCode: 'CN', reason: 'Promotion' })).body.positionCode).toBe('CN');
      expect(await db.auditEntry.count({ where: { action: 'EMPLOYEE_POSITION_CHANGED', resourceId: String(emp.id) } })).toBe(1);

      expect((await hr.del(`/employees/${emp.id}`).send({ reason: 'Left the hospital' })).body.deleted).toBe(true);
      expect((await hr.get(`/employees/${emp.id}`)).status).toBe(404);
      expect((await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: emp.id } })).status).toBe('INELIGIBLE');
    });
  });

  describe('own phone numbers (D-35)', () => {
    it('the employee updates only their phones, in international format; HR too; the next-of-kin number stays out of the audit', async () => {
      const { emp, user } = await makeNurse(db, org.unitA.id, { account: true });
      const self = await signIn(app, user!.email);
      const ok = await self.patch('/employees/me/contact', { primaryPhone: '+966 50-123-4567', emergencyContactPhone: '+44 (20) 7946 0958' });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ id: emp.id, primaryPhone: '+966501234567', emergencyContactPhone: '+442079460958' });
      for (const bad of ['0501234567', '+0501234567', '+1234567', '+9665012345678901', 'call me']) {
        expect((await self.patch('/employees/me/contact', { primaryPhone: bad })).body.error.code, bad).toBe('VALIDATION_FAILED');
      }
      expect((await self.patch('/employees/me/contact', { salary: '1' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await self.patch('/employees/me/contact', {})).body.error.code).toBe('NO_CHANGES');
      expect((await self.patch('/employees/me/contact', { emergencyContactPhone: null })).body.emergencyContactPhone).toBeNull();

      const audit = await db.auditEntry.findMany({ where: { action: 'EMPLOYEE_CONTACT_UPDATED', resourceId: String(emp.id) }, orderBy: { id: 'asc' } });
      expect(audit[0]!.changes).toMatchObject({ primaryPhone: { from: null, to: '+966501234567' }, emergencyContactPhone: { from: '(redacted)', to: '(redacted)' } });
      expect(JSON.stringify(audit.map((a) => a.changes))).not.toContain('442079460958');

      expect((await hr.patch(`/employees/${emp.id}`, { primaryPhone: '+639171234567' })).body.primaryPhone).toBe('+639171234567');
      await expect(db.employee.update({ where: { id: emp.id }, data: { primaryPhone: '0501234567' } })).rejects.toThrow(); // database CHECK
      const unlinked = await signIn(app, (await makeUser(db)).email);
      expect((await unlinked.patch('/employees/me/contact', { primaryPhone: '+966501234567' })).body.error.code).toBe('NO_EMPLOYEE_RECORD');
    });
  });

  describe('unauthorized access sweep (R15)', () => {
    const STAFF_ONLY: Array<[string, string]> = [
      ['POST', '/departments'], ['PATCH', '/departments/1'], ['POST', '/units'], ['PATCH', '/units/1'],
      ['PUT', '/units/1/bed-capacity'], ['PUT', '/units/bed-capacity/bulk'], ['POST', '/units/import'], ['GET', '/units/1/bed-history'],
      ['POST', '/positions'], ['PATCH', '/positions/SN'], ['PUT', '/coverage-targets'], ['GET', '/kpi/nurse-to-bed?date=2026-01-01&shift=Night'],
      ['GET', '/employees'], ['POST', '/employees/onboard'], ['PATCH', '/employees/1'], ['POST', '/employees/1/position'], ['DELETE', '/employees/1'],
      ['GET', '/contracts'], ['GET', '/contracts/creatable'], ['GET', '/contracts/renewable'], ['POST', '/contracts'],
      ['POST', '/contracts/1/renew'], ['POST', '/contracts/1/transition'], ['POST', '/contracts/1/documents'],
    ];
    it.each(STAFF_ONLY)('%s %s is forbidden to an employee', async (method, path) => {
      const nurse = await signIn(app, (await makeUser(db)).email);
      const req = method === 'GET' ? nurse.get(path) : method === 'POST' ? nurse.post(path, {}) : method === 'PUT' ? nurse.put(path, {}) : method === 'PATCH' ? nurse.patch(path, {}) : nurse.del(path);
      expect((await req.set('Idempotency-Key', randomUUID())).status).toBe(403);
    });

    it('a nurse reads only their own record and contracts', async () => {
      const { user } = await makeNurse(db, org.unitA.id, { account: true });
      const other = await makeNurse(db, org.unitA.id);
      const nurse = await signIn(app, user!.email);
      expect((await nurse.get(`/employees/${other.emp.id}`)).status).toBe(403);
      const theirs = await db.contract.findFirstOrThrow({ where: { employeeId: other.emp.id } });
      expect((await nurse.get(`/contracts/${theirs.id}`)).status).toBe(403);
      expect((await nurse.get(`/contracts/${theirs.id}/documents`)).status).toBe(403);
    });
  });

  describe('contracts (C1–C11, D-29, D-30)', () => {
    const TYPE = 'DIRECT_HOSPITAL'; // one of the types the migration adds (owner decision 2026-10-03)
    async function draftFor(creator: Client, start = today(), end = addDays(today(), 364)) {
      const emp = await makeEmployee(db, org.unitA.id);
      const made = await idem(creator.post('/contracts', { employeeId: emp.id, startDate: start, endDate: end, contractTypeCode: TYPE }));
      expect(made.status).toBe(201);
      return { emp, id: made.body.id as number };
    }
    const act = (c: Client, id: number, action: string, reason?: string) => c.post(`/contracts/${id}/transition`, { action, ...(reason ? { reason } : {}) });

    it('Draft → submit (needs a copy) → approve by someone else → Active, with eligibility', async () => {
      const { emp, id } = await draftFor(hr);
      expect((await act(hr, id, 'approve')).body.error.code).toBe('TRANSITION_NOT_ALLOWED');
      expect((await act(hr, id, 'submit')).body.error.code).toBe('CONTRACT_COPY_REQUIRED');
      expect((await hr.upload(`/contracts/${id}/documents`, FILES.png, 'image/png', 'copy.png')).status).toBe(415);
      expect((await hr.upload(`/contracts/${id}/documents`, FILES.pdf, 'application/pdf', 'copy.pdf')).status).toBe(201);
      expect((await act(hr, id, 'submit')).body.status).toBe('PendingApproval');
      expect((await act(hr, id, 'approve')).body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
      const approved = await act(hr2, id, 'approve');
      expect(approved.body).toMatchObject({ status: 'Active', eligibility: 'ELIGIBLE' });
      expect((await db.contract.findUniqueOrThrow({ where: { id } })).approvedAt).not.toBeNull();

      expect((await act(hr, id, 'suspend')).body.error.code).toBe('VALIDATION_FAILED');
      expect((await act(hr, id, 'suspend', 'Investigation pending')).body).toMatchObject({ status: 'Suspended', eligibility: 'INELIGIBLE' });
      expect((await act(hr, id, 'reinstate', 'Investigation closed')).body.status).toBe('Active');
      expect((await act(hr, id, 'terminate', 'Resigned with notice')).body.status).toBe('Terminated');
      expect((await act(hr, id, 'reinstate', 'Try again')).body.error.code).toBe('TRANSITION_NOT_ALLOWED');
      expect((await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: emp.id } })).status).toBe('INELIGIBLE');
    });

    it('a future period is Approved (C2); an overlapping renewal cannot be approved (C4); return goes back to Draft', async () => {
      const { emp, id } = await draftFor(hr);
      await hr.upload(`/contracts/${id}/documents`, FILES.pdf, 'application/pdf');
      await act(hr, id, 'submit');
      await act(hr2, id, 'approve');
      expect((await idem(hr.post('/contracts', { employeeId: emp.id, startDate: today(), endDate: addDays(today(), 10), contractTypeCode: TYPE }))).body.error.code).toBe('EMPLOYEE_HAS_CONTRACT');

      // The picker lists at most 500 employees; read it through HR scoped to a unit of its own so the shared test database cannot push this one out.
      const own = await db.unit.create({ data: { code: uniq('RN').toUpperCase().slice(0, 20), name: 'Renewal unit', departmentId: org.dept.id } });
      await db.employee.update({ where: { id: emp.id }, data: { unitId: own.id } });
      const unitHr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [own.id] }] })).email);
      const renewable = (await unitHr.get('/contracts/renewable')).body.items.find((r: { employeeId: number }) => r.employeeId === emp.id);
      expect(renewable.prefill.start).toBe(addDays(today(), 365));
      const next = await idem(hr.post(`/contracts/${id}/renew`, {}));
      await hr.upload(`/contracts/${next.body.id}/documents`, FILES.pdf, 'application/pdf');
      await act(hr, next.body.id, 'submit');
      expect((await act(hr, next.body.id, 'return', 'Wrong grade on page 2')).body.status).toBe('Draft');
      await act(hr, next.body.id, 'submit');
      expect((await act(hr2, next.body.id, 'approve')).body.status).toBe('Approved');

      const overlapping = await idem(hr.post(`/contracts/${next.body.id}/renew`, { startDate: addDays(today(), 400), endDate: addDays(today(), 500) }));
      await hr.upload(`/contracts/${overlapping.body.id}/documents`, FILES.pdf, 'application/pdf');
      await act(hr, overlapping.body.id, 'submit');
      expect((await act(hr2, overlapping.body.id, 'approve')).body.error.code).toBe('CONTRACT_PERIOD_OVERLAP');
    });

    it('a renewal needs valid credentials; the contract itself is ignored, and a first contract is not gated (owner decision 2026-10-02)', async () => {
      const own = await db.unit.create({ data: { code: uniq('RC').toUpperCase().slice(0, 20), name: 'Renewal gate unit', departmentId: org.dept.id } });
      const tpl = await makeTemplate(db);
      await db.credentialRequirement.create({ data: { templateId: tpl.id, unitId: own.id, positionCode: null, policyStatus: 'MANDATORY' } });

      // A first contract is not gated, whatever the credentials.
      const newcomer = await makeEmployee(db, own.id);
      expect((await idem(hr.post('/contracts', { employeeId: newcomer.id, startDate: today(), endDate: addDays(today(), 30), contractTypeCode: TYPE }))).status).toBe(201);

      // The old contract has ended, so the nurse is INELIGIBLE for the contract too — that reason must not stop the renewal.
      const emp = await makeEmployee(db, own.id);
      const old = await db.contract.create({ data: { employeeId: emp.id, jobNumber: emp.jobNumber, status: 'Expired', startDate: toDbDate(addDays(today(), -400)), endDate: toDbDate(addDays(today(), -35)) } });
      const refused = await idem(hr.post(`/contracts/${old.id}/renew`, { contractTypeCode: TYPE }));
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('CREDENTIALS_BLOCK_RENEWAL');
      expect(refused.body.error.details.reasons).toEqual([expect.objectContaining({ code: 'CREDENTIAL_MISSING', templateCode: tpl.code })]);
      expect(JSON.stringify(refused.body.error.details.reasons)).not.toContain('NO_CONTRACT_COVERAGE');
      // A "new" contract after the old one ended is a renewal too.
      expect((await idem(hr.post('/contracts', { employeeId: emp.id, startDate: today(), endDate: addDays(today(), 30), contractTypeCode: TYPE }))).body.error.code).toBe('CREDENTIALS_BLOCK_RENEWAL');

      const cred = await db.credential.create({ data: { employeeId: emp.id, templateId: tpl.id, status: 'Valid', trackingData: {}, expiryDate: toDbDate(addDays(today(), 200)) } });
      const next = await idem(hr.post(`/contracts/${old.id}/renew`, { contractTypeCode: TYPE }));
      expect(next.status).toBe(201);
      await hr.upload(`/contracts/${next.body.id}/documents`, FILES.pdf, 'application/pdf');
      await act(hr, next.body.id, 'submit');

      // Checked again at approval: the credential expired in between.
      await db.credential.update({ where: { id: cred.id }, data: { expiryDate: toDbDate(addDays(today(), -1)) } });
      const blocked = await act(hr2, next.body.id, 'approve');
      expect(blocked.body.error.code).toBe('CREDENTIALS_BLOCK_RENEWAL');
      expect(blocked.body.error.details.reasons[0]).toMatchObject({ code: 'CREDENTIAL_EXPIRED', templateCode: tpl.code });
      expect((await db.contract.findUniqueOrThrow({ where: { id: next.body.id } })).status).toBe('PendingApproval');

      await db.credential.update({ where: { id: cred.id }, data: { expiryDate: toDbDate(addDays(today(), 200)) } });
      expect((await act(hr2, next.body.id, 'approve')).body).toMatchObject({ status: 'Active', eligibility: 'ELIGIBLE' });
    });

    it('an employment contract type, when given, must be on the active list; new contracts and renewals otherwise carry the previous one (owner decisions 2026-10-03, 2026-10-04)', async () => {
      const emp = await makeEmployee(db, org.unitA.id);
      const body = { employeeId: emp.id, startDate: today(), endDate: addDays(today(), 364) };
      expect((await idem(hr.post('/contracts', { ...body, contractTypeCode: 'NOT_A_TYPE' }))).body.error.code).toBe('CONTRACT_TYPE_INVALID');
      const retired = await hr.post('/contract-types', { code: uniq('RT').toUpperCase().slice(0, 20), name: 'Retired type' });
      await hr.patch(`/contract-types/${retired.body.code}`, { isActive: false });
      expect((await idem(hr.post('/contracts', { ...body, contractTypeCode: retired.body.code }))).body.error.code).toBe('CONTRACT_TYPE_INACTIVE');

      const made = await idem(hr.post('/contracts', { ...body, contractTypeCode: 'AGENCY' }));
      expect(made.status).toBe(201);
      expect((await hr.get(`/contracts/${made.body.id}`)).body).toMatchObject({ contractTypeCode: 'AGENCY', contractTypeName: 'Agency Contract', contractTypeNameAr: expect.any(String) });
      const listed = await hr.get(`/contracts?employeeId=${emp.id}&contractTypeCode=AGENCY`);
      expect(listed.body.items.map((c: { id: number }) => c.id)).toEqual([made.body.id]);
      expect((await hr.get(`/contracts?employeeId=${emp.id}&contractTypeCode=SOP`)).body.items).toEqual([]);
      const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'CONTRACT_CREATED', resourceId: String(made.body.id) } });
      expect(audit.changes).toMatchObject({ contractTypeCode: 'AGENCY' });

      // A renewal keeps the type unless another is given.
      const kept = await idem(hr.post(`/contracts/${made.body.id}/renew`, {}));
      expect((await db.contract.findUniqueOrThrow({ where: { id: kept.body.id } })).contractTypeCode).toBe('AGENCY');
      const changed = await idem(hr.post(`/contracts/${kept.body.id}/renew`, { contractTypeCode: 'TEMPORARY' }));
      expect((await db.contract.findUniqueOrThrow({ where: { id: changed.body.id } })).contractTypeCode).toBe('TEMPORARY');

      // New contract without a type: the employee's latest contract's type (set at Onboard employee)…
      const returning = await makeEmployee(db, org.unitA.id);
      await db.contract.create({ data: { employeeId: returning.id, jobNumber: returning.jobNumber, status: 'Expired', contractTypeCode: 'SOP', startDate: toDbDate(addDays(today(), -400)), endDate: toDbDate(addDays(today(), -35)) } });
      const carried = await idem(hr.post('/contracts', { employeeId: returning.id, startDate: today(), endDate: addDays(today(), 364) }));
      expect(carried.status).toBe(201);
      expect((await db.contract.findUniqueOrThrow({ where: { id: carried.body.id } })).contractTypeCode).toBe('SOP');
      // …or "Not classified" when there is none.
      const first = await idem(hr.post('/contracts', { employeeId: (await makeEmployee(db, org.unitA.id)).id, startDate: today(), endDate: addDays(today(), 364) }));
      expect(first.status).toBe(201);
      expect((await hr.get(`/contracts/${first.body.id}`)).body).toMatchObject({ contractTypeCode: null, contractTypeName: null });

      // A previous type that has been deactivated is not carried into a new contract or renewal.
      const stale = await makeEmployee(db, org.unitA.id);
      const staleOld = await db.contract.create({ data: { employeeId: stale.id, jobNumber: stale.jobNumber, status: 'Expired', contractTypeCode: retired.body.code, startDate: toDbDate(addDays(today(), -400)), endDate: toDbDate(addDays(today(), -35)) } });
      const renewedStale = await idem(hr.post(`/contracts/${staleOld.id}/renew`, {}));
      expect(renewedStale.status).toBe(201);
      expect((await db.contract.findUniqueOrThrow({ where: { id: renewedStale.body.id } })).contractTypeCode).toBeNull();

      // A contract from before the field stays unclassified, and so does its renewal unless a type is given.
      const legacy = await makeEmployee(db, org.unitA.id);
      const old = await db.contract.create({ data: { employeeId: legacy.id, jobNumber: legacy.jobNumber, status: 'Expired', startDate: toDbDate(addDays(today(), -400)), endDate: toDbDate(addDays(today(), -35)) } });
      expect((await hr.get(`/contracts/${old.id}`)).body).toMatchObject({ contractTypeCode: null, contractTypeName: null });
      const unclassified = await idem(hr.post(`/contracts/${old.id}/renew`, {}));
      expect(unclassified.status).toBe(201);
      expect((await db.contract.findUniqueOrThrow({ where: { id: unclassified.body.id } })).contractTypeCode).toBeNull();
    });

    it('contract types: system-wide HR adds and edits them; delete removes an unused type and deactivates a used one', async () => {
      const code = uniq('CT').toUpperCase().slice(0, 20);
      expect((await scoped.post('/contract-types', { code, name: 'Scoped try' })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await hr.post('/contract-types', { code: 'bad code!', name: 'x' })).body.error.code).toBe('VALIDATION_FAILED');
      const made = await hr.post('/contract-types', { code, name: 'Locum Contract', nameAr: 'عقد بديل', displayOrder: 9 });
      expect(made.status).toBe(201);
      expect((await hr.post('/contract-types', { code, name: 'Again' })).body.error.code).toBe('CONTRACT_TYPE_EXISTS');
      expect((await hr.patch(`/contract-types/${code}`, { name: 'Locum / Relief Contract' })).body.name).toBe('Locum / Relief Contract');
      expect((await scoped.get('/contract-types')).body.items.map((t: { code: string }) => t.code)).toEqual(expect.arrayContaining(['DIRECT_HOSPITAL', 'SOP', code]));

      // Unused: really deleted.
      const spare = uniq('CS').toUpperCase().slice(0, 20);
      await hr.post('/contract-types', { code: spare, name: 'Spare' });
      expect((await hr.del(`/contract-types/${spare}`)).body).toMatchObject({ outcome: 'DELETED', contractCount: 0 });
      expect(await db.contractType.findUnique({ where: { code: spare } })).toBeNull();

      // Used: deactivated — gone from the form list, kept on the contract and in the full list.
      const emp = await makeEmployee(db, org.unitA.id);
      const c = await idem(hr.post('/contracts', { employeeId: emp.id, startDate: today(), endDate: addDays(today(), 30), contractTypeCode: code }));
      expect(c.status).toBe(201);
      expect((await hr.del(`/contract-types/${code}`)).body).toMatchObject({ outcome: 'DEACTIVATED', contractCount: 1 });
      expect((await hr.get('/contract-types')).body.items.map((t: { code: string }) => t.code)).not.toContain(code);
      const all = (await hr.get('/contract-types?includeInactive=true')).body.items.find((t: { code: string }) => t.code === code);
      expect(all).toMatchObject({ isActive: false, contractCount: 1 });
      expect((await hr.get(`/contracts/${c.body.id}`)).body.contractTypeName).toBe('Locum / Relief Contract');
      expect(await db.auditEntry.count({ where: { resource: 'contract_type', resourceId: { in: [code, spare] } } })).toBe(5);
    });

    it('scope, own-contract and view rules', async () => {
      const { emp, id } = await draftFor(hr);
      expect((await idem(scoped.post('/contracts', { employeeId: (await makeEmployee(db, org.unitC.id)).id, startDate: today(), endDate: addDays(today(), 30), contractTypeCode: TYPE }))).body.error.code).toBe('SCOPE_NOT_COVERED');

      // An HR Admin who is also a nurse cannot manage their own contract.
      const selfHr = await makeUser(db, { employeeId: emp.id, roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
      const selfClient = await signIn(app, selfHr.email);
      expect((await act(selfClient, id, 'submit')).body.error.code).toBe('SELF_ACTION_FORBIDDEN');
      expect((await selfClient.get('/contracts/me')).body.items[0]).toMatchObject({ id, view: 'REDUCED' });

      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      const row = (await sup.get(`/contracts?employeeId=${emp.id}`)).body.items[0];
      expect(row.view).toBe('REDUCED');
      expect(row).not.toHaveProperty('createdById');
      expect((await sup.get(`/contracts/${id}/documents`)).status).toBe(403);
      expect((await sup.post(`/contracts/${id}/transition`, { action: 'submit' })).status).toBe(403);
      expect((await findChainBreaks(db))).toHaveLength(0);
    });

    it('the employee pickers search the whole scope on the server (job number or name) and return a page with the full match count', async () => {
      const tag = uniq('Pick');
      const withContract = await makeNurse(db, org.unitA.id);
      await db.employee.update({ where: { id: withContract.emp.id }, data: { lastName: `${tag}Renewer` } });
      const without = await makeEmployee(db, org.unitA.id);
      await db.employee.update({ where: { id: without.id }, data: { lastName: `${tag}Newcomer` } });

      // Name search (full_name is composed by trigger E3) is case-insensitive; each picker lists only its own kind (C10).
      const renew = await hr.get(`/contracts/renewable?q=${tag.toLowerCase()}`);
      expect(renew.body).toMatchObject({ total: 1, items: [{ employeeId: withContract.emp.id }] });
      const create = await hr.get(`/contracts/creatable?q=${tag.toUpperCase()}`);
      expect(create.body).toMatchObject({ total: 1, items: [{ id: without.id }] });
      // Job-number search.
      expect((await hr.get(`/contracts/renewable?q=${withContract.emp.jobNumber}`)).body.items.map((r: { employeeId: number }) => r.employeeId)).toEqual([withContract.emp.id]);

      // A page is at most `limit` rows; `total` counts every match, so the UI can say "refine your search".
      const page = await hr.get('/contracts/renewable?limit=2');
      expect(page.body.items).toHaveLength(2);
      expect(page.body.total).toBeGreaterThan(2);
      expect((await hr.get('/contracts/renewable?limit=51')).status).toBe(400);

      // Search never widens scope: unit HR elsewhere finds nothing.
      const otherHr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitC.id] }] })).email);
      expect((await otherHr.get(`/contracts/renewable?q=${tag}`)).body).toEqual({ items: [], total: 0 });
      expect((await otherHr.get(`/contracts/creatable?q=${tag}`)).body).toEqual({ items: [], total: 0 });
    });
  });
});
