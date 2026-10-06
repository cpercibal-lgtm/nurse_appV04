// E-mail dispatcher (spec §7.2; decision D-47). Every 60 seconds, under a
// 10-minute processing lease, it sends the PENDING notification e-mails and
// outbox e-mails through the hospital SMTP relay: up to SMTP_RETRY_MAX
// attempts, SMTP_RETRY_DELAY_SECONDS apart, then FAILED and logged.
//
// D-69: with EMAIL_HOURLY_LIMIT set, a run sends only what keeps the last 60
// minutes under the limit (UltaMail allows 200 per hour per domain); the rest
// waits as PENDING without using an attempt. Outbox mail (the break-glass
// alert) goes first, then notifications by priority, then announcement mail,
// so a large send never holds back a security e-mail.
//
// Delivery is at-least-once: a crash after the relay accepted a message but
// before the row is marked SENT sends it again (same Message-ID, so most
// clients show it once). With e-mail off, pending rows are marked SKIPPED.

import type { Env } from '../config/env.js';
import type { Notification } from '../generated/prisma/client.js';
import type { Prisma } from '../lib/prisma.js';
import { renderEmail } from '../lib/email-templates.js';
import { describeError, logger } from '../lib/logger.js';
import { senderDomain, type Mailer } from '../lib/mailer.js';
import type { Db } from '../lib/prisma.js';
import { withLease } from '../lib/worker-lease.js';

export interface DispatchConfig {
  retryMax: number;
  retryDelaySeconds: number;
  /** The app's public URL; notification e-mails link to its notifications page. */
  baseUrl: string;
  /** Right-hand side of Message-IDs, e.g. the sender's domain. */
  domain: string;
  batchSize?: number;
  /** D-69: most e-mails sent in any 60 minutes; 0 or unset = no limit. */
  hourlyLimit?: number;
}

export function dispatchConfigFrom(env: Env): DispatchConfig {
  return {
    retryMax: env.SMTP_RETRY_MAX, retryDelaySeconds: env.SMTP_RETRY_DELAY_SECONDS,
    baseUrl: env.APP_BASE_URL ?? env.CORS_ORIGIN, domain: senderDomain(env.SMTP_FROM),
    hourlyLimit: env.EMAIL_HOURLY_LIMIT,
  };
}

export interface DispatchSummary { sent: number; retrying: number; failed: number; skipped: number }

const URGENT = new Set(['CRITICAL', 'HIGH']);
const LEASE_SECONDS = 600; // spec §7.2: 10-minute processing lease

function errorText(e: unknown) {
  const code = (e as { responseCode?: number }).responseCode;
  const msg = e instanceof Error ? e.message : String(e);
  return (code ? `${code} ` : '') + msg.replace(/\s+/g, ' ').slice(0, 300);
}

