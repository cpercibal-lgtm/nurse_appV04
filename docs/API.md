# API

The single V04 HTTP API. Every business rule behind these endpoints is enforced in the backend services and database; the frontend only calls them. Section numbers (§2.x) are cited from code comments, so they stay stable.

- Who may call what: [RBAC.md](RBAC.md) (generated from `backend/src/modules/users/permissions.ts` and checked by a test).
- Owner decisions (D-n) referenced below: [V04_ARCHITECTURE_PLAN.md §9a](V04_ARCHITECTURE_PLAN.md#9a-decision-record-2026-09-23).
- The V03 endpoints this API replaced: [Appendix A](#appendix-a--v03-api-historical).

## 2. V04 API (single, authoritative)

### 2.1 Conventions

- **Prefix `/api/v1`** (the spec's convention). No compatibility requirement exists for `/api/*`: the V04 frontend is rebuilt in the same repository, so the old routes are dropped rather than aliased.
- **Auth:** `Authorization: Bearer <access JWT>` on everything except health, login and refresh. The refresh cookie is scoped to `/api/v1/auth`.
- **Authorization:** middleware `authorize(permission)` resolves effective roles + scopes from `role_assignments` (fresh read per request, R9). The service layer then filters rows by scope. The "Scope" column below is the row filter.
- **Validation:** every body/query validated with a zod schema; unknown fields rejected.
- **Errors:** `{error: {code, message, details?}}`. Stable codes (`CONTRACT_PERIOD_OVERLAP`, `POSITION_NOT_ACTIVE`, `SELF_APPROVAL_FORBIDDEN`, …) carried over from V03 messages.
- **Idempotency-Key** (UUID v4) required where marked **[I]**.
- **If-Match** (edits marked **[V]**): the record's `updatedAt` as loaded, in quotes (`If-Match: "2026-10-08T11:19:39.123Z"`; `W/` accepted). If the record changed since, the edit is refused with **409 `STALE_RECORD`** (`details.currentVersion`) and nothing is written; the row is locked during the check, so of two edits from the same version exactly one is applied. A malformed value is 400 `IF_MATCH_INVALID`. Without the header the edit is applied as before; the application's edit dialogs always send it, and so does the account Activate/Deactivate button; the one-field Activate/Deactivate buttons of the master lists do not, as they cannot overwrite another person's change (QA checklist DB-03).
- **Audit:** every mutation writes an audit row in the same transaction (A1).
- **Pagination:** list endpoints accept `?page&pageSize` (default 50, max 200) and return `{items, total}`.
- **Date windows** are bounded to 94 days (S6).

Role shorthand: **SA** SYSTEM_ADMIN (requires active PAM elevation, R13) · **HR** HR_ADMIN · **SUP** SUPERVISOR · **EMP** any authenticated user (implicit EMPLOYEE) · *own* = records linked to the caller's `User.employeeId`.

### 2.2 Platform & auth

| Method | Endpoint | Purpose | Permission | Request → Response | Source |
| :--- | :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/health` | Liveness + DB | public | → 200 `{status: ok, database: up}` · 503 `{status: degraded, database: down}` | server |
| POST | `/api/v1/auth/login` | Login | public (rate-limited per account and per client) | `{email, password}` → `{token, csrfToken, expiresIn}` + `nurseapp_refresh` (HttpOnly, path `/api/v1/auth`) and `nurseapp_csrf` cookies; 429 `TOO_MANY_ATTEMPTS` + `Retry-After`. **When a second step is due** (spec §3.5): `{mfa: {step: VERIFY \| ENROLL, challenge, expiresIn}}` and **no cookie** — VERIFY for an account with an authenticator, ENROLL for a role in `MFA_REQUIRED_ROLES` without one; never for break-glass | server, D-51 |
| POST | `/api/v1/auth/mfa/verify` | Second step: authenticator code or recovery code | public (Origin check; the challenge; per-account `mfa:` and per-client limits) | `{challenge, code}` → as a successful login. Each 30-second code works once; a recovery code once. 401 `MFA_CODE_INVALID` · `MFA_CHALLENGE_INVALID` (used, expired after 5 min, 5 wrong codes, other kind); 429 + `Retry-After` | D-51 |
| POST | `/api/v1/auth/mfa/enroll/start` | Second step, first time: a new authenticator seed | public (Origin check; ENROLL challenge, valid 15 min) | `{challenge}` → `{secret, otpauthUri, account}` (QR code) | D-51 |
| POST | `/api/v1/auth/mfa/enroll/confirm` | Confirm the new authenticator with its first code | public (as verify) | `{challenge, code}` → as a successful login **plus** `recoveryCodes[10]` (shown once; only SHA-256 stored) | D-51 |
| GET | `/api/v1/auth/mfa` | Own two-factor status | EMP (own only) | → `{enabled, enabledAt, required, available, recoveryCodesLeft}` | D-51 |
| POST | `/api/v1/auth/mfa/setup` · `/setup/confirm` | Set up an authenticator while signed in (optional for staff) | EMP (own; not break-glass) | → `{secret, otpauthUri}` · `{code}` → `{recoveryCodes}`; 409 `MFA_ALREADY_ENABLED` | D-51 |
| POST | `/api/v1/auth/mfa/recovery-codes` | New recovery codes; the old ones stop working | EMP (own) | `{code}` (authenticator code, not a recovery code) → `{recoveryCodes}` | D-51 |
| POST | `/api/v1/auth/mfa/disable` | Turn it off | EMP (own) | `{code}` → 204; 403 `MFA_REQUIRED` when the account's roles require it | D-51 |
| POST | `/api/v1/auth/refresh` | Rotate (atomic consume; replay → family revoked, `SESSION_REVOKED`) | cookie + Origin + CSRF double-submit | → `{token, csrfToken, expiresIn}` | server |
| POST | `/api/v1/auth/logout` | Revoke the whole session family; clears both cookies | cookie + Origin + CSRF double-submit | → 204 | server |
| POST | `/api/v1/auth/password-reset/request` | "Forgot password?" (D-50) | public (Origin check; per-address and per-client limits) | `{email}` → always 202 `{accepted: true}`: a 30-minute link is e-mailed only to an active **staff** account (no HR / Supervisor / System Admin assignment, not break-glass); nothing reveals whether the address exists. 429 + `Retry-After` | D-50 |
| POST | `/api/v1/auth/password-reset/complete` | Set a new password with the e-mailed link | public (Origin check; per-client limit) | `{token, password 12–72}` → 204; signs out every session of the account and clears its sign-in lockout. Invalid, used, expired or superseded link (or a staff link after a promotion) → 400 `PASSWORD_RESET_INVALID` | D-50 |
| POST | `/api/v1/auth/invitations/preview` | Registration step 1 (spec §3.2) | public (Origin check; per-client limit) | `{token, jobNumber}` → `{fullName, jobNumber, unit, unitAr, position, positionAr, emailHint, expiresAt}` (e-mail masked); any bad token / Job Number → 400 `INVITATION_INVALID`; 429 + `Retry-After` | spec §3.2 |
| POST | `/api/v1/auth/invitations/claim` | Registration step 2: create the account | public (Origin check; per-client limit) | `{token, jobNumber, email, password 12–72}` → 201 `{userId}`; exactly one account per invitation and per employee, staff self-service role only; any mismatch → 400 `INVITATION_INVALID` | spec §3.2 |
| GET | `/api/v1/auth/me` | Identity, stored grants (SA marked `dormant` until PAM), effective roles, PAM and break-glass state | EMP | → `{user{id,email,displayName,employeeId,isBreakGlass}, roles[], effectiveRoles[], pam, breakGlass}` | server + backend `roles/me` |
| GET | `/api/v1/auth/sessions` | Own sign-in history: one entry per session family — signed in / last active, sign-in and last IP and browser, current, active (**D-22**, commit 9) | EMP (own only) | → `{items[]}` | spec §3.3 |
| POST | `/api/v1/auth/password` | Change own password; revokes all sessions | EMP | `{currentPassword, newPassword}` → 204 | spec §3.3 (new) |

### 2.3 Users & roles (`modules/users`)

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/users` | List accounts | HR (scoped), SA | spec §8.1 Accounts |
| POST | `/api/v1/users` **[I]** | Provision account (optionally linked to an employee) | HR (scoped), SA | spec §8.1 |
| POST | `/api/v1/users/:id/mfa/reset` | Lost authenticator (D-51): removes it and its recovery codes and signs the account out everywhere; set up again at the next sign-in → 204. 403 `SELF_ACTION_FORBIDDEN` · `BREAK_GLASS_ACCOUNT_PROTECTED`; 409 `MFA_NOT_SET_UP`. Audited HIGH; the account holder is notified | HR (scoped), SA (`accounts.write`) | D-51 |
| POST | `/api/v1/users/:id/password-reset` | HR-assisted reset (D-50): e-mails a 24-hour link to the **account's own** address (never returned) → 202 `{email, expiresAt}`. Any active account in scope; 403 `SELF_ACTION_FORBIDDEN` (own account — use change password) · `BREAK_GLASS_ACCOUNT_PROTECTED`; 409 `ACCOUNT_INACTIVE` · `EMAIL_OFF` | HR (scoped), SA (`accounts.write`) | D-50 |
| POST | `/api/v1/employees/:id/invitations` | Invite the employee to register: e-mails a single-use 72-hour link to the contact e-mail (the token is never returned); revokes earlier open invitations. 409 `EMPLOYEE_HAS_ACCOUNT` · `NO_CURRENT_CONTRACT` · `CONTACT_EMAIL_INVALID` · `EMAIL_IN_USE` · `EMAIL_OFF` → `{id, email, expiresAt}` | HR (scoped), SA (`accounts.write`) | spec §3.2 |
| GET | `/api/v1/employees/:id/invitations` | Invitation history: `OPEN` / `CLAIMED` / `REVOKED` / `EXPIRED` (never the token) | HR (scoped), SA (`accounts.read`) | spec §3.2 |
| PATCH | `/api/v1/users/:id` **[V]** | Activate/deactivate, relink employee. The version is the account's `updatedAt` from `GET /users`; signing in does not change it, a password, e-mail or Telegram change does | HR (scoped), SA | new |
| GET | `/api/v1/roles/matrix` | Static matrix §8.1–8.2 | EMP | backend |
| GET | `/api/v1/role-assignments?userId&role&scopeType&active&unitId` | List | HR (within scope), SA | backend |
| POST | `/api/v1/role-assignments` **[I]** | Grant → 201, or 202 `{status:'PENDING_APPROVAL', requestId}` | HR, SA (R2–R7, R10) | backend |
| PATCH | `/api/v1/role-assignments/:id` | Scope/reason/expiry | HR, SA | backend |
| POST | `/api/v1/role-assignments/:id/revoke` | Revoke `{reason}` (POST, not DELETE-with-body) | HR, SA (R2, R8) | backend |
| GET | `/api/v1/approvals?status=PENDING` | Four-eyes queue (role grants/updates; credential-type changes — visible to system-wide admins only) | HR, SA | backend |
| POST | `/api/v1/approvals/:id/approve` · `/reject` | Decide `{reason}` | HR, SA; approver ≠ initiator (R11); both decisions check request scope (catalog: system-wide) | backend |
| POST | `/api/v1/approvals/:id/withdraw` | Initiator withdraws their own pending request with `{reason}`; returns terminal `WITHDRAWN` status and never executes the payload | HR, SA; initiator only; row-locked against concurrent approval/rejection | backend |
| POST | `/api/v1/pam/elevate` · GET `/api/v1/pam/status` · POST `/api/v1/pam/end` | JIT elevation | users holding SA | backend |
| POST | `/api/v1/break-glass/activate` | Siren (R18) | break-glass account only | spec §3.6 — **scope decision D-9** |
| POST | `/api/v1/admin/baseline-import/preview` | `{file}` → per-row CREATE / UNCHANGED / CONFLICT / REJECTED report, totals (beds, fields), `canImport`; writes nothing | `baseline.import` — hospital-wide scope | **D-42** (P7) |
| POST | `/api/v1/admin/baseline-import` | `{file, reason ≥ 10}` → **202** `{status: PENDING_APPROVAL, requestId, report}`; refused with any conflict or rejection (`BASELINE_NOT_IMPORTABLE`) or nothing new (`NOTHING_TO_IMPORT`). A second hospital-wide admin approves via `/approvals/:id/approve`; the file is re-checked (`BASELINE_CHANGED_SINCE_REQUEST`) and applied in one transaction. Break-glass → 201 applied | `baseline.import` — hospital-wide scope | **D-42** (P7) |

**Implemented in commit 5 (notes):**
- Every route under `/api/v1` except health, `/auth/login|refresh|logout` and `/auth/invitations/preview|claim` and `/auth/password-reset/request|complete` and `/auth/mfa/verify|enroll/start|enroll/confirm` and `/files/:token` passes one `authenticate` step; an anonymous caller gets 401 for any path, known or not.
- State-changing requests need `X-CSRF-Token` equal to the session's token (bound into the access token as a hash) and `Origin` equal to the app origin (spec §3.4 CsrfGuard).
- `[I]` responses carry identifiers only (`POST /users` → `{id}`; `POST /role-assignments` → `{status:'GRANTED', id}` or 202 `{status:'PENDING_APPROVAL', requestId}`), so stored idempotent responses hold no personal data.
- Four-eyes approval executes the stored action **as the approver**: every grant rule (R2–R6) is re-checked for them, inside the approval's transaction.

### 2.4 Workforce (`modules/workforce`) — implemented in commit 7

"System-wide" = an HR_ADMIN / SYSTEM_ADMIN assignment with SYSTEM scope. The organisation structure is one hospital-wide configuration (same principle as the credential catalog, D-25); bed counts and coverage targets follow unit scope.

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/departments?includeInactive` | List (active by default) | EMP | spec §2.9 |
| POST · PATCH | `/api/v1/departments`, `/:id` (PATCH **[V]**) | Create / update / deactivate — refused while it has active units (W1) | HR, SA — system-wide | W1 |
| GET | `/api/v1/units?departmentId&includeInactive` | List | EMP | spec §2.9 |
| GET | `/api/v1/units/summary` | Live bed totals by department, active units (W3: the seeded 582 is not a constant) | EMP | kit |
| POST · PATCH | `/api/v1/units`, `/:id` (PATCH **[V]**) | Create (initial beds logged) / rename / move department / set `criticalArea` (ICU / ER / OR / null) / deactivate — refused while it has active employees (W2) | HR, SA — system-wide | W2 |
| PUT | `/api/v1/units/:id/bed-capacity` **[V]** | `{bedCount 0–500, reason}` → `UPDATED`/`UNCHANGED`; one log row per change (W4) | HR, SA — unit in scope | W4 |
| PUT | `/api/v1/units/bed-capacity/bulk` **[I]** | `{rows:[{unitCode, bedCount}], reason}` → per-row `UPDATED`/`UNCHANGED`/`REJECTED` (unknown code, out of scope, bad value, duplicate); applied rows commit together (W5) | HR, SA — rows outside scope rejected | W5 |
| POST | `/api/v1/units/import` **[I]** | `{csv, dryRun=true}`; header `unit_code,name,department_code,beds[,description]`; RFC 4180 quotes; ≤ 500 rows; never deletes or deactivates | HR, SA — system-wide | kit |
| GET | `/api/v1/units/:id/bed-history` | Log with actor name | HR, SA, SUP — unit in scope | W4 |
| GET | `/api/v1/positions?includeInactive` · `/:code` | Directory | EMP | spec §3.1.1 |
| GET | `/api/v1/nationalities` | The fixed nationality list (owner decision 2026-10-03): `{code, name, nameAr, countryName}`, ISO 3166-1 alpha-3, alphabetical by `name`; read-only, changed only by a release | EMP | — |
| GET | `/api/v1/rank-grades?includeInactive&q` | Rank/Grade master (owner decision 2026-10-03): the SCFHS nursing classifications `{code, name, meaning, isActive, sortOrder, employeeCount}` by sort order; `q` searches code, classification and meaning | EMP | — |
| POST · PATCH · DELETE | `/api/v1/rank-grades`, `/:code` (PATCH **[V]**) | Create `{code, name, meaning?, isActive?, sortOrder?}` (409 `RANK_GRADE_EXISTS`) · update `{name?, meaning?, isActive?, sortOrder?}` — the code never changes; audited as updated, deactivated or reactivated · delete only when no employee or licence uses it, else 409 `RANK_GRADE_IN_USE` with the counts | HR, SA — system-wide | — |
| GET | `/api/v1/nursing-specialties?includeInactive&q` | Nursing Specialty master (owner decision 2026-10-03): `{code, name, nameAr, description, isActive, sortOrder, employeeCount}` by sort order; `q` searches code, name, Arabic name and description | EMP | — |
| POST · PATCH · DELETE | `/api/v1/nursing-specialties`, `/:code` (PATCH **[V]**) | Create `{code, name, nameAr?, description?, isActive?, sortOrder?}` (409 `SPECIALTY_EXISTS`, `SPECIALTY_NAME_EXISTS` — names unique ignoring case) · update `{name?, nameAr?, description?, isActive?, sortOrder?}` — the code never changes; audited as updated, deactivated or reactivated · delete only when no employee holds it, else 409 `SPECIALTY_IN_USE` | HR, SA — system-wide | — |
| GET | `/api/v1/saudi-regions?includeInactive&q` · `/api/v1/saudi-cities?regionCode&includeInactive&q` | Saudi location master (owner decision 2026-10-03): regions `{code (ISO 3166-2), name, nameAr, isActive, sortOrder, cityCount, employeeCount}`; cities `{id, regionCode, name, nameAr, isActive, sortOrder, employeeCount}` of one region (active cities of active regions unless `includeInactive`) | EMP | — |
| POST · PATCH · DELETE | `/api/v1/saudi-regions`, `/:code` · `/api/v1/saudi-cities`, `/:id` (both PATCH **[V]**) | Regions: create `{code, name, nameAr?, isActive?, sortOrder?}` (409 `REGION_EXISTS`, `REGION_NAME_EXISTS`); the code never changes; delete only with no cities and no employees, else 409 `REGION_IN_USE`. Cities: create `{regionCode, name, …}` (409 `CITY_NAME_EXISTS` within the region); a held city cannot change region or be deleted (409 `CITY_IN_USE`). All audited (created, updated, deactivated, reactivated, deleted) | HR, SA — system-wide | — |
| GET | `/api/v1/facilities?includeInactive&q` | Facility master (owner decision 2026-10-03): `{id, name, nameAr, isActive, sortOrder, employeeCount}` by sort order | EMP | — |
| POST · PATCH · DELETE | `/api/v1/facilities`, `/:id` (PATCH **[V]**) | Create `{name, nameAr?}` (appended to the end) · update `{name?, nameAr?, isActive?, sortOrder?}` — the id never changes; names trimmed, single-spaced, unique ignoring case (409 `FACILITY_NAME_EXISTS`) · delete only when no employee uses it, else 409 `FACILITY_IN_USE`; audited | HR, SA — system-wide | — |
| POST · PATCH | `/api/v1/positions`, `/:code` (PATCH **[V]**) | Create / update (tier from the §3.1.1 list) / deactivate — refused while held by active employees (W6). A schedulability change re-evaluates holders (L6) | HR, SA — system-wide | W6, W7 |
| GET · PUT | `/api/v1/coverage-targets?unitId` | `{unitId, shiftType, minimumStaff 0–999 \| null}`; `null` removes the target ("unspecified", never zero — W8) | read EMP; write HR, SA — unit in scope | spec §6.3 |
| GET | `/api/v1/kpi/nurse-to-bed?date&shift` or `?month=YYYY-MM` | MoH Ada'a KPI A (units whose `criticalArea` is ICU/ER/OR; each area coded 1–4, averaged) and B (QFR-55: nurses in units with `patientCareArea`, beds of units with `inpatientBeds`). Nurses = Published assignments of positions with `countsAsNurse`, averaged per shift (`period.shifts`; a running month counts up to today). Response: `period`, `kpiA`, `kpiB`, `basis` (nurse positions, area units, non-patient-care units, inpatient-bed units), `source` | HR, SA, SUP | [Ada'a cards](reference/MOH_ADAA_NURSE_TO_BED_KPI.md) — **D-11, D-70** |

### 2.5 Nurses (`modules/nurses`) — implemented in commit 7

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/employees?unitId&unassigned&positionCode&q&page&pageSize` | List | HR/SA scoped → `view: FULL`; SUP scoped → `view: BASELINE` (identity, unit, position, job title, specialty, status, hire date, contact email, mobile phone, actual work place — salary, marital status, nationality, file no., rank, job post and emergency contact phone suppressed) | spec §8.1, **D-36** |
| GET | `/api/v1/employees/onboarding-defaults` | Rule E6 defaults: `{unitId: null, positionCode}` — the default position only if the hospital has it active, else `null` (onboarding then requires a position: `POSITION_REQUIRED`) | HR, SA | E6, **D-42** (P4) |
| GET | `/api/v1/employees/me` · `/:id` | Own profile (FULL) · one record, shaped by viewer | EMP own; HR, SUP scoped | spec §8.1 |
| POST | `/api/v1/employees/onboard` **[I]** | Employee + **Draft** contract (Hijri dates converted by the server; `contractTypeCode` required, an active employment contract type; `nationalityCode` required, a listed nationality; `rankGradeCode` required, an active Rank/Grade; `specialtyCode` required, an active nursing specialty; `jobPostRegionCode` + `jobPostCityId` required, an active city of that region; `facilityId` required, an active facility) + HIGH audit + eligibility state in one transaction → `{employeeId, contractId}`. Defaults: Unassigned, position SN (E6). Job number unique regardless of case (E1) | HR, SA — unit in scope; Unassigned needs system-wide | spec §3.1, **D-3**, D-17 |
| PATCH | `/api/v1/employees/:id` **[V]** | Source fields E1–E8 and the two phones (not position); `nationalityCode` is a listed code — 422 `NATIONALITY_INVALID` — and can be changed but not cleared (choosing one clears unmatched old free text in `nationality`); `rankGradeCode` likewise (422 `RANK_GRADE_INVALID`; a new choice must be active, 422 `RANK_GRADE_INACTIVE`; an unchanged inactive one is kept); `specialtyCode` likewise (`SPECIALTY_INVALID`, `SPECIALTY_INACTIVE`); `jobPostRegionCode` + `jobPostCityId` always together (422 `JOB_POST_INCOMPLETE`), the city must be in the region (`CITY_NOT_IN_REGION`), a new choice active (`REGION_INACTIVE`, `CITY_INACTIVE`); `facilityId` a listed facility (`FACILITY_INVALID`; a new choice active, `FACILITY_INACTIVE`), changed but never cleared; a unit move re-evaluates eligibility; salary and emergency-phone values are not copied into the audit trail | HR, SA — old and new unit in scope | spec §3.1, D-35 |
| POST | `/api/v1/employees/:id/position` | `{positionCode, reason}`; rejects inactive/unchanged; HIGH audit from → to; re-evaluates eligibility | **HR_ADMIN only** (E9), scoped | E9 |
| POST | `/api/v1/employees/:id/assignment` | `{unitId?, positionCode?, reason ≥ 10}` (`unitId: null` = Unassigned); at least one must change (422 `ASSIGNMENT_UNCHANGED`); current and new unit in scope (403 `SCOPE_NOT_COVERED`); not on your own record (403 `SELF_ACTION_FORBIDDEN`); one HIGH audit `EMPLOYEE_ASSIGNMENT_CHANGED` from → to with the reason; re-evaluates eligibility, returning invalid future published shifts to Draft; `Idempotency-Key`. Returns `{id, unitId, positionCode, eligibility}` | HR_ADMIN, SYSTEM_ADMIN (elevated) — `employees.assign` | owner 2026-10-05 |
| GET | `/api/v1/employees/:id/assignment/preview?unitId=&positionCode=` | What the assignment would do (`unitId=none` = Unassigned): the same checks and result plus `shiftsToDraft[]`; run in a transaction that is always rolled back, so nothing is written | `employees.assign` | owner 2026-10-05 |
| DELETE | `/api/v1/employees/:id` | Soft delete, body `{reason ≥ 10}`; history kept; eligibility becomes INELIGIBLE; not on one's own record | HR, SA — scoped | spec |
| PATCH | `/api/v1/employees/me/contact` **[V]** | Own `primaryPhone` / `emergencyContactPhone` only (E.164 `+` 8–15 digits; separators removed; `null` clears); any other field → 400 `VALIDATION_FAILED`; audited `EMPLOYEE_CONTACT_UPDATED` | EMP own record (no permission; `NO_EMPLOYEE_RECORD` if unlinked) | spec §3.3, **D-35** |

### 2.6 Contracts (`modules/contracts`) — implemented in commit 7

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/contracts?employeeId&status&contractTypeCode&page&pageSize` | List; every view carries `contractTypeCode`, `contractTypeName`, `contractTypeNameAr` (null on contracts from before the field) | HR/SA scoped → FULL; SUP scoped → REDUCED (identifiers, employee/position, unit, status, dates) | spec §4.1 |
| GET | `/api/v1/contracts/me` · `/:id` | Own (REDUCED) · one, shaped by viewer | EMP own; HR, SUP scoped | spec §4.1 |
| GET | `/api/v1/contracts/creatable` · `/renewable` | New-contract picker (no Approved/Active contract, C10) · renewal picker with the C8 prefill. `?q=` searches job number or name (case-insensitive) across the whole scope; `?limit=` 1–50 (default 20); `total` counts every match | HR, SA scoped | C8, C10 |
| POST | `/api/v1/contracts` **[I]** | `{employeeId, startDate, endDate, contractTypeCode?}` → Draft; a type given must exist and be active — 422 `CONTRACT_TYPE_INVALID` · `CONTRACT_TYPE_INACTIVE`; without one, the employee's latest contract's type while still active, else none (owner decision 2026-10-04: the screen no longer asks); refused if the employee already has an Approved/Active contract (use renewal) | HR, SA scoped; not own | C5, C6, C10 |
| POST | `/api/v1/contracts/:id/renew` **[I]** | From the employee's latest contract; dates default to the C8 prefill and `contractTypeCode` to the prior contract's while still active, else none → Draft | HR, SA scoped; not own | C8 |
| GET | `/api/v1/contract-types?includeInactive` | Employment contract types (owner decision 2026-10-03): active ones by display order; `includeInactive=true` adds inactive ones; each with `contractCount` | HR, SA, SUP | — |
| POST | `/api/v1/contract-types` | `{code, name, nameAr?, displayOrder?}` → 201; 409 `CONTRACT_TYPE_EXISTS` | HR, SA **system-wide** (403 `SCOPE_NOT_COVERED`) | audited |
| PATCH | `/api/v1/contract-types/:code` **[V]** | `{name?, nameAr?, isActive?, displayOrder?}`; the code never changes | HR, SA system-wide | audited |
| DELETE | `/api/v1/contract-types/:code` | Unused → deleted (`outcome: DELETED`); used by contracts → deactivated (`outcome: DEACTIVATED`, `contractCount`) | HR, SA system-wide | audited |
| POST | `/api/v1/contracts/:id/transition` | `{action, reason?}` per the D-29 map: `submit` (needs a CLEAN copy, C11), `return`\*, `approve` (Active if it covers today, else Approved; overlap checked, C4), `suspend`\*, `reinstate`\*, `terminate`\*. \* reason required. Expired only by the daily job; Superseded never by hand. Returns `{status, eligibility}` | HR, SA scoped; not own; **approver ≠ creator and ≠ submitter (D-30)** | spec §4.2, D-29, D-30 |
| POST | `/api/v1/contracts/:id/documents` | Contract copy: raw PDF body, `X-File-Name`; ≤ 10 MB; magic bytes; malware scan — 422 `UPLOAD_INFECTED`, 503 `SCANNER_UNAVAILABLE`; a badly encoded `X-File-Name` — 400 `FILE_NAME_INVALID` (D1–D3) | HR, SA scoped; not own | D1–D3 |
| GET | `/api/v1/contracts/:id/documents` · `/:docId` | Versions · download (CLEAN only, audited, `nosniff`). A vault failure is never a partial file: 500 `DOCUMENT_INTEGRITY_FAILED` · `DOCUMENT_MISSING`, audited HIGH (D-53) | HR scoped; EMP own; **never SUP** (D5) | D4, D5 |
| POST | `/api/v1/contracts/:id/documents/:docId/link` | `{inline?: boolean = true}` → 201 `{url, expiresAt}`: a single-use link valid 60 s (D-53), after the same checks as a download; opened by a plain browser request | as download | D-53 |

### 2.7 Credentials (`modules/credentials`) — implemented in commit 6

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/credential-categories` · `/api/v1/credential-templates?includeInactive` | Catalog | EMP | spec §5.1 |
| POST · PATCH | `/api/v1/credential-templates`, `/:id` | Template admin (`nameAr` — PATCH `null` clears it — and `fieldDefs[].labelAr`, owner 2026-10-05; fields, `gracePeriodDays` 0–90, activity, `nationalityRule` `ALL`·`ONLY`·`EXCEPT` with `nationalityCodes` — owner decision 2026-10-04; 422 `NATIONALITY_RULE_INVALID` · `NATIONALITY_INVALID`) with `reason` (≥ 10). **202** `{status: PENDING_APPROVAL, requestId}` — applied only when a second system-wide admin approves via `/approvals/:id/approve` (D-24); break-glass → 201/200 `{status: APPLIED, template}`. Grace/expiry/activity changes re-evaluate holders; a nationality change re-evaluates every unit that requires the type | HR, SA — **system-wide scope only** (D-25) | spec §5.1, §6.1.1, R10 |
| POST · PATCH | `/api/v1/credential-categories`, `/:code` | Create / change a category `{code, name, description?, displayOrder, reason ≥ 10}` → **202** pending approval by a second system-wide admin (`CATEGORY_CHANGED_SINCE_REQUEST` if it changed meanwhile); break-glass → applied | HR, SA — **system-wide scope only** | **D-42** (P8) |
| GET | `/api/v1/credential-requirements?unitId&position&templateId` | Rules filtered to caller's units (out-of-scope `unitId` returns an empty list) | HR, SA, SUP — scoped | spec §5.1.4 |
| POST · PUT · DELETE | `/api/v1/credential-requirements`, `/:id` | Rule CRUD; re-evaluates the unit in the same transaction; `{affectedEmployees}` | HR (unit in scope), SA | spec §5.1.4 |
| POST | `/api/v1/credential-requirements/bulk` | `{items[]}` in one transaction → `{created, updated, affectedEmployees}` | HR (scoped), SA | spec §5.1.4 |
| GET | `/api/v1/credentials?employeeId&templateId&status&queue=review&identifier` | List (review queue = pending verification, staged renewal or pending document). `identifier`: exact Iqama, passport or SCFHS number (spaces and dashes ignored) through the blind index — HR scope only, audited `IDENTIFIER_SEARCHED` without the value (D-54). Sensitive fields are stored sealed and returned opened; `personalDataErased: true` when the employee's key was destroyed | HR/SA full (scoped); SUP compliance view (no tracking data, pending values or evidence) | spec §5.2, §8.1, §8.3 |
| GET | `/api/v1/credentials/:id` | One record, shaped by viewer | owner, HR/SA scoped, SUP scoped | spec §5.2 |
| POST | `/api/v1/credentials` · `/api/v1/credentials/me` | Record → PendingVerification; tracking data validated against template fields; sensitive fields sealed and indexed (D-54) — 409 `PROCESSING_NOT_REGISTERED` (no active lawful basis) · `PERSONAL_DATA_ERASED` | HR (scoped) · EMP own | spec §5.1.5, §8.3 |
| GET | `/api/v1/credentials/me` · `/me/requirements` | Own records · rules that apply to me; a type that does not apply to my nationality comes back `policyStatus: OPTIONAL`, `optionalByNationality: true` | EMP | spec §8.1 |
| POST | `/api/v1/credentials/:id/verify` `{documentId?}` | PendingVerification → Valid/ExpiringSoon/Expired by date; approves evidence | HR (scoped), not own | spec §5.2 |
| POST | `/api/v1/credentials/:id/suspend` · `/revoke` `{reason}` | L3; closes grace | HR (scoped), not own | spec §5.2 |
| POST · GET | `/api/v1/credentials/:id/scfhs-check` · `/scfhs-checks` | Check the licence with SCFHS now → `{checked, status, matched, discrepancies, action, logId, driver}` (422 `SCFHS_NOT_ENABLED` / `SCFHS_NO_NUMBER` / `SCFHS_ERASED`) · the last 20 checks, newest first. `POST /credentials` also returns `scfhs` (the check on submission) | HR (scoped) | spec §5.4, D-64 |
| POST | `/api/v1/credentials/:id/renewal` | Stage replacement data | EMP own, HR (scoped) | spec §5.2 |
| POST | `/api/v1/credentials/:id/renewal/approve` `{documentId?}` · `/renewal/reject` `{reason}` | Promote or discard; approval completes grace, rejection closes it | HR (scoped), not own | spec §5.2, §6.1.1 |
| POST | `/api/v1/credentials/:id/documents` | Raw body = file, `Content-Type` = its type, `X-File-Name`; PDF/JPEG/PNG/WebP, ≤ 10 MB, magic bytes must match; malware scan — 422 `UPLOAD_INFECTED`, 503 `SCANNER_UNAVAILABLE`; a badly encoded `X-File-Name` — 400 `FILE_NAME_INVALID` | EMP own, HR (scoped) | spec §5.1.5 |
| GET | `/api/v1/credentials/:id/documents` · `/:docId` | Versions · download (CLEAN only, audited, `nosniff`); vault failures as for contracts (D-53) | EMP own, HR (scoped); **never SUP** (D5) | spec §5.2, §5.3.2 |
| POST | `/api/v1/credentials/:id/documents/:docId/link` | `{inline?: boolean = true}` → 201 `{url, expiresAt}`: a single-use link valid 60 s (D-53), after the same checks as a download; opened by a plain browser request | as download | D-53 |
| GET | `/api/v1/files/:token/:fileName` | Redeems a link once: the file, `inline` or `attachment` as issued, with `Content-Security-Policy: default-src 'none'`, `nosniff`; audited as a download (`via: link`) by the user it was issued to. Used, expired, unknown, or the user deactivated → 404 `LINK_INVALID`. The token and file name never reach the logs | public (the token is the credential) | D-53 |

### 2.8 Eligibility (`modules/eligibility`) — implemented in commit 6

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/eligibility?unitId&status` | Materialized states with reasons | HR, SA, SUP (scoped) | spec §6.1 |
| GET | `/api/v1/eligibility/me` · `/:employeeId` | One stored state | EMP own; HR, SUP (scoped) | spec §6.1 |
| GET | `/api/v1/eligibility/:employeeId/evaluate?date=YYYY-MM-DD` | Live engine result for a day, not stored (the path publication will use, L7) | HR, SA, SUP (scoped) | spec §6.1 |
| POST | `/api/v1/eligibility/:employeeId/refresh` | Recalculate and store one nurse | HR, SA (scoped) | spec §6.1 |
| GET · POST | `/api/v1/waivers?employeeId&active`, `/api/v1/waivers` | List / create `{employeeId, templateId, reason, expiresAt}` (≤ 72 h, HIGH audit) | read HR, SA, SUP; **create SUP or HR only** (spec §6.1.2 — System Admin gets 403), scoped, not own | spec §6.1.2 |

### 2.9 Scheduling (`modules/scheduling`) — implemented in commit 8

Eligibility in every response is the **live engine for the shift date** (L7), not the stored snapshot. A nurse is scheduled only in their **home unit** (D-32). Windows are 1–94 days (S6).

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/roster?unitId&from&to` | Board: non-cancelled assignments with live eligibility, and coverage per date × shift | HR, SA, SUP, NA, ND — unit in scope (read) | spec §6.2 |
| GET | `/api/v1/roster/me?from&to` | Own published shifts (any unit) + home-unit published schedule with notes (S2) | EMP | spec §6.2 |
| GET | `/api/v1/roster/pool?unitId&date&shiftType` | Home-unit candidates not already in that slot, ranked by live eligibility, with their other shifts that day | SUP — unit in scope | spec §6.1 |
| POST | `/api/v1/shift-assignments` | `{employeeId, unitId, shiftDate, shiftType, notes?}` → Draft (+ live eligibility). Refused: other unit (`NOT_HOME_UNIT`), past date, same slot twice (S1, `SHIFT_SLOT_TAKEN`) | **SUP, NA** — unit in scope (D-14, D-71) | S1 |
| DELETE | `/api/v1/shift-assignments/:id` | Draft → deleted; Published → Cancelled with body `{reason}` (HIGH audit) | SUP, NA — unit in scope | spec §6.2 |
| POST | `/api/v1/roster/auto-generate` | `{unitId, from, to, dryRun=true}`: drafts up to each configured target from eligible home-unit nurses; unset targets reported (D-16); at most one auto-filled shift per nurse per day; fewest shifts first | SUP, NA — unit in scope | V03 board (formula removed) |
| GET | `/api/v1/roster/approvals?unitId&status?` | Approval requests for the unit, newest first (max 100): `{items[{id, unitId, from, to, status, requestedBy, requestedAt, decidedBy, decidedAt, note}], total}`. Status is `Pending`, `Approved`, `Rejected` or `Withdrawn` | HR, SA, SUP, NA, ND — unit in scope (read) | D-71 |
| POST | `/api/v1/roster/approvals` | `{unitId, from, to}` → 201 `{id, status: 'Pending', drafts}`. Refused: no drafts in the window (`NOTHING_TO_APPROVE`), a Pending or Approved request already touches these dates (`APPROVAL_EXISTS`) | SUP, NA — unit in scope | D-71 |
| POST | `/api/v1/roster/approvals/:id/decision` | `{decision: 'approve'\|'reject', note?}` (a rejection needs `note`, ≥ 5 characters) → `{id, status}`. Refused: own request (`SELF_APPROVAL_FORBIDDEN`), already decided or withdrawn (`NOT_PENDING`), unit outside scope. HIGH audit `ROSTER_APPROVED` / `ROSTER_REJECTED` | ND — unit in scope | D-71 |
| POST | `/api/v1/roster/publish` **[I]** | `{unitId, from, to}` → needs one Approved request covering every date (`APPROVAL_REQUIRED` otherwise); any draft created, removed or auto-generated in a Pending or Approved window withdraws that request (audit `ROSTER_APPROVAL_WITHDRAWN`). One transaction, per-unit advisory lock; each draft re-validated (L7, S3); ineligible stays Draft with reasons → `{published, blocked[], reliedOnGraceOrWaiver[]}`; reliance also stored as `eligibilityAtPublish` and in the HIGH audit (L8) | SUP, NA — unit in scope | spec §6.2, D-71 |
| GET | `/api/v1/coverage?unitId&from&to` | Per date × shift: target (`null` = unspecified), draft and published `{total, eligible}`, `publishedShortage` (warning only, S4) | HR, SA, SUP — scoped | spec §6.3 |
| — | Revalidation (no endpoint) | Every eligibility refresh (credential, contract, position, requirement, waiver, unit move, deletion) re-checks the nurse's future published shifts; an invalid one returns to Draft, HIGH audit `ASSIGNMENT_DEMOTED`, COVERAGE notice to the unit's supervisors | — | spec §6.2 |

### 2.10 Attendance (`modules/attendance`) — implemented in commit 8 (read side)

| Method | Endpoint | Purpose | Permission | Source |
| :--- | :--- | :--- | :--- | :--- |
| POST | `/api/v1/attendance/events` | Badge events from the badge system (PACS): `{events: [{jobNumber, type: CLOCK_IN\|CLOCK_OUT\|BREAK_START\|BREAK_END, at (ISO 8601 with offset), deviceId?, location?}]}`, 1–1000 per batch → `{received, accepted, duplicates, rejected: [{index, reason}]}`. Each event judged alone (`UNKNOWN_JOB_NUMBER`, `EMPLOYEE_DELETED`, `IN_THE_FUTURE` > 5 min, `TOO_OLD` > 7 days, `INVALID`); idempotent — a resent event is a duplicate. Stored with source `client:<client id>` | An API client with the `attendance.ingest` scope (D-63 token) — no person | spec §14.2, **D-65** (our format until the PACS contract, B-15) |
| GET | `/api/v1/attendance/events?employeeId\|unitId&from&to` | Clock events (≤ 94 days) | HR, SA, SUP — scoped | spec §14.2 |
| GET | `/api/v1/attendance/me?from&to` | Own clock events | EMP | spec |
| GET | `/api/v1/attendance/gaps?unitId&date` | Published shifts of a unit/date vs clock-ins: `UPCOMING`, `PENDING`, `MISSING` (no clock-in from **30 min before** the start — D-38 — and **30 min** passed since the start), `PRESENT`, `INELIGIBLE_ON_DUTY` (clocked in, engine blocks today). Shift times from D-31 | HR, SA, SUP — scoped | spec §14.2 (30 min; the earlier "15 min" in this map was wrong); response has `gapMinutes`, `earlyClockInMinutes` |

### 2.11 Notifications, audit and jobs — implemented in commit 9

| Method | Endpoint | Purpose | Permission | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/notifications?unread&page&pageSize` | Own notifications with the unread count; `announcementId` on an announcement (D-69) | EMP (own only, N2) | spec §7.1 |
| POST | `/api/v1/notifications/:id/read` · `/read-all` | Acknowledge own; another user's id is 404 | EMP (recipient only) | spec §7.1 |
| GET | `/api/v1/audit?resource&resourceId&actor&action&priority&from&to&page` | Search, newest first; BIGINT ids as strings; actor names resolved | **SA only (D-20)** | spec §9.1 |
| GET | `/api/v1/pdpl/register` | Processing register (spec §8.3.2, D-54): lawful basis, purpose, retention per sensitive category → `{items[{id, dataCategory, lawfulBasis, purpose, retentionRule, isActive, updatedAt}]}` | HR, SA | D-54 |
| POST · PATCH | `/api/v1/pdpl/register` · `/:id` | Add an entry `{dataCategory, lawfulBasis, purpose, retentionRule, reason}` · change `{purpose?, retentionRule?, isActive?, reason}`; audited HIGH. A category with no active entry cannot be recorded (409 `PROCESSING_NOT_REGISTERED`) | SA (`pdpl.manage`) | D-54 |
| GET · POST | `/api/v1/pdpl/register/sign-offs` | DPO sign-offs of the register (B-18, D-56): history `{items[{id, reviewedBy, title, note, reviewedAt, register[]}]}` · record one `{title, note?, confirm: true}` — the register as it stands is kept with it; audited HIGH. `GET /pdpl/register` also returns `signOff {last, changedSince, dueAt, due}` | HR, SA (`pdpl.read` · `pdpl.signoff`) | D-56 |
| GET · POST | `/api/v1/pdpl/requests/me` | Own data-subject requests (spec §8.3.3, D-55) · make one `{type: ACCESS\|PORTABILITY\|RECTIFICATION\|ERASURE, details?}` (RECTIFICATION needs `details` ≥ 10 characters). Each item: `{id, type, status, details, employee, requestedBy, requestedAt, reviewedBy, decidedBy, decidedAt, decisionNote, completedAt, dueAt, overdue, exportAvailable, exportExpiresAt, erasure{keyDestroyedAt, backupsExpireAt, documentsErased}\|null}`. 409 `REQUEST_ALREADY_OPEN` · 404 `NO_EMPLOYEE_RECORD` | EMP own | D-55 |
| GET | `/api/v1/pdpl/requests/me/:id/export` · `/api/v1/pdpl/requests/:id/export` | The personal-data package (JSON attachment) of a completed ACCESS / PORTABILITY request, for 30 days after approval; audited HIGH `PERSONAL_DATA_EXPORTED`. 409 `EXPORT_NOT_AVAILABLE` | EMP own · HR, SA (scoped) | D-55 |
| GET · POST | `/api/v1/pdpl/requests?open=true&status&type` · `/api/v1/pdpl/requests` | The queue within HR scope · log a request received outside the application `{employeeId, type, details?}` | HR, SA (`pdpl.requests`) | D-55 |
| POST | `/api/v1/pdpl/requests/:id/review` · `/approve` `{note?}` · `/reject` `{note}` · `/complete` `{note}` | Take into review · approve (ACCESS/PORTABILITY → COMPLETED, package ready; RECTIFICATION → APPROVED) · decline with a reason · complete a correction. Never on one's own request (403 `SELF_REVIEW_FORBIDDEN`); ERASURE is not approved here (409 `ERASURE_NEEDS_SYSTEM_ADMIN`) | HR, SA (`pdpl.requests`, scoped) | D-55 |
| POST | `/api/v1/pdpl/requests/:id/erase` | Approve an erasure `{note, confirmJobNumber}`: key destroyed, number-search rows and identity scans removed, evidence recorded; audited HIGH `PERSONAL_DATA_ERASED`. 403 `FOUR_EYES_REQUIRED` (you logged it) · 422 `CONFIRMATION_MISMATCH` · 409 `ALREADY_ERASED`. An erased document then answers 410 `PERSONAL_DATA_ERASED` | SA (`pdpl.erase`) | D-55 |
| GET | `/api/v1/audit/requests` | Request-level forensic log (spec §9.2, D-52), newest first: `?from&to` (Riyadh dates), `actor`, `requestId`, `method`, `status` (`4xx` or `403`), `path` (contains), `errorCode`, `page`, `pageSize` ≤ 200 → `{items[{id (string), requestId, at, actorUserId, actorName, actorRoles, sessionFamily, method, path, statusCode, durationMs, ipAddress, userAgent, paramsHash, errorCode}], total}` | SA | spec §9.2 |
| GET | `/api/v1/audit/verify` | Chain check (`audit_chain_breaks` view: link and content) | SA | spec §9.1, A3 |
| GET | `/api/v1/admin/jobs` | Jobs, schedules and last 10 runs each | SA | plan "Jobs" |
| GET | `/api/v1/system/health/business` | Business health: `{status: HEALTHY \| ATTENTION, issues[], eligibility {lastAuditAt, lastChecked, lastDrifted, checked7d, drifts7d, driftRate7d, recentDrifts[]}, jobs[] {lastCompletedAt, ageMinutes, stale, lastAttemptFailed}, email {pendingOver15Minutes, failedLast24Hours, lastSentAt}, pdpl {unprotectedValues, overdueRequests, signOff}, keys {previousConfigured[], employeeKeysOnOldKey, searchRowsOnOldPepper}}` | SA (`jobs.read`) | spec §10.8 |
| POST | `/api/v1/admin/jobs/:name/run` | Run now under its own run key (never consumes the scheduled period); HIGH audit | SA | plan "Jobs" |
| GET · POST · POST · DELETE | `/api/v1/dev-console/badge-simulator` · `/events` `{jobNumber, type, at?}` · `/shift` `{unitId, date?, shiftType, leaveOut}` · `/events` | Simulated badge events `{enabled, recent, total}` · one swipe · clock-ins for a unit's published shift, `leaveOut` nurses chosen at random left out (→ MISSING); 409 `SHIFT_NOT_STARTED` before the 30-minute early window · delete every simulated event. Source `simulator`, audited HIGH; 409 `BADGE_SIMULATOR_OFF` when off | SA (elevated) | D-65 |
| GET · PUT · DELETE | `/api/v1/dev-console/scfhs-registry` · `/:registrationNumber` `{status, expiryDate?, specialty?, note?}` | The simulated SCFHS registry `{driver, items}` · set an entry (VERIFIED, EXPIRED, SUSPENDED, REVOKED, or ERROR for an outage) · remove it (audited, number masked) | SA (elevated) | D-64 |
| POST | `/api/v1/dev-console/telegram-inbox/simulate` | Mock driver only: handle `{chatId, text}` as if that chat sent it to the bot (e.g. `/start <token>`); 409 `TELEGRAM_LIVE` otherwise; audited | SA (elevated) | D-66 |
| GET · POST · DELETE | `/api/v1/me/telegram` · `/me/telegram/link` · `/me/telegram` | Own Telegram connection `{linked, linkedAt, botUsername, driver, available}` · new single-use link `{url, startParameter, expiresAt}` (15 min; replaces open ones; 403 for break-glass) · disconnect (409 `TELEGRAM_NOT_LINKED`) | Signed in (own account) | D-66 |
| GET · POST · DELETE | `/api/v1/me/email` | Own sign-in e-mail `{email, pending, available}` · request a change `{newEmail, currentPassword}` → 202 `{pendingEmail, expiresAt}` (400 `CURRENT_PASSWORD_WRONG` · `EMAIL_UNCHANGED`; 409 `EMAIL_IN_USE` · `EMAIL_OFF`; 403 for break-glass; 429 with the sign-in limit) · cancel the waiting change (409 `EMAIL_CHANGE_NONE`) | Signed in (own account) | D-67 |
| POST | `/api/v1/users/:id/email` | Start a sign-in e-mail change for an account in scope `{newEmail}` → 202; the link goes to the new address (403 `SELF_ACTION_FORBIDDEN` · `BREAK_GLASS_ACCOUNT_PROTECTED`; 409 `ACCOUNT_INACTIVE` · `EMAIL_IN_USE` · `EMAIL_OFF`) | HR, SA (`accounts.write`) | D-67 |
| POST | `/api/v1/auth/email-change/confirm` | **Public.** `{token}` from the link in the new mailbox → `{email}`; switches the e-mail and signs out every session (400 `EMAIL_CHANGE_INVALID`; 409 `EMAIL_IN_USE` if taken meanwhile; Origin check; throttled) | — | D-67 |
| POST | `/api/v1/users/:id/telegram/link` | A link for an account in scope, to show the person (never break-glass; 409 `ACCOUNT_INACTIVE`) | HR, SA (`accounts.write`) | D-66 |
| POST | `/api/v1/telegram/webhook` | **Public.** Telegram's updates when `TELEGRAM_UPDATES=webhook`; `X-Telegram-Bot-Api-Secret-Token` must match `TELEGRAM_WEBHOOK_SECRET` (401 otherwise, 404 when the webhook is off); always 200 once accepted | Telegram | D-66 |
| GET · POST | `/api/v1/dev-console/telegram-inbox?limit` · `/test` | Messages the mock Telegram gateway intercepted, newest first `{driver, items, total}` · send a test message `{chatId, message}` → `{accepted, messageId, driver}` (audited, chat id masked; 502 `TELEGRAM_NOT_ACCEPTED`) | SA (elevated) | D-66 |
| GET | `/api/v1/eligibility/logic` · `/:version/findings?decision=undecided\|approved\|rejected\|all&page&pageSize` | Shadow mode (spec §10.9): versions, the one in shadow with its promotion state · its disagreements within scope | HR, SA | D-60 |
| POST | `/api/v1/eligibility/logic/findings/:id/decision` `{decision: APPROVED\|REJECTED, note}` · `/:version/promote` `{reason}` · `/:version/retire` `{reason}` | Decide a disagreement (final) · promote when §10.9 allows (every nurse recalculated) · retire the version in shadow; audited HIGH | HR (system-wide) | D-60 |

**Scheduled jobs** (`backend/src/jobs/`; in the API process when `JOBS_MODE=in-process`, in `npm run worker` when `worker`). Each run is a unique `job_runs.run_key`, taken under a worker lease (spec §10.3):

| Job | When (Asia/Riyadh) | Does | Source |
| :--- | :--- | :--- | :--- |
| `daily-transition` | 00:05 daily (catches up if missed) | Contracts Approved→Active / →Expired; stored credential status by date; closes ended grace windows (HIGH audit + HR notice); removes expired PAM; ends expired break-glass; purges spent idempotency keys; re-evaluates every live nurse (demotes invalid future published shifts; TRANSITION policy notice) | spec §6.1, §6.1.1, §6.1.1.1, §6.2, §5.2, R13, R18 |
| `expiry-scan` | 06:00 daily | Credentials at 60 / 30 / 14 / 7 days, contracts at 90 / 30 / 14 / 7 days before the last valid day, both once expired (current milestone only). Credentials → employee; + unit Supervisor from 14; + scoped HR from 7. Contracts → employee + scoped HR from 90; + Supervisor from 14; none once a later contract is Approved/Active. Key = record + expiry date + milestone | spec §7.1 (N1, N3, N4); **D-39 overrides N2** |
| `attendance-alerts` | every 15 minutes | Shifts under way: not clocked in 30 min after the start, or clocked in while ineligible → CRITICAL notice to the unit's supervisors, once per assignment | spec §14.2 |

### 2.11a Announcements (`modules/announcements`, D-69)

Memos, meeting schedules and seminar notices. Plan and owner decisions: [ANNOUNCEMENTS_PHASE1_PLAN.md](ANNOUNCEMENTS_PHASE1_PLAN.md). Body fields: `kind` (MEMO · MEETING · SEMINAR), `title` (≤ 150), `body` (≤ 5000), `titleAr`, `bodyAr`, `referenceNo`, `startsAt`, `endsAt`, `location`, `onlineUrl` (https), `speaker`, `ceHours`, `priority` (LOW · MEDIUM · HIGH — High for memos only), `audienceType` (HOSPITAL · DEPARTMENT · UNIT · PEOPLE), `audienceIds`, `roleFilter`, `positionFilter`, `specialtyFilter`, `expiresAt` (default: 30 days for a memo, the day after the event otherwise).

| Method | Endpoint | Purpose | Permission | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/announcements?state=active\|archived&kind&page&pageSize` | The board: published announcements addressed to me, by board date | EMP (recipient only) | D-69 |
| GET | `/api/v1/announcements/:id` | Detail with `canCancel`; 404 unless recipient, sender, or a manager covering the audience | EMP | D-69 |
| GET | `/api/v1/announcements/sent?status` | My own, every status | HR, SUP, SA | D-69 |
| GET | `/api/v1/announcements/managed` | Every sent announcement whose audience my HR scope covers (newest 200) | HR, SA | D-69 |
| GET | `/api/v1/announcements/people?q` | Accounts I may pick by name (HR or Supervisor scope): `{items[{id, displayName, jobNumber, unitName}]}` | HR, SUP, SA | D-69 |
| POST | `/api/v1/announcements` | Create a draft → the announcement + `needsApproval`. Refused outside the sender's scope (`SCOPE_NOT_COVERED`), on a wrong shape (`ANNOUNCEMENT_INVALID`) or unknown recipients/filters (`AUDIENCE_INVALID`) | HR, SUP, SA | D-69 |
| PATCH · DELETE | `/api/v1/announcements/:id` | Change or delete one's own draft (409 `ANNOUNCEMENT_NOT_DRAFT` otherwise) | HR, SUP, SA | owner Q4 |
| POST | `/api/v1/announcements/:id/preview` | `{recipients, telegramLinked, emailOnly, needsApproval, emailsQueued, emailEtaMinutes, emailHourlyLimit}` | HR, SUP, SA | D-69 |
| POST | `/api/v1/announcements/:id/submit` [I] | Supervisor to own units, or break-glass → `{id, status: PUBLISHED}`; any other → `{id, status: PENDING_APPROVAL, approvalRequestId}` (Approvals, action type `ANNOUNCEMENT_PUBLISH:<id>`). `NO_RECIPIENTS`, `EVENT_IN_PAST`, `ANNOUNCEMENT_EXPIRED` | HR, SUP, SA | owner Q1–Q2 |
| POST | `/api/v1/announcements/:id/cancel` | `{reason ≥ 10}` → `{id, status: CANCELLED, emailsStopped, telegramStopped}`: undelivered e-mail and Telegram rows become SKIPPED | HR, SUP, SA (sender, or manager in scope) | D-69 |

Publication writes one `notifications` row per recipient account (type `ANNOUNCEMENT`, e-mail button → `/announcements?id=:id`, Telegram prompt without content) and one `email_outbox` row per contact address of staff without an account (no link). Approve / reject / withdraw go through `/api/v1/approvals/:id/…` (§2.3).

### 2.12 Interoperability — FHIR R4 (`modules/interop`, D-61)

FHIR R4 (4.0.1) read API for the hospital's other systems (spec §14.1). Responses are `application/fhir+json`; route errors are `OperationOutcome` (404 `not-found`, 410 `deleted`, 400 `not-supported`, 403 `forbidden` for a scope the client's token lacks); authentication errors keep the API's own shape. Two kinds of caller: **another system** with a client token (D-63, below), which reads every nurse within its scopes; or a signed-in HR or System Admin, who reads within their scope — a nurse outside it reads as not found. Checked by the HL7 validator in CI (spec §11.3).

| Method | Endpoint | Returns | Permission |
| :--- | :--- | :--- | :--- |
| GET | `/api/v1/fhir/metadata` | `CapabilityStatement` | `fhir.read` (HR, SA) · any client |
| GET | `/api/v1/fhir/Practitioner/:id` | Job number (`http://aigh.sa/job-number`), name, work e-mail, verified current licences as `qualification` (SCFHS number as the identifier, `http://scfhs.org.sa/registration`) | `fhir.read` · scope `system/Practitioner.read` |
| GET | `/api/v1/fhir/PractitionerRole/:id` | Position (`code`), unit (`specialty`), the contract covering today (`period`; `active` only while one does) | `fhir.read` · scope `system/PractitionerRole.read` |
| GET | `/api/v1/fhir/Practitioner?identifier=[system\|]<job number>` · `/api/v1/fhir/PractitionerRole?practitioner=Practitioner/<id>` | `Bundle` (searchset); an identifier over 300 characters — 400 `invalid` | as the resource |

The ids are the employee id for both resource types. The spec's example puts qualifications on `PractitionerRole`; R4 has no such element, so licences are `Practitioner.qualification`.

**Other systems — OAuth 2.0 client credentials (D-63).** A System Admin registers the system under Nursing Administration → API clients and hands over its client id and secret (shown once) over a secure channel. The system then:

```bash
curl -s -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials https://nurse.<hospital-domain>/api/v1/fhir/token
# → {"access_token":"…","token_type":"Bearer","expires_in":900,"scope":"system/Practitioner.read system/PractitionerRole.read"}
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" "https://nurse.<hospital-domain>/api/v1/fhir/Practitioner?identifier=J-1001"
```

| Method | Endpoint | Purpose | Permission |
| :--- | :--- | :--- | :--- |
| POST | `/api/v1/fhir/token` | `application/x-www-form-urlencoded`: `grant_type=client_credentials`, optional `scope` (space-separated, a subset of the client's); credentials in HTTP Basic or as `client_id` / `client_secret`. Errors per RFC 6749 §5.2: 400 `invalid_request` / `unsupported_grant_type` / `invalid_scope`, 401 `invalid_client`; 429 with `Retry-After` after repeated failures | public (the credentials) |
| GET | `/api/v1/api-clients` | Registered clients (never the secret) | `apiclients.manage` (SA) |
| POST | `/api/v1/api-clients` | `{name, scopes?}` → `{client, clientSecret}` — the only time the secret is returned | `apiclients.manage` |
| POST | `/api/v1/api-clients/:id/secret` | New secret → `{client, clientSecret}`; the old secret and every token under it stop at once | `apiclients.manage` |
| POST | `/api/v1/api-clients/:id/revoke` | Permanent; its tokens stop at once | `apiclients.manage` |

A client token is accepted only on `GET /api/v1/fhir/*` (401 anywhere else, 403 for other methods) and lasts 15 minutes: request a new one when it expires.

### 2.13 Removed from V03

| Removed | Replaced by |
| :--- | :--- |
| `GET /api/bootstrap` | Per-module list endpoints with scope + field filtering |
| `GET/POST/PUT/DELETE /api/:entity[/:id]` (all 47 routes) | Domain endpoints above |
| Hard `DELETE` of employees/contracts/units | Soft delete / deactivate / status transitions |
| localStorage roles mock | `/api/v1/role-assignments`, `/api/v1/approvals` |

Scheduled jobs (no HTTP): contract/credential daily scan (N1), credential status transition by date, contract Active → Expired by end date, eligibility daily transition (L6), grace expiry (L8), waiver expiry, role-assignment expiry (R5), PAM expiry (R13), idempotency cleanup. Each runs under a worker lease.

## Appendix A — V03 API (historical)

Kept from the stage-1 analysis for traceability; none of these endpoints exists in V04.

### A.0 Current state (V03)

### A.1 Running API — `server/src/index.ts` (Express, port 3001, prefix `/api`)

| Method | Endpoint | Purpose | Auth | Permission | Request | Response | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| GET | `/api/health` | DB liveness | none | — | — | `{status, db}` / 503 | |
| POST | `/api/auth/login` | Password login | none | — | `{email, password}` | `{user, token, csrfToken, expiresIn}` + refresh/CSRF cookies | No rate limit; email only |
| POST | `/api/auth/refresh` | Rotate refresh, new access token | refresh cookie | Origin + CSRF double-submit | — | same as login | Reuse → family revoked |
| POST | `/api/auth/logout` | Revoke session | refresh cookie | none | — | 204 | Not CSRF-checked (low risk: only revokes) |
| GET | `/api/auth/me` | Current identity | Bearer | any | — | `{user}` | |
| GET | `/api/bootstrap` | **Every row of 12 tables** | Bearer | any authenticated | — | `{departments, units, …, auditEntries}` | Exposes salaries, contact emails, all credentials to EMPLOYEE role (violates R15/R16) |
| GET | `/api/:entity` | List a table | Bearer | any authenticated | — | array | 12 entities: departments, units, positions, employees, contracts, credential-categories, credential-templates, credential-requirements, credentials, shift-assignments, notifications, audit-entries |
| POST | `/api/:entity` | Create row | Bearer | HR_ADMIN, SYSTEM_ADMIN, DEVELOPER | raw model JSON | row | No validation, no business rules, client-supplied ids. 405 for notifications/audit-entries |
| PUT | `/api/:entity/:id` | Update row | Bearer | same | partial JSON | row | Any column, incl. `status`, `salary`, `deletedAt` |
| DELETE | `/api/:entity/:id` | Hard delete row | Bearer | same | — | 204 | Hard delete, whereas the UI soft-deletes |

**Effective route count:** 5 fixed + 12 list + 30 write routes (10 writable entities × 3). Prisma error codes map to 404/409/400; internal errors never echo messages (keep this).

### A.2 Reference API — `backend/` (NestJS, port 3000, never running)

| Method | Endpoint | Purpose | Permission |
| :--- | :--- | :--- | :--- |
| GET | `/api/v1/roles/matrix` | Static role matrix | authenticated |
| GET | `/api/v1/roles/me` | Own assignments + effective roles | authenticated |
| GET | `/api/v1/roles/assignments?userId&role&scopeType&isActive&unitId` | List assignments | HR_ADMIN, SYSTEM_ADMIN (+PAM) |
| GET | `/api/v1/roles/assignments/:id` | One assignment (implemented by filtering the full list) | same |
| POST | `/api/v1/roles/assignments` + `Idempotency-Key` | Grant → 201, or 202 PENDING_APPROVAL | same |
| PATCH | `/api/v1/roles/assignments/:id` | Change scope/reason/expiry; → SYSTEM needs approval | same |
| DELETE | `/api/v1/roles/assignments/:id` `{reason}` | Revoke | same |
| GET | `'/../admin/approvals'` *(malformed path)* | Pending approvals | same |
| POST | `'/../admin/approvals/:id/approve'`, `/reject` | Four-eyes decision | same |
| POST | `'/../admin/pam/elevate'`, GET `/status` | PAM | SYSTEM_ADMIN |

### A.3 Reference API — `wave1a-kit/` (NestJS, never running)

| Method | Endpoint | Purpose | Permission |
| :--- | :--- | :--- | :--- |
| GET | `/api/v1/units?departmentId&includeInactive` | List units | authenticated |
| GET | `/api/v1/units/summary` | Totals by department | authenticated |
| PUT | `/api/v1/units/bed-capacity/bulk` + `Idempotency-Key` | Bulk bed update | HR_ADMIN, SYSTEM_ADMIN |
| POST | `/api/v1/units/import` + `Idempotency-Key` | CSV import, dry-run default | HR_ADMIN, SYSTEM_ADMIN |
| PUT | `/api/v1/units/:id/bed-capacity` | Single update | HR_ADMIN, SYSTEM_ADMIN |
| GET | `/api/v1/units/:id/bed-history` | Bed log | HR_ADMIN, SYSTEM_ADMIN, SUPERVISOR |

### A.4 Specified but never implemented (spec v2.8.7)

`/api/v1/positions` (CRUD), `/api/v1/departments`, `/api/v1/credential-templates` (CRUD), `/api/v1/credential-categories` (CRUD), `/api/v1/credential-requirements` (CRUD + `/bulk`), `/api/v1/workforce/onboard`, `/api/v1/workforce/invitations`, `/api/v1/workforce/publish`, evidence `/:evidenceId/download`, `/api/v1/auth/register`, `/api/v1/push/register|unregister|devices`, `/api/v1/fhir/Practitioner/:id` and `/api/v1/fhir/PractitionerRole/:id` (built in V04, §2.12). Tracker B-23 records a route disagreement (`/api/v1/positions` vs `/api/v1/workforce/positions`).

### A.5 Duplicates and conflicts

| Issue | Detail |
| :--- | :--- |
| Two prefixes | Running `/api/…` vs spec/reference `/api/v1/…` |
| Two unit APIs | Generic `PUT /api/units/:id` (running) vs `/api/v1/units/*` (kit) |
| Generic vs domain | Every write goes through generic CRUD, so business rules (onboarding atomicity, overlap, publication gate, waiver limits) can be bypassed by calling the API directly |
| Mock API | `app/src/lib/api/roles.api.ts` simulates the NestJS roles API in localStorage |

---
