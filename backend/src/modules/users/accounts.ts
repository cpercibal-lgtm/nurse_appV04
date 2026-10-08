// Login accounts (spec §8.1 Accounts: "Provision and administer within
// assigned scope"). An account's scope is its linked employee's unit; an
// account without an employee link can only be administered system-wide.
// HR can still provision an account with an initial password; registration by
// invitation (spec §3.2) is in invitations.ts.

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { assertUnchanged } from '../../lib/concurrency.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import { PasswordSchema, type PasswordService } from '../../lib/passwords.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { lockSystemAdminChanges, otherActiveSystemAdmins, unitScope, type AuthContext, type UnitScope } from './access.js';

const ADMIN_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'] as const;

export const CreateAccountBody = z.strictObject({
  email: z.email().max(254).transform((e) => e.trim().toLowerCase()),
  displayName: z.string().trim().min(1).max(120),
  password: PasswordSchema,
  employeeId: z.number().int().positive().nullable().optional(),
});

export const UpdateAccountBody = z.strictObject({
  displayName: z.string().trim().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  employeeId: z.number().int().positive().nullable().optional(),
});

export const ListAccountsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  active: z.enum(['true', 'false']).optional(),
});

const outOfScope = () => new HttpError(403, 'SCOPE_NOT_COVERED', 'This account is outside your assigned scope');

export async function assertEmployeeInScope(db: DbClient, scope: UnitScope, employeeId: number | null | undefined) {
  if (employeeId == null) {
    if (!scope.all) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'Only system-wide administrators can manage accounts without an employee link');
    return;
  }
  const emp = await db.employee.findFirst({ where: { id: employeeId, deletedAt: null }, select: { unitId: true } });
  if (!emp) throw new HttpError(422, 'EMPLOYEE_NOT_FOUND', 'The employee does not exist');
  if (!scope.all && (emp.unitId === null || !scope.unitIds.has(emp.unitId))) throw outOfScope();
}

export function createAccountService(db: Db, passwords: PasswordService) {
  async function list(auth: AuthContext, query: z.infer<typeof ListAccountsQuery>) {
    const scope = await unitScope(db, auth, ADMIN_ROLES);
    const users = await db.user.findMany({
      where: {
        ...(scope.all ? {} : { employee: { unitId: { in: [...scope.unitIds] } } }),
        ...(query.active ? { isActive: query.active === 'true' } : {}),
        ...(query.q ? { OR: [{ email: { contains: query.q, mode: 'insensitive' as const } }, { displayName: { contains: query.q, mode: 'insensitive' as const } }] } : {}),
      },
      select: {
        id: true, email: true, displayName: true, isActive: true, isBreakGlass: true, employeeId: true, lastLoginAt: true, createdAt: true, updatedAt: true,
        employee: { select: { jobNumber: true, fullName: true, unitId: true } },
        mfaFactor: { select: { confirmedAt: true } },
        telegramLinkedAt: true, // D-66: whether, never the chat id
        roleAssignments: { where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { role: true, scopeType: true } },
      },
      orderBy: { email: 'asc' },
    });
    return { items: users.map(({ mfaFactor, telegramLinkedAt, ...u }) => ({ ...u, mfaEnabled: Boolean(mfaFactor?.confirmedAt), telegramLinked: Boolean(telegramLinkedAt) })), total: users.length };
  }

  async function create(auth: AuthContext, body: z.infer<typeof CreateAccountBody>, requestId?: string) {
    const scope = await unitScope(db, auth, ADMIN_ROLES);
    await assertEmployeeInScope(db, scope, body.employeeId);
    const passwordHash = await passwords.hash(body.password);
    return db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: body.email, displayName: body.displayName, passwordHash, employeeId: body.employeeId ?? null },
        select: { id: true },
      });
      await appendAudit(tx, {
        actorUserId: auth.user.id, action: 'USER_CREATED', resource: 'user', resourceId: user.id,
        changes: { email: body.email, displayName: body.displayName, employeeId: body.employeeId ?? null }, requestId,
      });
      return user;
    });
  }

  /** `expected`: the version the caller loaded (If-Match); an account changed since is refused (STALE_RECORD). Signing in does not change the version. */
  async function update(auth: AuthContext, id: number, body: z.infer<typeof UpdateAccountBody>, requestId?: string, expected: Date | null = null) {
    const target = await db.user.findUnique({ where: { id }, select: { id: true, isActive: true, isBreakGlass: true, employeeId: true, displayName: true } });
    if (!target) throw notFound('Account not found');
    if (target.isBreakGlass) throw new HttpError(403, 'BREAK_GLASS_ACCOUNT_PROTECTED', 'The break-glass account is managed outside the application');
    if (id === auth.user.id && body.isActive === false) throw new HttpError(403, 'SELF_DEACTIVATION_FORBIDDEN', 'You cannot deactivate your own account');
    // Separation of duties: the employee link decides whose "own" records an
    // account sees, so nobody may re-link their own account.
    if (id === auth.user.id && body.employeeId !== undefined) throw new HttpError(403, 'SELF_UPDATE_FORBIDDEN', 'You cannot change the employee link of your own account');

    const scope = await unitScope(db, auth, ADMIN_ROLES);
    await assertEmployeeInScope(db, scope, target.employeeId); // may administer this account at all
    if (body.employeeId !== undefined) await assertEmployeeInScope(db, scope, body.employeeId); // and may link it there

    return db.$transaction(async (tx) => {
      if (body.isActive === false && target.isActive) {
        // R8: deactivating an account must not remove the last usable System Admin.
        await lockSystemAdminChanges(tx);
        const holdsSa = await tx.roleAssignment.count({ where: { userId: id, role: 'SYSTEM_ADMIN', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
        if (holdsSa > 0 && (await otherActiveSystemAdmins(tx, { userId: id })) === 0) {
          throw new HttpError(409, 'LAST_SYSTEM_ADMIN', 'This account holds the last active System Admin assignment (R8)');
        }
      }
      // After the System Admin lock above (same order as every other path), hold the account and compare versions.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id }, select: { updatedAt: true } });
      if (!current) throw notFound('Account not found');
      assertUnchanged(expected, current);
      const { updatedAt, ...updated } = await tx.user.update({ where: { id }, data: body, select: { id: true, isActive: true, displayName: true, employeeId: true, updatedAt: true } });
      if (body.isActive === false && target.isActive) {
        // Deactivation ends every session at once (authenticate checks the family).
        await tx.refreshSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await appendAudit(tx, {
        actorUserId: auth.user.id, action: body.isActive === false && target.isActive ? 'USER_DEACTIVATED' : 'USER_UPDATED',
        resource: 'user', resourceId: id,
        changes: { before: { isActive: target.isActive, displayName: target.displayName, employeeId: target.employeeId }, after: updated },
        requestId, priority: body.isActive === false ? 'HIGH' : 'NORMAL',
      });
      return { ...updated, updatedAt };
    });
  }

  return { list, create, update };
}
