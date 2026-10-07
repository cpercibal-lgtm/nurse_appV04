# Database architecture

PostgreSQL 15 is the system of record for **all hospital data**. The application code holds business rules, workflows, validation and the user interface; it holds no hospital data. The schema is [`backend/prisma/schema.prisma`](../backend/prisma/schema.prisma), and it changes only through a migration in [`backend/prisma/migrations/`](../backend/prisma/migrations/).

How data gets into an empty database — bootstrap, hospital baseline import, day-to-day screens — is in [§7](#7-how-data-enters-the-database); how the system moved here from a TypeScript seed is in [DATABASE_MIGRATION.md](DATABASE_MIGRATION.md). The consolidation that produced the original schema from V03's four sources is recorded in [history/DATABASE_CONSOLIDATION.md](history/DATABASE_CONSOLIDATION.md).

## 1. Conventions

- Tables and columns are `snake_case` (`@@map` / `@map`); Prisma models are `PascalCase`.
- Ids are integer auto-increment (D-8).
- **Timestamps** are `timestamptz` and every connection pins `TimeZone=UTC` (`lib/prisma.ts`). Prisma 7's pg adapter sends dates without an offset, so a server in another time zone would otherwise store them shifted; a regression test forces an Asia/Riyadh connection.
- **Calendar dates** (shift, contract, credential dates) are `date` columns and are compared as Asia/Riyadh days. The expiry or end date is the **last valid day**.
- Umm al-Qura Hijri equivalents are stored beside contract and credential dates (`YYYY-MM-DD`, shape-checked); the Gregorian date is authoritative.
- Soft delete: `employees.deleted_at`. No other business table deletes rows.

## 2. Data domains (28 tables)

| Domain | Kind of data | Tables | Who changes it |
| :--- | :--- | :--- | :--- |
| **Hospital master data** | The hospital's own structure and catalogue | `departments`, `units` (with `bed_count` and KPI `critical_area`), `bed_capacity_logs`, `positions` (with `replaced_by`), `coverage_targets`, `credential_categories`, `credential_templates`, `credential_template_fields` | Hospital-wide HR / System Admin (structure, catalogue — catalogue changes need a second administrator); unit-scoped HR for beds and coverage targets. Initially through the [baseline import](#7-how-data-enters-the-database) |
| **Credential policy** | Which credential each unit/position requires | `credential_requirements`; grace days on `credential_templates` | HR / System Admin with the unit in scope. Not seeded: it is the hospital's policy (U2) |
| **Workforce (operational)** | People and their records | `employees`, `contracts`, `credentials`, `document_versions`, `credential_waivers`, `eligibility_states`, `shift_assignments`, `attendance_events` | HR, Supervisors and employees through the application, under the rules in [WORKFORCE.md](WORKFORCE.md) and [CLINICAL_ELIGIBILITY.md](CLINICAL_ELIGIBILITY.md) |
| **Access** | Accounts and their rights | `users`, `role_assignments`, `approval_requests`, `privileged_sessions`, `refresh_sessions`, `break_glass_events` | The bootstrap (first two administrators), then administrators through the application ([RBAC.md](RBAC.md)) |
| **Platform** | Evidence and plumbing | `audit_entries`, `notifications`, `idempotency_keys`, `worker_leases`, `job_runs`, `login_throttle`, `email_outbox` | The application only |
| **Communication** | Announcements to staff (D-69) | `announcements` (recipients are `notifications` and `email_outbox` rows) | HR Admin, Supervisor and elevated System Admin through the application; HR / System Admin sends approved by a second administrator |

**System configuration stays in code**, because it is logic, not hospital data, and changing it must go through code review and tests: the roles (`AppRole` enum), the permission table (`permissions.ts`, checked against [RBAC.md](RBAC.md)), workflow states (enums), shift times (`config/shifts.ts`), position tiers (spec §3.1.1) and the onboarding default position of rule E6. Decision P2 of the migration plan.

**Test and demo data** never lives in the schema or a migration: it is a fixture under `backend/test/fixtures/` ([§7](#7-how-data-enters-the-database)).

### Key relationships

- `units.department_id` → `departments`; `employees.unit_id` → `units` (**nullable = Unassigned** — no magic id 0); `employees.position_code` → `positions.code`; `positions.replaced_by` → `positions.code` (a deprecated position names its successor; never itself).
- `credential_templates.category_code` → `credential_categories.code`; `credential_template_fields.template_id` → `credential_templates` (one row per tracked field, ordered by `ordinal`, unique `key` per type); `credential_requirements` → template, unit and optional position.
- `contracts`, `credentials`, `credential_waivers`, `shift_assignments`, `attendance_events`, `eligibility_states` → `employees`; `document_versions` → a contract **or** a credential (exactly one).
- `users.employee_id` → `employees` (optional); `role_assignments` → `users` (assignee, granter, revoker) and optionally the `approval_requests` row that authorised it.
- Records are referenced by **business code** in imports and APIs (`department.code`, `unit.code`, `position.code`, `credential_templates.code`, `employee.job_number`), never by name or e-mail.
- History is never destroyed: master records are deactivated (`is_active`) rather than deleted; employees are soft-deleted (`deleted_at`); audit rows and break-glass events cannot be deleted at all.

## 3. Constraints the database enforces

Prisma cannot express these, so they are hand-written in migration SQL. They are the last line of defence: each service checks the same rule first and returns a readable error, but a bug or a direct SQL write still cannot break them. `backend/test/database-constraints.test.ts` proves the important ones.

| Rule | Constraint | Migration |
| :--- | :--- | :--- |
| C4: no overlapping Approved/Active contracts per employee (inclusive dates) | `no_overlapping_active_contracts` (exclusion, `btree_gist`) | `init` |
| C5: contract end after start | `chk_contracts_dates` | `init` |
| Hijri date shape | `chk_contracts_hijri_shape`, `chk_credentials_hijri_shape` | `init` |
| W4: beds 0–500 | `chk_units_bed_count` | `init` |
| W8: coverage minimum ≥ 0 | `chk_coverage_targets_minimum` | `init` |
| E7: salary ≥ 0 | `chk_employees_salary` | `init` |
| E1: job number unique regardless of case | unique index on `lower(job_number)` | `init` |
| E3: full name derived from first + middle + last, never typed | trigger `trg_employees_compose_full_name` | `init` |
| D-35: phones in E.164 | `employees_primary_phone_e164`, `employees_emergency_contact_phone_e164` | `employee_phones` |
| L8: grace 0–90 days | `chk_credential_templates_grace` | `init` |
| Credential fields: key format, label, one row per key, date flags only on date fields, at most one issue and one expiry field per type | `chk_template_fields_key`, `chk_template_fields_label`, `chk_template_fields_date_flags`, unique (`template_id`, `key`), partial uniques `credential_template_fields_one_issue_date` / `_one_expiry_date` | `database_first_master_data` |
| A credential field is not both the issue date and the expiry date | `chk_template_fields_not_issue_and_expiry` | `field_not_issue_and_expiry` |
| A deprecated position's successor exists and is not itself | `positions_replaced_by_fkey`, `chk_positions_not_self_replaced` | `database_first_master_data` |
| §5.1.4: one requirement per template + unit + position (position `NULL` = every position) | unique index `NULLS NOT DISTINCT` | `init` |
| Credential issue ≤ expiry | `chk_credentials_dates` | `init` |
| L9: waiver lasts at most 72 hours | `chk_waiver_future`, `chk_waiver_max_window` | `init` |
| D2: a document belongs to exactly one contract or credential, 1 byte – 10 MB | `chk_document_versions_one_owner`, `chk_document_versions_size` | `init` |
| R3: `SYSTEM` scope ⇔ no scope ids; expiry after grant | `chk_role_assignments_scope`, `chk_role_assignments_expiry` | `init` |
| R7: one active assignment per user + role + scope type | partial unique `role_assignments_active_key` | `init` |
| R11: one pending request per initiator + action | partial unique `approval_requests_pending_key` | `init` |
| S1: one slot per nurse per date and shift, across units | partial unique `shift_assignments_employee_slot_key` (cancelled rows excluded) | `init` |
| N3: one notification per recipient + event key | unique (`recipient_id`, `event_key`) | `init` |
| R18: break-glass events cannot be deleted | trigger `trg_break_glass_events_no_delete` | `init` |
| Audit append-only (A2) | trigger `trg_audit_entries_append_only` | `init` |
| Job runs claimed once per period | unique `job_runs.run_key` | `session_meta_and_job_runs` |
| Worker lease 30–3600 s | `chk_lease_seconds`, `chk_lease_expiry`; view `worker_lease_status` | `init` |

## 4. Audit chain

| Object | Purpose |
| :--- | :--- |
| `fn_audit_hash(...)` | SHA-256 over the previous hash and the stored columns, **including** `created_at` (D-7), so a row's content can be re-verified later |
| `fn_append_audit_entry(...)` | The single write path. Takes a transaction-scoped advisory lock so concurrent transactions cannot fork the chain; called inside the business transaction, so the audit row commits or rolls back with the change |
| `trg_audit_entries_append_only` | Rejects `UPDATE` and `DELETE` for every role, independent of grants |
| `audit_chain_breaks` (view) | Rows whose link (`BROKEN_LINK`) or content (`CONTENT_MISMATCH`) fails. Expected: empty. Served by `GET /api/v1/audit/verify` |

Values kept out of the audit trail on purpose: salary and the emergency contact phone (only the fact that they changed is recorded).

## 5. Migrations

| Migration | Adds |
| :--- | :--- |
| `20260922224327_init` | Every table, enum and index, plus the hand-written constraints, triggers, functions and views above |
| `20260923060000_credential_review_and_policy_warning` | `ELIGIBLE_WITH_POLICY_WARNING`, evidence review status and reviewer, `credentials.latest_evidence_id` |
| `20260923120000_contract_actors` | `contracts.created_by_id`, `submitted_by_id` (D-30) |
| `20260923180000_session_meta_and_job_runs` | Session IP and browser (D-22); `job_runs` |
| `20260924090000_employee_phones` | `employees.primary_phone`, `emergency_contact_phone` with E.164 checks (D-35) |
| `20260924100000_database_first_master_data` | `credential_template_fields` (the field definitions, copied from the JSON with a count check; the JSON kept as `field_defs_legacy` for rollback), `positions.replaced_by` foreign key, `units.critical_area` (filled from the former code map) |
| `20260925090000_field_not_issue_and_expiry` | Check: one field cannot be both the issue and the expiry date (found in the first browser check) |
| `20260925200000_approval_withdrawal` | `ApprovalStatus.WITHDRAWN` and `approval_requests.withdrawn_at`: the initiator may withdraw their own pending request (owner decision 2026-09-24) |
| `20260926090000_drop_field_defs_legacy` | Drops `credential_templates.field_defs_legacy`, the unread JSON rollback copy (go-live preparation, owner decision 2026-09-24) |

**Rules**

- Development: `npm run db:migrate -w backend` (`prisma migrate dev`) after editing `schema.prisma`. Hand-written SQL goes at the end of the generated file, under a comment explaining the rule.
- CI and production: `npm run db:deploy -w backend` (`prisma migrate deploy`). CI runs it twice to check repeatable deployment; this does **not** detect drift in a manually changed database. CI generates the custom-output Prisma client before seeding a fresh checkout.
- `prisma db push` is never used. A migration that has been applied anywhere is never edited; fix forward with a new one.
- Status: `npm run db:status -w backend`.

## 6. RBAC and eligibility in the database

- **RBAC:** role assignments are rows (`role_assignments`, scoped by `scope_type` + `scope_ids`); the permission each role grants is code ([RBAC.md](RBAC.md)). Four-eyes requests live in `approval_requests` with the full payload the approver sees.
- **Eligibility:** `eligibility_states` stores each nurse's current result, refreshed inside every transaction that changes a fact; the engine itself is code and reads only database rows ([CLINICAL_ELIGIBILITY.md](CLINICAL_ELIGIBILITY.md)).

## 7. How data enters the database

There is **no seed**. `npx prisma migrate deploy` creates the structure; nothing else writes data except these, all audited:

| Step | Command / screen | Writes | Guard |
| :--- | :--- | :--- | :--- |
| 1. Bootstrap | `npm run bootstrap -w backend` (after build) | The first System Admin, a hospital-wide HR Admin, optionally the break-glass account | Only on a database with no accounts; passwords from a hidden prompt |
| 2. Hospital baseline | Nursing Administration → **Hospital baseline import** (or `POST /api/v1/admin/baseline-import`), with the reference file `backend/prisma/baseline/aigh-baseline.json` or the hospital's own file | Departments, units and beds (+ bed log), positions, credential categories, credential types and fields | Hospital-wide administrator; preview; a **second** administrator approves; one transaction; never overwrites; idempotent |
| 3. Everyday work | The application screens and API | Everything else | Permissions, scope, four-eyes where required |
| Development only | `npm run fixtures:demo -w backend` | Demo accounts, the baseline, the fictional workforce | Refuses production, a database with accounts, and names not marked `_dev` / `_test` / `_demo` |

The baseline file is hospital data kept as a **data file**, not code: 5 departments, 47 units (582 beds), 25 positions, 5 categories, 17 credential types with 71 fields. The original 16 positions, 16 types and 68 fields are recorded in [SEED_DATA_INVENTORY.md](SEED_DATA_INVENTORY.md); the 9 positions from the 2026 roster (provisional titles) came with migration `20261027090000_roster_positions`.

## 8. Database roles

Spec §10.7 separates the runtime, migration, backup and audit-reader roles. They are in [`ops/db`](../ops/db/README.md): `01_roles.sql` (once per server, superuser) and `02_grants.sql` (per database, by the owner, after every migration). The migration role **owns** every schema object — in PostgreSQL only the owner may alter one — and connects only for `prisma migrate deploy` (`MIGRATION_DATABASE_URL`); the API and worker connect as `nurseapp_runtime`, which reads and writes data but cannot alter the schema, truncate, update or delete audit rows, delete break-glass events or read the migration journal. `backend/test/db-roles.test.ts` checks all of it on brand-new databases in CI.

**Not yet applied** to any server: the development database still connects as its owner. Applying them is a production prerequisite — [DEPLOYMENT.md §6](DEPLOYMENT.md#6-known-gaps-before-production). Where V04 departs from the spec's sample script (onboarding function, contract guard trigger, audit-reader table list) is listed in the README under *Adaptations*.
