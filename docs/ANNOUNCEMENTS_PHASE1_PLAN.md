# Announcements — Phase 1 plan

**Status:** APPROVED by the owner 2026-10-05 (decisions in §2). Build in progress on branch `claude/announcements-phase1`.
**Proposed decision number:** D-69 (next after D-68 in `V04_ARCHITECTURE_PLAN.md`).
**Base:** `main` = `9d99e5b`, latest migration `20261025100000_position_titles_arabic`.

---

## 1. Goal

Nursing Administration and supervisors can send **Memos**, **Meeting schedules** and **Seminar announcements** to staff from inside the app. Each announcement reaches recipients:

| Channel | Content | Built on |
|---|---|---|
| In-app (bell + new **Announcements** board) | Full text, the permanent record | `notifications` table + new `announcements` table |
| E-mail | Full text (English + Arabic). Staff **without an account** get it here only, at their `contact_email` (Q6) | Existing e-mail dispatcher (`backend/src/jobs/email-dispatch.ts`, `lib/email-templates.ts`); `email_outbox` for no-account staff |
| Telegram | Generic prompt only, no content (D-66) | Existing Telegram dispatcher (`backend/src/jobs/telegram-dispatch.ts`), **no change** |

### In Phase 1
- Compose, preview, send for the three types.
- Audience picker with a live recipient count.
- Four-eyes approval for every send by an HR Admin or System Admin; Supervisor sends to their own units go out at once.
- Announcements board (active / archived), detail page, cancel.
- E-mail hourly cap so a large send can't break UltaMail's limit (§6.3).

### Not in Phase 1 (Phase 2/3)
Scheduled publish time, reminders before meetings/seminars, `.ics` calendar invites, cancellation notices, read-acknowledgement report, RSVP / seats, PDF attachments.

---

## 2. Owner decisions (2026-10-05)

| # | Question | Owner decision |
|---|---|---|
| Q1 | Who may **send**? | HR Admin (within scope); Supervisor (only their own units); System Admin only while elevated (PAM) |
| Q2 | Which sends need a **second person's approval**? | **Every send by an HR Admin or System Admin**, whatever the audience (approver = another HR/System Admin covering the audience). Supervisor → own unit(s): no approval, published at once |
| Q3 | May Telegram carry the **title** of an announcement? | **No.** Same generic message as today. Changing this would be a written policy decision under D-66 |
| Q4 | Can a published announcement be **edited**? | No. Cancel and send a new one |
| Q5 | How long does an announcement stay on the board? | Until its expiry date (sender sets; default 30 days; meetings/seminars default to the day after the event), then **Archived**, still readable. Never deleted in Phase 1 |
| Q6 | Staff with **no account** (employee record but not invited)? | **Not in the app, but they receive it by e-mail** at their employee `contact_email` (§6.2a) |
| Q7 | Default **priority** | LOW for memos and seminars, MEDIUM for meetings. Sender may raise a memo to HIGH; CRITICAL is not offered (reserved for system alerts) |
| Q8 | Content limits | Title ≤ 150 characters, body ≤ 5,000 characters, Arabic optional but recommended |

---

## 3. Decision D-69 (for `V04_ARCHITECTURE_PLAN.md`)

> **D-69 (2026-10-05) — Announcements: memos, meeting schedules and seminar notices** (owner request and decisions 2026-10-05). An announcement is written once (`announcements`) and fanned out to one `notifications` row per recipient account (type `ANNOUNCEMENT`, `eventKey = announcement:<id>`, rule N2/N3), so in-app, e-mail and Telegram delivery reuse the existing outbox, retries and health checks. Staff in the audience without an account get the e-mail only, at their employee contact address, through `email_outbox` (same event key; no link, as they cannot sign in). E-mail carries the full text; Telegram stays content-free (D-66). Every send by an HR Admin or System Admin needs four-eyes approval through the shared Approvals queue; a Supervisor sends to their own units without approval. Published announcements are not edited; they are cancelled. E-mail delivery respects `EMAIL_HOURLY_LIMIT` (UltaMail: 200/hour per domain), security and operational mail first.