export async function dispatchEmails(db: Db, mailer: Mailer, cfg: DispatchConfig, now = new Date()): Promise<DispatchSummary> {
  const out: DispatchSummary = { sent: 0, retrying: 0, failed: 0, skipped: 0 };
  if (!mailer.enabled) {
    const a = await db.notification.updateMany({ where: { emailStatus: 'PENDING' }, data: { emailStatus: 'SKIPPED' } });
    const b = await db.emailOutbox.updateMany({ where: { status: 'PENDING' }, data: { status: 'SKIPPED' } });
    out.skipped = a.count + b.count;
    return out;
  }
  const batch = cfg.batchSize ?? 100;
  const dueBefore = new Date(now.getTime() - cfg.retryDelaySeconds * 1000);
  let allowance = cfg.hourlyLimit ? Math.max(0, cfg.hourlyLimit - await sentInLastHour(db, now)) : Infinity;

  const base = cfg.baseUrl.replace(/\/$/, '');

  const sendOutbox = async (where: Prisma.EmailOutboxWhereInput) => {
    if (allowance <= 0) return;
    const rows = await db.emailOutbox.findMany({
      where: { AND: [where, { status: 'PENDING', OR: [{ lastAt: null }, { lastAt: { lte: dueBefore } }] }] },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }], take: Math.min(batch, allowance),
    });
    for (const m of rows) {
      const outcome = await attempt(mailer, cfg, m.attempts, {
        to: m.toAddress, subject: m.subject, text: m.bodyText, html: m.bodyHtml,
        messageId: `<outbox-${m.id}@${cfg.domain}>`, urgent: URGENT.has(m.priority),
      }, { kind: 'outbox', id: m.id });
      await db.emailOutbox.update({ where: { id: m.id }, data: { status: outcome.status, attempts: { increment: 1 }, lastAt: new Date(), lastError: outcome.error } });
      count(out, outcome.status);
      allowance--;
    }
  };

  const sendNotifications = async (where: Prisma.NotificationWhereInput) => {
    if (allowance <= 0) return;
    const rows = await db.notification.findMany({
      where: { AND: [where, { emailStatus: 'PENDING', OR: [{ emailLastAt: null }, { emailLastAt: { lte: dueBefore } }] }] },
      include: { recipient: { select: { email: true, isActive: true } } },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }], take: Math.min(batch, allowance),
    });
    for (const n of rows) {
      if (!n.recipient.isActive) {
        await db.notification.update({ where: { id: n.id }, data: { emailStatus: 'SKIPPED' } });
        out.skipped++;
        continue;
      }
      // D-69: an announcement's button opens the announcement itself.
      const link = n.announcementId ? `${base}/announcements?id=${n.announcementId}` : `${base}/notifications`;
      const outcome = await attempt(mailer, cfg, n.emailAttempts, {
        to: n.recipient.email, ...renderEmail({ ...n, link }),
        messageId: `<notification-${n.id}@${cfg.domain}>`, urgent: URGENT.has(n.priority),
      }, { kind: 'notification', id: n.id });
      await db.notification.update({ where: { id: n.id }, data: { emailStatus: outcome.status, emailAttempts: { increment: 1 }, emailLastAt: new Date(), emailLastError: outcome.error } });
      count(out, outcome.status);
      allowance--;
    }
  };

  // Order (D-69): outbox mail (the break-glass alert), then notifications most urgent first
  // (the enum sorts CRITICAL → LOW), then announcements — to accounts, then to staff without one.
  const announcementMail = { eventKey: { startsWith: 'announcement:' } };
  await sendOutbox({ NOT: announcementMail });
  await sendNotifications({ type: { not: 'ANNOUNCEMENT' } });
  await sendNotifications({ type: 'ANNOUNCEMENT' });
  await sendOutbox(announcementMail);
  return out;
}

/** E-mails the relay accepted in the hour before `now`, notifications and outbox together (D-69). */
export async function sentInLastHour(db: Db, now = new Date()) {
  const since = new Date(now.getTime() - 3_600_000);
  const [notifications, outbox] = await Promise.all([
    db.notification.count({ where: { emailStatus: 'SENT', emailLastAt: { gte: since } } }),
    db.emailOutbox.count({ where: { status: 'SENT', lastAt: { gte: since } } }),
  ]);
  return notifications + outbox;
}

type Outcome = { status: Notification['emailStatus']; error: string | null };

async function attempt(mailer: Mailer, cfg: DispatchConfig, previousAttempts: number, mail: Parameters<Mailer['send']>[0], ref: { kind: string; id: number }): Promise<Outcome> {
  try {
    await mailer.send(mail);
    return { status: 'SENT', error: null };
  } catch (e) {
    const error = errorText(e);
    const attemptNo = previousAttempts + 1;
    if (attemptNo >= cfg.retryMax) {
      // No address or content in the log: identifiers only.
      logger.error('e-mail delivery failed; giving up', { kind: ref.kind, id: ref.id, attempts: attemptNo, error });
      return { status: 'FAILED', error };
    }
    logger.warn('e-mail delivery failed; will retry', { kind: ref.kind, id: ref.id, attempt: attemptNo, of: cfg.retryMax, error });
    return { status: 'PENDING', error };
  }
}

function count(out: DispatchSummary, status: Notification['emailStatus']) {
  if (status === 'SENT') out.sent++;
  else if (status === 'FAILED') out.failed++;
  else out.retrying++;
}

/** Runs the dispatcher every `intervalMs` under the worker lease; returns a stop function. Runs never overlap. */
export function startEmailDispatcher(db: Db, mailer: Mailer, cfg: DispatchConfig, intervalMs = 60_000) {
  let running = false;
  const beat = async () => {
    if (running) return;
    running = true;
    try {
      const out = await withLease(db, 'email-dispatch', LEASE_SECONDS, () => dispatchEmails(db, mailer, cfg));
      if (out.ran && (out.result.sent || out.result.failed || out.result.retrying)) logger.info('e-mail dispatch', { ...out.result });
    } catch (e) {
      logger.error('e-mail dispatch failed', describeError(e));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void beat(), intervalMs);
  void beat();
  logger.info('e-mail dispatcher started', { enabled: mailer.enabled });
  return () => clearInterval(timer);
}
