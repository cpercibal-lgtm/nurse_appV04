// End-to-end business scenarios (Phase 15 "business scenarios"; plan commit 10):
// nurse creation, credential management, eligibility, missing credential,
// training requirement, staffing target, assignment and roster, expired
// licence, attendance gap, coverage, break-glass and the audit trail — one
// story through the HTTP API, with the scheduled jobs standing in for the
// passage of days. Steps run in order and share state.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { findChainBreaks } from '../src/lib/audit.js';
import { addDays, riyadhDate, toDbDate } from '../src/lib/dates.js';
import type { Db } from '../src/lib/prisma.js';
import { attendanceAlerts } from '../src/jobs/attendance-alerts.js';
import { dailyTransition } from '../src/jobs/daily-transition.js';
import { FILES, makeOrg, makeTemplate, makeUser, openDb, signIn, TEST_URL, testApp, uniq, jobPost } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const today = () => riyadhDate();
const tomorrow = () => addDays(today(), 1);
type Client = Awaited<ReturnType<typeof signIn>>;
const idem = <T extends { set: (k: string, v: string) => T }>(req: T) => req.set('Idempotency-Key', randomUUID());
const licence = (issue: string, expiry: string) => ({ trackingData: { licence_number: 'SCFHS-1', issue_date: issue, expiry_date: expiry } });

