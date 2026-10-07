// Database-first acceptance (migration plan §12): a brand-new database is
// migrated (nothing else), bootstrapped, and then
//   A. administrators create hospital data through the API and every business
//      rule works on it — without any seed or baseline;
//   B. the hospital baseline enters through the controlled import (P7):
//      preview → request → second administrator → one transaction → audit;
//      idempotent, conflict-safe and all-or-nothing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { bootstrapAdministrators } from '../src/cli/bootstrap.js';
import { findChainBreaks } from '../src/lib/audit.js';
import { addDays, riyadhDate } from '../src/lib/dates.js';
import { createPasswordService } from '../src/lib/passwords.js';
import type { Db } from '../src/lib/prisma.js';
import { createFreshDatabase } from './fresh-db.js';
import { FILES, signIn, TEST_URL, testApp, jobPost } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const BASELINE = JSON.parse(readFileSync(join(__dirname, '..', 'prisma', 'baseline', 'aigh-baseline.json'), 'utf8'));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const admins = {
  systemAdmin: { email: 'sa@fresh.example', displayName: 'SA', password: 'fresh-system-admin-1' },
  hrAdmin: { email: 'hr@fresh.example', displayName: 'HR', password: 'fresh-hr-admin-long-2' },
};

async function freshApp() {
  const fresh = await createFreshDatabase(TEST_URL!);
  const app = testApp(fresh.db);
  await bootstrapAdministrators(fresh.db, admins, createPasswordService(4));
  const hr = await signIn(app, admins.hrAdmin.email, admins.hrAdmin.password);
  const sa = await signIn(app, admins.systemAdmin.email, admins.systemAdmin.password);
  expect((await sa.post('/pam/elevate', { reason: 'Database-first acceptance run' })).status).toBe(200);
  return { fresh, app, hr, sa };
}

describeDb('A. an empty database works through the API alone', () => {
  let ctx: Awaited<ReturnType<typeof freshApp>>;
  let db: Db;
  let app: Express;
  beforeAll(async () => { ctx = await freshApp(); db = ctx.fresh.db; app = ctx.app; }, 180_000);
  afterAll(async () => { await ctx?.fresh.drop(); }, 60_000);

  it('administrators create the hospital, HR onboards a nurse, credentials decide eligibility, the audit chain holds', async () => {
    const { hr, sa } = ctx;
    // Master data, created through the ordinary endpoints (no seed).
    const dept = await hr.post('/departments', { code: 'MED', name: 'Medicine' });
    expect(dept.status).toBe(201);
    const unit = await hr.post('/units', { code: 'WARD1', name: 'Ward 1', departmentId: dept.body.id, bedCount: 20, criticalArea: 'ICU' });
    expect(unit.status).toBe(201);
    expect((await hr.post('/positions', { code: 'RN', title: 'Registered Nurse', tier: 'Clinical', isSchedulable: true })).status).toBe(201);

    // Credential catalogue: category and type both need a second administrator.
    const cat = await hr.post('/credential-categories', { code: 'LICENSURE', name: 'Licensure', reason: 'Hospital catalogue start-up' });
    expect(cat.status).toBe(202);
    expect((await sa.post(`/approvals/${cat.body.requestId}/approve`, { reason: 'Agreed' })).body.status).toBe('EXECUTED');
    const tplReq = await hr.post('/credential-templates', {
      code: 'LICENCE', name: 'Nursing licence', categoryCode: 'LICENSURE', hasExpiry: true, requiresUpload: false, reason: 'Hospital catalogue start-up',
      fieldDefs: [
        { key: 'number', label: 'Number', type: 'text', required: true, displayOrder: 1 },
        { key: 'issue_date', label: 'Issue date', type: 'date', required: true, displayOrder: 2, isIssueDate: true },
        { key: 'expiry_date', label: 'Expiry date', type: 'date', required: true, displayOrder: 3, isExpiryDate: true },
      ],
    });
    await sa.post(`/approvals/${tplReq.body.requestId}/approve`, { reason: 'Agreed' });
    const tpl = (await hr.get('/credential-templates')).body.items.find((t: { code: string }) => t.code === 'LICENCE');
    expect(tpl.fieldDefs).toHaveLength(3);
    expect((await hr.post('/credential-requirements', { templateId: tpl.id, unitId: unit.body.id })).status).toBe(201);

    // HR onboards a nurse: with no SN position in this hospital, a position must be chosen (E6).
    const today = riyadhDate();
    const base = { jobNumber: 'N-1', firstName: 'Noor', lastName: 'Ali', contactEmail: 'noor@fresh.example', unitId: unit.body.id, contractStart: today, contractEnd: addDays(today, 365), contractTypeCode: 'DIRECT_HOSPITAL', nationalityCode: 'SAU', rankGradeCode: 'N03', specialtyCode: 'NS003', ...(await jobPost(db)) };
    expect((await hr.get('/employees/onboarding-defaults')).body.positionCode).toBeNull();
    expect((await hr.post('/employees/onboard', base).set('Idempotency-Key', randomUUID())).body.error.code).toBe('POSITION_REQUIRED');
    const onboard = await hr.post('/employees/onboard', { ...base, positionCode: 'RN' }).set('Idempotency-Key', randomUUID());
    expect(onboard.status).toBe(201);
    const empId = onboard.body.employeeId as number;

    // The contract needs a second HR person (D-30): the elevated System Admin approves it.
    const contractId = onboard.body.contractId as number;
    await hr.upload(`/contracts/${contractId}/documents`, FILES.pdf, 'application/pdf');
    expect((await hr.post(`/contracts/${contractId}/transition`, { action: 'submit' })).body.status).toBe('PendingApproval');
    expect((await sa.post(`/contracts/${contractId}/transition`, { action: 'approve' })).body.status).toBe('Active');

    // Eligibility follows the credential held in the database.
    expect((await hr.get(`/eligibility/${empId}`)).body.status).toBe('INELIGIBLE');
    const cred = await hr.post('/credentials', { employeeId: empId, templateId: tpl.id, trackingData: { number: 'L-1', issue_date: addDays(today, -10), expiry_date: addDays(today, 300) } });
    expect(cred.status).toBe(201);
    await sa.post(`/credentials/${cred.body.id}/verify`, {});
    expect((await hr.get(`/eligibility/${empId}`)).body.status).toBe('ELIGIBLE');

    // RBAC still denies what it should, and the audit chain is intact.
    expect((await hr.get('/audit')).status).toBe(403);
    expect(await findChainBreaks(db)).toEqual([]);
    expect(await db.auditEntry.count({ where: { action: { in: ['SYSTEM_BOOTSTRAPPED', 'CATEGORY_CREATED', 'TEMPLATE_CREATED', 'EMPLOYEE_ONBOARDED'] } } })).toBe(4);
    void app;
  }, 120_000);
});

