# AIGH Nursing Workforce Management System

Version **0.1.0**, the architecture baseline: see [CHANGELOG.md](CHANGELOG.md).

Clean rebuild of `nurse_appV03`: one backend, one frontend, one schema, one API.

| Path | What it is |
| :--- | :--- |
| `backend/` | Express 5 + TypeScript + Prisma + PostgreSQL — the only API, where every business rule is enforced |
| `frontend/` | React 19 + Vite + TypeScript + antd — the only UI |
| `ops/backup/` | PostgreSQL WAL archiving, encrypted base backup, PITR restore and drill scripts |
| `docs/` | Documentation — start at [docs/README.md](docs/README.md). What the system must do: [SYSTEM_SPECIFICATION.md](docs/SYSTEM_SPECIFICATION.md); how to run it: [DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| `scripts/` | Repository checks (`check-docs.mjs`: documentation links) |

## Requirements

Node.js 22 LTS or newer, PostgreSQL 15 (or `docker compose up -d db`).

## Getting started

```bash
npm install
cp .env.example backend/.env
# Set JWT_SECRET in backend/.env and check DATABASE_URL points to a V04-only database.
docker compose up -d db                     # or start a separate PostgreSQL 15 database
npm run db:generate -w backend              # generate the Prisma client
npm run db:deploy -w backend                # apply the V04 migrations (an empty database)
npm run dev:backend                         # http://localhost:3001/api/v1/health
npm run dev:frontend                        # http://localhost:5173
```

There is no seed: hospital data lives only in the database ([docs/DATABASE_ARCHITECTURE.md §7](docs/DATABASE_ARCHITECTURE.md#7-how-data-enters-the-database)). On an empty database:

```bash
npm run build -w backend && npm run bootstrap -w backend   # first System Admin + HR Admin (hidden password prompt)
```

then sign in and use **Nursing Administration → Hospital baseline import** with `backend/prisma/baseline/aigh-baseline.json`. For a development database with demo accounts and fictional staff instead (database name ending `_dev`, `_test` or `_demo`, no accounts yet):

```bash
DEMO_PASSWORD='choose-12-or-more-chars' npm run fixtures:demo -w backend
```

## Checks

Backend integration tests require PostgreSQL to be running (`docker compose up -d --wait db`)
and a separate, migrated database configured as `TEST_DATABASE_URL` in `backend/.env`.
Use a fresh test database for full-suite verification, as CI does: integration tests retain
their fixtures and repeated runs can make database-wide jobs exceed test timeouts.
The exit-package test uses built-in `tar` on Windows and requires `unzip` on other platforms.

```bash
npm run typecheck
npm test                 # backend, frontend and the documentation link check
npm run build            # includes the frontend bundle budget gate
```

## Status

Stage 2 of the consolidation is complete: all 12 commits of the sequence in [docs/V04_ARCHITECTURE_PLAN.md §7](docs/V04_ARCHITECTURE_PLAN.md#7-commit-sequence-stage-2-after-approval) are done; the validation matrix is in [docs/CLEANUP_REPORT.md](docs/CLEANUP_REPORT.md). **Not yet deployable to production** — see [DEPLOYMENT.md §6](docs/DEPLOYMENT.md#6-known-gaps-before-production).
