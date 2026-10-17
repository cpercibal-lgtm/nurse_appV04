// Scoped role assignments (rules R1–R12; docs/FEATURE_MASTER_INVENTORY.md §15).
// Ported from the V03 NestJS reference (backend/src/modules/roles/roles.service.ts),
// with its simplified scope check replaced by a real one: a DEPARTMENT grant
// needs the granter to hold that department, a UNIT grant needs every unit
// covered, and SYSTEM needs a system-wide granter (R6).

import { inTransaction, type Transaction } from '../../lib/transaction.js';
import { z } from 'zod';
import type { AppRole, ScopeType } from '../../generated/prisma/client.js';
import { appendAudit } from '../../lib/audit.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { lockSystemAdminChanges, otherActiveSystemAdmins, scopeCovers, unitScope, unitsOfScope, type AuthContext } from './access.js';

const ADMIN_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'] as const;
const DAY_MS = 24 * 3600_000;
/**
 * R5 maximum assignment windows. Source: V03 NestJS reference implementation
 * (roles.service.ts); NOT stated in the specification — flagged in RBAC.md.
 */
export const MAX_EXPIRY_DAYS: Record<AppRole, number> = { SUPERVISOR: 90, NURSING_ADMIN: 365, NURSING_DIRECTOR: 365, HR_ADMIN: 365, SYSTEM_ADMIN: 365 };

// R1: EMPLOYEE is implicit and not grantable — it is simply not in this enum.
const Role = z.enum(['SYSTEM_ADMIN', 'HR_ADMIN', 'SUPERVISOR', 'NURSING_ADMIN', 'NURSING_DIRECTOR']);
const Scope = z.enum(['SYSTEM', 'DEPARTMENT', 'UNIT']);
const ScopeIds = z.array(z.number().int().positive()).max(200).transform((ids) => [...new Set(ids)].sort((a, b) => a - b));

