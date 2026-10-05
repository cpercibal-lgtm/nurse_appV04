// Four-eyes approvals (spec §8.1; rules R10–R12). Ported from the V03 NestJS
// reference (admin-approval.service.ts): the request row is locked FOR UPDATE
// so two approvers cannot both proceed, only PENDING requests can be decided,
// the approver must differ from the initiator, and the approved action runs in
// the same transaction as the status change — if it fails, both roll back and
// the request stays PENDING.

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import type { Db } from '../../lib/prisma.js';
import { scopeCovers, unitScope, type AuthContext, type UnitScope } from '../users/access.js';
import { isCatalogPayload, type CatalogApprovalPayload, type CatalogService } from '../credentials/catalog.js';
import { isBaselinePayload, type BaselineApprovalPayload, type BaselineImportService } from './baseline-import.js';
import type { ApprovalPayload as RolePayload, RoleAssignmentService } from '../users/role-assignments.js';
import { isAnnouncementPayload, type AnnouncementApprovalPayload, type AnnouncementService } from '../announcements/service.js';

type ApprovalPayload = RolePayload | CatalogApprovalPayload | BaselineApprovalPayload | AnnouncementApprovalPayload;
const isCatalog = (p: ApprovalPayload): p is CatalogApprovalPayload => isCatalogPayload(p);

export const DecideBody = z.strictObject({
  reason: z.string().trim().min(5, 'A decision needs a reason of at least 5 characters (R4)').max(1000),
});
export const ListApprovalsQuery = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'WITHDRAWN']).default('PENDING') });

const ADMIN_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'] as const;
/** GET /approvals returns at most this many rows the caller may decide. */
const LIST_LIMIT = 200;
/** Rows read per database round trip while filling the list. */
const LIST_BATCH = 200;

interface LockedRow { id: number; initiator_id: number; status: string; action_type: string; payload: ApprovalPayload }

/** The same scope rule guards both the queue and decisions (including rejection).
 * A UNIT grant cannot cover a DEPARTMENT grant: future units would expand it. */
function canDecide(auth: AuthContext, scope: UnitScope, p: ApprovalPayload): boolean {
  if (isCatalog(p) || isBaselinePayload(p)) return scope.all; // hospital-wide configuration (D-25, P7)
  if (isAnnouncementPayload(p)) return p.unitIds === 'ALL' ? scope.all : scopeCovers(scope, p.unitIds); // D-69: the audience's units
  const type = p.kind === 'GRANT' ? p.grant.scopeType : p.update.scopeType ?? 'SYSTEM';
  const ids = p.kind === 'GRANT' ? p.grant.scopeIds : p.update.scopeIds ?? [];
  if (type === 'SYSTEM') return scope.all && ids.length === 0;
  if (ids.length === 0) return false;
  if (type === 'DEPARTMENT') {
    return scope.all || ids.every((id) => auth.effective.some((g) =>
      (ADMIN_ROLES as readonly string[]).includes(g.role) && g.scopeType === 'DEPARTMENT' && g.scopeIds.includes(id)));
  }
  return scopeCovers(scope, ids);
}

