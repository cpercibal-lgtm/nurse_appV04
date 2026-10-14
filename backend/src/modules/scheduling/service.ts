// Rosters (spec §6.2, §6.3; rules S1–S6, L7; decisions D-14, D-16, D-31, D-32).
//
// - Scoped Supervisors draft and publish (D-14); HR / System Admin read.
// - D-71 (hospital reply C6, 2026-10-14): the Nursing Admin prepares and, like the Supervisor,
//   publishes; the Nursing Director approves a unit's drafts for a date window first. Publishing
//   needs an Approved window that covers the dates; any change to the drafts in an approved or
//   pending window withdraws it. The requester never decides their own request.
// - A nurse is scheduled only in their home unit (D-32): the engine checks the
//   home unit's credential rules, so floating would skip the target's rules.
// - Every eligibility figure here is the live engine for the shift date, never
//   the stored snapshot (L7). Facts are loaded once per nurse per request and
//   evaluated for each date in memory.
// - Publication re-validates every draft in one transaction; an INELIGIBLE
//   nurse stays in draft unless a waiver covers the gap (S3). Grace and
//   waiver reliance is recorded on the assignment and in the audit (L8).
// - Coverage compares eligible, non-cancelled assignments with the configured
//   targets; a missing target is "unspecified" (W8); a shortage warns, it
//   never blocks (S4, S5). Date windows are at most 94 days (S6).

import { z } from 'zod';
import { SHIFT_TYPES, type ShiftType } from '../../config/shifts.js';
import { appendAudit } from '../../lib/audit.js';
import { addDays, daysBetween, dbDate, isIsoDate, riyadhDate, toDbDate, type IsoDate } from '../../lib/dates.js';
import { conflict, HttpError, notFound, unprocessable } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import type { EngineFacts, EngineResult } from '../eligibility/engine.js';
import { currentLogic } from '../eligibility/logic.js';
import { loadFacts, recipientsForUnit } from '../eligibility/state.service.js';
import { unitScope, type AuthContext, type UnitScope } from '../users/access.js';

export const MAX_WINDOW_DAYS = 94; // S6
const Shift = z.enum(['Morning', 'Evening', 'Night']);
const IsoDateStr = z.string().refine(isIsoDate, 'YYYY-MM-DD');
const UnitId = z.coerce.number().int().positive();

const Window = z.object({ from: IsoDateStr, to: IsoDateStr }).superRefine((w, ctx) => {
  if (!isIsoDate(w.from) || !isIsoDate(w.to)) return;
  if (w.to < w.from) ctx.addIssue({ code: 'custom', path: ['to'], message: '`to` must not be before `from`' });
  else if (daysBetween(w.from, w.to) + 1 > MAX_WINDOW_DAYS) ctx.addIssue({ code: 'custom', path: ['to'], message: `A window is at most ${MAX_WINDOW_DAYS} days (S6)` });
});
export const BoardQuery = Window.and(z.object({ unitId: UnitId }));
export const OwnQuery = Window;
export const PoolQuery = z.object({ unitId: UnitId, date: IsoDateStr, shiftType: Shift });
export const CreateBody = z.strictObject({
  employeeId: z.number().int().positive(), unitId: z.number().int().positive(), shiftDate: IsoDateStr, shiftType: Shift,
  notes: z.string().trim().max(500).optional(),
});
export const CancelBody = z.strictObject({ reason: z.string().trim().min(5).max(500).optional() });
const windowCheck = (w: { from: string; to: string }, ctx: z.RefinementCtx) => {
  if (!isIsoDate(w.from) || !isIsoDate(w.to)) return;
  if (w.to < w.from || daysBetween(w.from, w.to) + 1 > MAX_WINDOW_DAYS) ctx.addIssue({ code: 'custom', path: ['to'], message: `A window of 1–${MAX_WINDOW_DAYS} days is required (S6)` });
};
export const PublishBody = z.strictObject({ unitId: z.number().int().positive(), from: IsoDateStr, to: IsoDateStr }).superRefine(windowCheck);
export const ApprovalRequestBody = PublishBody;
export const ApprovalListQuery = z.object({
  unitId: UnitId,
  status: z.enum(['Pending', 'Approved', 'Rejected', 'Withdrawn']).optional(),
});
export const DecideBody = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().min(5).max(500).optional(),
}).superRefine((b, ctx) => {
  if (b.decision === 'reject' && !b.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Rejecting a roster needs a reason of at least 5 characters' });
});
export const GenerateBody = z.strictObject({ unitId: z.number().int().positive(), from: IsoDateStr, to: IsoDateStr, dryRun: z.boolean().default(true) }).superRefine(windowCheck);

const READ_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR', 'NURSING_ADMIN', 'NURSING_DIRECTOR'] as const;
/** D-71: who prepares and publishes a unit's roster. */
const PREPARE_ROLES = ['SUPERVISOR', 'NURSING_ADMIN'] as const;
const APPROVE_ROLES = ['NURSING_DIRECTOR'] as const;
const covers = (s: UnitScope, unitId: number) => s.all || s.unitIds.has(unitId);
const dates = (from: IsoDate, to: IsoDate) => Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));
const slim = (r: EngineResult) => ({ status: r.status, reasons: r.reasons });
/** Waiver or grace reliance is never silent (L8). */
const relied = (r: EngineResult) => r.status !== 'ELIGIBLE' || r.reasons.some((x) => x.code === 'WAIVER_ACTIVE');