export const GrantBody = z.strictObject({
  userId: z.number().int().positive(),
  role: Role,
  scopeType: Scope,
  scopeIds: ScopeIds,
  reason: z.string().trim().min(20, 'A grant needs a reason of at least 20 characters (R4)').max(1000),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export const UpdateBody = z.strictObject({
  scopeType: Scope.optional(),
  scopeIds: ScopeIds.optional(),
  reason: z.string().trim().min(20, 'A reason must be at least 20 characters (R4)').max(1000),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export const RevokeBody = z.strictObject({
  reason: z.string().trim().min(10, 'A revocation needs a reason of at least 10 characters (R4)').max(1000),
});
export const ListQuery = z.object({
  userId: z.coerce.number().int().positive().optional(),
  role: Role.optional(),
  scopeType: Scope.optional(),
  active: z.enum(['true', 'false']).optional(),
});

export type GrantInput = z.infer<typeof GrantBody>;
export type UpdateInput = z.infer<typeof UpdateBody>;

/** Stored in approval_requests.payload for four-eyes actions (R10). */
export type ApprovalPayload =
  | { kind: 'GRANT'; grant: GrantInput }
  | { kind: 'UPDATE'; assignmentId: number; update: UpdateInput };

export type GrantOutcome = { status: 'GRANTED'; id: number } | { status: 'PENDING_APPROVAL'; requestId: number };

const forbid = (code: string, message: string) => new HttpError(403, code, message);

/** R3: SYSTEM ⇔ no ids; DEPARTMENT/UNIT need at least one (also a DB check). */
function assertScopeShape(scopeType: ScopeType, scopeIds: number[]) {
  if (scopeType === 'SYSTEM' && scopeIds.length > 0) throw new HttpError(400, 'SCOPE_INVALID', 'SYSTEM scope must not list departments or units');
  if (scopeType !== 'SYSTEM' && scopeIds.length === 0) throw new HttpError(400, 'SCOPE_INVALID', 'DEPARTMENT and UNIT scopes need at least one id');
}

/** R5: expiry in the future and within the role's maximum window. */
function assertExpiry(role: AppRole, expiresAt: string | null | undefined, now: Date) {
  if (!expiresAt) return;
  const t = new Date(expiresAt).getTime();
  if (t <= now.getTime()) throw new HttpError(400, 'EXPIRY_INVALID', 'The expiry must be in the future');
  if (t - now.getTime() > MAX_EXPIRY_DAYS[role] * DAY_MS) {
    throw new HttpError(400, 'EXPIRY_INVALID', `A ${role} assignment can last at most ${MAX_EXPIRY_DAYS[role]} days`);
  }
}

/** The referenced departments/units must exist (a dangling id would silently grant nothing). */
async function assertScopeTargetsExist(db: DbClient, scopeType: ScopeType, scopeIds: number[]) {
  if (scopeType === 'SYSTEM') return;
  const found = scopeType === 'UNIT'
    ? await db.unit.count({ where: { id: { in: scopeIds } } })
    : await db.department.count({ where: { id: { in: scopeIds } } });
  if (found !== scopeIds.length) throw new HttpError(422, 'SCOPE_TARGET_NOT_FOUND', 'One or more departments or units in the scope do not exist');
}

/** R6: the granter must cover the requested scope. */
async function assertCovers(db: DbClient, auth: AuthContext, scopeType: ScopeType, scopeIds: number[]) {
  const mine = auth.effective.filter((g) => (ADMIN_ROLES as readonly string[]).includes(g.role));
  if (mine.some((g) => g.scopeType === 'SYSTEM')) return;
  if (scopeType === 'SYSTEM') throw forbid('SCOPE_NOT_COVERED', 'Only a System Admin or a system-wide HR Admin can assign SYSTEM scope');
  if (scopeType === 'DEPARTMENT') {
    const myDepts = new Set(mine.filter((g) => g.scopeType === 'DEPARTMENT').flatMap((g) => g.scopeIds));
    if (!scopeIds.every((id) => myDepts.has(id))) throw forbid('SCOPE_NOT_COVERED', 'You do not hold every department in this scope');
    return;
  }
  if (!scopeCovers(await unitScope(db, auth, ADMIN_ROLES), scopeIds)) throw forbid('SCOPE_NOT_COVERED', 'You do not cover every unit in this scope');
}

/** Roles whose system-wide grant is as sensitive as a system-wide HR Admin (D-71: the two roster roles). */
const WIDE_ROLES: readonly AppRole[] = ['HR_ADMIN', 'NURSING_ADMIN', 'NURSING_DIRECTOR'];
/** R10 (spec §8.1): promoting to System Admin or to a system-wide HR Admin, Nursing Admin or Nursing Director needs a second administrator. */
const needsFourEyes = (role: AppRole, scopeType: ScopeType) => role === 'SYSTEM_ADMIN' || (WIDE_ROLES.includes(role) && scopeType === 'SYSTEM');

export function createRoleAssignmentService(db: Db) {
  async function list(auth: AuthContext, q: z.infer<typeof ListQuery>) {
    const now = new Date();
    const rows = await db.roleAssignment.findMany({
      where: {
        ...(q.userId ? { userId: q.userId } : {}),
        ...(q.role ? { role: q.role } : {}),
        ...(q.scopeType ? { scopeType: q.scopeType } : {}),
        ...(q.active === 'true' ? { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } : {}),
        ...(q.active === 'false' ? { OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: now } }] } : {}),
      },
      include: { user: { select: { email: true, displayName: true } }, grantedBy: { select: { displayName: true } } },
      orderBy: { grantedAt: 'desc' },
      take: 500,
    });
    // Scoped administrators see assignments inside their own scope only.
    const scope = await unitScope(db, auth, ADMIN_ROLES);
    const visible = [];
    for (const r of rows) {
      const units = await unitsOfScope(db, r.scopeType, r.scopeIds);
      if (units === 'ALL' ? scope.all : scopeCovers(scope, units)) visible.push(r);
    }
    return { items: visible.map((r) => ({ ...r, active: r.revokedAt === null && (r.expiresAt === null || r.expiresAt > now) })), total: visible.length };
  }

  /** Every grant check (R2, R3, R5, R6), run as `auth` without writing. */
  async function validateGrant(tx: DbClient, auth: AuthContext, input: GrantInput) {
    if (input.userId === auth.user.id) throw forbid('SELF_GRANT_FORBIDDEN', 'You cannot grant a role to yourself (R2)');
    assertScopeShape(input.scopeType, input.scopeIds);
    assertExpiry(input.role, input.expiresAt, new Date());
    const target = await tx.user.findUnique({ where: { id: input.userId }, select: { isActive: true, isBreakGlass: true } });
    if (!target) throw new HttpError(422, 'USER_NOT_FOUND', 'The account does not exist');
    if (!target.isActive) throw new HttpError(422, 'USER_INACTIVE', 'Roles cannot be granted to a deactivated account');
    if (target.isBreakGlass) throw forbid('BREAK_GLASS_ACCOUNT_PROTECTED', 'The break-glass account holds no stored roles');
    await assertScopeTargetsExist(tx, input.scopeType, input.scopeIds);
    await assertCovers(tx, auth, input.scopeType, input.scopeIds);
  }

  /** Validates and writes a grant as `auth`. Four-eyes is handled by the caller. */
  async function grantNow(tx: DbClient, auth: AuthContext, input: GrantInput, approvalRequestId: number | null, requestId?: string) {
    await validateGrant(tx, auth, input);
    const created = await tx.roleAssignment.create({
      data: {
        userId: input.userId, role: input.role, scopeType: input.scopeType, scopeIds: input.scopeIds, reason: input.reason,
        grantedById: auth.user.id, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, approvalRequestId,
      },
    });
    await appendAudit(tx, {
      actorUserId: auth.user.id, action: 'ROLE_GRANTED', resource: 'role_assignment', resourceId: created.id,
      changes: { userId: input.userId, role: input.role, scopeType: input.scopeType, scopeIds: input.scopeIds, reason: input.reason, expiresAt: input.expiresAt ?? null, approvalRequestId, breakGlass: auth.breakGlass !== null },
      requestId, priority: 'HIGH',
    });
    return created.id;
  }

  async function updateNow(tx: DbClient, auth: AuthContext, id: number, input: UpdateInput, approvalRequestId: number | null, requestId?: string) {
    const existing = await tx.roleAssignment.findUnique({ where: { id } });
    if (!existing || existing.revokedAt) throw notFound('Assignment not found or already revoked');
    if (existing.userId === auth.user.id) throw forbid('SELF_UPDATE_FORBIDDEN', 'You cannot change your own assignment (R2)');
    const scopeType = input.scopeType ?? existing.scopeType;
    const scopeIds = input.scopeIds ?? (input.scopeType && input.scopeType !== existing.scopeType ? [] : existing.scopeIds);
    assertScopeShape(scopeType, scopeIds);
    assertExpiry(existing.role, input.expiresAt, new Date());
    await assertScopeTargetsExist(tx, scopeType, scopeIds);
    await assertCovers(tx, auth, existing.scopeType, existing.scopeIds); // may touch it at all
    await assertCovers(tx, auth, scopeType, scopeIds); // and may give it the new scope

    const updated = await tx.roleAssignment.update({
      where: { id },
      data: { scopeType, scopeIds, reason: input.reason, ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } : {}) },
    });
    await appendAudit(tx, {
      actorUserId: auth.user.id, action: 'ROLE_UPDATED', resource: 'role_assignment', resourceId: id,
      changes: { before: { scopeType: existing.scopeType, scopeIds: existing.scopeIds, expiresAt: existing.expiresAt }, after: { scopeType, scopeIds, expiresAt: updated.expiresAt }, reason: input.reason, approvalRequestId },
      requestId, priority: 'HIGH',
    });
    return updated.id;
  }

  async function initiateApproval(auth: AuthContext, actionType: string, payload: ApprovalPayload, requestId?: string, transaction?: Transaction) {
    return inTransaction(db, transaction, async (tx) => {
      const req = await tx.approvalRequest.create({ data: { initiatorId: auth.user.id, actionType, payload } });
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'APPROVAL_INITIATED', resource: 'approval_request', resourceId: req.id, changes: { actionType, payload }, requestId, priority: 'HIGH' });
      return req.id;
    });
  }

  async function grant(auth: AuthContext, input: GrantInput, requestId?: string, transaction?: Transaction): Promise<GrantOutcome> {
    // Break-glass bypasses four-eyes (spec §3.6); everyone else needs a second admin for R10 actions.
    if (needsFourEyes(input.role, input.scopeType) && !auth.breakGlass) {
      // Validate now so an impossible request never reaches the approval queue.
      await validateGrant(transaction ?? db, auth, input);
      const requestIdOut = await initiateApproval(auth, `GRANT:${input.userId}:${input.role}:${input.scopeType}`, { kind: 'GRANT', grant: input }, requestId, transaction);
      return { status: 'PENDING_APPROVAL', requestId: requestIdOut };
    }
    const id = await inTransaction(db, transaction, (tx) => grantNow(tx, auth, input, null, requestId));
    return { status: 'GRANTED', id };
  }

  async function update(auth: AuthContext, id: number, input: UpdateInput, requestId?: string): Promise<GrantOutcome> {
    const existing = await db.roleAssignment.findUnique({ where: { id } });
    if (!existing || existing.revokedAt) throw notFound('Assignment not found or already revoked');
    const upgradingToSystem = WIDE_ROLES.includes(existing.role) && existing.scopeType !== 'SYSTEM' && input.scopeType === 'SYSTEM';
    if (upgradingToSystem && !auth.breakGlass) {
      if (existing.userId === auth.user.id) throw forbid('SELF_UPDATE_FORBIDDEN', 'You cannot change your own assignment (R2)');
      await assertCovers(db, auth, 'SYSTEM', []);
      const rid = await initiateApproval(auth, `UPDATE:${id}`, { kind: 'UPDATE', assignmentId: id, update: input }, requestId);
      return { status: 'PENDING_APPROVAL', requestId: rid };
    }
    await db.$transaction((tx) => updateNow(tx, auth, id, input, null, requestId));
    return { status: 'GRANTED', id };
  }

  async function revoke(auth: AuthContext, id: number, reason: string, requestId?: string) {
    await db.$transaction(async (tx) => {
      // Serialise System Admin removals so two concurrent ones cannot remove the last (R8).
      await lockSystemAdminChanges(tx);
      const existing = await tx.roleAssignment.findUnique({ where: { id } });
      if (!existing || existing.revokedAt) throw notFound('Assignment not found or already revoked');
      if (existing.userId === auth.user.id) throw forbid('SELF_REVOKE_FORBIDDEN', 'You cannot revoke your own role — another administrator must (R2)');
      await assertCovers(tx, auth, existing.scopeType, existing.scopeIds);
      if (existing.role === 'SYSTEM_ADMIN' && (await otherActiveSystemAdmins(tx, { assignmentId: id })) === 0) {
        throw new HttpError(409, 'LAST_SYSTEM_ADMIN', 'The last System Admin assignment cannot be revoked (R8)');
      }
      await tx.roleAssignment.update({ where: { id }, data: { revokedAt: new Date(), revokedById: auth.user.id, revokeReason: reason } });
      await appendAudit(tx, {
        actorUserId: auth.user.id, action: 'ROLE_REVOKED', resource: 'role_assignment', resourceId: id,
        changes: { userId: existing.userId, role: existing.role, scopeType: existing.scopeType, scopeIds: existing.scopeIds, reason },
        requestId, priority: 'HIGH',
      });
    });
  }

  /** Executes an approved request as the approver, inside the approval's transaction (R11). */
  async function executeApproved(tx: DbClient, approver: AuthContext, payload: ApprovalPayload, approvalRequestId: number, requestId?: string) {
    if (payload.kind === 'GRANT') return grantNow(tx, approver, payload.grant, approvalRequestId, requestId);
    return updateNow(tx, approver, payload.assignmentId, payload.update, approvalRequestId, requestId);
  }

  return { list, grant, update, revoke, executeApproved };
}

export type RoleAssignmentService = ReturnType<typeof createRoleAssignmentService>;
