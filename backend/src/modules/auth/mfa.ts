// MFA for privileged accounts (spec §3.5): an authenticator app (TOTP) plus
// single-use recovery codes. No identity provider is involved (SSO stays
// deferred); the factor belongs to the local account.
//
// Who is asked:
// - every account with a confirmed authenticator, at every sign-in;
// - holders of a role in MFA_REQUIRED_ROLES (System Admin, HR Admin,
//   Supervisor, Nursing Admin and Nursing Director by default) must set one up at their next sign-in before any
//   session is issued;
// - never the break-glass account (spec §3.6: it must work in an emergency
//   from the sealed envelopes; it has its own siren).
//
// Seeds are encrypted (lib/secret-box.ts); recovery codes and challenge tokens
// are stored as SHA-256. A code's 30-second step must be later than the last
// one accepted, so a code works once. Wrong codes count per account
// (`mfa:<id>`, the sign-in limits) and per challenge (5).

import crypto from 'node:crypto';
import type { Env } from '../../config/env.js';
import { appendAudit } from '../../lib/audit.js';
import { conflict, HttpError, notFound } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import type { SecretBox } from '../../lib/secret-box.js';
import { randomToken, sha256hex } from '../../lib/tokens.js';
import { matchTotp, newTotpSecret, otpauthUri } from '../../lib/totp.js';
import { assertEmployeeInScope } from '../users/accounts.js';
import { activeGrants, unitScope, type AuthContext } from '../users/access.js';

export const RECOVERY_CODE_COUNT = 10;
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const VERIFY_CHALLENGE_SECONDS = 5 * 60;
/** Longer: the person may first have to install an authenticator app. */
export const ENROLL_CHALLENGE_SECONDS = 15 * 60;
const ADMIN_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'] as const;

export type ChallengePurpose = 'VERIFY' | 'ENROLL';
export type FactorUsed = 'TOTP' | 'RECOVERY_CODE';

