# Security review — 2026-10-04

A review of the whole application (version 0.1.0 at commit `573d90d`, live on the VPS), top to bottom, against seven checks the owner set: input validation, parameterized SQL, protected admin routes, server-side secrets, cross-site scripting, dependencies, and a code security review of the kind Claude Code's `/security-review` runs (injection, authentication, authorization, data exposure, unsafe file handling). The method was to read the code and the configuration, run tools over every route and query, and send read-only requests to the live site. Fixes are listed in [CHANGELOG.md](../CHANGELOG.md) under *Unreleased → Security*.

**Result:** no exploitable vulnerability found. Four small hardening fixes made, and `npm audit` went from 4 high advisories to 0.

## 1. Input validation

| Checked | Finding |
|---|---|
| Every route handler (213 routes, read from `backend/src`) | Every request body, query string and path parameter goes through a zod schema (`.parse`) before use. Write bodies use `z.strictObject`, so unknown fields are refused. Strings have maximum lengths, numbers are integers within ranges, codes are trimmed and normalised. |
| Validation errors | One handler (`middleware/errors.ts`) turns them into 400 `VALIDATION_FAILED` with field paths. Database errors are mapped to stable codes; the SQL text is never returned. |
| Request size | JSON ≤ 1 MB, uploads ≤ `UPLOAD_MAX_SIZE_BYTES` (10 MB) + 1 byte, the OAuth token form ≤ 4 KB; Caddy and nginx cap bodies at 11 MB. |
| Uploads (`lib/uploads.ts`) | The type must be on the allowlist **and** match the file's first bytes; empty files are refused; the stored name is only for display, never a path; vault keys must be 64 hex characters (`lib/vault.ts`). |
| **Fixed** | A malformed `X-File-Name` (`decodeURIComponent` error) gave a 500. It now gives 400 `FILE_NAME_INVALID`. |
| **Fixed** | Stored file names kept invisible and direction-changing characters (`U+202E` can make `x‮fdp.exe` display as `xexe.pdf`). These are now removed with the control characters. |
| **Fixed** | The FHIR `identifier` search value had no length limit. It is now capped at 300 characters. |
| Kept as is | `GET /credential-templates?includeInactive=` compares the raw value with `'true'`, so any other value means false. That is safe as written. |

## 2. Parameterized SQL

All database access goes through Prisma, which binds values as parameters. Every raw query (33 call sites: row locks, advisory locks, throttle, audit chain, purge and sampling jobs) uses the tagged-template form `` $queryRaw`…${value}…` ``, which also sends values as bind parameters. The application code never calls `$queryRawUnsafe`, `$executeRawUnsafe` or `Prisma.raw` (they appear only in Prisma's generated client). Sort orders are fixed in code: no field name from a request ever reaches `orderBy`.

## 3. Protected admin routes

- **Default deny.** Every route under `/api/v1` sits behind one `authenticate` middleware. Only 15 routes are public (health, sign-in steps, invitation and password-reset links, single-use file links, the OAuth token endpoint, the Telegram webhook), and each is guarded by its own token, throttle or secret.
- **Role gates.** Admin routes carry `authorize('<permission>')`, read from `modules/users/permissions.ts`. System Admin rights stay dormant until a PAM elevation (`PAM_ELEVATION_REQUIRED`); break-glass sessions end after 4 hours. Roles are read from the database on every request, never from the token.
- **Record scope.** Services filter by the caller's units (`unitScope`, `viewerOf`). Hospital-wide masters (facilities, regions, ranks, specialties, contract types) also require a system-wide HR or SA scope.
- **Automated proof.** `backend/test/route-matrix.test.ts` reads every route from the running app and checks, for five personas, that each route answers exactly as `permissions.ts` says. It also checks that anonymous calls get 401. An ungated route fails the test unless it is on the reviewed own-or-scoped list. Every route passes.
- **CSRF.** State-changing requests need an `Origin` equal to the app's origin **and** the session's CSRF token, compared in constant time.
- **Live check.** An anonymous `GET /api/v1/employees` on the live site answers 401.

## 4. Server-side API secrets

- Secrets exist only in server environment files (`/etc/nurseapp/*.env`, outside the repository). `config/env.ts` refuses to start with a short `JWT_SECRET` (< 32 characters) or with a key that isn't 32 random bytes. Production also requires the MFA, document and PDPL keys.
- The frontend reads **no** environment values (`import.meta.env` is unused) and holds no keys. The access token lives in memory only, never in `localStorage`. The refresh token is an `httpOnly`, `Secure`, `SameSite=Lax` cookie limited to the refresh path.
- Telegram and SCFHS tokens, SMTP passwords and client secrets are used only by the API. Client secrets and one-time tokens are stored as hashes; MFA secrets and documents are encrypted (AES-GCM, with key rotation).
- `.gitignore` excludes `.env*`, keys and backups. A scan of all tracked files **and the full Git history** for private keys, cloud keys, bot tokens and long secrets in `KEY=value` form found no production secret. Only the documented development and CI placeholders appear.
- Access tokens are HS256 with the algorithm pinned (no `alg: none`), constant-time signature checks and UTC expiry. Passwords use bcrypt with cost 12.

## 5. Cross-site scripting

- React escapes everything it renders. The code has no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function`. The only dynamic links are the server-built `https://t.me/<bot>?start=<token>` and single-use file links, opened with `noopener`.
- E-mail templates escape every interpolated value (`lib/email-templates.ts`).
- Stored files are served with their allowlisted type, `X-Content-Type-Options: nosniff`, a `default-src 'none'` CSP and `Content-Disposition` with an encoded name. An uploaded file therefore cannot run script on the app's origin.
- **Live headers** (checked on the site): a CSP with `script-src` limited to `'self'` (no inline script, no `eval`), `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` and HSTS. HTTP redirects to HTTPS (308). CORS answers only the app's own origin.
- **Added:** `Permissions-Policy` denying camera, microphone, geolocation, payment and USB.

## 6. Dependencies

- Patch updates applied (all versions stay pinned exactly): dotenv 18.0.5, nodemailer 10.0.14, pg 8.23.1, @tanstack/react-query 5.104.1, vite 8.3.2, vitest 5.0.3, supertest 7.3.1, smtp-server 3.19.17.
- `npm audit` listed 4 high advisories, all inside the Prisma command-line tool:
  - `mysql2` (GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3) is used only with a MySQL database; this app uses PostgreSQL.
  - `deepmerge-ts` (GHSA-ggr8-5vv4-36mx) only merges the project's own `prisma.config.ts`.

  Neither is reachable from a request. `npm audit fix --force` would have *downgraded* Prisma to 6.x, and no fixed Prisma 7 release exists. Root `overrides` therefore pin `mysql2` 3.24.5 and `deepmerge-ts` 8.0.2. `npm audit` now reports **0**. `npm ci` was verified in the production image (`node:22-bookworm-slim`, npm 10.9.9), and Prisma `validate` passes.
- Not taken, on purpose:
  - Prisma 8 is a release candidate only.
  - TypeScript 7 is a new major version with a rewritten compiler, so it needs its own change.
  - `@types/node` 26 would describe a newer Node than the Node 22 that production runs.

## 7. Verification

Typecheck (backend and frontend), 520 backend and 62 frontend tests (new: `src/lib/uploads.test.ts` and an over-long FHIR identifier case), the documentation link check, the production build, and `nginx -t` on the updated template in `nginx:1.28-alpine` all pass.
