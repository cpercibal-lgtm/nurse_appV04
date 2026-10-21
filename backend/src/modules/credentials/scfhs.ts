// SCFHS licence verification (spec §5.4, D-64). A credential whose type has
// scfhs_enabled is checked against the SCFHS registry:
//   MANUAL     — HR presses "Check with SCFHS" on the credential;
//   ON_SUBMIT  — right after the credential is recorded;
//   SCHEDULED  — the nightly scfhs-sync job, for every current credential.
//
// Every check is logged in scfhs_verification_log (the number only as its last
// four characters, the response only as its hash). What follows from it:
//   VERIFIED, dates agree         → nothing;
//   VERIFIED/EXPIRED, dates differ, or NOT_FOUND → the scoped HR admins are told
//                                   (HR corrects the record; SCFHS never
//                                   overwrites it silently);
//   SUSPENDED / REVOKED           → with scfhs_auto_suspend: the credential is
//                                   Suspended at once (eligibility re-evaluated,
//                                   audited HIGH) and HR told; otherwise HR told.
//                                   Revoking stays an HR decision: the council's
//                                   data can be wrong, a suspension can be undone.
//   ERROR (unreachable)           → logged; the nightly run stops after
//                                   MAX_CONSECUTIVE_ERRORS in a row (circuit breaker).
// A notice is sent once per credential and SCFHS answer (event key).

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { dbDate } from '../../lib/dates.js';
import { describeError, logger } from '../../lib/logger.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { maskReg, normalizeReg, ScfhsUnavailableError, type ScfhsGateway, type ScfhsLookup } from '../../lib/scfhs.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import { refreshEligibility, recipientsForUnit } from '../eligibility/state.service.js';
import type { AuthContext } from '../users/access.js';
import { viewerOf } from './access.js';
import type { Protection } from '../pdpl/protection.js';

/** D-74: a human observation from the official website, never a gateway lookup. */
export const WebsiteCheckBody = z.strictObject({
  status: z.enum(['VERIFIED', 'EXPIRED', 'SUSPENDED', 'REVOKED', 'NOT_FOUND', 'ERROR']),
  checkedAt: z.string().datetime({ offset: true }),
  notes: z.string().trim().min(10).max(1000),
  evidenceDocumentId: z.number().int().positive(),
});

export type ScfhsRequestType = 'MANUAL' | 'ON_SUBMIT' | 'SCHEDULED';
export type ScfhsAction = 'NONE' | 'HR_NOTIFIED' | 'SUSPENDED';
export const MAX_CONSECUTIVE_ERRORS = 5;
/** Checked by the nightly run: credentials that currently count, or are waiting to. */
const CHECKED_STATUSES = ['PendingVerification', 'Valid', 'ExpiringSoon'] as const;
const SUSPENDABLE = ['PendingVerification', 'Valid', 'ExpiringSoon', 'Expired'];

export interface ScfhsCheckResult {
  checked: boolean;
  /** Why no check was made (the type is not SCFHS-checked, no number recorded, the number erased). */
  skipped?: 'NOT_ENABLED' | 'NO_NUMBER' | 'ERASED';
  status?: ScfhsLookup['status'] | 'ERROR';
  matched?: boolean | null;
  discrepancies?: string[];
  action?: ScfhsAction;
  logId?: string;
}

