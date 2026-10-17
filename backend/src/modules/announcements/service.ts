// Announcements (D-69; owner decisions 2026-10-05): memos, meeting schedules and
// seminar notices. A sender writes a draft, previews who it reaches, and submits:
//   - a Supervisor addressing only units they supervise publishes at once;
//   - every other send (any HR Admin or System Admin send, any department or
//     hospital audience) waits for a second administrator in the shared
//     Approvals queue (approvals.ts calls executeApproved / onRejected /
//     onWithdrawn below); a break-glass session publishes at once (spec §3.6).
// Publication fans out, in one transaction: one notifications row per recipient
// account (in-app; e-mail and the content-free Telegram prompt go through the
// existing dispatchers) and one email_outbox row per contact address of staff
// in the audience who have no account (owner Q6), all with event key
// `announcement:<id>`. Nothing is edited once sent (owner Q4): a published
// announcement is cancelled, which stops whatever has not been delivered yet.

import { inTransaction, type Transaction } from '../../lib/transaction.js';
import { z } from 'zod';
import type { Announcement, AnnouncementKind, AudienceType, AppRole } from '../../generated/prisma/client.js';
import { appendAudit } from '../../lib/audit.js';
import { renderEmail } from '../../lib/email-templates.js';
import { conflict, HttpError, notFound, unprocessable } from '../../lib/http-errors.js';
import { Prisma, type Db, type DbClient } from '../../lib/prisma.js';
import { HR_ROLES } from '../credentials/access.js';
import { checkPermission, unitScope, type AuthContext, type UnitScope } from '../users/access.js';

const DAY = 86_400_000;
const CHUNK = 500;
const RIYADH = 'Asia/Riyadh';
const SUPERVISOR_ROLES = ['SUPERVISOR'] as const;
const LIST_LIMIT = 200;

export const eventKeyOf = (id: number) => `announcement:${id}`;

// ── Request bodies ──────────────────────────────────────────────────────────

/** Optional text: trimmed, and an empty string clears the field. */
const optionalText = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().optional();
const Code = z.string().trim().min(1).max(20);

