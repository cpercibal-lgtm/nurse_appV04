# Architecture

How V04 is built and where to find things. The reasons behind each choice are in [V04_ARCHITECTURE_PLAN.md](V04_ARCHITECTURE_PLAN.md) (§3–§4 and the decision record); this document describes the system as it is.

## 1. Principles

1. **Every business rule is enforced on the server** — in a backend service, and where possible again in a database constraint. The frontend shows data and collects input; hiding a button is never the protection.
2. **One of everything:** one backend, one frontend, one schema, one migration chain, one API, one permission table, one eligibility engine, one audit write path.
3. **No invented requirements.** Where the specification gives no rule, nothing is built, or a default is marked in code and in [SYSTEM_SPECIFICATION.md §4](SYSTEM_SPECIFICATION.md#4-requirement-not-established).

## 2. Components

```
 Browser ──HTTPS──▶ reverse proxy ──▶ API process (Express)  ──▶ PostgreSQL 15
   React SPA          (static files        │                        ▲
                       + /api/v1)          └─ jobs (JOBS_MODE=in-process, development)
                                                                     │
                                      worker process (JOBS_MODE=worker on the API) ──┘
```

| Component | Technology | Entry point |
| :--- | :--- | :--- |
| Backend API | Node ≥ 22, Express 5, TypeScript, zod 4, Prisma 7 (`@prisma/adapter-pg`) | `backend/src/server.ts` → `app.ts` |
| Background worker | Same code base | `backend/src/jobs/worker.ts` (`npm run worker -w backend`) |
| Database | PostgreSQL 15 | `backend/prisma/schema.prisma` + `migrations/` |
| Frontend | React 19, Vite 8, antd 6, React Query, zustand, i18next (English / Arabic, RTL) | `frontend/src/main.tsx` |
| Backups | WAL archiving, encrypted base backups, PITR drills | `ops/backup/` |

Redis, a message queue and a separate shared-code package are deliberately absent (plan §2–§3).

## 3. Repository layout

```
nurse_appV04/
├─ backend/
│  ├─ prisma/        schema.prisma · migrations/ (Prisma Migrate + hand-written SQL) · baseline/aigh-baseline.json (hospital data file for the import)
│  ├─ src/
│  │  ├─ config/     env.ts (validated settings) · residency.ts (KSA fail-closed check) · shifts.ts (shift times)
│  │  ├─ middleware/ request-id · authenticate · authorize · idempotency · errors
│  │  ├─ lib/        prisma · audit · dates · hijri · passwords · tokens · throttle · uploads · worker-lease · logger · http-errors
│  │  ├─ modules/    one folder per domain (§4)
│  │  ├─ jobs/       scheduler · worker · daily-transition · expiry-scan · attendance-alerts
│  │  ├─ cli/        bootstrap.ts — the one-time first-administrator command
│  │  ├─ app.ts      assembles the Express app (no listen — tests use it directly)
│  │  └─ server.ts   residency and scanner checks → listen → scheduler (in-process mode)
│  └─ test/          integration tests against a real PostgreSQL database; fixtures/demo/ (development-only demo data and its loader)
├─ frontend/
│  ├─ scripts/       check-bundle-size.mjs (fail-closed gzip budget)
│  └─ src/
│     ├─ app/        modules.tsx — the page registry (path, menu label, icon, required roles)
│     ├─ layouts/    AppLayout (role-aware menu, notification bell), password change
│     ├─ modules/    one folder per domain: pages + api.ts (React Query hooks)
│     ├─ services/   http.ts — the only HTTP client (token, CSRF, single-flight refresh)
│     ├─ hooks/      useAuth, usePermissions, usePreferences
│     └─ lib/        i18n (en/ar), hijri (display), phone, errors
├─ ops/backup/       backup and restore scripts, SQL probes, systemd units, crontab example
├─ docs/             this documentation set (docs/README.md is the index)
├─ .github/workflows/ci.yml
├─ docker-compose.yml   development database only
└─ .env.example         every backend setting, documented
```

## 4. Backend modules

| Module | Owns | Main files |
| :--- | :--- | :--- |
| `auth` | Login, refresh rotation, logout, password change, break-glass siren, own sessions | `service.ts`, `routes.ts` |
| `users` | Accounts, scoped role assignments, **the permission table**, scope resolution | `permissions.ts`, `access.ts`, `accounts.ts`, `role-assignments.ts` |
| `administration` | Four-eyes approvals, PAM elevation, hospital baseline import | `approvals.ts`, `pam.ts`, `baseline-import.ts` |
| `workforce` | Departments, units, beds (single / bulk / CSV), positions, coverage targets, KPI | `org.ts`, `kpi.ts` |
| `nurses` | Employee master, onboarding, own phones | `service.ts` |
| `contracts` | Contract lifecycle, renewal, documents | `service.ts` |
| `credentials` | Catalog: categories and types with their fields (four-eyes), requirements, records, evidence, renewal | `catalog.ts`, `fields.ts`, `records.ts`, `access.ts` |
| `eligibility` | **The engine** (pure), stored state, waivers | `engine.ts`, `state.service.ts`, `service.ts` |
| `scheduling` | Roster board, pool, draft, auto-fill, publish, coverage | `service.ts` |
| `attendance` | Clock events, gap classification | `service.ts` |
| `notifications` | Own notification list and acknowledgement | `routes.ts` |
| `audit` | Audit search and chain verification; job administration | `routes.ts` |

**Module rules.** A module exposes `routes.ts` (HTTP only: permission, parse, call) and a service (the rules). Services take the Prisma transaction client; every write happens in one transaction together with its audit entry and the eligibility refresh it causes. Queries on a transaction client are issued one at a time — never `Promise.all` — because a transaction is one pinned PostgreSQL connection (`pg` 9 rejects concurrent queries on it); `Promise.all` is fine on the root client, which uses the pool. Two shared entry points are called from many modules: `appendAudit(tx, …)` and `refreshEligibility(tx, employeeId, event)`.

## 5. A request, end to end

1. `request-id` assigns `X-Request-Id`; the one-line JSON log carries ids only, never personal data (`test/logging.test.ts`).
2. `authenticate` verifies the access token (HS256), then checks the CSRF header against the token's bound hash and the `Origin` header on every state-changing request.
3. `authorize(permission)` reads the caller's live role assignments (System Admin only while elevated) and compares them with `permissions.ts`.
4. The route parses the body and query with a strict zod schema (unknown fields rejected); `[I]` routes also require an `Idempotency-Key`.
5. The service resolves record scope, applies the business rules, and writes inside one transaction: data + `appendAudit` + `refreshEligibility` (which also returns invalid future published shifts to draft).
6. Errors leave as `{ error: { code, message, details? } }` with a stable code; responses carry `Cache-Control: no-store`.

## 6. Eligibility

One pure function, `evaluate(facts, {date, today, now})` in `modules/eligibility/engine.ts`, decides whether a nurse may work on a date. It has no database access and no clock, so every clinical rule is unit-tested directly. The same function serves the stored state (today), the roster pool and board, auto-fill, publication and the attendance gap view. Details: [CLINICAL_ELIGIBILITY.md](CLINICAL_ELIGIBILITY.md).

## 7. Background jobs

| Job | When (Asia/Riyadh) | Does |
| :--- | :--- | :--- |
| `daily-transition` | 00:05 daily | Contract and credential statuses by date, grace closure, PAM and break-glass expiry, idempotency purge, full eligibility refresh |
| `expiry-scan` | 06:00 daily | Credential and contract reminders by milestone (D-39) |
| `attendance-alerts` | every 15 minutes | CRITICAL notice to unit Supervisors when a published nurse has not clocked in 30 minutes after the start |

The scheduler ticks every minute. Each period has a unique run key in `job_runs`: a completed key never runs again, a failed one is retried (5 attempts), and a missed day runs when the process next starts. A `worker_leases` row keeps two processes from running one job at the same time. System Admins see runs and can run a job now (`/admin/jobs`). Deployment modes: [DEPLOYMENT.md §3](DEPLOYMENT.md#3-processes-and-background-jobs).

## 8. Audit

`appendAudit(tx, …)` calls the SQL function `fn_append_audit_entry`, which takes an advisory lock, links the row to the previous hash and hashes the stored columns (including the timestamp). A trigger rejects every `UPDATE` and `DELETE` on `audit_entries`, whichever database role connects. The view `audit_chain_breaks` lists any row whose link or content fails verification; `GET /audit/verify` reports it. Details: [DATABASE_ARCHITECTURE.md §4](DATABASE_ARCHITECTURE.md#4-audit-chain).

## 9. Frontend

- **Page registry** (`app/modules.tsx`): each page's path, menu label, icon, required roles and lazy import. The menu shows only permitted pages; the server still enforces everything.
- **HTTP client and session cache** (`services/http.ts`, `services/queryClient.ts`, `hooks/useAuth.ts`): keep the access token in memory, send the CSRF header, refresh once for concurrent requests, and attach idempotency keys. Protected React Query results are discarded on expiry, logout, login, restore and privilege reload.
- **Language**: every label is a key with an English text in `lib/i18n.en.ts` and an Arabic one in `lib/i18n.ar.ts`; Arabic switches the layout to right-to-left. English is in the main bundle; the Arabic table is a separate chunk that `lib/i18n.ts` loads only when Arabic is used, and the app renders once the chosen language is in. `i18n.test.ts` fails on a missing or empty translation.
- **Dates**: Gregorian dates are authoritative; the Umm al-Qura Hijri date is shown beside them (`lib/hijri.ts`, display only — the server converts and stores Hijri dates itself).
- **Bundle budget**: the build fails if the initial download exceeds 200 KB gzipped or any chunk exceeds 150 KB.

## 10. Tests

| Suite | Where | What it proves |
| :--- | :--- | :--- |
| Engine unit tests | `backend/src/modules/eligibility/engine.test.ts` | The spec's acceptance tables, rule by rule |
| Integration tests | `backend/test/*.test.ts` | Every module against PostgreSQL, including database constraints |
| Route security matrix | `backend/test/route-matrix.test.ts` | Every registered route × five personas matches `permissions.ts`; unauthenticated → 401; no unreviewed ungated route |
| End-to-end scenarios | `backend/test/scenarios.test.ts` | The 13 business scenarios as one story |
| Log privacy | `backend/test/logging.test.ts` | No e-mail, password, name, salary or search text in logs |
| Database-first | `backend/test/bootstrap.test.ts`, `database-first.test.ts`, `fixtures.test.ts` | On brand-new databases (migrations only): bootstrap, a hospital built through the API alone, the baseline import (exact counts, idempotent, all-or-nothing), demo fixtures |
| Documentation | `backend/test/docs.test.ts`, `scripts/check-docs.mjs` | RBAC.md matches the permission table; every documentation link resolves |
| Frontend | `frontend/src/**/*.test.ts(x)` | Translations complete, every page loads, Hijri and phone helpers |

Run everything with `npm test` from the repository root; CI (`.github/workflows/ci.yml`) generates the Prisma client, deploys migrations twice (idempotent deployment, **not** a drift check), runs the typecheck and the tests, and builds. There is no seed: the tests create their own rows, and the database-first suites start from brand-new migrated databases ([DATABASE_ARCHITECTURE.md §7](DATABASE_ARCHITECTURE.md#7-how-data-enters-the-database)).
