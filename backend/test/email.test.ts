// E-mail through the hospital SMTP relay (spec §7.2, §3.6; decision D-47):
// templates, settings, the dispatcher's outbox rules against PostgreSQL, and
// real SMTP against a local server (STARTTLS required, headers, multipart).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import { loadEnv } from '../src/config/env.js';
import { dispatchEmails, sentInLastHour, type DispatchConfig } from '../src/jobs/email-dispatch.js';
import { renderEmail } from '../src/lib/email-templates.js';
import { createMailer, disabledMailer, senderDomain, type Mailer, type OutgoingEmail } from '../src/lib/mailer.js';
import type { Db } from '../src/lib/prisma.js';
import { makeUser, openDb, ORIGIN, PASSWORD, TEST_URL, testApp, testEnv, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const CFG: DispatchConfig = { retryMax: 3, retryDelaySeconds: 0, baseUrl: 'https://nurse.aigh.sa/', domain: 'aigh.sa' };

/** Records what would be sent; fails while `failing` is set. */
function fakeMailer() {
  const sent: OutgoingEmail[] = [];
  const m = { enabled: true, failing: false, sent, send: async (mail: OutgoingEmail) => { if (m.failing) throw Object.assign(new Error('Connection refused'), { responseCode: 421 }); sent.push(mail); } };
  return m satisfies Mailer & { failing: boolean };
}

describe('e-mail templates and settings', () => {
  it('renders plain text and HTML in both languages, escapes HTML and keeps the subject on one line', () => {
    const m = renderEmail({ title: 'Licence <expires>\r\nBcc: x@y', message: 'Renew "now" & upload', titleAr: 'تنبيه', messageAr: 'جدد الرخصة', link: 'https://nurse.aigh.sa/notifications' });
    expect(m.subject).toBe('AIGH Workforce: Licence <expires> Bcc: x@y');
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text).toContain('جدد الرخصة');
    expect(m.text).toContain('Open: https://nurse.aigh.sa/notifications');
    expect(m.html).toContain('Licence &lt;expires&gt;');
    expect(m.html).toContain('Renew &quot;now&quot; &amp; upload');
    expect(m.html).toContain('dir="rtl"');
    expect(m.html).not.toMatch(/<img|<script|https?:\/\/(?!nurse\.aigh\.sa)/);
  });

  it('turns `link` into a real anchor (button plus the plain address), once, between the English and Arabic text', () => {
    const url = 'https://nurse.aigh.sa/claim#token=abc-DEF_123';
    const m = renderEmail({ title: 'Invite', message: 'Use the link below.', titleAr: 'دعوة', messageAr: 'استخدم الرابط أعلاه.', link: url });
    expect(m.html.match(/<a href="https:\/\/nurse\.aigh\.sa\/claim#token=abc-DEF_123"/g)).toHaveLength(2); // button + fallback address
    expect(m.html.indexOf('Use the link below.')).toBeLessThan(m.html.indexOf('<a href='));
    expect(m.html.indexOf('<a href=')).toBeLessThan(m.html.indexOf('استخدم الرابط أعلاه.'));
    expect(m.text).toContain(`Open: ${url}`);
    expect(m.text.indexOf('Open:')).toBeLessThan(m.text.indexOf('دعوة'));
    // a URL written inside `message` is escaped text, not an anchor: callers must use `link`
    expect(renderEmail({ title: 't', message: `see ${url}` }).html).not.toContain('<a href=');
  });

  it('validates the SMTP settings', () => {
    const base = { DATABASE_URL: 'postgresql://x@y/z', JWT_SECRET: 'x'.repeat(32) };
    expect(() => loadEnv({ ...base, SMTP_HOST: 'smtp.aigh.local' })).toThrow(/SMTP_FROM: required/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', SMTP_TLS_REJECT_UNAUTHORIZED: 'false' })).toThrow(/must stay true in production/);
    expect(() => loadEnv({ ...base, BREAK_GLASS_ALERT_EMAILS: 'ceo@aigh.sa, not-an-address' })).toThrow(/BREAK_GLASS_ALERT_EMAILS/);
    const env = loadEnv({ ...base, BREAK_GLASS_ALERT_EMAILS: 'ceo@aigh.sa, it.director@aigh.sa' });
    expect(env.BREAK_GLASS_ALERT_EMAILS).toEqual(['ceo@aigh.sa', 'it.director@aigh.sa']);
    expect(env.SMTP_SECURE).toBe(false);
    expect(env.EMAIL_HOURLY_LIMIT).toBe(0); // D-69: no limit unless set
    expect(loadEnv({ ...base, EMAIL_HOURLY_LIMIT: '150' }).EMAIL_HOURLY_LIMIT).toBe(150);
    expect(() => loadEnv({ ...base, EMAIL_HOURLY_LIMIT: '-1' })).toThrow(/EMAIL_HOURLY_LIMIT/);
    expect(createMailer(env).enabled).toBe(false); // no SMTP_HOST → e-mail off
    expect(senderDomain('AIGH Workforce <nurseapp@aigh.sa>')).toBe('aigh.sa');
  });
});

describeDb('e-mail dispatcher (outbox rules)', () => {
  let db: Db;
  beforeAll(() => { db = openDb(); });
  afterAll(async () => { await db.$disconnect(); });
  // Tests share one database: start each case with an empty queue.
  beforeEach(async () => {
    await db.notification.updateMany({ where: { emailStatus: 'PENDING' }, data: { emailStatus: 'SKIPPED' } });
    await db.emailOutbox.updateMany({ where: { status: 'PENDING' }, data: { status: 'SKIPPED' } });
  });

  const notify = async (recipientId: number, priority: 'CRITICAL' | 'MEDIUM' = 'MEDIUM') => db.notification.create({
    data: { recipientId, type: 'CREDENTIAL', priority, title: 'Licence expires in 30 days', message: 'Upload the renewal.', titleAr: 'تنبيه', messageAr: 'جدد', eventKey: uniq('ev') },
  });

  it('new notifications start PENDING and are sent once, to the account address, with a stable Message-ID', async () => {
    const u = await makeUser(db);
    const n = await notify(u.id, 'CRITICAL');
    expect(n.emailStatus).toBe('PENDING');
    const mailer = fakeMailer();
    expect(await dispatchEmails(db, mailer, CFG)).toMatchObject({ sent: 1, failed: 0 });
    expect(mailer.sent).toEqual([expect.objectContaining({ to: u.email, messageId: `<notification-${n.id}@aigh.sa>`, urgent: true })]);
    expect(mailer.sent[0]!.text).toContain('https://nurse.aigh.sa/notifications');
    expect(await db.notification.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ emailStatus: 'SENT', emailAttempts: 1, emailLastError: null });
    expect(await dispatchEmails(db, mailer, CFG)).toMatchObject({ sent: 0 }); // never twice
  });

  it('retries a relay failure, waits the retry delay, and gives up (FAILED) after the last attempt', async () => {
    const n = await notify((await makeUser(db)).id);
    const mailer = fakeMailer();
    mailer.failing = true;
    expect(await dispatchEmails(db, mailer, { ...CFG, retryDelaySeconds: 60 })).toMatchObject({ retrying: 1 });
    expect(await dispatchEmails(db, mailer, { ...CFG, retryDelaySeconds: 60 })).toMatchObject({ retrying: 0 }); // not due yet
    await dispatchEmails(db, mailer, CFG); // attempt 2
    expect(await dispatchEmails(db, mailer, CFG)).toMatchObject({ failed: 1 }); // attempt 3 of 3
    const row = await db.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(row).toMatchObject({ emailStatus: 'FAILED', emailAttempts: 3, emailLastError: '421 Connection refused' });
    mailer.failing = false;
    expect(await dispatchEmails(db, mailer, CFG)).toMatchObject({ sent: 0 }); // FAILED stays failed
  });

  it('a relay that recovers delivers on the next attempt', async () => {
    const n = await notify((await makeUser(db)).id);
    const mailer = fakeMailer();
    mailer.failing = true;
    await dispatchEmails(db, mailer, CFG);
    mailer.failing = false;
    expect(await dispatchEmails(db, mailer, CFG)).toMatchObject({ sent: 1 });
    expect(await db.notification.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ emailStatus: 'SENT', emailAttempts: 2 });
  });

  it('skips inactive recipients, and everything when e-mail is off', async () => {
    const inactive = await notify((await makeUser(db, { isActive: false })).id);
    const mailer = fakeMailer();
    expect(await dispatchEmails(db, mailer, CFG)).toMatchObject({ skipped: 1, sent: 0 });
    expect((await db.notification.findUniqueOrThrow({ where: { id: inactive.id } })).emailStatus).toBe('SKIPPED');

    const n = await notify((await makeUser(db)).id);
    const box = await db.emailOutbox.create({ data: { toAddress: 'ceo@aigh.sa', subject: 's', bodyText: 't', bodyHtml: 'h', eventKey: uniq('ev') } });
    expect(await dispatchEmails(db, disabledMailer, CFG)).toMatchObject({ skipped: 2 });
    expect((await db.notification.findUniqueOrThrow({ where: { id: n.id } })).emailStatus).toBe('SKIPPED');
    expect((await db.emailOutbox.findUniqueOrThrow({ where: { id: box.id } })).status).toBe('SKIPPED');
  });

  it('D-69: the hourly limit holds back what is over it as PENDING, without using an attempt', async () => {
    const u = await makeUser(db);
    const rows = [await notify(u.id), await notify(u.id), await notify(u.id), await notify(u.id)];
    // Earlier cases in this file sent mail within the hour: the limit counts those too.
    const cfg = { ...CFG, hourlyLimit: (await sentInLastHour(db)) + 2 };
    const mailer = fakeMailer();
    expect(await dispatchEmails(db, mailer, cfg)).toMatchObject({ sent: 2 });
    expect(await dispatchEmails(db, mailer, cfg)).toMatchObject({ sent: 0 }); // limit reached
    const after = await db.notification.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: { id: 'asc' } });
    expect(after.map((r) => [r.emailStatus, r.emailAttempts])).toEqual([['SENT', 1], ['SENT', 1], ['PENDING', 0], ['PENDING', 0]]);
    // An hour later the window has moved past them, and the rest go out.
    expect(await dispatchEmails(db, mailer, cfg, new Date(Date.now() + 61 * 60_000))).toMatchObject({ sent: 2 });
  });

  it('D-69: under the limit, outbox mail goes first, then notifications by priority', async () => {
    const u = await makeUser(db);
    const low = await db.notification.create({ data: { recipientId: u.id, type: 'SYSTEM', priority: 'LOW', title: 'Routine', message: 'm', eventKey: uniq('ev') } });
    const critical = await notify(u.id, 'CRITICAL');
    const box = await db.emailOutbox.create({ data: { toAddress: 'ceo@aigh.sa', subject: 's', bodyText: 't', bodyHtml: 'h', priority: 'CRITICAL', eventKey: uniq('ev') } });
    const mailer = fakeMailer();
    await dispatchEmails(db, mailer, { ...CFG, hourlyLimit: (await sentInLastHour(db)) + 2 });
    expect(mailer.sent.map((m) => m.messageId)).toEqual([`<outbox-${box.id}@aigh.sa>`, `<notification-${critical.id}@aigh.sa>`]);
    expect((await db.notification.findUniqueOrThrow({ where: { id: low.id } })).emailStatus).toBe('PENDING');
  });

  it('break-glass sign-in e-mails the configured CEO and IT Director addresses (spec §3.6)', async () => {
    const app = testApp(db, { BREAK_GLASS_ALERT_EMAILS: 'ceo@aigh.sa,it.director@aigh.sa' });
    const bg = await makeUser(db, { isBreakGlass: true, roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
    const login = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: bg.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const event = await db.breakGlassEvent.findFirstOrThrow({ where: { actorUserId: bg.id }, orderBy: { id: 'desc' } });
    const rows = await db.emailOutbox.findMany({ where: { eventKey: `break-glass:${event.id}` }, orderBy: { toAddress: 'asc' } });
    expect(rows.map((r) => [r.toAddress, r.priority, r.status])).toEqual([['ceo@aigh.sa', 'CRITICAL', 'PENDING'], ['it.director@aigh.sa', 'CRITICAL', 'PENDING']]);
    expect(rows[0]!.bodyText).toContain('break-glass');

    const mailer = fakeMailer();
    await dispatchEmails(db, mailer, CFG);
    expect(mailer.sent.filter((m) => m.messageId.startsWith('<outbox-')).map((m) => [m.to, m.urgent])).toEqual([['ceo@aigh.sa', true], ['it.director@aigh.sa', true]]);
  });
});