const Fields = {
  kind: z.enum(['MEMO', 'MEETING', 'SEMINAR']),
  title: z.string().trim().min(1, 'A title is required').max(150),
  body: z.string().trim().min(1, 'The text is required').max(5000),
  titleAr: optionalText(150),
  bodyAr: optionalText(5000),
  referenceNo: optionalText(50),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  location: optionalText(200),
  onlineUrl: z.string().trim().max(500).regex(/^https:\/\/\S+$/, 'The online link must start with https:// and contain no spaces').nullable().optional(),
  speaker: optionalText(150),
  ceHours: z.number().min(0).max(999.9).refine((v) => Number.isInteger(Math.round(v * 10 * 1e6) / 1e6), 'One decimal place at most').nullable().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  audienceType: z.enum(['HOSPITAL', 'DEPARTMENT', 'UNIT', 'PEOPLE']),
  audienceIds: z.array(z.number().int().positive()).max(500).optional(),
  roleFilter: z.array(z.enum(['SYSTEM_ADMIN', 'HR_ADMIN', 'SUPERVISOR'])).max(3).optional(),
  positionFilter: z.array(Code).max(100).optional(),
  specialtyFilter: z.array(Code).max(100).optional(),
  /** Omitted or null: 30 days for a memo, the day after the event otherwise (owner Q5). */
  expiresAt: z.coerce.date().nullable().optional(),
};
export const CreateBody = z.strictObject(Fields);
export const UpdateBody = z.strictObject(Fields).partial();
export const CancelBody = z.strictObject({ reason: z.string().trim().min(10, 'A cancellation needs a reason of at least 10 characters').max(1000) });
export const ReceivedQuery = z.object({
  state: z.enum(['active', 'archived']).default('active'),
  kind: z.enum(['MEMO', 'MEETING', 'SEMINAR']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const SentQuery = z.object({ status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'REJECTED', 'CANCELLED']).optional() });
export const PeopleQuery = z.object({ q: z.string().trim().min(2).max(100) });

/** Stored in approval_requests.payload (D-69). `unitIds` is what the approver's scope must cover. */
export interface AnnouncementApprovalPayload {
  kind: 'ANNOUNCEMENT';
  announcementId: number;
  announcementKind: AnnouncementKind;
  title: string;
  audienceType: AudienceType;
  audienceIds: number[];
  unitIds: number[] | 'ALL';
  recipients: number;
  emailOnly: number;
}
export const isAnnouncementPayload = (p: { kind: string }): p is AnnouncementApprovalPayload => p.kind === 'ANNOUNCEMENT';

// ── Shape rules (the database checks the same, as a backstop) ───────────────

type Shape = {
  kind: AnnouncementKind; title: string; body: string; titleAr: string | null; bodyAr: string | null; referenceNo: string | null;
  startsAt: Date | null; endsAt: Date | null; location: string | null; onlineUrl: string | null; speaker: string | null; ceHours: number | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH'; audienceType: AudienceType; audienceIds: number[];
  roleFilter: AppRole[]; positionFilter: string[]; specialtyFilter: string[]; expiresAt: Date;
};

const invalid = (message: string) => unprocessable('ANNOUNCEMENT_INVALID', message);

/** Owner Q5: a memo stays 30 days; a meeting or seminar until the day after it. */
export function defaultExpiry(kind: AnnouncementKind, startsAt: Date | null, endsAt: Date | null, now = new Date()) {
  const event = endsAt ?? startsAt;
  return kind === 'MEMO' || !event ? new Date(now.getTime() + 30 * DAY) : new Date(event.getTime() + DAY);
}

function checkShape(s: Shape) {
  if (s.kind === 'MEMO') {
    if (s.startsAt || s.endsAt || s.location || s.onlineUrl) throw invalid('A memo has no date, place or online link — choose Meeting or Seminar for an event');
  } else {
    if (!s.startsAt) throw invalid(`A ${s.kind === 'MEETING' ? 'meeting' : 'seminar'} needs a start date and time`);
    if (s.endsAt && s.endsAt <= s.startsAt) throw invalid('The end must be after the start');
  }
  if (s.kind !== 'SEMINAR' && (s.speaker || s.ceHours !== null)) throw invalid('Speaker and CE hours belong to seminars');
  if (s.priority === 'HIGH' && s.kind !== 'MEMO') throw invalid('Only a memo can be High priority (owner decision Q7)');
  if (s.audienceType === 'HOSPITAL' && s.audienceIds.length > 0) throw invalid('The whole hospital needs no departments, units or people');
  if (s.audienceType !== 'HOSPITAL' && s.audienceIds.length === 0) throw invalid('Choose at least one recipient department, unit or person');
  if (s.startsAt && s.expiresAt <= s.startsAt) throw invalid('The announcement must stay on the board until after the event starts');
}

function toShape(a: Announcement): Shape {
  return {
    kind: a.kind, title: a.title, body: a.body, titleAr: a.titleAr, bodyAr: a.bodyAr, referenceNo: a.referenceNo,
    startsAt: a.startsAt, endsAt: a.endsAt, location: a.location, onlineUrl: a.onlineUrl, speaker: a.speaker,
    ceHours: a.ceHours === null ? null : Number(a.ceHours), priority: a.priority as Shape['priority'], audienceType: a.audienceType,
    audienceIds: a.audienceIds, roleFilter: a.roleFilter, positionFilter: a.positionFilter, specialtyFilter: a.specialtyFilter, expiresAt: a.expiresAt,
  };
}

/** The response view: Decimal as a number, the sender's name, never the internals of other tables. */
function view(a: Announcement & { createdBy?: { displayName: string } }) {
  const { createdBy, ...rest } = a;
  return { ...rest, ceHours: a.ceHours === null ? null : Number(a.ceHours), createdByName: createdBy?.displayName ?? null };
}

// ── Message text (e-mail and in-app) ────────────────────────────────────────

const fmt = (locale: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: RIYADH, ...opts });
const FULL: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
const DATE_ONLY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'numeric', year: 'numeric' };
const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };
/** Gregorian dates and Latin digits in Arabic too: ar-SA defaults to the Hijri calendar. */
const AR = 'ar-SA-u-ca-gregory-nu-latn';

function when(s: Shape, locale: string) {
  if (!s.startsAt) return null;
  const start = fmt(locale, FULL).format(s.startsAt);
  if (!s.endsAt) return start;
  const sameDay = fmt('en-CA', DATE_ONLY).format(s.startsAt) === fmt('en-CA', DATE_ONLY).format(s.endsAt);
  return `${start} – ${fmt(locale, sameDay ? TIME : FULL).format(s.endsAt)}`;
}

