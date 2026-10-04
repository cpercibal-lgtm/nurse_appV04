# Credentials and clinical eligibility

Whether a nurse may work on a given day, and the credential records that decide it. Sources: reference spec §5 (credentials), §6.1 (engine), §6.1.1 (grace), §6.1.1.1 (policy transitions), §6.1.2 (waivers), §7.1 (reminders); rules L1–L10 and D1–D5 in the [rule register](FEATURE_MASTER_INVENTORY.md#15-business-rule-register); amendments in [SYSTEM_SPECIFICATION.md](SYSTEM_SPECIFICATION.md).

**This system does not define clinical policy.** Which credentials a unit requires, grace lengths and transition deadlines are configuration that hospital HR enters and owns. The seeded catalog is a starting list, not a policy.

## 1. Catalog and requirements

| Concept | Meaning | Who changes it |
| :--- | :--- | :--- |
| Category | Grouping of credential types (licence, life support, training, …) | System-wide HR / System Admin, **with a second system-wide approver** (D-42 / P8); initially from the baseline import |
| **Credential type** (template) | Name, code, whether it expires, tracked fields (e.g. licence number; one database row per field in `credential_template_fields`), grace days (0–90), and who it applies to: every nationality, only listed nationalities, or every nationality except listed ones (owner decision 2026-10-04) | System-wide HR / System Admin, **with a second system-wide approver** (D-24, D-25). The request needs a reason (≥ 10 characters) and shows before → after; it is refused if the type changed after the request. Break-glass applies at once |
| **Requirement** | "Unit U requires type T" — for every position (`position = null`) or one position; status `MANDATORY`, `TRANSITION` (with a deadline) or `OPTIONAL` | HR / System Admin with the unit in scope; applies immediately and re-evaluates every affected nurse in the same transaction |

A position-specific requirement overrides the unit-wide one for the same type (§5.1.4). `OPTIONAL` requirements never affect eligibility.

**By nationality (owner decision 2026-10-04).** For a nurse a credential type does not apply to, every requirement of that type counts as `OPTIONAL`: the credential can still be recorded and verified, but its absence or expiry never makes the nurse ineligible. A nurse without a listed nationality matches no nationality — an "except" type applies to them, an "only" type does not. The hospital baseline sets **Passport** and **Resident ID (Iqama)** to every nationality except Saudi, and adds **National ID** (number protected like the Iqama number, issue and expiry dates, upload required) for Saudi nationals only; which units and positions require each one is still set in the requirements. Changing a nurse's nationality, or a type's setting, re-evaluates the nurses concerned at once (`modules/credentials/nationality-rule.ts`). HR and supervisors can read rules **only for units in their assigned scope**, including when they pass an explicit `unitId` filter.

## 2. Credential records

**Stored statuses:** `PendingVerification`, `Valid`, `ExpiringSoon`, `Expired`, `Suspended`, `Revoked`.

| Step | Rule |
| :--- | :--- |
| Record | HR records a credential, or the nurse submits their own; tracked fields are validated against the type. Starts `PendingVerification` |
| Evidence | PDF, JPEG, PNG or WebP, ≤ 10 MB, content checked against the file's first bytes; never overwritten; downloadable only when marked clean (D1–D4) |
| Verify | HR (not the holder — D-26) verifies → `Valid` or `ExpiringSoon` or `Expired`, by date |
| By date (daily job) | `Valid` → `ExpiringSoon` within **60 days** of expiry → `Expired` the day after the expiry date |
| Renewal | The nurse or HR stages new data and uploads new evidence; the current credential stays usable until its own expiry. HR approves (promotes the staged data and evidence) or rejects (clears them; the approved record is unchanged) |
| Suspend / revoke | Immediate ineligibility. Revoked is final |

**Iqama expiry:** the baseline Iqama type accepts an Umm al-Qura Hijri expiry field. The server converts that value to the corresponding Gregorian calendar day before recording or renewing the credential; the Gregorian `expiryDate` is the authoritative date for eligibility. It rejects invalid Hijri dates and an explicit Gregorian date that conflicts with the tracked field. The paired `expiryDateHijri` is stored for display. **Pre-fix records need review:** a credential entered with a Hijri expiry before this conversion may have a Gregorian year such as 1448 in `expiryDate`. Before deployment, HR must identify and reconcile such records against the evidence and audit trail; this change does not silently rewrite clinical records.

**Display labels** (never authorize anything on their own): `Active`, `SubjectToRenew` (within 60 days), `OnProcess` (renewal awaiting review), `Expired`.

**Who sees what:** the holder and scoped HR see everything; a scoped Supervisor gets a compliance view with no tracking data (identity numbers), no staged values and no evidence downloads (spec §5.2, D5).

## 3. The engine

`evaluate(facts, {date, today, now})` in `backend/src/modules/eligibility/engine.ts` — a pure function; every rule below has a unit test in `engine.test.ts`.

Checks, in the specification's order (L4):

| # | Check | Blocks with |
| :-: | :--- | :--- |
| 1 | Employee exists, not deleted, status Active | `EMPLOYEE_NOT_FOUND`, `EMPLOYEE_DELETED`, `EMPLOYEE_NOT_ACTIVE` |
| 2 | Position is schedulable (DON, DEPUTY_DON, ADMIN are not) | `POSITION_NOT_SCHEDULABLE` |
| 3 | An Approved or Active contract covers the date | `NO_CONTRACT_COVERAGE` |
| 4 | The employee has a unit (D-27); requirements apply. **None configured → allowed** with `NO_REQUIREMENTS_CONFIGURED` (D-4) | `UNIT_NOT_ASSIGNED` |
| 5 | For each required type, in turn: a verified (`Valid`/`ExpiringSoon`) credential issued by the date and not expired on it (the expiry date is the last valid day — D-15) → else **grace** → else a **waiver for that type** → else a **transition** before its deadline → else block | `CREDENTIAL_MISSING`, `CREDENTIAL_NOT_VERIFIED`, `CREDENTIAL_EXPIRED`, `CREDENTIAL_NOT_YET_ISSUED`, `CREDENTIAL_EXPIRY_UNKNOWN`, `CREDENTIAL_SUSPENDED`, `CREDENTIAL_REVOKED` |
| 6 | Caller scope | Enforced by the calling service |

**Outcome (L5):** `INELIGIBLE` if anything blocks; otherwise `ELIGIBLE_WITH_GRACE` if a grace window is used; otherwise `ELIGIBLE_WITH_POLICY_WARNING` if a transition requirement is unmet; otherwise `ELIGIBLE`. Every result carries its reasons (block, warn or info) and the engine version.

### Grace (§6.1.1, L8)

A credential that has **expired** is still accepted when all of these hold: the type has grace days > 0; the date is within expiry + grace days; a **renewal is in progress** (staged data or evidence awaiting review); it is not suspended, revoked or unverified; and no earlier grace window for a different expiry is still open (no stacking). Grace is never silent: first use is recorded on the credential, audited HIGH, and notified to the holder and scoped HR. Approval closes the cycle; rejection, suspension or revocation closes it for good.

### Waivers (§6.1.2, L9)

An emergency waiver covers **one credential type** for one nurse, for at most **72 hours** (also a database constraint). Only a Supervisor or HR Admin may issue one (D-28 — not System Admin, not break-glass), never for their own credential (D-26). Every waiver and every shift published in reliance on it is audited.

### Policy transitions (§6.1.1.1, L10)

A `TRANSITION` requirement warns (`POLICY_TRANSITION_WARNING`) until its deadline, judged against **today**, and blocks like `MANDATORY` after it. Nurses affected by a new transition requirement are notified.

## 4. Where the engine is used

| Use | Date evaluated | Notes |
| :--- | :--- | :--- |
| Stored state (`eligibility_states`) | Today | Refreshed inside every transaction that changes a fact (contract, credential, requirement, type, waiver, unit, position, employee) and by the daily job. Changes of status are audited |
| Roster pool, board, auto-fill | Each shift date | Live engine, never the stored snapshot (L7) |
| Publication | Each shift date | One transaction; an ineligible nurse stays Draft with reasons; grace or waiver reliance is stored on the assignment |
| Future published shifts | Each shift date | When a fact changes (or a date passes), published shifts that are no longer valid return to Draft, are audited HIGH, and the unit's Supervisors are notified (§6.2) |
| Attendance | Today | A nurse who clocked in but is ineligible today shows as `INELIGIBLE_ON_DUTY` |

## 5. Reminders

Daily at 06:00 Asia/Riyadh (`jobs/expiry-scan.ts`; owner decision D-39, which overrides rule N2):

| Days before the last valid day | Credential → | Contract → |
| :--- | :--- | :--- |
| 90 | — | Employee, scoped HR |
| 60 | Employee | — |
| 30 | Employee | Employee, scoped HR |
| 14 | Employee, unit Supervisor | Employee, scoped HR, unit Supervisor |
| 7 | Employee, Supervisor, scoped HR | Employee, scoped HR, Supervisor |
| After expiry / end | Employee, Supervisor, scoped HR | Employee, scoped HR, Supervisor |

Each run sends only the milestone a record is in now, once per recipient (event key = record + date + milestone), so a missed run or a late entry never produces a burst. A contract with a later Approved or Active contract gets no reminder. Notifications are in-app and, once the hospital SMTP relay is configured, also e-mailed to the recipient's account (D-47; [DEPLOYMENT.md §2.2](DEPLOYMENT.md#22-e-mail-hospital-smtp-relay)).

## 6. Owner-configurable values

| Value | Where | Current |
| :--- | :--- | :--- |
| Grace days per type | Credential catalog (four-eyes) | 0 for every type in the baseline file until the hospital policy sets them; 0–90 |
| Requirements per unit / position | Requirements page | None until the hospital enters its policy (the six illustrative ones exist only in the development fixtures) |
| Renewal window | `RENEWAL_WINDOW_DAYS` in `credentials/records.ts` | 60 days (spec §5.2) |
| Reminder milestones and recipients | `MILESTONES`, `ROUTING` in `jobs/expiry-scan.ts` | D-39 |
| Waiver maximum | Spec §6.1.2 + database constraint | 72 hours |
