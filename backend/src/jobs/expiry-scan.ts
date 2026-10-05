// Expiry scan (spec §7.1; N1, N3, N4; owner decision D-39). Daily at 06:00 Asia/Riyadh.
//
// Milestones: credentials 60, 30, 14 and 7 days before the expiry date;
// contracts 90, 30, 14 and 7 days before the end date; both once it has passed ("0 days": the day after the last valid day — a credential is
// valid through its expiry date, a contract through its end date). Each run
// sends the milestone the record is in now, so a missed run or a record that
// enters late gets the current milestone, never a burst of old ones (N4).
//
// Routing (D-39, overrides N2's "HR at every notice"):
//   credentials — the nurse renews: employee at 60 and 30; + unit supervisor
//                 from 14; + scoped HR from 7 and at expiry.
//   contracts   — HR renews: employee and scoped HR from 90; + unit supervisor
//                 from 14 (the same cadence as credentials).
// A contract whose next period is already Approved or Active needs no reminder.
//
// Event key = record id + expiry date + milestone (N3), unique per recipient.
// Email waits for SMTP (not decided): rows are stored with emailStatus SKIPPED;
// unregistered employees get no in-app row.

import { addDays, daysBetween, dbDate, riyadhDate, toDbDate } from '../lib/dates.js';
import type { Db, DbClient } from '../lib/prisma.js';
import { unitRecipients } from '../modules/eligibility/state.service.js';

type Kind = 'CREDENTIAL' | 'CONTRACT';
/** Days before the last valid day. A credential's first milestone is its renewal window (RENEWAL_WINDOW_DAYS, §5.2 "Subject to Renew"). */
export const MILESTONES = { CREDENTIAL: [60, 30, 14, 7], CONTRACT: [90, 30, 14, 7] } as const;
type Milestone = 90 | 60 | 30 | 14 | 7 | 'expired';
type Audience = 'EMPLOYEE' | 'SUPERVISOR' | 'HR';

export const ROUTING: Record<Kind, Partial<Record<Milestone, Audience[]>>> = {
  CREDENTIAL: {
    60: ['EMPLOYEE'], 30: ['EMPLOYEE'], 14: ['EMPLOYEE', 'SUPERVISOR'],
    7: ['EMPLOYEE', 'SUPERVISOR', 'HR'], expired: ['EMPLOYEE', 'SUPERVISOR', 'HR'],
  },
  CONTRACT: {
    90: ['EMPLOYEE', 'HR'], 30: ['EMPLOYEE', 'HR'], 14: ['EMPLOYEE', 'SUPERVISOR', 'HR'],
    7: ['EMPLOYEE', 'SUPERVISOR', 'HR'], expired: ['EMPLOYEE', 'SUPERVISOR', 'HR'],
  },
};

/** The milestone a record is in, `daysLeft` days before its last valid day (0 = last day). */
export function milestoneFor(kind: Kind, daysLeft: number): Milestone | null {
  if (daysLeft < 0) return 'expired';
  const within = MILESTONES[kind].filter((m) => daysLeft <= m);
  return within.length ? within[within.length - 1]! : null;
}

type Notice = {
  kind: Kind; milestone: Milestone; employeeId: number; unitId: number | null; eventKey: string;
  title: string; message: string; titleAr: string; messageAr: string;
};

type Recipients = { own: Map<number, number>; supervisors: (unitId: number | null) => number[]; hr: (unitId: number | null) => number[] };

/** Each notice's new recipients; `sent` holds "recipientId eventKey" pairs that already have their row. */
function recipientsOf(n: Notice, r: Recipients, sent: Set<string>) {
  const audience = ROUTING[n.kind][n.milestone] ?? [];
  const ids: number[] = [];
  const own = r.own.get(n.employeeId);
  if (audience.includes('EMPLOYEE') && own !== undefined) ids.push(own);
  if (audience.includes('SUPERVISOR')) ids.push(...r.supervisors(n.unitId));
  if (audience.includes('HR')) ids.push(...r.hr(n.unitId));
  return [...new Set(ids)].filter((id) => !sent.has(`${id} ${n.eventKey}`));
}

// The expired milestone lasts until the record is renewed, so every run meets
// the same notices again. Recipients are resolved once per run and pairs that
// already have their row are skipped before the insert (skipDuplicates still
// guards against a concurrent run); per record, the cost is the new rows only.
async function deliver(db: DbClient, notices: Notice[], now: Date) {
  const employeeIds = [...new Set(notices.map((n) => n.employeeId))];
  const r: Recipients = {
    own: new Map((await db.user.findMany({ where: { employeeId: { in: employeeIds }, isActive: true }, select: { id: true, employeeId: true } }))
      .map((u) => [u.employeeId!, u.id])),
    supervisors: await unitRecipients(db, 'SUPERVISOR', now),
    hr: await unitRecipients(db, 'HR_ADMIN', now),
  };
  const sent = new Set<string>();
  for (let i = 0; i < notices.length; i += CHUNK) {
    const rows = await db.notification.findMany({ where: { eventKey: { in: notices.slice(i, i + CHUNK).map((n) => n.eventKey) } }, select: { recipientId: true, eventKey: true } });
    for (const row of rows) sent.add(`${row.recipientId} ${row.eventKey}`);
  }
  const data = notices.flatMap((n) => {
    const priority = n.milestone === 90 || n.milestone === 60 || n.milestone === 30 ? 'MEDIUM' as const : 'HIGH' as const;
    const { eventKey, title, message, titleAr, messageAr, employeeId } = n;
    return recipientsOf(n, r, sent).map((recipientId) => ({ recipientId, employeeId, type: n.kind, priority, eventKey, title, message, titleAr, messageAr }));
  });
  let count = 0;
  for (let i = 0; i < data.length; i += CHUNK) count += (await db.notification.createMany({ data: data.slice(i, i + CHUNK), skipDuplicates: true })).count;
  return count;
}