/** The details block under the text. `inApp`: the reader can open the app (the online link is shown there). */
function details(s: Shape, lang: 'en' | 'ar', inApp: boolean) {
  const L = lang === 'en'
    ? { when: 'When', tz: '(Riyadh time)', where: 'Where', online: 'Online', inApp: 'the link is in the announcement in the app', speaker: 'Speaker', ce: 'CE hours', ref: 'Ref' }
    : { when: 'الموعد', tz: '(بتوقيت الرياض)', where: 'المكان', online: 'عبر الإنترنت', inApp: 'الرابط في الإعلان داخل التطبيق', speaker: 'المتحدث', ce: 'ساعات التعليم المستمر', ref: 'المرجع' };
  const w = when(s, lang === 'en' ? 'en-GB' : AR);
  return [
    w && `${L.when}: ${w} ${L.tz}`,
    s.location && `${L.where}: ${s.location}`,
    s.onlineUrl && `${L.online}: ${inApp ? L.inApp : s.onlineUrl}`,
    s.speaker && `${L.speaker}: ${s.speaker}`,
    s.ceHours !== null && `${L.ce}: ${s.ceHours}`,
    s.referenceNo && `${L.ref}: ${s.referenceNo}`,
  ].filter(Boolean).join('\n');
}

export function messages(s: Shape, inApp: boolean) {
  const join = (text: string, block: string) => (block ? `${text}\n\n${block}` : text);
  const hasAr = Boolean(s.titleAr || s.bodyAr);
  return {
    title: s.title,
    message: join(s.body, details(s, 'en', inApp)),
    titleAr: hasAr ? (s.titleAr ?? s.title) : null,
    messageAr: hasAr ? join(s.bodyAr ?? s.body, details(s, 'ar', inApp)) : null,
  };
}

// ── Scope and audience ──────────────────────────────────────────────────────

interface SenderScope { hr: UnitScope; sup: UnitScope }
const has = (s: UnitScope, unitId: number) => s.all || s.unitIds.has(unitId);
const isEmpty = (s: UnitScope) => !s.all && s.unitIds.size === 0;
const scopeError = () => new HttpError(403, 'SCOPE_NOT_COVERED', 'This audience is outside your assigned scope');

/** The units an audience reaches: ALL for the hospital, for PEOPLE whether anyone has no unit. */
type AudienceUnits = { all: true } | { all: false; units: number[]; unplaced: boolean };

async function audienceUnits(tx: DbClient, s: Pick<Shape, 'audienceType' | 'audienceIds'>): Promise<AudienceUnits> {
  if (s.audienceType === 'HOSPITAL') return { all: true };
  if (s.audienceType === 'UNIT') return { all: false, units: s.audienceIds, unplaced: false };
  if (s.audienceType === 'DEPARTMENT') {
    const units = await tx.unit.findMany({ where: { departmentId: { in: s.audienceIds } }, select: { id: true } });
    return { all: false, units: units.map((u) => u.id), unplaced: false };
  }
  const people = await tx.user.findMany({ where: { id: { in: s.audienceIds } }, select: { employee: { select: { unitId: true, deletedAt: true } } } });
  const units = people.map((p) => (p.employee && !p.employee.deletedAt ? p.employee.unitId : null));
  return { all: false, units: [...new Set(units.filter((u): u is number => u !== null))], unplaced: units.some((u) => u === null) };
}

/** What the approver's scope must cover: ALL when the hospital, an account with no unit, or no unit at all is involved. */
const approvalUnits = (u: AudienceUnits): number[] | 'ALL' => (u.all || u.unplaced || u.units.length === 0 ? 'ALL' : u.units);

/**
 * Owner Q1/Q2: may this sender address this audience, and does it need approval?
 * DIRECT only when acting as a Supervisor: a unit or people audience entirely inside
 * their SUPERVISOR scope. Department and hospital audiences need HR scope.
 */
function routeOf(s: Pick<Shape, 'audienceType'>, scope: SenderScope, u: AudienceUnits, breakGlass: boolean): 'DIRECT' | 'APPROVAL' {
  const needs = approvalUnits(u);
  if (needs === 'ALL') {
    if (!scope.hr.all) throw scopeError();
    return breakGlass ? 'DIRECT' : 'APPROVAL';
  }
  if (s.audienceType !== 'DEPARTMENT' && !isEmpty(scope.sup) && needs.every((id) => has(scope.sup, id))) return 'DIRECT';
  const covered = s.audienceType === 'DEPARTMENT' ? needs.every((id) => has(scope.hr, id)) : needs.every((id) => has(scope.hr, id) || has(scope.sup, id));
  if (!covered) throw scopeError();
  return breakGlass ? 'DIRECT' : 'APPROVAL';
}