describeDb('business scenarios, end to end', () => {
  let db: Db;
  let app: Express;
  let hr: Client; let hr2: Client; let sup: Client; let dir: Client; let nurseA: Client;
  let supId: number;
  let unitId: number;
  const ids = { a: 0, b: 0, lic: 0, train: 0, aLicence: 0, aTomorrow: 0, bTomorrow: 0, bToday: 0 };

  const state = async (employeeId: number) => db.eligibilityState.findUniqueOrThrow({ where: { employeeId } });
  const codes = async (employeeId: number) => ((await state(employeeId)).reasons as Array<{ code: string }>).map((r) => r.code);
  /** D-71: the supervisor asks, the Nursing Director approves the day, and only then can it be published. */
  const approveDay = async (date: string) => {
    const asked = await sup.post('/roster/approvals', { unitId, from: date, to: date });
    expect(asked.status).toBe(201);
    expect((await dir.post(`/roster/approvals/${asked.body.id}/decision`, { decision: 'approve' })).body.status).toBe('Approved');
  };
  const coverage = async (date: string) => (await sup.get(`/coverage?unitId=${unitId}&from=${date}&to=${date}`)).body.coverage.find((c: { shiftType: string }) => c.shiftType === 'Morning');

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    const org = await makeOrg(db);
    unitId = (await db.unit.create({ data: { code: uniq('SC').toUpperCase().slice(0, 20), name: 'Scenario ward', departmentId: org.dept.id, bedCount: 20 } })).id;
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    hr2 = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    const supUser = await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [unitId] }] });
    supId = supUser.id;
    sup = await signIn(app, supUser.email);
    dir = await signIn(app, (await makeUser(db, { roles: [{ role: 'NURSING_DIRECTOR', scopeType: 'UNIT', scopeIds: [unitId] }] })).email);
  });
  afterAll(async () => { await db.$disconnect(); });

  it('1. nurse creation: onboarding, contract copy, submit, approval by a second HR person', async () => {
    for (const key of ['a', 'b'] as const) {
      const res = await idem(hr.post('/employees/onboard', {
        jobNumber: uniq('SCN'), firstName: key === 'a' ? 'Amal' : 'Basma', lastName: 'Nurse', contactEmail: `${key}@example.sa`,
        unitId, contractStart: addDays(today(), -10), contractEnd: addDays(today(), 355), contractTypeCode: 'DIRECT_HOSPITAL', nationalityCode: 'SAU', rankGradeCode: 'N03', specialtyCode: 'NS002', ...(await jobPost(db)),
      }));
      expect(res.status).toBe(201);
      ids[key] = res.body.employeeId;
      expect(await codes(ids[key])).toContain('NO_CONTRACT_COVERAGE');
      const contract = res.body.contractId;
      await hr.upload(`/contracts/${contract}/documents`, FILES.pdf, 'application/pdf', 'contract.pdf');
      await hr.post(`/contracts/${contract}/transition`, { action: 'submit' });
      expect((await hr.post(`/contracts/${contract}/transition`, { action: 'approve' })).body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
      expect((await hr2.post(`/contracts/${contract}/transition`, { action: 'approve' })).body).toMatchObject({ status: 'Active', eligibility: 'ELIGIBLE' });
    }
    expect(await codes(ids.a)).toEqual(['NO_REQUIREMENTS_CONFIGURED']); // D-4
    nurseA = await signIn(app, (await makeUser(db, { employeeId: ids.a })).email);
  });

  it('2. credential management: a mandatory licence blocks both; the nurse submits hers and HR verifies it', async () => {
    ids.lic = (await makeTemplate(db)).id;
    expect((await hr.post('/credential-requirements', { templateId: ids.lic, unitId })).body.affectedEmployees).toBe(2);
    expect((await state(ids.a)).status).toBe('INELIGIBLE');
    expect(await codes(ids.b)).toContain('CREDENTIAL_MISSING');

    const own = await nurseA.post('/credentials/me', { templateId: ids.lic, ...licence(addDays(today(), -100), addDays(today(), 265)) });
    expect(own.status).toBe(201);
    ids.aLicence = own.body.id;
    expect((await nurseA.upload(`/credentials/${ids.aLicence}/documents`, FILES.pdf, 'application/pdf', 'licence.pdf')).status).toBe(201);
    expect((await nurseA.post(`/credentials/${ids.aLicence}/verify`)).status).toBe(403); // nobody reviews their own (D-26)
    expect((await hr.post(`/credentials/${ids.aLicence}/verify`)).status).toBe(200);
    expect((await state(ids.a)).status).toBe('ELIGIBLE');
  });

  it('3. training requirement: a TRANSITION rule warns until its deadline, then blocks', async () => {
    ids.train = (await makeTemplate(db, { hasExpiry: false })).id;
    const rule = await hr.post('/credential-requirements', { templateId: ids.train, unitId, policyStatus: 'TRANSITION', transitionDeadline: addDays(today(), 30) });
    expect((await state(ids.a)).status).toBe('ELIGIBLE_WITH_POLICY_WARNING');
    await dailyTransition(db);
    const notice = await db.notification.findFirst({ where: { employeeId: ids.a, eventKey: { startsWith: 'policy-warning:' } } });
    expect(notice?.message).toContain('will become mandatory');

    await hr.put(`/credential-requirements/${rule.body.id}`, { policyStatus: 'TRANSITION', transitionDeadline: addDays(today(), -1) });
    expect((await state(ids.a)).status).toBe('INELIGIBLE');
    // The requirement is met again once the training record is verified.
    const rec = await hr.post('/credentials', { employeeId: ids.a, templateId: ids.train, trackingData: { licence_number: 'BLS-7', issue_date: addDays(today(), -5), expiry_date: addDays(today(), 700) } });
    await hr.upload(`/credentials/${rec.body.id}/documents`, FILES.pdf, 'application/pdf');
    await hr2.post(`/credentials/${rec.body.id}/verify`);
    expect((await state(ids.a)).status).toBe('ELIGIBLE');
    await hr.del(`/credential-requirements/${rule.body.id}`); // keep nurse B's story about the licence only
  });

  it('4–5. staffing target and roster: publish re-validates, the nurse without a licence stays in draft', async () => {
    expect((await hr.put('/coverage-targets', { unitId, shiftType: 'Morning', minimumStaff: 2 })).body.minimumStaff).toBe(2);
    ids.aTomorrow = (await sup.post('/shift-assignments', { employeeId: ids.a, unitId, shiftDate: tomorrow(), shiftType: 'Morning' })).body.id;
    const bDraft = await sup.post('/shift-assignments', { employeeId: ids.b, unitId, shiftDate: tomorrow(), shiftType: 'Morning' });
    ids.bTomorrow = bDraft.body.id;
    expect(bDraft.body.eligibility.status).toBe('INELIGIBLE');
    await approveDay(tomorrow());
    const pub = await idem(sup.post('/roster/publish', { unitId, from: tomorrow(), to: tomorrow() }));
    expect(pub.body.published).toBe(1);
    expect(pub.body.blocked[0].reasons.map((r: { code: string }) => r.code)).toContain('CREDENTIAL_MISSING');
    expect(await coverage(tomorrow())).toMatchObject({ target: 2, published: { total: 1, eligible: 1 }, publishedShortage: 1 });
  });

  it('6. missing credential: a supervisor waiver for that credential only lets the shift publish, and it is recorded', async () => {
    const w = await sup.post('/waivers', { employeeId: ids.b, templateId: ids.lic, reason: 'Licence renewal confirmed by the council by phone', expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() });
    expect(w.body.eligibility).toBe('ELIGIBLE');
    const pub = await idem(sup.post('/roster/publish', { unitId, from: tomorrow(), to: tomorrow() }));
    expect(pub.body.published).toBe(1);
    expect(pub.body.reliedOnGraceOrWaiver.map((r: { id: number }) => r.id)).toEqual([ids.bTomorrow]);
    expect((await coverage(tomorrow())).publishedShortage).toBe(0);
  });

  it('7. expired licence: overnight the licence lapses, the nurse becomes ineligible and her published shift returns to draft', async () => {
    // A day passes: the licence's expiry is now in the past.
    await db.credential.update({ where: { id: ids.aLicence }, data: { expiryDate: toDbDate(addDays(today(), -1)) } });
    await dailyTransition(db);
    expect((await db.credential.findUniqueOrThrow({ where: { id: ids.aLicence } })).status).toBe('Expired');
    expect(await codes(ids.a)).toContain('CREDENTIAL_EXPIRED');
    expect((await db.shiftAssignment.findUniqueOrThrow({ where: { id: ids.aTomorrow } })).status).toBe('Draft');
    expect(await db.notification.count({ where: { recipientId: supId, employeeId: ids.a, type: 'COVERAGE' } })).toBe(1);
    expect((await coverage(tomorrow())).publishedShortage).toBe(1); // coverage reflects it at once
  });

  it('8. attendance gap: a published nurse who has not clocked in 30 minutes after the start raises one critical alert', async () => {
    ids.bToday = (await sup.post('/shift-assignments', { employeeId: ids.b, unitId, shiftDate: today(), shiftType: 'Morning' })).body.id;
    await approveDay(today());
    const pub = await idem(sup.post('/roster/publish', { unitId, from: today(), to: today() }));
    expect(pub.body.published).toBe(1);
    await attendanceAlerts(db, new Date(`${today()}T07:45:00+03:00`));
    const alert = await db.notification.findFirstOrThrow({ where: { recipientId: supId, employeeId: ids.b, eventKey: `gap-missing:${ids.bToday}` } });
    expect(alert.priority).toBe('CRITICAL');
    const gaps = await sup.get(`/attendance/gaps?unitId=${unitId}&date=${today()}`);
    expect(gaps.body.items.map((g: { assignmentId: number }) => g.assignmentId)).toContain(ids.bToday);
  });

  it('9. break-glass: the siren sounds, four-eyes is bypassed, and clinical waivers stay out of reach', async () => {
    const sa = await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
    const bgUser = await makeUser(db, { isBreakGlass: true });
    const bg = await signIn(app, bgUser.email);
    const event = await db.breakGlassEvent.findFirstOrThrow({ where: { actorUserId: bgUser.id } });
    expect(await db.notification.count({ where: { recipientId: sa.id, eventKey: `break-glass:${event.id}`, priority: 'CRITICAL' } })).toBe(1);
    const tpl = await bg.post('/credential-templates', { code: `BG_${Date.now().toString(36).toUpperCase()}`, name: 'Emergency type', categoryCode: 'LICENSURE', reason: 'Break-glass emergency configuration' });
    expect(tpl.body.status).toBe('APPLIED'); // D-24: break-glass bypasses four-eyes (spec §3.6)
    expect((await bg.post('/waivers', { employeeId: ids.a, templateId: ids.lic, reason: 'Emergency', expiresAt: new Date(Date.now() + 3600_000).toISOString() })).status).toBe(403); // D-28
  });

  it('10. audit trail: every step above left its record, and the hash chain is intact', async () => {
    const actions = new Set((await db.auditEntry.findMany({
      where: { OR: [{ resourceId: { in: [String(ids.a), String(ids.b), String(ids.aLicence), String(ids.aTomorrow), String(ids.bTomorrow), String(unitId)] } }, { changes: { path: ['employeeId'], equals: ids.a } }] },
      select: { action: true },
    })).map((e) => e.action));
    for (const a of ['EMPLOYEE_ONBOARDED', 'CONTRACT_APPROVE', 'CREDENTIAL_RECORDED', 'CREDENTIAL_VERIFIED', 'ELIGIBILITY_CHANGED', 'ASSIGNMENT_DRAFTED', 'ROSTER_PUBLISHED', 'CREDENTIAL_STATUS_CHANGED', 'ASSIGNMENT_DEMOTED', 'COVERAGE_TARGET_SET']) {
      expect(actions, a).toContain(a);
    }
    expect(await db.auditEntry.count({ where: { action: 'WAIVER_GRANTED', priority: 'HIGH', changes: { path: ['employeeId'], equals: ids.b } } })).toBe(1);
    expect(await findChainBreaks(db)).toEqual([]);
  });
});
