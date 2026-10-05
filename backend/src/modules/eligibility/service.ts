// Eligibility reads and emergency waivers (spec §6.1, §6.1.2; rules L5, L9).

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { isIsoDate } from '../../lib/dates.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import type { Db } from '../../lib/prisma.js';
import { unitScope, type AuthContext } from '../users/access.js';
import { employeeInScope, REVIEW_ROLES, viewerOf } from '../credentials/access.js';
import { evaluateFor, refreshEligibility } from './state.service.js';

/** Spec §6.1.2: a waiver lasts at most 72 hours (also chk_waiver_max_window). */
export const WAIVER_MAX_HOURS = 72;

export const WaiverBody = z.strictObject({
  employeeId: z.number().int().positive(),
  templateId: z.number().int().positive(),
  /** Clinical justification (spec §6.1.2). No minimum length is established; it must not be blank. */
  reason: z.string().trim().min(1).max(2000),
  expiresAt: z.iso.datetime({ offset: true }),
});
export const WaiverQuery = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
  active: z.enum(['true', 'false']).optional(),
});
export const StateQuery = z.object({
  unitId: z.coerce.number().int().positive().optional(),
  status: z.enum(['ELIGIBLE', 'ELIGIBLE_WITH_GRACE', 'ELIGIBLE_WITH_POLICY_WARNING', 'INELIGIBLE']).optional(),
});
export const EvaluateQuery = z.object({ date: z.string().refine(isIsoDate, 'YYYY-MM-DD') });

/** Spec §6.1.2 "Authority": Supervisor or HR_Admin only — System Admin is not listed. */
const WAIVER_ROLES = ['SUPERVISOR', 'HR_ADMIN'] as const;

export function createEligibilityService(db: Db) {
  return {
    async listStates(auth: AuthContext, q: z.infer<typeof StateQuery>) {
      const scope = await unitScope(db, auth, REVIEW_ROLES);
      const rows = await db.eligibilityState.findMany({
        where: {
          ...(q.status ? { status: q.status } : {}),
          employee: { deletedAt: null, ...employeeInScope(scope), ...(q.unitId ? { unitId: q.unitId } : {}) },
        },
        include: { employee: { select: { id: true, jobNumber: true, fullName: true, unitId: true, positionCode: true } } },
        orderBy: [{ status: 'asc' }, { employeeId: 'asc' }],
        take: 2000,
      });
      return { items: rows, total: rows.length };
    },

    async getState(auth: AuthContext, employeeId: number) {
      await viewerOf(db, auth, employeeId, ['OWN', 'HR', 'SUPERVISOR']);
      const state = await db.eligibilityState.findUnique({ where: { employeeId } });
      if (!state) throw notFound('No eligibility state has been calculated for this employee');
      return state;
    },

    /** Runs the engine for a given day without storing anything (L7: publication uses the engine, not the snapshot). */
    async evaluate(auth: AuthContext, employeeId: number, date: string) {
      await viewerOf(db, auth, employeeId, ['HR', 'SUPERVISOR']);
      return evaluateFor(db, employeeId, date);
    },

    async refresh(auth: AuthContext, employeeId: number, requestId?: string) {
      await viewerOf(db, auth, employeeId, ['HR']);
      return db.$transaction((tx) => refreshEligibility(tx, employeeId, 'MANUAL_REFRESH', { actorUserId: auth.user.id, requestId }));
    },

    async listWaivers(auth: AuthContext, q: z.infer<typeof WaiverQuery>) {
      const scope = await unitScope(db, auth, REVIEW_ROLES);
      const now = new Date();
      const rows = await db.credentialWaiver.findMany({
        where: {
          ...(q.employeeId ? { employeeId: q.employeeId } : {}),
          ...(q.active === 'true' ? { expiresAt: { gt: now } } : q.active === 'false' ? { expiresAt: { lte: now } } : {}),
          employee: { deletedAt: null, ...employeeInScope(scope) },
        },
        include: { template: { select: { code: true, name: true, nameAr: true } }, employee: { select: { jobNumber: true, fullName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      return { items: rows.map((w) => ({ ...w, active: w.expiresAt > now })), total: rows.length };
    },

    /** Spec §6.1.2: one nurse, one template, ≤ 72 h, future expiry, HIGH audit with the justification. */
    async createWaiver(auth: AuthContext, body: z.infer<typeof WaiverBody>, requestId?: string) {
      const { unitId } = await viewerOf(db, auth, body.employeeId, ['HR', 'SUPERVISOR']);
      // The caller's authority must come from a waiver role that covers this nurse.
      const scope = await unitScope(db, auth, WAIVER_ROLES);
      if (!(scope.all || (unitId !== null && scope.unitIds.has(unitId)))) {
        throw new HttpError(403, 'WAIVER_NOT_AUTHORIZED', 'Only a Supervisor or HR Admin covering this nurse can issue a waiver');
      }
      if (auth.user.employeeId === body.employeeId) throw new HttpError(403, 'SELF_WAIVER_FORBIDDEN', 'You cannot waive your own credential');
      const tpl = await db.credentialTemplate.findUnique({ where: { id: body.templateId }, select: { id: true, code: true } });
      if (!tpl) throw new HttpError(422, 'TEMPLATE_NOT_FOUND', 'The credential template does not exist');

      const now = new Date();
      const expiresAt = new Date(body.expiresAt);
      // Same rules as the database constraints, answered clearly before they fire.
      if (expiresAt <= now) throw new HttpError(422, 'WAIVER_EXPIRY_IN_PAST', 'A waiver must expire in the future');
      if (expiresAt.getTime() - now.getTime() > WAIVER_MAX_HOURS * 3600_000) throw new HttpError(422, 'WAIVER_WINDOW_EXCEEDED', `A waiver can last at most ${WAIVER_MAX_HOURS} hours`);

      return db.$transaction(async (tx) => {
        const w = await tx.credentialWaiver.create({
          data: { employeeId: body.employeeId, templateId: body.templateId, waivedById: auth.user.id, reason: body.reason, createdAt: now, expiresAt },
        });
        await appendAudit(tx, {
          actorUserId: auth.user.id, action: 'WAIVER_GRANTED', resource: 'credential_waiver', resourceId: w.id,
          changes: { employeeId: body.employeeId, templateId: body.templateId, templateCode: tpl.code, waivedById: auth.user.id, justification: body.reason, expiresAt: expiresAt.toISOString() },
          requestId, priority: 'HIGH',
        });
        const state = await refreshEligibility(tx, body.employeeId, 'WAIVER_GRANTED', { actorUserId: auth.user.id, requestId, now });
        return { id: w.id, eligibility: state?.status ?? null };
      });
    },
  };
}