---

## 4. Data model (one migration: `20261026090000_announcements`)

```prisma
enum AnnouncementKind   { MEMO  MEETING  SEMINAR }
enum AnnouncementStatus { DRAFT  PENDING_APPROVAL  PUBLISHED  CANCELLED  REJECTED }
enum AudienceType       { HOSPITAL  DEPARTMENT  UNIT  PEOPLE }

/// D-69: one row per announcement; recipients are notifications rows (type ANNOUNCEMENT).
model Announcement {
  id            Int                  @id @default(autoincrement())
  kind          AnnouncementKind
  status        AnnouncementStatus   @default(DRAFT)
  priority      NotificationPriority @default(LOW)
  title         String               // ≤150 (Q8)
  body          String               // ≤5000
  titleAr       String?              @map("title_ar")
  bodyAr        String?              @map("body_ar")
  referenceNo   String?              @map("reference_no")   // MEMO
  startsAt      DateTime?            @map("starts_at") @db.Timestamptz   // MEETING / SEMINAR
  endsAt        DateTime?            @map("ends_at")   @db.Timestamptz
  location      String?                                  // room / hall
  onlineUrl     String?              @map("online_url")  // https only
  speaker       String?                                  // SEMINAR
  ceHours       Decimal?             @map("ce_hours") @db.Decimal(4, 1)  // SEMINAR, info only
  audienceType  AudienceType         @map("audience_type")
  audienceIds   Int[]                @map("audience_ids")    // department / unit / user ids
  /// Optional narrowing, applied on top of audienceType (empty = no filter).
  roleFilter      AppRole[]          @map("role_filter")
  positionFilter  Int[]              @map("position_filter")
  specialtyFilter String[]           @map("specialty_filter")
  recipientCount  Int?               @map("recipient_count")  // frozen at publish
  expiresAt     DateTime             @map("expires_at") @db.Timestamptz
  createdById   Int                  @map("created_by_id")
  publishedAt   DateTime?            @map("published_at") @db.Timestamptz
  cancelledAt   DateTime?            @map("cancelled_at") @db.Timestamptz
  cancelReason  String?              @map("cancel_reason")
  createdAt     DateTime             @default(now()) @map("created_at") @db.Timestamptz
  updatedAt     DateTime             @updatedAt @map("updated_at") @db.Timestamptz

  createdBy     User                 @relation(fields: [createdById], references: [id])
  notifications Notification[]

  @@index([status, expiresAt])
  @@map("announcements")
}
```

Changes to existing tables:

- `enum NotificationType`: add `ANNOUNCEMENT`.
- `model Notification`: add `announcementId Int? @map("announcement_id")` + relation + `@@index([announcementId])`. Lets the board show "read by 312 of 412" later (Phase 3) and lets a cancel find its rows.
- Database checks (SQL in the migration): `MEETING`/`SEMINAR` require `starts_at`; `ends_at > starts_at`; `online_url LIKE 'https://%'`; title/body lengths.

---

## 5. Audience resolution

Recipients are **active user accounts** (`users.is_active`), resolved at publish time and frozen as notification rows:

| Audience | Who |
|---|---|
| HOSPITAL | Every active account |
| DEPARTMENT | Accounts whose employee record is in a unit of the selected departments, **plus** accounts holding a role grant scoped to those departments/units (so supervisors and HR of that area get it) |
| UNIT | Same, for the selected units |
| PEOPLE | The selected accounts |

Then the optional filters (role, position, specialty) narrow it. The break-glass account is never a recipient.

**Staff without an account (Q6):** the same audience rules are applied to employee records (not deleted, status Active) that have **no linked account**. They become e-mail-only recipients at `employees.contact_email` (§6.2a). The role filter does not apply to them (they hold no role); position and specialty filters do. An employee who has an account is reached through the account only, never twice.

