// MFA for privileged accounts (spec §3.5): authenticator (TOTP) + recovery
// codes; required for the roles in MFA_REQUIRED_ROLES, never for break-glass.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from '../src/lib/prisma.js';
import { loadEnv } from '../src/config/env.js';
import { totp } from '../src/lib/totp.js';
import { makeNurse, makeOrg, makeUser, openDb, ORIGIN, PASSWORD, signIn, TEST_URL, testApp } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const ON = { MFA_REQUIRED_ROLES: 'SYSTEM_ADMIN,HR_ADMIN,SUPERVISOR' };

describeDb('MFA (spec §3.5)', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;

  beforeAll(async () => {
    db = openDb();
    app = testApp(db, ON);
    org = await makeOrg(db);
  });
  afterAll(async () => { await db.$disconnect(); });

  const post = (a: Express, path: string, body: object) => request(a).post(`/api/v1/auth${path}`).set('Origin', ORIGIN).send(body);
  const login = (a: Express, email: string, password = PASSWORD) => post(a, '/login', { email, password });
  const hr = () => makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
  const supervisor = () => makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] });
  /** A code the server will accept once more: forget the last used step, then read the authenticator. */
  async function freshCode(userId: number, secret: string) {
    await db.mfaFactor.update({ where: { userId }, data: { lastUsedStep: null } });
    return totp(secret);
  }
  /** Signs in a required-role account for the first time and sets up its authenticator. */
  async function enrol(a: Express, email: string) {
    const first = await login(a, email);
    const { secret } = (await post(a, '/mfa/enroll/start', { challenge: first.body.mfa.challenge })).body;
    const setupCode = totp(secret);
    const done = await post(a, '/mfa/enroll/confirm', { challenge: first.body.mfa.challenge, code: setupCode });
    expect(done.status).toBe(200);
    return { secret, setupCode, recoveryCodes: done.body.recoveryCodes as string[] };
  }

  it('a required role must set up an authenticator before any session exists', async () => {
    const u = await hr();
    const res = await login(app, u.email);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfa: { step: 'ENROLL', challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresIn: 900 } });
    expect(res.headers['set-cookie']).toBeUndefined();

    const start = await post(app, '/mfa/enroll/start', { challenge: res.body.mfa.challenge });
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ secret: expect.stringMatching(/^[A-Z2-7]{32}$/), account: u.email });
    expect(start.body.otpauthUri).toContain(`secret=${start.body.secret}`);
    const stored = await db.mfaFactor.findUniqueOrThrow({ where: { userId: u.id } });
    expect(stored.secretEnc).not.toContain(start.body.secret);
    expect(stored.confirmedAt).toBeNull();

    const wrong = await post(app, '/mfa/enroll/confirm', { challenge: res.body.mfa.challenge, code: totp(start.body.secret, Date.now() + 300_000) });
    expect([wrong.status, wrong.body.error.code]).toEqual([401, 'MFA_CODE_INVALID']);
    const ok = await post(app, '/mfa/enroll/confirm', { challenge: res.body.mfa.challenge, code: totp(start.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ token: expect.any(String), csrfToken: expect.any(String) });
    expect(ok.body.recoveryCodes).toHaveLength(10);
    expect(new Set(ok.body.recoveryCodes).size).toBe(10);
    for (const c of ok.body.recoveryCodes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(String(ok.headers['set-cookie'])).toContain('nurseapp_refresh=');
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${ok.body.token}`);
    expect(me.body.user.id).toBe(u.id);

    expect((await post(app, '/mfa/enroll/confirm', { challenge: res.body.mfa.challenge, code: totp(start.body.secret) })).body.error.code).toBe('MFA_CHALLENGE_INVALID');
    expect(await db.auditEntry.count({ where: { action: 'MFA_ENABLED', resourceId: String(u.id) } })).toBe(1);
    expect(await db.auditEntry.count({ where: { action: 'MFA_FAILED', resourceId: String(u.id) } })).toBe(1);
    expect(await db.notification.count({ where: { recipientId: u.id, type: 'SECURITY', title: 'Two-factor sign-in turned on' } })).toBe(1);
    const hashes = await db.mfaRecoveryCode.findMany({ where: { userId: u.id } });
    expect(JSON.stringify(hashes)).not.toContain(ok.body.recoveryCodes[0]);
  });

  it('later sign-ins need a current code, and each code works once', async () => {
    const u = await supervisor();
    const { secret, setupCode } = await enrol(app, u.email);
    const next = await login(app, u.email);
    expect(next.body.mfa.step).toBe('VERIFY');
    expect(next.body.mfa.expiresIn).toBe(300);
    // The code used to confirm the set-up is spent (that exact code: the clock may have moved to the next one since).
    expect((await post(app, '/mfa/verify', { challenge: next.body.mfa.challenge, code: setupCode })).body.error.code).toBe('MFA_CODE_INVALID');
    const code = await freshCode(u.id, secret);
    const ok = await post(app, '/mfa/verify', { challenge: next.body.mfa.challenge, code });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toEqual(expect.any(String));
    expect(ok.body.recoveryCodes).toBeUndefined();
    // Replay of the same code on a new challenge.
    const again = await login(app, u.email);
    expect((await post(app, '/mfa/verify', { challenge: again.body.mfa.challenge, code })).body.error.code).toBe('MFA_CODE_INVALID');
    // A used challenge is dead; a challenge of the other kind is refused.
    expect((await post(app, '/mfa/verify', { challenge: next.body.mfa.challenge, code: await freshCode(u.id, secret) })).body.error.code).toBe('MFA_CHALLENGE_INVALID');
    expect((await post(app, '/mfa/enroll/start', { challenge: again.body.mfa.challenge })).body.error.code).toBe('MFA_CHALLENGE_INVALID');
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'LOGIN_SUCCEEDED', resourceId: String(u.id) }, orderBy: { id: 'desc' } });
    expect(audit.changes).toEqual({ mfa: 'TOTP' });
  });

  it('an authenticator code is accepted with the space the apps display ("123 456")', async () => {
    const u = await supervisor();
    const first = await login(app, u.email);
    const { secret } = (await post(app, '/mfa/enroll/start', { challenge: first.body.mfa.challenge })).body;
    const spaced = (c: string) => `${c.slice(0, 3)} ${c.slice(3)}`;
    expect((await post(app, '/mfa/enroll/confirm', { challenge: first.body.mfa.challenge, code: spaced(totp(secret)) })).status).toBe(200);
    const next = await login(app, u.email);
    const ok = await post(app, '/mfa/verify', { challenge: next.body.mfa.challenge, code: ` ${spaced(await freshCode(u.id, secret))} ` });
    expect(ok.status).toBe(200);
    expect((await db.auditEntry.findFirstOrThrow({ where: { action: 'LOGIN_SUCCEEDED', resourceId: String(u.id) }, orderBy: { id: 'desc' } })).changes).toEqual({ mfa: 'TOTP' });
  });

  it('a recovery code signs in once, in any case and with or without the dash', async () => {
    const u = await hr();
    const { recoveryCodes } = await enrol(app, u.email);
    const code = recoveryCodes[3]!.toLowerCase().replace('-', '');
    const c1 = (await login(app, u.email)).body.mfa.challenge;
    expect((await post(app, '/mfa/verify', { challenge: c1, code })).status).toBe(200);
    const c2 = (await login(app, u.email)).body.mfa.challenge;
    expect((await post(app, '/mfa/verify', { challenge: c2, code: recoveryCodes[3] })).body.error.code).toBe('MFA_CODE_INVALID');
    expect(await db.auditEntry.count({ where: { action: 'MFA_RECOVERY_CODE_USED', resourceId: String(u.id) } })).toBe(1);
    expect(await db.mfaRecoveryCode.count({ where: { userId: u.id, usedAt: null } })).toBe(9);
    expect(await db.notification.count({ where: { recipientId: u.id, title: 'A recovery code was used to sign in' } })).toBe(1);
  });

  it('wrong codes are limited per challenge and per account', async () => {
    const u = await hr();
    const { secret } = await enrol(app, u.email);
    const c = (await login(app, u.email)).body.mfa.challenge;
    for (let i = 0; i < 5; i++) expect((await post(app, '/mfa/verify', { challenge: c, code: '000000' })).body.error.code).toBe('MFA_CODE_INVALID');
    expect((await post(app, '/mfa/verify', { challenge: c, code: await freshCode(u.id, secret) })).body.error.code).toBe('MFA_CHALLENGE_INVALID');

    const limited = testApp(db, { ...ON, LOGIN_THROTTLE_MAX_PER_ACCOUNT: '3', LOGIN_THROTTLE_MAX_PER_CLIENT: '50' });
    const v = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    const { secret: s2 } = await enrol(limited, v.email);
    for (let i = 0; i < 3; i++) {
      const ch = (await login(limited, v.email)).body.mfa.challenge;
      await post(limited, '/mfa/verify', { challenge: ch, code: '111111' });
    }
    const ch = (await login(limited, v.email)).body.mfa.challenge; // the password still works…
    const blocked = await post(limited, '/mfa/verify', { challenge: ch, code: await freshCode(v.id, s2) }); // …the code does not
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('staff may turn it on and off; a required role cannot turn it off; break-glass is never asked', async () => {
    const staff = (await makeNurse(db, org.unitA.id, { account: true })).user!;
    const s = await signIn(app, staff.email); // no step without an authenticator
    expect((await s.get('/auth/mfa')).body).toEqual({ enabled: false, enabledAt: null, required: false, available: true, recoveryCodesLeft: 0 });
    const setup = await s.post('/auth/mfa/setup');
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect((await s.post('/auth/mfa/setup/confirm', { code: '123456' })).status).toBe(401);
    const confirm = await s.post('/auth/mfa/setup/confirm', { code: totp(setup.body.secret) });
    expect(confirm.body.recoveryCodes).toHaveLength(10);
    expect((await s.post('/auth/mfa/setup')).body.error.code).toBe('MFA_ALREADY_ENABLED');
    expect((await login(app, staff.email)).body.mfa.step).toBe('VERIFY');
    expect((await s.get('/auth/mfa')).body).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });

    // New recovery codes need an authenticator code; the old ones stop working.
    expect((await s.post('/auth/mfa/recovery-codes', { code: confirm.body.recoveryCodes[0] })).body.error.code).toBe('MFA_CODE_INVALID');
    const regen = await s.post('/auth/mfa/recovery-codes', { code: await freshCode(staff.id, setup.body.secret) });
    expect(regen.body.recoveryCodes).toHaveLength(10);
    const c = (await login(app, staff.email)).body.mfa.challenge;
    expect((await post(app, '/mfa/verify', { challenge: c, code: confirm.body.recoveryCodes[0] })).body.error.code).toBe('MFA_CODE_INVALID');

    expect((await s.post('/auth/mfa/disable', { code: '000000' })).status).toBe(401);
    expect((await s.post('/auth/mfa/disable', { code: regen.body.recoveryCodes[0] })).status).toBe(204);
    expect((await login(app, staff.email)).body.token).toEqual(expect.any(String));

    // An account with an authenticator is always asked, even where its role does not require one.
    const admin = await hr();
    const { secret } = await enrol(app, admin.email);
    const relaxed = testApp(db);
    expect((await login(relaxed, admin.email)).body.mfa.step).toBe('VERIFY');
    const a = await signIn(relaxed, admin.email, PASSWORD, () => freshCode(admin.id, secret));
    expect((await a.get('/auth/mfa')).body).toMatchObject({ enabled: true, required: false });

    const bg = await makeUser(db, { isBreakGlass: true });
    const bgLogin = await login(app, bg.email);
    expect(bgLogin.body.token).toEqual(expect.any(String));
    const bgClient = await signIn(testApp(db, ON), bg.email);
    expect((await bgClient.post('/auth/mfa/setup')).body.error.code).toBe('BREAK_GLASS_ACCOUNT_PROTECTED');
  });

  it('a required role cannot turn it off itself', async () => {
    const u = await supervisor();
    const { secret } = await enrol(app, u.email);
    const c = (await login(app, u.email)).body.mfa.challenge;
    const res = await post(app, '/mfa/verify', { challenge: c, code: await freshCode(u.id, secret) });
    const csrf = res.body.csrfToken as string;
    const off = await request(app).post('/api/v1/auth/mfa/disable').set('Origin', ORIGIN).set('Authorization', `Bearer ${res.body.token}`).set('X-CSRF-Token', csrf)
      .send({ code: await freshCode(u.id, secret) });
    expect([off.status, off.body.error.code]).toEqual([403, 'MFA_REQUIRED']);
  });

  it('HR resets a lost authenticator: it is removed, the account is signed out, and set-up is asked again', async () => {
    const hrUser = await hr();
    const { secret } = await enrol(app, hrUser.email);
    const hrClient = await signIn(app, hrUser.email, PASSWORD, () => freshCode(hrUser.id, secret));
    const sup = await supervisor();
    await enrol(app, sup.email);
    expect((await hrClient.get('/users?q=' + encodeURIComponent(sup.email))).body.items[0].mfaEnabled).toBe(true);

    expect((await hrClient.post(`/users/${sup.id}/mfa/reset`)).status).toBe(204);
    expect(await db.mfaFactor.count({ where: { userId: sup.id } })).toBe(0);
    expect(await db.mfaRecoveryCode.count({ where: { userId: sup.id } })).toBe(0);
    expect(await db.refreshSession.count({ where: { userId: sup.id, revokedAt: null } })).toBe(0);
    expect((await login(app, sup.email)).body.mfa.step).toBe('ENROLL');
    expect(await db.auditEntry.count({ where: { action: 'MFA_RESET', resourceId: String(sup.id), priority: 'HIGH' } })).toBe(1);
    expect(await db.notification.count({ where: { recipientId: sup.id, title: 'Two-factor sign-in was reset' } })).toBe(1);

    expect((await hrClient.post(`/users/${sup.id}/mfa/reset`)).body.error.code).toBe('MFA_NOT_SET_UP');
    expect((await hrClient.post(`/users/${hrUser.id}/mfa/reset`)).body.error.code).toBe('SELF_ACTION_FORBIDDEN');
    expect((await hrClient.post(`/users/${(await makeUser(db, { isBreakGlass: true })).id}/mfa/reset`)).body.error.code).toBe('BREAK_GLASS_ACCOUNT_PROTECTED');
    const outOfScope = (await makeNurse(db, org.unitC.id, { account: true })).user!;
    const unitHr = await signIn(testApp(db), (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
    expect((await unitHr.post(`/users/${outOfScope.id}/mfa/reset`)).status).toBe(403);
    const supClient = await signIn(testApp(db), (await supervisor()).email);
    expect((await supClient.post(`/users/${sup.id}/mfa/reset`)).status).toBe(403);
  });

  it('production requires an encryption key and MFA for HR and System Admin', () => {
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://x/y', JWT_SECRET: 'x'.repeat(40), DOCUMENT_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), PDPL_FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 10).toString('base64'), PDPL_BLIND_INDEX_PEPPER: Buffer.alloc(32, 11).toString('base64') };
    expect(() => loadEnv(base)).toThrow(/MFA_ENCRYPTION_KEY: required in production/);
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(loadEnv({ ...base, MFA_ENCRYPTION_KEY: key }).MFA_REQUIRED_ROLES).toEqual(['SYSTEM_ADMIN', 'HR_ADMIN', 'SUPERVISOR']);
    expect(() => loadEnv({ ...base, MFA_ENCRYPTION_KEY: key, MFA_REQUIRED_ROLES: 'SYSTEM_ADMIN' })).toThrow(/must include SYSTEM_ADMIN and HR_ADMIN/);
    expect(() => loadEnv({ ...base, MFA_ENCRYPTION_KEY: key, MFA_REQUIRED_ROLES: 'none' })).toThrow(/must include SYSTEM_ADMIN and HR_ADMIN/);
    expect(() => loadEnv({ ...base, MFA_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 random bytes/);
    expect(() => loadEnv({ ...base, MFA_ENCRYPTION_KEY: key, MFA_REQUIRED_ROLES: 'SYSTEM_ADMIN,HR_ADMIN,NURSE' })).toThrow(/MFA_REQUIRED_ROLES/);
    expect(loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://x/y', JWT_SECRET: 'x'.repeat(40), MFA_REQUIRED_ROLES: 'none' }).MFA_REQUIRED_ROLES).toEqual([]);
  });
});
