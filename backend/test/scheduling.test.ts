// Rosters and attendance through the HTTP API against PostgreSQL: rules S1–S6,
// L7, L8, spec §6.2 revalidation, §14.2 gaps; decisions D-14, D-31–D-33.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { addDays, riyadhDate, toDbDate } from '../src/lib/dates.js';
import type { Db } from '../src/lib/prisma.js';
import { makeEmployee, makeNurse, makeOrg, makeTemplate, makeUser, openDb, signIn, TEST_URL, testApp } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const today = () => riyadhDate();
const tomorrow = () => addDays(today(), 1);
type Client = Awaited<ReturnType<typeof signIn>>;

describeDb('scheduling and attendance', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let sup: Client; // supervises unit A
  let hr: Client; // system-wide HR: read only for rosters (D-14)
  let dir: Client; // Nursing Director of unit A: approves rosters (D-71)
  let na: Client; // Nursing Admin of unit A: prepares and publishes (D-71)

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    org = await makeOrg(db);
    sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    dir = await signIn(app, (await makeUser(db, { roles: [{ role: 'NURSING_DIRECTOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
    na = await signIn(app, (await makeUser(db, { roles: [{ role: 'NURSING_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
  });
  afterAll(async () => { await db.$disconnect(); });

  const draft = (c: Client, employeeId: number, shiftDate = tomorrow(), shiftType = 'Morning', unitId = org.unitA.id) =>
    c.post('/shift-assignments', { employeeId, unitId, shiftDate, shiftType });
  const publish = (c: Client, from = tomorrow(), to = tomorrow()) =>
    c.post('/roster/publish', { unitId: org.unitA.id, from, to }).set('Idempotency-Key', randomUUID());
  const requestApproval = (c: Client, from = tomorrow(), to = tomorrow(), unitId = org.unitA.id) => c.post('/roster/approvals', { unitId, from, to });
  const decide = (c: Client, id: number, body: Record<string, unknown>) => c.post(`/roster/approvals/${id}/decision`, body);
  /** The Nursing Director's approval of the drafts in a window (D-71): the supervisor asks, the director approves. */
  const approve = async (from = tomorrow(), to = tomorrow()) => {
    const asked = await requestApproval(sup, from, to);
    expect(asked.status).toBe(201);
    expect((await decide(dir, asked.body.id, { decision: 'approve' })).body.status).toBe('Approved');
  };

  describe('drafting (S1, D-14, D-32)', () => {
    it('only the unit supervisor drafts, only for home-unit nurses, never twice in one slot, never in the past', async () => {
      const { emp } = await makeNurse(db, org.unitA.id);
      const other = await makeNurse(db, org.unitC.id);
      expect((await draft(hr, emp.id)).status).toBe(403);
      expect((await draft(sup, other.emp.id)).body.error.code).toBe('NOT_HOME_UNIT');
      expect((await draft(sup, emp.id, addDays(today(), -1))).body.error.code).toBe('SHIFT_IN_PAST');
      const ok = await draft(sup, emp.id);
      expect(ok.status).toBe(201);
      expect(ok.body.eligibility.status).toBe('ELIGIBLE');
      expect((await draft(sup, emp.id)).body.error.code).toBe('SHIFT_SLOT_TAKEN');
      expect((await draft(sup, other.emp.id, tomorrow(), 'Morning', org.unitC.id)).body.error.code).toBe('SCOPE_NOT_COVERED');
      const board = await hr.get(`/roster?unitId=${org.unitA.id}&from=${tomorrow()}&to=${tomorrow()}`);
      expect(board.body.assignments.some((a: { id: number }) => a.id === ok.body.id)).toBe(true);
      expect((await hr.get(`/roster?unitId=${org.unitA.id}&from=${today()}&to=${addDays(today(), 94)}`)).body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('publication (L7, S3, L8)', () => {
    it('re-validates every draft: ineligible stays draft with reasons; a waiver is recorded, never silent', async () => {
      const ok = (await makeNurse(db, org.unitA.id)).emp;
      const noContract = await makeEmployee(db, org.unitA.id);
      const waived = (await makeNurse(db, org.unitA.id)).emp;
      const date = addDays(today(), 2);
      const tpl = await makeTemplate(db);
      // A position-specific rule for a fresh position keeps other tests' nurses unaffected.
      const pos = `W${Date.now().toString(36).toUpperCase()}`.slice(0, 20);
      await db.position.create({ data: { code: pos, title: 'Waiver test', tier: 'Clinical', isSchedulable: true } });
      await db.employee.update({ where: { id: waived.id }, data: { positionCode: pos } });
      await db.credentialRequirement.create({ data: { templateId: tpl.id, unitId: org.unitA.id, positionCode: pos, policyStatus: 'MANDATORY' } });
      const waiverBy = await makeUser(db);
      await db.credentialWaiver.create({ data: { employeeId: waived.id, templateId: tpl.id, waivedById: waiverBy.id, reason: 'Emergency cover', expiresAt: new Date(Date.now() + 71 * 3600_000) } });

      const ids = [];
      for (const e of [ok, noContract, waived]) ids.push((await draft(sup, e.id, date)).body.id as number);
      expect((await sup.post('/roster/publish', { unitId: org.unitA.id, from: date, to: date })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await publish(hr, date, date)).status).toBe(403);
      await approve(date, date);
      const res = await publish(sup, date, date);
      expect(res.body.published).toBe(2);
      expect(res.body.blocked).toHaveLength(1);
      expect(res.body.blocked[0]).toMatchObject({ id: ids[1] });
      expect(res.body.blocked[0].reasons.map((r: { code: string }) => r.code)).toContain('NO_CONTRACT_COVERAGE');
      expect(res.body.reliedOnGraceOrWaiver.map((r: { id: number }) => r.id)).toEqual([ids[2]]);
      expect((await db.shiftAssignment.findUniqueOrThrow({ where: { id: ids[1] } })).status).toBe('Draft');
      expect((await db.shiftAssignment.findUniqueOrThrow({ where: { id: ids[2] } })).eligibilityAtPublish).toBe('ELIGIBLE');
      expect(await db.auditEntry.count({ where: { action: 'ROSTER_PUBLISHED', resourceId: String(org.unitA.id), priority: 'HIGH' } })).toBeGreaterThan(0);
    });

    it('a published shift that stops passing the engine goes back to draft and the supervisor is told (§6.2)', async () => {
      const { emp } = await makeNurse(db, org.unitA.id);
      const supUser = await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] });
      const date = addDays(today(), 3);
      const id = (await draft(sup, emp.id, date)).body.id;
      await approve(date, date);
      await publish(sup, date, date);
      expect((await db.shiftAssignment.findUniqueOrThrow({ where: { id } })).status).toBe('Published');

      const contract = await db.contract.findFirstOrThrow({ where: { employeeId: emp.id } });
      expect((await hr.post(`/contracts/${contract.id}/transition`, { action: 'suspend', reason: 'Investigation pending' })).body.status).toBe('Suspended');
      const after = await db.shiftAssignment.findUniqueOrThrow({ where: { id } });
      expect(after).toMatchObject({ status: 'Draft', publishedAt: null });
      expect(await db.auditEntry.count({ where: { action: 'ASSIGNMENT_DEMOTED', resourceId: String(id) } })).toBe(1);
      expect(await db.notification.count({ where: { recipientId: supUser.id, type: 'COVERAGE', employeeId: emp.id } })).toBe(1);

      // A move to another unit demotes too (D-32).
      await hr.post(`/contracts/${contract.id}/transition`, { action: 'reinstate', reason: 'Investigation closed' });
      await publish(sup, date, date);
      expect((await db.shiftAssignment.findUniqueOrThrow({ where: { id } })).status).toBe('Published');
      await hr.patch(`/employees/${emp.id}`, { unitId: org.unitB.id });
      expect((await db.shiftAssignment.findUniqueOrThrow({ where: { id } })).status).toBe('Draft');
    });

    it('cancelling a published shift needs a reason; a draft is simply removed', async () => {
      const { emp } = await makeNurse(db, org.unitA.id);
      const date = addDays(today(), 4);
      const id = (await draft(sup, emp.id, date)).body.id;
      await approve(date, date);
      await publish(sup, date, date);
      expect((await sup.del(`/shift-assignments/${id}`)).body.error.code).toBe('VALIDATION_FAILED');
      expect((await sup.del(`/shift-assignments/${id}`).send({ reason: 'Nurse on leave' })).body.status).toBe('Cancelled');
      const d2 = (await draft(sup, emp.id, date, 'Evening')).body.id;
      expect((await sup.del(`/shift-assignments/${d2}`)).body.status).toBe('Deleted');
    });
  });

  describe('roster approval chain (D-71, hospital reply C6)', () => {
    it('a roster cannot be published until the Nursing Director approves; the Nursing Admin prepares and publishes', async () => {
      const { emp } = await makeNurse(db, org.unitA.id);
      const date = addDays(today(), 20);
      const id = (await draft(na, emp.id, date)).body.id;
      expect(id).toBeGreaterThan(0);
      // Nobody publishes an unapproved roster.
      expect((await publish(na, date, date)).body.error.code).toBe('APPROVAL_REQUIRED');
      expect((await publish(sup, date, date)).body.error.code).toBe('APPROVAL_REQUIRED');
      // The Director neither drafts nor publishes; HR neither asks nor decides.
      expect((await draft(dir, emp.id, addDays(today(), 21))).status).toBe(403);
      expect((await publish(dir, date, date)).status).toBe(403);
      expect((await requestApproval(hr, date, date)).status).toBe(403);

      const asked = await requestApproval(na, date, date);
      expect(asked.status).toBe(201);
      expect(asked.body).toMatchObject({ status: 'Pending', drafts: 1 });
      expect((await requestApproval(sup, date, date)).body.error.code).toBe('APPROVAL_EXISTS');
      expect((await decide(na, asked.body.id, { decision: 'approve' })).status).toBe(403); // the preparer cannot approve
      expect((await publish(na, date, date)).body.error.code).toBe('APPROVAL_REQUIRED'); // still pending

      expect((await decide(dir, asked.body.id, { decision: 'approve' })).body.status).toBe('Approved');
      expect((await decide(dir, asked.body.id, { decision: 'approve' })).body.error.code).toBe('NOT_PENDING');
      const res = await publish(na, date, date);
      expect(res.body.published).toBe(1);
      expect((await db.shiftAssignment.findUniqueOrThrow({ where: { id } })).status).toBe('Published');
      expect(await db.auditEntry.count({ where: { action: 'ROSTER_APPROVED', resourceId: String(org.unitA.id), priority: 'HIGH' } })).toBeGreaterThan(0);

      const list = await hr.get('/roster/approvals').query({ unitId: org.unitA.id, status: 'Approved' });
      expect(list.body.items.find((a: { id: number }) => a.id === asked.body.id)).toMatchObject({ from: date, to: date, requestedBy: { name: 'Test User' }, decidedBy: { name: 'Test User' } });
    });

    it('there must be drafts to approve; a rejection needs a reason, blocks publishing and can be asked again', async () => {
      const { emp } = await makeNurse(db, org.unitA.id);
      const date = addDays(today(), 22);
      expect((await requestApproval(sup, date, date)).body.error.code).toBe('NOTHING_TO_APPROVE');
      await draft(sup, emp.id, date);
      const asked = await requestApproval(sup, date, date);
      expect((await decide(dir, asked.body.id, { decision: 'reject' })).status).toBe(400);
      expect((await decide(dir, asked.body.id, { decision: 'reject', note: 'Night cover is too thin' })).body.status).toBe('Rejected');
      expect((await publish(sup, date, date)).body.error.code).toBe('APPROVAL_REQUIRED');
      const again = await requestApproval(sup, date, date);
      expect(again.status).toBe(201);
      expect((await decide(dir, again.body.id, { decision: 'approve' })).body.status).toBe('Approved');
      expect((await publish(sup, date, date)).body.published).toBe(1);
    });

    it('a director never decides their own request', async () => {
      const { emp } = await makeNurse(db, org.unitA.id);
      const date = addDays(today(), 23);
      const both = await signIn(app, (await makeUser(db, { roles: [
        { role: 'NURSING_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }, { role: 'NURSING_DIRECTOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] },
      ] })).email);
      await draft(both, emp.id, date);
      const asked = await requestApproval(both, date, date);
      expect((await decide(both, asked.body.id, { decision: 'approve' })).body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
      expect((await decide(dir, asked.body.id, { decision: 'approve' })).body.status).toBe('Approved');
    });

    it('changing the drafts withdraws the approval; it must cover every date published', async () => {
      const first = (await makeNurse(db, org.unitA.id)).emp;
      const second = (await makeNurse(db, org.unitA.id)).emp;
      const date = addDays(today(), 24);
      await draft(sup, first.id, date);
      await approve(date, date);
      // A new draft in the approved window withdraws the approval.
      const extra = (await draft(sup, second.id, date)).body.id;
      expect((await publish(sup, date, date)).body.error.code).toBe('APPROVAL_REQUIRED');
      expect(await db.auditEntry.count({ where: { action: 'ROSTER_APPROVAL_WITHDRAWN', resourceId: String(org.unitA.id) } })).toBeGreaterThan(0);
      // So does removing one.
      await approve(date, date);
      expect((await sup.del(`/shift-assignments/${extra}`)).body.status).toBe('Deleted');
      expect((await publish(sup, date, date)).body.error.code).toBe('APPROVAL_REQUIRED');
      // An approval for one day does not cover two.
      const next = addDays(date, 1);
      await draft(sup, first.id, next);
      await approve(date, date);
      expect((await publish(sup, date, next)).body.error.code).toBe('APPROVAL_REQUIRED');
    });

    it('keeps to the unit: a director or admin of another unit can neither decide nor ask', async () => {
      const { emp } = await makeNurse(db, org.unitA.id);
      const date = addDays(today(), 26);
      await draft(sup, emp.id, date);
      const asked = await requestApproval(sup, date, date);
      const otherDir = await signIn(app, (await makeUser(db, { roles: [{ role: 'NURSING_DIRECTOR', scopeType: 'UNIT', scopeIds: [org.unitC.id] }] })).email);
      const otherNa = await signIn(app, (await makeUser(db, { roles: [{ role: 'NURSING_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitC.id] }] })).email);
      expect((await decide(otherDir, asked.body.id, { decision: 'approve' })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await requestApproval(otherNa, date, date)).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await otherNa.get('/roster/approvals').query({ unitId: org.unitA.id })).status).toBe(403);
    });

    it('the database refuses a decision by the requester, a decision without a decider and a rejection without a reason', async () => {
      const u = await makeUser(db);
      const other = await makeUser(db);
      const base = { unitId: org.unitA.id, fromDate: toDbDate(addDays(today(), 30)), toDate: toDbDate(addDays(today(), 30)), requestedById: u.id };
      await expect(db.rosterApproval.create({ data: { ...base, status: 'Approved', decidedById: u.id, decidedAt: new Date() } })).rejects.toThrow();
      await expect(db.rosterApproval.create({ data: { ...base, status: 'Approved' } })).rejects.toThrow();
      await expect(db.rosterApproval.create({ data: { ...base, status: 'Rejected', decidedById: other.id, decidedAt: new Date() } })).rejects.toThrow();
      await expect(db.rosterApproval.create({ data: { ...base, status: 'Approved', decidedById: other.id, decidedAt: new Date() } })).resolves.toBeTruthy();
    });
  });

  describe('coverage and auto-fill (S4, S5, W8, D-16)', () => {
    it('reports unspecified targets, fills to the target from eligible home-unit nurses, one auto shift per nurse per day', async () => {
      const unit = await db.unit.create({ data: { code: `AF${Date.now().toString(36).toUpperCase()}`.slice(0, 20), name: 'Auto-fill unit', departmentId: org.dept.id } });
      const s2 = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [unit.id] }] })).email);
      const nurses = [(await makeNurse(db, unit.id)).emp, (await makeNurse(db, unit.id)).emp];
      await makeEmployee(db, unit.id); // no contract → never proposed
      await db.coverageTarget.create({ data: { unitId: unit.id, shiftType: 'Morning', minimumStaff: 2 } });
      await db.coverageTarget.create({ data: { unitId: unit.id, shiftType: 'Night', minimumStaff: 1 } });
      const date = addDays(today(), 5);

      const dry = await s2.post('/roster/auto-generate', { unitId: unit.id, from: date, to: date });
      expect(dry.body.dryRun).toBe(true);
      expect(dry.body.targetsMissing).toEqual(['Evening']);
      expect(dry.body.proposed.filter((p: { shiftType: string }) => p.shiftType === 'Morning')).toHaveLength(2);
      // Both nurses already have a Morning shift that day, so Night stays unfilled.
      expect(dry.body.unfilled).toEqual([{ date, shiftType: 'Night', target: 1, have: 0 }]);
      expect(new Set(dry.body.proposed.map((p: { employeeId: number }) => p.employeeId))).toEqual(new Set(nurses.map((n) => n.id)));
      expect(await db.shiftAssignment.count({ where: { unitId: unit.id } })).toBe(0);

      await s2.post('/roster/auto-generate', { unitId: unit.id, from: date, to: date, dryRun: false });
      expect(await db.shiftAssignment.count({ where: { unitId: unit.id, status: 'Draft' } })).toBe(2);
      const cov = await s2.get(`/coverage?unitId=${unit.id}&from=${date}&to=${date}`);
      const morning = cov.body.coverage.find((c: { shiftType: string }) => c.shiftType === 'Morning');
      expect(morning).toMatchObject({ target: 2, draft: { total: 2, eligible: 2 }, published: { total: 0, eligible: 0 }, publishedShortage: 2 });
      expect(cov.body.coverage.find((c: { shiftType: string }) => c.shiftType === 'Evening').target).toBeNull();
    });
  });

  describe('employee view (S2)', () => {
    it('shows own and home-unit published shifts only', async () => {
      const { emp, user } = await makeNurse(db, org.unitA.id, { account: true });
      const colleague = (await makeNurse(db, org.unitA.id)).emp;
      const date = addDays(today(), 6);
      const mine = (await draft(sup, emp.id, date)).body.id;
      const theirs = (await draft(sup, colleague.id, date)).body.id;
      const unpublished = (await draft(sup, colleague.id, date, 'Night')).body.id;
      await db.shiftAssignment.updateMany({ where: { id: { in: [mine, theirs] } }, data: { status: 'Published' } });
      const me = await signIn(app, user!.email);
      const view = await me.get(`/roster/me?from=${date}&to=${date}`);
      expect(view.body.own.map((a: { id: number }) => a.id)).toEqual([mine]);
      const home = view.body.homeUnit.map((a: { id: number }) => a.id);
      expect(home).toEqual(expect.arrayContaining([mine, theirs]));
      expect(home).not.toContain(unpublished);
      expect((await me.get(`/roster?unitId=${org.unitA.id}&from=${date}&to=${date}`)).status).toBe(403);
    });
  });

  describe('attendance gaps (§14.2, D-31, D-33)', () => {
    it('classifies published shifts against clock-ins from 30 minutes before the start (D-38)', async () => {
      const unit = await db.unit.create({ data: { code: `AT${Date.now().toString(36).toUpperCase()}`.slice(0, 20), name: 'Attendance unit', departmentId: org.dept.id } });
      const s3 = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [unit.id] }] })).email);
      const [present, missing, early, tooEarly] = [(await makeNurse(db, unit.id)).emp, (await makeNurse(db, unit.id)).emp, (await makeNurse(db, unit.id)).emp, (await makeNurse(db, unit.id)).emp];
      const yesterday = addDays(today(), -1);
      for (const e of [present, missing, early, tooEarly]) {
        await db.shiftAssignment.create({ data: { employeeId: e.id, unitId: unit.id, shiftDate: toDbDate(yesterday), shiftType: 'Morning', status: 'Published' } });
      }
      const at = (time: string) => new Date(`${yesterday}T${time}:00+03:00`);
      await db.attendanceEvent.create({ data: { employeeId: present.id, eventType: 'CLOCK_IN', eventTimestamp: at('07:05') } });
      await db.attendanceEvent.create({ data: { employeeId: early.id, eventType: 'CLOCK_IN', eventTimestamp: at('06:30') } }); // exactly at the edge
      await db.attendanceEvent.create({ data: { employeeId: tooEarly.id, eventType: 'CLOCK_IN', eventTimestamp: at('06:29') } });

      const gaps = await s3.get(`/attendance/gaps?unitId=${unit.id}&date=${yesterday}`);
      const status = (id: number) => gaps.body.items.find((i: { employeeId: number }) => i.employeeId === id).status;
      expect(status(present.id)).toBe('PRESENT');
      expect(status(missing.id)).toBe('MISSING');
      expect(status(early.id)).toBe('PRESENT');
      expect(status(tooEarly.id)).toBe('MISSING');
      expect(gaps.body).toMatchObject({ gapMinutes: 30, earlyClockInMinutes: 30 });

      await db.shiftAssignment.create({ data: { employeeId: missing.id, unitId: unit.id, shiftDate: toDbDate(addDays(today(), 1)), shiftType: 'Night', status: 'Published' } });
      const upcoming = await s3.get(`/attendance/gaps?unitId=${unit.id}&date=${addDays(today(), 1)}`);
      expect(upcoming.body.items[0]).toMatchObject({ status: 'UPCOMING', shiftType: 'Night' });
      expect(new Date(upcoming.body.items[0].shiftEnd).getTime() - new Date(upcoming.body.items[0].shiftStart).getTime()).toBe(8 * 3600_000);

      const events = await s3.get(`/attendance/events?unitId=${unit.id}&from=${yesterday}&to=${yesterday}`);
      expect(events.body.total).toBe(3);
      expect((await sup.get(`/attendance/gaps?unitId=${unit.id}`)).status).toBe(403);
    });
  });

  describe('unauthorized access sweep (R15)', () => {
    it.each([
      ['GET', `/roster?unitId=1&from=2026-01-01&to=2026-01-02`], ['GET', '/roster/pool?unitId=1&date=2026-01-01&shiftType=Night'],
      ['POST', '/shift-assignments'], ['DELETE', '/shift-assignments/1'], ['POST', '/roster/auto-generate'], ['POST', '/roster/publish'],
      ['GET', '/coverage?unitId=1&from=2026-01-01&to=2026-01-02'], ['GET', '/attendance/events?unitId=1&from=2026-01-01&to=2026-01-02'],
      ['GET', '/attendance/gaps?unitId=1'],
    ])('%s %s is forbidden to an employee', async (method, path) => {
      const nurse = await signIn(app, (await makeUser(db)).email);
      const req = method === 'GET' ? nurse.get(path) : method === 'POST' ? nurse.post(path, {}) : nurse.del(path);
      expect((await req.set('Idempotency-Key', randomUUID())).status).toBe(403);
    });
  });
});
