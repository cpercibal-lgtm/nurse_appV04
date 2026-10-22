# RBAC module kit: roles, scopes and permissions

A portable role-based access control (RBAC) module. Drop this one file into a new project and ask your coding assistant: **"Implement the RBAC module described in RBAC_MODULE.md."**

It was extracted from the AIGH Nursing Workforce Management System V04, where it runs in production-style code with tests. The hospital-specific roles were replaced with generic examples.

**Target stack:** Node ≥ 22, Express 5, TypeScript, zod 4, Prisma (6 or 7) on PostgreSQL, React 18/19 with React Query, Vitest + Supertest. Other stacks can follow [the rules](#2-the-rules) and translate the code.

**What it gives you:**

- One permission table that decides which roles may call which routes. Anything not in the table is denied.
- Role assignments stored in the database, each with a **scope** (whole system, some departments, or some units), a reason, and an optional expiry.
- A safe grant/revoke service: nobody grants themselves a role, a granter can only grant inside their own scope, and the last system-wide admin cannot be removed.
- Row-level scope helpers so services return only the records the caller may see.
- A React hook and components that hide menus and buttons a user cannot use.
- Tests that fail when a new route has no permission, or a permission guards nothing.

**What it does not include:** sign-in, passwords, tokens and sessions. The kit assumes the app already has an `authenticate` middleware that knows the signed-in user's id. Optional add-ons (admin elevation, four-eyes approval, audit log) are described at the end.

## Contents

1. [Instructions for the AI assistant](#1-instructions-for-the-ai-assistant)
2. [The rules](#2-the-rules)
3. [Roles and scopes](#3-roles-and-scopes)
4. [Database](#4-database)
5. [Backend code](#5-backend-code)
6. [Frontend code](#6-frontend-code)
7. [Tests](#7-tests)
8. [How to add a permission](#8-how-to-add-a-permission)
9. [Optional add-ons](#9-optional-add-ons)
10. [Done checklist](#10-done-checklist)

## 1. Instructions for the AI assistant

You are adding this RBAC module to an existing project. Follow these steps in order.

**Before writing code, inspect the project and adapt:**

1. **Stack.** Confirm it uses Express, Prisma and React. If something differs (Fastify, Drizzle, Next.js route handlers, Vue), keep [the rules](#2-the-rules) and the file layout, and translate the code. Tell the user what you changed.
2. **User model.** Find the existing `User` model. The kit expects `id`, `email`, `displayName` and `isActive`. If the id is a string (uuid/cuid), change every `Int`/`number` user id in the kit to match. Do not create a second user table.
3. **Authentication.** Find the middleware that verifies the session or token. You will add one call to it (see [5.4](#54-hook-into-authentication)). If there is none, stop and tell the user: this kit needs a signed-in user id.
4. **Errors.** If the project already has an error class and an error handler, use them instead of [5.1](#51-http-errors). Keep the error codes (`UNAUTHENTICATED`, `FORBIDDEN`, `SCOPE_NOT_COVERED` and the others), because the frontend and the tests rely on them.
5. **Organisation structure.** The kit scopes roles to `DEPARTMENT` and `UNIT`. If the project has a different hierarchy (for example Region → Store, or Company → Team), rename the two levels everywhere and point them at the existing tables. If it has no hierarchy, keep only `SYSTEM` scope and delete the scope code. Ask the user if this is unclear.
6. **Roles and permissions.** The roles (`ADMIN`, `MANAGER`) and permissions (`orders.*`, `reports.read`, `settings.manage`) are **examples**. Ask the user for the real roles and the real list of actions. Do not invent business roles.
7. **Prisma client path.** Imports use `../../generated/prisma/client.js` (the Prisma 7 `prisma-client` generator). If the project imports from `@prisma/client`, change the imports.

**Then build in this order:**

1. Database: schema, migration, SQL constraints ([section 4](#4-database)).
2. Backend: errors, permission table, access helpers, `authorize` middleware, the authentication hook, the role-assignment service and routes, `/auth/me` ([section 5](#5-backend-code)).
3. Put `authorize(...)` on every existing route of the project. A route that only touches the caller's own data gets a `USER` permission, or goes on the reviewed list in the route test.
4. Frontend: the `useMe` and `usePermissions` hooks, `<Can>` and `<RequirePermission>`, menu filtering ([section 6](#6-frontend-code)).
5. Tests ([section 7](#7-tests)), then run the type checker and the tests.
6. Work through the [done checklist](#10-done-checklist).

**Do not:**

- Store the `USER` role. It is implicit for every active account.
- Cache roles in the token, the session or memory. Read them from the database on every request.
- Trust a role, scope or id sent by the browser. The server works out what the caller may do.
- Treat hidden frontend buttons as security. The server checks every request.
- Use `Promise.all` with a Prisma transaction client (`tx`). A transaction is one database connection; run its queries one after another.
- Use `prisma db push`. Create a migration.

## 2. The rules

These rules hold in any stack. Each one is enforced by the code in this kit.

| # | Rule | Where it is enforced |
| :--- | :--- | :--- |
| 1 | **Default deny.** A route must name one permission. A permission not in the table can never be allowed. | `authorize()`, the route test |
| 2 | **`USER` is implicit.** Every active, signed-in account has it. It is never stored and cannot be granted. | `effectiveRoles()`, the zod role enum |
| 3 | **Roles are read fresh.** Active assignments are loaded from the database on every request, so a revoke takes effect on the next request. | `loadAuthContext()` |
| 4 | **Every assignment has a scope:** `SYSTEM` (no ids), `DEPARTMENT` (department ids) or `UNIT` (unit ids). A department scope covers every unit in it. | SQL check, `assertScopeShape()`, `unitScope()` |
| 5 | **Two checks per request.** First the route permission (may this role do this at all?), then the record scope inside the service (may they touch *this* row?). | `authorize()`, then `unitScope()` / `scopeCovers()` |
| 6 | **The server decides scope.** An id sent by the browser never grants access. | Every service filters by `unitScope()` |
| 7 | **No self-service grants.** Nobody grants, changes or revokes their own role assignment. | Role-assignment service |
| 8 | **A granter must cover the scope they grant.** Only a system-wide admin grants `SYSTEM` scope. | `assertCovers()` |
| 9 | **One active assignment per user + role + scope type.** | Partial unique index |
| 10 | **Expiry limits.** Each role has a maximum assignment length (example: `MANAGER` 90 days, `ADMIN` 365). An expired assignment stops counting at once. | `assertExpiry()`, `activeGrants()` |
| 11 | **The last system-wide admin cannot be removed** by revoke or by narrowing its scope. Changes that could remove them run one at a time under a database lock. | `lockAdminChanges()`, `otherSystemAdmins()` |
| 12 | **Every grant, change and revoke needs a written reason** and is recorded with who did it. | zod schemas, the `audit` hook |
| 13 | **A job title never grants a role.** Roles come only from explicit assignments. | Design: no code derives roles from other fields |
| 14 | **The frontend only hides.** It reads the user's permissions from `/auth/me` to hide menus and buttons. The server is the protection. | `usePermissions()` |

## 3. Roles and scopes

Example roles. Replace them with the project's own.

| Role | Stored? | Meaning (example) |
| :--- | :--- | :--- |
| `USER` | **No**, implicit for every active account | Own profile, own records, read reference data |
| `MANAGER` | Role assignment | Works on records inside their departments or units |
| `ADMIN` | Role assignment | Administers accounts and role assignments inside their scope; system-wide admins manage settings |

Scopes:

| Scope type | `scopeIds` holds | Covers |
| :--- | :--- | :--- |
| `SYSTEM` | nothing (empty array) | Everything |
| `DEPARTMENT` | department ids | Every unit in those departments, including units added later |
| `UNIT` | unit ids | Those units only |

A user can hold several assignments, for example `MANAGER` of units 3 and 7, and `ADMIN` of department 2. Their scope for an action is the union of the assignments whose role allows that action.

## 4. Database

### 4.1 Prisma schema

Add to `prisma/schema.prisma`. Merge the `User` relations into the existing model, and skip `Department` and `Unit` if the project already has equivalent tables (then point the scope code at them).

```prisma
enum AppRole {
  ADMIN
  MANAGER
  // USER is implicit for every active account and is never stored.
}

enum ScopeType {
  SYSTEM
  DEPARTMENT
  UNIT
}

model User {
  id          Int     @id @default(autoincrement())
  email       String  @unique
  displayName String  @map("display_name")
  isActive    Boolean @default(true) @map("is_active")
  // ...the project's existing fields...

  roleAssignments RoleAssignment[] @relation("assignee")
  rolesGranted    RoleAssignment[] @relation("granter")
  rolesRevoked    RoleAssignment[] @relation("revoker")

  @@map("users")
}

model Department {
  id    Int    @id @default(autoincrement())
  name  String @unique
  units Unit[]

  @@map("departments")
}

model Unit {
  id           Int        @id @default(autoincrement())
  name         String
  departmentId Int        @map("department_id")
  department   Department @relation(fields: [departmentId], references: [id])

  @@index([departmentId])
  @@map("units")
}

/// A scoped role assignment. Revoked rows are kept (revokedAt set), never deleted.
model RoleAssignment {
  id           Int       @id @default(autoincrement())
  userId       Int       @map("user_id")
  role         AppRole
  scopeType    ScopeType @map("scope_type")
  /// Department ids (DEPARTMENT) or unit ids (UNIT); empty for SYSTEM.
  scopeIds     Int[]     @map("scope_ids")
  reason       String
  grantedById  Int       @map("granted_by_id")
  grantedAt    DateTime  @default(now()) @map("granted_at") @db.Timestamptz
  expiresAt    DateTime? @map("expires_at") @db.Timestamptz
  revokedById  Int?      @map("revoked_by_id")
  revokedAt    DateTime? @map("revoked_at") @db.Timestamptz
  revokeReason String?   @map("revoke_reason")

  user      User  @relation("assignee", fields: [userId], references: [id])
  grantedBy User  @relation("granter", fields: [grantedById], references: [id])
  revokedBy User? @relation("revoker", fields: [revokedById], references: [id])

  @@index([userId, revokedAt])
  @@index([role, scopeType])
  @@map("role_assignments")
}
```

### 4.2 Migration and SQL constraints

Prisma cannot express these rules, so they are added by hand. Create the migration without applying it, append the SQL, then apply:

```bash
npx prisma migrate dev --create-only --name rbac
# append the SQL below to the end of the new migration.sql
npx prisma migrate dev
```

```sql
-- ── RBAC (hand-written) ────────────────────────────────────────────────────
-- SYSTEM scope has no ids; DEPARTMENT and UNIT scopes have at least one.
ALTER TABLE "role_assignments"
  ADD CONSTRAINT "chk_role_assignments_scope" CHECK (
    ("scope_type" = 'SYSTEM') = (cardinality("scope_ids") = 0)),
  ADD CONSTRAINT "chk_role_assignments_expiry" CHECK (
    "expires_at" IS NULL OR "expires_at" > "granted_at");

-- One active (not revoked) assignment per user + role + scope type.
CREATE UNIQUE INDEX "role_assignments_active_key"
  ON "role_assignments" ("user_id", "role", "scope_type") WHERE "revoked_at" IS NULL;
```

Note: the unique index cannot look at `expires_at` (an index cannot use the current time), so an **expired but not revoked** assignment still blocks a new one with the same user, role and scope type. To renew, extend its expiry with `PATCH`, or revoke it and grant again.

### 4.3 The first admin

No one can grant the first role, because every grant needs an admin. Create it once from a script or a one-off SQL statement on a new installation, with no expiry:

```sql
INSERT INTO role_assignments (user_id, role, scope_type, scope_ids, reason, granted_by_id)
VALUES (1, 'ADMIN', 'SYSTEM', '{}', 'First administrator, created at installation', 1);
```

Replace `1` with the id of the first account.

## 5. Backend code

File layout (adapt to the project):

```text
src/
  lib/http-errors.ts          5.1
  lib/db.ts                   5.1 (types only)
  modules/rbac/permissions.ts 5.2  the one permission table
  modules/rbac/access.ts      5.3  who is calling, roles, scope
  middleware/authorize.ts     5.3  route gate
  modules/rbac/service.ts     5.5  grant, update, revoke, list
  modules/rbac/routes.ts      5.6  HTTP routes + /auth/me data
```

### 5.1 HTTP errors

Every error leaves the API as `{ error: { code, message, details? } }`. `code` is stable and machine-readable; `message` is safe to show the user.

```ts
// src/lib/http-errors.ts
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
  toBody() {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }
}

export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'UNAUTHENTICATED', message);
export const forbidden = (code = 'FORBIDDEN', message = 'You do not have permission to do this') => new HttpError(403, code, message);
export const notFound = (message = 'Record not found') => new HttpError(404, 'NOT_FOUND', message);

/** Register last: app.use(errorHandler). Express 5 forwards rejected async handlers here. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) return void res.status(err.status).json(err.toBody());
  if (err instanceof ZodError) {
    return void res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'The request is not valid', details: err.issues } });
  }
  console.error(err); // log ids only in real logs, never personal data
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
};
```

```ts
// src/lib/db.ts
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';

export type Db = PrismaClient;
/** The client or a transaction client. Never Promise.all on a transaction client. */
export type DbClient = PrismaClient | Prisma.TransactionClient;
```

### 5.2 The permission table

The **only** place that says which role may do what. Each new feature adds its permissions here.

```ts
// src/modules/rbac/permissions.ts
// Default deny: an operation not listed here cannot be authorized.
// 'USER' means any signed-in, active account; the service then limits
// them to their own records.

import type { AppRole } from '../../generated/prisma/client.js';

export type EffectiveRole = AppRole | 'USER';

export const PERMISSIONS = {
  // RBAC administration (this kit).
  'roles.read': ['ADMIN'],
  'roles.write': ['ADMIN'], // grant, change, revoke, within the caller's scope
  'matrix.read': ['USER'], // read the permission table itself

  // ── Examples: replace with the project's real permissions ──────────────
  'orders.read': ['ADMIN', 'MANAGER'],
  'orders.write': ['ADMIN', 'MANAGER'],
  'orders.approve': ['ADMIN'],
  'reports.read': ['ADMIN', 'MANAGER'],
  'settings.manage': ['ADMIN'], // the service also requires SYSTEM scope
} as const satisfies Record<string, readonly EffectiveRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
```

Naming: `area.action`, lower case. Use `read` / `write` / a specific verb (`approve`, `publish`, `export`) when one role may do it and another may not.

### 5.3 Access helpers and the `authorize` middleware

```ts
// src/modules/rbac/access.ts
// Who is calling and what they may touch, read from the database on every
// request (no cache), so a revoke takes effect on the next request.

import type { AppRole, ScopeType } from '../../generated/prisma/client.js';
import type { DbClient } from '../../lib/db.js';
import { ALL_PERMISSIONS, PERMISSIONS, type EffectiveRole, type Permission } from './permissions.js';

export interface Grant {
  id: number;
  role: AppRole;
  scopeType: ScopeType;
  scopeIds: number[];
  expiresAt: Date | null;
}

export interface AuthContext {
  user: { id: number; email: string; displayName: string };
  /** Active assignments: not revoked, not expired. */
  grants: Grant[];
}

declare global {
  namespace Express {
    interface Locals {
      auth?: AuthContext;
    }
  }
}

export function activeGrants(db: DbClient, userId: number, now = new Date()): Promise<Grant[]> {
  return db.roleAssignment.findMany({
    where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { id: true, role: true, scopeType: true, scopeIds: true, expiresAt: true },
    orderBy: { id: 'asc' },
  });
}

/** Called by `authenticate` once the token is valid. Null: no such account, or deactivated. */
export async function loadAuthContext(db: DbClient, userId: number, now = new Date()): Promise<AuthContext | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, displayName: true, isActive: true } });
  if (!user || !user.isActive) return null;
  const grants = await activeGrants(db, userId, now);
  return { user: { id: user.id, email: user.email, displayName: user.displayName }, grants };
}

export function effectiveRoles(auth: AuthContext): EffectiveRole[] {
  return ['USER', ...new Set(auth.grants.map((g) => g.role))];
}

export function checkPermission(auth: AuthContext, permission: Permission): boolean {
  const allowed: readonly EffectiveRole[] = PERMISSIONS[permission];
  return effectiveRoles(auth).some((r) => allowed.includes(r));
}

/** The permissions the caller holds, for /auth/me (the frontend hides what is not listed). */
export function allowedPermissions(auth: AuthContext): Permission[] {
  return ALL_PERMISSIONS.filter((p) => checkPermission(auth, p));
}

/** The caller holds one of these roles with SYSTEM scope. */
export function isSystemWide(auth: AuthContext, roles: readonly AppRole[]): boolean {
  return auth.grants.some((g) => roles.includes(g.role) && g.scopeType === 'SYSTEM');
}

// ── Record scope ──────────────────────────────────────────────────────────

/** Every unit, or an explicit set of unit ids. */
export type UnitScope = { all: true } | { all: false; unitIds: Set<number> };

/**
 * The units the caller may act on through the given roles. DEPARTMENT grants
 * expand to that department's units, read fresh. An id sent by the browser
 * never establishes access.
 */
export async function unitScope(db: DbClient, auth: AuthContext, roles: readonly AppRole[]): Promise<UnitScope> {
  const grants = auth.grants.filter((g) => roles.includes(g.role));
  if (grants.some((g) => g.scopeType === 'SYSTEM')) return { all: true };
  const unitIds = new Set(grants.filter((g) => g.scopeType === 'UNIT').flatMap((g) => g.scopeIds));
  const deptIds = grants.filter((g) => g.scopeType === 'DEPARTMENT').flatMap((g) => g.scopeIds);
  if (deptIds.length > 0) {
    const units = await db.unit.findMany({ where: { departmentId: { in: deptIds } }, select: { id: true } });
    for (const u of units) unitIds.add(u.id);
  }
  return { all: false, unitIds };
}

/** Every one of these units is inside the scope. */
export function scopeCovers(scope: UnitScope, unitIds: Iterable<number>): boolean {
  if (scope.all) return true;
  for (const id of unitIds) if (!scope.unitIds.has(id)) return false;
  return true;
}

/** A Prisma `where` fragment for a table with a `unitId` column. */
export function unitWhere(scope: UnitScope): { unitId?: { in: number[] } } {
  return scope.all ? {} : { unitId: { in: [...scope.unitIds] } };
}

/** The unit ids an assignment's scope refers to. */
export async function unitsOfScope(db: DbClient, scopeType: ScopeType, scopeIds: number[]): Promise<number[] | 'ALL'> {
  if (scopeType === 'SYSTEM') return 'ALL';
  if (scopeType === 'UNIT') return scopeIds;
  const units = await db.unit.findMany({ where: { departmentId: { in: scopeIds } }, select: { id: true } });
  return units.map((u) => u.id);
}

// ── Last system-wide admin ────────────────────────────────────────────────

/**
 * Active system-wide ADMIN assignments on active accounts, leaving out one
 * assignment or one account (the one about to be removed). Call it only
 * after lockAdminChanges, inside the same transaction.
 */
export function otherSystemAdmins(db: DbClient, exclude: { assignmentId?: number; userId?: number }, now = new Date()) {
  return db.roleAssignment.count({
    where: {
      role: 'ADMIN', scopeType: 'SYSTEM', revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      user: { isActive: true },
      ...(exclude.assignmentId ? { id: { not: exclude.assignmentId } } : {}),
      ...(exclude.userId ? { userId: { not: exclude.userId } } : {}),
    },
  });
}

/** Serialises every change that could remove the last system-wide admin. Inside a transaction only. */
export const lockAdminChanges = (db: DbClient) => db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('role_assignments:admin'))`;
```

```ts
// src/middleware/authorize.ts
import type { RequestHandler, Response } from 'express';
import { forbidden, unauthorized } from '../lib/http-errors.js';
import { checkPermission, type AuthContext } from '../modules/rbac/access.js';
import type { Permission } from '../modules/rbac/permissions.js';

/**
 * Route gate (default deny). Record scope is then applied by the service.
 * Use after `authenticate`: router.get('/orders', authorize('orders.read'), handler)
 */
export function authorize(permission: Permission): RequestHandler & { permission: Permission } {
  const gate: RequestHandler = (_req, res, next) => {
    const auth = res.locals.auth;
    if (!auth) return next(unauthorized());
    if (checkPermission(auth, permission)) return next();
    next(forbidden());
  };
  // Tagged so the route test can read which permission guards each route.
  return Object.assign(gate, { permission });
}

/** The signed-in caller; only valid after `authenticate`. */
export function authOf(res: Response): AuthContext {
  const auth = res.locals.auth;
  if (!auth) throw unauthorized();
  return auth;
}
```

### 5.4 Hook into authentication

In the project's existing `authenticate` middleware, after the token or session is verified and the user id is known, add:

```ts
import { loadAuthContext } from '../modules/rbac/access.js';

// ...token verified; `userId` is the signed-in account...
const auth = await loadAuthContext(db, userId);
if (!auth) return next(unauthorized('Session expired or invalid — sign in again'));
res.locals.auth = auth;
next();
```

Then make the app accept `authenticate` as a dependency, so the tests can pass a fake one ([7.2](#72-route-gate-tests)):

```ts
// src/app.ts
import express, { Router, type RequestHandler } from 'express';
import { errorHandler } from './lib/http-errors.js';
import type { Db } from './lib/db.js';
import { createRbacRouter } from './modules/rbac/routes.js';

export function createApp(deps: { db: Db; authenticate: RequestHandler }) {
  const app = express();
  app.use(express.json());

  const api = Router();
  // Public routes (health, login, refresh, logout) go on `api` BEFORE authenticate.
  api.get('/health', (_req, res) => { res.json({ ok: true }); });
  api.use(deps.authenticate); // every route below needs a signed-in user
  api.use(createRbacRouter(deps.db));
  // api.use(createOrdersRouter(deps.db)); ...the project's other routers

  app.use('/api', api); // mount every router through this one prefix (the route test relies on it)
  app.use(errorHandler);
  return app;
}
```

### 5.5 The role-assignment service

```ts
// src/modules/rbac/service.ts
// Scoped role assignments: grant, change scope or expiry, revoke, list.

import { z } from 'zod';
import { Prisma, type AppRole, type ScopeType } from '../../generated/prisma/client.js';
import type { Db, DbClient } from '../../lib/db.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import { lockAdminChanges, otherSystemAdmins, scopeCovers, unitScope, unitsOfScope, type AuthContext } from './access.js';

/** Roles that may grant roles (and must cover the scope they grant). */
const GRANTER_ROLES: readonly AppRole[] = ['ADMIN'];
const DAY_MS = 24 * 3600_000;

/** Longest allowed assignment per role, in days. Example values: set the project's own. */
export const MAX_EXPIRY_DAYS: Record<AppRole, number> = { MANAGER: 90, ADMIN: 365 };

// USER is implicit and not grantable, so it is not in this enum.
const Role = z.enum(['ADMIN', 'MANAGER']);
const Scope = z.enum(['SYSTEM', 'DEPARTMENT', 'UNIT']);
const ScopeIds = z.array(z.number().int().positive()).max(200).transform((ids) => [...new Set(ids)].sort((a, b) => a - b));

export const GrantBody = z.strictObject({
  userId: z.number().int().positive(),
  role: Role,
  scopeType: Scope,
  scopeIds: ScopeIds,
  reason: z.string().trim().min(20, 'A grant needs a reason of at least 20 characters').max(1000),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export const UpdateBody = z.strictObject({
  scopeType: Scope.optional(),
  scopeIds: ScopeIds.optional(),
  reason: z.string().trim().min(20, 'A reason must be at least 20 characters').max(1000),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export const RevokeBody = z.strictObject({
  reason: z.string().trim().min(10, 'A revocation needs a reason of at least 10 characters').max(1000),
});
export const ListQuery = z.strictObject({
  userId: z.coerce.number().int().positive().optional(),
  role: Role.optional(),
  scopeType: Scope.optional(),
  active: z.enum(['true', 'false']).optional(),
});

export type GrantInput = z.infer<typeof GrantBody>;
export type UpdateInput = z.infer<typeof UpdateBody>;

/** Writes one audit entry inside the same transaction. No-op until the project has an audit log. */
export type AuditFn = (tx: DbClient, entry: { actorUserId: number; action: string; resourceId: number; changes: unknown }) => Promise<void>;

const forbid = (code: string, message: string) => new HttpError(403, code, message);

function assertScopeShape(scopeType: ScopeType, scopeIds: number[]) {
  if (scopeType === 'SYSTEM' && scopeIds.length > 0) throw new HttpError(400, 'SCOPE_INVALID', 'SYSTEM scope must not list departments or units');
  if (scopeType !== 'SYSTEM' && scopeIds.length === 0) throw new HttpError(400, 'SCOPE_INVALID', 'DEPARTMENT and UNIT scopes need at least one id');
}

function assertExpiry(role: AppRole, expiresAt: string | null | undefined, now: Date) {
  if (!expiresAt) return;
  const t = new Date(expiresAt).getTime();
  if (t <= now.getTime()) throw new HttpError(400, 'EXPIRY_INVALID', 'The expiry must be in the future');
  if (t - now.getTime() > MAX_EXPIRY_DAYS[role] * DAY_MS) {
    throw new HttpError(400, 'EXPIRY_INVALID', `A ${role} assignment can last at most ${MAX_EXPIRY_DAYS[role]} days`);
  }
}

/** A dangling id would silently grant nothing, so every id must exist. */
async function assertScopeTargetsExist(db: DbClient, scopeType: ScopeType, scopeIds: number[]) {
  if (scopeType === 'SYSTEM') return;
  const found = scopeType === 'UNIT'
    ? await db.unit.count({ where: { id: { in: scopeIds } } })
    : await db.department.count({ where: { id: { in: scopeIds } } });
  if (found !== scopeIds.length) throw new HttpError(422, 'SCOPE_TARGET_NOT_FOUND', 'One or more departments or units in the scope do not exist');
}

/** The granter must cover the scope. Only a system-wide granter gives SYSTEM scope. */
async function assertCovers(db: DbClient, auth: AuthContext, scopeType: ScopeType, scopeIds: number[]) {
  const mine = auth.grants.filter((g) => GRANTER_ROLES.includes(g.role));
  if (mine.some((g) => g.scopeType === 'SYSTEM')) return;
  if (scopeType === 'SYSTEM') throw forbid('SCOPE_NOT_COVERED', 'Only a system-wide administrator can assign SYSTEM scope');
  if (scopeType === 'DEPARTMENT') {
    const myDepts = new Set(mine.filter((g) => g.scopeType === 'DEPARTMENT').flatMap((g) => g.scopeIds));
    if (!scopeIds.every((id) => myDepts.has(id))) throw forbid('SCOPE_NOT_COVERED', 'You do not hold every department in this scope');
    return;
  }
  if (!scopeCovers(await unitScope(db, auth, GRANTER_ROLES), scopeIds)) throw forbid('SCOPE_NOT_COVERED', 'You do not cover every unit in this scope');
}

/** Unique index hit. Prisma 7 driver adapters may report it as SQLSTATE 23505 instead of P2002. */
const isUniqueViolation = (e: unknown) => {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const cause = (e.meta?.driverAdapterError as { cause?: { originalCode?: string } } | undefined)?.cause;
  return e.code === 'P2002' || cause?.originalCode === '23505';
};
const alreadyAssigned = () => new HttpError(409, 'ROLE_ALREADY_ASSIGNED', 'This user already has an active assignment of this role and scope type — change it instead');
const lastAdmin = () => new HttpError(409, 'LAST_SYSTEM_ADMIN', 'The last system-wide administrator cannot be removed');

export function createRoleAssignmentService(db: Db, audit: AuditFn = async () => {}) {
  async function list(auth: AuthContext, q: z.infer<typeof ListQuery>) {
    const now = new Date();
    const active = { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
    const inactive = { OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: now } }] };
    const rows = await db.roleAssignment.findMany({
      where: {
        ...(q.userId ? { userId: q.userId } : {}),
        ...(q.role ? { role: q.role } : {}),
        ...(q.scopeType ? { scopeType: q.scopeType } : {}),
        ...(q.active === 'true' ? active : q.active === 'false' ? inactive : {}),
      },
      include: { user: { select: { email: true, displayName: true } }, grantedBy: { select: { displayName: true } } },
      orderBy: { grantedAt: 'desc' },
      take: 500,
    });
    // A scoped administrator sees only assignments inside their own scope.
    const scope = await unitScope(db, auth, GRANTER_ROLES);
    const visible = [];
    for (const r of rows) {
      const units = await unitsOfScope(db, r.scopeType, r.scopeIds);
      if (units === 'ALL' ? scope.all : scopeCovers(scope, units)) visible.push(r);
    }
    return {
      items: visible.map((r) => ({ ...r, active: r.revokedAt === null && (r.expiresAt === null || r.expiresAt > now) })),
      total: visible.length,
    };
  }

  async function grant(auth: AuthContext, input: GrantInput) {
    if (input.userId === auth.user.id) throw forbid('SELF_GRANT_FORBIDDEN', 'You cannot grant a role to yourself');
    assertScopeShape(input.scopeType, input.scopeIds);
    assertExpiry(input.role, input.expiresAt, new Date());
    try {
      return await db.$transaction(async (tx) => {
        const target = await tx.user.findUnique({ where: { id: input.userId }, select: { isActive: true } });
        if (!target) throw new HttpError(422, 'USER_NOT_FOUND', 'The account does not exist');
        if (!target.isActive) throw new HttpError(422, 'USER_INACTIVE', 'Roles cannot be granted to a deactivated account');
        await assertScopeTargetsExist(tx, input.scopeType, input.scopeIds);
        await assertCovers(tx, auth, input.scopeType, input.scopeIds);
        const created = await tx.roleAssignment.create({
          data: {
            userId: input.userId, role: input.role, scopeType: input.scopeType, scopeIds: input.scopeIds,
            reason: input.reason, grantedById: auth.user.id, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          },
        });
        await audit(tx, { actorUserId: auth.user.id, action: 'ROLE_GRANTED', resourceId: created.id, changes: input });
        return { id: created.id };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw alreadyAssigned();
      throw e;
    }
  }

  async function update(auth: AuthContext, id: number, input: UpdateInput) {
    try {
      return await db.$transaction(async (tx) => {
        await lockAdminChanges(tx); // narrowing a system-wide ADMIN could remove the last one
        const existing = await tx.roleAssignment.findUnique({ where: { id } });
        if (!existing || existing.revokedAt) throw notFound('Assignment not found or already revoked');
        if (existing.userId === auth.user.id) throw forbid('SELF_UPDATE_FORBIDDEN', 'You cannot change your own assignment');
        const scopeType = input.scopeType ?? existing.scopeType;
        // Changing the scope type without new ids clears the ids (and fails the shape check unless SYSTEM).
        const scopeIds = input.scopeIds ?? (input.scopeType && input.scopeType !== existing.scopeType ? [] : existing.scopeIds);
        assertScopeShape(scopeType, scopeIds);
        assertExpiry(existing.role, input.expiresAt, new Date());
        await assertScopeTargetsExist(tx, scopeType, scopeIds);
        await assertCovers(tx, auth, existing.scopeType, existing.scopeIds); // may touch it at all
        await assertCovers(tx, auth, scopeType, scopeIds); // and may give it the new scope
        const losesSystemAdmin = existing.role === 'ADMIN' && existing.scopeType === 'SYSTEM' && scopeType !== 'SYSTEM';
        if (losesSystemAdmin && (await otherSystemAdmins(tx, { assignmentId: id })) === 0) throw lastAdmin();

        const updated = await tx.roleAssignment.update({
          where: { id },
          data: {
            scopeType, scopeIds, reason: input.reason,
            ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } : {}),
          },
        });
        await audit(tx, {
          actorUserId: auth.user.id, action: 'ROLE_UPDATED', resourceId: id,
          changes: { before: { scopeType: existing.scopeType, scopeIds: existing.scopeIds, expiresAt: existing.expiresAt }, after: { scopeType, scopeIds, expiresAt: updated.expiresAt }, reason: input.reason },
        });
        return { id };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw alreadyAssigned();
      throw e;
    }
  }

  async function revoke(auth: AuthContext, id: number, reason: string) {
    await db.$transaction(async (tx) => {
      await lockAdminChanges(tx); // two revokes at once must not remove the last admin
      const existing = await tx.roleAssignment.findUnique({ where: { id } });
      if (!existing || existing.revokedAt) throw notFound('Assignment not found or already revoked');
      if (existing.userId === auth.user.id) throw forbid('SELF_REVOKE_FORBIDDEN', 'You cannot revoke your own role — another administrator must');
      await assertCovers(tx, auth, existing.scopeType, existing.scopeIds);
      if (existing.role === 'ADMIN' && existing.scopeType === 'SYSTEM' && (await otherSystemAdmins(tx, { assignmentId: id })) === 0) throw lastAdmin();
      await tx.roleAssignment.update({ where: { id }, data: { revokedAt: new Date(), revokedById: auth.user.id, revokeReason: reason } });
      await audit(tx, { actorUserId: auth.user.id, action: 'ROLE_REVOKED', resourceId: id, changes: { userId: existing.userId, role: existing.role, reason } });
    });
  }

  return { list, grant, update, revoke };
}

export type RoleAssignmentService = ReturnType<typeof createRoleAssignmentService>;
```

**Account deactivation** (in the project's own accounts code) must also protect the last admin. Inside its transaction:

```ts
await lockAdminChanges(tx);
if (holdsSystemAdmin && (await otherSystemAdmins(tx, { userId })) === 0) {
  throw new HttpError(409, 'LAST_SYSTEM_ADMIN', 'The last system-wide administrator cannot be deactivated');
}
```

### 5.6 Routes and `/auth/me`

```ts
// src/modules/rbac/routes.ts
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { allowedPermissions, effectiveRoles } from './access.js';
import { PERMISSIONS } from './permissions.js';
import { createRoleAssignmentService, GrantBody, ListQuery, RevokeBody, UpdateBody, type AuditFn } from './service.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });

export function createRbacRouter(db: Db, audit?: AuditFn) {
  const router = Router();
  const roles = createRoleAssignmentService(db, audit);

  // The caller's own access: what the frontend uses to hide menus and buttons.
  // Any signed-in user (no permission gate; listed as own-data in the route test).
  router.get('/auth/me', (_req, res) => {
    const auth = authOf(res);
    res.json({ user: auth.user, roles: auth.grants, effectiveRoles: effectiveRoles(auth), permissions: allowedPermissions(auth) });
  });

  router.get('/roles/matrix', authorize('matrix.read'), (_req, res) => {
    res.json({ permissions: PERMISSIONS });
  });
  router.get('/role-assignments', authorize('roles.read'), async (req, res) => {
    res.json(await roles.list(authOf(res), ListQuery.parse(req.query)));
  });
  router.post('/role-assignments', authorize('roles.write'), async (req, res) => {
    res.status(201).json(await roles.grant(authOf(res), GrantBody.parse(req.body)));
  });
  router.patch('/role-assignments/:id', authorize('roles.write'), async (req, res) => {
    res.json(await roles.update(authOf(res), IdParam.parse(req.params).id, UpdateBody.parse(req.body)));
  });
  router.post('/role-assignments/:id/revoke', authorize('roles.write'), async (req, res) => {
    await roles.revoke(authOf(res), IdParam.parse(req.params).id, RevokeBody.parse(req.body).reason);
    res.status(204).end();
  });

  return router;
}
```

If the project already has a `/auth/me` route, add `roles`, `effectiveRoles` and `permissions` to its response instead of adding a second one.

| Method | Path | Permission | Answers |
| :--- | :--- | :--- | :--- |
| GET | `/api/auth/me` | signed in | `{ user, roles, effectiveRoles, permissions }` |
| GET | `/api/roles/matrix` | `matrix.read` | The permission table |
| GET | `/api/role-assignments?userId=&role=&scopeType=&active=` | `roles.read` | `{ items, total }`, inside the caller's scope |
| POST | `/api/role-assignments` | `roles.write` | 201 `{ id }` |
| PATCH | `/api/role-assignments/:id` | `roles.write` | 200 `{ id }` |
| POST | `/api/role-assignments/:id/revoke` | `roles.write` | 204 |

Error codes: `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `SCOPE_NOT_COVERED` 403, `SELF_GRANT_FORBIDDEN` / `SELF_UPDATE_FORBIDDEN` / `SELF_REVOKE_FORBIDDEN` 403, `SCOPE_INVALID` / `EXPIRY_INVALID` / `INVALID_REQUEST` 400, `USER_NOT_FOUND` / `USER_INACTIVE` / `SCOPE_TARGET_NOT_FOUND` 422, `ROLE_ALREADY_ASSIGNED` / `LAST_SYSTEM_ADMIN` 409, `NOT_FOUND` 404.

### 5.7 Using scope in a feature service

The route gate answers "may this role list orders at all?". The service answers "which orders?". Example for a table with a `unitId` column:

```ts
import type { Db } from '../../lib/db.js';
import { forbidden, notFound } from '../../lib/http-errors.js';
import { scopeCovers, unitScope, unitWhere, type AuthContext } from '../rbac/access.js';

const ORDER_ROLES = ['ADMIN', 'MANAGER'] as const; // the roles of 'orders.read'

export async function listOrders(db: Db, auth: AuthContext) {
  const scope = await unitScope(db, auth, ORDER_ROLES);
  return db.order.findMany({ where: { ...unitWhere(scope) } });
}

export async function getOrder(db: Db, auth: AuthContext, id: number) {
  const order = await db.order.findUnique({ where: { id } });
  const scope = await unitScope(db, auth, ORDER_ROLES);
  // Out of scope answers the same as missing, so the caller cannot learn that it exists.
  if (!order || !scopeCovers(scope, [order.unitId])) throw notFound();
  return order;
}

export async function moveOrder(db: Db, auth: AuthContext, id: number, toUnitId: number) {
  const order = await getOrder(db, auth, id);
  const scope = await unitScope(db, auth, ORDER_ROLES);
  // Both the old and the new unit must be in scope.
  if (!scopeCovers(scope, [order.unitId, toUnitId])) throw forbidden('SCOPE_NOT_COVERED', 'You do not cover the target unit');
  // ...update
}
```

**Own-data routes** (my profile, my orders) use a `USER` permission, or no gate plus an entry on the reviewed list ([7.2](#72-route-gate-tests)), and always filter by `auth.user.id`, never by an id from the request.

**Hospital-wide settings:** when an action needs system-wide scope (for example `settings.manage`), check it in the service: `if (!isSystemWide(auth, ['ADMIN'])) throw forbidden('SCOPE_NOT_COVERED', '...')`.

## 6. Frontend code

The frontend reads `/auth/me` and hides what the user cannot use. It never decides access.

### 6.1 Types and the `useMe` hook

```ts
// src/services/rbac.ts
import { useQuery } from '@tanstack/react-query';
import { http } from './http'; // the project's HTTP client (sends the token)

export type AppRole = 'ADMIN' | 'MANAGER';
export type EffectiveRole = AppRole | 'USER';
export type ScopeType = 'SYSTEM' | 'DEPARTMENT' | 'UNIT';
/** Permission names as in the backend table. In a monorepo, import the backend's `Permission` type instead. */
export type Permission = string;

export interface RoleGrant { id: number; role: AppRole; scopeType: ScopeType; scopeIds: number[]; expiresAt: string | null }
export interface Me {
  user: { id: number; email: string; displayName: string };
  roles: RoleGrant[];
  effectiveRoles: EffectiveRole[];
  permissions: Permission[];
}

export const ME_KEY = ['auth', 'me'] as const;

export function useMe() {
  return useQuery({ queryKey: ME_KEY, queryFn: () => http.get<Me>('/auth/me'), staleTime: 60_000 });
}
```

After a role change, call `queryClient.invalidateQueries({ queryKey: ME_KEY })`. A user whose own roles changed sees the new menu on the next refetch; the server applies the change at once either way.

### 6.2 `usePermissions`, `<Can>` and `<RequirePermission>`

```tsx
// src/hooks/usePermissions.ts
// UI-only helpers. They hide navigation and buttons a user cannot use;
// they are NEVER the protection: the backend authorizes every request.
import { useMe, type AppRole, type EffectiveRole, type Permission } from '../services/rbac';

export function usePermissions() {
  const { data: me, isLoading } = useMe();
  const permissions = new Set(me?.permissions ?? []);
  const roles = me?.effectiveRoles ?? [];
  return {
    isLoading,
    can: (permission: Permission) => permissions.has(permission),
    hasRole: (...wanted: EffectiveRole[]) => roles.some((r) => wanted.includes(r)),
    /** Holds one of these roles with SYSTEM scope (for hospital-wide settings screens). */
    systemWide: (...wanted: AppRole[]) => (me?.roles ?? []).some((g) => wanted.includes(g.role) && g.scopeType === 'SYSTEM'),
  };
}
```

```tsx
// src/components/Can.tsx
import type { ReactNode } from 'react';
import { usePermissions } from '../hooks/usePermissions';
import type { Permission } from '../services/rbac';

/** Renders children only when the user holds the permission. */
export function Can({ permission, children, fallback = null }: { permission: Permission; children: ReactNode; fallback?: ReactNode }) {
  const { can } = usePermissions();
  return <>{can(permission) ? children : fallback}</>;
}

/** Page guard: a friendly "no access" page instead of a page full of 403 errors. */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can, isLoading } = usePermissions();
  if (isLoading) return null;
  if (!can(permission)) return <p role="alert">You do not have access to this page.</p>;
  return <>{children}</>;
}
```

Usage:

```tsx
<Can permission="orders.write">
  <Button onClick={create}>New order</Button>
</Can>
```

### 6.3 Menu and routes from one list

Keep one list of pages, so a page cannot be in the router without being in the menu (or the other way round):

```tsx
// src/app/modules.tsx
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { Permission } from '../services/rbac';

export interface AppModule {
  path: string;
  label: string; // or an i18n key
  /** Shown only to users holding this permission (UI hint; the server enforces). */
  requires?: Permission;
  Page: LazyExoticComponent<ComponentType>;
}

export const MODULES: AppModule[] = [
  { path: '/', label: 'Dashboard', Page: lazy(() => import('../modules/dashboard/DashboardPage')) },
  { path: '/orders', label: 'Orders', requires: 'orders.read', Page: lazy(() => import('../modules/orders/OrdersPage')) },
  { path: '/admin/roles', label: 'Roles', requires: 'roles.read', Page: lazy(() => import('../modules/rbac/RolesPage')) },
];

export const isVisible = (m: AppModule, can: (p: Permission) => boolean) => !m.requires || can(m.requires);
```

Build the menu from `MODULES.filter((m) => isVisible(m, can))`, and wrap each routed page in `<RequirePermission>` when it has `requires`.

### 6.4 Handling 403 from the API

When an action answers 403, show the `message` from the error body (it is written for users) and refetch `/auth/me`, because the user's roles may have changed since the page loaded.

### 6.5 Roles admin screen (outline)

A page at `/admin/roles` (permission `roles.read`; the buttons need `roles.write`):

- Table from `GET /role-assignments?active=true`: user, role, scope type, scope (department or unit names), expiry, granted by, reason.
- **Grant** form: user, role, scope type, departments or units (multi-select, hidden for `SYSTEM`), expiry (date, limited to the role's maximum), reason (at least 20 characters).
- Row actions: **Change** (scope, expiry, reason) and **Revoke** (reason, at least 10 characters), with a confirmation.
- Hide the actions on the signed-in user's own rows (the server refuses them anyway).
- After a successful change, invalidate the assignments list and `ME_KEY`.

## 7. Tests

Vitest + Supertest. Three layers: pure functions (fast, no database), the route gates (no database), and the service rules (needs a test database).

### 7.1 Pure function tests

```ts
// test/rbac-access.test.ts
import { describe, expect, it } from 'vitest';
import { allowedPermissions, checkPermission, effectiveRoles, scopeCovers, type AuthContext, type Grant } from '../src/modules/rbac/access.js';

const user = { id: 1, email: 'a@example.test', displayName: 'A' };
const authWith = (...grants: Partial<Grant>[]): AuthContext => ({
  user,
  grants: grants.map((g, i) => ({ id: i + 1, role: 'MANAGER', scopeType: 'UNIT', scopeIds: [1], expiresAt: null, ...g })),
});

describe('permissions', () => {
  it('every signed-in user is USER', () => {
    expect(effectiveRoles(authWith())).toEqual(['USER']);
  });
  it('allows only the listed roles (default deny)', () => {
    expect(checkPermission(authWith(), 'matrix.read')).toBe(true);
    expect(checkPermission(authWith(), 'roles.write')).toBe(false);
    expect(checkPermission(authWith({ role: 'MANAGER' }), 'roles.write')).toBe(false);
    expect(checkPermission(authWith({ role: 'ADMIN', scopeType: 'SYSTEM', scopeIds: [] }), 'roles.write')).toBe(true);
  });
  it('allowedPermissions lists exactly what checkPermission allows', () => {
    const auth = authWith({ role: 'MANAGER' });
    // 'orders.read' is an example permission: use one of the project's own MANAGER permissions.
    expect(allowedPermissions(auth)).toContain('orders.read');
    expect(allowedPermissions(auth)).not.toContain('roles.write');
  });
});

describe('scopeCovers', () => {
  it('SYSTEM covers everything', () => {
    expect(scopeCovers({ all: true }, [1, 2, 99])).toBe(true);
  });
  it('a unit scope must cover every unit asked for', () => {
    const scope = { all: false as const, unitIds: new Set([1, 2]) };
    expect(scopeCovers(scope, [1])).toBe(true);
    expect(scopeCovers(scope, [1, 3])).toBe(false);
  });
});
```

### 7.2 Route gate tests

These fail when someone adds a route without a permission, adds a permission no route uses, or the gates stop matching the table. They build the app with a **fake** `authenticate` that signs in a persona, so no database is needed: an allowed request reaches the handler (and may then fail on validation or the dummy database, which is fine); a denied one stops at the gate with 403 `FORBIDDEN`.

```ts
// test/route-matrix.test.ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express, RequestHandler } from 'express';
import { createApp } from '../src/app.js';
import type { Db } from '../src/lib/db.js';
import type { AuthContext } from '../src/modules/rbac/access.js';
import { PERMISSIONS, type EffectiveRole, type Permission } from '../src/modules/rbac/permissions.js';

/** Routes that need no sign-in. Reviewed list: add here only on purpose. */
const PUBLIC = new Set(['GET /api/health']);
/** Signed-in routes without a gate: the service limits them to the caller's own data. Reviewed list. */
const OWN_DATA = ['GET /api/auth/me'].sort();

interface RouteInfo { method: string; path: string; permission: Permission | null }
type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { permission?: Permission } }> };
  handle?: { stack?: Layer[] };
};

/** Every route with its path and gate. Assumes all routers hang off the one '/api' router (see app.ts). */
function routesOf(app: Express): RouteInfo[] {
  const out: RouteInfo[] = [];
  const walk = (stack: Layer[], prefix: string) => {
    for (const l of stack) {
      if (l.route) {
        const permission = l.route.stack.map((s) => s.handle.permission).find((p) => p !== undefined) ?? null;
        for (const m of Object.keys(l.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + l.route.path, permission });
      } else if (l.handle?.stack) {
        // Express 5 does not expose mount paths; everything is mounted under '/api'.
        walk(l.handle.stack, '/api');
      }
    }
  };
  walk((app as unknown as { router: { stack: Layer[] } }).router.stack, '');
  return out;
}

// A dummy database: allowed requests that reach a service fail there, which is not a gate answer.
const db = new Proxy({}, { get: () => { throw new Error('no database in this test'); } }) as unknown as Db;

const personas: Record<string, AuthContext | null> = {
  ANONYMOUS: null,
  USER: { user: { id: 1, email: 'u@example.test', displayName: 'U' }, grants: [] },
  MANAGER: { user: { id: 2, email: 'm@example.test', displayName: 'M' }, grants: [{ id: 1, role: 'MANAGER', scopeType: 'UNIT', scopeIds: [1], expiresAt: null }] },
  ADMIN: { user: { id: 3, email: 'a@example.test', displayName: 'A' }, grants: [{ id: 2, role: 'ADMIN', scopeType: 'SYSTEM', scopeIds: [], expiresAt: null }] },
};

const fakeAuthenticate = (auth: AuthContext | null): RequestHandler => (_req, res, next) => {
  if (!auth) return void res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
  res.locals.auth = auth;
  next();
};

const appAs = (persona: keyof typeof personas) => createApp({ db, authenticate: fakeAuthenticate(personas[persona] ?? null) });
const concrete = (path: string) => path.replace(/:\w+/g, '999999');
const send = (app: Express, r: RouteInfo) => request(app)[r.method.toLowerCase() as 'get'](concrete(r.path)).send({});

describe('route security matrix', () => {
  const routes = routesOf(appAs('USER'));

  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('every non-public route answers 401 without a sign-in', async () => {
    const app = appAs('ANONYMOUS');
    const leaks: string[] = [];
    for (const r of routes.filter((x) => !PUBLIC.has(`${x.method} ${x.path}`))) {
      const res = await send(app, r);
      if (res.status !== 401) leaks.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('routes without a gate are exactly the reviewed own-data list', () => {
    const ungated = routes.filter((r) => r.permission === null && !PUBLIC.has(`${r.method} ${r.path}`)).map((r) => `${r.method} ${r.path}`).sort();
    expect(ungated).toEqual(OWN_DATA);
  });

  it('every permission guards at least one route', () => {
    const used = new Set(routes.map((r) => r.permission));
    expect((Object.keys(PERMISSIONS) as Permission[]).filter((p) => !used.has(p))).toEqual([]);
  });

  it.each(['USER', 'MANAGER', 'ADMIN'] as const)('%s gets exactly what permissions.ts grants', async (persona) => {
    const app = appAs(persona);
    const roles: EffectiveRole[] = ['USER', ...personas[persona]!.grants.map((g) => g.role)];
    const wrong: string[] = [];
    for (const r of routes.filter((x) => x.permission)) {
      const res = await send(app, r);
      const gate = res.status === 403 && res.body?.error?.code === 'FORBIDDEN' ? 'DENY' : 'ALLOW';
      const allowed: readonly EffectiveRole[] = PERMISSIONS[r.permission!];
      const want = roles.some((x) => allowed.includes(x)) ? 'ALLOW' : 'DENY';
      if (gate !== want) wrong.push(`${r.method} ${r.path} [${r.permission}] → ${gate}, expected ${want}`);
    }
    expect(wrong).toEqual([]);
  });
});
```

The test "every permission guards at least one route" fails while the example permissions (`orders.*`, `reports.read`, `settings.manage`) have no routes. Replace them with the project's real permissions, or delete them.

### 7.3 Service rules (test database)

Run against a separate, migrated test database (`TEST_DATABASE_URL`). Cover at least:

| Case | Expect |
| :--- | :--- |
| Admin grants a role to themselves | 403 `SELF_GRANT_FORBIDDEN` |
| `SYSTEM` scope with ids, or `UNIT` with none | 400 `SCOPE_INVALID` |
| Expiry in the past, or longer than the role's maximum | 400 `EXPIRY_INVALID` |
| Unit id that does not exist | 422 `SCOPE_TARGET_NOT_FOUND` |
| Department admin grants `SYSTEM` scope, or a unit outside their departments | 403 `SCOPE_NOT_COVERED` |
| Department admin grants a unit inside their department | 201 |
| Same user + role + scope type granted twice | 409 `ROLE_ALREADY_ASSIGNED` |
| Revoke, or narrow, the only system-wide `ADMIN` | 409 `LAST_SYSTEM_ADMIN` |
| Two revokes of the last two system-wide admins at the same time | Exactly one succeeds |
| A revoked or expired assignment | Next request: 403 on a route that needed it |
| A scoped admin lists assignments | Only those inside their scope |
| A scoped manager lists orders | Only orders of their units; another unit's order answers 404 |

### 7.4 Optional: the docs equal the code

If the project documents the permission table in `docs/RBAC.md` as rows like ``| `orders.read` | ADMIN, MANAGER | List orders |``, this test keeps the two from drifting:

```ts
// test/docs.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../src/modules/rbac/permissions.js';

describe('docs/RBAC.md', () => {
  it('lists exactly the permissions and roles of permissions.ts', () => {
    // From backend/test/ to the repository's docs/ folder: adjust to the project's layout.
    const md = readFileSync(new URL('../../docs/RBAC.md', import.meta.url), 'utf8');
    const rows = [...md.matchAll(/^\| `([\w.]+)` \| ([A-Z_, ]+) \|/gm)].map((m) => [m[1]!, m[2]!.split(',').map((r) => r.trim()).sort()] as const);
    const documented = Object.fromEntries(rows);
    expect(rows.length, 'a permission is listed twice').toBe(Object.keys(documented).length);
    expect(documented).toEqual(Object.fromEntries(Object.entries(PERMISSIONS).map(([p, r]) => [p, [...r].sort()])));
  });
});
```

## 8. How to add a permission

1. **Table.** Add `'area.action': ['ROLE', ...]` to `PERMISSIONS` in `permissions.ts`.
2. **Route.** Put `authorize('area.action')` on the route.
3. **Scope.** In the service, filter or check rows with `unitScope()` / `scopeCovers()` (or `auth.user.id` for own data).
4. **UI.** Hide the button or page with `<Can permission="area.action">` or `requires: 'area.action'`. Update `docs/RBAC.md` if you keep one, then run the tests.

Adding a **role**: add it to the `AppRole` enum (and a migration), to the zod `Role` enum and `MAX_EXPIRY_DAYS` in `service.ts`, to the frontend `AppRole` type, to the permissions it should hold, and a persona in the route test.

## 9. Optional add-ons

Not part of this kit. Add them only when the project needs them. Each is a pattern from the original system.

- **Admin elevation (PAM).** A system-admin assignment is *dormant*: it counts only during a short, audited elevation the admin starts themselves (for example 30 minutes, with a reason). Store elevations in a `privileged_sessions` table; `loadAuthContext` keeps all grants but builds an `effective` list that drops the admin grant unless an elevation is active. `checkPermission` reads `effective` and answers a third value, `NEEDS_ELEVATION`, when a dormant admin grant would have allowed it; `authorize` maps it to 403 `PAM_ELEVATION_REQUIRED`, so the UI can offer an **Elevate** button.
- **Four-eyes approval.** Sensitive grants (a system-wide admin) create a row in `approval_requests` instead of the assignment, and answer 202 `{ status: 'PENDING_APPROVAL', requestId }`. A **different** admin approves it; the grant is then written, as the approver, inside the approval's transaction. A partial unique index stops the same person opening two identical pending requests. Re-run every grant check at approval time.
- **Tamper-evident audit log.** Pass a real `AuditFn` to the service that writes to an append-only `audit_entries` table in the same transaction. In the original, a SQL function chains each row's hash to the previous one under an advisory lock, and a trigger rejects every `UPDATE` and `DELETE` on the table.
- **Break-glass account.** One emergency account whose sign-in grants a temporary, fully audited system-wide admin, bypassing elevation and four-eyes, with a hard time limit (for example 4 hours).

## 10. Done checklist

- [ ] `AppRole` and `ScopeType` enums, `RoleAssignment` model, and the hand-written SQL are in one migration, applied with `prisma migrate dev`.
- [ ] The first admin exists, system-wide, with no expiry.
- [ ] `permissions.ts` holds the project's real permissions; no example permission is left without a route.
- [ ] The existing `authenticate` calls `loadAuthContext` and sets `res.locals.auth`; a deactivated account gets 401.
- [ ] **Every** route has `authorize(...)`, or is on the reviewed `PUBLIC` or `OWN_DATA` list in the route test.
- [ ] Every service that reads or writes unit-owned rows filters by `unitScope()`; out-of-scope records answer 404.
- [ ] `/auth/me` returns `roles`, `effectiveRoles` and `permissions`.
- [ ] The frontend menu, pages and buttons use `usePermissions()`, `<Can>` or `requires`; nothing in the frontend is relied on for security.
- [ ] Pure tests, route gate tests and the service-rule tests pass; the type checker passes.
- [ ] The user has been told what was adapted (names, scope levels, id types) and which add-ons were left out.
