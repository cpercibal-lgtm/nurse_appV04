// Announcements (D-69; owner decisions 2026-10-05, docs/ANNOUNCEMENTS_PHASE1_PLAN.md):
// who may send to whom (Q1), four-eyes for every HR / System Admin send (Q2),
// staff without an account reached by e-mail only (Q6), no edit after sending (Q4),
// cancellation, the content-free Telegram prompt (Q3), and the e-mail order.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { dispatchEmails, sentInLastHour } from '../src/jobs/email-dispatch.js';
import { dispatchTelegram } from '../src/jobs/telegram-dispatch.js';
import type { OutgoingEmail } from '../src/lib/mailer.js';
import type { Db } from '../src/lib/prisma.js';
import type { TelegramGateway } from '../src/lib/telegram.js';
import { businessHealth } from '../src/modules/audit/business-health.js';
import { makeOrg, makeUser, openDb, signIn, TEST_URL, testApp, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const HOUR = 3600_000;
type Client = Awaited<ReturnType<typeof signIn>>;

describeDb('announcements (D-69)', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let sup: Client, hr: Client, hr2: Client, hrUnit: Client, nurseA: Client, nurseB: Client;
  let ids: { sup: number; hrUnit: number; nurseA: number; nurseA2: number; nurseB: number; hr2: number };
  let sharedAddress: string;
  let nurseAEmail: string;

  const staff = (unitId: number, contactEmail: string, extra: Record<string, unknown> = {}) => db.employee.create({
    data: { jobNumber: uniq('J'), firstName: 'Ann', lastName: uniq('N'), fullName: `Ann ${uniq('N')}`, contactEmail, positionCode: 'SN', unitId, ...extra },
  });
  const meeting = (unitIds: number[], extra: Record<string, unknown> = {}) => {
    const startsAt = new Date(Date.now() + 2 * 24 * HOUR);
    return {
      kind: 'MEETING', title: 'Unit A staff meeting', body: 'Monthly meeting for all Unit A staff.', bodyAr: 'الاجتماع الشهري',
      startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + HOUR).toISOString(),
      location: 'Conference Hall B', onlineUrl: 'https://meet.example.org/unit-a', audienceType: 'UNIT', audienceIds: unitIds, ...extra,
    };
  };
  const memo = (audienceType: string, audienceIds: number[], extra: Record<string, unknown> = {}) => ({
    kind: 'MEMO', title: `Memo ${uniq('m')}`, body: 'Please read the updated hand-hygiene policy.', referenceNo: 'NA-MEMO-2026-041', audienceType, audienceIds, ...extra,
  });
  const submit = (c: Client, id: number) => c.post(`/announcements/${id}/submit`).set('Idempotency-Key', randomUUID());
  const create = async (c: Client, body: object) => {
    const res = await c.post('/announcements', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: number; needsApproval: boolean; priority: string; expiresAt: string };
  };

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    org = await makeOrg(db);
    const supUser = await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] });
    const hrUser = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    const hr2User = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    const hrUnitUser = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] });
    const a1 = await makeUser(db, { employeeId: (await staff(org.unitA.id, `${uniq('a1')}@x.sa`)).id });
    const a2 = await makeUser(db, { employeeId: (await staff(org.unitA.id, `${uniq('a2')}@x.sa`)).id });
    await db.user.update({ where: { id: a2.id }, data: { telegramChatId: String(Date.now()).slice(-9), telegramLinkedAt: new Date() } });
    const b = await makeUser(db, { employeeId: (await staff(org.unitB.id, `${uniq('b')}@x.sa`)).id });
    nurseAEmail = a1.email;
    // Unit A staff without an account: two records share one address (one e-mail), one uses an
    // account's address (reached through the account only), one is deleted, one has left.
    sharedAddress = `${uniq('shared')}@x.sa`;
    await staff(org.unitA.id, sharedAddress);
    await staff(org.unitA.id, sharedAddress.toUpperCase());
    await staff(org.unitA.id, a1.email);
    await staff(org.unitA.id, `${uniq('gone')}@x.sa`, { deletedAt: new Date() });
    await makeUser(db, { isActive: false, employeeId: (await staff(org.unitA.id, `${uniq('inactive')}@x.sa`)).id });
    ids = { sup: supUser.id, hrUnit: hrUnitUser.id, nurseA: a1.id, nurseA2: a2.id, nurseB: b.id, hr2: hr2User.id };
    sup = await signIn(app, supUser.email);
    hr = await signIn(app, hrUser.email);
    hr2 = await signIn(app, hr2User.email);
    hrUnit = await signIn(app, hrUnitUser.email);
    nurseA = await signIn(app, a1.email);
    nurseB = await signIn(app, b.email);
  });
  afterAll(async () => { await db.$disconnect(); });

  it('Q1/Q6: a supervisor sends a meeting to their unit at once — to its accounts and supervisors, and by e-mail only to staff without an account', async () => {
    const body = meeting([org.unitA.id]);
    const a = await create(sup, body);
    expect(a).toMatchObject({ needsApproval: false, priority: 'MEDIUM' }); // Q7: meetings default to Medium
    expect(new Date(a.expiresAt).getTime()).toBe(new Date(body.endsAt).getTime() + 24 * HOUR); // Q5: the day after the event

    const preview = await sup.post(`/announcements/${a.id}/preview`);
    expect(preview.body).toMatchObject({ recipients: 4, telegramLinked: 1, emailOnly: 1, needsApproval: false }); // two nurses, the supervisor, unit HR

    expect((await submit(sup, a.id)).body).toEqual({ id: a.id, status: 'PUBLISHED' });
    const rows = await db.notification.findMany({ where: { announcementId: a.id }, orderBy: { recipientId: 'asc' } });
    expect(rows.map((r) => r.recipientId).sort((x, y) => x - y)).toEqual([ids.sup, ids.hrUnit, ids.nurseA, ids.nurseA2].sort((x, y) => x - y));
    expect(rows.every((r) => r.type === 'ANNOUNCEMENT' && r.eventKey === `announcement:${a.id}` && r.emailStatus === 'PENDING' && r.telegramStatus === 'PENDING')).toBe(true);
    // In the app the online link is on the announcement page; the text says where to find it.
    expect(rows[0]!.message).toContain('Where: Conference Hall B');
    expect(rows[0]!.message).toContain('Online: the link is in the announcement in the app');
    expect(rows[0]!.messageAr).toContain('الاجتماع الشهري');

    const outbox = await db.emailOutbox.findMany({ where: { eventKey: `announcement:${a.id}` } });
    expect(outbox.map((o) => o.toAddress)).toEqual([sharedAddress.toLowerCase()]);
    expect(outbox[0]!.bodyText).toContain('Online: https://meet.example.org/unit-a'); // no app for them: the link is written out
    expect(outbox[0]!.bodyText).not.toContain('Open:'); // and no "open the app" button
    expect(await db.announcement.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: 'PUBLISHED', recipientCount: 4, emailOnlyCount: 1 });

    const board = await nurseA.get('/announcements');
    expect(board.body.items.map((x: { id: number }) => x.id)).toContain(a.id);
    expect((await nurseA.get(`/announcements/${a.id}`)).body).toMatchObject({ id: a.id, title: 'Unit A staff meeting', canCancel: false });
    expect((await nurseB.get(`/announcements/${a.id}`)).status).toBe(404); // never revealed to others
    expect((await submit(sup, a.id)).body.error?.code).toBe('ANNOUNCEMENT_NOT_DRAFT'); // Q4: nothing changes once sent
    expect((await sup.patch(`/announcements/${a.id}`, { title: 'Changed' })).status).toBe(409);
    expect((await sup.del(`/announcements/${a.id}`)).status).toBe(409);
  });

  it('Q1: a supervisor cannot address another unit, a department or the hospital; nurses cannot send', async () => {
    expect((await sup.post('/announcements', meeting([org.unitB.id]))).body.error?.code).toBe('SCOPE_NOT_COVERED');
    expect((await sup.post('/announcements', memo('DEPARTMENT', [org.dept.id]))).body.error?.code).toBe('SCOPE_NOT_COVERED');
    expect((await sup.post('/announcements', memo('HOSPITAL', []))).body.error?.code).toBe('SCOPE_NOT_COVERED');
    expect((await sup.post('/announcements', memo('PEOPLE', [ids.nurseB]))).body.error?.code).toBe('SCOPE_NOT_COVERED');
    expect((await nurseA.post('/announcements', memo('UNIT', [org.unitA.id]))).status).toBe(403);
  });

  it('Q2: every HR send waits for a second administrator, even to one unit; two can wait at once; the sender cannot approve', async () => {
    const a = await create(hr, memo('UNIT', [org.unitA.id]));
    const b = await create(hr, memo('UNIT', [org.unitA.id]));
    expect(a).toMatchObject({ needsApproval: true, priority: 'LOW' });
    const sa = await submit(hr, a.id);
    expect(sa.body).toMatchObject({ id: a.id, status: 'PENDING_APPROVAL' });
    expect((await submit(hr, b.id)).body.status).toBe('PENDING_APPROVAL'); // one action type per announcement
    expect(await db.notification.count({ where: { announcementId: a.id } })).toBe(0);

    expect((await hr.post(`/approvals/${sa.body.approvalRequestId}/approve`, { reason: 'Looks fine' })).body.error?.code).toBe('SELF_APPROVAL_FORBIDDEN');
    const queue = await hr2.get('/approvals');
    expect(queue.body.items.find((r: { id: number }) => r.id === sa.body.approvalRequestId)?.payload).toMatchObject({ kind: 'ANNOUNCEMENT', announcementId: a.id, recipients: 4, emailOnly: 1 });
    const ok = await hr2.post(`/approvals/${sa.body.approvalRequestId}/approve`, { reason: 'Approved for Unit A' });
    expect(ok.body).toMatchObject({ status: 'EXECUTED', resultId: a.id });
    expect(await db.announcement.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: 'PUBLISHED', recipientCount: 4 });
    expect(await db.notification.count({ where: { announcementId: a.id } })).toBe(4);
  });

  it('Q2: the approver must cover the audience; rejection marks it Rejected; withdrawal makes it a draft again', async () => {
    await staff(org.unitC.id, `${uniq('c')}@x.sa`); // someone to reach (an empty audience is refused: NO_RECIPIENTS)
    const other = await create(hr, memo('UNIT', [org.unitC.id]));
    const req = (await submit(hr, other.id)).body.approvalRequestId;
    expect(req).toEqual(expect.any(Number));
    expect((await hrUnit.post(`/approvals/${req}/approve`, { reason: 'Not my unit' })).body.error?.code).toBe('SCOPE_NOT_COVERED');
    expect((await hr2.post(`/approvals/${req}/reject`, { reason: 'Wrong audience' })).body.status).toBe('REJECTED');
    expect((await db.announcement.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('REJECTED');

    const w = await create(hr, memo('UNIT', [org.unitA.id]));
    const wreq = (await submit(hr, w.id)).body.approvalRequestId;
    expect((await hr.post(`/approvals/${wreq}/withdraw`, { reason: 'Typo in text' })).body.status).toBe('WITHDRAWN');
    expect((await db.announcement.findUniqueOrThrow({ where: { id: w.id } })).status).toBe('DRAFT');
    expect((await hr.patch(`/announcements/${w.id}`, { body: 'Corrected text.' })).status).toBe(200);
  });

  it('Q2: a scoped HR Admin cannot address someone with no unit (needs system-wide scope)', async () => {
    expect((await hrUnit.post('/announcements', memo('PEOPLE', [ids.nurseA, ids.hr2]))).body.error?.code).toBe('SCOPE_NOT_COVERED');
    expect((await hrUnit.post('/announcements', memo('PEOPLE', [ids.nurseA]))).status).toBe(201);
  });

  it('drafts: shape rules, edit, delete; filters narrow the audience', async () => {
    expect((await hr.post('/announcements', memo('UNIT', [org.unitA.id], { startsAt: new Date(Date.now() + HOUR).toISOString() }))).body.error?.code).toBe('ANNOUNCEMENT_INVALID');
    expect((await hr.post('/announcements', meeting([org.unitA.id], { startsAt: null, endsAt: null }))).body.error?.code).toBe('ANNOUNCEMENT_INVALID');
    expect((await hr.post('/announcements', meeting([org.unitA.id], { priority: 'HIGH' }))).body.error?.code).toBe('ANNOUNCEMENT_INVALID'); // Q7
    expect((await hr.post('/announcements', meeting([org.unitA.id], { onlineUrl: 'http://meet.example.org/x' }))).status).toBe(400);
    expect((await hr.post('/announcements', memo('UNIT', []))).body.error?.code).toBe('ANNOUNCEMENT_INVALID');
    expect((await hr.post('/announcements', memo('UNIT', [999_999_999]))).body.error?.code).toBe('AUDIENCE_INVALID');
    expect((await hr.post('/announcements', memo('UNIT', [org.unitA.id], { title: 'x'.repeat(151) }))).status).toBe(400); // Q8

    const d = await create(sup, memo('UNIT', [org.unitA.id], { roleFilter: ['SUPERVISOR'] }));
    expect((await sup.post(`/announcements/${d.id}/preview`)).body).toMatchObject({ recipients: 1, emailOnly: 0 }); // the supervisor only; no-account staff hold no role
    const memoExpiry = new Date((await sup.patch(`/announcements/${d.id}`, { title: 'Renamed' })).body.expiresAt).getTime();
    expect(Math.abs(memoExpiry - (Date.now() + 30 * 24 * HOUR))).toBeLessThan(HOUR); // Q5: 30 days for a memo
    expect((await hr.patch(`/announcements/${d.id}`, { title: 'Not yours' })).status).toBe(404);
    expect((await sup.del(`/announcements/${d.id}`)).body).toEqual({ id: d.id, deleted: true });

    // An audience nobody is in is refused at sending, and stays a draft.
    const empty = await db.unit.create({ data: { code: uniq('UE'), name: 'Empty unit', departmentId: org.dept.id } });
    const e = await create(hr, memo('UNIT', [empty.id]));
    expect((await submit(hr, e.id)).body.error?.code).toBe('NO_RECIPIENTS');
    expect((await db.announcement.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('DRAFT');
  });

  it('cancel stops what has not been delivered and hides it from the board; the reason is required', async () => {
    const a = await create(sup, meeting([org.unitA.id]));
    await submit(sup, a.id);
    const first = await db.notification.findFirstOrThrow({ where: { announcementId: a.id }, orderBy: { id: 'asc' } });
    await db.notification.update({ where: { id: first.id }, data: { emailStatus: 'SENT' } });

    expect((await nurseB.post(`/announcements/${a.id}/cancel`, { reason: 'Not mine to cancel' })).status).toBe(403); // a nurse sends nothing
    expect((await sup.post(`/announcements/${a.id}/cancel`, { reason: 'short' })).status).toBe(400);
    const res = await sup.post(`/announcements/${a.id}/cancel`, { reason: 'Meeting postponed to next month' });
    expect(res.body).toMatchObject({ status: 'CANCELLED', emailsStopped: 3 + 1, telegramStopped: 4 });
    expect((await db.notification.findUniqueOrThrow({ where: { id: first.id } })).emailStatus).toBe('SENT'); // already delivered stays
    expect(await db.emailOutbox.count({ where: { eventKey: `announcement:${a.id}`, status: 'PENDING' } })).toBe(0);
    expect((await nurseA.get('/announcements')).body.items.map((x: { id: number }) => x.id)).not.toContain(a.id);
    expect((await nurseA.get(`/announcements/${a.id}`)).body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Meeting postponed to next month' });
    // An HR manager covering the unit may cancel another sender's announcement.
    const b = await create(sup, meeting([org.unitA.id]));
    await submit(sup, b.id);
    expect((await hrUnit.post(`/announcements/${b.id}/cancel`, { reason: 'Duplicate of the HR memo' })).body.status).toBe('CANCELLED');
  });

  it('the board: archived after the board date; people search stays in the sender’s scope', async () => {
    const a = await create(sup, memo('UNIT', [org.unitA.id]));
    await submit(sup, a.id);
    await db.announcement.update({ where: { id: a.id }, data: { expiresAt: new Date(Date.now() - HOUR) } });
    expect((await nurseA.get('/announcements')).body.items.map((x: { id: number }) => x.id)).not.toContain(a.id);
    expect((await nurseA.get('/announcements?state=archived')).body.items.map((x: { id: number }) => x.id)).toContain(a.id);

    const found = await sup.get(`/announcements/people?q=${encodeURIComponent('Ann')}`);
    const foundIds = found.body.items.map((p: { id: number }) => p.id);
    expect(foundIds).toContain(ids.nurseA);
    expect(foundIds).not.toContain(ids.nurseB);
  });

  describe('delivery', () => {
    beforeEach(async () => {
      await db.notification.updateMany({ where: { OR: [{ emailStatus: 'PENDING' }, { telegramStatus: 'PENDING' }] }, data: { emailStatus: 'SKIPPED', telegramStatus: 'SKIPPED' } });
      await db.emailOutbox.updateMany({ where: { status: 'PENDING' }, data: { status: 'SKIPPED' } });
    });

    it('Q3: the Telegram prompt carries nothing from the announcement', async () => {
      const a = await create(sup, meeting([org.unitA.id]));
      await submit(sup, a.id);
      const sent: string[] = [];
      const gateway: TelegramGateway = { driver: 'mock', send: async (_chat, text) => { sent.push(text); return { accepted: true, messageId: '1' } as never; } };
      await dispatchTelegram(db, gateway, 'https://nurse.aigh.sa');
      expect(sent).toHaveLength(1); // the one linked nurse
      expect(sent[0]).not.toMatch(/Unit A|meeting|Conference|meet\.example/i);
      expect(sent[0]).toContain('https://nurse.aigh.sa/notifications');
    });

    it('e-mail: announcement mail goes after other mail, and its button opens the announcement', async () => {
      const a = await create(sup, meeting([org.unitA.id]));
      await submit(sup, a.id);
      const routine = await db.notification.create({ data: { recipientId: ids.nurseB, type: 'SYSTEM', priority: 'LOW', title: 'Routine', message: 'm', eventKey: uniq('ev') } });
      const sent: OutgoingEmail[] = [];
      const mailer = { enabled: true, send: async (m: OutgoingEmail) => { sent.push(m); } };
      const cfg = { retryMax: 3, retryDelaySeconds: 0, baseUrl: 'https://nurse.aigh.sa/', domain: 'aigh.sa' };
      await dispatchEmails(db, mailer, { ...cfg, hourlyLimit: (await sentInLastHour(db)) + 1 });
      expect(sent.map((m) => m.messageId)).toEqual([`<notification-${routine.id}@aigh.sa>`]); // the low-priority routine notice still goes first
      await dispatchEmails(db, mailer, cfg);
      const toAccount = sent.find((m) => m.to === nurseAEmail)!;
      expect(toAccount.text).toContain(`Open: https://nurse.aigh.sa/announcements?id=${a.id}`);
      expect(sent.at(-1)!.to).toBe(sharedAddress.toLowerCase()); // staff without an account last
    });

    it('health: waiting announcement mail is not an e-mail backlog until 6 hours', async () => {
      const a = await create(sup, memo('UNIT', [org.unitA.id]));
      await submit(sup, a.id);
      await db.notification.updateMany({ where: { announcementId: a.id }, data: { createdAt: new Date(Date.now() - HOUR) } });
      let h = await businessHealth(db);
      expect(h.issues.map((i) => i.code)).not.toContain('EMAIL_BACKLOG');
      expect(h.issues.map((i) => i.code)).not.toContain('ANNOUNCEMENT_EMAIL_BACKLOG');
      await db.notification.updateMany({ where: { announcementId: a.id }, data: { createdAt: new Date(Date.now() - 7 * HOUR) } });
      h = await businessHealth(db);
      expect(h.issues.map((i) => i.code)).toContain('ANNOUNCEMENT_EMAIL_BACKLOG');
    });
  });
});
