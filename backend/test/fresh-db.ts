// A brand-new, empty database for the database-first acceptance tests: created
// next to TEST_DATABASE_URL, migrated with `prisma migrate deploy` (nothing
// else — no seed), and dropped afterwards. The test login needs CREATEDB.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import pg from 'pg';
import { createPrisma, type Db } from '../src/lib/prisma.js';

const BACKEND = resolve(__dirname, '..');
const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js');

function adminUrl(base: string) {
  const u = new URL(base);
  u.pathname = '/postgres';
  return u.toString();
}

/** `prisma migrate deploy` against `url` — and only `url`, whatever MIGRATION_DATABASE_URL a .env sets. */
export function migrateDeploy(url: string) {
  execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: BACKEND, env: { ...process.env, DATABASE_URL: url, MIGRATION_DATABASE_URL: url }, stdio: 'pipe',
  });
}

/** An empty database next to `baseUrl` (no migrations), with its URL and a drop function. */
export async function createEmptyDatabase(baseUrl: string, prefix = 'nurseapp_fresh') {
  const name = `${prefix}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl(baseUrl) });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  return {
    name, url: u.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: adminUrl(baseUrl) });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export async function createFreshDatabase(baseUrl: string): Promise<{ url: string; db: Db; drop: () => Promise<void> }> {
  const empty = await createEmptyDatabase(baseUrl);
  migrateDeploy(empty.url); // exactly what a new installation runs
  const db = createPrisma(empty.url);
  return {
    url: empty.url, db,
    drop: async () => { await db.$disconnect(); await empty.drop(); },
  };
}