describeDb('B. the hospital baseline import (P7)', () => {
  let ctx: Awaited<ReturnType<typeof freshApp>>;
  let db: Db;
  beforeAll(async () => { ctx = await freshApp(); db = ctx.fresh.db; }, 180_000);
  afterAll(async () => { await ctx?.fresh.drop(); }, 60_000);

  it('rejects bad files and blocks on any invalid row, writing nothing', async () => {
    const { hr } = ctx;
    expect((await hr.post('/admin/baseline-import/preview', { file: { format: 'something-else' } })).body.error.code).toBe('VALIDATION_FAILED');
    const bad = clone(BASELINE);
    bad.units[0].departmentCode = 'NOWHERE';
    bad.positions.push({ ...bad.positions[0] }); // duplicate code
    bad.credentialTemplates.find((t: { code: string }) => t.code === 'BLS').scfhsEnabled = true; // no SCFHS number to check
    bad.credentialTemplates.find((t: { code: string }) => t.code === 'HOSPITAL_ID').scfhsAutoSuspend = true; // suspension without checks
    const preview = await hr.post('/admin/baseline-import/preview', { file: bad });
    expect(preview.body.canImport).toBe(false);
    expect(preview.body.totals.REJECTED).toBe(5); // the unit, both copies of the duplicated position, BLS and Hospital ID
    expect(preview.body.rows.filter((r: { status: string; section: string }) => r.status === 'REJECTED' && r.section === 'credentialTemplates').map((r: { code: string; issues: string[] }) => [r.code, r.issues])).toEqual([
      ['HOSPITAL_ID', ['scfhsAutoSuspend needs scfhsEnabled']],
      ['BLS', ['scfhsEnabled needs a field with pdplCategory SCFHS_REG']],
    ]);
    expect((await hr.post('/admin/baseline-import', { file: bad, reason: 'Initial hospital configuration' })).body.error.code).toBe('BASELINE_NOT_IMPORTABLE');
    expect(await db.unit.count()).toBe(0);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('only hospital-wide administrators may import', async () => {
    const dept = await ctx.hr.post('/departments', { code: 'TMPD', name: 'Temporary' });
    const unit = await ctx.hr.post('/units', { code: 'TMPU', name: 'Temporary', departmentId: dept.body.id });
    const user = await ctx.hr.post('/users', { email: 'scoped@fresh.example', displayName: 'Scoped HR', password: 'scoped-hr-password-9' }).set('Idempotency-Key', randomUUID());
    const grant = await ctx.hr.post('/role-assignments', { userId: user.body.id, role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [unit.body.id], reason: 'Unit HR for the import scope test' }).set('Idempotency-Key', randomUUID());
    expect(grant.status).toBe(201);
    const scoped = await signIn(ctx.app, 'scoped@fresh.example', 'scoped-hr-password-9');
    expect((await scoped.post('/admin/baseline-import/preview', { file: BASELINE })).body.error.code).toBe('SCOPE_NOT_COVERED');
    // Leave the database as the next test expects: the temporary rows stay, they are not part of the baseline.
  });

  it('previews, requests, is approved by a second administrator, and reproduces the baseline exactly', async () => {
    const { hr, sa } = ctx;
    const preview = await hr.post('/admin/baseline-import/preview', { file: BASELINE });
    expect(preview.status).toBe(200);
    expect(preview.body.canImport).toBe(true);
    expect(preview.body.totals).toMatchObject({ CREATE: 6 + 55 + 25 + 5 + 17, UNCHANGED: 0, CONFLICT: 0, REJECTED: 0, beds: 618, fields: 71 });

    const req = await hr.post('/admin/baseline-import', { file: BASELINE, reason: 'Initial hospital configuration from the approved baseline' });
    expect(req.status).toBe(202);
    expect(await db.unit.count({ where: { code: { not: 'TMPU' } } })).toBe(0); // nothing before approval
    expect((await hr.post(`/approvals/${req.body.requestId}/approve`, { reason: 'Self approval' })).body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
    const approved = await sa.post(`/approvals/${req.body.requestId}/approve`, { reason: 'Checked the preview' });
    expect(approved.body.status).toBe('EXECUTED');

    const baselineUnits = { code: { not: 'TMPU' } };
    expect(await db.department.count({ where: { code: { not: 'TMPD' } } })).toBe(6); // + Outpatient Department (owner, 2026-10-07)
    expect(await db.unit.count({ where: baselineUnits })).toBe(55); // wards, SCABU, Day Care, DS Cluster, Blood Collection; no INP_WARDS
    expect((await db.unit.aggregate({ where: baselineUnits, _sum: { bedCount: true } }))._sum.bedCount).toBe(618); // active beds, 2026-10-07
    expect(await db.bedCapacityLog.count({ where: { unit: baselineUnits } })).toBe(55);
    expect(await db.position.count()).toBe(25); // 16 + 9 from the 2026 roster (owner, 2026-10-07)
    expect(await db.position.count({ where: { replacedBy: { not: null } } })).toBe(3); // AHN, CI, HD (owner, 2026-10-07)
    expect(await db.credentialCategory.count()).toBe(5);
    expect(await db.credentialTemplate.count()).toBe(17);
    expect(await db.credentialTemplateField.count()).toBe(71);
    // Owner decision 2026-10-04: passport and Iqama optional for Saudi nationals, who hold a National ID instead.
    expect(await db.credentialTemplate.findMany({ where: { code: { in: ['PASSPORT', 'IQAMA', 'NATIONAL_ID', 'BLS'] } }, orderBy: { code: 'asc' }, select: { code: true, nationalityRule: true, nationalityCodes: true } })).toEqual([
      { code: 'BLS', nationalityRule: 'ALL', nationalityCodes: [] },
      { code: 'IQAMA', nationalityRule: 'EXCEPT', nationalityCodes: ['SAU'] },
      { code: 'NATIONAL_ID', nationalityRule: 'ONLY', nationalityCodes: ['SAU'] },
      { code: 'PASSPORT', nationalityRule: 'EXCEPT', nationalityCodes: ['SAU'] },
    ]);
    // Arabic names (owner, 2026-10-05): every type and every field has one.
    expect(await db.credentialTemplate.count({ where: { nameAr: null } })).toBe(0);
    expect(await db.credentialTemplateField.count({ where: { labelAr: null } })).toBe(0);
    expect(await db.credentialTemplate.findUniqueOrThrow({ where: { code: 'NATIONAL_ID' }, select: { nameAr: true, fields: { select: { key: true, labelAr: true }, orderBy: { ordinal: 'asc' } } } })).toEqual({
      nameAr: 'الهوية الوطنية',
      fields: [{ key: 'national_id_number', labelAr: 'رقم الهوية الوطنية' }, { key: 'issue_date', labelAr: 'تاريخ الإصدار' }, { key: 'expiry_date', labelAr: 'تاريخ الانتهاء (ميلادي/هجري)' }],
    });
    // The credential requirements matrix (owner, 2026-10-04): grace days, and SCFHS checks on the SCFHS licence only.
    expect(await db.credentialTemplate.findMany({ where: { code: { in: ['PASSPORT', 'IQAMA', 'NATIONAL_ID', 'SCFHS', 'EMP_CONTRACT', 'BLS'] } }, orderBy: { code: 'asc' }, select: { code: true, gracePeriodDays: true, scfhsEnabled: true, scfhsAutoSuspend: true } })).toEqual([
      { code: 'BLS', gracePeriodDays: 60, scfhsEnabled: false, scfhsAutoSuspend: false },
      { code: 'EMP_CONTRACT', gracePeriodDays: 0, scfhsEnabled: false, scfhsAutoSuspend: false },
      { code: 'IQAMA', gracePeriodDays: 30, scfhsEnabled: false, scfhsAutoSuspend: false },
      { code: 'NATIONAL_ID', gracePeriodDays: 30, scfhsEnabled: false, scfhsAutoSuspend: false },
      { code: 'PASSPORT', gracePeriodDays: 90, scfhsEnabled: false, scfhsAutoSuspend: false },
      { code: 'SCFHS', gracePeriodDays: 60, scfhsEnabled: true, scfhsAutoSuspend: true },
    ]);
    expect(await db.unit.count({ where: { criticalArea: { not: null } } })).toBe(11);
    expect(await db.auditEntry.count({ where: { action: 'BASELINE_IMPORTED' } })).toBe(1);
    expect((await hr.get('/employees/onboarding-defaults')).body.positionCode).toBe('SN'); // E6 now has its position
    expect(await findChainBreaks(db)).toEqual([]);
  }, 120_000);

  it('is idempotent: the same file again creates nothing', async () => {
    const preview = await ctx.hr.post('/admin/baseline-import/preview', { file: BASELINE });
    expect(preview.body.totals).toMatchObject({ CREATE: 0, UNCHANGED: 6 + 55 + 25 + 5 + 17, CONFLICT: 0, REJECTED: 0 });
    expect((await ctx.hr.post('/admin/baseline-import', { file: BASELINE, reason: 'Run the same baseline a second time' })).body.error.code).toBe('NOTHING_TO_IMPORT');
    expect(await db.credentialTemplate.count()).toBe(17);
  });

  it('never overwrites: a differing existing record is a conflict, and a conflict arising after the request rolls the whole import back', async () => {
    const { hr, sa } = ctx;
    const changed = clone(BASELINE);
    changed.units[0].bedCount += 1;
    const preview = await hr.post('/admin/baseline-import/preview', { file: changed });
    expect(preview.body.totals.CONFLICT).toBe(1);
    expect(preview.body.rows.find((r: { status: string }) => r.status === 'CONFLICT').issues[0]).toMatch(/bedCount: stored \d+, file \d+/);

    // A file adding two new units is requested; before approval someone creates one of them differently.
    const extra = clone(BASELINE);
    extra.units.push({ code: 'NEW_A', name: 'New A', departmentCode: 'GNSP', bedCount: 5 }, { code: 'NEW_B', name: 'New B', departmentCode: 'GNSP', bedCount: 6 });
    const req = await hr.post('/admin/baseline-import', { file: extra, reason: 'Two additional units from the planning office' });
    expect(req.status).toBe(202);
    const gnsp = await db.department.findUniqueOrThrow({ where: { code: 'GNSP' } });
    await hr.post('/units', { code: 'NEW_B', name: 'Different', departmentId: gnsp.id, bedCount: 1 });
    const approve = await sa.post(`/approvals/${req.body.requestId}/approve`, { reason: 'Checked' });
    expect(approve.body.error.code).toBe('BASELINE_CHANGED_SINCE_REQUEST');
    expect(await db.unit.findUnique({ where: { code: 'NEW_A' } })).toBeNull(); // all or nothing
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: req.body.requestId } })).status).toBe('PENDING');
  });
});
