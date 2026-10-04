// Credentials and clinical eligibility through the HTTP API against PostgreSQL:
// spec §5.1.4 (requirements), §5.1.5 / §5.3 (evidence, D1–D5), §5.2 (lifecycle,
// L1–L3), §6.1 (materialized state, L6), §6.1.1 grace (L8), §6.1.1.1 transitions
// (L10), §6.1.2 waivers (L9), §8.1 Credentials row.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { findChainBreaks } from '../src/lib/audit.js';
import { addDays, riyadhDate } from '../src/lib/dates.js';
import { toHijriIso } from '../src/lib/hijri.js';
import type { Db } from '../src/lib/prisma.js';
import { FILES, loadTemplate, makeNurse, makeOrg, makeTemplate, makeUser, openDb, signIn, TEST_URL, testApp, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const today = () => riyadhDate();
const fields = (issue: string, expiry: string) => ({ trackingData: { licence_number: 'L-123', issue_date: issue, expiry_date: expiry } });

describeDb('credentials and eligibility', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let hr: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    org = await makeOrg(db);
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
  });
  afterAll(async () => { await db.$disconnect(); });

  type StoredReason = { code: string; severity: string; templateId?: number; until?: string };
  const state = async (employeeId: number) => {
    const s = await db.eligibilityState.findUnique({ where: { employeeId } });
    return s && { ...s, reasons: s.reasons as StoredReason[] };
  };
  const require = (templateId: number, unitId: number, extra: object = {}) => hr.post('/credential-requirements', { templateId, unitId, ...extra });
  /** Records, uploads evidence and verifies a credential for a nurse. Returns its id. */
  async function validCredential(employeeId: number, templateId: number, issue = addDays(today(), -30), expiry = addDays(today(), 365)) {
    const rec = await hr.post('/credentials', { employeeId, templateId, ...fields(issue, expiry) });
    expect(rec.status).toBe(201);
    expect((await hr.upload(`/credentials/${rec.body.id}/documents`, FILES.pdf, 'application/pdf')).status).toBe(201);
    expect((await hr.post(`/credentials/${rec.body.id}/verify`)).status).toBe(200);
    return rec.body.id as number;
  }

  describe('requirements drive the materialized state in the same transaction (§5.1.4, L6)', () => {
    it('adding a MANDATORY rule makes a nurse without it INELIGIBLE at once; deleting it restores ELIGIBLE (D-4)', async () => {
      const unit = await db.unit.create({ data: { code: `RQ${Date.now()}`, name: 'Req unit', departmentId: org.dept.id } });
      const { emp } = await makeNurse(db, unit.id);
      const tpl = await makeTemplate(db);
      const made = await require(tpl.id, unit.id);
      expect(made.status).toBe(201);
      expect(made.body.affectedEmployees).toBe(1);
      const s1 = await state(emp.id);
      expect(s1?.status).toBe('INELIGIBLE');
      expect(s1?.reasons).toEqual([expect.objectContaining({ code: 'CREDENTIAL_MISSING', templateId: tpl.id })]);
      expect((await hr.del(`/credential-requirements/${made.body.id}`)).status).toBe(200);
      const s2 = await state(emp.id);
      expect(s2?.status).toBe('ELIGIBLE');
      expect(s2?.reasons).toEqual([expect.objectContaining({ code: 'NO_REQUIREMENTS_CONFIGURED', severity: 'INFO' })]);
      expect(await db.auditEntry.count({ where: { action: { in: ['REQUIREMENT_CREATED', 'REQUIREMENT_DELETED'] }, resourceId: String(made.body.id), priority: 'HIGH' } })).toBe(2);
    });

    it('validates targets and transition deadlines; the same rule cannot exist twice', async () => {
      const tpl = await makeTemplate(db);
      expect((await require(tpl.id, org.unitA.id, { policyStatus: 'TRANSITION' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await require(tpl.id, org.unitA.id, { transitionDeadline: '2030-01-01' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await require(tpl.id, 2_000_000_000)).body.error.code).toBe('UNIT_NOT_FOUND');
      expect((await require(tpl.id, org.unitA.id, { positionCode: 'NOPE' })).body.error.code).toBe('POSITION_NOT_FOUND');
      expect((await require(tpl.id, org.unitA.id)).status).toBe(201);
      expect((await require(tpl.id, org.unitA.id)).body.error.code).toBe('REQUIREMENT_EXISTS');
    });

    it('scope: a unit-scoped HR admin manages rules only for their units; supervisors cannot write rules', async () => {
      const tpl = await makeTemplate(db);
      const scoped = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      expect((await scoped.post('/credential-requirements', { templateId: tpl.id, unitId: org.unitB.id })).body.error.code).toBe('SCOPE_NOT_COVERED');
      const inside = await scoped.post('/credential-requirements', { templateId: tpl.id, unitId: org.unitA.id });
      expect(inside.status).toBe(201);
      const outside = await hr.post('/credential-requirements', { templateId: tpl.id, unitId: org.unitB.id });
      expect(outside.status).toBe(201);
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      expect((await sup.post('/credential-requirements', { templateId: tpl.id, unitId: org.unitB.id })).body.error.code).toBe('FORBIDDEN');
      for (const client of [scoped, sup]) {
        const all = await client.get('/credential-requirements');
        expect(all.status).toBe(200);
        expect(all.body.items.map((r: { id: number }) => r.id)).toContain(inside.body.id);
        expect(all.body.items.every((r: { unitId: number }) => r.unitId === org.unitA.id)).toBe(true);
        expect((await client.get(`/credential-requirements?unitId=${org.unitB.id}`)).body).toMatchObject({ items: [], total: 0 });
      }
      expect((await hr.get(`/credential-requirements?unitId=${org.unitB.id}`)).body.items.map((r: { id: number }) => r.id)).toContain(outside.body.id);
    });

    it('bulk set applies all entries in one transaction and refreshes the units', async () => {
      const unit = await db.unit.create({ data: { code: `BK${Date.now()}`, name: 'Bulk unit', departmentId: org.dept.id } });
      const { emp } = await makeNurse(db, unit.id);
      const [t1, t2] = [await makeTemplate(db), await makeTemplate(db)];
      const res = await hr.post('/credential-requirements/bulk', { items: [{ templateId: t1.id, unitId: unit.id }, { templateId: t2.id, unitId: unit.id, positionCode: 'SN' }] });
      expect(res.body).toMatchObject({ created: 2, updated: 0, affectedEmployees: 1 });
      expect((await state(emp.id))?.reasons).toHaveLength(2);
    });
  });

  describe('verification lifecycle (§5.2, L1–L3)', () => {
    it('record → evidence → verify makes the nurse ELIGIBLE; verification needs evidence when the template requires it', async () => {
      const unit = await db.unit.create({ data: { code: `VL${Date.now()}`, name: 'Lifecycle unit', departmentId: org.dept.id } });
      const { emp } = await makeNurse(db, unit.id);
      const tpl = await makeTemplate(db);
      await require(tpl.id, unit.id);
      const rec = await hr.post('/credentials', { employeeId: emp.id, templateId: tpl.id, ...fields(addDays(today(), -10), addDays(today(), 400)) });
      expect(rec.status).toBe(201);
      expect((await state(emp.id))?.reasons[0]).toMatchObject({ code: 'CREDENTIAL_NOT_VERIFIED' });
      expect((await hr.post(`/credentials/${rec.body.id}/verify`)).body.error.code).toBe('EVIDENCE_REQUIRED');
      const up = await hr.upload(`/credentials/${rec.body.id}/documents`, FILES.pdf, 'application/pdf', 'licence.pdf');
      expect(up.status).toBe(201);
      const v = await hr.post(`/credentials/${rec.body.id}/verify`);
      expect(v.body).toEqual({ id: rec.body.id, status: 'Valid' });
      const stored = await db.credential.findUniqueOrThrow({ where: { id: rec.body.id } });
      expect(stored.latestEvidenceId).toBe(up.body.id);
      expect((await db.documentVersion.findUniqueOrThrow({ where: { id: up.body.id } })).reviewStatus).toBe('APPROVED');
      expect((await state(emp.id))?.status).toBe('ELIGIBLE');
      expect((await hr.post(`/credentials/${rec.body.id}/verify`)).body.error.code).toBe('CREDENTIAL_NOT_PENDING');
    });

    it('stores ExpiringSoon within 60 days (D-39) and Expired past expiry; tracking data is validated against the template', async () => {
      const { emp } = await makeNurse(db, org.unitB.id);
      const tpl = await makeTemplate(db);
      const soon = await validCredential(emp.id, tpl.id, addDays(today(), -300), addDays(today(), 60));
      expect((await db.credential.findUniqueOrThrow({ where: { id: soon } })).status).toBe('ExpiringSoon');
      const later = await validCredential(emp.id, (await makeTemplate(db)).id, addDays(today(), -300), addDays(today(), 61));
      expect((await db.credential.findUniqueOrThrow({ where: { id: later } })).status).toBe('Valid');
      const bad = await hr.post('/credentials', { employeeId: emp.id, templateId: tpl.id, trackingData: { licence_number: '', issue_date: 'nope', expiry_date: '2020-01-01', extra: 'x' } });
      expect(bad.body.error.code).toBe('TRACKING_DATA_INVALID');
      expect(bad.body.error.details).toEqual(expect.arrayContaining(['extra: not a field of this template', 'licence_number: required', 'issue_date: must be YYYY-MM-DD']));
    });

    it('uses Gregorian clinical dates for Hijri Iqama expiry, including renewal, and rejects conflicting or invalid dates', async () => {
      await db.credentialCategory.upsert({ where: { code: 'IDENTITY' }, update: {}, create: { code: 'IDENTITY', name: 'Identity' } });
      const pendingTemplate = await hr.post('/credential-templates', {
        code: uniq('IQ').toUpperCase(), name: 'Test Iqama', categoryCode: 'IDENTITY', hasExpiry: true, requiresUpload: false,
        fieldDefs: [
          { key: 'issue_date', label: 'Issue date', type: 'date', required: true, displayOrder: 1, isIssueDate: true },
          { key: 'expiry_date', label: 'Expiry date (Hijri)', type: 'date_hijri', required: true, displayOrder: 2, isExpiryDate: true },
        ],
        reason: 'Validate Iqama expiry in the Umm al-Qura calendar',
      });
      expect(pendingTemplate.status).toBe(202);
      const secondHr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      const approvedTemplate = await secondHr.post(`/approvals/${pendingTemplate.body.requestId}/approve`, { reason: 'Calendar policy reviewed' });
      expect(approvedTemplate.status).toBe(200);
      const templateId = approvedTemplate.body.resultId as number;
      const { emp } = await makeNurse(db, org.unitA.id);
      const expiry = addDays(today(), 365);
      const trackingData = { issue_date: addDays(today(), -30), expiry_date: toHijriIso(expiry) };
      const body = { employeeId: emp.id, templateId, trackingData };
      const conflict = await hr.post('/credentials', { ...body, expiryDate: addDays(expiry, 1) });
      expect(conflict.status).toBe(400);
      expect(conflict.body.error.details).toContain('expiryDate: disagrees with expiry_date');
      const invalid = await hr.post('/credentials', { ...body, trackingData: { ...trackingData, expiry_date: '1448-13-01' } });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('TRACKING_DATA_INVALID');

      const recorded = await hr.post('/credentials', body);
      expect(recorded.status).toBe(201);
      const id = recorded.body.id as number;
      const stored = await db.credential.findUniqueOrThrow({ where: { id } });
      expect(stored.expiryDate?.toISOString().slice(0, 10)).toBe(expiry);
      expect(stored.expiryDateHijri).toBe(trackingData.expiry_date);
      expect((await hr.post(`/credentials/${id}/verify`)).body.status).toBe('Valid');

      const renewalExpiry = addDays(today(), 500);
      const staged = await hr.post(`/credentials/${id}/renewal`, { trackingData: { ...trackingData, expiry_date: toHijriIso(renewalExpiry) } });
      expect(staged.status).toBe(200);
      const during = await db.credential.findUniqueOrThrow({ where: { id } });
      expect((during.pendingData as { expiryDate: string }).expiryDate).toBe(renewalExpiry);
      expect(during.expiryDate?.toISOString().slice(0, 10)).toBe(expiry);
      expect((await hr.post(`/credentials/${id}/renewal/approve`)).body.status).toBe('Valid');
      const after = await db.credential.findUniqueOrThrow({ where: { id } });
      expect(after.expiryDate?.toISOString().slice(0, 10)).toBe(renewalExpiry);
      expect(after.expiryDateHijri).toBe(toHijriIso(renewalExpiry));
    });

    it('suspension and revocation make the nurse INELIGIBLE immediately (L3); revoked is final', async () => {
      const unit = await db.unit.create({ data: { code: `SR${Date.now()}`, name: 'Suspend unit', departmentId: org.dept.id } });
      const { emp } = await makeNurse(db, unit.id);
      const tpl = await makeTemplate(db);
      await require(tpl.id, unit.id);
      const id = await validCredential(emp.id, tpl.id);
      expect((await state(emp.id))?.status).toBe('ELIGIBLE');
      expect((await hr.post(`/credentials/${id}/suspend`, { reason: 'SCFHS query' })).body.status).toBe('Suspended');
      expect((await state(emp.id))?.reasons[0]).toMatchObject({ code: 'CREDENTIAL_SUSPENDED' });
      expect((await hr.post(`/credentials/${id}/revoke`, { reason: 'Licence withdrawn' })).body.status).toBe('Revoked');
      expect((await hr.post(`/credentials/${id}/suspend`, { reason: 'again' })).body.error.code).toBe('CREDENTIAL_REVOKED');
      expect(await db.auditEntry.count({ where: { resource: 'credential', resourceId: String(id), action: { in: ['CREDENTIAL_SUSPENDED', 'CREDENTIAL_REVOKED'] }, priority: 'HIGH' } })).toBe(2);
    });

    it('nobody reviews their own credential (separation of duties)', async () => {
      const { emp } = await makeNurse(db, org.unitA.id);
      const tpl = await makeTemplate(db, { requiresUpload: false });
      const hrNurse = await signIn(app, (await makeUser(db, { employeeId: emp.id, roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      const rec = await hrNurse.post('/credentials', { employeeId: emp.id, templateId: tpl.id, ...fields(addDays(today(), -1), addDays(today(), 100)) });
      expect((await hrNurse.post(`/credentials/${rec.body.id}/verify`)).body.error.code).toBe('SELF_REVIEW_FORBIDDEN');
      expect((await hr.post(`/credentials/${rec.body.id}/verify`)).status).toBe(200);
    });
  });

  describe('evidence rules (§5.1.5, §5.3.2, D1–D5)', () => {
    it('rejects empty, oversized, disallowed and mismatched files; accepts PDF and PNG as new versions', async () => {
      const small = testApp(db, { UPLOAD_MAX_SIZE_BYTES: '64' });
      const hrSmall = await signIn(small, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      const { emp } = await makeNurse(db, org.unitA.id);
      const tpl = await makeTemplate(db);
      const rec = await hr.post('/credentials', { employeeId: emp.id, templateId: tpl.id, ...fields(addDays(today(), -1), addDays(today(), 100)) });
      const path = `/credentials/${rec.body.id}/documents`;
      expect((await hr.upload(path, Buffer.alloc(0), 'application/pdf')).body.error.code).toBe('UPLOAD_EMPTY');
      expect((await hrSmall.upload(path, Buffer.concat([FILES.pdf, Buffer.alloc(100)]), 'application/pdf')).status).toBe(413);
      expect((await hr.upload(path, FILES.exe, 'application/x-msdownload', 'x.exe')).body.error.code).toBe('UPLOAD_TYPE_NOT_ALLOWED');
      expect((await hr.upload(path, FILES.exe, 'application/pdf')).body.error.code).toBe('UPLOAD_TYPE_MISMATCH');
      expect((await hr.upload(path, FILES.png, 'application/pdf')).body.error.code).toBe('UPLOAD_TYPE_MISMATCH');
      const v1 = await hr.upload(path, FILES.pdf, 'application/pdf');
      const v2 = await hr.upload(path, FILES.png, 'image/png', 'scan.png');
      expect([v1.body.version, v2.body.version]).toEqual([1, 2]);
    });

    it('serves only CLEAN files, only to the owner and scoped HR; supervisors never see or download evidence', async () => {
      const { emp, user } = await makeNurse(db, org.unitA.id, { account: true });
      const tpl = await makeTemplate(db);
      const id = await validCredential(emp.id, tpl.id);
      const docs = await hr.get(`/credentials/${id}/documents`);
      const docId = docs.body.items[0].id as number;
      expect(docs.body.items[0]).toMatchObject({ isCurrentEvidence: true, reviewStatus: 'APPROVED' });
      const dl = await hr.get(`/credentials/${id}/documents/${docId}`);
      expect(dl.status).toBe(200);
      expect(dl.headers['content-type']).toBe('application/pdf');
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect(await db.auditEntry.count({ where: { action: 'DOCUMENT_DOWNLOADED', resourceId: String(id) } })).toBe(1);

      const own = await signIn(app, user!.email);
      expect((await own.get(`/credentials/${id}/documents/${docId}`)).status).toBe(200);
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      expect((await sup.get(`/credentials/${id}/documents`)).status).toBe(403);
      expect((await sup.get(`/credentials/${id}/documents/${docId}`)).status).toBe(403);
      expect((await sup.post(`/credentials/${id}/documents/${docId}/link`, {})).status).toBe(403); // nor a 60-second link (D-53)
      // The supervisor compliance view carries no tracking data, pending values or evidence ids.
      const view = await sup.get(`/credentials/${id}`);
      expect(view.status).toBe(200);
      expect(view.body).not.toHaveProperty('trackingData');
      expect(view.body).not.toHaveProperty('pendingData');
      expect(view.body).not.toHaveProperty('latestEvidenceId');

      await db.documentVersion.update({ where: { id: docId }, data: { scanStatus: 'INFECTED' } });
      expect((await hr.get(`/credentials/${id}/documents/${docId}`)).body.error.code).toBe('DOCUMENT_NOT_CLEAN');
    });

    it('another employee cannot read or upload to someone else\'s credential', async () => {
      const { emp } = await makeNurse(db, org.unitA.id);
      const other = await makeNurse(db, org.unitA.id, { account: true });
      const tpl = await makeTemplate(db);
      const id = await validCredential(emp.id, tpl.id);
      const c = await signIn(app, other.user!.email);
      expect((await c.get(`/credentials/${id}`)).status).toBe(403);
      expect((await c.upload(`/credentials/${id}/documents`, FILES.pdf, 'application/pdf')).status).toBe(403);
      expect((await c.get('/credentials')).status).toBe(403);
    });
  });

  describe('grace periods (§6.1.1 acceptance criteria, L8)', () => {
    async function expiredWithGrace() {
      const unit = await db.unit.create({ data: { code: `GR${Date.now()}${Math.random().toString(36).slice(2, 5)}`, name: 'Grace unit', departmentId: org.dept.id } });
      const { emp, user } = await makeNurse(db, unit.id, { account: true });
      const tpl = await makeTemplate(db, { gracePeriodDays: 30 });
      await require(tpl.id, unit.id);
      // Verified last year, expired five days ago.
      const id = await validCredential(emp.id, tpl.id, addDays(today(), -400), addDays(today(), -5));
      expect((await state(emp.id))?.status).toBe('INELIGIBLE');
      return { emp, user: user!, tpl, id };
    }

    it('"Grace activation" + "Eligibility with grace": a staged renewal puts the nurse in ELIGIBLE_WITH_GRACE, never silently', async () => {
      const { emp, user, id } = await expiredWithGrace();
      const own = await signIn(app, user.email);
      const renewal = await own.post(`/credentials/${id}/renewal`, fields(addDays(today(), -2), addDays(today(), 700)));
      expect(renewal.status).toBe(200);
      const s = await state(emp.id);
      expect(s?.status).toBe('ELIGIBLE_WITH_GRACE');
      expect(s?.reasons[0]).toMatchObject({ code: 'GRACE_ACTIVE', until: addDays(addDays(today(), -5), 30) });
      const cred = await db.credential.findUniqueOrThrow({ where: { id } });
      expect(cred.graceCycleId).toBeTruthy();
      expect(await db.auditEntry.count({ where: { action: 'GRACE_ACTIVATED', resourceId: String(id), priority: 'HIGH' } })).toBe(1);
      // Notified: the nurse ("Renewal Required — Grace Period Active") and scoped HR.
      const notes = await db.notification.findMany({ where: { employeeId: emp.id, type: 'ELIGIBILITY' } });
      expect(notes.map((n) => n.recipientId)).toContain(user.id);
      expect(notes.find((n) => n.recipientId === user.id)?.title).toBe('Renewal Required — Grace Period Active');
      expect(notes.length).toBeGreaterThan(1);
      // Re-evaluating the same cycle does not activate grace twice.
      await hr.post(`/eligibility/${emp.id}/refresh`);
      expect(await db.auditEntry.count({ where: { action: 'GRACE_ACTIVATED', resourceId: String(id) } })).toBe(1);
    });

    it('"Renewal approval closes grace": the new dates are promoted and grace fields cleared', async () => {
      const { emp, user, id } = await expiredWithGrace();
      const own = await signIn(app, user.email);
      await own.post(`/credentials/${id}/renewal`, fields(addDays(today(), -2), addDays(today(), 700)));
      await own.upload(`/credentials/${id}/documents`, FILES.pdf, 'application/pdf', 'renewal.pdf');
      const ok = await hr.post(`/credentials/${id}/renewal/approve`);
      expect(ok.body).toEqual({ id, status: 'Valid' });
      const cred = await db.credential.findUniqueOrThrow({ where: { id } });
      expect(cred).toMatchObject({ graceCycleId: null, graceExpiryDate: null, pendingData: null });
      expect((await state(emp.id))?.status).toBe('ELIGIBLE');
      expect(await db.auditEntry.count({ where: { action: 'GRACE_COMPLETED', resourceId: String(id) } })).toBe(1);
    });

    it('"Renewal rejection closes grace": INELIGIBLE at once, and re-submitting cannot re-open the same window', async () => {
      const { emp, user, id } = await expiredWithGrace();
      const own = await signIn(app, user.email);
      await own.post(`/credentials/${id}/renewal`, fields(addDays(today(), -2), addDays(today(), 700)));
      expect((await state(emp.id))?.status).toBe('ELIGIBLE_WITH_GRACE');
      expect((await hr.post(`/credentials/${id}/renewal/reject`, { reason: 'Document illegible' })).status).toBe(200);
      expect((await state(emp.id))?.status).toBe('INELIGIBLE');
      expect(await db.auditEntry.count({ where: { action: 'GRACE_CLOSED', resourceId: String(id), priority: 'HIGH' } })).toBe(1);
      await own.post(`/credentials/${id}/renewal`, fields(addDays(today(), -2), addDays(today(), 700)));
      expect((await state(emp.id))?.status).toBe('INELIGIBLE');
    });

    it('"Suspension/revocation overrides grace"', async () => {
      const { emp, user, id } = await expiredWithGrace();
      await (await signIn(app, user.email)).post(`/credentials/${id}/renewal`, fields(addDays(today(), -2), addDays(today(), 700)));
      await hr.post(`/credentials/${id}/suspend`, { reason: 'Under investigation' });
      expect((await state(emp.id))?.reasons[0]).toMatchObject({ code: 'CREDENTIAL_SUSPENDED' });
    });
  });

  describe('policy transitions (§6.1.1.1 acceptance criteria, L10)', () => {
    it('"Transition mode" warns until the deadline; "Hard deadline enforcement" blocks once it has passed', async () => {
      const unit = await db.unit.create({ data: { code: `TR${Date.now()}`, name: 'Transition unit', departmentId: org.dept.id } });
      const { emp } = await makeNurse(db, unit.id);
      const tpl = await makeTemplate(db);
      const r = await require(tpl.id, unit.id, { policyStatus: 'TRANSITION', transitionDeadline: addDays(today(), 30) });
      const s1 = await state(emp.id);
      expect(s1?.status).toBe('ELIGIBLE_WITH_POLICY_WARNING');
      expect(s1?.reasons[0]).toMatchObject({ code: 'POLICY_TRANSITION_WARNING', until: addDays(today(), 30) });
      expect((await hr.put(`/credential-requirements/${r.body.id}`, { transitionDeadline: addDays(today(), -1) })).status).toBe(200);
      expect((await state(emp.id))?.status).toBe('INELIGIBLE');
    });
  });

  describe('emergency waivers (§6.1.2 acceptance criteria, L9)', () => {
    async function ineligibleNurse() {
      const unit = await db.unit.create({ data: { code: `WV${Date.now()}${Math.random().toString(36).slice(2, 5)}`, name: 'Waiver unit', departmentId: org.dept.id } });
      const { emp } = await makeNurse(db, unit.id);
      const tpl = await makeTemplate(db);
      await require(tpl.id, unit.id);
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [unit.id] }] })).email);
      return { emp, tpl, sup, unit };
    }
    const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

    it('"Waiver grants eligibility" + "High-priority audit" with the supervisor and the clinical justification', async () => {
      const { emp, tpl, sup } = await ineligibleNurse();
      expect((await state(emp.id))?.status).toBe('INELIGIBLE');
      const w = await sup.post('/waivers', { employeeId: emp.id, templateId: tpl.id, reason: 'ICU short-staffed; licence renewal confirmed by phone', expiresAt: inHours(24) });
      expect(w.status).toBe(201);
      expect(w.body.eligibility).toBe('ELIGIBLE');
      const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'WAIVER_GRANTED', resourceId: String(w.body.id) } });
      expect(audit.priority).toBe('HIGH');
      expect(audit.changes).toMatchObject({ justification: 'ICU short-staffed; licence renewal confirmed by phone', templateId: tpl.id });
    });

    it('"Maximum duration": more than 72 hours, or an expiry in the past, is rejected', async () => {
      const { emp, tpl, sup } = await ineligibleNurse();
      expect((await sup.post('/waivers', { employeeId: emp.id, templateId: tpl.id, reason: 'cover', expiresAt: inHours(72.1) })).body.error.code).toBe('WAIVER_WINDOW_EXCEEDED');
      expect((await sup.post('/waivers', { employeeId: emp.id, templateId: tpl.id, reason: 'cover', expiresAt: inHours(-1) })).body.error.code).toBe('WAIVER_EXPIRY_IN_PAST');
      expect((await sup.post('/waivers', { employeeId: emp.id, templateId: tpl.id, reason: '   ', expiresAt: inHours(2) })).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('"Authority check": only a Supervisor or HR Admin covering the nurse; System Admin and employees get 403', async () => {
      const { emp, tpl } = await ineligibleNurse();
      const body = { employeeId: emp.id, templateId: tpl.id, reason: 'cover', expiresAt: inHours(2) };
      const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
      expect((await sa.post('/waivers', body)).status).toBe(403);
      const nurse = await signIn(app, (await makeUser(db)).email);
      expect((await nurse.post('/waivers', body)).status).toBe(403);
      const otherSup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitC.id] }] })).email);
      expect((await otherSup.post('/waivers', body)).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await hr.post('/waivers', body)).status).toBe(201);
    });

    it('"Automatic expiry": once the waiver has lapsed the engine is INELIGIBLE again', async () => {
      const { emp, tpl, sup } = await ineligibleNurse();
      const w = await sup.post('/waivers', { employeeId: emp.id, templateId: tpl.id, reason: 'cover', expiresAt: inHours(1) });
      await db.$executeRaw`UPDATE credential_waivers SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 second' WHERE id = ${w.body.id}`;
      const r = await sup.get(`/eligibility/${emp.id}/evaluate?date=${today()}`);
      expect(r.body.status).toBe('INELIGIBLE');
    });
  });

  describe('eligibility reads and self-service', () => {
    it('evaluates a nurse for a given day without storing it; the contract must cover that day', async () => {
      const { emp } = await makeNurse(db, org.unitA.id);
      const later = await hr.get(`/eligibility/${emp.id}/evaluate?date=${addDays(today(), 400)}`);
      expect(later.body.reasons.map((r: { code: string }) => r.code)).toContain('NO_CONTRACT_COVERAGE');
      expect((await hr.get(`/eligibility/${emp.id}/evaluate?date=not-a-date`)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('an employee submits their own credential and reads their own state; a supervisor lists only their units', async () => {
      const { emp, user } = await makeNurse(db, org.unitB.id, { account: true });
      const tpl = await makeTemplate(db);
      const own = await signIn(app, user!.email);
      expect((await own.post('/credentials/me', { templateId: tpl.id, ...fields(addDays(today(), -1), addDays(today(), 200)) })).status).toBe(201);
      expect((await own.get('/credentials/me')).body.items).toHaveLength(1);
      await hr.post(`/eligibility/${emp.id}/refresh`);
      expect((await own.get('/eligibility/me')).status).toBe(200);
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitC.id] }] })).email);
      const list = await sup.get('/eligibility');
      expect(list.body.items.every((s: { employee: { unitId: number } }) => s.employee.unitId === org.unitC.id)).toBe(true);
      expect((await sup.get(`/eligibility/${emp.id}`)).status).toBe(403);
    });
  });

  describe('catalog', () => {
    const reason = 'Hospital policy memo 2026-14';
    const approve = async (client: typeof hr, requestId: number) => client.post(`/approvals/${requestId}/approve`, { reason: 'Checked against the memo' });

    it('credential categories are created and changed through four-eyes by system-wide admins only (P8)', async () => {
      const code = uniq('CAT').toUpperCase().slice(0, 30);
      const hr2 = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      const scopedHr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      const nurse = await signIn(app, (await makeUser(db)).email);

      expect((await nurse.post('/credential-categories', { code, name: 'Research', reason })).status).toBe(403);
      expect((await scopedHr.post('/credential-categories', { code, name: 'Research', reason })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await hr.post('/credential-categories', { code, name: 'Research', reason: 'short' })).body.error.code).toBe('VALIDATION_FAILED');

      const created = await hr.post('/credential-categories', { code, name: 'Research', description: 'Research credentials', displayOrder: 9, reason });
      expect(created.status).toBe(202);
      expect(await db.credentialCategory.findUnique({ where: { code } })).toBeNull(); // nothing until approved
      expect((await approve(hr, created.body.requestId)).body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
      expect((await approve(hr2, created.body.requestId)).body.status).toBe('EXECUTED');
      expect(await db.credentialCategory.findUnique({ where: { code } })).toMatchObject({ name: 'Research', displayOrder: 9 });
      expect((await hr.post('/credential-categories', { code, name: 'Again', reason })).body.error.code).toBe('CATEGORY_EXISTS');

      const change = await hr.patch(`/credential-categories/${code}`, { name: 'Research & audit', reason });
      expect(change.status).toBe(202);
      // A second administrator's competing request (one pending request per initiator and action — R11).
      const hr3 = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      const racing = await hr3.patch(`/credential-categories/${code}`, { name: 'Research & compliance', reason: `${reason} (second)` });
      expect(racing.status).toBe(202);
      await approve(hr2, change.body.requestId);
      expect((await db.credentialCategory.findUniqueOrThrow({ where: { code } })).name).toBe('Research & audit');
      expect((await approve(hr2, racing.body.requestId)).body.error.code).toBe('CATEGORY_CHANGED_SINCE_REQUEST');
      expect((await hr.patch(`/credential-categories/${code}`, { name: 'Research & audit', reason })).body.error.code).toBe('NO_CHANGES');
      expect(await db.auditEntry.count({ where: { resource: 'credential_category', resourceId: code } })).toBe(2);
      expect((await hr.get('/credential-categories')).body.items.map((c: { code: string }) => c.code)).toContain(code);
    });

    it('only system-wide administrators change templates; every change waits for a second one (D-24, D-25)', async () => {
      const scoped = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      const hr2 = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      const body = { code: `TPL_${Date.now()}`, name: 'New template', categoryCode: 'LICENSURE', reason };
      expect((await scoped.post('/credential-templates', body)).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await hr.post('/credential-templates', { ...body, reason: 'short' })).body.error.code).toBe('VALIDATION_FAILED');

      const asked = await hr.post('/credential-templates', body);
      expect(asked.status).toBe(202);
      expect(asked.body.status).toBe('PENDING_APPROVAL');
      expect(await db.credentialTemplate.findUnique({ where: { code: body.code } })).toBeNull();
      // A scoped HR Admin neither sees nor decides catalog requests.
      expect((await scoped.get('/approvals')).body.items.some((r: { id: number }) => r.id === asked.body.requestId)).toBe(false);
      expect((await approve(hr, asked.body.requestId)).body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
      expect((await approve(scoped, asked.body.requestId)).status).toBe(403);
      const done = await approve(hr2, asked.body.requestId);
      expect(done.body.status).toBe('EXECUTED');
      const tpl = await db.credentialTemplate.findUniqueOrThrow({ where: { code: body.code } });
      expect(await db.auditEntry.count({ where: { action: 'TEMPLATE_CREATED', resourceId: String(tpl.id), actorUserId: { not: null }, priority: 'HIGH' } })).toBe(1);

      expect((await hr.patch(`/credential-templates/${tpl.id}`, { gracePeriodDays: 91, reason })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await hr.patch(`/credential-templates/${tpl.id}`, { gracePeriodDays: 0, reason })).body.error.code).toBe('NO_CHANGES');
      const change = await hr.patch(`/credential-templates/${tpl.id}`, { gracePeriodDays: 14, reason });
      expect(change.status).toBe(202);
      expect((await db.credentialTemplate.findUniqueOrThrow({ where: { id: tpl.id } })).gracePeriodDays).toBe(0);
      await approve(hr2, change.body.requestId);
      expect((await db.credentialTemplate.findUniqueOrThrow({ where: { id: tpl.id } })).gracePeriodDays).toBe(14);
      expect((await (await signIn(app, (await makeUser(db)).email)).get('/credential-templates')).status).toBe(200);
    });

    it('field definitions come back in the order they were given, from the relational table (P1)', async () => {
      const tpl = await makeTemplate(db);
      const listed = (await hr.get('/credential-templates')).body.items.find((t: { id: number }) => t.id === tpl.id);
      expect(listed.fieldDefs.map((f: { key: string }) => f.key)).toEqual(['licence_number', 'issue_date', 'expiry_date']);
      expect(listed.fieldDefs[1]).toEqual({ key: 'issue_date', label: 'Issue date', type: 'date', required: true, displayOrder: 2, isIssueDate: true });
      expect(listed).not.toHaveProperty('fieldDefsLegacy');
    });

    it('a partial change leaves the other fields as stored', async () => {
      const tpl = await makeTemplate(db);
      const hr2 = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      const change = await hr.patch(`/credential-templates/${tpl.id}`, { gracePeriodDays: 30, reason });
      expect(change.body.status).toBe('PENDING_APPROVAL');
      await approve(hr2, change.body.requestId);
      const after = await loadTemplate(db, tpl.id);
      expect(after.gracePeriodDays).toBe(30);
      expect(after.fieldDefs).toEqual(tpl.fieldDefs);
      expect([after.hasExpiry, after.requiresUpload, after.displayOrder]).toEqual([tpl.hasExpiry, tpl.requiresUpload, tpl.displayOrder]);
    });

    it('a field cannot be both the issue and the expiry date — refused on request, and when an older request is approved', async () => {
      const hr2 = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      const both = { key: 'iqama', label: 'Expiry', type: 'date', required: true, displayOrder: 1, isIssueDate: true, isExpiryDate: true };
      const code = `BOTH_${Date.now()}`;
      const asked = await hr.post('/credential-templates', { code, name: 'Both dates', categoryCode: 'LICENSURE', fieldDefs: [both], reason });
      expect(asked.body.error.code).toBe('VALIDATION_FAILED');
      // A request stored before the rule existed (as in the first browser check) is refused at approval, nothing written.
      const initiator = await db.user.findFirstOrThrow({ where: { email: (await hr.get('/auth/me')).body.email } });
      const stored = await db.approvalRequest.create({ data: {
        initiatorId: initiator.id, actionType: `TEMPLATE_CREATE:${code}`, status: 'PENDING',
        payload: { kind: 'TEMPLATE_CREATE', reason, template: { code, name: 'Both dates', categoryCode: 'LICENSURE', hasExpiry: true, requiresUpload: true, gracePeriodDays: 0, displayOrder: 0, fieldDefs: [both] } },
      } });
      const decided = await approve(hr2, stored.id);
      expect(decided.body.error.code).toBe('FIELD_DEFINITIONS_INVALID');
      expect(await db.credentialTemplate.findUnique({ where: { code } })).toBeNull();
    });

    it('the Catalog screen\'s field edit (reordered and renumbered, a field added, description cleared) applies as sent', async () => {
      const tpl = await makeTemplate(db);
      await db.credentialTemplate.update({ where: { id: tpl.id }, data: { description: 'Old text' } });
      const hr2 = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      const [num, issue, expiry] = tpl.fieldDefs;
      // The shape frontend/src/modules/credentials/catalogForm.ts sends: whole list, display order 1..n.
      const fieldDefs = [
        { ...expiry!, displayOrder: 1 }, { ...num!, displayOrder: 2 }, { ...issue!, displayOrder: 3 },
        { key: 'issuing_body', label: 'Issuing body', type: 'text', required: false, displayOrder: 4 },
      ];
      const change = await hr.patch(`/credential-templates/${tpl.id}`, { description: '', fieldDefs, reason });
      expect(change.body.status).toBe('PENDING_APPROVAL');
      expect((await approve(hr2, change.body.requestId)).body).toMatchObject({ status: 'EXECUTED' });
      const after = await loadTemplate(db, tpl.id);
      expect(after.fieldDefs).toEqual(fieldDefs);
      expect(after.description).toBe('');
      expect(await db.credentialTemplateField.count({ where: { templateId: tpl.id } })).toBe(4);
    });

    it('an approval is refused when the credential type changed after the request', async () => {
      const tpl = await makeTemplate(db);
      const hr2 = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      const first = await hr.patch(`/credential-templates/${tpl.id}`, { gracePeriodDays: 30, reason });
      const second = await hr2.patch(`/credential-templates/${tpl.id}`, { gracePeriodDays: 60, reason });
      await approve(hr2, first.body.requestId);
      const stale = await approve(hr, second.body.requestId);
      expect(stale.body.error.code).toBe('TEMPLATE_CHANGED_SINCE_REQUEST');
      expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: second.body.requestId } })).status).toBe('PENDING');
      expect((await db.credentialTemplate.findUniqueOrThrow({ where: { id: tpl.id } })).gracePeriodDays).toBe(30);
    });

    it('break-glass applies a catalog change at once (spec §3.6)', async () => {
      const tpl = await makeTemplate(db);
      const bg = await signIn(app, (await makeUser(db, { isBreakGlass: true })).email);
      const out = await bg.patch(`/credential-templates/${tpl.id}`, { gracePeriodDays: 7, reason });
      expect(out.status).toBe(200);
      expect(out.body.status).toBe('APPLIED');
      expect(out.body.template.gracePeriodDays).toBe(7);
    });
  });

  describe('unauthorized access sweep (R15)', () => {
    const STAFF_ONLY: Array<[string, string]> = [
      ['GET', '/credentials'], ['POST', '/credentials'], ['POST', '/credentials/1/verify'], ['POST', '/credentials/1/suspend'],
      ['POST', '/credentials/1/revoke'], ['POST', '/credentials/1/renewal/approve'], ['POST', '/credentials/1/renewal/reject'],
      ['GET', '/credential-requirements'], ['POST', '/credential-requirements'], ['PUT', '/credential-requirements/1'],
      ['DELETE', '/credential-requirements/1'], ['POST', '/credential-requirements/bulk'], ['POST', '/credential-templates'],
      ['PATCH', '/credential-templates/1'], ['GET', '/eligibility'], ['GET', '/eligibility/1/evaluate?date=2026-01-01'],
      ['POST', '/eligibility/1/refresh'], ['GET', '/waivers'], ['POST', '/waivers'],
    ];

    it('anonymous callers get 401 everywhere; plain employees get 403 on every staff endpoint', async () => {
      const { default: request } = await import('supertest');
      const emp = await signIn(app, (await makeUser(db)).email);
      for (const [method, path] of STAFF_ONLY) {
        const anon = await request(app)[method.toLowerCase() as 'get'](`/api/v1${path}`).set('Origin', 'http://localhost:5173').send({});
        expect([method, path, anon.status]).toEqual([method, path, 401]);
        const r = method === 'GET' ? await emp.get(path) : method === 'PUT' ? await emp.put(path, {}) : method === 'DELETE' ? await emp.del(path)
          : method === 'PATCH' ? await emp.patch(path, {}) : await emp.post(path, {});
        expect([method, path, r.status]).toEqual([method, path, 403]);
      }
    });
  });

  describe('credential types by nationality (owner decision 2026-10-04)', () => {
    const reason = 'Saudi nationals hold a National ID';
    const ruled = async (rule: 'ALL' | 'ONLY' | 'EXCEPT', codes: string[]) => {
      const t = await makeTemplate(db);
      await db.credentialTemplate.update({ where: { id: t.id }, data: { nationalityRule: rule, nationalityCodes: codes } });
      return t;
    };
    const nurseOf = async (unitId: number, nationalityCode: string | null, account = false) => {
      const n = await makeNurse(db, unitId, { account });
      await db.employee.update({ where: { id: n.emp.id }, data: { nationalityCode } });
      return n;
    };
    const missing = async (employeeId: number) => (await state(employeeId))?.reasons.filter((r) => r.code === 'CREDENTIAL_MISSING').map((r) => r.templateId).sort();

    it('a type for all EXCEPT Saudi nationals is optional for them; a type ONLY for them is required of them alone; no nationality counts as non-Saudi', async () => {
      const unit = await db.unit.create({ data: { code: `NR${Date.now()}`, name: 'Nationality unit', departmentId: org.dept.id } });
      const passport = await ruled('EXCEPT', ['SAU']);
      const nationalId = await ruled('ONLY', ['SAU']);
      const saudi = await nurseOf(unit.id, 'SAU', true);
      const filipino = await nurseOf(unit.id, 'PHL');
      const unknown = await nurseOf(unit.id, null);
      expect((await require(passport.id, unit.id)).body.affectedEmployees).toBe(3);
      await require(nationalId.id, unit.id);

      expect(await missing(saudi.emp.id)).toEqual([nationalId.id]);
      expect(await missing(filipino.emp.id)).toEqual([passport.id]);
      expect(await missing(unknown.emp.id)).toEqual([passport.id]);

      // With the National ID the Saudi nurse is eligible, without any passport.
      await validCredential(saudi.emp.id, nationalId.id);
      expect((await state(saudi.emp.id))?.status).toBe('ELIGIBLE');
      // A passport can still be recorded; it never blocks.
      const optional = await hr.post('/credentials', { employeeId: saudi.emp.id, templateId: passport.id, ...fields(addDays(today(), -30), addDays(today(), 365)) });
      expect(optional.status).toBe(201);
      expect((await state(saudi.emp.id))?.status).toBe('ELIGIBLE');

      // The nurse's own list marks the passport optional for them.
      const self = await signIn(app, saudi.user!.email);
      const own = (await self.get('/credentials/me/requirements')).body.items as Array<{ templateId: number; policyStatus: string; optionalByNationality: boolean }>;
      expect(own.find((r) => r.templateId === passport.id)).toMatchObject({ policyStatus: 'OPTIONAL', optionalByNationality: true });
      expect(own.find((r) => r.templateId === nationalId.id)).toMatchObject({ policyStatus: 'MANDATORY', optionalByNationality: false });

      // A changed nationality is re-evaluated at once.
      expect((await hr.patch(`/employees/${saudi.emp.id}`, { nationalityCode: 'PHL' })).status).toBe(200);
      expect(await missing(saudi.emp.id)).toEqual([]);
      expect((await state(saudi.emp.id))?.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CREDENTIAL_NOT_VERIFIED', templateId: passport.id })]));
      expect((await hr.patch(`/employees/${unknown.emp.id}`, { nationalityCode: 'SAU' })).status).toBe(200);
      expect(await missing(unknown.emp.id)).toEqual([nationalId.id]);
    });

    it('the setting is checked, goes through four-eyes, and re-evaluates the units that require the type', async () => {
      const hr2 = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      const body = { code: `NAT_${Date.now()}`, name: 'National ID test', categoryCode: 'LICENSURE', reason };
      expect((await hr.post('/credential-templates', { ...body, nationalityRule: 'ONLY' })).body.error.code).toBe('NATIONALITY_RULE_INVALID');
      expect((await hr.post('/credential-templates', { ...body, nationalityCodes: ['SAU'] })).body.error.code).toBe('NATIONALITY_RULE_INVALID');
      expect((await hr.post('/credential-templates', { ...body, nationalityRule: 'ONLY', nationalityCodes: ['ZZZ'] })).body.error.code).toBe('NATIONALITY_INVALID');
      const asked = await hr.post('/credential-templates', {
        ...body, nationalityRule: 'ONLY', nationalityCodes: ['sau', 'SAU'],
        fieldDefs: [{ key: 'national_id_number', label: 'National ID Number', type: 'text', required: true, displayOrder: 1, pdplCategory: 'NATIONAL_ID' }],
      });
      expect(asked.status).toBe(202);
      expect((await hr2.post(`/approvals/${asked.body.requestId}/approve`, { reason: 'Checked against the memo' })).body.status).toBe('EXECUTED');
      expect(await db.credentialTemplate.findUniqueOrThrow({ where: { code: body.code }, include: { fields: true } })).toMatchObject({
        nationalityRule: 'ONLY', nationalityCodes: ['SAU'], fields: [expect.objectContaining({ pdplCategory: 'NATIONAL_ID' })],
      });

      // An existing type required in a unit: limiting it re-evaluates that unit's nurses.
      const unit = await db.unit.create({ data: { code: `NC${Date.now()}`, name: 'Rule change unit', departmentId: org.dept.id } });
      const tpl = await makeTemplate(db);
      const saudi = await nurseOf(unit.id, 'SAU');
      await require(tpl.id, unit.id);
      expect(await missing(saudi.emp.id)).toEqual([tpl.id]);
      const limit = await hr.patch(`/credential-templates/${tpl.id}`, { nationalityRule: 'EXCEPT', nationalityCodes: ['SAU'], reason });
      expect(limit.status).toBe(202);
      expect(await missing(saudi.emp.id)).toEqual([tpl.id]); // nothing until approved
      expect((await hr2.post(`/approvals/${limit.body.requestId}/approve`, { reason: 'Checked against the memo' })).body.status).toBe('EXECUTED');
      expect(await missing(saudi.emp.id)).toEqual([]);
      // "Every nationality" clears the list without being told to.
      const back = await hr.patch(`/credential-templates/${tpl.id}`, { nationalityRule: 'ALL', reason });
      expect((await hr2.post(`/approvals/${back.body.requestId}/approve`, { reason: 'Checked against the memo' })).body.status).toBe('EXECUTED');
      expect(await db.credentialTemplate.findUniqueOrThrow({ where: { id: tpl.id }, select: { nationalityRule: true, nationalityCodes: true } })).toEqual({ nationalityRule: 'ALL', nationalityCodes: [] });
      expect(await missing(saudi.emp.id)).toEqual([tpl.id]);
    });

    it('the migration limits Passport and Iqama and creates the National ID type (rolled back here)', async () => {
      const sql = readFileSync(resolve(__dirname, '../prisma/migrations/20261022090000_nationality_credential_rules/migration.sql'), 'utf8');
      const steps = sql.slice(sql.indexOf('-- Passport and Iqama')).split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !/^(--[^\n]*\n?)+$/.test(s));
      // Run inside a transaction that is always rolled back: the shared test database keeps its own catalog.
      const seen = await db.$transaction(async (tx) => {
        await tx.credentialCategory.upsert({ where: { code: 'IDENTITY' }, update: {}, create: { code: 'IDENTITY', name: 'Identity' } });
        await tx.credentialTemplate.updateMany({ where: { code: 'NATIONAL_ID' }, data: { code: `OLD_NID_${Date.now()}` } });
        for (const code of ['PASSPORT', 'IQAMA']) {
          await tx.credentialTemplate.upsert({ where: { code }, update: { nationalityRule: 'ALL', nationalityCodes: [] }, create: { code, name: code, categoryCode: 'IDENTITY' } });
        }
        for (const s of steps) await tx.$executeRawUnsafe(s);
        for (const s of steps) await tx.$executeRawUnsafe(s); // a second run changes nothing
        const rows = await tx.credentialTemplate.findMany({ where: { code: { in: ['PASSPORT', 'IQAMA', 'NATIONAL_ID'] } }, orderBy: { code: 'asc' }, include: { fields: { orderBy: { ordinal: 'asc' } } } });
        const result = rows.map((t) => ({ code: t.code, rule: t.nationalityRule, codes: t.nationalityCodes, fields: t.fields.map((f) => [f.key, f.type, f.isIssueDate, f.isExpiryDate, f.pdplCategory]) }));
        throw Object.assign(new Error('rollback'), { result });
      }).catch((e: unknown) => {
        if (e instanceof Error && 'result' in e) return e.result;
        throw e;
      });
      expect(seen).toEqual([
        { code: 'IQAMA', rule: 'EXCEPT', codes: ['SAU'], fields: expect.any(Array) },
        { code: 'NATIONAL_ID', rule: 'ONLY', codes: ['SAU'], fields: [
          ['national_id_number', 'text', false, false, 'NATIONAL_ID'], ['issue_date', 'date', true, false, null], ['expiry_date', 'date_hijri', false, true, null],
        ] },
        { code: 'PASSPORT', rule: 'EXCEPT', codes: ['SAU'], fields: expect.any(Array) },
      ]);
    });
  });

  it('leaves the audit chain intact', async () => {
    expect(await findChainBreaks(db)).toEqual([]);
  });
});