/** Live engine with facts loaded once per nurse for the life of one request. */
function engineFor(tx: DbClient, now = new Date()) {
  const facts = new Map<number, Promise<EngineFacts>>();
  const logic = currentLogic(tx).then((l) => l.engine); // the ACTIVE version (spec §10.9)
  const today = riyadhDate(now);
  return async (employeeId: number, date: IsoDate) => {
    if (!facts.has(employeeId)) facts.set(employeeId, loadFacts(tx, employeeId, now));
    return (await logic)(await facts.get(employeeId)!, { date, today, now });
  };
}

export function createSchedulingService(db: Db) {
  async function assertRead(tx: DbClient, auth: AuthContext, unitId: number) {
    if (!(await tx.unit.findUnique({ where: { id: unitId }, select: { id: true } }))) throw notFound('Unit not found');
    if (!covers(await unitScope(tx, auth, READ_ROLES), unitId)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This unit is outside your assigned scope');
  }
  async function assertSupervises(tx: DbClient, auth: AuthContext, unitId: number) {
    const unit = await tx.unit.findUnique({ where: { id: unitId }, select: { isActive: true } });
    if (!unit) throw notFound('Unit not found');
    if (!covers(await unitScope(tx, auth, PREPARE_ROLES), unitId)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'You do not manage this unit\'s roster');
    return unit;
  }

  /** Approvals still alive (Pending or Approved) whose window touches [from, to]. */
  const overlapping = (unitId: number, from: IsoDate, to: IsoDate) => ({
    unitId, status: { in: ['Pending', 'Approved'] as Array<'Pending' | 'Approved'> }, fromDate: { lte: toDbDate(to) }, toDate: { gte: toDbDate(from) },
  });

  /** D-71: the drafts in a window changed, so any approval request touching it no longer describes them. */
  async function withdrawApprovals(tx: DbClient, auth: AuthContext, unitId: number, from: IsoDate, to: IsoDate, requestId?: string) {
    // The same per-unit lock as publishing: a publication that has already read its approval finishes first,
    // and one that starts later sees the withdrawal, so no draft is published under an approval that predates it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('roster:publish'), ${unitId})`;
    const alive = await tx.rosterApproval.findMany({ where: overlapping(unitId, from, to), select: { id: true, status: true } });
    if (alive.length === 0) return;
    await tx.rosterApproval.updateMany({ where: { id: { in: alive.map((a) => a.id) } }, data: { status: 'Withdrawn' } });
    await appendAudit(tx, {
      actorUserId: auth.user.id, action: 'ROSTER_APPROVAL_WITHDRAWN', resource: 'unit', resourceId: unitId,
      changes: { approvalIds: alive.map((a) => a.id), wereApproved: alive.filter((a) => a.status === 'Approved').length, reason: 'drafts in the window changed' }, requestId,
    });
  }

  /** Assignments of a unit/window with live eligibility, and coverage per date × shift. */
  async function board(tx: DbClient, unitId: number, from: IsoDate, to: IsoDate) {
    // Sequential: `tx` may be a transaction client (one pinned pg connection; no concurrent queries).
    const rows = await tx.shiftAssignment.findMany({
      where: { unitId, status: { not: 'Cancelled' }, shiftDate: { gte: toDbDate(from), lte: toDbDate(to) } },
      include: { employee: { select: { jobNumber: true, fullName: true } } },
      orderBy: [{ shiftDate: 'asc' }, { shiftType: 'asc' }, { employeeId: 'asc' }],
    });
    const targets = await tx.coverageTarget.findMany({ where: { unitId } });
    const check = engineFor(tx);
    const assignments: Array<{ id: number; employeeId: number; jobNumber: string; fullName: string; unitId: number; shiftDate: IsoDate; shiftType: string; status: string; notes: string | null; eligibilityAtPublish: string | null; eligibility: ReturnType<typeof slim> }> = [];
    for (const a of rows) {
      const date = dbDate(a.shiftDate);
      assignments.push({
        id: a.id, employeeId: a.employeeId, jobNumber: a.employee.jobNumber, fullName: a.employee.fullName, unitId: a.unitId,
        shiftDate: date, shiftType: a.shiftType, status: a.status, notes: a.notes, eligibilityAtPublish: a.eligibilityAtPublish,
        eligibility: slim(await check(a.employeeId, date)),
      });
    }
    const target = new Map(targets.map((t) => [t.shiftType, t.minimumStaff]));
    const coverage = dates(from, to).flatMap((date) => SHIFT_TYPES.map((shiftType) => {
      const here = assignments.filter((a) => a.shiftDate === date && a.shiftType === shiftType);
      const count = (status: 'Draft' | 'Published') => {
        const set = here.filter((a) => a.status === status);
        return { total: set.length, eligible: set.filter((a) => a.eligibility.status !== 'INELIGIBLE').length };
      };
      const draft = count('Draft');
      const published = count('Published');
      const min = target.get(shiftType) ?? null;
      return { date, shiftType, target: min, draft, published, publishedShortage: min === null ? null : Math.max(0, min - published.eligible) };
    }));
    return { unitId, from, to, targets, assignments, coverage };
  }

  return {
    async board(auth: AuthContext, q: z.infer<typeof BoardQuery>) {
      await assertRead(db, auth, q.unitId);
      return board(db, q.unitId, q.from, q.to);
    },

    async coverage(auth: AuthContext, q: z.infer<typeof BoardQuery>) {
      await assertRead(db, auth, q.unitId);
      const b = await board(db, q.unitId, q.from, q.to);
      return { unitId: b.unitId, from: b.from, to: b.to, coverage: b.coverage };
    },

    /** S2: the caller's own published shifts (any unit) and their home unit's published schedule. */
    async own(auth: AuthContext, q: z.infer<typeof OwnQuery>) {
      if (auth.user.employeeId === null) return { own: [], homeUnit: [] };
      const emp = await db.employee.findFirst({ where: { id: auth.user.employeeId, deletedAt: null }, select: { id: true, unitId: true } });
      if (!emp) return { own: [], homeUnit: [] };
      const range = { gte: toDbDate(q.from), lte: toDbDate(q.to) };
      const include = { employee: { select: { jobNumber: true, fullName: true } }, unit: { select: { code: true } } } as const;
      const shape = (a: { id: number; employeeId: number; unitId: number; shiftDate: Date; shiftType: string; notes: string | null; employee: { jobNumber: string; fullName: string }; unit: { code: string } }) => ({
        id: a.id, employeeId: a.employeeId, jobNumber: a.employee.jobNumber, fullName: a.employee.fullName, unitCode: a.unit.code,
        shiftDate: dbDate(a.shiftDate), shiftType: a.shiftType, notes: a.notes,
      });
      const [own, home] = await Promise.all([
        db.shiftAssignment.findMany({ where: { employeeId: emp.id, status: 'Published', shiftDate: range }, include, orderBy: { shiftDate: 'asc' } }),
        emp.unitId === null ? [] : db.shiftAssignment.findMany({ where: { unitId: emp.unitId, status: 'Published', shiftDate: range }, include, orderBy: [{ shiftDate: 'asc' }, { shiftType: 'asc' }] }),
      ]);
      return { own: own.map(shape), homeUnit: home.map(shape) };
    },

    /** Candidates for one slot: home-unit nurses not already holding it, with the live engine result. */
    async pool(auth: AuthContext, q: z.infer<typeof PoolQuery>) {
      await assertSupervises(db, auth, q.unitId);
      const [emps, booked] = await Promise.all([
        db.employee.findMany({ where: { unitId: q.unitId, deletedAt: null }, select: { id: true, jobNumber: true, fullName: true, positionCode: true }, orderBy: { jobNumber: 'asc' } }),
        db.shiftAssignment.findMany({ where: { shiftDate: toDbDate(q.date), status: { not: 'Cancelled' } }, select: { employeeId: true, shiftType: true } }),
      ]);
      const check = engineFor(db);
      const items = [];
      for (const e of emps) {
        const sameSlot = booked.some((b) => b.employeeId === e.id && b.shiftType === q.shiftType);
        if (sameSlot) continue; // S1
        items.push({ ...e, shiftsThatDay: booked.filter((b) => b.employeeId === e.id).map((b) => b.shiftType), eligibility: slim(await check(e.id, q.date)) });
      }
      const rank = { ELIGIBLE: 0, ELIGIBLE_WITH_POLICY_WARNING: 1, ELIGIBLE_WITH_GRACE: 2, INELIGIBLE: 3 } as const;
      items.sort((a, b) => rank[a.eligibility.status] - rank[b.eligibility.status] || a.jobNumber.localeCompare(b.jobNumber));
      return { items, total: items.length };
    },

    async create(auth: AuthContext, body: z.infer<typeof CreateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const unit = await assertSupervises(tx, auth, body.unitId);
        if (!unit.isActive) throw unprocessable('UNIT_NOT_ACTIVE', 'The unit is inactive');
        if (body.shiftDate < riyadhDate()) throw unprocessable('SHIFT_IN_PAST', 'Shifts can be drafted for today or later');
        const emp = await tx.employee.findFirst({ where: { id: body.employeeId, deletedAt: null }, select: { unitId: true } });
        if (!emp) throw notFound('Employee not found');
        if (emp.unitId !== body.unitId) throw unprocessable('NOT_HOME_UNIT', 'A nurse can only be scheduled in their home unit (D-32)');
        const a = await tx.shiftAssignment.create({ data: { ...body, shiftDate: toDbDate(body.shiftDate), status: 'Draft', createdById: auth.user.id } });
        await withdrawApprovals(tx, auth, body.unitId, body.shiftDate, body.shiftDate, requestId);
        const eligibility = await engineFor(tx)(body.employeeId, body.shiftDate);
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'ASSIGNMENT_DRAFTED', resource: 'shift_assignment', resourceId: a.id, changes: { ...body, eligibility: eligibility.status }, requestId });
        return { id: a.id, status: a.status, eligibility: slim(eligibility) };
      });
    },

    /** A draft is removed; a published shift is cancelled with a reason (kept for history). */
    async remove(auth: AuthContext, id: number, reason: string | undefined, requestId?: string) {
      return db.$transaction(async (tx) => {
        const a = await tx.shiftAssignment.findUnique({ where: { id } });
        if (!a) throw notFound('Assignment not found');
        await assertSupervises(tx, auth, a.unitId);
        const changes = { employeeId: a.employeeId, unitId: a.unitId, shiftDate: dbDate(a.shiftDate), shiftType: a.shiftType, reason };
        if (a.status === 'Draft') {
          await tx.shiftAssignment.delete({ where: { id } });
          await withdrawApprovals(tx, auth, a.unitId, dbDate(a.shiftDate), dbDate(a.shiftDate), requestId);
          await appendAudit(tx, { actorUserId: auth.user.id, action: 'ASSIGNMENT_DELETED', resource: 'shift_assignment', resourceId: id, changes, requestId });
          return { id, status: 'Deleted' as const };
        }
        if (a.status === 'Cancelled') throw conflict('ALREADY_CANCELLED', 'This shift is already cancelled');
        if (!reason) throw new HttpError(400, 'VALIDATION_FAILED', 'Cancelling a published shift needs a reason');
        await tx.shiftAssignment.update({ where: { id }, data: { status: 'Cancelled' } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'ASSIGNMENT_CANCELLED', resource: 'shift_assignment', resourceId: id, changes, requestId, priority: 'HIGH' });
        return { id, status: 'Cancelled' as const };
      });
    },

    /**
     * Drafts assignments to reach each configured target from eligible home-unit
     * nurses (dry run by default). Heuristics, not rules: at most one
     * auto-filled shift per nurse per day, fewest shifts in the window first.
     * Unset targets are reported, never guessed (D-16).
     */
    async generate(auth: AuthContext, body: z.infer<typeof GenerateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSupervises(tx, auth, body.unitId);
        const today = riyadhDate();
        const from = body.from < today ? today : body.from;
        const targets = new Map((await tx.coverageTarget.findMany({ where: { unitId: body.unitId } })).map((t) => [t.shiftType, t.minimumStaff]));
        const targetsMissing = SHIFT_TYPES.filter((s) => !targets.has(s));
        if (from > body.to) return { dryRun: body.dryRun, proposed: [], unfilled: [], targetsMissing };
        // Sequential: inside a transaction (one pinned pg connection; no concurrent queries).
        const nurses = await tx.employee.findMany({ where: { unitId: body.unitId, deletedAt: null }, select: { id: true, jobNumber: true, fullName: true }, orderBy: { jobNumber: 'asc' } });
        const existing = await tx.shiftAssignment.findMany({ where: { status: { not: 'Cancelled' }, shiftDate: { gte: toDbDate(from), lte: toDbDate(body.to) } }, select: { employeeId: true, unitId: true, shiftDate: true, shiftType: true } });
        const check = engineFor(tx);
        const booked = existing.map((e) => ({ employeeId: e.employeeId, unitId: e.unitId, date: dbDate(e.shiftDate), shiftType: e.shiftType as ShiftType }));
        const load = new Map(nurses.map((n) => [n.id, booked.filter((b) => b.employeeId === n.id).length]));
        const proposed: Array<{ employeeId: number; jobNumber: string; fullName: string; date: IsoDate; shiftType: ShiftType; eligibility: string }> = [];
        const unfilled: Array<{ date: IsoDate; shiftType: ShiftType; target: number; have: number }> = [];

        for (const date of dates(from, body.to)) {
          for (const shiftType of SHIFT_TYPES) {
            const target = targets.get(shiftType);
            if (target === undefined) continue;
            let have = 0;
            for (const b of booked.filter((x) => x.unitId === body.unitId && x.date === date && x.shiftType === shiftType)) {
              if ((await check(b.employeeId, date)).status !== 'INELIGIBLE') have++;
            }
            const candidates = [...nurses].sort((a, b) => load.get(a.id)! - load.get(b.id)! || a.jobNumber.localeCompare(b.jobNumber));
            for (const n of candidates) {
              if (have >= target) break;
              if (booked.some((b) => b.employeeId === n.id && b.date === date)) continue;
              const r = await check(n.id, date);
              if (r.status === 'INELIGIBLE') continue;
              booked.push({ employeeId: n.id, unitId: body.unitId, date, shiftType });
              load.set(n.id, load.get(n.id)! + 1);
              proposed.push({ employeeId: n.id, jobNumber: n.jobNumber, fullName: n.fullName, date, shiftType, eligibility: r.status });
              have++;
            }
            if (have < target) unfilled.push({ date, shiftType, target, have });
          }
        }
        if (!body.dryRun && proposed.length > 0) {
          await tx.shiftAssignment.createMany({
            data: proposed.map((p) => ({ employeeId: p.employeeId, unitId: body.unitId, shiftDate: toDbDate(p.date), shiftType: p.shiftType, status: 'Draft' as const, createdById: auth.user.id })),
          });
          await withdrawApprovals(tx, auth, body.unitId, from, body.to, requestId);
          await appendAudit(tx, { actorUserId: auth.user.id, action: 'ROSTER_AUTO_DRAFTED', resource: 'unit', resourceId: body.unitId, changes: { from, to: body.to, created: proposed.length, unfilled: unfilled.length }, requestId });
        }
        return { dryRun: body.dryRun, proposed, unfilled, targetsMissing };
      }, { timeout: 120_000 });
    },

    /** D-71: the roster preparer asks the Nursing Director to approve a unit's drafts for a window. */
    async requestApproval(auth: AuthContext, body: z.infer<typeof ApprovalRequestBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const unit = await assertSupervises(tx, auth, body.unitId);
        if (!unit.isActive) throw unprocessable('UNIT_NOT_ACTIVE', 'The unit is inactive');
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('roster:approval'), ${body.unitId})`;
        const drafts = await tx.shiftAssignment.count({
          where: { unitId: body.unitId, status: 'Draft', shiftDate: { gte: toDbDate(body.from), lte: toDbDate(body.to) } },
        });
        if (drafts === 0) throw unprocessable('NOTHING_TO_APPROVE', 'There are no drafts in these dates to approve');
        const alive = await tx.rosterApproval.findFirst({ where: overlapping(body.unitId, body.from, body.to), select: { id: true, status: true } });
        if (alive) throw conflict('APPROVAL_EXISTS', alive.status === 'Pending' ? 'These dates are already waiting for the Nursing Director' : 'These dates are already approved', { approvalId: alive.id });
        const row = await tx.rosterApproval.create({
          data: { unitId: body.unitId, fromDate: toDbDate(body.from), toDate: toDbDate(body.to), requestedById: auth.user.id },
        });
        await appendAudit(tx, {
          actorUserId: auth.user.id, action: 'ROSTER_APPROVAL_REQUESTED', resource: 'unit', resourceId: body.unitId,
          changes: { approvalId: row.id, from: body.from, to: body.to, drafts }, requestId,
        });
        // D-71: the Nursing Directors whose scope covers the unit hear of it (in-app, e-mail, Telegram prompt).
        const directors = (await recipientsForUnit(tx, 'NURSING_DIRECTOR', body.unitId)).filter((id) => id !== auth.user.id);
        const code = (await tx.unit.findUniqueOrThrow({ where: { id: body.unitId }, select: { code: true } })).code;
        const name = auth.user.displayName;
        await tx.notification.createMany({
          data: directors.map((recipientId) => ({
            recipientId, type: 'APPROVAL' as const, priority: 'MEDIUM' as const,
            title: 'Roster waiting for your approval',
            message: `${name} asked you to approve the roster of ${code} for ${body.from} to ${body.to} (${drafts} draft shift${drafts === 1 ? '' : 's'}). Open Roster & Scheduling to approve or reject it.`,
            titleAr: 'جدول بانتظار اعتمادك',
            messageAr: `طلب ${name} اعتماد جدول الوحدة ${code} للفترة من ${body.from} إلى ${body.to} (${drafts} من المناوبات المسودة). افتح صفحة الجدول والمناوبات للاعتماد أو الرفض.`,
            eventKey: `roster-approval:${row.id}:asked`,
          })),
          skipDuplicates: true,
        });
        return { id: row.id, status: row.status, drafts };
      });
    },

    /** D-71: a Nursing Director whose scope covers the unit approves or rejects; never their own request. */
    async decideApproval(auth: AuthContext, id: number, body: z.infer<typeof DecideBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const row = await tx.rosterApproval.findUnique({ where: { id } });
        if (!row) throw notFound('Approval request not found');
        if (!covers(await unitScope(tx, auth, APPROVE_ROLES), row.unitId)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This unit is outside your approval scope');
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('roster:approval'), ${row.unitId})`;
        if (row.requestedById === auth.user.id) throw new HttpError(403, 'SELF_APPROVAL_FORBIDDEN', 'You cannot decide a roster request you made yourself');
        const status = body.decision === 'approve' ? 'Approved' : 'Rejected';
        const done = await tx.rosterApproval.updateMany({
          where: { id, status: 'Pending' },
          data: { status, decidedById: auth.user.id, decidedAt: new Date(), note: body.note ?? null },
        });
        if (done.count === 0) throw conflict('NOT_PENDING', 'This request has already been decided or withdrawn');
        await appendAudit(tx, {
          actorUserId: auth.user.id, action: status === 'Approved' ? 'ROSTER_APPROVED' : 'ROSTER_REJECTED', resource: 'unit', resourceId: row.unitId,
          changes: { approvalId: id, from: dbDate(row.fromDate), to: dbDate(row.toDate), requestedById: row.requestedById, note: body.note ?? null },
          requestId, priority: 'HIGH',
        });
        // D-71: whoever asked hears the outcome, with the reason when it was rejected.
        const code = (await tx.unit.findUniqueOrThrow({ where: { id: row.unitId }, select: { code: true } })).code;
        const approved = status === 'Approved';
        const range = `${dbDate(row.fromDate)} to ${dbDate(row.toDate)}`;
        const rangeAr = `من ${dbDate(row.fromDate)} إلى ${dbDate(row.toDate)}`;
        await tx.notification.createMany({
          data: [{
            recipientId: row.requestedById, type: 'APPROVAL' as const, priority: approved ? ('MEDIUM' as const) : ('HIGH' as const),
            title: approved ? 'Roster approved' : 'Roster rejected',
            message: approved
              ? `${auth.user.displayName} approved the roster of ${code} for ${range}. It can be published now.`
              : `${auth.user.displayName} rejected the roster of ${code} for ${range}: ${body.note}`,
            titleAr: approved ? 'تم اعتماد الجدول' : 'تم رفض الجدول',
            messageAr: approved
              ? `اعتمد ${auth.user.displayName} جدول الوحدة ${code} ${rangeAr}. يمكن نشره الآن.`
              : `رفض ${auth.user.displayName} جدول الوحدة ${code} ${rangeAr}: ${body.note}`,
            eventKey: `roster-approval:${id}:${approved ? 'approved' : 'rejected'}`,
          }],
          skipDuplicates: true,
        });
        return { id, status };
      });
    },

    /** Approval requests for a unit (newest first), with the names of the people involved. */
    async approvals(auth: AuthContext, q: z.infer<typeof ApprovalListQuery>) {
      await assertRead(db, auth, q.unitId);
      const rows = await db.rosterApproval.findMany({
        where: { unitId: q.unitId, ...(q.status ? { status: q.status } : {}) }, orderBy: { id: 'desc' }, take: 100,
      });
      const ids = [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById].filter((x): x is number => x !== null)))];
      const users = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }) : [];
      const name = new Map(users.map((u) => [u.id, u.displayName]));
      return {
        items: rows.map((r) => ({
          id: r.id, unitId: r.unitId, from: dbDate(r.fromDate), to: dbDate(r.toDate), status: r.status,
          requestedBy: { id: r.requestedById, name: name.get(r.requestedById) ?? null }, requestedAt: r.requestedAt.toISOString(),
          decidedBy: r.decidedById === null ? null : { id: r.decidedById, name: name.get(r.decidedById) ?? null },
          decidedAt: r.decidedAt?.toISOString() ?? null, note: r.note,
        })),
        total: rows.length,
      };
    },

    /** L7, S3: every draft in the window is re-validated by the engine in one transaction. */
    async publish(auth: AuthContext, body: z.infer<typeof PublishBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSupervises(tx, auth, body.unitId);
        // One publication per unit at a time.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('roster:publish'), ${body.unitId})`;
        // D-71: the Nursing Director has approved a window that covers every date being published.
        const approved = await tx.rosterApproval.findFirst({
          where: { unitId: body.unitId, status: 'Approved', fromDate: { lte: toDbDate(body.from) }, toDate: { gte: toDbDate(body.to) } },
          select: { id: true },
        });
        if (!approved) throw conflict('APPROVAL_REQUIRED', 'The Nursing Director has not approved the roster for these dates. Ask for approval first.');
        const today = riyadhDate();
        const drafts = await tx.shiftAssignment.findMany({
          where: { unitId: body.unitId, status: 'Draft', shiftDate: { gte: toDbDate(body.from), lte: toDbDate(body.to) } },
          include: { employee: { select: { unitId: true, deletedAt: true, jobNumber: true, fullName: true } } },
          orderBy: [{ shiftDate: 'asc' }, { shiftType: 'asc' }],
        });
        const check = engineFor(tx);
        const now = new Date();
        const published: number[] = [];
        const reliedOn: Array<{ id: number; status: string; reasons: string[] }> = [];
        const blocked: Array<{ id: number; employeeId: number; jobNumber: string; fullName: string; shiftDate: IsoDate; shiftType: string; reasons: Array<{ code: string; message: string }> }> = [];
        for (const a of drafts) {
          const date = dbDate(a.shiftDate);
          const base = { id: a.id, employeeId: a.employeeId, jobNumber: a.employee.jobNumber, fullName: a.employee.fullName, shiftDate: date, shiftType: a.shiftType };
          if (date < today) { blocked.push({ ...base, reasons: [{ code: 'SHIFT_IN_PAST', message: 'The shift date has passed' }] }); continue; }
          if (a.employee.unitId !== body.unitId) { blocked.push({ ...base, reasons: [{ code: 'NOT_HOME_UNIT', message: 'The nurse is no longer in this unit (D-32)' }] }); continue; }
          const r = await check(a.employeeId, date);
          if (r.status === 'INELIGIBLE') {
            blocked.push({ ...base, reasons: r.reasons.filter((x) => x.severity === 'BLOCK').map((x) => ({ code: x.code, message: x.message })) });
            continue;
          }
          const flag = relied(r);
          await tx.shiftAssignment.update({ where: { id: a.id }, data: { status: 'Published', publishedById: auth.user.id, publishedAt: now, eligibilityAtPublish: flag ? r.status : null } });
          published.push(a.id);
          if (flag) reliedOn.push({ id: a.id, status: r.status, reasons: r.reasons.filter((x) => x.severity !== 'INFO' || x.code === 'WAIVER_ACTIVE').map((x) => x.code) });
        }
        await appendAudit(tx, {
          actorUserId: auth.user.id, action: 'ROSTER_PUBLISHED', resource: 'unit', resourceId: body.unitId,
          changes: { from: body.from, to: body.to, approvalId: approved.id, published: published.length, blocked: blocked.map((b) => ({ id: b.id, reasons: b.reasons.map((x) => x.code) })), reliedOnGraceOrWaiver: reliedOn },
          requestId, priority: 'HIGH',
        });
        return { published: published.length, blocked, reliedOnGraceOrWaiver: reliedOn };
      }, { timeout: 120_000 });
    },
  };
}

export type SchedulingService = ReturnType<typeof createSchedulingService>;
