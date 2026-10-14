// Staff import (D-72): check writes nothing; the import is all or nothing, idempotent,
// never overwrites, follows the onboarding rules and the caller's scope, and its
// responses carry no names, e-mails or phones.

import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/prisma.js';
import { makeOrg, makeUser, openDb, signIn, testApp, TEST_URL, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
type Client = Awaited<ReturnType<typeof signIn>>;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const SHA = 'a'.repeat(64);

describeDb('staff import (D-72)', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let hr: Client; // system-wide HR
  let scoped: Client; // HR for unit A only

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    org = await makeOrg(db);
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    scoped = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
  });
  afterAll(async () => { await db.$disconnect(); });

  let n = 0;
  /** One template row, as the browser sends it: codes and names, ISO dates, everything else text or null. */
  const row = (over: Record<string, unknown> = {}) => ({
    rowNumber: 2 + n++, jobNumber: uniq('IMP'), firstName: 'Sara', middleName: null, lastName: 'Example', nationalityCode: 'PHL',
    contactEmail: 'Sara.Example@Example.com', primaryPhone: '+966 50 123 4567', emergencyContactPhone: null,
    unitCode: org.unitA.code, positionCode: null, jobTitle: 'Staff Nurse', rankGradeCode: 'N03', specialtyCode: 'NS003',
    jobPostRegionCode: 'SA-05', jobPostCity: 'Buraydah', facility: 'al iman  general hospital', fileNo: null, maritalStatus: 'Single',
    hireDate: '2026-10-01', contractTypeCode: 'DIRECT_HOSPITAL', contractStart: iso(new Date()), contractEnd: iso(new Date(Date.now() + 364 * 86_400_000)),
    ...over,
  });
  const body = (rows: object[], over: object = {}) => ({ templateVersion: 3, fileSha256: SHA, rows, ...over });
  const commit = (c: Client, b: object, key = randomUUID()) => c.post('/employees/import', b).set('Idempotency-Key', key);
  const statusOf = (res: { body: { rows: Array<{ rowNumber: number; status: string }> } }, r: { rowNumber: number }) => res.body.rows.find((x) => x.rowNumber === r.rowNumber)?.status;
  const codesOf = (res: { body: { rows: Array<{ rowNumber: number; problems: Array<{ code: string }> }> } }, r: { rowNumber: number }) =>
    res.body.rows.find((x) => x.rowNumber === r.rowNumber)?.problems.map((p) => p.code);

  it('check reports every row and writes nothing', async () => {
    const good = row();
    const twin = row({ jobNumber: 'TWIN-' + uniq('') });
    const twin2 = row({ jobNumber: twin.jobNumber.toLowerCase() }); // same job number, other case
    const wrongCity = row({ jobPostCity: 'Jeddah' }); // Jeddah is in SA-02
    const noFacility = row({ facility: 'Unknown Hospital' });
    const badEmail = row({ contactEmail: 'not-an-email' });
    const backwards = row({ contractEnd: '2020-01-01' });
    const missing = row({ lastName: '', rankGradeCode: null });
    const before = await db.employee.count();
    const res = await hr.post('/employees/import/check', body([good, twin, twin2, wrongCity, noFacility, badEmail, backwards, missing]));
    expect(res.status).toBe(200);
    expect(await db.employee.count()).toBe(before);
    expect(res.body.totals).toEqual({ create: 1, unchanged: 0, conflict: 0, rejected: 7 });
    expect(res.body.canImport).toBe(false);
    expect(statusOf(res, good)).toBe('CREATE');
    expect(codesOf(res, twin)).toEqual(['DUPLICATE_IN_FILE']);
    expect(codesOf(res, twin2)).toEqual(['DUPLICATE_IN_FILE']);
    expect(codesOf(res, wrongCity)).toEqual(['CITY_NOT_IN_REGION']);
    expect(codesOf(res, noFacility)).toEqual(['VALUE_NOT_LISTED']);
    expect(res.body.rows.find((x: { rowNumber: number }) => x.rowNumber === badEmail.rowNumber).problems[0]).toMatchObject({ column: 'Contact E-mail', code: 'INVALID_VALUE' });
    expect(codesOf(res, backwards)).toEqual(['CONTRACT_DATES_INVALID']);
    expect(res.body.rows.find((x: { rowNumber: number }) => x.rowNumber === missing.rowNumber).problems.map((p: { column: string }) => p.column).sort()).toEqual(['Last Name', 'Rank/Grade']);
    // No personal data in the report: job numbers and codes only.
    const text = JSON.stringify(res.body);
    for (const secret of ['Sara', 'Example.com', '123 4567', 'not-an-email']) expect(text).not.toContain(secret);
  });

  it('imports every row in one transaction, idempotently, as Draft contracts with audit entries', async () => {
    const rows = [row(), row({ unitCode: null, positionCode: 'SN', middleName: 'Ali', primaryPhone: null })];
    const b = body(rows);
    expect((await hr.post('/employees/import/check', b)).body).toMatchObject({ canImport: true, totals: { create: 2 } });
    expect((await hr.post('/employees/import', b)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = randomUUID();
    const res = await commit(hr, b, key);
    expect(res.status).toBe(201);
    expect(res.body.totals).toMatchObject({ create: 2 });
    expect(res.body.created).toHaveLength(2);
    const replay = await commit(hr, b, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(res.body);

    const emps = await db.employee.findMany({ where: { jobNumber: { in: rows.map((r) => r.jobNumber) } }, include: { contracts: true } });
    expect(emps).toHaveLength(2);
    const first = emps.find((e) => e.jobNumber === rows[0]!.jobNumber)!;
    expect(first).toMatchObject({ fullName: 'Sara Example', contactEmail: 'sara.example@example.com', primaryPhone: '+966501234567', positionCode: 'SN', unitId: org.unitA.id, nationalityCode: 'PHL', salary: null });
    expect(first.contracts.map((c) => c.status)).toEqual(['Draft']);
    expect(emps.find((e) => e.jobNumber === rows[1]!.jobNumber)!.unitId).toBeNull();
    for (const e of emps) expect(await db.auditEntry.count({ where: { action: 'EMPLOYEE_ONBOARDED', resourceId: String(e.id) } })).toBe(1);
    const batch = await db.auditEntry.findMany({ where: { action: 'STAFF_IMPORTED', requestId: res.headers['x-request-id'] } });
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ priority: 'HIGH' });
    expect(batch[0]!.changes).toMatchObject({ templateVersion: 3, fileSha256: SHA, rows: 2, create: 2 });

    // The same file again: nothing new, nothing changed.
    const again = await hr.post('/employees/import/check', body(rows.map((r) => ({ ...r, jobNumber: r.jobNumber.toUpperCase() }))));
    expect(again.body.totals).toEqual({ create: 0, unchanged: 2, conflict: 0, rejected: 0 });
    expect((await commit(hr, b)).body.error.code).toBe('NOTHING_TO_IMPORT');
  });

  it('never overwrites an existing employee: different values are a CONFLICT naming the columns', async () => {
    const r = row();
    await commit(hr, body([r]));
    const changed = { ...r, rowNumber: r.rowNumber + 1000, lastName: 'Changed', jobPostCity: 'Unaizah' };
    const res = await hr.post('/employees/import/check', body([changed]));
    expect(statusOf(res, changed)).toBe('CONFLICT');
    expect(res.body.rows[0].problems[0].message).toContain('Last Name, Job Post City');
    expect(res.body.rows[0].problems[0].message).not.toContain('Changed');
    const out = await commit(hr, body([changed]));
    expect([out.status, out.body.error.code]).toEqual([409, 'STAFF_IMPORT_NOT_CLEAN']);
    expect((await db.employee.findFirstOrThrow({ where: { jobNumber: r.jobNumber } })).lastName).toBe('Example');
  });

  it('is all or nothing: one bad row and nothing is written', async () => {
    const good = row();
    const bad = row({ nationalityCode: 'XXX' });
    const res = await commit(hr, body([good, bad]));
    expect([res.status, res.body.error.code]).toEqual([409, 'STAFF_IMPORT_NOT_CLEAN']);
    expect(res.body.error.details.rows.find((x: { rowNumber: number }) => x.rowNumber === bad.rowNumber).problems[0].code).toBe('NATIONALITY_INVALID');
    expect(await db.employee.count({ where: { jobNumber: good.jobNumber } })).toBe(0);
  });

  it('follows the caller\'s scope and the roles that may onboard', async () => {
    const inA = row();
    const inB = row({ unitCode: org.unitB.code });
    const unassigned = row({ unitCode: null });
    const res = await scoped.post('/employees/import/check', body([inA, inB, unassigned]));
    expect(statusOf(res, inA)).toBe('CREATE');
    expect(codesOf(res, inB)).toEqual(['SCOPE_NOT_COVERED']);
    expect(codesOf(res, unassigned)).toEqual(['SCOPE_NOT_COVERED']);
    for (const role of ['SUPERVISOR', 'NURSING_ADMIN', 'NURSING_DIRECTOR'] as const) {
      const other = await signIn(app, (await makeUser(db, { roles: [{ role, scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      expect((await other.post('/employees/import/check', body([row()]))).status).toBe(403);
      expect((await commit(other, body([row()]))).status).toBe(403);
      expect((await other.get('/employees/import/lists')).status).toBe(403);
    }
  });

  it('refuses a request that is not template version 3 or has more than 1,000 rows', async () => {
    expect((await hr.post('/employees/import/check', body([row()], { templateVersion: 2 }))).status).toBe(400);
    expect((await hr.post('/employees/import/check', body([{ ...row(), salary: '100' }]))).status).toBe(400);
    expect((await hr.post('/employees/import/check', body(Array.from({ length: 1001 }, () => row())))).status).toBe(400);
  });

  it('lists the live values for the downloadable template, units within scope', async () => {
    const all = (await hr.get('/employees/import/lists')).body;
    expect(all).toMatchObject({ templateVersion: 3, maxRows: 1000, unassignedAllowed: true });
    expect(all.citiesByRegion['SA-05']).toContain('Buraydah');
    expect(all.facilities).toContain('Al Iman General Hospital');
    expect(all.contractTypes.map((t: { code: string }) => t.code)).toContain('DIRECT_HOSPITAL');
    const mine = (await scoped.get('/employees/import/lists')).body;
    expect(mine.unassignedAllowed).toBe(false);
    expect(mine.units.map((u: { code: string }) => u.code)).toEqual([org.unitA.code]);
  });

  it('imports 1,000 rows in one transaction', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row({ rowNumber: 2 + i }));
    const started = Date.now();
    const res = await commit(hr, body(rows));
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1000);
    console.log(`staff import: 1,000 rows in ${Date.now() - started} ms`);
    // Leave the test database as other suites expect it: the nightly jobs walk every employee that is not deleted.
    await db.employee.updateMany({ where: { id: { in: res.body.created.map((c: { employeeId: number }) => c.employeeId) } }, data: { deletedAt: new Date() } });
  }, 180_000);
});
