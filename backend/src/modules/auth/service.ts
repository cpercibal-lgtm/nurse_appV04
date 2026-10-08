// Login, refresh rotation, logout, password change and the break-glass siren
// (spec §3.3, §3.4, §3.6; ported from V03 server/src/index.ts auth routes).

import type { Env } from '../../config/env.js';
import { appendAudit } from '../../lib/audit.js';
import { renderEmail } from '../../lib/email-templates.js';
import { HttpError } from '../../lib/http-errors.js';
import { describeError, logger } from '../../lib/logger.js';
import type { PasswordService } from '../../lib/passwords.js';
import type { TelegramGateway } from '../../lib/telegram.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import type { Throttle } from '../../lib/throttle.js';
import { constantTimeEqual, randomToken, sha256hex, type TokenService } from '../../lib/tokens.js';
import { activeBreakGlass, activeGrants, activePam, effectiveGrants, effectiveRoles, type AuthContext } from '../users/access.js';
import { mfaCodeInvalid, type ChallengePurpose, type MfaService } from './mfa.js';

/** Spec §3.6: a break-glass session is limited to 4 hours. */
export const BREAK_GLASS_SESSION_SECONDS = 4 * 3600;

export interface AuthDeps {
  db: Db;
  env: Env;
  tokens: TokenService;
  passwords: PasswordService;
  accountThrottle: Throttle;
  clientThrottle: Throttle;
  mfa: MfaService;
  /** Sends the break-glass alert by Telegram (D-66); the mock driver keeps it in the Dev Console. */
  telegram: TelegramGateway;
}

/** Password accepted; the second step (spec §3.5) is still needed. No cookie is set yet. */
export interface MfaStep { mfa: { step: ChallengePurpose; challenge: string; expiresIn: number } }

export interface IssuedSession {
  /** Cookie value "<sessionId>.<secret>"; only sha256(secret) is stored. */
  refreshCookie: string;
  csrfToken: string;
  token: string;
  expiresIn: number;
  /** Seconds until the absolute boundary — the cookies' max age. */
  cookieMaxAge: number;
}

/** Where a request came from; stored on the session row for the owner's history (D-22). */
export interface ClientMeta { ip: string; userAgent?: string }

const invalidCredentials = () => new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
const sessionEnded = () => new HttpError(401, 'SESSION_EXPIRED', 'Your session has ended — sign in again');

