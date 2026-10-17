import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/prisma.js';
import { makeEmployee, makeOrg, openDb, TEST_URL } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
describeDb('PostgreSQL transaction query scheduling', () => {
  let db: Db;
  const warnings: string[] = [];
  const onWarning = (warning: Error) => { if (warning.message.includes('already executing a query')) warnings.push(warning.message); };
  beforeAll(() => { db = openDb(); process.on('warning', onWarning); });
  afterAll(async () => { process.off('warning', onWarning); await db.$disconnect(); });

  it('handles concurrent Prisma operations on a transaction without relying on the deprecated pg queue', async () => {
    const result = await db.$transaction(async (tx) => Promise.all([
      tx.$queryRaw<Array<{ value: number }>>`SELECT 1::int AS value FROM pg_sleep(0.02)`,
      tx.$queryRaw<Array<{ value: number }>>`SELECT 2::int AS value`,
      tx.$queryRaw<Array<{ value: number }>>`SELECT 3::int AS value`,
    ]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result.map((rows) => rows[0]!.value)).toEqual([1, 2, 3]);
    expect(warnings).toEqual([]);
  });

  it('loads multiple relations inside a transaction without concurrent driver calls', async () => {
    const org = await makeOrg(db);
    const employee = await makeEmployee(db, org.unitA.id);
    const result = await db.$transaction((tx) => tx.employee.findUniqueOrThrow({
      where: { id: employee.id }, include: { unit: true, position: true, contracts: true, nationalityRef: true },
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result.unit?.id).toBe(org.unitA.id);
    expect(result.position.code).toBe('SN');
    expect(warnings).toEqual([]);
  });
});
