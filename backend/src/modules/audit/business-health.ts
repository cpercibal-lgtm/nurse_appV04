// Business health (spec §10.8): "SLA" signals for the silent failures that a
// liveness probe cannot see. GET /api/v1/system/health/business (System Admin).
//
// - Eligibility: the consistency auditor's last run and 7-day drift rate.
// - Jobs: each scheduled job's last completed run; older than its maxAgeMinutes,
//   or last attempt failed → attention.
// - E-mail (D-47): pending older than 15 minutes, failures in the last 24 hours.
//
// The spec's SCFHS sync freshness and weekly evidence checksum signals belong to
// modules that are not built (§5.4, §5.3 vault) and are not reported.

import { RESPONSE_DAYS } from '../pdpl/requests.js';
import { signOffState } from '../pdpl/register.js';
import { JOBS } from '../../jobs/scheduler.js';
import type { Db } from '../../lib/prisma.js';

export interface Issue { code: string; message: string }

const MINUTE = 60_000;

/** B-18: the ids of the keys in use, and which previous keys are still configured. */
export interface KeyStatus { masterKeyId: number; pepperId: number; previous: string[] }

export async function businessHealth(db: Db, now = new Date(), keyStatus?: KeyStatus) {
  const issues: Issue[] = [];
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * MINUTE);

  // ── Eligibility consistency ────────────────────────────────────────────────
  const auditRuns = await db.jobRun.findMany({ where: { jobName: 'consistency-audit', status: 'COMPLETED', finishedAt: { gte: weekAgo } }, orderBy: { finishedAt: 'desc' } });
  const checked7d = auditRuns.reduce((n, r) => n + Number((r.summary as { checked?: number } | null)?.checked ?? 0), 0);
  const drifts7d = await db.consistencyAuditLog.count({ where: { detectedAt: { gte: weekAgo } } });
  const last = auditRuns[0];
  const lastSummary = (last?.summary ?? null) as { checked?: number; drifted?: number } | null;
  if (lastSummary?.drifted) issues.push({ code: 'ELIGIBILITY_DRIFT', message: `The last consistency audit corrected ${lastSummary.drifted} nurse(s)` });
  const recentDrifts = await db.consistencyAuditLog.findMany({
    where: { detectedAt: { gte: weekAgo } }, orderBy: { detectedAt: 'desc' }, take: 20,
    select: { employeeId: true, expectedStatus: true, actualStatus: true, detectedAt: true, employee: { select: { jobNumber: true } } },
  });

  // ── Scheduled jobs ─────────────────────────────────────────────────────────
  const jobs = [];
  for (const job of JOBS) {
    const [lastDone, lastAttempt] = await Promise.all([
      db.jobRun.findFirst({ where: { jobName: job.name, status: 'COMPLETED' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } }),
      db.jobRun.findFirst({ where: { jobName: job.name }, orderBy: { startedAt: 'desc' }, select: { status: true, error: true } }),
    ]);
    const ageMinutes = lastDone?.finishedAt ? Math.floor((now.getTime() - lastDone.finishedAt.getTime()) / MINUTE) : null;
    const stale = ageMinutes === null || ageMinutes > job.maxAgeMinutes;
    const failed = lastAttempt?.status === 'FAILED';
    if (stale) issues.push({ code: 'JOB_STALE', message: ageMinutes === null ? `${job.name} has never completed` : `${job.name} last completed ${ageMinutes} minutes ago` });
    if (failed) issues.push({ code: 'JOB_FAILED', message: `${job.name}'s last attempt failed: ${lastAttempt?.error ?? 'unknown error'}` });
    jobs.push({ name: job.name, schedule: job.schedule, lastCompletedAt: lastDone?.finishedAt ?? null, ageMinutes, maxAgeMinutes: job.maxAgeMinutes, stale, lastAttemptFailed: failed });
  }

  // ── Document vault (D-53) ──────────────────────────────────────────────────
  const lastVault = await db.jobRun.findFirst({ where: { jobName: 'vault-reconcile', status: 'COMPLETED' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true, summary: true } });
  const vs = (lastVault?.summary ?? null) as { objects?: number; documents?: number; missing?: number; integrityFailures?: number; sampled?: number; legacyPlaintext?: number; orphansRemoved?: number } | null;
  if (vs?.missing) issues.push({ code: 'VAULT_MISSING', message: `${vs.missing} stored document(s) are missing — restore them from backup` });
  if (vs?.integrityFailures) issues.push({ code: 'VAULT_INTEGRITY', message: `${vs.integrityFailures} stored document(s) failed the integrity check` });
  if (vs?.legacyPlaintext) issues.push({ code: 'VAULT_PLAINTEXT', message: `${vs.legacyPlaintext} document(s) are stored unencrypted — run npm run vault:encrypt` });
  const vault = {
    lastCheckAt: lastVault?.finishedAt ?? null, documents: vs?.documents ?? null, missing: vs?.missing ?? null,
    sampled: vs?.sampled ?? null, integrityFailures: vs?.integrityFailures ?? null, legacyPlaintext: vs?.legacyPlaintext ?? null, orphansRemoved: vs?.orphansRemoved ?? null,
  };

  // ── Sensitive personal data (D-54) ─────────────────────────────────────────
  // Values of fields marked sensitive that are still stored in clear (before
  // `npm run pdpl:protect`, or a field marked sensitive after data was entered).
  const [plain] = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM credentials c
      JOIN credential_template_fields f ON f.template_id = c.template_id AND f.pdpl_category IS NOT NULL
     WHERE (coalesce(c.tracking_data ->> f.key, '') NOT IN ('') AND c.tracking_data ->> f.key NOT LIKE 'pdpl:v1:%')
        OR (coalesce(c.pending_data -> 'trackingData' ->> f.key, '') NOT IN ('') AND c.pending_data -> 'trackingData' ->> f.key NOT LIKE 'pdpl:v1:%')`;
  // D-55: data-subject requests still open past the 30-day answer deadline.
  const overdueRequests = await db.dataSubjectRequest.count({ where: { status: { in: ['RECEIVED', 'IN_REVIEW', 'APPROVED'] }, requestedAt: { lt: new Date(now.getTime() - RESPONSE_DAYS * 86_400_000) } } });
  const signOff = await signOffState(db, now);
  const pdpl = { unprotectedValues: Number(plain?.n ?? 0), overdueRequests, signOff: { lastAt: signOff.last?.reviewedAt ?? null, changedSince: signOff.changedSince, due: signOff.due } };
  if (signOff.due) {
    issues.push({ code: 'PDPL_REGISTER_SIGN_OFF_DUE', message: !signOff.last ? 'The processing register has never been signed off by the Data Protection Officer (Nursing Administration → Data protection)'
      : signOff.changedSince ? 'The processing register changed since the Data Protection Officer last signed it off' : 'The yearly Data Protection Officer sign-off of the processing register is due' });
  }
  if (pdpl.unprotectedValues > 0) issues.push({ code: 'PDPL_PLAINTEXT', message: `${pdpl.unprotectedValues} sensitive value(s) are stored unencrypted — run npm run pdpl:protect` });
  if (overdueRequests > 0) issues.push({ code: 'PDPL_REQUESTS_OVERDUE', message: `${overdueRequests} personal-data request(s) are past the 30-day answer deadline (Nursing Administration → Data protection)` });

  // ── SCFHS licence checks (spec §5.4, §10.8 "SCFHS sync freshness", D-64) ──
  const lastScfhs = await db.jobRun.findFirst({ where: { jobName: 'scfhs-sync', status: 'COMPLETED' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true, summary: true } });
  const ss = (lastScfhs?.summary ?? null) as { due?: number; checked?: number; discrepancies?: number; suspended?: number; errors?: number; stoppedAfterErrors?: boolean; driver?: string } | null;
  if (ss?.stoppedAfterErrors) issues.push({ code: 'SCFHS_UNREACHABLE', message: `The last SCFHS check stopped after ${ss.errors} failure(s) in a row — SCFHS could not be reached; ${Math.max(0, (ss.due ?? 0) - (ss.checked ?? 0))} licence(s) went unchecked` });
  else if (ss?.errors) issues.push({ code: 'SCFHS_ERRORS', message: `${ss.errors} licence check(s) with SCFHS failed in the last run` });
  const scfhs = {
    lastSyncAt: lastScfhs?.finishedAt ?? null, driver: ss?.driver ?? null, due: ss?.due ?? null, checked: ss?.checked ?? null,
    discrepancies: ss?.discrepancies ?? null, suspended: ss?.suspended ?? null, errors: ss?.errors ?? null,
  };

  // ── Eligibility logic, shadow mode (spec §10.9, D-60) ───────────────────────
  const logicRows = await db.eligibilityLogicVersion.findMany({ where: { status: { in: ['ACTIVE', 'SHADOW'] } } });
  const activeLogic = logicRows.find((v) => v.status === 'ACTIVE');
  const shadowLogic = logicRows.find((v) => v.status === 'SHADOW');
  const shadowUndecided = shadowLogic ? await db.eligibilityShadowLog.count({ where: { logicVersion: shadowLogic.version, decision: null } }) : 0;
  const staleStates = activeLogic ? await db.eligibilityState.count({ where: { logicVersion: { not: activeLogic.version } } }) : 0;
  if (shadowUndecided > 0) issues.push({ code: 'ELIGIBILITY_SHADOW_UNDECIDED', message: `Eligibility logic version ${shadowLogic!.version} (in shadow) disagreed with the active logic on ${shadowUndecided} evaluation(s) awaiting an HR decision (Nursing Administration → Eligibility logic)` });
  // Right after a promotion the re-evaluation is still running; an hour later every state should be on the new logic.
  if (staleStates > 0 && activeLogic?.promotedAt && now.getTime() - activeLogic.promotedAt.getTime() > 60 * MINUTE) {
    issues.push({ code: 'ELIGIBILITY_LOGIC_STALE', message: `${staleStates} stored eligibility state(s) were calculated with an older logic than version ${activeLogic.version}; the daily transition recalculates them` });
  }

  // ── E-mail delivery ────────────────────────────────────────────────────────
  const stuckBefore = new Date(now.getTime() - 15 * MINUTE);
  const dayAgo = new Date(now.getTime() - 24 * 60 * MINUTE);
  // D-69: announcement mail waits behind the hourly limit by design; it has its own, longer threshold.
  const announcementStuckBefore = new Date(now.getTime() - 6 * 60 * MINUTE);
  const notAnnouncement = { NOT: { eventKey: { startsWith: 'announcement:' } } };
  const [pendingN, pendingO, failedN, failedO, lastN, lastO, annN, annO] = await Promise.all([
    db.notification.count({ where: { emailStatus: 'PENDING', createdAt: { lt: stuckBefore }, type: { not: 'ANNOUNCEMENT' } } }),
    db.emailOutbox.count({ where: { status: 'PENDING', createdAt: { lt: stuckBefore }, ...notAnnouncement } }),
    db.notification.count({ where: { emailStatus: 'FAILED', emailLastAt: { gte: dayAgo } } }),
    db.emailOutbox.count({ where: { status: 'FAILED', lastAt: { gte: dayAgo } } }),
    db.notification.findFirst({ where: { emailStatus: 'SENT' }, orderBy: { emailLastAt: 'desc' }, select: { emailLastAt: true } }),
    db.emailOutbox.findFirst({ where: { status: 'SENT' }, orderBy: { lastAt: 'desc' }, select: { lastAt: true } }),
    db.notification.count({ where: { emailStatus: 'PENDING', createdAt: { lt: announcementStuckBefore }, type: 'ANNOUNCEMENT' } }),
    db.emailOutbox.count({ where: { status: 'PENDING', createdAt: { lt: announcementStuckBefore }, eventKey: { startsWith: 'announcement:' } } }),
  ]);
  const email = {
    pendingOver15Minutes: pendingN + pendingO,
    failedLast24Hours: failedN + failedO,
    lastSentAt: [lastN?.emailLastAt, lastO?.lastAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
    announcementsPendingOver6Hours: annN + annO,
  };
  if (email.pendingOver15Minutes > 0) issues.push({ code: 'EMAIL_BACKLOG', message: `${email.pendingOver15Minutes} e-mail(s) waiting more than 15 minutes` });
  if (email.announcementsPendingOver6Hours > 0) issues.push({ code: 'ANNOUNCEMENT_EMAIL_BACKLOG', message: `${email.announcementsPendingOver6Hours} announcement e-mail(s) waiting more than 6 hours — check EMAIL_HOURLY_LIMIT and the relay` });
  if (email.failedLast24Hours > 0) issues.push({ code: 'EMAIL_FAILED', message: `${email.failedLast24Hours} e-mail(s) failed in the last 24 hours` });

  // ── Telegram delivery (D-66) ──────────────────────────────────────────────
  const [tgPending, tgFailed, tgLast, tgLinked] = await Promise.all([
    db.notification.count({ where: { telegramStatus: 'PENDING', createdAt: { lt: stuckBefore } } }),
    db.notification.count({ where: { telegramStatus: 'FAILED', telegramLastAt: { gte: dayAgo } } }),
    db.notification.findFirst({ where: { telegramStatus: 'SENT' }, orderBy: { telegramLastAt: 'desc' }, select: { telegramLastAt: true } }),
    db.user.count({ where: { telegramChatId: { not: null }, isActive: true } }),
  ]);
  const telegram = { pendingOver15Minutes: tgPending, failedLast24Hours: tgFailed, lastSentAt: tgLast?.telegramLastAt ?? null, linkedAccounts: tgLinked };
  if (telegram.pendingOver15Minutes > 0) issues.push({ code: 'TELEGRAM_BACKLOG', message: `${telegram.pendingOver15Minutes} Telegram announcement(s) waiting more than 15 minutes` });
  if (telegram.failedLast24Hours > 0) issues.push({ code: 'TELEGRAM_FAILED', message: `${telegram.failedLast24Hours} notification(s) could not be announced by Telegram in the last 24 hours` });

  // ── Key rotation (B-18) ───────────────────────────────────────────────────
  const keys = keyStatus ? {
    previousConfigured: keyStatus.previous,
    employeeKeysOnOldKey: await db.employeeKey.count({ where: { wrappedKey: { not: null }, keyVersion: { not: keyStatus.masterKeyId } } }),
    searchRowsOnOldPepper: await db.pdplIdentifierIndex.count({ where: { keyVersion: { not: keyStatus.pepperId } } }),
  } : null;
  if (keys && (keys.previousConfigured.length > 0 || keys.employeeKeysOnOldKey > 0 || keys.searchRowsOnOldPepper > 0)) {
    const parts = [
      ...(keys.previousConfigured.length > 0 ? [`previous key(s) still configured: ${keys.previousConfigured.join(', ')}`] : []),
      ...(keys.employeeKeysOnOldKey > 0 ? [`${keys.employeeKeysOnOldKey} employee key(s) under an older master key`] : []),
      ...(keys.searchRowsOnOldPepper > 0 ? [`${keys.searchRowsOnOldPepper} search row(s) under an older pepper`] : []),
    ];
    issues.push({ code: 'KEY_ROTATION_PENDING', message: `Key rotation not finished — ${parts.join('; ')}. Run npm run keys:rotate, then remove the previous keys` });
  }

  return {
    status: issues.length === 0 ? 'HEALTHY' as const : 'ATTENTION' as const,
    issues,
    eligibility: {
      lastAuditAt: last?.finishedAt ?? null, lastChecked: lastSummary?.checked ?? null, lastDrifted: lastSummary?.drifted ?? null,
      checked7d, drifts7d, driftRate7d: checked7d > 0 ? drifts7d / checked7d : null,
      recentDrifts: recentDrifts.map((d) => ({ employeeId: d.employeeId, jobNumber: d.employee.jobNumber, expected: d.expectedStatus, stored: d.actualStatus, detectedAt: d.detectedAt })),
    },
    jobs,
    vault,
    scfhs,
    pdpl,
    keys,
    email,
    telegram,
    generatedAt: now,
  };
}