- **Scope rule:** a Supervisor may pick only units inside their own grants (`unitScope()` in `modules/users/access.ts`), and PEOPLE only from those units; the server checks again with `scopeCovers()`. A scoped HR Admin is limited the same way; HOSPITAL needs system-wide scope.
- **Preview endpoint** returns: account recipients, how many have Telegram linked, e-mail-only recipients (no account), and the estimated e-mail delivery time under the hourly cap.

---

## 6. Delivery

### 6.1 In-app
Fan-out inserts one `notifications` row per recipient (`createMany`, chunks of 500, `skipDuplicates` on `(recipientId, eventKey)`, so a retried publish never doubles). The `message` holds a short summary; the board/detail page reads the full `announcements` row.

### 6.2 E-mail (full content)
`renderEmail()` is reused. The notification's `message` is built as the body plus a details block, for example:

```
When: Sunday 12 October 2026, 10:00–11:00 (Riyadh time)
Where: Nursing Conference Hall B
Online: see the announcement in the app
Ref: NA-MEMO-2026-041
```

Only `link` becomes clickable in our template (by design), so the e-mail's button opens `/announcements/<id>` in the app, where the online meeting link is shown. All times shown in **Asia/Riyadh**.

### 6.2a E-mail to staff without an account (Q6)
One `email_outbox` row per address, rendered at publish time with the same `renderEmail()` but **without a link** (they cannot sign in), `eventKey = announcement:<id>`. The table's unique `(to_address, event_key)` stops two records with the same address getting it twice. For meetings, the online link is written in the e-mail text, since there is no app page they can open. The dispatcher already sends outbox rows, with the same retries. Contact addresses may be personal mailboxes; the e-mail goes through the same UltaMail relay already accepted by the DPO.

### 6.3 E-mail hourly cap (needed before a hospital-wide send)
UltaMail allows **200 e-mails per hour per domain**. Today the dispatcher sends up to 100 per minute and retries 8 × 60 s, so a 400-person announcement would hit the limit and the rest would end **FAILED** after about 8 minutes.

Change in `jobs/email-dispatch.ts`:
- New setting `EMAIL_HOURLY_LIMIT` (default `0` = no limit; live: `150`, leaving room for sign-in, MFA and break-glass mail).
- Each run counts e-mails sent in the last 60 minutes (notifications + outbox) and takes only the remaining allowance.
- Ordering: non-announcement outbox (break-glass) first, then non-announcement notifications by priority, then announcement mail (notifications and outbox rows with an `announcement:` event key). A security e-mail is never stuck behind a memo.
- Rows held back by the cap stay `PENDING` **without** using up an attempt.
- Business health already raises `EMAIL_BACKLOG` for mail pending more than 15 minutes (`modules/audit/business-health.ts`). A capped announcement is expected to wait longer, so step 3 leaves announcement mail out of that check and adds `ANNOUNCEMENT_EMAIL_BACKLOG` for announcement mail pending more than 6 h.
- **Done in step 1** (`EMAIL_HOURLY_LIMIT`, outbox first, notifications by priority). Ordering announcement mail last comes in step 3, once the `ANNOUNCEMENT` type exists.

### 6.4 Telegram (unchanged)
The existing dispatcher already sends one message per person per minute, however many notifications are waiting. Announcements default to LOW/MEDIUM, so the message is not marked "(urgent)". No content leaves the Kingdom (Q3).

---

## 7. Approval (four-eyes)