const notExpired = (now: Date) => ({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

export interface Recipients { accounts: Array<{ id: number; email: string; telegramChatId: string | null }>; emails: string[] }

/** Who receives it right now: accounts (in-app, e-mail, Telegram) and contact addresses of staff without one (owner Q6). */
export async function resolveRecipients(tx: DbClient, s: Shape, now = new Date()): Promise<Recipients> {
  const u = await audienceUnits(tx, s);
  const units = u.all ? [] : u.units;
  const and: Prisma.UserWhereInput[] = [{ isActive: true, isBreakGlass: false }];
  if (s.audienceType === 'PEOPLE') and.push({ id: { in: s.audienceIds } });
  else if (!u.all) {
    const depts = s.audienceType === 'DEPARTMENT' ? s.audienceIds
      : (await tx.unit.findMany({ where: { id: { in: units } }, select: { departmentId: true } })).map((x) => x.departmentId);
    // Staff placed in those units, and the supervisors / HR whose grants cover them.
    and.push({ OR: [
      { employee: { unitId: { in: units }, deletedAt: null } },
      { roleAssignments: { some: { AND: [notExpired(now), { OR: [{ scopeType: 'UNIT', scopeIds: { hasSome: units } }, { scopeType: 'DEPARTMENT', scopeIds: { hasSome: depts } }] }] } } },
    ] });
  }
  if (s.roleFilter.length) and.push({ roleAssignments: { some: { ...notExpired(now), role: { in: s.roleFilter } } } });
  if (s.positionFilter.length) and.push({ employee: { positionCode: { in: s.positionFilter }, deletedAt: null } });
  if (s.specialtyFilter.length) and.push({ employee: { specialtyCode: { in: s.specialtyFilter }, deletedAt: null } });
  const accounts = await tx.user.findMany({ where: { AND: and }, select: { id: true, email: true, telegramChatId: true }, orderBy: { id: 'asc' } });

  // People picked by name are accounts; a role filter means people holding that role.
  let emails: string[] = [];
  if (s.audienceType !== 'PEOPLE' && s.roleFilter.length === 0) {
    const staff = await tx.employee.findMany({
      where: {
        deletedAt: null, status: 'Active', user: { is: null },
        ...(u.all ? {} : { unitId: { in: units } }),
        ...(s.positionFilter.length ? { positionCode: { in: s.positionFilter } } : {}),
        ...(s.specialtyFilter.length ? { specialtyCode: { in: s.specialtyFilter } } : {}),
      },
      select: { contactEmail: true },
    });
    const taken = new Set(accounts.map((a) => a.email.toLowerCase()));
    emails = [...new Set(staff.map((e) => e.contactEmail.trim().toLowerCase()).filter((e) => e.includes('@') && !taken.has(e)))].sort();
  }
  return { accounts, emails };
}

// ── The service ─────────────────────────────────────────────────────────────

export function createAnnouncementService(db: Db, opts: { emailHourlyLimit: number }) {
  async function senderScope(tx: DbClient, auth: AuthContext): Promise<SenderScope> {
    return { hr: await unitScope(tx, auth, HR_ROLES), sup: await unitScope(tx, auth, SUPERVISOR_ROLES) };
  }

  async function assertReferences(tx: DbClient, s: Shape) {
    const ids = [...new Set(s.audienceIds)];
    const found = s.audienceType === 'DEPARTMENT' ? await tx.department.count({ where: { id: { in: ids } } })
      : s.audienceType === 'UNIT' ? await tx.unit.count({ where: { id: { in: ids } } })
      : s.audienceType === 'PEOPLE' ? await tx.user.count({ where: { id: { in: ids }, isActive: true, isBreakGlass: false } })
      : 0;
    if (found !== ids.length) throw unprocessable('AUDIENCE_INVALID', `Some chosen ${s.audienceType.toLowerCase()} recipients do not exist or are inactive`);
    if (s.positionFilter.length && (await tx.position.count({ where: { code: { in: s.positionFilter } } })) !== new Set(s.positionFilter).size) throw unprocessable('AUDIENCE_INVALID', 'Unknown position in the filter');
    if (s.specialtyFilter.length && (await tx.nursingSpecialty.count({ where: { code: { in: s.specialtyFilter } } })) !== new Set(s.specialtyFilter).size) throw unprocessable('AUDIENCE_INVALID', 'Unknown specialty in the filter');
  }

  /** Checks a draft's shape, references and that the sender may address its audience; returns the route. */
  async function validate(tx: DbClient, auth: AuthContext, s: Shape) {
    checkShape(s);
    await assertReferences(tx, s);
    return routeOf(s, await senderScope(tx, auth), await audienceUnits(tx, s), auth.breakGlass !== null);
  }

  async function lock(tx: DbClient, id: number) {
    await tx.$queryRaw`SELECT id FROM announcements WHERE id = ${id} FOR UPDATE`;
    const a = await tx.announcement.findUnique({ where: { id } });
    if (!a) throw notFound('Announcement not found');
    return a;
  }

  async function lockOwnDraft(tx: DbClient, auth: AuthContext, id: number) {
    const a = await lock(tx, id);
    if (a.createdById !== auth.user.id) throw notFound('Announcement not found');
    if (a.status !== 'DRAFT') throw conflict('ANNOUNCEMENT_NOT_DRAFT', `This announcement is ${a.status.toLowerCase().replace('_', ' ')}; only a draft can be changed`);
    return a;
  }

  function assertSendable(s: Shape, now = new Date()) {
    if (s.expiresAt <= now) throw conflict('ANNOUNCEMENT_EXPIRED', 'Its board date has passed — set a later one');
    if (s.startsAt && s.startsAt <= now) throw conflict('EVENT_IN_PAST', 'The event has already started');
  }

  /** May this caller cancel or oversee it: the sender, or an announcement manager whose HR scope covers the audience. */
  async function manages(tx: DbClient, auth: AuthContext, a: Announcement) {
    if (a.createdById === auth.user.id) return true;
    if (checkPermission(auth, 'announcements.manage') !== 'ALLOWED') return false;
    const hr = await unitScope(tx, auth, HR_ROLES);
    const needs = approvalUnits(await audienceUnits(tx, a));
    return needs === 'ALL' ? hr.all : needs.every((id) => has(hr, id));
  }

  /** Fans the announcement out and marks it published. Caller holds the row lock. */
  async function publish(tx: DbClient, a: Announcement, actorUserId: number, requestId?: string) {
    const s = toShape(a);
    const r = await resolveRecipients(tx, s);
    if (r.accounts.length === 0 && r.emails.length === 0) throw unprocessable('NO_RECIPIENTS', 'Nobody is in this audience');
    const key = eventKeyOf(a.id);
    const inApp = messages(s, true);
    for (let i = 0; i < r.accounts.length; i += CHUNK) {
      await tx.notification.createMany({
        data: r.accounts.slice(i, i + CHUNK).map((acc) => ({ recipientId: acc.id, type: 'ANNOUNCEMENT' as const, priority: a.priority, ...inApp, eventKey: key, announcementId: a.id })),
        skipDuplicates: true,
      });
    }
    // Staff without an account: no link (they cannot sign in), the online link written out.
    const mail = renderEmail(messages(s, false));
    for (let i = 0; i < r.emails.length; i += CHUNK) {
      await tx.emailOutbox.createMany({
        data: r.emails.slice(i, i + CHUNK).map((toAddress) => ({ toAddress, subject: mail.subject, bodyText: mail.text, bodyHtml: mail.html, priority: a.priority, eventKey: key })),
        skipDuplicates: true,
      });
    }
    const published = await tx.announcement.update({
      where: { id: a.id },
      data: { status: 'PUBLISHED', publishedAt: new Date(), recipientCount: r.accounts.length, emailOnlyCount: r.emails.length },
    });
    await appendAudit(tx, {
      actorUserId, action: 'ANNOUNCEMENT_PUBLISHED', resource: 'announcement', resourceId: a.id, requestId,
      changes: { kind: a.kind, audienceType: a.audienceType, audienceIds: a.audienceIds, recipients: r.accounts.length, emailOnly: r.emails.length },
      priority: a.audienceType === 'HOSPITAL' ? 'HIGH' : 'NORMAL',
    });
    return published;
  }

  return {
    /** Announcements addressed to me: published, active or archived by their board date. */
    async received(auth: AuthContext, q: z.infer<typeof ReceivedQuery>) {
      const now = new Date();
      const where: Prisma.AnnouncementWhereInput = {
        status: 'PUBLISHED', notifications: { some: { recipientId: auth.user.id } },
        expiresAt: q.state === 'active' ? { gt: now } : { lte: now }, ...(q.kind ? { kind: q.kind } : {}),
      };
      const [rows, total] = await Promise.all([
        db.announcement.findMany({ where, include: { createdBy: { select: { displayName: true } } }, orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
        db.announcement.count({ where }),
      ]);
      return { items: rows.map(view), total, page: q.page, pageSize: q.pageSize };
    },

    /** My own announcements, every status. */
    async sent(auth: AuthContext, q: z.infer<typeof SentQuery>) {
      const rows = await db.announcement.findMany({
        where: { createdById: auth.user.id, ...(q.status ? { status: q.status } : {}) },
        include: { createdBy: { select: { displayName: true } } }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: LIST_LIMIT,
      });
      return { items: rows.map(view), total: rows.length };
    },

    /** Announcement managers: every sent announcement whose audience their HR scope covers (newest LIST_LIMIT). */
    async managed(auth: AuthContext) {
      const rows = await db.announcement.findMany({
        where: { status: { not: 'DRAFT' } }, include: { createdBy: { select: { displayName: true } } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: LIST_LIMIT * 2,
      });
      const items = [];
      for (const a of rows) if (items.length < LIST_LIMIT && (await manages(db, auth, a))) items.push(view(a));
      return { items, total: items.length };
    },

    async get(auth: AuthContext, id: number) {
      const a = await db.announcement.findUnique({ where: { id }, include: { createdBy: { select: { displayName: true } } } });
      if (!a) throw notFound('Announcement not found');
      const own = a.createdById === auth.user.id;
      const received = !own && ['PUBLISHED', 'CANCELLED'].includes(a.status)
        && (await db.notification.count({ where: { announcementId: id, recipientId: auth.user.id } })) > 0;
      const managed = !own && !received && a.status !== 'DRAFT' && (await manages(db, auth, a));
      if (!own && !received && !managed) throw notFound('Announcement not found'); // never reveal it exists
      return { ...view(a), canCancel: a.status === 'PUBLISHED' && (own || managed || (await manages(db, auth, a))) };
    },

    async create(auth: AuthContext, body: z.infer<typeof CreateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const startsAt = body.startsAt ?? null;
        const endsAt = body.endsAt ?? null;
        const s: Shape = {
          kind: body.kind, title: body.title, body: body.body, titleAr: body.titleAr ?? null, bodyAr: body.bodyAr ?? null, referenceNo: body.referenceNo ?? null,
          startsAt, endsAt, location: body.location ?? null, onlineUrl: body.onlineUrl ?? null, speaker: body.speaker ?? null, ceHours: body.ceHours ?? null,
          priority: body.priority ?? (body.kind === 'MEETING' ? 'MEDIUM' : 'LOW'), audienceType: body.audienceType, audienceIds: [...new Set(body.audienceIds ?? [])],
          roleFilter: body.roleFilter ?? [], positionFilter: body.positionFilter ?? [], specialtyFilter: body.specialtyFilter ?? [],
          expiresAt: body.expiresAt ?? defaultExpiry(body.kind, startsAt, endsAt),
        };
        const route = await validate(tx, auth, s);
        const a = await tx.announcement.create({ data: { ...s, createdById: auth.user.id } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'ANNOUNCEMENT_CREATED', resource: 'announcement', resourceId: a.id, requestId, changes: { kind: a.kind, audienceType: a.audienceType, audienceIds: a.audienceIds } });
        return { ...view(a), needsApproval: route === 'APPROVAL' };
      });
    },

    /** Drafts only. A change of kind or event time without a board date recalculates the default one. */
    async update(auth: AuthContext, id: number, body: z.infer<typeof UpdateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const before = await lockOwnDraft(tx, auth, id);
        const prev = toShape(before);
        const pick = <K extends keyof Shape>(k: K): Shape[K] => (body[k as keyof typeof body] === undefined ? prev[k] : (body[k as keyof typeof body] ?? null) as Shape[K]);
        const s: Shape = {
          kind: pick('kind'), title: pick('title'), body: pick('body'), titleAr: pick('titleAr'), bodyAr: pick('bodyAr'), referenceNo: pick('referenceNo'),
          startsAt: pick('startsAt'), endsAt: pick('endsAt'), location: pick('location'), onlineUrl: pick('onlineUrl'), speaker: pick('speaker'), ceHours: pick('ceHours'),
          priority: body.priority ?? prev.priority, audienceType: pick('audienceType'), audienceIds: body.audienceIds ? [...new Set(body.audienceIds)] : prev.audienceIds,
          roleFilter: body.roleFilter ?? prev.roleFilter, positionFilter: body.positionFilter ?? prev.positionFilter, specialtyFilter: body.specialtyFilter ?? prev.specialtyFilter,
          expiresAt: prev.expiresAt,
        };
        const timing = body.kind !== undefined || body.startsAt !== undefined || body.endsAt !== undefined;
        s.expiresAt = body.expiresAt ?? (body.expiresAt === null || timing ? defaultExpiry(s.kind, s.startsAt, s.endsAt) : prev.expiresAt);
        const route = await validate(tx, auth, s);
        const a = await tx.announcement.update({ where: { id }, data: s });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'ANNOUNCEMENT_UPDATED', resource: 'announcement', resourceId: id, requestId, changes: { fields: Object.keys(body) } });
        return { ...view(a), needsApproval: route === 'APPROVAL' };
      });
    },

    async remove(auth: AuthContext, id: number, requestId?: string) {
      return db.$transaction(async (tx) => {
        const a = await lockOwnDraft(tx, auth, id);
        await tx.announcement.delete({ where: { id } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'ANNOUNCEMENT_DRAFT_DELETED', resource: 'announcement', resourceId: id, requestId, changes: { kind: a.kind } });
        return { id, deleted: true };
      });
    },

    /** Who it would reach now, whether it needs approval, and roughly when the last e-mail goes out. */
    async preview(auth: AuthContext, id: number) {
      const a = await db.announcement.findUnique({ where: { id } });
      if (!a || a.createdById !== auth.user.id) throw notFound('Announcement not found');
      const s = toShape(a);
      const route = routeOf(s, await senderScope(db, auth), await audienceUnits(db, s), auth.breakGlass !== null);
      const r = await resolveRecipients(db, s);
      const [queuedN, queuedO] = await Promise.all([
        db.notification.count({ where: { emailStatus: 'PENDING' } }),
        db.emailOutbox.count({ where: { status: 'PENDING' } }),
      ]);
      const perHour = opts.emailHourlyLimit > 0 ? opts.emailHourlyLimit : 6000; // no limit: 100 a minute
      const mails = r.accounts.length + r.emails.length;
      return {
        recipients: r.accounts.length, telegramLinked: r.accounts.filter((x) => x.telegramChatId).length, emailOnly: r.emails.length,
        needsApproval: route === 'APPROVAL', emailsQueued: queuedN + queuedO,
        emailEtaMinutes: mails === 0 ? 0 : Math.ceil(((queuedN + queuedO + mails) / perHour) * 60),
        emailHourlyLimit: opts.emailHourlyLimit,
      };
    },

    /** Publishes at once (Supervisor to own units, break-glass) or opens a four-eyes request. Identifiers only (idempotent route). */
    async submit(auth: AuthContext, id: number, requestId?: string, transaction?: Transaction) {
      return inTransaction(db, transaction, async (tx) => {
        const a = await lockOwnDraft(tx, auth, id);
        const s = toShape(a);
        assertSendable(s);
        const units = await audienceUnits(tx, s);
        const route = await validate(tx, auth, s);
        if (route === 'DIRECT') {
          await publish(tx, a, auth.user.id, requestId);
          return { id, status: 'PUBLISHED' as const };
        }
        const r = await resolveRecipients(tx, s);
        if (r.accounts.length === 0 && r.emails.length === 0) throw unprocessable('NO_RECIPIENTS', 'Nobody is in this audience');
        const payload: AnnouncementApprovalPayload = {
          kind: 'ANNOUNCEMENT', announcementId: id, announcementKind: a.kind, title: a.title, audienceType: a.audienceType,
          audienceIds: a.audienceIds, unitIds: approvalUnits(units), recipients: r.accounts.length, emailOnly: r.emails.length,
        };
        // One action type per announcement: approval_requests allows one PENDING request per initiator and action type.
        const actionType = `ANNOUNCEMENT_PUBLISH:${id}`;
        const req = await tx.approvalRequest.create({ data: { initiatorId: auth.user.id, actionType, payload: payload as unknown as Prisma.InputJsonObject } });
        await tx.announcement.update({ where: { id }, data: { status: 'PENDING_APPROVAL' } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'APPROVAL_INITIATED', resource: 'approval_request', resourceId: req.id, changes: { actionType, payload }, requestId, priority: 'HIGH' });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'ANNOUNCEMENT_SUBMITTED', resource: 'announcement', resourceId: id, requestId, changes: { approvalRequestId: req.id } });
        return { id, status: 'PENDING_APPROVAL' as const, approvalRequestId: req.id };
      }, { timeout: 120_000 }); // a hospital-wide fan-out writes a row per account
    },

    /** Stops what has not been delivered; the board hides it; recipients who open it see it was cancelled. */
    async cancel(auth: AuthContext, id: number, reason: string, requestId?: string) {
      return db.$transaction(async (tx) => {
        const a = await lock(tx, id);
        if (!(await manages(tx, auth, a))) throw notFound('Announcement not found');
        if (a.status !== 'PUBLISHED') throw conflict('ANNOUNCEMENT_NOT_PUBLISHED', 'Only a published announcement can be cancelled; withdraw a pending one in Approvals');
        await tx.announcement.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: auth.user.id, cancelReason: reason } });
        const email = await tx.notification.updateMany({ where: { announcementId: id, emailStatus: 'PENDING' }, data: { emailStatus: 'SKIPPED' } });
        const telegram = await tx.notification.updateMany({ where: { announcementId: id, telegramStatus: 'PENDING' }, data: { telegramStatus: 'SKIPPED' } });
        const outbox = await tx.emailOutbox.updateMany({ where: { eventKey: eventKeyOf(id), status: 'PENDING' }, data: { status: 'SKIPPED' } });
        await appendAudit(tx, {
          actorUserId: auth.user.id, action: 'ANNOUNCEMENT_CANCELLED', resource: 'announcement', resourceId: id, requestId, priority: 'HIGH',
          changes: { reason, emailsStopped: email.count + outbox.count, telegramStopped: telegram.count },
        });
        return { id, status: 'CANCELLED' as const, emailsStopped: email.count + outbox.count, telegramStopped: telegram.count };
      });
    },

    /** Accounts a sender may pick by name: within their HR or Supervisor scope. */
    async people(auth: AuthContext, q: z.infer<typeof PeopleQuery>) {
      const scope = await senderScope(db, auth);
      const everyone = scope.hr.all || scope.sup.all;
      const units = everyone ? [] : [...new Set([...(scope.hr.all ? [] : scope.hr.unitIds), ...(scope.sup.all ? [] : scope.sup.unitIds)])];
      const rows = await db.user.findMany({
        where: {
          isActive: true, isBreakGlass: false,
          OR: [{ displayName: { contains: q.q, mode: 'insensitive' } }, { employee: { fullName: { contains: q.q, mode: 'insensitive' } } }, { employee: { jobNumber: { contains: q.q, mode: 'insensitive' } } }],
          ...(everyone ? {} : { employee: { unitId: { in: units }, deletedAt: null } }),
        },
        select: { id: true, displayName: true, employee: { select: { jobNumber: true, unit: { select: { name: true } } } } },
        orderBy: { displayName: 'asc' }, take: 20,
      });
      return { items: rows.map((u) => ({ id: u.id, displayName: u.displayName, jobNumber: u.employee?.jobNumber ?? null, unitName: u.employee?.unit?.name ?? null })) };
    },

    // ── Called by the Approvals queue (approvals.ts), inside its transaction ──

    /** The approver's scope was checked against payload.unitIds; recipients are resolved afresh now. */
    async executeApproved(tx: DbClient, approver: AuthContext, payload: AnnouncementApprovalPayload, _approvalRequestId: number, requestId?: string) {
      const a = await lock(tx, payload.announcementId);
      if (a.status !== 'PENDING_APPROVAL') throw conflict('ANNOUNCEMENT_NOT_PENDING', `This announcement is ${a.status.toLowerCase()}`);
      assertSendable(toShape(a));
      await publish(tx, a, approver.user.id, requestId);
      return a.id;
    },

    async onRejected(tx: DbClient, payload: AnnouncementApprovalPayload, actorUserId: number, requestId?: string) {
      const done = await tx.announcement.updateMany({ where: { id: payload.announcementId, status: 'PENDING_APPROVAL' }, data: { status: 'REJECTED' } });
      if (done.count) await appendAudit(tx, { actorUserId, action: 'ANNOUNCEMENT_REJECTED', resource: 'announcement', resourceId: payload.announcementId, requestId });
    },

    /** The sender took the request back: the announcement is a draft again. */
    async onWithdrawn(tx: DbClient, payload: AnnouncementApprovalPayload, actorUserId: number, requestId?: string) {
      const done = await tx.announcement.updateMany({ where: { id: payload.announcementId, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (done.count) await appendAudit(tx, { actorUserId, action: 'ANNOUNCEMENT_WITHDRAWN', resource: 'announcement', resourceId: payload.announcementId, requestId });
    },
  };
}
export type AnnouncementService = ReturnType<typeof createAnnouncementService>;
