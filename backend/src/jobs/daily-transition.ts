// Daily transition (spec §6.1 "Daily Midnight Transition", §6.2, §5.2, L6).
// Everything that changes only because a date passed:
//   1. Contracts: Approved → Active on the start date (C2); Approved/Active →
//      Expired after the end date (C3).
//   2. Stored credential status: Valid ⇄ ExpiringSoon → Expired by date (§5.2).
//   3. Grace windows that ended without a completed renewal are closed, with a
//      HIGH audit and an HR notice (§6.1.1 acceptance table).
//   4. Expired PAM elevations are removed (R13); ended break-glass sessions
//      get their end time (R18); spent idempotency keys are purged (§9.5).
//   5. Every live nurse is re-evaluated; the refresh returns future published
//      shifts that no longer pass to draft (§6.2) and TRANSITION warnings
//      produce the policy notice (§6.1.1.1).
// Each step commits on its own; step 5 runs one nurse per transaction so one
// failure cannot hold the whole hospital's refresh.

import { appendAudit } from '../lib/audit.js';
import { dbDate, riyadhDate, toDbDate } from '../lib/dates.js';
import { describeError, logger } from '../lib/logger.js';
import type { Db } from '../lib/prisma.js';
import { deriveStatus } from '../modules/credentials/records.js';
import { hrRecipientsForUnit, refreshEligibility } from '../modules/eligibility/state.service.js';

const SYSTEM = null; // audit actor for scheduled work

