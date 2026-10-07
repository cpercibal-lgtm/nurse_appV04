# System specification — V04

**The functional specification of V04 is the [reference specification v2.8.7](reference/AIGH_Nursing_Workforce_Management_System_v2_8_7.md), as amended by this document.**

- Where this document and the reference disagree, **this document wins**. Every amendment below is an owner decision recorded in the [decision record](V04_ARCHITECTURE_PLAN.md#9a-decision-record-2026-09-23) with its date.
- Where this document is silent, the reference applies.
- The reference is kept verbatim for traceability and is never edited. Its code samples (NestJS services, `SECURITY DEFINER` functions, Redis) describe a design that V04 did not adopt; see [ARCHITECTURE.md](ARCHITECTURE.md).
- Nothing here invents a clinical, legal, staffing or licensing rule. Where the reference has no rule, the item is listed in §4 as **REQUIREMENT NOT ESTABLISHED**.

## 1. Amendments

Each row changes what the reference says. "Spec" is the section of the reference.

| # | Spec | Reference says | V04 rule | Decision |
| :-: | :--- | :--- | :--- | :--- |
| A1 | §3.1 | Onboarding creates the employee and an **Approved** contract | Onboarding creates the employee and a **Draft** contract, atomically, with an audit entry. Coverage starts only after a different HR person approves the contract (§4.2 C2) | D-3, D-30 |
| A2 | §3.1 "Bulletproof Rule" | A `SECURITY DEFINER` database function performs onboarding; the runtime has no `INSERT` on `employees`/`contracts` | One Prisma interactive transaction performs onboarding; database constraints still enforce job-number uniqueness, contract dates and overlap | D-17 |
| A3 | §3.3 | Login accepts username or email | Login accepts the **account email** only; no username field exists | D-21 |
| A4 | §3.3 | Employees can change their own phone number | Two numbers: **mobile** and **emergency contact (next of kin)**, E.164 (`+`, 8–15 digits). The employee edits both; HR maintains both. The emergency number is seen by the employee and HR only and its value is kept out of the audit trail | D-35 |
| A5 | §6.1 check 4 | No applicable credential rule → scheduling **blocked** | No applicable rule → **allowed**, with the informational reason `NO_REQUIREMENTS_CONFIGURED` so the gap is always visible | D-4 |
| A6 | §6.1, §6.2 | Caller scope authorizes "the nurse and destination unit/post/shift" (cross-unit placement possible) | A nurse is drafted and published **only in their home unit**. Floating needs an engine change first, because the engine applies the home unit's credential rules | D-32 |
| A7 | §7.1 | Each reminder goes to the employee **and** scoped HR (N2); milestones not named | Milestones and recipients: **credentials** at 60 / 30 days → employee; 14 → + unit Supervisor; 7 and on expiry → + scoped HR. **Contracts** at 90 / 30 → employee + scoped HR; 14, 7 and on end → + Supervisor. No contract reminder once a later contract is Approved or Active. Windows unchanged (contracts 90, credentials 60) | D-39 |
| A8 | §14.2 | A shift is "missing" when there is no clock-in **at or after** the start, 30 minutes after the start | A clock-in from **30 minutes before** the start counts. Presence only — early-arrival pay rules belong to payroll | D-38 |
| A9 | §0.2, §11.4 | Node 20 LTS | Node 22 LTS or newer (Node 20 reached end-of-life in April 2026). PostgreSQL 15 unchanged | D-13 |

## 2. Clarifications

The reference is silent or open on these; the owner settled them. They add detail without contradicting the reference.

| Spec | Clarification | Decision |
| :--- | :--- | :--- |
| §3.3 | Sessions: 15-minute access token; a session not refreshed for 1 hour ends; 24-hour absolute limit through every rotation | D-6 |
| §3.3 | Login attempt limits: 5 per account and 20 per client per 15 minutes (configurable; the reference sets no numbers) | D-23 |
| §3.3 | Own sign-in history: one entry per session with sign-in and last IP and browser | D-22 |
| §3.2 | Registration by invitation is built: HR sends a single-use 72-hour link by e-mail to an unclaimed employee with a current contract; the employee confirms with the Job Number and creates one self-service account. HR can still provision an account with an initial password | D-23, D-47 |
| §4.2 | Contract status transitions: Draft → PendingApproval → Approved/Active, return to Draft; suspend, reinstate, terminate (final); Expired only by the daily job; Superseded never set by hand | D-29 |
| §4.2 | A contract may be renewed while the current one still covers; the next period follows it directly and the overlap rule (C4) keeps them apart. V03's rule C7 (renew only after coverage lapsed) is not used | D-41 |
| §10.6 | Nightly backup at 01:00 Asia/Riyadh (22:00 UTC), scheduled independently of the host clock | D-40 |
| §5.1, §8.1 R10 | "Modifying global eligibility rules" = the hospital-wide credential catalog: every credential type change needs a second, system-wide administrator. Unit requirements apply at once | D-24, D-25 |
| §5.2 | "Subject to Renew" window stays 60 days | D-39 |
| §6.1 | An employee without a unit is ineligible (`UNIT_NOT_ASSIGNED`) | D-27 |
| §6.1.2 | Waivers: Supervisor or HR Admin only — System Admin and the break-glass account cannot issue them. A waiver covers one credential type (not all checks) and at most 72 hours | D-15, D-28 |
| §6.1 | Credential dates are checked against the shift date, not only the stored status | D-15 |
| §6.2 | Scoped Supervisors draft and publish; HR and System Admin have a read and coverage view | D-14 |
| §6.3 | No staffing formula: coverage targets are entered per unit and shift; an unset target is "unspecified", never zero | D-16 |
| §8.1 | Supervisor view of an employee ("private fields suppressed"): shown — name, job number, unit, position, job title, specialty, status, hire date, contact email, mobile phone, actual work place; hidden — salary, marital status, nationality, rank/grade, file number, job post location, emergency contact phone | D-36 |
| §8.1 | Organisation structure (departments, units, positions, CSV import) is hospital-wide configuration; unit-scoped HR manages beds and coverage targets | D-34 |
| §8.1 | Separation of duties: nobody acts on their own credential (D-26), approves a contract they created or submitted (D-30), or acts on their own contract or deletes their own employee record (D-37) | D-26, D-30, D-37 |
| §8.1 | Audit trail readable by System Admins only until HR access is decided | D-20 |
| §3.6 | Break-glass is built minimally: irrevocable event, HIGH audit, CRITICAL in-app alert to System Admins, 4-hour session; e-mail to System Admins and to the CEO and IT Director (`BREAK_GLASS_ALERT_EMAILS`); a Telegram message to them (`BREAK_GLASS_ALERT_TELEGRAM_CHAT_IDS`) through the Telegram gateway, with no personal data — simulated by the mock driver (Dev Console Telegram inbox) until the bot is set up. **Amendment:** Telegram replaces the SMS text of D-48 / D-59 | D-9, D-47, D-66 |
| §5.3 | Uploads: magic-byte and size checks, then a synchronous ClamAV (`clamd`) scan before storage; infected files are rejected and audited, never stored; scanner outages fail closed. Development may skip the scan (`dev-magic-bytes`); production refuses to start without `clamav`. **The spec's asynchronous quarantine queue and scan worker are deliberately not built** ([DEPLOYMENT.md §2.1](DEPLOYMENT.md#21-malware-scanner-clamav)) | D-10, **D-43** |
| §14.2 | Attendance: the gap view, 15-minute alerts and the badge-event ingest (`POST /attendance/events`, an API client with `attendance.ingest`) are built, with a Dev Console badge simulator until the badge system is connected; the PACS contract itself is open (B-15) | D-33, D-65 |
| §8.3.1–8.3.4 | PDPL: fields a credential type marks sensitive (Iqama, passport, SCFHS registration — marked in the hospital baseline) are encrypted with the employee's own key (AES-256-GCM, wrapped by `PDPL_FIELD_ENCRYPTION_KEY`) and found only by exact number through an HMAC blind index (`PDPL_BLIND_INDEX_PEPPER`); a value is stored only while the processing register has an active lawful basis for its category; ID-shaped numbers are masked in every log line | D-54 |
| §8.3.2, §8.3.4 | Key rotation and DPO sign-off: each encryption key and the blind-index pepper can be replaced without downtime — the old key is kept beside the new one while `npm run keys:rotate` re-wraps employee keys and stored files, re-seals authenticator seeds and rebuilds the search index (digests carry their key id); System health shows an unfinished rotation. The Data Protection Officer's sign-off of the processing register is recorded with the register as reviewed, due yearly and after any change | D-56 |
| §8.3.3 | Data-subject rights: an employee asks under **My data** for a copy (ACCESS), an export (PORTABILITY), a correction (RECTIFICATION) or erasure (ERASURE); HR can log a request received on paper. HR within scope reviews and answers within 30 days (overdue requests show in System health). An approved access or portability request gives a JSON package of everything held about the employee, downloadable for 30 days. **Erasure** is approved only by a System Admin other than whoever logged it, typing the job number to confirm: the employee's key is destroyed (crypto-shredding), their number-search rows are removed and their identity scans deleted from the vault; ordinary employment records stay. The request records when the key was destroyed and when the last backup holding the old ciphertext expires (`BACKUP_RETENTION_DAYS` + 1 day). Requests are never deleted | D-55 |
| K1 | The Ada'a nurse-to-bed KPIs follow the MoH Ada'a indicator profiles ([reference](reference/MOH_ADAA_NURSE_TO_BED_KPI.md)): nurses only, average per shift over a shift or a month, patient-care areas, inpatient beds | D-11, D-70 |

## 3. Open conflicts

| Item | Status |
| :--- | :--- |
| — | None open. (Renewal timing was settled by D-41, the backup time by D-40.) |

## 4. REQUIREMENT NOT ESTABLISHED

The reference (and the owner, so far) gives no rule for these. V04 builds nothing that depends on them, or uses a clearly marked technical default.

| Item | V04 behaviour |
| :--- | :--- |
| Employment statuses other than "Active" | Only "Active" is used; any other value makes the employee ineligible |
| Rest, fatigue, overtime and maximum-shift rules | None enforced. Auto-fill gives at most one shift per nurse per day (a heuristic, not policy); manual drafting can add a second shift on another shift type |
| Acuity, skill mix, mandatory posts, staffing ratios | Not built |
| Agency workforce | Not built |
| Leave and absence | Not built |
| HR access to the audit trail | System Admin only (D-20) |
| Password reset | Built (D-50): self-service by e-mail for staff accounts (30-minute link); HR / System Admin sends the link for HR, supervisor and admin accounts (24 hours); break-glass never |
| Unique contact e-mail | Not enforced (D-19) |
| Ada'a KPI basis | Units behind 72 of the hospital's 358 operational beds; whether Assistant Nurses (AN) hold an SCFHS nursing licence; whether ICU Extension's beds are staffed (D-70) |
| Badge-feed contract (auth, format, delivery) | Not built (D-33) |
| Approval notification rules | None beyond the approval queue itself |
| Staff accepting or declining a published shift (e.g. from Telegram) | Not built (D-66): what a decline changes on a published roster, who is told, what it does to coverage, and any deadline are not decided |

## 5. Deferred — specified, not built in V04

These stay in the reference and get their own migration and module when scheduled.

| Spec | Capability |
| :--- | :--- |
| §7.6 | Mobile push. (SMTP e-mail, §7.2, is built — D-47; the §7.4 health endpoint is replaced by the monitoring query in DEPLOYMENT.md §7) |
| §3.5 | SSO (identity provider not chosen). MFA is **built** (D-51): authenticator app + recovery codes, required for System Admin, HR Admin and Supervisor, never for break-glass |
| §5.3 | (The document vault is **built**, D-53: storage adapter with local disk today, AES-256-GCM encryption at rest, integrity check on every read, single-use 60-second links, daily reconciliation. Not built: object storage — waits for the hosting decision — and a separate quarantine store, which D-43's synchronous scan makes unnecessary: nothing unscanned is ever stored) |
| §5.4 | (SCFHS verification is **built** behind a gateway, D-64: checks on submission, on demand and nightly, the verification log, HR notices, automatic suspension per credential type, a circuit breaker — answered by a simulated registry until the SCFHS agreement, U3. Not built: the live SCFHS API call) |
| §9.2 | (Request-level forensic log is **built**, D-52: `request_audit_log`, one row per API request except the liveness probe, written after the response in batches; no bodies or query strings — the body only as an HMAC with secrets removed; 365 days; Audit → Requests) |
| §9.3 | Redis (not used; the database is read on every request) |
| §10.4–10.5 | (Blue/green releases are **built** for the single-VPS layout, D-57: [ops/vps](../ops/vps/README.md). Not built: blue/green for the Google Cloud alternative, D-49, which was not chosen; and further operations tooling) |
| §10.7 | Database privilege separation (runtime / migration / backup / audit-reader roles). The audit table is append-only by trigger regardless of role; the roles and grants are in [`ops/db`](../ops/db/README.md) (tested; adaptations from the spec listed there) and still have to be applied per server — see [DEPLOYMENT.md](DEPLOYMENT.md#6-known-gaps-before-production) |
| §10.8 | (Consistency auditor and business health are **built**: daily sample of max(1%, 50) nurses, drift logged + corrected + audited; `GET /system/health/business`. SCFHS checks are reported too, D-64: the nightly run's freshness via the job table and `SCFHS_UNREACHABLE` / `SCFHS_ERRORS`; evidence integrity via the vault check, D-53) |
| §10.9 | (Shadow mode is **built**, D-60: engine versions registered in `modules/eligibility/logic.ts`; a new one runs in shadow beside the active one on every stored evaluation, disagreements kept in `eligibility_shadow_log` for a system-wide HR Admin to approve or reject; promotion after 7 days without a disagreement or once all are approved; Nursing Administration → Eligibility logic. Previews and pool checks run the active logic only) |
| §10.10 | Legacy migration bridge (no V03 production data exists — [MIGRATION.md](MIGRATION.md)) |
| §14.1, §14.3 | (The FHIR R4 read API is **built**, D-61: Practitioner and PractitionerRole, search by job number, validated by the HL7 validator in CI; a signed-in HR or System Admin, within scope. The §14.3 exit package is **built**, D-62: a server-side command, encrypted to the backup key on the VPS. Other systems call the FHIR API with OAuth 2.0 client credentials, D-63: registered by a System Admin, 15-minute tokens, read scopes, revocable at once) |

## 6. How V04 implements the rest

Where the reference describes a mechanism rather than a rule, V04 may reach the same result differently. These are design choices, not rule changes:

| Spec | Reference mechanism | V04 |
| :--- | :--- | :--- |
| §6.1 | Pool and roster read the materialized eligibility state | The state is kept (and refreshed in every transaction that changes a fact), but pool, board, auto-fill and publication run the engine live for the shift date (rule L7) — a snapshot can never clear a nurse |
| §6.1.1 | A `grace_period_log` table | Grace activation, completion and closure are HIGH audit entries |
| §9.1 | Audit hash in application code | One SQL function hashes stored columns, including the timestamp, so every row's content can be re-verified (D-7) |
| §10.2–10.3 | Separate worker with advisory locks | The same job code runs in the API (development) or a separate worker (production), each job under a lease and a unique run key |