describe('SMTP transport (a real local SMTP server)', () => {
  interface Received { raw: string; secure: boolean; user?: string; from?: string; to: string[] }
  const received: Received[] = [];

  async function server(opts: { startTls: boolean }) {
    const s = new SMTPServer({
      disabledCommands: opts.startTls ? [] : ['STARTTLS'],
      authOptional: false,
      onAuth(auth, _session, cb) {
        return auth.username === 'nurseapp' && auth.password === 's3cret' ? cb(null, { user: auth.username }) : cb(new Error('Invalid credentials'));
      },
      onData(stream, session, cb) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          received.push({ raw: Buffer.concat(chunks).toString('utf8'), secure: session.secure, user: session.user as string | undefined, from: session.envelope.mailFrom ? session.envelope.mailFrom.address : undefined, to: session.envelope.rcptTo.map((r) => r.address) });
          cb();
        });
      },
      logger: false,
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return { port: (s.server.address() as AddressInfo).port, close: () => new Promise<void>((r) => s.close(() => r())) };
  }

  const envFor = (port: number, extra: Record<string, string> = {}) => testEnv({
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'nurseapp', SMTP_PASS: 's3cret',
    SMTP_FROM: 'AIGH Workforce <nurseapp@aigh.sa>', SMTP_REPLY_TO: 'hr@aigh.sa',
    SMTP_TLS_REJECT_UNAUTHORIZED: 'false', // the test server's certificate is self-signed
    ...extra,
  });

  it('upgrades with STARTTLS, authenticates, and sends multipart UTF-8 with the spec headers', async () => {
    const s = await server({ startTls: true });
    try {
      const mail = renderEmail({ title: 'Break-glass account activated', message: 'Signed in.', titleAr: 'تم تفعيل حساب الطوارئ', messageAr: 'تسجيل دخول' });
      await createMailer(envFor(s.port)).send({ to: 'ceo@aigh.sa', ...mail, messageId: '<outbox-7@aigh.sa>', urgent: true });
      const r = received.at(-1)!;
      expect(r).toMatchObject({ secure: true, user: 'nurseapp', from: 'nurseapp@aigh.sa', to: ['ceo@aigh.sa'] });
      expect(r.raw).toMatch(/^Message-ID: <outbox-7@aigh\.sa>/mi);
      expect(r.raw).toMatch(/^X-Priority: 1/mi);
      expect(r.raw).toMatch(/^Reply-To: hr@aigh\.sa/mi);
      expect(r.raw).toMatch(/^From: AIGH Workforce <nurseapp@aigh\.sa>/mi);
      expect(r.raw).toMatch(/Content-Type: multipart\/alternative/i);
      expect(r.raw).toMatch(/Content-Type: text\/plain; charset=utf-8/i);
      expect(r.raw).toMatch(/Content-Type: text\/html; charset=utf-8/i);
    } finally { await s.close(); }
  });

  it('refuses to send when the relay does not offer STARTTLS (never plain text)', async () => {
    const s = await server({ startTls: false });
    try {
      const before = received.length;
      await expect(createMailer(envFor(s.port)).send({ to: 'x@aigh.sa', subject: 's', text: 't', html: 'h', messageId: '<m@aigh.sa>', urgent: false })).rejects.toThrow(/STARTTLS/i);
      expect(received.length).toBe(before);
    } finally { await s.close(); }
  });

  it('reports a rejected login as a relay error', async () => {
    const s = await server({ startTls: true });
    try {
      await expect(createMailer(envFor(s.port, { SMTP_PASS: 'wrong' })).send({ to: 'x@aigh.sa', subject: 's', text: 't', html: 'h', messageId: '<m@aigh.sa>', urgent: false })).rejects.toThrow(/Invalid|auth/i);
    } finally { await s.close(); }
  });
});