// Recovery codes: 10 characters from an alphabet without look-alikes, shown as XXXXX-XXXXX.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normaliseRecovery = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');
// Authenticator apps show a code as "123 456", and copying it may keep the space.
const normaliseTotp = (code: string) => code.replace(/\s/g, '');
const hashRecovery = (code: string) => sha256hex(`mfa-recovery:${normaliseRecovery(code)}`);
function newRecoveryCode() {
  const bytes = crypto.randomBytes(10);
  const raw = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export const mfaCodeInvalid = () => new HttpError(401, 'MFA_CODE_INVALID', 'That code is not correct. Enter the current code from your authenticator app, or a recovery code.');
export const mfaChallengeInvalid = () => new HttpError(401, 'MFA_CHALLENGE_INVALID', 'This sign-in step has expired. Sign in again.');

export function createMfa(db: Db, env: Env, box: SecretBox) {
  /** D-68: a development exemption set by `npm run mfa`; production never honours it. */
  async function exempt(tx: DbClient, userId: number) {
    if (env.NODE_ENV === 'production') return false;
    return (await tx.user.findUnique({ where: { id: userId }, select: { mfaExempt: true } }))?.mfaExempt ?? false;
  }

  /** VERIFY when the account has an authenticator, ENROLL when its roles require one, else null. */
  async function stepFor(tx: DbClient, user: { id: number; isBreakGlass: boolean }, now = new Date()): Promise<ChallengePurpose | null> {
    if (user.isBreakGlass) return null;
    if (await exempt(tx, user.id)) return null;
    const factor = await tx.mfaFactor.findUnique({ where: { userId: user.id }, select: { confirmedAt: true } });
    if (factor?.confirmedAt) return 'VERIFY';
    return (await isRequired(tx, user.id, now)) ? 'ENROLL' : null;
  }

  async function isRequired(tx: DbClient, userId: number, now = new Date()) {
    if (await exempt(tx, userId)) return false;
    const required = new Set<string>(env.MFA_REQUIRED_ROLES);
    return (await activeGrants(tx, userId, now)).some((g) => required.has(g.role));
  }

  async function createChallenge(tx: DbClient, userId: number, purpose: ChallengePurpose, now = new Date()) {
    const token = randomToken(32);
    const seconds = purpose === 'VERIFY' ? VERIFY_CHALLENGE_SECONDS : ENROLL_CHALLENGE_SECONDS;
    await tx.mfaChallenge.create({ data: { userId, purpose, tokenHash: sha256hex(token), expiresAt: new Date(now.getTime() + seconds * 1000) } });
    return { challenge: token, expiresIn: seconds };
  }

  /** Locks and returns a usable challenge of the given purpose, or throws. */
  async function takeChallenge(tx: DbClient, token: string, purpose: ChallengePurpose, now = new Date()) {
    const h = sha256hex(token);
    await tx.$queryRaw`SELECT id FROM mfa_challenges WHERE token_hash = ${h} FOR UPDATE`;
    const c = await tx.mfaChallenge.findUnique({ where: { tokenHash: h }, include: { user: { select: { id: true, email: true, isActive: true, isBreakGlass: true } } } });
    if (!c || c.purpose !== purpose || c.usedAt || c.expiresAt <= now || c.attempts >= CHALLENGE_MAX_ATTEMPTS || !c.user.isActive || c.user.isBreakGlass) throw mfaChallengeInvalid();
    return c;
  }

  /** Counts a wrong code on the challenge (in its own statement, so it survives the caller's rollback). */
  async function countFailure(challengeId: number) {
    await db.mfaChallenge.update({ where: { id: challengeId }, data: { attempts: { increment: 1 } } });
  }

  /** A new pending seed; replaces an earlier unconfirmed one. Refused when one is confirmed. */
  async function startSetup(tx: DbClient, user: { id: number; email: string }) {
    const existing = await tx.mfaFactor.findUnique({ where: { userId: user.id }, select: { confirmedAt: true } });
    if (existing?.confirmedAt) throw conflict('MFA_ALREADY_ENABLED', 'Two-factor sign-in is already set up for this account');
    const secret = newTotpSecret();
    await tx.mfaFactor.upsert({
      where: { userId: user.id },
      create: { userId: user.id, secretEnc: box.seal(secret) },
      update: { secretEnc: box.seal(secret), createdAt: new Date(), lastUsedStep: null },
    });
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  async function newRecoveryCodes(tx: DbClient, userId: number) {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: hashRecovery(c) })) });
    return codes;
  }

  /** Confirms the pending seed with its first code. Returns the recovery codes, or null for a wrong code. */
  async function confirmSetup(tx: DbClient, userId: number, code: string, now = new Date()) {
    await tx.$queryRaw`SELECT user_id FROM mfa_factors WHERE user_id = ${userId} FOR UPDATE`;
    const factor = await tx.mfaFactor.findUnique({ where: { userId } });
    if (!factor) throw conflict('MFA_SETUP_NOT_STARTED', 'Start the set-up again');
    if (factor.confirmedAt) throw conflict('MFA_ALREADY_ENABLED', 'Two-factor sign-in is already set up for this account');
    const step = matchTotp(box.open(factor.secretEnc), normaliseTotp(code), now.getTime());
    if (step === null) return null;
    await tx.mfaFactor.update({ where: { userId }, data: { confirmedAt: now, lastUsedStep: BigInt(step) } });
    return newRecoveryCodes(tx, userId);
  }

  /**
   * Checks a code against the confirmed factor: a TOTP code whose step is later
   * than the last one used, or an unused recovery code (consumed here).
   */
  async function verify(tx: DbClient, userId: number, input: string, now = new Date()): Promise<FactorUsed | null> {
    await tx.$queryRaw`SELECT user_id FROM mfa_factors WHERE user_id = ${userId} FOR UPDATE`;
    const factor = await tx.mfaFactor.findUnique({ where: { userId } });
    if (!factor?.confirmedAt) return null;
    const code = input.trim();
    const digits = normaliseTotp(code);
    if (/^\d{6}$/.test(digits)) {
      const step = matchTotp(box.open(factor.secretEnc), digits, now.getTime());
      if (step === null || (factor.lastUsedStep !== null && BigInt(step) <= factor.lastUsedStep)) return null;
      await tx.mfaFactor.update({ where: { userId }, data: { lastUsedStep: BigInt(step) } });
      return 'TOTP';
    }
    if (normaliseRecovery(code).length !== 10) return null;
    const used = await tx.mfaRecoveryCode.updateMany({ where: { userId, codeHash: hashRecovery(code), usedAt: null }, data: { usedAt: now } });
    return used.count === 1 ? 'RECOVERY_CODE' : null;
  }

  /** Removes the authenticator, its recovery codes and any open sign-in step. */
  async function remove(tx: DbClient, userId: number) {
    await tx.mfaChallenge.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaFactor.deleteMany({ where: { userId } });
  }

  async function notify(tx: DbClient, userId: number, key: string, title: string, message: string, titleAr: string, messageAr: string) {
    await tx.notification.createMany({
      data: [{ recipientId: userId, type: 'SECURITY', priority: 'HIGH', title, message, titleAr, messageAr, eventKey: `mfa:${key}` }],
      skipDuplicates: true,
    });
  }

  // ── Signed-in self-service ────────────────────────────────────────────────

  async function status(auth: AuthContext) {
    const [factor, left, required] = await Promise.all([
      db.mfaFactor.findUnique({ where: { userId: auth.user.id }, select: { confirmedAt: true } }),
      db.mfaRecoveryCode.count({ where: { userId: auth.user.id, usedAt: null } }),
      auth.user.isBreakGlass ? Promise.resolve(false) : isRequired(db, auth.user.id),
    ]);
    return {
      enabled: Boolean(factor?.confirmedAt), enabledAt: factor?.confirmedAt ?? null,
      required, available: !auth.user.isBreakGlass, recoveryCodesLeft: factor?.confirmedAt ? left : 0,
    };
  }

  async function setupSelf(auth: AuthContext, requestId?: string) {
    if (auth.user.isBreakGlass) throw new HttpError(403, 'BREAK_GLASS_ACCOUNT_PROTECTED', 'The break-glass account does not use two-factor sign-in (spec §3.6)');
    return db.$transaction(async (tx) => {
      const out = await startSetup(tx, auth.user);
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'MFA_SETUP_STARTED', resource: 'user', resourceId: auth.user.id, requestId });
      return out;
    });
  }

  async function confirmSelf(auth: AuthContext, code: string, requestId?: string) {
    const codes = await db.$transaction(async (tx) => {
      const c = await confirmSetup(tx, auth.user.id, code);
      if (!c) return null;
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'MFA_ENABLED', resource: 'user', resourceId: auth.user.id, requestId, priority: 'HIGH' });
      await notify(tx, auth.user.id, `enabled:${Date.now()}`, 'Two-factor sign-in turned on',
        'An authenticator app was set up for your account. If this was not you, tell HR at once.',
        'تم تفعيل التحقق الثنائي', 'تم ربط تطبيق مصادقة بحسابك. إذا لم تقم بذلك فأبلغ الموارد البشرية فوراً.');
      return c;
    });
    if (!codes) throw mfaCodeInvalid();
    return { recoveryCodes: codes };
  }

  /** New recovery codes; needs a current authenticator code (not a recovery code). */
  async function regenerateCodes(auth: AuthContext, code: string, requestId?: string) {
    if (!/^\d{6}$/.test(code.trim())) throw mfaCodeInvalid();
    const codes = await db.$transaction(async (tx) => {
      if ((await verify(tx, auth.user.id, code)) !== 'TOTP') return null;
      const c = await newRecoveryCodes(tx, auth.user.id);
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'MFA_RECOVERY_CODES_REGENERATED', resource: 'user', resourceId: auth.user.id, requestId, priority: 'HIGH' });
      return c;
    });
    if (!codes) throw mfaCodeInvalid();
    return { recoveryCodes: codes };
  }

  /** Turns it off — only for accounts whose roles do not require it. */
  async function disableSelf(auth: AuthContext, code: string, requestId?: string) {
    if (await isRequired(db, auth.user.id)) throw new HttpError(403, 'MFA_REQUIRED', 'Your role requires two-factor sign-in. If you lost your authenticator, ask HR to reset it.');
    const ok = await db.$transaction(async (tx) => {
      if (!(await verify(tx, auth.user.id, code))) return false;
      await remove(tx, auth.user.id);
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'MFA_DISABLED', resource: 'user', resourceId: auth.user.id, requestId, priority: 'HIGH' });
      return true;
    });
    if (!ok) throw mfaCodeInvalid();
  }

  // ── HR / System Admin ─────────────────────────────────────────────────────

  /**
   * A lost phone: removes the authenticator and signs the account out
   * everywhere. The person sets up a new one at the next sign-in (their role
   * requires it) — after confirming who they are, as for a password reset.
   */
  async function adminReset(auth: AuthContext, userId: number, requestId?: string) {
    const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, isBreakGlass: true, employeeId: true } });
    if (!target) throw notFound('Account not found');
    if (target.isBreakGlass) throw new HttpError(403, 'BREAK_GLASS_ACCOUNT_PROTECTED', 'The break-glass account is managed outside the application');
    if (target.id === auth.user.id) throw new HttpError(403, 'SELF_ACTION_FORBIDDEN', 'Another administrator must reset your two-factor sign-in');
    await assertEmployeeInScope(db, await unitScope(db, auth, ADMIN_ROLES), target.employeeId);
    await db.$transaction(async (tx) => {
      const had = await tx.mfaFactor.findUnique({ where: { userId }, select: { confirmedAt: true } });
      if (!had) throw conflict('MFA_NOT_SET_UP', 'This account has no two-factor sign-in to reset');
      await remove(tx, userId);
      await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'MFA_RESET', resource: 'user', resourceId: userId, changes: { wasConfirmed: Boolean(had.confirmedAt) }, requestId, priority: 'HIGH' });
      await notify(tx, userId, `reset:${Date.now()}`, 'Two-factor sign-in was reset',
        'An administrator removed the authenticator from your account and signed you out. Set up a new one at your next sign-in. If you did not ask for this, tell HR at once.',
        'تمت إعادة تعيين التحقق الثنائي', 'أزال أحد المسؤولين تطبيق المصادقة من حسابك. اضبط تطبيقاً جديداً عند تسجيل الدخول التالي.');
    });
  }

  return {
    stepFor, isRequired, createChallenge, takeChallenge, countFailure, startSetup, confirmSetup, verify, notify,
    status, setupSelf, confirmSelf, regenerateCodes, disableSelf, adminReset,
  };
}

export type MfaService = ReturnType<typeof createMfa>;