/** Rows or keys per statement, well under PostgreSQL's 65,535 bind parameters. */
const CHUNK = 1000;

export async function expiryScan(db: Db, now = new Date()) {
  const today = riyadhDate(now);
  const horizon = (kind: Kind) => toDbDate(addDays(today, MILESTONES[kind][0]));
  const summary = { contracts: 0, contractsEnded: 0, credentialsExpiring: 0, credentialsExpired: 0, notificationsCreated: 0 };
  const employee = { select: { unitId: true, jobNumber: true, fullName: true } } as const;

  const contracts = await db.contract.findMany({
    where: { status: { in: ['Approved', 'Active', 'Expired'] }, endDate: { lte: horizon('CONTRACT') }, employee: { deletedAt: null } },
    select: {
      id: true, employeeId: true, endDate: true, status: true,
      employee: { select: { ...employee.select, contracts: { where: { status: { in: ['Approved', 'Active'] } }, select: { id: true, endDate: true } } } },
    },
  });
  const credentials = await db.credential.findMany({
    where: {
      OR: [
        { status: { in: ['Valid', 'ExpiringSoon'] }, expiryDate: { gte: toDbDate(today), lte: horizon('CREDENTIAL') } },
        { status: { notIn: ['Suspended', 'Revoked', 'PendingVerification'] }, expiryDate: { lt: toDbDate(today) } },
      ],
      employee: { deletedAt: null },
    },
    select: { id: true, employeeId: true, expiryDate: true, template: { select: { name: true, nameAr: true } }, employee },
  });

  const notices: Notice[] = [];
  for (const c of contracts) {
    const end = dbDate(c.endDate);
    // The next period is already secured: nothing to remind.
    if (c.employee.contracts.some((o) => o.id !== c.id && dbDate(o.endDate) > end)) continue;
    const left = daysBetween(today, end);
    const milestone = milestoneFor('CONTRACT', left);
    // An Expired status only matters once the end date has passed; Approved/Active past their end are expired too.
    if (!milestone || (c.status === 'Expired' && milestone !== 'expired')) continue;
    const who = `${c.employee.jobNumber} ${c.employee.fullName}`;
    if (milestone === 'expired') {
      summary.contractsEnded += 1;
      notices.push({
        kind: 'CONTRACT', milestone, employeeId: c.employeeId, unitId: c.employee.unitId, eventKey: `contract:${c.id}:${end}:expired`,
        title: 'Contract ended', message: `${who}: the contract ended on ${end} and no next period is approved.`,
        titleAr: 'انتهى العقد', messageAr: `${who}: انتهى العقد في ${end} ولا توجد فترة تالية معتمدة.`,
      });
    } else {
      summary.contracts += 1;
      notices.push({
        kind: 'CONTRACT', milestone, employeeId: c.employeeId, unitId: c.employee.unitId, eventKey: `contract:${c.id}:${end}:within-${milestone}`,
        title: 'Contract ending soon', message: `${who}: the contract ends on ${end} (${left} days left).`,
        titleAr: 'العقد يقترب من الانتهاء', messageAr: `${who}: ينتهي العقد في ${end} (متبقٍ ${left} يومًا).`,
      });
    }
  }
  for (const c of credentials) {
    const expiry = dbDate(c.expiryDate!);
    const left = daysBetween(today, expiry);
    const milestone = milestoneFor('CREDENTIAL', left);
    if (!milestone) continue;
    const who = `${c.employee.jobNumber} ${c.employee.fullName}`;
    if (milestone === 'expired') {
      summary.credentialsExpired += 1;
      notices.push({
        kind: 'CREDENTIAL', milestone, employeeId: c.employeeId, unitId: c.employee.unitId, eventKey: `credential:${c.id}:${expiry}:expired`,
        title: 'Credential expired', message: `${who}: ${c.template.name} expired on ${expiry}.`,
        titleAr: 'انتهت صلاحية شهادة', messageAr: `${who}: انتهت صلاحية ${c.template.nameAr ?? c.template.name} في ${expiry}.`,
      });
    } else {
      summary.credentialsExpiring += 1;
      notices.push({
        kind: 'CREDENTIAL', milestone, employeeId: c.employeeId, unitId: c.employee.unitId, eventKey: `credential:${c.id}:${expiry}:within-${milestone}`,
        title: 'Credential expiring soon', message: `${who}: ${c.template.name} expires on ${expiry} (${left} days left). Start the renewal now.`,
        titleAr: 'شهادة تقترب من الانتهاء', messageAr: `${who}: تنتهي ${c.template.nameAr ?? c.template.name} في ${expiry} (متبقٍ ${left} يومًا). ابدأ التجديد الآن.`,
      });
    }
  }
  summary.notificationsCreated = await deliver(db, notices, now);
  return summary;
}
