# Retry safety and email confirmation implementation plan

> Execute inline using superpowers:executing-plans, with regression tests before changes.

**Goal:** Resolve the three verified review findings approved by the user.

**Architecture:** Protected routes explicitly execute their service operation and persist its JSON response in one PostgreSQL transaction. A transaction-scoped advisory lock prevents concurrent execution for an actor/key; service methods accept the existing transaction. Operational database failures remain server errors. Email confirmation observes hash changes and tracks one promise per token, ignoring stale UI results.

**Tech stack:** Express, Prisma/PostgreSQL, React, Vitest.

**Spec:** The approved review in this chat: atomic idempotency across all 11 routes; safe database error classification; replacement email confirmation tokens in a mounted tab.

## Constraints and review focus

- Preserve existing service transaction behavior for callers outside HTTP, and import timeouts and all-or-nothing staff import semantics.
- Never send a successful response before commit; response persistence failure must roll back business writes.
- Concurrent requests, expired legacy leases, handler errors after writes, and replay after ambiguous commit must not duplicate writes.
- Preserve request-hash conflict checks and client-safe constraint errors.
- New tokens, missing tokens, stale completions and StrictMode effect restarts need coverage without new runtime dependencies.

## Tasks

- [x] Add database error classification regressions, observe failure, map temporary failures to 503 and unknown database failures to 500; run focused tests.
- [x] Add real-database idempotency regressions for rollback, concurrency, retry and replay. Replace response interception middleware with an explicit transactional callback. Pass its transaction into all 11 protected service operations. Run backend integration tests and typecheck.
- [x] Add email confirmation regressions for hash changes and stale results. Handle confirmation per token with effect cleanup and promise reuse; run frontend tests and typecheck.
- [x] Run the project test command and review the complete diff. Report any remaining failures accurately.

## Verification record

- Database classification: 11 regressions failed with 400 before the fix, then passed; existing constraint tests also passed.
- Atomicity: response-storage failure and handler failure initially left writes committed; expired lease admitted a duplicate. All eight final database regression tests pass, including real account-route rollback and a real PostgreSQL constraint-error replay.
- Email confirmation: three DOM regressions failed before the fix; all four pass, including StrictMode deduplication.
- Root typecheck passed. Independent source review found no high/medium defects; its constraint-recovery coverage recommendation was added and passed.
- Full project suite against a fresh migrated database: 54 backend files / 615 tests passed, 14 frontend files / 138 tests passed, documentation check passed (424 links in 32 files). PostgreSQL client concurrent-query deprecation warnings were emitted; no test failures.
- Compatibility decision: refuse unresolved legacy idempotency records until reconciled; guessing their outcome could repeat a committed operation. Cost: an affected old request needs operator review.

## Follow-up: PostgreSQL warning and legacy-state reconciliation

- Approved by the user after commit `2e99daf`.
- Root cause: Prisma's relation loader can call `PgTransaction.queryRaw` concurrently within a single awaited ORM operation. A real relation-loading regression reproduced the pg deprecation warning.
- Fix: serialize the adapter's query/execute/commit/rollback calls per transaction. Pool queries and separate transactions remain independent; failed queries still permit rollback/savepoint recovery.
- Reconciliation on 2026-10-17: application database `nurseapp` and older `nurseapp_test` had no unresolved records. Removed eight synthetic `test.write` records from `nurseapp_test_clean_20261016` and two from the previous review database. All had the test-only `/write` path. No business writes or real request outcomes were changed. The regression suite now removes its synthetic idempotency states after testing.
- Focused verification: 18 tests passed without warnings; backend typecheck passed. Full project verification with `NODE_OPTIONS=--throw-deprecation` passed: 617 backend tests, 138 frontend tests, and documentation checks; no deprecation warnings. Final local database inventory confirmed zero unresolved records, including the new full-suite database. Independent follow-up review was unavailable due to the reviewer usage limit; the implementer reviewed the final diff.
