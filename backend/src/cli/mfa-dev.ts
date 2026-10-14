// Development switch for two-factor sign-in (spec §3.5, D-51), so a local
// tester is not stuck behind an authenticator:
//
//   npm run mfa -w backend -- status            which roles must use it; who has it
//   npm run mfa -w backend -- off [ROLE...]     stop asking (default SYSTEM_ADMIN)
//   npm run mfa -w backend -- on  [ROLE...]     ask again (set-up at the next sign-in)
//   npm run mfa -w backend -- off <email|id>    one account: password only (D-68)
//   npm run mfa -w backend -- on  <email|id>    one account: clear that exemption
//
// Roles: `off` takes them out of MFA_REQUIRED_ROLES in backend/.env and removes
// the authenticator (and recovery codes) of every account holding one of
// them: an account with an authenticator is always asked, whatever its role.
// `on` puts the roles back; those accounts set up a new authenticator at their
// next sign-in. Restart the backend after either. Each removal is audited HIGH.
//
// One account: `off` removes its authenticator and sets users.mfa_exempt, so
// it is never asked for a second step; `on` clears it. Read at each sign-in,
// so no restart. Audited HIGH (MFA_DEV_EXEMPTED / MFA_DEV_EXEMPTION_CLEARED).
//
// Refused with NODE_ENV=production: there the roles are mandatory (env.ts) and
// the API ignores exemptions.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { appendAudit } from '../lib/audit.js';
import { loadEnv } from '../config/env.js';
import { createPrisma, type Db } from '../lib/prisma.js';

export const MFA_ROLES = ['SYSTEM_ADMIN', 'HR_ADMIN', 'SUPERVISOR', 'NURSING_ADMIN', 'NURSING_DIRECTOR'] as const;
export type MfaRole = (typeof MFA_ROLES)[number];

/** Returns the .env text with MFA_REQUIRED_ROLES set to `roles` ("none" when empty); every other line is kept. */
export function setRequiredRoles(envText: string, roles: readonly string[]): string {
  const value = roles.length ? roles.join(',') : 'none';
  const eol = envText.includes('\r\n') ? '\r\n' : '\n';
  const lines = envText.split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*MFA_REQUIRED_ROLES\s*=/.test(l));
  if (i >= 0) lines[i] = `MFA_REQUIRED_ROLES=${value}`;
  else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(`MFA_REQUIRED_ROLES=${value}`, '');
  }
  return lines.join(eol);
}

/** Accounts (not break-glass) holding an active grant of one of the roles. */
async function holders(db: Db, roles: readonly MfaRole[], now = new Date()) {
  return db.user.findMany({
    where: {
      isBreakGlass: false,
      roleAssignments: { some: { role: { in: [...roles] }, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } },
    },
    select: { id: true, email: true, mfaExempt: true, mfaFactor: { select: { confirmedAt: true } } },
    orderBy: { id: 'asc' },
  });
}

/** Removes the authenticators of the given accounts, as the HR reset does, audited. */
export async function removeAuthenticators(db: Db, userIds: number[]) {
  let removed = 0;
  for (const userId of userIds) {
    await db.$transaction(async (tx) => {
      const had = await tx.mfaFactor.findUnique({ where: { userId }, select: { confirmedAt: true } });
      if (!had) return;
      await tx.mfaChallenge.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.mfaFactor.deleteMany({ where: { userId } });
      await appendAudit(tx, { actorUserId: null, action: 'MFA_RESET', resource: 'user', resourceId: userId, changes: { wasConfirmed: Boolean(had.confirmedAt), via: 'cli mfa off (development)' }, priority: 'HIGH' });
      removed++;
    });
  }
  return removed;
}

/** An account by e-mail (any case) or numeric id; null when there is none. */
export async function findAccount(db: Db, who: string) {
  const select = { id: true, email: true, isBreakGlass: true, mfaExempt: true } as const;
  if (/^\d+$/.test(who)) return db.user.findUnique({ where: { id: Number(who) }, select });
  return db.user.findFirst({ where: { email: { equals: who.trim(), mode: 'insensitive' } }, select });
}

/**
 * D-68, one account: `off` removes its authenticator and exempts it (password only, whatever its
 * role requires); `on` clears the exemption (a required role sets up a new authenticator at the next
 * sign-in). Audited HIGH. Answers what changed.
 */
