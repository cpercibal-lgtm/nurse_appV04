// Optimistic concurrency (QA checklist DB-03, finding F5): an edit carries the
// version the caller loaded (If-Match: its updatedAt); a record changed since is
// refused with 409 STALE_RECORD and keeps the other person's change.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Db } from '../src/lib/prisma.js';
import { makeEmployee, makeNurse, makeOrg, makeUser, openDb, signIn, TEST_URL, testApp, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
type Client = Awaited<ReturnType<typeof signIn>>;
const tag = (v: string) => `"${v}"`;

describeDb('simultaneous edits are refused, not overwritten (DB-03)', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let hr: Client;
  let hr2: Client;

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    org = await makeOrg(db);
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    hr2 = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
  });
  afterAll(async () => { await db.$disconnect(); });

  it('employee: the second of two edits made from the same version is refused; the first stays', async () => {
    const emp = await makeEmployee(db, org.unitA.id);
    const loaded = (await hr.get(`/employees/${emp.id}`)).body.updatedAt as string;
    expect(loaded).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const first = await hr.patch(`/employees/${emp.id}`, { jobTitle: 'Charge Nurse' }).set('If-Match', tag(loaded));
    expect(first.status).toBe(200);
    expect(first.body.updatedAt).not.toBe(loaded);

    const second = await hr2.patch(`/employees/${emp.id}`, { jobTitle: 'Staff Nurse' }).set('If-Match', tag(loaded));
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'STALE_RECORD', details: { currentVersion: first.body.updatedAt } });
    expect((await db.employee.findUniqueOrThrow({ where: { id: emp.id } })).jobTitle).toBe('Charge Nurse');
    expect(await db.auditEntry.count({ where: { action: 'EMPLOYEE_UPDATED', resourceId: String(emp.id) } })).toBe(1);

    // With the current version (after reloading) the change goes through.
    expect((await hr2.patch(`/employees/${emp.id}`, { jobTitle: 'Staff Nurse' }).set('If-Match', tag(first.body.updatedAt))).status).toBe(200);
  });

  it('two edits sent at the same moment from the same version: exactly one is applied (the row is locked)', async () => {
    const emp = await makeEmployee(db, org.unitA.id);
    const loaded = (await hr.get(`/employees/${emp.id}`)).body.updatedAt as string;
    const results = await Promise.all([
      hr.patch(`/employees/${emp.id}`, { jobTitle: 'From HR one' }).set('If-Match', tag(loaded)),
      hr2.patch(`/employees/${emp.id}`, { jobTitle: 'From HR two' }).set('If-Match', tag(loaded)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!.body.jobTitle;
    expect((await db.employee.findUniqueOrThrow({ where: { id: emp.id } })).jobTitle).toBe(winner);
  });

  it('own phone numbers: a change by HR since loading the profile is not overwritten', async () => {
    const { emp, user } = await makeNurse(db, org.unitA.id, { account: true });
    const self = await signIn(app, user!.email);
    const loaded = (await self.get('/employees/me')).body.updatedAt as string;
    expect((await hr.patch(`/employees/${emp.id}`, { primaryPhone: '+966501111111' })).status).toBe(200);
    const stale = await self.patch('/employees/me/contact', { primaryPhone: '+966502222222' }).set('If-Match', tag(loaded));
    expect(stale.body.error?.code).toBe('STALE_RECORD');
    expect((await db.employee.findUniqueOrThrow({ where: { id: emp.id } })).primaryPhone).toBe('+966501111111');
  });

  it('unit, its beds, department and position: the same rule', async () => {
    const unit = await hr.post('/units', { code: uniq('CC').toUpperCase().slice(0, 20), name: 'Concurrency unit', departmentId: org.dept.id, bedCount: 4 });
    expect(unit.status).toBe(201);
    const v1 = unit.body.updatedAt as string;
    const renamed = await hr.patch(`/units/${unit.body.id}`, { name: 'Renamed by HR one' }).set('If-Match', tag(v1));
    expect(renamed.status).toBe(200);
    expect((await hr2.patch(`/units/${unit.body.id}`, { name: 'Renamed by HR two' }).set('If-Match', tag(v1))).body.error.code).toBe('STALE_RECORD');
    // A bed change also needs the unit as it is now: the rename above changed its version.
    expect((await hr2.put(`/units/${unit.body.id}/bed-capacity`, { bedCount: 6, reason: 'Two beds opened' }).set('If-Match', tag(v1))).body.error.code).toBe('STALE_RECORD');
    expect((await hr2.put(`/units/${unit.body.id}/bed-capacity`, { bedCount: 6, reason: 'Two beds opened' }).set('If-Match', tag(renamed.body.updatedAt))).status).toBe(200);
    const u = await db.unit.findUniqueOrThrow({ where: { id: unit.body.id } });
    expect([u.name, u.bedCount]).toEqual(['Renamed by HR one', 6]);
    expect(await db.bedCapacityLog.count({ where: { unitId: u.id } })).toBe(2); // created with 4, then 4 → 6

    const dept = await hr.post('/departments', { code: uniq('CD').toUpperCase().slice(0, 20), name: 'Concurrency department' });
    expect((await hr.patch(`/departments/${dept.body.id}`, { name: 'First' }).set('If-Match', tag(dept.body.updatedAt))).status).toBe(200);
    expect((await hr2.patch(`/departments/${dept.body.id}`, { name: 'Second' }).set('If-Match', tag(dept.body.updatedAt))).body.error.code).toBe('STALE_RECORD');

    const pos = await hr.post('/positions', { code: uniq('CP').toUpperCase().slice(0, 20), title: 'Concurrency position', tier: 'Clinical', isSchedulable: true });
    expect((await hr.patch(`/positions/${pos.body.code}`, { title: 'First' }).set('If-Match', tag(pos.body.updatedAt))).status).toBe(200);
    expect((await hr2.patch(`/positions/${pos.body.code}`, { title: 'Second' }).set('If-Match', tag(pos.body.updatedAt))).body.error.code).toBe('STALE_RECORD');
    expect((await db.position.findUniqueOrThrow({ where: { code: pos.body.code } })).title).toBe('First');
  });

  it('master lists (rank/grade, specialty, region, city, facility, contract type): the same rule', async () => {
    const code = () => uniq('CM').toUpperCase().slice(0, 20);
    // Each list: create a record, save once from its version, then a second save from the same version is refused.
    const check = async (created: { status: number; body: Record<string, unknown> }, path: string, field: string, read: () => Promise<object>) => {
      expect(created.status).toBe(201);
      const v1 = created.body.updatedAt as string;
      expect(v1).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const first = await hr.patch(path, { [field]: `First ${v1}` }).set('If-Match', tag(v1));
      expect(first.status).toBe(200);
      const second = await hr2.patch(path, { [field]: `Second ${v1}` }).set('If-Match', tag(v1));
      expect(second.status).toBe(409);
      expect(second.body.error).toMatchObject({ code: 'STALE_RECORD', details: { currentVersion: first.body.updatedAt } });
      expect(((await read()) as Record<string, unknown>)[field]).toBe(`First ${v1}`);
      // After reloading (the current version) the change goes through; without a version it is applied as before.
      expect((await hr2.patch(path, { [field]: `Second ${v1}` }).set('If-Match', tag(first.body.updatedAt))).status).toBe(200);
      expect((await hr.patch(path, { isActive: false })).status).toBe(200);
    };

    const rank = await hr.post('/rank-grades', { code: code(), name: 'Concurrency rank' });
    await check(rank, `/rank-grades/${rank.body.code}`, 'name', () => db.rankGrade.findUniqueOrThrow({ where: { code: rank.body.code } }));

    const spec = await hr.post('/nursing-specialties', { code: code(), name: `Concurrency specialty ${uniq('s')}` });
    await check(spec, `/nursing-specialties/${spec.body.code}`, 'name', () => db.nursingSpecialty.findUniqueOrThrow({ where: { code: spec.body.code } }));

    const region = await hr.post('/saudi-regions', { code: `R${Math.random().toString(36).slice(2, 11)}`.toUpperCase(), name: `Concurrency region ${uniq('r')}` });
    const city = await hr.post('/saudi-cities', { regionCode: region.body.code, name: 'Concurrency city' });
    await check(city, `/saudi-cities/${city.body.id}`, 'name', () => db.saudiCity.findUniqueOrThrow({ where: { id: city.body.id } }));
    await check(region, `/saudi-regions/${region.body.code}`, 'name', () => db.saudiRegion.findUniqueOrThrow({ where: { code: region.body.code } }));

    const facility = await hr.post('/facilities', { name: `Concurrency facility ${uniq('f')}` });
    await check(facility, `/facilities/${facility.body.id}`, 'name', () => db.facility.findUniqueOrThrow({ where: { id: facility.body.id } }));

    const type = await hr.post('/contract-types', { code: code(), name: 'Concurrency contract type' });
    await check(type, `/contract-types/${type.body.code}`, 'name', () => db.contractType.findUniqueOrThrow({ where: { code: type.body.code } }));
  });

  it('account: a second edit from the same version is refused; signing in does not change the version', async () => {
    const target = await makeUser(db);
    const row = async () => ((await hr.get('/users')).body.items as Array<{ id: number; updatedAt: string }>).find((u) => u.id === target.id)!;
    const v1 = (await row()).updatedAt;
    expect(v1).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The account's owner signs in while the administrator has the list open: not an edit, so the version stays.
    await signIn(app, target.email);
    expect((await db.user.findUniqueOrThrow({ where: { id: target.id } })).lastLoginAt).not.toBeNull();
    expect((await row()).updatedAt).toBe(v1);

    const first = await hr.patch(`/users/${target.id}`, { displayName: 'Renamed by HR one' }).set('If-Match', tag(v1));
    expect(first.status).toBe(200);
    expect(first.body.updatedAt).not.toBe(v1);
    const second = await hr2.patch(`/users/${target.id}`, { isActive: false }).set('If-Match', tag(v1));
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'STALE_RECORD', details: { currentVersion: first.body.updatedAt } });
    const u = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    expect([u.displayName, u.isActive]).toEqual(['Renamed by HR one', true]);
    expect(await db.auditEntry.count({ where: { resource: 'user', resourceId: String(target.id), action: { in: ['USER_UPDATED', 'USER_DEACTIVATED'] } } })).toBe(1);

    // With the current version the deactivation goes through; without a version an edit is applied as before.
    expect((await hr2.patch(`/users/${target.id}`, { isActive: false }).set('If-Match', tag(first.body.updatedAt))).status).toBe(200);
    expect((await hr.patch(`/users/${target.id}`, { isActive: true })).status).toBe(200);
  });

  it('without If-Match an edit is applied as before; a malformed one is refused', async () => {
    const emp = await makeEmployee(db, org.unitA.id);
    expect((await hr.patch(`/employees/${emp.id}`, { jobTitle: 'No version sent' })).status).toBe(200);
    const bad = await hr.patch(`/employees/${emp.id}`, { jobTitle: 'Bad version' }).set('If-Match', '"yesterday"');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('IF_MATCH_INVALID');
    // A weak tag (W/"…") is read the same way.
    const now = (await hr.get(`/employees/${emp.id}`)).body.updatedAt as string;
    expect((await hr.patch(`/employees/${emp.id}`, { jobTitle: 'Weak tag' }).set('If-Match', `W/${tag(now)}`)).status).toBe(200);
  });
});