- **When (Q2):** the announcement is published at once only when the sender is acting as a **Supervisor**: the audience is UNIT (or PEOPLE) and every unit is covered by the sender's own SUPERVISOR grants. Every other send (any HR Admin or System Admin send, any department or hospital audience) needs approval. Someone who holds both roles and sends to a unit they supervise is acting as its supervisor.
- Sender submits → status `PENDING_APPROVAL` → an `approval_requests` row with action type `ANNOUNCEMENT_PUBLISH`, payload `{ kind: 'ANNOUNCEMENT', announcementId }`.
- Appears in **Nursing Administration → Approvals** with a read-only preview and the recipient count.
- Approve: the service locks the request (existing `FOR UPDATE` logic in `modules/administration/approvals.ts`), checks the approver ≠ sender and covers the audience scope, then **publishes in the same transaction** (status, fan-out, audit). If fan-out fails, everything rolls back and the request stays pending (rule R12).
- Reject: status `REJECTED`, reason shown to the sender, who can copy it into a new draft.
- **Watch-out:** `approval_requests` has a partial unique index on `(initiator_id, action_type) WHERE status = 'PENDING'`, which means one pending request per sender per action type. HR may well want several memos waiting at once. Plan: action type `ANNOUNCEMENT_PUBLISH:<id>`, keeping the "one pending request per item" meaning. `canDecide()` gets a branch for this payload (scope = audience units, or `scope.all` for HOSPITAL).

---

## 8. Permissions (`modules/users/permissions.ts`)

```ts
// D-69: announcements. Everyone reads those addressed to them; senders are scoped in the service.
'announcements.read':  ['EMPLOYEE'],
'announcements.write': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'],  // draft, preview, submit, cancel own
'announcements.manage': ['HR_ADMIN', 'SYSTEM_ADMIN'],               // see all, cancel any within scope
```

Approval uses the existing `approvals.decide`. System Admin writes need elevation (existing PAM check). `docs/RBAC.md` and the `ACCESS_MATRIX` gain an "Announcements" row.

---

