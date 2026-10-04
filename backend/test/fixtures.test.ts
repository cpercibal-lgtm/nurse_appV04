// P9: the demo data is a non-production fixture — it loads only into an empty
// development database, and what it loads obeys the same rules as real data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChainBreaks } from '../src/lib/audit.js';
import { createPasswordService } from '../src/lib/passwords.js';
import type { Db } from '../src/lib/prisma.js';
import { assertFixtureTarget, FixtureRefused, loadDemoFixtures } from './fixtures/demo/load.js';
import { createFreshDatabase } from './fresh-db.js';
import { signIn, TEST_URL, testApp } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const PASSWORD = 'demo-fixture-password-1';

describe('fixture target guard', () => {
  it('refuses production and databases not marked for development', () => {
    expect(() => assertFixtureTarget({ NODE_ENV: 'production' }, 'postgresql://u@h/nurseapp_dev')).toThrow(FixtureRefused);
    expect(() => assertFixtureTarget({}, 'postgresql://u@h/nurseapp')).toThrow(/not marked/);
    expect(() => assertFixtureTarget({}, 'postgresql://u@h/nurseapp_v04')).toThrow(/allow-database=nurseapp_v04/);
    expect(assertFixtureTarget({}, 'postgresql://u@h/nurseapp_v04', 'nurseapp_v04')).toBe('nurseapp_v04');
    expect(assertFixtureTarget({}, 'postgresql://u@h/nurseapp_demo')).toBe('nurseapp_demo');
    expect(assertFixtureTarget({}, 'postgresql://u@h/nurseapp_test')).toBe('nurseapp_test');
  });
});

describeDb('demo fixtures on an empty database (P9)', () => {
  let fresh: Awaited<ReturnType<typeof createFreshDatabase>>;
  let db: Db;
  beforeAll(async () => { fresh = await createFreshDatabase(TEST_URL!); db = fresh.db; }, 120_000);
  afterAll(async () => { await fresh?.drop(); }, 60_000); // dropping a database waits for its connections to close

  it('loads accounts, the baseline and the fictional workforce with consistent statuses', async () => {
    await loadDemoFixtures(db, PASSWORD, createPasswordService(4), '2026-09-23');
    expect([await db.user.count(), await db.employee.count(), await db.contract.count(), await db.credential.count(), await db.credentialRequirement.count(), await db.roleAssignment.count()])
      .toEqual([5, 8, 8, 7, 6, 3]);
    expect([await db.unit.count(), await db.credentialTemplateField.count()]).toEqual([47, 71]);
    // Stored statuses follow the dates (the old seed stored "Valid" for expired credentials).
    const creds = await db.credential.findMany({ include: { employee: { select: { jobNumber: true } }, template: { select: { code: true } } } });
    const status = (job: string, code: string) => creds.find((c) => c.employee.jobNumber === job && c.template.code === code)!.status;
    expect([status('1001', 'SCFHS'), status('1001', 'BLS'), status('1002', 'SCFHS'), status('3005', 'IQAMA')]).toEqual(['Expired', 'Expired', 'Expired', 'Valid']);
    expect(creds.find((c) => c.template.code === 'IQAMA')!.expiryDateHijri).toMatch(/^14\d\d-\d\d-\d\d$/);
    // Nothing is set to Superseded by hand; creator and approver always differ.
    expect(await db.contract.count({ where: { status: 'Superseded' } })).toBe(0);
    expect((await db.contract.findMany()).every((c) => c.createdById !== c.approvedById)).toBe(true);
    // The demo story: only 2004 and 3005 can be scheduled.
    const states = await db.eligibilityState.findMany({ include: { employee: { select: { jobNumber: true } } } });
    expect(states.filter((s) => s.status !== 'INELIGIBLE').map((s) => s.employee.jobNumber).sort()).toEqual(['2004', '3005']);
    expect(await findChainBreaks(db)).toEqual([]);
    // The demo password works; nothing in the database contains it.
    const nurse = await signIn(testApp(db), 'nurse@aigh.sa', PASSWORD);
    expect((await nurse.get('/employees/me')).body.jobNumber).toBe('1001');
  }, 120_000);

  it('refuses a database that already has accounts', async () => {
    await expect(loadDemoFixtures(db, PASSWORD, createPasswordService(4))).rejects.toBeInstanceOf(FixtureRefused);
    expect(await db.employee.count()).toBe(8);
  });
});
