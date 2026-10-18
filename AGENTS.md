# AGENTS.md

This file provides guidance to Codex (claude.ai/code) when working with code in this repository.

AIGH Nursing Workforce Management System, V04: an npm-workspaces monorepo with `backend/` (Express 5, TypeScript, zod 4, Prisma 7 on PostgreSQL 15) and `frontend/` (React 19, Vite 8, antd 6, React Query, i18next English/Arabic). Node ≥ 22. Start with [docs/README.md](docs/README.md) (the documentation index) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Commands

Run from the repository root unless noted.

```bash
docker compose up -d --wait db            # development PostgreSQL 15 (localhost:5432)
cp .env.example backend/.env              # then set JWT_SECRET; DATABASE_URL and TEST_DATABASE_URL point at the container
npm run db:generate -w backend            # Prisma client (generated into backend/src/generated, not tracked)
npm run db:deploy -w backend              # apply migrations to DATABASE_URL
npm run dev:backend                       # http://localhost:3001/api/v1/health
npm run dev:frontend                      # http://localhost:5173

npm run typecheck                         # backend (prisma generate + tsc) and frontend (tsc -b)
npm test                                  # backend tests, then frontend tests, then docs:check; stops at the first failing step
npm run build                             # includes the frontend bundle budget gate (200 KB gz initial, 150 KB per chunk)
npm run docs:check                        # every relative link and heading anchor in the docs must resolve
npm run docs:manual                       # regenerate the user manual (Markdown, flow SVGs, PDF) from the guide content
```

A single test:

```bash
cd backend && npx vitest run test/scfhs.test.ts                # one file
cd backend && npx vitest run test/scfhs.test.ts -t "on demand"  # one test by name
cd frontend && npx vitest run src/modules/guidelines            # one frontend folder
```

There is no lint script; the TypeScript compilers are the static check.

### Database tests

- Backend integration tests use `TEST_DATABASE_URL`, a separate, migrated database. When it is unset, every database test is **skipped, not failed** (`describe.skip`), so a green run without it proves little.
- Tests leave their rows behind (the audit trail is append-only). For a full-suite run, use a freshly created and migrated database, as CI does: create it, run `db:deploy` against it, and point `TEST_DATABASE_URL` at it. Database-wide jobs can otherwise exceed test timeouts.
- Test files run one at a time (`fileParallelism: false`): the backend suite takes 5–10 minutes. Run it in the background and narrow to the files you touched while iterating.

## Architecture

- **The server enforces every rule.** Business rules live in backend services, and where possible again in a database constraint. The frontend hides what a role cannot do, but that is never the protection.
- **One of everything:** one API, one schema and migration chain, one permission table, one eligibility engine, one audit write path. Add to the existing one rather than creating a second.
- **No invented requirements.** Where the specification ([docs/SYSTEM_SPECIFICATION.md](docs/SYSTEM_SPECIFICATION.md)) gives no rule, nothing is built, or a default is marked in code and listed as REQUIREMENT NOT ESTABLISHED. Owner decisions get a D-number in the decision record ([docs/V04_ARCHITECTURE_PLAN.md](docs/V04_ARCHITECTURE_PLAN.md) §9a) first; code, tests and docs then cite it.

### Backend