export function createScfhsService(db: Db, gateway: ScfhsGateway, protection: Protection) {
  /** The registration number from the credential's SCFHS_REG field, opened (D-54). */
  async function registrationOf(c: { employeeId: number; trackingData: unknown }, key: string) {
    const opened = await protection.reveal(db, c.employeeId, c.trackingData);
    if (opened.erased) return { erased: true as const };
    const v = (opened.data as Record<string, unknown> | null)?.[key];
    return { reg: typeof v === 'string' && v.trim() ? normalizeReg(v) : null };
  }

  async function notifyHr(tx: DbClient, c: { id: number; employeeId: number; employee: { unitId: number | null; fullName: string; jobNumber: string }; template: { name: string; nameAr: string | null } }, eventKey: string, what: string, whatAr: string) {
    const ids = await recipientsForUnit(tx, 'HR_ADMIN', c.employee.unitId);
    const who = `${c.employee.fullName} (${c.employee.jobNumber})`;
    await tx.notification.createMany({
      data: [...new Set(ids)].map((recipientId) => ({
        recipientId, employeeId: c.employeeId, type: 'CREDENTIAL' as const, priority: 'HIGH' as const, eventKey,
        title: `SCFHS: ${c.template.name} of ${who}`, message: what,
        titleAr: `الهيئة السعودية للتخصصات الصحية: ${c.template.nameAr ?? c.template.name} — ${who}`, messageAr: whatAr,
      })),
      skipDuplicates: true,
    });
    return ids.length;
  }

  /** Checks one credential with SCFHS and acts on the answer. Never throws for an SCFHS failure. */
  async function check(credentialId: number, requestType: ScfhsRequestType, actorUserId: number | null, requestId?: string): Promise<ScfhsCheckResult> {
    const c = await db.credential.findUnique({
      where: { id: credentialId },
      include: {
        template: { select: { name: true, nameAr: true, scfhsEnabled: true, scfhsAutoSuspend: true, fields: { where: { pdplCategory: 'SCFHS_REG' }, select: { key: true } } } },
        employee: { select: { unitId: true, fullName: true, jobNumber: true } },
      },
    });
    if (!c) return { checked: false, skipped: 'NOT_ENABLED' };
    const key = c.template.fields[0]?.key;
    if (!c.template.scfhsEnabled || !key) return { checked: false, skipped: 'NOT_ENABLED' };
    const number = await registrationOf(c, key);
    if ('erased' in number) return { checked: false, skipped: 'ERASED' };
    if (!number.reg) return { checked: false, skipped: 'NO_NUMBER' };

    const requestedAt = new Date();
    let answer: ScfhsLookup | null = null;
    let error: string | null = null;
    try {
      answer = await gateway.lookup(number.reg);
    } catch (e) {
      error = (e instanceof ScfhsUnavailableError ? e.message : `SCFHS lookup failed: ${(e as Error).message}`).slice(0, 500);
      if (!(e instanceof ScfhsUnavailableError)) logger.error('scfhs lookup failed', { credentialId, ...describeError(e) });
    }
    const respondedAt = answer ? new Date() : null;
    const base = {
      credentialId: c.id, employeeId: c.employeeId, regNumberHint: maskReg(number.reg), requestType, driver: gateway.driver,
      requestedAt, respondedAt, actorUserId,
    };

    if (!answer) {
      const log = await db.scfhsCheck.create({ data: { ...base, responseStatus: 'ERROR', errorMessage: error, action: 'NONE', discrepancies: [] } });
      if (requestType === 'MANUAL') {
        await appendAudit(db, { actorUserId, action: 'SCFHS_CHECKED', resource: 'credential', resourceId: c.id, changes: { employeeId: c.employeeId, status: 'ERROR', logId: log.id.toString() }, requestId });
      }
      return { checked: true, status: 'ERROR', matched: null, discrepancies: [], action: 'NONE', logId: log.id.toString() };
    }

    // Compare with what the hospital recorded.
    const localExpiry = c.expiryDate ? dbDate(c.expiryDate) : null;
    const discrepancies: string[] = [];
    if (answer.expiryDate && localExpiry && answer.expiryDate !== localExpiry) discrepancies.push(`Expiry date: recorded ${localExpiry}, SCFHS ${answer.expiryDate}`);
    if (answer.expiryDate && !localExpiry) discrepancies.push(`Expiry date: none recorded, SCFHS ${answer.expiryDate}`);
    // SCFHS saying EXPIRED about a credential the hospital already holds as Expired is agreement, not news.
    if (answer.status !== 'VERIFIED' && !(answer.status === 'EXPIRED' && c.status === 'Expired')) discrepancies.push(`SCFHS status: ${answer.status}`);
    const matched = discrepancies.length === 0;

    return db.$transaction(async (tx) => {
      const adverse = answer.status === 'SUSPENDED' || answer.status === 'REVOKED';
      let action: ScfhsAction = 'NONE';
      const log = await tx.scfhsCheck.create({
        data: {
          ...base, responseStatus: answer.status, scfhsExpiryDate: answer.expiryDate, scfhsSpecialty: answer.specialty,
          scfhsLicenseStatus: answer.licenseStatus, responseHash: answer.responseHash, matched, discrepancies, action,
        },
      });
      // Mock responses are demonstration data and must never affect real credential state.
      if (gateway.driver === 'live' && adverse && c.template.scfhsAutoSuspend && SUSPENDABLE.includes(c.status)) {
        const reason = `SCFHS reports the licence ${answer.status} (check ${log.id})`;
        await tx.credential.update({ where: { id: c.id }, data: { status: 'Suspended', statusReason: reason, ...(c.graceCycleId && !c.graceCycleId.endsWith(':closed') ? { graceCycleId: `${c.graceCycleId}:closed` } : {}) } });
        await appendAudit(tx, {
          actorUserId, action: 'CREDENTIAL_SCFHS_SUSPENDED', resource: 'credential', resourceId: c.id,
          changes: { employeeId: c.employeeId, from: c.status, scfhsStatus: answer.status, logId: log.id.toString(), requestType }, requestId, priority: 'HIGH',
        });
        await refreshEligibility(tx, c.employeeId, 'CREDENTIAL_SUSPENDED', { actorUserId, requestId });
        action = 'SUSPENDED';
      }
      if (!matched && !(c.status === 'Suspended' && adverse) && c.status !== 'Revoked') {
        const eventKey = `scfhs:${c.id}:${answer.status}:${answer.expiryDate ?? '-'}`;
        const what = action === 'SUSPENDED'
          ? `SCFHS reports this licence ${answer.status}. The credential was suspended automatically and eligibility re-checked — review it and revoke or restore it.`
          : `SCFHS answered differently from the record — ${discrepancies.join('; ')}. Review the credential.`;
        const whatAr = action === 'SUSPENDED'
          ? `تفيد الهيئة بأن الترخيص ${answer.status}. عُلّق الاعتماد تلقائياً وأُعيد تقييم الأهلية — راجعه وقرّر إلغاءه أو إعادته.`
          : `تختلف إجابة الهيئة عن السجل — ${discrepancies.join('؛ ')}. راجع الاعتماد.`;
        await notifyHr(tx, c, eventKey, what, whatAr);
        if (action === 'NONE') action = 'HR_NOTIFIED';
      }
      if (action !== 'NONE') await tx.scfhsCheck.update({ where: { id: log.id }, data: { action } });
      if (requestType === 'MANUAL') {
        await appendAudit(tx, { actorUserId, action: 'SCFHS_CHECKED', resource: 'credential', resourceId: c.id, changes: { employeeId: c.employeeId, status: answer.status, matched, action, logId: log.id.toString() }, requestId });
      }
      return { checked: true, status: answer.status, matched, discrepancies, action, logId: log.id.toString() };
    });
  }

  /** Record only. No gateway, notification, credential update or eligibility refresh. */
  async function recordWebsiteCheck(auth: AuthContext, credentialId: number, input: z.infer<typeof WebsiteCheckBody>, requestId?: string) {
    const body = WebsiteCheckBody.parse(input);
    const checkedAt = new Date(body.checkedAt);
    if (checkedAt > new Date()) throw new HttpError(422, 'SCFHS_CHECK_IN_FUTURE', 'The website check time cannot be in the future');
    return db.$transaction(async (tx) => {
      const c = await tx.credential.findUnique({ where: { id: credentialId }, include: { template: { select: { scfhsEnabled: true } } } });
      if (!c) throw notFound('Credential not found');
      await viewerOf(tx, auth, c.employeeId, ['HR']);
      if (!c.template.scfhsEnabled) throw new HttpError(422, 'SCFHS_NOT_ENABLED', 'This credential type is not checked with SCFHS');
      const evidence = await tx.documentVersion.findFirst({
        where: { id: body.evidenceDocumentId, credentialId, scanStatus: 'CLEAN', erasedAt: null },
        select: { id: true },
      });
      if (!evidence) throw new HttpError(422, 'SCFHS_EVIDENCE_INVALID', 'Select a clean, available evidence file belonging to this credential');
      const log = await tx.scfhsCheck.create({ data: {
        credentialId, employeeId: c.employeeId, regNumberHint: '…', requestType: 'WEBSITE', driver: 'manual',
        responseStatus: body.status, action: 'NONE', discrepancies: [], matched: null, actorUserId: auth.user.id,
        manualCheckedAt: checkedAt, manualNotes: body.notes, evidenceDocumentId: evidence.id,
        errorMessage: body.status === 'ERROR' ? 'The website check could not verify the licence' : null,
      } });
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'SCFHS_WEBSITE_CHECK_RECORDED', resource: 'credential', resourceId: credentialId,
        changes: { employeeId: c.employeeId, logId: log.id.toString(), status: body.status, checkedAt: checkedAt.toISOString(), evidenceDocumentId: evidence.id }, requestId });
      return { ...log, id: log.id.toString() };
    });
  }

  /** The nightly run over every current SCFHS-checked credential. */
  async function syncAll(now = new Date()) {
    const due = await db.credential.findMany({
      where: { status: { in: [...CHECKED_STATUSES] }, template: { scfhsEnabled: true }, employee: { deletedAt: null } },
      select: { id: true }, orderBy: { id: 'asc' },
    });
    const summary = { due: due.length, checked: 0, verified: 0, discrepancies: 0, suspended: 0, notified: 0, errors: 0, skipped: 0, stoppedAfterErrors: false, driver: gateway.driver, at: now.toISOString() };
    let consecutive = 0;
    for (const { id } of due) {
      const r = await check(id, 'SCHEDULED', null);
      if (!r.checked) { summary.skipped++; continue; }
      summary.checked++;
      if (r.status === 'ERROR') {
        summary.errors++;
        if (++consecutive >= MAX_CONSECUTIVE_ERRORS) { summary.stoppedAfterErrors = true; break; }
        continue;
      }
      consecutive = 0;
      if (r.matched) summary.verified++; else summary.discrepancies++;
      if (r.action === 'SUSPENDED') summary.suspended++;
      if (r.action === 'HR_NOTIFIED') summary.notified++;
    }
    if (summary.stoppedAfterErrors) logger.warn('scfhs sync stopped: the service kept failing', { errors: summary.errors });
    return summary;
  }

  /** The latest checks of one credential, newest first. */
  const history = (credentialId: number, take = 20) =>
    db.scfhsCheck.findMany({ where: { credentialId }, orderBy: { id: 'desc' }, take })
      .then((rows) => rows.map((r) => ({ ...r, id: r.id.toString() })));

  /** HR (or a System Admin) whose scope covers the credential's holder. */
  async function assertHr(auth: AuthContext, credentialId: number) {
    const c = await db.credential.findUnique({ where: { id: credentialId }, select: { employeeId: true } });
    if (!c) throw notFound('Credential not found');
    await viewerOf(db, auth, c.employeeId, ['HR']);
  }

  return { check, recordWebsiteCheck, syncAll, history, assertHr, driver: gateway.driver };
}

export type ScfhsService = ReturnType<typeof createScfhsService>;
