// Database privilege separation (spec §10.7, ops/db). Runs ops/db/01_roles.sql
// and 02_grants.sql on brand-new databases with uniquely named roles, then
// checks what each role can and cannot do — and that the application works as
// the runtime role. Needs a test login that may create roles (CI's is a
// superuser); skipped otherwise, with the reason in the test name.

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { bootstrapAdministrators } from '../src/cli/bootstrap.js';
import { findChainBreaks } from '../src/lib/audit.js';
import { assertRuntimeRole, runtimeRoleProblems } from '../src/lib/db-role.js';
import { createPasswordService } from '../src/lib/passwords.js';
import { createPrisma, type Db } from '../src/lib/prisma.js';
import { applyBaseline, parseBaseline } from '../src/modules/administration/baseline-import.js';
import { createEmptyDatabase, migrateDeploy } from './fresh-db.js';
import { signIn, TEST_URL, testApp } from './helpers.js';

const OPS = resolve(__dirname, '../../ops/db');
const ROLES = ['migration', 'runtime', 'backup', 'audit_reader'] as const;
type Role = (typeof ROLES)[number];

const prefix = `t${randomBytes(3).toString('hex')}`;
const roleName = (r: Role) => `${prefix}_${r}`;
/** The ops scripts with this run's role names, so tests never touch real nurseapp_* roles. */
const script = (file: string) => readFileSync(resolve(OPS, file), 'utf8')
  .replace(/\bnurseapp_(migration|runtime|backup|audit_reader)\b/g, (_, r: Role) => roleName(r));
const secret = Object.fromEntries(ROLES.map((r) => [r, randomBytes(12).toString('hex')])) as Record<Role, string>;

function urlAs(base: string, role: Role) {
  const u = new URL(base);
  u.username = roleName(role);
  u.password = secret[role];
  return u.toString();
}
async function run(url: string, sql: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await c.query(sql); } finally { await c.end(); }
}
/** Resolves to the SQLSTATE of the refusal, or 'ok'. */
async function attempt(url: string, sql: string) {
  try { await run(url, sql); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? String(e); }
}
const DENIED = '42501'; // insufficient_privilege (also "must be owner")

async function canCreateRoles() {
  if (!TEST_URL) return false;
  const r = await run(TEST_URL, `SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user`);
  return r.rows[0]?.ok === true;
}
const allowed = await canCreateRoles();
const describeRoles = allowed ? describe : describe.skip;

async function provision(dbUrl: string) {
  await run(dbUrl, script('01_roles.sql'));
  for (const r of ROLES) await run(dbUrl, `ALTER ROLE ${roleName(r)} PASSWORD '${secret[r]}'`);
  await run(dbUrl, script('02_grants.sql'));
}

