// The tester walkthrough end to end, through the API the screens use, on a fresh database
// with the real hospital baseline (owner request 2026-10-04: "check it yourself"). One
// Saudi and one Filipino nurse are onboarded today; dates are relative to the day the test
// runs, so it never goes stale. It crosses the features that the per-module tests check
// one by one: onboarding's required fields, credential types by nationality (Passport and
// Iqama optional for Saudi nationals, National ID only for them), the renewal rule, a New
// contract without a type field, the two-person approval with PAM elevation, supervisor
// scope, and the audit chain.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { findChainBreaks } from '../src/lib/audit.js';
import { addDays, riyadhDate } from '../src/lib/dates.js';
import { toHijriIso } from '../src/lib/hijri.js';
import type { Db } from '../src/lib/prisma.js';
import { applyBaseline, parseBaseline } from '../src/modules/administration/baseline-import.js';
import { createFreshDatabase } from './fresh-db.js';
import { FILES, makeUser, signIn, TEST_URL, testApp } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;

describeDb('tester walkthrough on the hospital baseline (end to end)', () => {
  let fresh: Awaited<ReturnType<typeof createFreshDatabase>>;
  let db: Db;
  let app: Express;
  let hr: Awaited<ReturnType<typeof signIn>>;
  let admin: Awaited<ReturnType<typeof signIn>>;
  let sup: Awaited<ReturnType<typeof signIn>>;
  let icuId: number;
  let onboardBase: Record<string, unknown>;
  const today = riyadhDate();
  const ids = { saudi: 0, filipino: 0, saudiContract: 0 };

  type Reason = { code: string; templateCode?: string };
  const reasons = async (employeeId: number) => ((await hr.get(`/eligibility/${employeeId}`)).body.reasons as Reason[]);
  const missing = async (employeeId: number) => (await reasons(employeeId)).filter((r) => r.code === 'CREDENTIAL_MISSING').map((r) => r.templateCode).sort();
  const status = async (employeeId: number) => (await hr.get(`/eligibility/${employeeId}`)).body.status as string;
  const templateId = async (code: string) => (await db.credentialTemplate.findUniqueOrThrow({ where: { code }, select: { id: true } })).id;
  /** Fictional values for every field of a type, issued a month ago and expiring in two years. */
  async function tracking(code: string) {
    const t = await db.credentialTemplate.findUniqueOrThrow({ where: { code }, include: { fields: true } });
    const out: Record<string, string> = {};
    for (const f of t.fields) {
      const date = f.isExpiryDate ? addDays(today, 730) : addDays(today, -30);
      out[f.key] = f.type === 'date' ? date : f.type === 'date_hijri' ? toHijriIso(date) : f.type === 'country' ? 'PHL' : `DEMO-${code}-${f.key}`;
    }
    return out;
  }
  const onboard = (body: Record<string, unknown>) => hr.post('/employees/onboard', body).set('Idempotency-Key', crypto.randomUUID());
  const newContract = (employeeId: number) => hr.post('/contracts', { employeeId, startDate: addDays(today, 400), endDate: addDays(today, 700) }).set('Idempotency-Key', crypto.randomUUID());

  beforeAll(async () => {
    fresh = await createFreshDatabase(TEST_URL!);
    db = fresh.db;
    app = testApp(db);
    const hrUser = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    const baseline = parseBaseline(JSON.parse(readFileSync(resolve(__dirname, '../prisma/baseline/aigh-baseline.json'), 'utf8')));
    await db.$transaction((tx) => applyBaseline(tx, hrUser.id, baseline, 'Walkthrough baseline', null), { timeout: 120_000 });
    icuId = (await db.unit.findUniqueOrThrow({ where: { code: 'ICU_MAIN' } })).id;
    hr = await signIn(app, hrUser.email);
    admin = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] })).email); // dormant until it elevates
    sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [icuId] }] })).email);
    const city = await db.saudiCity.findFirstOrThrow({ where: { regionCode: 'SA-05', name: 'Buraydah' } });
    const facility = await db.facility.findFirstOrThrow({ orderBy: { id: 'asc' } });
    onboardBase = {
      firstName: 'Test', contactEmail: 'test.nurse@example.com', unitId: icuId, contractStart: today, contractEnd: addDays(today, 364),
      contractTypeCode: 'DIRECT_HOSPITAL', rankGradeCode: 'N03', specialtyCode: 'NS003', jobPostRegionCode: 'SA-05', jobPostCityId: city.id, facilityId: facility.id,
    };
  }, 240_000);
  afterAll(async () => {
    await (app?.locals.requestLog as { flush(): Promise<void> } | undefined)?.flush(); // write the pending request log before the database goes
    await fresh?.drop();
  }, 60_000);

  it('O: onboarding needs every required field; with them it creates the employee and a Draft contract of the chosen type', async () => {
    const refused = await onboard({ ...onboardBase, jobNumber: 'W-0', lastName: 'No Nationality' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'nationalityCode', message: 'Nationality is required.' })]));
    const saudi = await onboard({ ...onboardBase, jobNumber: 'W-1', lastName: 'Saudi', nationalityCode: 'SAU' });
    const filipino = await onboard({ ...onboardBase, jobNumber: 'W-2', lastName: 'Filipino', nationalityCode: 'PHL' });
    expect([saudi.status, filipino.status]).toEqual([201, 201]);
    ids.saudi = saudi.body.employeeId; ids.filipino = filipino.body.employeeId; ids.saudiContract = saudi.body.contractId;
    expect((await hr.get(`/contracts/${ids.saudiContract}`)).body).toMatchObject({ status: 'Draft', contractTypeCode: 'DIRECT_HOSPITAL' });
    expect((await hr.get(`/employees/${ids.saudi}`)).body).toMatchObject({ nationalityCode: 'SAU', rankGradeCode: 'N03', specialtyCode: 'NS003', jobPostRegionCode: 'SA-05' });
  });

  it('N: with ICU requiring BLS, Passport, Iqama and National ID, each nurse misses only what applies to their nationality', async () => {
    for (const code of ['BLS', 'PASSPORT', 'IQAMA', 'NATIONAL_ID']) {
      expect((await hr.post('/credential-requirements', { templateId: await templateId(code), unitId: icuId })).status).toBe(201);
    }
    expect(await missing(ids.saudi)).toEqual(['BLS', 'NATIONAL_ID']);
    expect(await missing(ids.filipino)).toEqual(['BLS', 'IQAMA', 'PASSPORT']);
    const nurse = await signIn(app, (await makeUser(db, { employeeId: ids.saudi })).email);
    const own = (await nurse.get('/credentials/me/requirements')).body.items as Array<{ template: { code: string }; policyStatus: string; optionalByNationality: boolean }>;
    const of = (code: string) => own.find((r) => r.template.code === code);
    expect([of('PASSPORT'), of('IQAMA')]).toEqual([expect.objectContaining({ policyStatus: 'OPTIONAL', optionalByNationality: true }), expect.objectContaining({ policyStatus: 'OPTIONAL', optionalByNationality: true })]);
    expect(of('NATIONAL_ID')).toMatchObject({ policyStatus: 'MANDATORY', optionalByNationality: false });
  });

  it('D1: a New contract (no type field) is refused while required credentials are missing, naming only those that apply', async () => {
    const refused = await newContract(ids.saudi);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('CREDENTIALS_BLOCK_RENEWAL');
    expect(refused.body.error.details.reasons.map((r: Reason) => r.templateCode).sort()).toEqual(['BLS', 'NATIONAL_ID']);
  });

  it('C: the nurse submits National ID and BLS with evidence; HR verifies; only the contract reason is left', async () => {
    const nurse = await signIn(app, (await db.user.findFirstOrThrow({ where: { employeeId: ids.saudi } })).email);
    for (const code of ['NATIONAL_ID', 'BLS']) {
      const rec = await nurse.post('/credentials/me', { templateId: await templateId(code), trackingData: await tracking(code) });
      expect(rec.status).toBe(201);
      expect((await nurse.upload(`/credentials/${rec.body.id}/documents`, FILES.pdf, 'application/pdf', `demo-${code}.pdf`)).status).toBe(201);
      expect((await hr.post(`/credentials/${rec.body.id}/verify`)).body.status).toBe('Valid');
    }
    expect((await reasons(ids.saudi)).map((r) => r.code)).toEqual(['NO_CONTRACT_COVERAGE']);
  });

  it('D: the contract needs its copy, a second administrator, and that administrator\'s elevation; then the nurse is eligible', async () => {
    const id = ids.saudiContract;
    expect((await hr.post(`/contracts/${id}/transition`, { action: 'submit' })).body.error.code).toBe('CONTRACT_COPY_REQUIRED');
    expect((await hr.upload(`/contracts/${id}/documents`, FILES.pdf, 'application/pdf', 'demo-contract.pdf')).status).toBe(201);
    expect((await hr.post(`/contracts/${id}/transition`, { action: 'submit' })).body.status).toBe('PendingApproval');
    expect((await hr.post(`/contracts/${id}/transition`, { action: 'approve' })).body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await admin.post(`/contracts/${id}/transition`, { action: 'approve' })).body.error.code).toBe('PAM_ELEVATION_REQUIRED');
    expect((await admin.post('/pam/elevate', { reason: 'Approve the walkthrough contract', durationHours: 1 })).status).toBe(200);
    expect((await admin.post(`/contracts/${id}/transition`, { action: 'approve' })).body.status).toBe('Active');
    expect(await status(ids.saudi)).toBe('ELIGIBLE'); // without any passport or Iqama
  });

  it('C/D: HR records the Filipino nurse\'s credentials; her New contract then passes and carries the type from onboarding', async () => {
    for (const code of ['BLS', 'PASSPORT', 'IQAMA']) {
      const rec = await hr.post('/credentials', { employeeId: ids.filipino, templateId: await templateId(code), trackingData: await tracking(code) });
      expect(rec.status).toBe(201);
      expect((await hr.upload(`/credentials/${rec.body.id}/documents`, FILES.pdf, 'application/pdf', `demo-${code}.pdf`)).status).toBe(201);
      expect((await hr.post(`/credentials/${rec.body.id}/verify`)).body.status).toBe('Valid');
    }
    expect(await missing(ids.filipino)).toEqual([]);
    const made = await newContract(ids.filipino);
    expect(made.status).toBe(201);
    expect((await hr.get(`/contracts/${made.body.id}`)).body).toMatchObject({ status: 'Draft', contractTypeCode: 'DIRECT_HOSPITAL' });
  });

  it('E: the supervisor sees the ICU nurses but not their evidence; the nurse sees only herself', async () => {
    const listed = ((await sup.get('/employees')).body.items as Array<{ id: number }>).map((x) => x.id).sort((a, b) => a - b);
    expect(listed).toEqual([ids.saudi, ids.filipino].sort((a, b) => a - b));
    const cred = await db.credential.findFirstOrThrow({ where: { employeeId: ids.saudi }, include: { documents: true } });
    expect((await sup.get(`/credentials/${cred.id}/documents/${cred.documents[0]!.id}`)).status).toBe(403);
    const nurse = await signIn(app, (await db.user.findFirstOrThrow({ where: { employeeId: ids.saudi } })).email);
    expect((await nurse.get('/employees')).status).toBe(403);
  });

  it('H: the audit chain is intact after the whole walkthrough', async () => {
    expect((await admin.get('/audit/verify')).body).toMatchObject({ intact: true, breaks: [] });
    expect(await findChainBreaks(db)).toEqual([]);
  });
});