export function createApprovalService(db: Db, roles: RoleAssignmentService, catalog: CatalogService, baseline: BaselineImportService, announcements: AnnouncementService) {
  async function assertDecisionScope(tx: Parameters<Parameters<Db['$transaction']>[0]>[0], auth: AuthContext, p: ApprovalPayload) {
    if (!canDecide(auth, await unitScope(tx, auth, ADMIN_ROLES), p)) {
      throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This approval request is outside your assigned scope');
    }
  }

  /**
   * Newest first, at most LIST_LIMIT rows the caller may decide. Scope is a
   * property of each request's payload, so it is applied in code — and the cap
   * is applied AFTER it: rows are read in batches until the limit is reached or
   * the status is exhausted, so a scoped admin's request is never pushed out by
   * other admins' requests. The scope used for visibility is also enforced
   * before either decision.
   */
  async function list(auth: AuthContext, q: z.infer<typeof ListApprovalsQuery>) {
    const scope = await unitScope(db, auth, ADMIN_ROLES);
    const page = (cursorId?: number) => db.approvalRequest.findMany({
      where: { status: q.status },
      include: { initiator: { select: { displayName: true, email: true } }, approver: { select: { displayName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_BATCH,
      ...(cursorId === undefined ? {} : { cursor: { id: cursorId }, skip: 1 }),
    });
    const visible: Awaited<ReturnType<typeof page>> = [];
    for (let cursorId: number | undefined; visible.length < LIST_LIMIT;) {
      const rows = await page(cursorId);
      for (const r of rows) if (canDecide(auth, scope, r.payload as unknown as ApprovalPayload)) visible.push(r);
      if (rows.length < LIST_BATCH) break;
      cursorId = rows[rows.length - 1]!.id;
    }
    const items = visible.slice(0, LIST_LIMIT);
    return { items, total: items.length };
  }

  async function lockPending(tx: Parameters<Parameters<Db['$transaction']>[0]>[0], id: number, approverId: number) {
    const rows = await tx.$queryRaw<LockedRow[]>`
      SELECT id, initiator_id, status::text AS status, action_type, payload FROM approval_requests WHERE id = ${id} FOR UPDATE`;
    const req = rows[0];
    if (!req) throw notFound('Approval request not found');
    if (req.status !== 'PENDING') throw new HttpError(409, 'APPROVAL_NOT_PENDING', `This request is already ${req.status}`);
    if (req.initiator_id === approverId) throw new HttpError(403, 'SELF_APPROVAL_FORBIDDEN', 'A request must be approved by a different administrator (R11)');
    return req;
  }

  async function lockPendingForWithdrawal(tx: Parameters<Parameters<Db['$transaction']>[0]>[0], id: number) {
    const rows = await tx.$queryRaw<LockedRow[]>`
      SELECT id, initiator_id, status::text AS status, action_type, payload FROM approval_requests WHERE id = ${id} FOR UPDATE`;
    const req = rows[0];
    if (!req) throw notFound('Approval request not found');
    if (req.status !== 'PENDING') throw new HttpError(409, 'APPROVAL_NOT_PENDING', `This request is already ${req.status}`);
    return req;
  }

  async function approve(auth: AuthContext, id: number, reason: string, requestId?: string) {
    return db.$transaction(async (tx) => {
      const req = await lockPending(tx, id, auth.user.id);
      await assertDecisionScope(tx, auth, req.payload);
      // The action runs as the approver: every rule is checked again for them.
      const p = req.payload;
      const resultId = isBaselinePayload(p) ? await baseline.executeApproved(tx, auth, p, id, requestId)
        : isCatalog(p) ? await catalog.executeApproved(tx, auth, p, id, requestId)
        : isAnnouncementPayload(p) ? await announcements.executeApproved(tx, auth, p, id, requestId)
        : await roles.executeApproved(tx, auth, p, id, requestId);
      const now = new Date();
      await tx.approvalRequest.update({ where: { id }, data: { status: 'EXECUTED', approverId: auth.user.id, reason, decidedAt: now, executedAt: now } });
      await appendAudit(tx, {
        actorUserId: auth.user.id, action: 'APPROVAL_EXECUTED', resource: 'approval_request', resourceId: id,
        changes: { initiatorId: req.initiator_id, approverId: auth.user.id, actionType: req.action_type, reason, resultId }, requestId, priority: 'HIGH',
      });
      return { id, status: 'EXECUTED' as const, resultId };
    }, { timeout: 120_000 }); // a baseline import creates a few hundred rows; an announcement a row per recipient
  }

  async function reject(auth: AuthContext, id: number, reason: string, requestId?: string) {
    return db.$transaction(async (tx) => {
      const req = await lockPending(tx, id, auth.user.id);
      await assertDecisionScope(tx, auth, req.payload);
      await tx.approvalRequest.update({ where: { id }, data: { status: 'REJECTED', approverId: auth.user.id, reason, decidedAt: new Date() } });
      if (isAnnouncementPayload(req.payload)) await announcements.onRejected(tx, req.payload, auth.user.id, requestId);
      await appendAudit(tx, {
        actorUserId: auth.user.id, action: 'APPROVAL_REJECTED', resource: 'approval_request', resourceId: id,
        changes: { initiatorId: req.initiator_id, approverId: auth.user.id, actionType: req.action_type, reason }, requestId, priority: 'HIGH',
      });
      return { id, status: 'REJECTED' as const };
    });
  }

  async function withdraw(auth: AuthContext, id: number, reason: string, requestId?: string) {
    return db.$transaction(async (tx) => {
      const req = await lockPendingForWithdrawal(tx, id);
      if (req.initiator_id !== auth.user.id) {
        throw new HttpError(403, 'WITHDRAWAL_NOT_OWNER', 'Only the initiator can withdraw this approval request');
      }
      const now = new Date();
      await tx.approvalRequest.update({
        where: { id },
        data: { status: 'WITHDRAWN', reason, decidedAt: now, withdrawnAt: now },
      });
      if (isAnnouncementPayload(req.payload)) await announcements.onWithdrawn(tx, req.payload, auth.user.id, requestId);
      await appendAudit(tx, {
        actorUserId: auth.user.id, action: 'APPROVAL_WITHDRAWN', resource: 'approval_request', resourceId: id,
        changes: { initiatorId: req.initiator_id, actionType: req.action_type, reason }, requestId, priority: 'HIGH',
      });
      return { id, status: 'WITHDRAWN' as const };
    });
  }

  return { list, approve, reject, withdraw };
}