describeRoles(`database roles (spec §10.7)${allowed ? '' : ' — skipped: the test login cannot create roles'}`, () => {
  const drops: Array<() => Promise<void>> = [];
  // DROP DATABASE waits for a checkpoint: seconds each late in a full run, when the server has many dirty buffers.
  afterAll(async () => {
    for (const d of drops.reverse()) await d();
    for (const r of [...ROLES].reverse()) await run(TEST_URL!, `DROP ROLE IF EXISTS ${roleName(r)}`);
  }, 60_000);

  describe('fresh installation: roles first, migrations as the migration role', () => {
    let base: string;
    let runtime: Db;
    beforeAll(async () => {
      const empty = await createEmptyDatabase(TEST_URL!, 'nurseapp_roles');
      drops.push(empty.drop);
      base = empty.url;
      await provision(base);
      migrateDeploy(urlAs(base, 'migration'));
      await run(base, script('02_grants.sql')); // the post-migration step
      runtime = createPrisma(urlAs(base, 'runtime'));
      drops.push(async () => { await runtime.$disconnect(); });
    }, 180_000);

    it('the migration role owns every table, view, type and function it created', async () => {
      const owners = await run(base, `
        SELECT DISTINCT pg_get_userbyid(relowner) AS o FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND relkind IN ('r','v','S')
        UNION SELECT DISTINCT pg_get_userbyid(typowner) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public' AND typtype = 'e'
        UNION SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`);
      expect(owners.rows.map((r) => r.o)).toEqual([roleName('migration')]);
    });

    it('the application works as the runtime role: bootstrap, baseline, sign-in, a four-eyes request, the audit chain', async () => {
      const input = {
        systemAdmin: { email: 'sa@roles.example', displayName: 'SA', password: 'roles-test-password-1' },
        hrAdmin: { email: 'hr@roles.example', displayName: 'HR', password: 'roles-test-password-2' },
      };
      const out = await bootstrapAdministrators(runtime, input, createPasswordService(4));
      const baseline = parseBaseline(JSON.parse(readFileSync(resolve(__dirname, '../prisma/baseline/aigh-baseline.json'), 'utf8')));
      await runtime.$transaction((tx) => applyBaseline(tx, out.systemAdminId, baseline, 'Role separation test', null), { timeout: 120_000 });
      expect(await runtime.unit.count()).toBe(55);

      const hr = await signIn(testApp(runtime), input.hrAdmin.email, input.hrAdmin.password);
      expect((await hr.get('/credential-templates')).body.items).toHaveLength(17); // the baseline's 16 + National ID (owner decision 2026-10-04)
      const asked = await hr.post('/credential-categories', { code: 'ROLE_TEST', name: 'Role test', reason: 'Checks writes as the runtime role' });
      expect(asked.status).toBe(202);
      expect(await findChainBreaks(runtime)).toEqual([]);
    }, 180_000);

    it('the runtime role cannot change the schema, truncate, rewrite audit or read the migration journal', async () => {
      const rt = urlAs(base, 'runtime');
      expect(await attempt(rt, `CREATE TABLE sneaky (id int)`)).toBe(DENIED);
      expect(await attempt(rt, `ALTER TABLE units ADD COLUMN sneaky int`)).toBe(DENIED);
      expect(await attempt(rt, `DROP TABLE units`)).toBe(DENIED);
      expect(await attempt(rt, `TRUNCATE employees`)).toBe(DENIED);
      expect(await attempt(rt, `UPDATE audit_entries SET action = 'X'`)).toBe(DENIED);
      expect(await attempt(rt, `DELETE FROM audit_entries`)).toBe(DENIED);
      expect(await attempt(rt, `DELETE FROM break_glass_events`)).toBe(DENIED);
      expect(await attempt(rt, `SELECT count(*) FROM _prisma_migrations`)).toBe(DENIED);
      expect(await attempt(rt, `SELECT count(*) FROM employees`)).toBe('ok');
      // The append-only triggers refuse with the same SQLSTATE, so check the privileges themselves too.
      const priv = await run(base, `SELECT
        has_table_privilege('${roleName('runtime')}', 'audit_entries', 'UPDATE') AS audit_update,
        has_table_privilege('${roleName('runtime')}', 'audit_entries', 'DELETE') AS audit_delete,
        has_table_privilege('${roleName('runtime')}', 'audit_entries', 'INSERT') AS audit_insert,
        has_table_privilege('${roleName('runtime')}', 'break_glass_events', 'DELETE') AS bg_delete,
        has_table_privilege('${roleName('runtime')}', 'break_glass_events', 'UPDATE') AS bg_update,
        has_table_privilege('${roleName('runtime')}', 'request_audit_log', 'UPDATE') AS rl_update,
        has_table_privilege('${roleName('runtime')}', 'request_audit_log', 'INSERT') AS rl_insert,
        has_table_privilege('${roleName('runtime')}', 'request_audit_log', 'DELETE') AS rl_delete,
        has_table_privilege('${roleName('runtime')}', 'data_subject_requests', 'DELETE') AS dsr_delete,
        has_table_privilege('${roleName('runtime')}', 'data_subject_requests', 'UPDATE') AS dsr_update`);
      expect(priv.rows[0]).toEqual({
        audit_update: false, audit_delete: false, audit_insert: true, bg_delete: false, bg_update: true,
        rl_update: false, rl_insert: true, rl_delete: true, // D-52: append-only; DELETE for the retention purge
        dsr_delete: false, dsr_update: true, // D-55: requests are a record; their status moves on
      });
    });

    it('the audit reader reads only audit; the backup role reads everything and writes nothing', async () => {
      const ar = urlAs(base, 'audit_reader');
      expect(await attempt(ar, `SELECT count(*) FROM audit_entries`)).toBe('ok');
      expect(await attempt(ar, `SELECT count(*) FROM audit_chain_breaks`)).toBe('ok');
      // D-45: the security-event tables, read-only.
      expect(await attempt(ar, `SELECT count(*) FROM break_glass_events`)).toBe('ok');
      expect(await attempt(ar, `SELECT count(*) FROM privileged_sessions`)).toBe('ok');
      expect(await attempt(ar, `SELECT count(*) FROM request_audit_log`)).toBe('ok'); // D-52
      expect(await attempt(ar, `DELETE FROM request_audit_log`)).toBe(DENIED);
      expect(await attempt(ar, `DELETE FROM privileged_sessions`)).toBe(DENIED);
      expect(await attempt(ar, `UPDATE break_glass_events SET ended_at = now()`)).toBe(DENIED);
      expect(await attempt(ar, `SELECT count(*) FROM employees`)).toBe(DENIED);
      expect(await attempt(ar, `SELECT count(*) FROM users`)).toBe(DENIED);
      expect(await attempt(ar, `INSERT INTO departments (code, name, updated_at) VALUES ('X', 'X', now())`)).toBe(DENIED);
      const bk = urlAs(base, 'backup');
      expect(await attempt(bk, `SELECT count(*) FROM users`)).toBe('ok');
      expect(await attempt(bk, `INSERT INTO departments (code, name, updated_at) VALUES ('X', 'X', now())`)).toBe(DENIED);
    });

    it('the migration role can alter the schema', async () => {
      const mg = urlAs(base, 'migration');
      expect(await attempt(mg, `ALTER TABLE units ADD COLUMN tmp_role_check int`)).toBe('ok');
      expect(await attempt(mg, `ALTER TABLE units DROP COLUMN tmp_role_check`)).toBe('ok');
    });

    it('production start-up accepts only a data-only login (runtime), never the migration role or a superuser', async () => {
      expect(await runtimeRoleProblems(runtime)).toEqual([]);
      await expect(assertRuntimeRole(runtime, true)).resolves.toBeUndefined();
      const migration = createPrisma(urlAs(base, 'migration'));
      const superuser = createPrisma(base);
      try {
        expect((await runtimeRoleProblems(migration)).join('; ')).toMatch(/owns the tables/);
        await expect(assertRuntimeRole(migration, true)).rejects.toThrow(/data-only runtime role in production/);
        expect((await runtimeRoleProblems(superuser)).join('; ')).toMatch(/is a superuser/);
        await expect(assertRuntimeRole(superuser, false)).resolves.toBeUndefined(); // development is not checked
      } finally {
        await migration.$disconnect();
        await superuser.$disconnect();
      }
    });

    it('verify.sql passes on the applied roles, and fails (non-zero) when a grant drifts', async () => {
      const results = await run(base, script('verify.sql')) as unknown as Array<{ command: string; rows: Array<{ status: string; check: string; detail: string }> }>;
      const table = results.find((r) => r.command === 'SELECT' && r.rows[0]?.status)!.rows;
      expect(table).toHaveLength(11);
      expect(table.filter((r) => r.status === 'FAIL')).toEqual([]);

      await run(base, `GRANT UPDATE ON audit_entries TO ${roleName('runtime')}`);
      try {
        expect(await runtimeRoleProblems(runtime)).toEqual([`"${roleName('runtime')}" can rewrite audit_entries`]);
        await expect(run(base, script('verify.sql'))).rejects.toThrow(/1 check\(s\) FAILED/);
      } finally {
        await run(base, script('02_grants.sql')); // re-applying the grants restores the refusal
      }
      expect(await runtimeRoleProblems(runtime)).toEqual([]);

      // TRUNCATE empties a table without row triggers or audit: start-up refuses it too, not only verify.sql.
      await run(base, `GRANT TRUNCATE ON employees, units TO ${roleName('runtime')}`);
      try {
        expect(await runtimeRoleProblems(runtime)).toEqual([`"${roleName('runtime')}" can truncate tables (employees, units)`]);
        await expect(assertRuntimeRole(runtime, true)).rejects.toThrow(/can truncate tables \(employees, units\)/);
        await expect(run(base, script('verify.sql'))).rejects.toThrow(/1 check\(s\) FAILED/);
      } finally {
        await run(base, script('02_grants.sql'));
      }
      expect(await runtimeRoleProblems(runtime)).toEqual([]);
    });
  });

  describe('existing database: objects created by the owner before the roles existed (like nurseapp_v04)', () => {
    let base: string;
    beforeAll(async () => {
      const empty = await createEmptyDatabase(TEST_URL!, 'nurseapp_roles');
      drops.push(empty.drop);
      base = empty.url;
      migrateDeploy(base); // as the owner, the way the development database was built
      await provision(base);
    }, 180_000);

    it('hands every object to the migration role; the runtime then reads and writes but cannot alter', async () => {
      const notMigration = await run(base, `
        SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND relkind IN ('r','v') AND pg_get_userbyid(relowner) <> '${roleName('migration')}'
        UNION SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public' AND typtype = 'e' AND pg_get_userbyid(typowner) <> '${roleName('migration')}'`);
      expect(notMigration.rows).toEqual([]);
      const rt = urlAs(base, 'runtime');
      expect(await attempt(rt, `INSERT INTO departments (code, name, updated_at) VALUES ('ROLES', 'Roles', now())`)).toBe('ok');
      expect(await attempt(rt, `ALTER TABLE departments ADD COLUMN sneaky int`)).toBe(DENIED);
      // A later migration, run as the migration role, still applies (nothing pending here, but it connects and checks).
      expect(() => migrateDeploy(urlAs(base, 'migration'))).not.toThrow();
    }, 120_000);

    it('running the grants again changes nothing and fails nothing (it runs after every migration)', async () => {
      await expect(run(base, script('02_grants.sql'))).resolves.toBeDefined();
      await expect(run(base, script('01_roles.sql'))).resolves.toBeDefined();
    });
  });
});