export async function setAccountExemption(db: Db, userId: number, exemptNow: boolean) {
  return db.$transaction(async (tx) => {
    const u = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaExempt: true } });
    let removed = false;
    if (exemptNow) {
      const had = await tx.mfaFactor.findUnique({ where: { userId }, select: { confirmedAt: true } });
      if (had) {
        await tx.mfaChallenge.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
        await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
        await tx.mfaFactor.deleteMany({ where: { userId } });
        removed = true;
      }
    }
    if (u.mfaExempt !== exemptNow) await tx.user.update({ where: { id: userId }, data: { mfaExempt: exemptNow } });
    if (removed || u.mfaExempt !== exemptNow) {
      await appendAudit(tx, {
        actorUserId: null, action: exemptNow ? 'MFA_DEV_EXEMPTED' : 'MFA_DEV_EXEMPTION_CLEARED', resource: 'user', resourceId: userId,
        changes: { authenticatorRemoved: removed, via: `cli mfa ${exemptNow ? 'off' : 'on'} (development)` }, priority: 'HIGH',
      });
    }
    return { changed: u.mfaExempt !== exemptNow, authenticatorRemoved: removed };
  });
}

function parseRoles(args: string[]): MfaRole[] {
  const roles = args.length ? args.map((a) => a.toUpperCase()) : ['SYSTEM_ADMIN'];
  for (const r of roles) if (!(MFA_ROLES as readonly string[]).includes(r)) throw new Error(`unknown role ${r} (one of ${MFA_ROLES.join(', ')})`);
  return roles as MfaRole[];
}

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (!['status', 'off', 'on'].includes(action ?? '')) {
    console.log([
      'usage: npm run mfa -w backend -- status',
      '       npm run mfa -w backend -- off|on [ROLE...]        roles (SYSTEM_ADMIN default, HR_ADMIN, SUPERVISOR, NURSING_ADMIN, NURSING_DIRECTOR); restart the backend after',
      '       npm run mfa -w backend -- off|on <email|id>       one account: exempt it (password only) or clear the exemption; no restart',
    ].join('\n'));
    process.exitCode = 2;
    return;
  }
  const env = loadEnv();
  if (env.NODE_ENV === 'production') throw new Error('refused: two-factor sign-in is mandatory in production (spec §3.5)');
  const envFile = path.resolve('.env');
  const required = new Set<string>(env.MFA_REQUIRED_ROLES);
  const db = createPrisma(env.DATABASE_URL);
  try {
    if (action === 'status') {
      console.log(`MFA_REQUIRED_ROLES: ${[...required].join(',') || 'none'}   (the running backend uses the value it started with)`);
      for (const u of await holders(db, MFA_ROLES)) console.log(`  ${u.email}: authenticator ${u.mfaFactor?.confirmedAt ? 'on' : u.mfaFactor ? 'set-up started' : 'none'}${u.mfaExempt ? ' — EXEMPT (password only)' : ''}`);
      return;
    }
    // One account (an e-mail or an id rather than a role name).
    const who = rest[0];
    if (rest.length === 1 && who && !(MFA_ROLES as readonly string[]).includes(who.toUpperCase())) {
      const u = await findAccount(db, who);
      if (!u) { console.error(`No account "${who}".`); process.exitCode = 1; return; }
      if (u.isBreakGlass) { console.log(`${u.email} is the break-glass account: it is never asked for a second step.`); return; }
      const out = await setAccountExemption(db, u.id, action === 'off');
      if (action === 'off') {
        console.log(out.changed || out.authenticatorRemoved
          ? `${u.email}: two-factor OFF — password only${out.authenticatorRemoved ? '; its authenticator and recovery codes were removed' : ''}. Takes effect at the next sign-in.`
          : `${u.email}: already exempt.`);
      } else {
        const needs = [...required].length > 0 && (await holders(db, [...required] as MfaRole[])).some((h) => h.id === u.id);
        console.log(!out.changed ? `${u.email}: was not exempt.` : needs
          ? `${u.email}: exemption cleared — its role requires two-factor, so it sets up an authenticator at the next sign-in.`
          : `${u.email}: exemption cleared — its role does not require two-factor; it can turn it on in My account → Security.`);
      }
      return;
    }
    const roles = parseRoles(rest);
    for (const r of roles) (action === 'off' ? required.delete(r) : required.add(r));
    const next = MFA_ROLES.filter((r) => required.has(r));
    const text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    fs.writeFileSync(envFile, setRequiredRoles(text, next));
    console.log(`MFA_REQUIRED_ROLES=${next.join(',') || 'none'} written to ${envFile}`);
    if (action === 'off') {
      const accounts = await holders(db, roles);
      const removed = await removeAuthenticators(db, accounts.map((u) => u.id));
      console.log(`Authenticators removed: ${removed} (${accounts.map((u) => u.email).join(', ') || 'no accounts with these roles'})`);
    } else {
      console.log(`Accounts with ${roles.join(', ')} set up an authenticator at their next sign-in.`);
    }
    console.log('Restart the backend for this to take effect.');
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && /mfa-dev\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => { console.error((e as Error).message); process.exit(1); });
}