- `src/app.ts` builds the Express app without listening (tests use it directly through `test/helpers.ts`); `src/server.ts` runs the production start-up checks, then listens and, with `JOBS_MODE=in-process`, runs the jobs. Production uses a separate worker (`src/jobs/worker.ts`).
- A request: `request-id` → `authenticate` (access token, CSRF header, Origin) → `authorize(permission)` against `modules/users/permissions.ts` → a strict zod parse (unknown fields rejected) → the service. Errors leave as `{ error: { code, message, details? } }` with a stable code.
- A module is `routes.ts` (permission, parse, call) plus a service (the rules). Every write happens in **one transaction** with its `appendAudit(tx, …)` and the `refreshEligibility(tx, employeeId, event)` it causes.
- **Never `Promise.all` on a transaction client**: a transaction is one PostgreSQL connection. `lib/prisma.ts` (`SerialTransactionPrismaPg`) also queues Prisma's own concurrent queries, and `test/pg-concurrency.test.ts` guards it.
- Routes marked `[I]` in [docs/API.md](docs/API.md) need an `Idempotency-Key`; the business write and the stored reply commit in one transaction (`middleware/idempotency.ts`). Edits marked `[V]` take `If-Match`.
- `modules/eligibility/engine.ts` is the one **pure** eligibility function (no database, no clock). It serves stored state, the roster pool and board, auto-fill, publication and attendance gaps.
- Audit rows go through the SQL function `fn_append_audit_entry` (hash chain, advisory lock); a trigger rejects any `UPDATE` or `DELETE` on `audit_entries`.
- Settings are validated in `src/config/env.ts`. Production refuses to start without its keys, the ClamAV scanner, the data-only database role and a Kingdom data-residency region. Integrations sit behind one gateway each, with a mock driver (`lib/telegram.ts`, `lib/scfhs.ts`, the badge simulator).
- Jobs (`src/jobs/scheduler.ts`) run in Asia/Riyadh time with a unique run key per period in `job_runs` and a `worker_leases` row, so a missed or failed period is retried safely.

### Database

- `backend/prisma/schema.prisma` and `migrations/`. After editing the schema: `npm run db:migrate -w backend` (`prisma migrate dev`); hand-written SQL (constraints, triggers, functions) goes at the end of the generated file under a comment. **Never `prisma db push`**, and never edit a migration that has been applied anywhere: fix forward.
- There is **no seed**. Hospital data enters through `npm run bootstrap` and the baseline import (`backend/prisma/baseline/aigh-baseline.json`); demo data through `npm run fixtures:demo -w backend` into a `*_dev`, `*_test` or `*_demo` database only.

### Frontend

- `src/app/modules.tsx` is the page registry (path, menu label, icon, required roles, lazy import).
- `src/services/http.ts` is the only HTTP client (in-memory token, CSRF header, single-flight refresh, idempotency keys). Each module's `api.ts` holds its React Query hooks.
- Every label is a key in **both** `src/lib/i18n.en.ts` and `src/lib/i18n.ar.ts`; Arabic switches the layout to right-to-left. `i18n.test.ts` fails on a missing or empty translation.

## Rules that tests enforce

- **The user manual is generated.** Edit `frontend/src/modules/guidelines/content/`, never `docs/USER_MANUAL.md`, then run `npm run docs:manual` and commit the regenerated Markdown, SVGs and both PDFs. `guidelines.test.ts` fails when they differ.
- [docs/RBAC.md](docs/RBAC.md) §3 must equal `permissions.ts` (`backend/test/docs.test.ts`). Every registered route is checked against five personas in `test/route-matrix.test.ts`, which also fails on a new ungated route.
- Logs carry ids only: no e-mail, name, password, salary or search text (`test/logging.test.ts`).

## Working in this repository

- **Work on a branch and open a pull request**; do not commit to `main`. Branch from `origin/main` after `git fetch`.
- **Other sessions may share this checkout.** Before branching or committing, check `git status` and `git log origin/main..HEAD`, so that nobody else's commits travel in your branch.
- Every change gets an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) (Changed / Fixed / Added), in plain language, with an **Upgrade:** note when a server needs a step. A release step also goes in [docs/DEPLOYMENT_CHECKLIST.md](docs/DEPLOYMENT_CHECKLIST.md).
- Commit messages follow `type(scope): summary` (`feat`, `fix`, `docs`, `test`, …), with a body that says why.
- When behaviour changes, update the documents that describe it (DEPLOYMENT.md, API.md, the guide content), then run `npm run docs:check`.
- **Windows:** if PowerShell blocks `npm.ps1`, use `npm.cmd`. In Git Bash, `tar` is GNU tar, not Windows' own `tar.exe`.