export function createAuthService(deps: AuthDeps) {
  const { db, env, tokens, passwords } = deps;

  async function issue(tx: DbClient, userId: number, family: string, idleUntil: Date, absoluteUntil: Date, now: Date, meta: ClientMeta): Promise<IssuedSession> {
    const id = randomToken(16);
    const secret = randomToken(32);
    const expiresAt = new Date(Math.min(idleUntil.getTime(), absoluteUntil.getTime()));
    await tx.refreshSession.create({
      data: { id, userId, tokenHash: sha256hex(secret), familyId: family, expiresAt, absoluteExpiresAt: absoluteUntil, ipAddress: meta.ip.slice(0, 45), userAgent: meta.userAgent?.slice(0, 300) ?? null },
    });
    const csrfToken = randomToken(24);
    return {
      refreshCookie: `${id}.${secret}`,
      csrfToken,
      token: tokens.sign({ sub: userId, sid: family, csrf: sha256hex(csrfToken) }, now.getTime()),
      expiresIn: tokens.ttlSeconds,
      cookieMaxAge: Math.max(0, Math.floor((absoluteUntil.getTime() - now.getTime()) / 1000)),
    };
  }

  async function login(emailRaw: string, password: string, clientIp: string, requestId?: string, userAgent?: string) {
    const email = emailRaw.trim().toLowerCase();
    const accountKey = `acct:${email}`;
    const clientKey = `ip:${clientIp}`;
    const wait = Math.max(await deps.accountThrottle.blockedFor(accountKey), await deps.clientThrottle.blockedFor(clientKey));
    if (wait > 0) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts — try again later', { retryAfterSeconds: wait });

    const user = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    const ok = await passwords.verify(password, user?.passwordHash);

    if (!user || !ok || !user.isActive) {
      await deps.accountThrottle.fail(accountKey);
      await deps.clientThrottle.fail(clientKey);
      // Audited only for a real account: an unknown email is not personal data we hold.
      if (user) {
        await appendAudit(db, {
          actorUserId: null, action: 'LOGIN_FAILED', resource: 'user', resourceId: String(user.id),
          changes: { reason: !ok ? 'bad_password' : 'inactive' }, requestId, priority: user.isBreakGlass ? 'HIGH' : 'NORMAL',
        });
      }
      throw invalidCredentials();
    }
    await deps.accountThrottle.reset(accountKey);

    const now = new Date();
    const step = await deps.mfa.stepFor(db, user, now);
    if (step) {
      return db.$transaction(async (tx): Promise<MfaStep> => {
        const c = await deps.mfa.createChallenge(tx, user.id, step, now);
        await appendAudit(tx, { actorUserId: null, action: 'LOGIN_MFA_REQUIRED', resource: 'user', resourceId: String(user.id), changes: { step }, requestId });
        return { mfa: { step, ...c } };
      });
    }
    const session = await db.$transaction((tx) => completeLogin(tx, user, now, { ip: clientIp, userAgent }, requestId));
    // Break-glass is never asked for a second step, so this is its only way in.
    if (user.isBreakGlass) await telegramSiren(user.id, now, requestId);
    return session;
  }

  const sessionSeconds = (breakGlass: boolean) => (breakGlass ? Math.min(BREAK_GLASS_SESSION_SECONDS, env.SESSION_ABSOLUTE_SECONDS) : env.SESSION_ABSOLUTE_SECONDS);

  /** Issues the session for a fully authenticated sign-in (after the password, and the second step if any). */
  async function completeLogin(tx: DbClient, user: { id: number; isBreakGlass: boolean }, now: Date, meta: ClientMeta, requestId?: string, mfaUsed?: string) {
    const absoluteSeconds = sessionSeconds(user.isBreakGlass);
    if (user.isBreakGlass) await sirenOnLogin(tx, user.id, meta.ip, now, absoluteSeconds, requestId);
    const session = await issue(tx, user.id, randomToken(16), new Date(now.getTime() + env.SESSION_IDLE_SECONDS * 1000), new Date(now.getTime() + absoluteSeconds * 1000), now, meta);
    // Raw, so updated_at stays: it is the account's version for edits (If-Match), and a sign-in is not an edit.
    await tx.$executeRaw`UPDATE users SET last_login_at = ${now} WHERE id = ${user.id}`;
    await appendAudit(tx, {
      actorUserId: user.id, action: 'LOGIN_SUCCEEDED', resource: 'user', resourceId: String(user.id), requestId,
      ...(mfaUsed ? { changes: { mfa: mfaUsed } } : {}), priority: user.isBreakGlass ? 'HIGH' : 'NORMAL',
    });
    return session;
  }

  async function clientBlocked(clientIp: string) {
    const wait = await deps.clientThrottle.blockedFor(`ip:${clientIp}`);
    if (wait > 0) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts — try again later', { retryAfterSeconds: wait });
  }

  /** A wrong second-step code: counted on the challenge, the account and the client, and audited. */
  async function mfaFailed(challengeId: number, userId: number, clientIp: string, requestId?: string): Promise<never> {
    await deps.mfa.countFailure(challengeId);
    await deps.accountThrottle.fail(`mfa:${userId}`);
    await deps.clientThrottle.fail(`ip:${clientIp}`);
    await appendAudit(db, { actorUserId: null, action: 'MFA_FAILED', resource: 'user', resourceId: String(userId), requestId, priority: 'HIGH' });
    throw mfaCodeInvalid();
  }

  const mfaLocked = (wait: number) => new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes — try again later', { retryAfterSeconds: wait });

  /** Second step for an account with an authenticator: a current code or an unused recovery code. */
  async function mfaVerify(challenge: string, code: string, clientIp: string, requestId?: string, userAgent?: string): Promise<IssuedSession> {
    await clientBlocked(clientIp);
    const now = new Date();
    const out = await db.$transaction(async (tx) => {
      const c = await deps.mfa.takeChallenge(tx, challenge, 'VERIFY', now);
      const wait = await deps.accountThrottle.blockedFor(`mfa:${c.userId}`);
      if (wait > 0) return { wait };
      const used = await deps.mfa.verify(tx, c.userId, code, now);
      if (!used) return { failedChallenge: c.id, userId: c.userId };
      await tx.mfaChallenge.update({ where: { id: c.id }, data: { usedAt: now } });
      if (used === 'RECOVERY_CODE') {
        const left = await tx.mfaRecoveryCode.count({ where: { userId: c.userId, usedAt: null } });
        await appendAudit(tx, { actorUserId: c.userId, action: 'MFA_RECOVERY_CODE_USED', resource: 'user', resourceId: String(c.userId), changes: { remaining: left }, requestId, priority: 'HIGH' });
        await deps.mfa.notify(tx, c.userId, `recovery:${c.id}`, 'A recovery code was used to sign in',
          `You signed in with a recovery code; ${left} remain. Each code works once. If this was not you, tell HR at once.`,
          'تم استخدام رمز استرداد لتسجيل الدخول', `سجلت الدخول برمز استرداد؛ تبقى ${left}. إذا لم تكن أنت فأبلغ الموارد البشرية فوراً.`);
      }
      return { session: await completeLogin(tx, c.user, now, { ip: clientIp, userAgent }, requestId, used), userId: c.userId };
    });
    if ('wait' in out) throw mfaLocked(out.wait!);
    if ('failedChallenge' in out) return mfaFailed(out.failedChallenge!, out.userId!, clientIp, requestId);
    await deps.accountThrottle.reset(`mfa:${out.userId}`);
    return out.session!;
  }

  /** Second step when the role requires an authenticator the account does not have yet: a new seed to scan. */
  async function mfaEnrollStart(challenge: string, clientIp: string) {
    await clientBlocked(clientIp);
    return db.$transaction(async (tx) => {
      const c = await deps.mfa.takeChallenge(tx, challenge, 'ENROLL');
      return { ...(await deps.mfa.startSetup(tx, c.user)), account: c.user.email };
    });
  }

  /** Confirms the new authenticator with its first code; signs in and returns the recovery codes (shown once). */
  async function mfaEnrollConfirm(challenge: string, code: string, clientIp: string, requestId?: string, userAgent?: string) {
    await clientBlocked(clientIp);
    const now = new Date();
    const out = await db.$transaction(async (tx) => {
      const c = await deps.mfa.takeChallenge(tx, challenge, 'ENROLL', now);
      const wait = await deps.accountThrottle.blockedFor(`mfa:${c.userId}`);
      if (wait > 0) return { wait };
      const codes = await deps.mfa.confirmSetup(tx, c.userId, code, now);
      if (!codes) return { failedChallenge: c.id, userId: c.userId };
      await tx.mfaChallenge.update({ where: { id: c.id }, data: { usedAt: now } });
      await appendAudit(tx, { actorUserId: c.userId, action: 'MFA_ENABLED', resource: 'user', resourceId: String(c.userId), changes: { at: 'sign-in' }, requestId, priority: 'HIGH' });
      await deps.mfa.notify(tx, c.userId, `enabled:${c.id}`, 'Two-factor sign-in turned on',
        'An authenticator app was set up for your account at sign-in. If this was not you, tell HR at once.',
        'تم تفعيل التحقق الثنائي', 'تم ربط تطبيق مصادقة بحسابك عند تسجيل الدخول. إذا لم تقم بذلك فأبلغ الموارد البشرية فوراً.');
      return { session: await completeLogin(tx, c.user, now, { ip: clientIp, userAgent }, requestId, 'ENROLLED'), codes, userId: c.userId };
    });
    if ('wait' in out) throw mfaLocked(out.wait!);
    if ('failedChallenge' in out) return mfaFailed(out.failedChallenge!, out.userId!, clientIp, requestId);
    await deps.accountThrottle.reset(`mfa:${out.userId}`);
    return { session: out.session!, recoveryCodes: out.codes! };
  }

  /**
   * Break-glass siren (spec §3.6, decision D-9): irrevocable event row, HIGH
   * audit entry, a CRITICAL in-app notification (and e-mail) to every System
   * Admin, and an e-mail to each BREAK_GLASS_ALERT_EMAILS address — the CEO and
   * IT Director (D-47). The Telegram alert (D-66) follows the commit: telegramSiren.
   */
  async function sirenOnLogin(tx: DbClient, userId: number, ip: string, now: Date, seconds: number, requestId?: string) {
    const event = await tx.breakGlassEvent.create({
      data: { actorUserId: userId, reason: 'Break-glass account sign-in', ipAddress: ip, activatedAt: now, expiresAt: new Date(now.getTime() + seconds * 1000) },
    });
    await appendAudit(tx, { actorUserId: userId, action: 'BREAK_GLASS_ACTIVATED', resource: 'break_glass_event', resourceId: String(event.id), changes: { ipAddress: ip, expiresAt: event.expiresAt.toISOString() }, requestId, priority: 'HIGH' });
    const admins = await tx.roleAssignment.findMany({
      where: { role: 'SYSTEM_ADMIN', revokedAt: null, userId: { not: userId }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { userId: true }, distinct: ['userId'],
    });
    if (admins.length > 0) {
      await tx.notification.createMany({
        data: admins.map((a) => ({
          recipientId: a.userId, type: 'SECURITY' as const, priority: 'CRITICAL' as const,
          title: 'Break-glass account activated',
          message: `The break-glass account signed in from ${ip}. The session ends at ${event.expiresAt.toISOString()} (UTC).`,
          titleAr: 'تم تفعيل حساب الطوارئ',
          messageAr: `تم تسجيل الدخول بحساب الطوارئ من ${ip}.`,
          eventKey: `break-glass:${event.id}`,
        })),
        skipDuplicates: true,
      });
    }
    if (env.BREAK_GLASS_ALERT_EMAILS.length > 0) {
      const mail = renderEmail({
        title: 'Break-glass account activated',
        message: `The AIGH Nursing Workforce break-glass (emergency) account signed in from ${ip} at ${now.toISOString()} (UTC). The session ends at ${event.expiresAt.toISOString()} (UTC). Every action it takes is audited.`,
        titleAr: 'تم تفعيل حساب الطوارئ',
        messageAr: `تم تسجيل الدخول بحساب الطوارئ من ${ip}. جميع الإجراءات مسجلة في سجل التدقيق.`,
      });
      await tx.emailOutbox.createMany({
        data: env.BREAK_GLASS_ALERT_EMAILS.map((to) => ({
          toAddress: to, subject: mail.subject, bodyText: mail.text, bodyHtml: mail.html, priority: 'CRITICAL' as const, eventKey: `break-glass:${event.id}`,
        })),
        skipDuplicates: true,
      });
    }
  }

  /**
   * The break-glass alert by Telegram to each BREAK_GLASS_ALERT_TELEGRAM_CHAT_IDS
   * chat (spec §3.6, D-66). Sent after the sign-in is committed: a slow or failing
   * gateway must never hold up or undo emergency access. No personal data: the
   * times only, not the client address. The outcome is audited HIGH either way.
   */
  async function telegramSiren(userId: number, now: Date, requestId?: string) {
    const chats = env.BREAK_GLASS_ALERT_TELEGRAM_CHAT_IDS;
    if (chats.length === 0) return;
    const at = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const ends = new Date(now.getTime() + sessionSeconds(true) * 1000);
    const text = `AIGH Workforce: the break-glass (emergency) account signed in at ${at(now)}. The session ends ${at(ends)}. Every action is audited.\n\n`
      + `تم تسجيل الدخول بحساب الطوارئ. جميع الإجراءات مسجلة في سجل التدقيق.`;
    const sent = await Promise.all(chats.map((c) => deps.telegram.send(c, text)));
    const failed = sent.filter((r) => !r.accepted).length;
    await appendAudit(db, {
      actorUserId: userId, action: failed === 0 ? 'BREAK_GLASS_TELEGRAM_SENT' : 'BREAK_GLASS_TELEGRAM_FAILED', resource: 'user', resourceId: String(userId),
      changes: { driver: deps.telegram.driver, sent: sent.length - failed, failed }, requestId, priority: 'HIGH',
    }).catch((e) => logger.error('break-glass Telegram outcome not audited', describeError(e)));
  }

  /**
   * Rotate the refresh token. The presented token is consumed atomically; a
   * token that was already consumed is treated as theft and the whole family
   * is revoked (spec §3.3 "consumed atomically — replay is rejected").
   */
  async function refresh(cookieValue: string | undefined, requestId?: string, meta: ClientMeta = { ip: 'unknown' }): Promise<IssuedSession> {
    const [id, secret] = (cookieValue ?? '').split('.');
    if (!id || !secret) throw sessionEnded();
    const session = await db.refreshSession.findUnique({ where: { id } });
    if (!session || !constantTimeEqual(session.tokenHash, sha256hex(secret))) throw sessionEnded();

    const now = new Date();
    const revokeFamily = () => db.refreshSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: now } });

    if (session.revokedAt) {
      await revokeFamily();
      await appendAudit(db, { actorUserId: session.userId, action: 'REFRESH_TOKEN_REUSE', resource: 'user', resourceId: String(session.userId), requestId, priority: 'HIGH' });
      throw new HttpError(401, 'SESSION_REVOKED', 'This session was ended for your protection — sign in again');
    }
    if (session.expiresAt <= now || session.absoluteExpiresAt <= now) throw sessionEnded();

    const user = await db.user.findUnique({ where: { id: session.userId } });
    if (!user?.isActive) { await revokeFamily(); throw sessionEnded(); }
    if (user.isBreakGlass && !(await activeBreakGlass(db, user.id, now))) { await revokeFamily(); throw sessionEnded(); }

    return db.$transaction(async (tx) => {
      const consumed = await tx.refreshSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
      if (consumed.count !== 1) throw new HttpError(401, 'SESSION_REVOKED', 'This session was ended for your protection — sign in again');
      return issue(tx, user.id, session.familyId, new Date(now.getTime() + env.SESSION_IDLE_SECONDS * 1000), session.absoluteExpiresAt, now, meta);
    });
  }

  /** Ends the whole session family, so access tokens minted from it stop working at once. */
  async function logout(cookieValue: string | undefined, requestId?: string) {
    const [id] = (cookieValue ?? '').split('.');
    if (!id) return;
    const session = await db.refreshSession.findUnique({ where: { id } });
    if (!session) return;
    await db.$transaction(async (tx) => {
      await tx.refreshSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      await appendAudit(tx, { actorUserId: session.userId, action: 'LOGOUT', resource: 'user', resourceId: String(session.userId), requestId });
    });
  }

  /** Spec §3.3: verifies the current password and revokes all active sessions. */
  async function changePassword(auth: AuthContext, current: string, next: string, requestId?: string) {
    const accountKey = `acct:${auth.user.email.toLowerCase()}`;
    if (await deps.accountThrottle.blockedFor(accountKey) > 0) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts — try again later');
    const user = await db.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    if (!(await passwords.verify(current, user.passwordHash))) {
      await deps.accountThrottle.fail(accountKey);
      throw new HttpError(400, 'CURRENT_PASSWORD_WRONG', 'The current password is not correct');
    }
    if (current === next) throw new HttpError(400, 'PASSWORD_UNCHANGED', 'Choose a password different from the current one');
    const passwordHash = await passwords.hash(next);
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.refreshSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await appendAudit(tx, { actorUserId: user.id, action: 'PASSWORD_CHANGED', resource: 'user', resourceId: String(user.id), requestId, priority: 'HIGH' });
    });
  }

  /** GET /auth/me — identity, stored grants, what is usable now, PAM and break-glass state. */
  async function me(auth: AuthContext) {
    const now = new Date();
    const [grants, pam, breakGlass] = await Promise.all([
      activeGrants(db, auth.user.id, now), activePam(db, auth.user.id, now),
      auth.user.isBreakGlass ? activeBreakGlass(db, auth.user.id, now) : Promise.resolve(null),
    ]);
    const effective = effectiveGrants(grants, pam, breakGlass);
    return {
      user: auth.user,
      roles: grants.map((g) => ({ ...g, dormant: g.role === 'SYSTEM_ADMIN' && !pam && !breakGlass })),
      effectiveRoles: effectiveRoles({ ...auth, effective }),
      pam: pam ? { expiresAt: pam.expiresAt } : null,
      breakGlass: breakGlass ? { expiresAt: breakGlass.expiresAt } : null,
    };
  }

  /**
   * D-22: the caller's own sign-ins, newest first. One entry per session
   * family (a sign-in and its refreshes): where it started, where it was last
   * refreshed, and whether it can still be used.
   */
  async function sessions(auth: AuthContext, now = new Date()) {
    const rows = await db.refreshSession.findMany({
      where: { userId: auth.user.id },
      select: { familyId: true, createdAt: true, expiresAt: true, absoluteExpiresAt: true, revokedAt: true, ipAddress: true, userAgent: true },
      orderBy: { createdAt: 'asc' },
    });
    const families = new Map<string, typeof rows>();
    for (const r of rows) families.set(r.familyId, [...(families.get(r.familyId) ?? []), r]);
    const items = [...families.entries()].map(([familyId, list]) => {
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = list.some((r) => !r.revokedAt && r.expiresAt > now && r.absoluteExpiresAt > now);
      return {
        current: familyId === auth.sessionFamily, active,
        signedInAt: first.createdAt, lastActiveAt: last.createdAt, endsBy: first.absoluteExpiresAt,
        signInIp: first.ipAddress, signInUserAgent: first.userAgent, lastIp: last.ipAddress, lastUserAgent: last.userAgent,
      };
    }).sort((a, b) => b.signedInAt.getTime() - a.signedInAt.getTime()).slice(0, 50);
    return { items, total: items.length };
  }

  return { login, mfaVerify, mfaEnrollStart, mfaEnrollConfirm, refresh, logout, changePassword, me, sessions };
}

export type AuthService = ReturnType<typeof createAuthService>;
