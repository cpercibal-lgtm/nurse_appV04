# Workforce: organisation, employees, contracts, scheduling and attendance

Sources: reference spec §2.9 (organisation), §3.1 and §3.1.1 (onboarding, positions), §4 (contracts), §6.2–6.3 (roster, coverage), §14.2 (attendance); rules W, E, C and S in the [rule register](FEATURE_MASTER_INVENTORY.md#15-business-rule-register); amendments in [SYSTEM_SPECIFICATION.md](SYSTEM_SPECIFICATION.md). Endpoints: [API.md §2.4–2.10](API.md#24-workforce-modulesworkforce--implemented-in-commit-7).

## 1. Organisation

| Item | Rules | Who changes it |
| :--- | :--- | :--- |
| Departments | Deactivation refused while the department has active units (W1) | System-wide HR / System Admin (D-34) |
| Units | Code unique; deactivation refused while it has active employees (W2); hospital bed total is computed live, never a constant (W3) | System-wide (create, rename, move, deactivate, CSV import) |
| Bed count | 0–500 (database constraint); every change needs a reason and writes one log row with actor, before and after (W4). Bulk update: per-row result, applied rows commit together (W5). CSV import: dry run by default, RFC 4180 quoting, ≤ 500 rows, never deletes or deactivates | HR / System Admin with the unit in scope |
| Positions | Tier from the §3.1.1 list; deactivation refused while held by active employees (W6); changing "schedulable" re-evaluates every holder (W7) | System-wide |
| Coverage targets | Minimum staff per unit and shift (Morning / Evening / Night); `null` = **unspecified**, never zero (W8). No formula (D-16) | HR / System Admin with the unit in scope |

**Nurse-to-bed KPIs (D-11, D-70).** Defined by the MoH Ada'a indicator profiles ([reference](reference/MOH_ADAA_NURSE_TO_BED_KPI.md)). KPI A scores the ICU, ER and OR areas separately (codes 1–4) and averages the codes; KPI B (QFR-55) is hospital-wide. Nurses = Published assignments of positions with **Nurse (KPI)** on, averaged per shift over one shift or a month (the month so far while it runs). Which units are ICU, ER or OR is each unit's **KPI critical area** (D-42). KPI B counts nurses only in units with **Patient-care area** on, against the beds of units with **Inpatient beds** on. All four settings belong to system-wide HR; the page and the response list what was counted (`basis`).

## 2. Employees

**Fields** (spec §3.1): first, middle, last name (full name is composed by the database, never typed — E3), job number (unique regardless of case, **no format rule** — E1), job title, file number (not unique — E8), rank/grade, nationality, job post location, actual work place, specialty, marital status (Single / Married / Others), salary in SAR (≥ 0), contact email, **mobile phone and emergency contact phone** (E.164, D-35), unit (or Unassigned), position, hire date.

| Operation | Rules |
| :--- | :--- |
| **Onboarding** (E10, D-3) | One transaction: employee + **Draft** contract (Hijri dates converted by the server) + HIGH audit + eligibility state. Defaults: Unassigned, position SN (E6) — when the hospital has no active SN position, a position must be chosen. Needs an idempotency key. The nurse is ineligible until another HR person approves the contract |
| Edit | HR within scope; a unit move re-evaluates eligibility and returns invalid future published shifts to draft |
| Position change (E9) | HR Admin only (not System Admin); refuses inactive or unchanged positions; reason required; audited from → to |
| Delete | Soft delete with a reason (≥ 10 characters); history kept; eligibility becomes INELIGIBLE; never on one's own record (D-37) |
| Own phones (D-35) | The employee edits their mobile and emergency contact numbers on **My Profile**; nothing else |

**Views** (D-36): HR sees every field; a Supervisor sees the baseline (see [RBAC.md §4](RBAC.md#4-what-each-role-sees-response-fields)); the employee sees their own record.

## 3. Contracts

| From | Action | To | Who |
| :--- | :--- | :--- | :--- |
| Draft | submit (needs a clean PDF copy) | PendingApproval | HR / System Admin in scope |
| PendingApproval | return | Draft | HR / System Admin in scope |
| PendingApproval | approve | Active if it covers today, else Approved | A different HR person — not the creator or submitter (D-30) |
| Approved / Active | suspend · terminate | Suspended · Terminated (final) | HR / System Admin in scope, with a reason |
| Suspended | reinstate | Approved or Active by date (overlap re-checked) | HR / System Admin in scope |
| Approved | start date reached | Active | Daily job |
| Approved / Active | end date passed | Expired | Daily job |

`Superseded` is never set by hand (spec §4.2). Transition map: D-29.

| Rule | Detail |
| :--- | :--- |
| Coverage (C1–C3, C12) | Only Approved and Active contracts cover a date; an Approved future period covers shifts inside it |
| No overlap (C4) | Two Approved/Active periods of one employee may not overlap (inclusive dates) — checked by the service, enforced by a database exclusion constraint |
| Dates (C5, C9) | End after start; Gregorian authoritative, Umm al-Qura stored beside it |
| One contract at a time (C6, C10) | "Create" offers only employees with no Approved/Active contract; otherwise renew |
| Renewal (C8) | Prefill starts the day after the previous end with the same length (editable). Allowed while the current contract still covers, so the next period can start the day after it ends (D-41) |
| Copy (C11) | A clean PDF copy is required before submit |
| Separation of duties (D-30, D-37) | The creator and the submitter cannot approve; nobody acts on their own contract |
| By date (daily job) | Approved → Active on the start date; Approved/Active → Expired after the end date |
| Reminders | 90 / 30 / 14 / 7 days and after the end ([CLINICAL_ELIGIBILITY.md §5](CLINICAL_ELIGIBILITY.md#5-reminders)) |

Every transition re-evaluates the nurse's eligibility in the same transaction.

**Known limit:** the renewal picker (`GET /contracts/renewable`) returns at most 500 employees in the caller's scope, ordered by job number, with no search. A hospital-wide HR Admin with more than 500 employees will not see the rest there — see [DEPLOYMENT.md §6](DEPLOYMENT.md#6-known-gaps-before-production).

## 4. Scheduling

**Shift times** (D-31, `backend/src/config/shifts.ts`, Asia/Riyadh): Morning 07:00–15:00, Evening 15:00–23:00, Night 23:00–07:00 (ends the next day).

| Rule | Detail |
| :--- | :--- |
| Who (D-14) | Scoped Supervisors draft, auto-fill, cancel and publish. HR and System Admin read the board and coverage |
| Where (D-32) | A nurse is scheduled **only in their home unit** |
| One slot (S1) | One assignment per nurse per date and shift type, across units (database constraint) |
| Live eligibility (L7) | Board, pool, auto-fill and publication use the engine for each shift date |
| Past dates | Drafting and publishing refuse dates before today |
| Publication (S3) | One transaction under a per-unit lock; every draft is re-validated; ineligible drafts stay Draft with reasons; grace or waiver reliance is recorded and audited |
| Revalidation (§6.2) | When a nurse's facts change, or a date passes, future published shifts that became invalid return to Draft, are audited and the Supervisors are notified |
| Coverage (S4, S5) | Eligible, non-cancelled assignments per unit and shift against the target; draft and published counted separately; unspecified target shown as such; a shortage warns and never blocks publication |
| Window (S6) | Date ranges are at most 94 days |
| Auto-fill | Fills to the configured targets only, fewest shifts first, at most one auto-filled shift per nurse per day. **A heuristic, not policy:** rest, fatigue and overtime rules are REQUIREMENT NOT ESTABLISHED |
| Employee view | Own shifts and the home unit's **published** schedule only |

## 5. Attendance

Clock events come from the hospital badge system (PACS). **The feed is not built:** its interface contract (authentication, format, delivery) is undefined (D-33), so events are read from `attendance_events` but no ingest endpoint exists.

**Gap classification** (`classifyShift` in `modules/attendance/service.ts`, spec §14.2 as amended by D-38) for each published shift:

| Status | When |
| :--- | :--- |
| `UPCOMING` | The shift has not started |
| `PENDING` | Started less than 30 minutes ago and no clock-in yet |
| `MISSING` | No clock-in from **30 minutes before** the start to the end, and 30 minutes have passed since the start |
| `PRESENT` | A clock-in in that window |
| `INELIGIBLE_ON_DUTY` | Clocked in, but the engine blocks the nurse today |

The gap view (`GET /attendance/gaps`) and the 15-minute alert job share this function. An alert is a CRITICAL in-app notice to the unit's Supervisors, sent once per missing assignment. Early-arrival pay is payroll's concern, not this system's.
