// SCFHS licence verification (spec §5.4, D-64) against the simulated registry:
// checks on submission, on demand and nightly; what each SCFHS answer leads to
// (nothing, an HR notice; simulated answers never suspend credentials); outages and the circuit
// breaker; the registration number never stored in the log; scope and rules.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/prisma.js';
import { fieldCryptoFromEnv } from '../src/lib/field-crypto.js';
import { MockScfhsGateway, ScfhsUnavailableError, type ScfhsGateway } from '../src/lib/scfhs.js';
import { fieldRows } from '../src/modules/credentials/fields.js';
import type { FieldDef } from '../src/modules/credentials/catalog.js';
import { createScfhsService, MAX_CONSECUTIVE_ERRORS } from '../src/modules/credentials/scfhs.js';
import { createProtection } from '../src/modules/pdpl/protection.js';
import { makeNurse, makeOrg, makeUser, openDb, signIn, TEST_URL, testApp, testEnv, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const DEFS: FieldDef[] = [
  { key: 'scfhs_number', label: 'SCFHS number', type: 'text', required: true, displayOrder: 1, pdplCategory: 'SCFHS_REG' },
  { key: 'issue_date', label: 'Issue date', type: 'date', required: true, displayOrder: 2, isIssueDate: true },
  { key: 'expiry_date', label: 'Expiry date', type: 'date', required: true, displayOrder: 3, isExpiryDate: true },
];

describeDb('SCFHS licence verification (spec §5.4, D-64)', () => {
  let db: Db;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let hr: Awaited<ReturnType<typeof signIn>>;
  let sa: Awaited<ReturnType<typeof signIn>>;
  let hrUserId: number;
  const app = () => testApp(db);

  async function template(opts: { enabled?: boolean; autoSuspend?: boolean } = {}) {
    await db.credentialCategory.upsert({ where: { code: 'LICENSURE' }, update: {}, create: { code: 'LICENSURE', name: 'Licensure' } });
    const t = await db.credentialTemplate.create({
      data: { code: uniq('SCFHS').toUpperCase(), name: 'SCFHS registration', categoryCode: 'LICENSURE', hasExpiry: true, requiresUpload: false, scfhsEnabled: opts.enabled ?? true, scfhsAutoSuspend: opts.autoSuspend ?? false },
    });
    await db.credentialTemplateField.createMany({ data: fieldRows(t.id, DEFS) });
    return t.id;
  }
  const regNo = () => `RN-${uniq('').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(-10)}`;
  const setRegistry = (reg: string, body: object) => sa.put(`/dev-console/scfhs-registry/${reg}`, body);
  async function record(templateId: number, reg: string, expiry = '2030-01-01', unitId = org.unitA.id) {
    const { emp } = await makeNurse(db, unitId);
    const res = await hr.post('/credentials', { employeeId: emp.id, templateId, trackingData: { scfhs_number: reg, issue_date: '2025-01-01', expiry_date: expiry } });
    expect(res.status).toBe(201);
    return { emp, id: res.body.id as number, scfhs: res.body.scfhs };
  }

  beforeAll(async () => {
    db = openDb();
    org = await makeOrg(db);
    const hrUser = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    hrUserId = hrUser.id;
    hr = await signIn(app(), hrUser.email);
    sa = await signIn(app(), (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
  });
  afterAll(async () => { await db.$disconnect(); });

  it('the simulated registry: a System Admin sets and removes entries; validated and audited without the number', async () => {
    const reg = regNo();
    const put = await setRegistry(reg.toLowerCase(), { status: 'VERIFIED', expiryDate: '2030-01-01', specialty: 'Nursing' });
    expect(put.status).toBe(200);
    expect(put.body.registrationNumber).toBe(reg); // stored as SCFHS writes it
    expect((await sa.get('/dev-console/scfhs-registry')).body).toMatchObject({ driver: 'mock', items: expect.arrayContaining([expect.objectContaining({ registrationNumber: reg })]) });
    expect((await setRegistry(reg, { status: 'MAYBE' })).status).toBe(400);
    expect((await setRegistry('bad number!', { status: 'VERIFIED' })).status).toBe(400);
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'SCFHS_REGISTRY_SET' }, orderBy: { id: 'desc' } });
    expect(audit.resourceId).toBe(`…${reg.slice(-4)}`);
    expect((await sa.del(`/dev-console/scfhs-registry/${reg}`)).status).toBe(204);
    expect((await sa.del(`/dev-console/scfhs-registry/${reg}`)).status).toBe(404);
    expect((await hr.get('/dev-console/scfhs-registry')).status).toBe(403);
  });

  it('on submission: an unknown number tells HR; the log keeps only the last four characters', async () => {
    const tpl = await template();
    const reg = regNo();
    const c = await record(tpl, reg);
    expect(c.scfhs).toMatchObject({ checked: true, status: 'NOT_FOUND', matched: false, action: 'HR_NOTIFIED' });
    const log = await db.scfhsCheck.findFirstOrThrow({ where: { credentialId: c.id } });
    expect(log).toMatchObject({ requestType: 'ON_SUBMIT', responseStatus: 'NOT_FOUND', regNumberHint: `…${reg.slice(-4)}`, driver: 'mock', actorUserId: hrUserId });
    expect(JSON.stringify(log, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(reg);
    const notice = await db.notification.findFirstOrThrow({ where: { recipientId: hrUserId, eventKey: { startsWith: `scfhs:${c.id}:NOT_FOUND` } } });
    expect(notice).toMatchObject({ type: 'CREDENTIAL', priority: 'HIGH' });
    expect(notice.message).not.toContain(reg);
  });

  it('on demand: agreement does nothing; a different expiry date tells HR once; history is listed', async () => {
    const tpl = await template();
    const reg = regNo();
    await setRegistry(reg, { status: 'VERIFIED', expiryDate: '2030-01-01', specialty: 'Nursing' });
    const c = await record(tpl, reg);
    expect(c.scfhs).toMatchObject({ status: 'VERIFIED', matched: true, action: 'NONE' });
    const ok = await hr.post(`/credentials/${c.id}/scfhs-check`, {});
    expect(ok.body).toMatchObject({ checked: true, status: 'VERIFIED', matched: true, action: 'NONE', driver: 'mock' });

    await setRegistry(reg, { status: 'VERIFIED', expiryDate: '2029-06-30' });
    const diff = await hr.post(`/credentials/${c.id}/scfhs-check`, {});
    expect(diff.body).toMatchObject({ matched: false, action: 'HR_NOTIFIED', discrepancies: ['Expiry date: recorded 2030-01-01, SCFHS 2029-06-30'] });
    await hr.post(`/credentials/${c.id}/scfhs-check`, {}); // the same answer again: no second notice
    expect(await db.notification.count({ where: { recipientId: hrUserId, eventKey: `scfhs:${c.id}:VERIFIED:2029-06-30` } })).toBe(1);
    // SCFHS never overwrites the record.
    expect((await db.credential.findUniqueOrThrow({ where: { id: c.id } })).expiryDate?.toISOString().slice(0, 10)).toBe('2030-01-01');

    const history = await hr.get(`/credentials/${c.id}/scfhs-checks`);
    expect(history.body.items.map((h: { requestType: string }) => h.requestType)).toEqual(['MANUAL', 'MANUAL', 'MANUAL', 'ON_SUBMIT']);
    expect(await db.auditEntry.count({ where: { action: 'SCFHS_CHECKED', resourceId: String(c.id) } })).toBe(3);
  });

  it('mock SUSPENDED or REVOKED never suspends a real credential or refreshes eligibility, even with auto-suspend enabled', async () => {
    const auto = await template({ autoSuspend: true });
    const reg = regNo();
    await setRegistry(reg, { status: 'VERIFIED', expiryDate: '2030-01-01' });
    const c = await record(auto, reg);
    await hr.post(`/credentials/${c.id}/verify`, {});
    expect((await db.credential.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('Valid');

    const eligibilityBefore = await db.eligibilityState.findUnique({ where: { employeeId: c.emp.id } });
    await setRegistry(reg, { status: 'REVOKED', expiryDate: '2030-01-01' });
    const r = await hr.post(`/credentials/${c.id}/scfhs-check`, {});
    expect(r.body).toMatchObject({ status: 'REVOKED', action: 'HR_NOTIFIED', driver: 'mock' });
    const after = await db.credential.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe('Valid');
    expect(after.statusReason).toBeNull();
    expect(await db.auditEntry.count({ where: { action: 'CREDENTIAL_SCFHS_SUSPENDED', resourceId: String(c.id) } })).toBe(0);
    expect(await db.eligibilityState.findUnique({ where: { employeeId: c.emp.id } })).toEqual(eligibilityBefore);
    expect(await db.notification.count({ where: { recipientId: hrUserId, eventKey: { startsWith: `scfhs:${c.id}:REVOKED` } } })).toBe(1);
    // Checked again: still no suspension and no second notice.
    expect((await hr.post(`/credentials/${c.id}/scfhs-check`, {})).body.action).toBe('NONE');

    const manual = await template({ autoSuspend: false });
    const reg2 = regNo();
    await setRegistry(reg2, { status: 'SUSPENDED', expiryDate: '2030-01-01' });
    const c2 = await record(manual, reg2);
    expect(c2.scfhs).toMatchObject({ status: 'SUSPENDED', action: 'HR_NOTIFIED' });
    expect((await db.credential.findUniqueOrThrow({ where: { id: c2.id } })).status).toBe('PendingVerification');
  });

  it('SCFHS unreachable: the attempt is logged as ERROR; the nightly run stops after repeated failures', async () => {
    const tpl = await template();
    const reg = regNo();
    await setRegistry(reg, { status: 'ERROR' });
    const c = await record(tpl, reg);
    expect(c.scfhs).toMatchObject({ checked: true, status: 'ERROR', action: 'NONE' });
    expect(await db.scfhsCheck.findFirstOrThrow({ where: { credentialId: c.id } })).toMatchObject({ responseStatus: 'ERROR', errorMessage: expect.stringMatching(/outage/) });

    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) await record(tpl, regNo());
    const down: ScfhsGateway = { driver: 'mock', lookup: async () => { throw new ScfhsUnavailableError('connection refused'); } };
    const protection = createProtection(fieldCryptoFromEnv(testEnv()));
    const summary = await createScfhsService(db, down, protection).syncAll();
    expect(summary).toMatchObject({ errors: MAX_CONSECUTIVE_ERRORS, stoppedAfterErrors: true });
    expect(summary.checked).toBe(MAX_CONSECUTIVE_ERRORS);
  });

  it('the nightly run checks current credentials of SCFHS-checked types only', async () => {
    const on = await template();
    const off = await template({ enabled: false });
    const reg = regNo();
    await setRegistry(reg, { status: 'VERIFIED', expiryDate: '2030-01-01' });
    const checked = await record(on, reg);
    const ignored = await record(off, regNo());
    expect(ignored.scfhs).toMatchObject({ checked: false, skipped: 'NOT_ENABLED' });
    const protection = createProtection(fieldCryptoFromEnv(testEnv()));
    const summary = await createScfhsService(db, new MockScfhsGateway(db), protection).syncAll();
    expect(summary.due).toBeGreaterThan(0);
    expect(await db.scfhsCheck.count({ where: { credentialId: checked.id, requestType: 'SCHEDULED', responseStatus: 'VERIFIED' } })).toBe(1);
    expect(await db.scfhsCheck.count({ where: { credentialId: ignored.id } })).toBe(0);
    expect((await hr.post(`/credentials/${ignored.id}/scfhs-check`, {})).body.error.code).toBe('SCFHS_NOT_ENABLED');
  });

  it('scope, and the credential-type rules', async () => {
    const tpl = await template();
    const outside = await record(tpl, regNo(), '2030-01-01', org.unitC.id);
    const deptHr = await signIn(app(), (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'DEPARTMENT', scopeIds: [org.dept.id] }] })).email);
    expect((await deptHr.post(`/credentials/${outside.id}/scfhs-check`, {})).status).toBe(403);
    expect((await deptHr.get(`/credentials/${outside.id}/scfhs-checks`)).status).toBe(403);

    // A type checked with SCFHS needs a registration-number field; auto-suspend needs the checks.
    await db.credentialCategory.upsert({ where: { code: 'LICENSURE' }, update: {}, create: { code: 'LICENSURE', name: 'Licensure' } });
    const base = { name: 'Licence', categoryCode: 'LICENSURE', reason: 'Adding a licence type for SCFHS checks' };
    const noField = await sa.post('/credential-templates', { ...base, code: uniq('T').toUpperCase().replace(/[^A-Z0-9_]/g, ''), scfhsEnabled: true, fieldDefs: [DEFS[1], DEFS[2]] });
    expect(noField.body.error.code).toBe('SCFHS_FIELD_REQUIRED');
    const noChecks = await sa.post('/credential-templates', { ...base, code: uniq('T').toUpperCase().replace(/[^A-Z0-9_]/g, ''), scfhsAutoSuspend: true, fieldDefs: DEFS });
    expect(noChecks.body.error.code).toBe('SCFHS_AUTO_SUSPEND_NEEDS_CHECKS');
    await expect(db.credentialTemplate.update({ where: { id: tpl }, data: { scfhsEnabled: false, scfhsAutoSuspend: true } })).rejects.toThrow();
  });
});