export async function dailyTransition(db: Db, now = new Date()) {
  const today = riyadhDate(now);
  const todayDb = toDbDate(today);
  const summary = { contractsActivated: 0, contractsExpired: 0, credentialStatusChanged: 0, graceClosed: 0, pamExpired: 0, breakGlassEnded: 0, idempotencyPurged: 0, nursesRefreshed: 0, refreshFailures: 0, policyNotices: 0 };

  // 1. Contracts (C2, C3).
  await db.$transaction(async (tx) => {
    const toActivate = await tx.contract.findMany({ where: { status: 'Approved', startDate: { lte: todayDb }, endDate: { gte: todayDb } }, select: { id: true, employeeId: true } });
    for (const c of toActivate) {
      await tx.contract.update({ where: { id: c.id }, data: { status: 'Active' } });
      await appendAudit(tx, { actorUserId: SYSTEM, action: 'CONTRACT_ACTIVATED', resource: 'contract', resourceId: c.id, changes: { employeeId: c.employeeId, from: 'Approved', to: 'Active', event: 'DAILY_TRANSITION' } });
    }
    const toExpire = await tx.contract.findMany({ where: { status: { in: ['Approved', 'Active'] }, endDate: { lt: todayDb } }, select: { id: true, employeeId: true, status: true } });
    for (const c of toExpire) {
      await tx.contract.update({ where: { id: c.id }, data: { status: 'Expired' } });
      await appendAudit(tx, { actorUserId: SYSTEM, action: 'CONTRACT_EXPIRED', resource: 'contract', resourceId: c.id, changes: { employeeId: c.employeeId, from: c.status, to: 'Expired', event: 'DAILY_TRANSITION' } });
    }
    summary.contractsActivated = toActivate.length;
    summary.contractsExpired = toExpire.length;
  }, { timeout: 120_000 });

  // 2. Stored credential status (only the date-driven states move).
  await db.$transaction(async (tx) => {
    const creds = await tx.credential.findMany({ where: { status: { in: ['Valid', 'ExpiringSoon', 'Expired'] } }, select: { id: true, employeeId: true, status: true, expiryDate: true } });
    for (const c of creds) {
      const next = deriveStatus(c.expiryDate ? dbDate(c.expiryDate) : null, today);
      if (next === c.status) continue;
      await tx.credential.update({ where: { id: c.id }, data: { status: next } });
      await appendAudit(tx, { actorUserId: SYSTEM, action: 'CREDENTIAL_STATUS_CHANGED', resource: 'credential', resourceId: c.id, changes: { employeeId: c.employeeId, from: c.status, to: next, event: 'DAILY_TRANSITION' } });
      summary.credentialStatusChanged++;
    }
  }, { timeout: 120_000 });

  // 3. Grace windows that ended (never silent: audit + HR notice).
  await db.$transaction(async (tx) => {
    const ended = await tx.credential.findMany({
      where: { graceExpiryDate: { lt: todayDb }, graceCycleId: { not: null } },
      select: { id: true, employeeId: true, graceCycleId: true, graceExpiryDate: true, template: { select: { name: true, nameAr: true } }, employee: { select: { unitId: true, fullName: true, jobNumber: true } } },
    });
    for (const c of ended) {
      if (c.graceCycleId!.endsWith(':closed')) continue;
      await tx.credential.update({ where: { id: c.id }, data: { graceCycleId: `${c.graceCycleId}:closed` } });
      await appendAudit(tx, { actorUserId: SYSTEM, action: 'GRACE_EXPIRED', resource: 'credential', resourceId: c.id, changes: { employeeId: c.employeeId, cycleId: c.graceCycleId, graceEndDate: dbDate(c.graceExpiryDate!) }, priority: 'HIGH' });
      const hr = await hrRecipientsForUnit(tx, c.employee.unitId, now);
      await tx.notification.createMany({
        data: hr.map((recipientId) => ({
          recipientId, employeeId: c.employeeId, type: 'ELIGIBILITY' as const, priority: 'HIGH' as const,
          title: 'Grace period ended without renewal',
          message: `${c.employee.jobNumber} ${c.employee.fullName}: the grace period for ${c.template.name} ended on ${dbDate(c.graceExpiryDate!)}. The nurse is ineligible until the renewal is approved.`,
          titleAr: 'انتهت فترة السماح دون تجديد',
          messageAr: `${c.employee.jobNumber} ${c.employee.fullName}: انتهت فترة السماح لـ ${c.template.nameAr ?? c.template.name} في ${dbDate(c.graceExpiryDate!)}. الممرض غير مؤهل حتى اعتماد التجديد.`,
          eventKey: `grace-expired:${c.graceCycleId}`,
        })),
        skipDuplicates: true,
      });
      summary.graceClosed++;
    }
  });

  // 4. Security housekeeping.
  await db.$transaction(async (tx) => {
    const pam = await tx.privilegedSession.findMany({ where: { expiresAt: { lte: now } }, select: { userId: true, expiresAt: true } });
    for (const p of pam) {
      await tx.privilegedSession.delete({ where: { userId: p.userId } });
      await appendAudit(tx, { actorUserId: SYSTEM, action: 'PAM_EXPIRED', resource: 'user', resourceId: p.userId, changes: { expiredAt: p.expiresAt.toISOString() }, priority: 'HIGH' });
    }
    summary.pamExpired = pam.length;
    const glass = await tx.breakGlassEvent.findMany({ where: { endedAt: null, expiresAt: { lte: now } }, select: { id: true, expiresAt: true } });
    for (const g of glass) {
      await tx.breakGlassEvent.update({ where: { id: g.id }, data: { endedAt: g.expiresAt } });
      await appendAudit(tx, { actorUserId: SYSTEM, action: 'BREAK_GLASS_ENDED', resource: 'break_glass_event', resourceId: g.id, changes: { endedAt: g.expiresAt.toISOString() }, priority: 'HIGH' });
    }
    summary.breakGlassEnded = glass.length;
    summary.idempotencyPurged = (await tx.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } })).count;
  });

  // 5. Re-evaluate every live nurse (demotes invalid future published shifts).
  const nurses = await db.employee.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' } });
  for (const n of nurses) {
    try {
      const result = await db.$transaction((tx) => refreshEligibility(tx, n.id, 'DAILY_TRANSITION', { actorUserId: SYSTEM, now }));
      summary.nursesRefreshed++;
      // §6.1.1.1: a TRANSITION requirement warns the nurse until its deadline.
      const warnings = result?.reasons.filter((r) => r.code === 'POLICY_TRANSITION_WARNING') ?? [];
      if (warnings.length > 0) {
        const own = await db.user.findFirst({ where: { employeeId: n.id, isActive: true }, select: { id: true } });
        if (own) {
          const created = await db.notification.createMany({
            data: warnings.map((w) => ({
              recipientId: own.id, employeeId: n.id, type: 'CREDENTIAL' as const, priority: 'MEDIUM' as const,
              title: 'New credential requirement',
              message: `${w.templateCode ?? 'A credential'} will become mandatory on ${w.until ?? 'its deadline'}. Please upload evidence.`,
              titleAr: 'متطلب شهادة جديد', messageAr: `ستصبح ${w.templateCode ?? 'شهادة'} إلزامية في ${w.until ?? 'الموعد المحدد'}. يرجى رفع المستند.`,
              eventKey: `policy-warning:${n.id}:${w.templateId ?? w.templateCode}:${w.until ?? ''}`,
            })),
            skipDuplicates: true,
          });
          summary.policyNotices += created.count;
        }
      }
    } catch (e) {
      summary.refreshFailures++;
      logger.error('daily transition: refresh failed', { employeeId: n.id, ...describeError(e) });
    }
  }
  return summary;
}
