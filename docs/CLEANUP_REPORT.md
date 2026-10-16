# Cleanup report — V04 stage 2, commit 12

The last commit of the stage-2 sequence ([plan §7](V04_ARCHITECTURE_PLAN.md#7-commit-sequence-stage-2-after-approval)): remove what was temporary, retire the stage-1 analysis, and validate the whole repository against the Phase 15 matrix. Date: 2026-09-23.

**Principles followed** (owner's standing rules): nothing was deleted on its name alone — every removal below has usage evidence; no conflicting implementations were merged without analysis; the V03 repository was not touched; nothing was invented.

## 1. Changes in this commit

### 1.1 Removed (each proven unused)

| Item | Evidence | Why it existed |
| :--- | :--- | :--- |
| `frontend/src/components/ModulePlaceholder.tsx` | Imported nowhere (repository-wide search; every page in `app/modules.tsx` now loads a real module, proven by `modules.test.tsx`) | Commit 4 stand-in for pages whose backend did not exist yet |
| Translation keys `notYetAvailable`, `planned` (English and Arabic) | Used only by `ModulePlaceholder` | Same |
| `readableUnits()` in `backend/src/modules/credentials/access.ts` | Called nowhere; it only forwarded to `unitScope()`, which every caller uses directly | Early helper, superseded |
| Unused `AppRole` import in the same file | Reported by the compiler once `noUnusedLocals` was switched on | Left behind by the removal above |

A repository-wide scan listed every export not referenced from another file (85 found). All the others are used inside their own file (constants, types, schemas); exporting them is harmless and some are tested. One genuinely unused helper was **kept on purpose**: `badRequest()` in `lib/http-errors.ts`, one line in the set of HTTP error helpers (`unauthorized`, `forbidden`, `notFound`, …) with no logic of its own.

No npm dependency is unused: `@prisma/client` is the runtime of the generated client, `pg` the driver behind `@prisma/adapter-pg`, and `typescript` provides `tsc`.

### 1.2 Moved

| Item | From → to | Evidence |
| :--- | :--- | :--- |
| `LEGACY_REPOSITORY_INVENTORY.md`, `DUPLICATE_IMPLEMENTATION_MAP.md`, `DATABASE_CONSOLIDATION.md`, `CLEANUP_PLAN.md` | `docs/` → [`docs/history/`](history/) | Stage-1 analysis of V03 (plan §8: "fold into these and are then retired"). Their V04-relevant content now lives in the authoritative set (DATABASE, MIGRATION, ARCHITECTURE). Content unchanged; a "historical" banner added and relative links adjusted; every link to them updated and verified by the link check |

### 1.3 Kept in place (analysed, not retired)

| Item | Why |
| :--- | :--- |
| [`FEATURE_MASTER_INVENTORY.md`](FEATURE_MASTER_INVENTORY.md) | Its §15 **business rule register** is live: the rule IDs are cited by code comments, tests and the **applied** first migration (`-- Rule IDs refer to docs/FEATURE_MASTER_INVENTORY.md §15`), which may never be edited. Moving the file would break that reference permanently. A status banner now says §15 is live and the other sections are historical |
| [`V04_ARCHITECTURE_PLAN.md`](V04_ARCHITECTURE_PLAN.md) | Holds the owner decision record (D-1 … D-41) and the implementation notes per commit |
| [`reference/…v2_8_7.md`](reference/AIGH_Nursing_Workforce_Management_System_v2_8_7.md) | The verbatim specification; never edited |
| V03 repository (`C:\WebApp_project\Local_Repo\app`) | Owner rule: not destroyed until V04 is validated in the hospital environment |

### 1.4 Corrected

| Item | Problem | Fix |
| :--- | :--- | :--- |
| `.env.example` | Said integration tests "roll back every change". They do not: they add uniquely named rows and leave them (the audit trail is append-only). The test database had grown to 970 employees, which is what exposed the 500-row renewal-picker cap in commit 10b | Comment now states the truth and how to reset the test database |
| Decision dates D-34 … D-41 | Recorded as 2026-09-24; they were taken on 2026-09-23 | Corrected in the plan. The migration folder `20260924090000_employee_phones` keeps its name: it is applied and pushed, and applied migrations are never renamed (its order is still correct) |
| Code comments pointing at "commit 9" | A plan commit number means nothing to a new developer | Now point at `jobs/daily-transition.ts` |
| `noUnusedLocals` | Not enabled, so dead locals and imports could accumulate silently | Enabled in `backend/tsconfig.json` and `frontend/tsconfig.json`; both compile clean |
| Link check | Did not scan `docs/history/` | Now does (82 links in 19 files, including this report) |

## 2. Validation matrix

Run on 2026-09-23 on Windows 11, Node 24.19 / npm 11.17, local PostgreSQL 17 (CI runs the same suite on Node 22 / PostgreSQL 15). Commands from the repository root unless noted.

### 2.1 Frontend

| Check | Command | Result |
| :--- | :--- | :--- |
| Install | `npm ci` | ✅ clean install from the lockfile (38 s) |
| Type check | `npm run typecheck` (`tsc -b`, strict, `noUnusedLocals`) | ✅ 0 errors |
| Build | `npm run build -w frontend` | ✅ |
| Imports / routes | `modules.test.tsx` — every registered page module loads; no duplicate paths | ✅ |
| Translations | `i18n.test.ts` — every used key and enum-driven key family exists in English and Arabic, none empty | ✅ |
| Bundle | `check-bundle-size.mjs` (fail-closed) | ✅ entry **172.69 KB gz** / 200 KB budget; every chunk under 150 KB |
| Unit tests | `npm run test -w frontend` | ✅ **31 / 31** (5 files) |

### 2.2 Backend

| Check | Command | Result |
| :--- | :--- | :--- |
| Install | `npm ci` | ✅ |
| Type check | `npm run typecheck` (strict, `noUnusedLocals`) | ✅ 0 errors |
| Build | `npm run build -w backend` | ✅ |
| Prisma validate / generate | `npx prisma validate`, `prisma generate` (in build) | ✅ schema valid |
| Migrations | `prisma migrate status` on the development and test databases | ✅ 5 migrations, both up to date |
| Deploy re-run | `npm run db:deploy -w backend` | ✅ "No pending migrations to apply" |
| Drift | `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma` | ✅ empty — the database equals the schema |
| Seed idempotent | `npm run db:seed -w backend` twice | ✅ counts unchanged: 5 departments, 47 units, 16 positions, 16 credential types, 8 employees, 5 users |
| Start | `node dist/server.js` (port 3099) | ✅ `GET /health` → 200 `{"status":"ok","database":"up"}`; `X-Request-Id` and `Cache-Control: no-store` present; one-line JSON logs |
| Worker | `node dist/jobs/worker.js` | ✅ scheduler starts; `attendance-alerts` run completed; daily jobs already completed for the day are not re-run |
| Production guards | `NODE_ENV=production node dist/server.js` | ✅ refuses to start: with region `local` → residency error; with a KSA region → `UPLOAD_SCANNER … not allowed in production (D-10)` (expected — see §3) |
| Tests | `npm run test -w backend` | ✅ **282 / 282** (18 files) |

### 2.3 Database constraints (`test/database-constraints.test.ts`)

| Constraint | Result |
| :--- | :--- |
| Overlapping Approved/Active contracts rejected | ✅ |
| Waiver longer than 72 hours rejected | ✅ |
| Bed count outside 0–500 rejected | ✅ |
| Duplicate job number (any case) rejected | ✅ |
| Double booking (same nurse, date and shift) rejected | ✅ |
| Audit rows cannot be updated or deleted; chain verifies; a tampered row is detected | ✅ |
| Phone format (E.164) enforced by CHECK | ✅ (`workforce.test.ts`) |

### 2.4 Security

| Check | Where | Result |
| :--- | :--- | :--- |
| Authentication; password hashing (bcrypt); token rotation and reuse detection; CSRF on refresh and on every mutation; Origin check | `auth.test.ts`, `rbac.test.ts` | ✅ |
| RBAC matrix per role | `route-matrix.test.ts` — every registered route × 5 personas matches `permissions.ts`; no unreviewed ungated route; no unused permission | ✅ |
| Unauthenticated access | Same — every non-public route → 401; live server check above | ✅ |
| Input validation | Strict zod schemas; malformed input or unknown fields → 400 `VALIDATION_FAILED` (tested per module) | ✅ |
| No unscoped reads | Scope sweeps in `credentials`, `workforce`, `scheduling` tests | ✅ |
| No personal data in logs | `logging.test.ts` | ✅ |
| Audit rows for mutations | Every step of the end-to-end story checked; chain intact on the development database (26 rows) and the test database (7 304 rows): `audit_chain_breaks` empty | ✅ for tested paths. **No generic "every mutation writes a row" test** (recorded since commit 10) |
| RBAC documentation matches code | `docs.test.ts` | ✅ |
| Dependency advisories | `npm audit` | ⚠ 4 high, all in the Prisma CLI's bundled `mysql2` / `deepmerge-ts`; not loaded by the running API; npm's fix downgrades Prisma — not applied. **2026-10-04:** root `overrides` pin the fixed `mysql2` and `deepmerge-ts`; `npm audit` reports 0 ([security review §6](SECURITY_REVIEW_2026-10-04.md#6-dependencies)) |

### 2.5 Business scenarios (`test/scenarios.test.ts` and module tests)

| Scenario | Result |
| :--- | :--- |
| Nurse creation (onboarding + Draft contract + second-HR approval) | ✅ |
| Credential management (submit, verify, not own) | ✅ |
| Eligibility | ✅ (+ 33 engine unit tests) |
| Expired licence → ineligible → published shift back to draft → Supervisor told | ✅ |
| Missing credential blocks publication; per-type waiver | ✅ |
| Training requirement (transition warning → block after deadline) | ✅ |
| Staffing target / coverage | ✅ |
| Assignment, roster, publication | ✅ |
| Attendance gap and one alert per missing shift (30-minute early window) | ✅ |
| Break-glass (siren, no four-eyes, no waivers) | ✅ |
| Audit trail | ✅ |
| Reminder milestones and routing (D-39) | ✅ (`jobs.test.ts`) |

### 2.6 Documentation

| Check | Result |
| :--- | :--- |
| `npm run docs:check` | ✅ 82 links in 19 files resolve, including heading anchors |

## 3. Carried forward

Nothing in this list blocks development use; all of it blocks production. Details in [DEPLOYMENT.md §6](DEPLOYMENT.md#6-known-gaps-before-production) and [MIGRATION.md §4](MIGRATION.md#4-open-programme-items-v03-remediation-tracker).

| Item | Owner |
| :--- | :--- |
| ~~Malware scanner (ClamAV adapter) — the API will not start in production without it~~ **2026-09-24:** built (`lib/scanner.ts`, [DEPLOYMENT.md §2.1](DEPLOYMENT.md#21-malware-scanner-clamav)); production needs a `clamd` host | Development |
| Database roles and grants (spec §10.7) | Development + DBA |
| ~~Login limits are in memory (single API instance)~~ **2026-09-24:** counted in PostgreSQL (`login_throttle`, D-46) | Development / operations |
| SMTP / SMS decision (e-mail reminders, break-glass alert to CEO and IT Director, password reset) | Owner / IT |
| Badge-system (PACS) feed contract | Hospital IT |
| ~~Renewal picker: search / paging beyond 500 employees~~ **2026-09-24:** both contract pickers search the whole scope on the server (`?q=`, job number or name) | Development |
| Container images, reverse-proxy configuration, TLS (B-20) | Operations |
| `archive_timeout` / RPO (B-22), key management (B-18), hosting (U1), credential policy (U2), SCFHS (U3) | Owner |
| HR access to the audit trail (D-20) | Owner — REQUIREMENT NOT ESTABLISHED |
| ~~HTTPS browser evidence for the refresh cookie (B-03)~~ **2026-09-24:** automated — [ops/e2e](../ops/e2e/README.md), run by CI | Development |

## 4. Observations from this run

- **npm 11 install scripts.** npm 11.17 skipped the install scripts of `@prisma/engines`, `prisma` and `esbuild` ("allow-scripts"). Build, tests and the server all worked without them (the build runs `prisma generate` itself). CI's Node 22 / npm 10 is not affected. If a later npm makes this an error, approve those three packages with `npm approve-scripts`.
- **Local database version.** The development and test databases used during stage 2 run on PostgreSQL 17 on port 55432, from a cluster created in the assistant's temporary scratch directory. The target and CI are PostgreSQL 15. Before relying on the local data, move to a permanent cluster (for example `docker compose up -d db`, which is PostgreSQL 15) — the temporary directory can be cleared by the operating system.
- **Test database growth.** Integration tests never delete their rows; drop and re-create `nurseapp_test` occasionally (`.env.example` explains).