## 9. API (`backend/src/modules/announcements/`)

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /announcements?state=active\|archived` | read | Board: announcements addressed to me (via my notification rows); senders/managers also see their own drafts and pending |
| `GET /announcements/:id` | read | Detail (404 if not addressed to me and not mine/in scope) |
| `POST /announcements` | write | Create draft |
| `PATCH /announcements/:id` | write | Edit draft only (409 otherwise) |
| `POST /announcements/:id/preview` | write | Account recipients, Telegram-linked, e-mail-only (no account), e-mail ETA |
| `POST /announcements/:id/submit` | write | Supervisor send to own units → publish now; every HR/System Admin send → approval request (§7) |
| `POST /announcements/:id/cancel` | write/manage | `{reason ≥ 10}`; status CANCELLED, hidden from the board; pending notification e-mail/Telegram and pending outbox rows (same event key) set to SKIPPED |
| `DELETE /announcements/:id` | write | Drafts only |

All bodies validated with zod `strictObject`; idempotency key on submit (as the other forms use).

---

## 10. Screens (`frontend/src/modules/announcements/`)

- **Sidebar → Announcements** (everyone), registered in `frontend/src/app/modules.tsx` / `layouts/AppLayout.tsx`.
- **Board:** cards with type badge (Memo / Meeting / Seminar), title, date or event time, sender; tabs Active / Archived; filter by type.
- **Detail:** full text EN/AR toggle, meeting details block, online link button, Cancelled banner if cancelled.
- **Compose** (senders only): type picker → fields for that type → audience picker (hospital / departments / units / people + filters) → **Preview** panel with counts and the e-mail ETA → Submit (button text says "Send" or "Send for approval").
- **Approvals tab:** new row kind with a preview of the announcement.
- **Notifications page:** an `ANNOUNCEMENT` notification opens the announcement detail.
- New strings in **both** `lib/i18n.en.ts` and `lib/i18n.ar.ts`; Arabic by me, to be checked by the owner/HR.

---

## 11. Audit (`appendAudit`)

`ANNOUNCEMENT_CREATED`, `ANNOUNCEMENT_SUBMITTED`, `ANNOUNCEMENT_PUBLISHED` (with recipient count, HIGH for HOSPITAL), `ANNOUNCEMENT_REJECTED`, `ANNOUNCEMENT_CANCELLED` (reason). No message body in the audit details (it can be long and may be personal); the id points to the row.

---

## 12. Tests

Backend (`backend/test/announcements.test.ts`, plus updates):
- Supervisor can send to own unit (published at once); refused for another unit (403 `SCOPE_NOT_COVERED`) and for HOSPITAL.
- HR send to a **single unit** → pending (Q2); HR hospital-wide → pending; same person cannot approve; another HR approves → N notification rows, e-mail/Telegram PENDING.
- Employee without an account in the audience → one outbox e-mail to `contact_email`, no link; employee with an account → notification only, no outbox row; two records sharing an address → one e-mail.
- Re-running publish creates no duplicates (`eventKey`).
- Draft edit allowed; edit after publish → 409.
- Cancel → board hides it; pending e-mail, Telegram and outbox rows become SKIPPED; already-sent rows untouched.
- Recipient sees it; non-recipient gets 404.
- Break-glass and inactive accounts never receive.
- Two pending announcements by the same sender are allowed (index watch-out, §7).
- E-mail cap: with `EMAIL_HOURLY_LIMIT=5` and 12 pending, 5 sent, 7 stay PENDING with **0** attempts used; security notification goes before announcements.
- Telegram text for an announcement contains no title/body.
- Route matrix (`test/route-matrix.test.ts`) and job list tests updated.

Frontend: compose form validation (type-specific required fields), board renders EN/AR.

---

## 13. Documentation to update

`docs/V04_ARCHITECTURE_PLAN.md` (D-69), `docs/API.md`, `docs/RBAC.md`, `docs/USER_MANUAL.md` (new section "Announcements" + note in §Notifications), in-app Guidelines (`frontend/src/modules/guidelines/content/sections/`), `docs/GUIDELINES_COVERAGE.md`, `.env.example` (`EMAIL_HOURLY_LIMIT`), `docs/DEPLOYMENT.md` (set `EMAIL_HOURLY_LIMIT=150` in `/etc/nurseapp/app.env`), `CHANGELOG.md` [Unreleased].

---

## 14. Build order (small, buildable commits on branch `claude/announcements-phase1`)

1. **E-mail hourly cap + priority ordering** (§6.3). Useful on its own and safe to ship first.
2. **Migration + model + permissions** (§4, §8), no routes yet.
3. **Service + routes**: drafts, preview, audience resolution, supervisor direct publish, cancel (§5, §9).
4. **Approval integration** (§7).
5. **Frontend**: board, detail, compose, approvals row, notification link, i18n EN/AR (§10).
6. **Docs + manual + guidelines** (§13).

Then: full backend + frontend suites, local run on a throw-away DB copy, PR for the owner to merge, deploy approval, set `EMAIL_HOURLY_LIMIT=150` on the VPS (owner runs `deploy.sh restart`), verify on live with one test announcement to the owner's own account (marked TEST, then cancelled).

---

## 15. Risks and notes

| Risk | Mitigation |
|---|---|
| Large send exceeds UltaMail 200/hour → permanent FAILED | §6.3 cap ships first; compose screen shows the ETA |
| Memo contains personal or patient data | Compose shows a reminder ("no patient data; staff names only when necessary"); e-mail already goes to an EU mailbox accepted by the DPO; Telegram carries nothing |
| Staff without accounts miss announcements | They get the e-mail at their contact address (Q6); preview shows how many. A wrong contact address means a missed e-mail — HR keeps addresses current |
| E-mail-only recipients add to the hourly volume | Counted in the cap and in the compose ETA |
| Approval index allows one pending per action type | Per-item action type (§7) |
| Telegram rate limits on a large send | Existing dispatcher already batches per person and per minute; monitor the first hospital-wide send |
| Arabic wording | Drafted by me; owner/HR to check before go-live |
