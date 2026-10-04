// FHIR R4 read API (spec §14.1, D-61): the mapping (typed against the official
// R4 definitions), the resources served over HTTP with the SCFHS number opened,
// scope, deletion, search, and OperationOutcome errors. The HL7 validator runs
// in CI on samples written by scripts/fhir-samples.ts (spec §11.3).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Practitioner, PractitionerRole } from 'fhir/r4.js';
import type { Db } from '../src/lib/prisma.js';
import { fieldRows } from '../src/modules/credentials/fields.js';
import type { FieldDef } from '../src/modules/credentials/catalog.js';
import { FHIR_ID, FHIR_SYSTEMS, toPractitioner, toPractitionerRole, type FhirEmployee } from '../src/modules/interop/fhir.js';
import { makeNurse, makeOrg, makeUser, openDb, signIn, TEST_URL, testApp, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;

const sample: FhirEmployee = {
  id: 42, jobNumber: 'J-1001', firstName: 'Sara', middleName: 'Ali', lastName: 'Alqahtani', fullName: 'Sara Ali Alqahtani',
  contactEmail: 'sara@aigh.sa', status: 'Active', updatedAt: new Date('2026-09-25T08:00:00Z'),
  unit: { code: 'ICU-1', name: 'Intensive Care 1' }, position: { code: 'SN', title: 'Staff Nurse' },
  contract: { startDate: '2026-01-01', endDate: '2027-12-31' },
};

describe('FHIR mapping (R4)', () => {
  it('Practitioner: job number, name, work e-mail and licences as qualifications', () => {
    const p = toPractitioner(sample, [{ template: { code: 'SCFHS', name: 'SCFHS registration' }, scfhsNumber: '12-RN-3456', issueDate: '2025-01-01', expiryDate: '2027-01-01' }]);
    expect(p).toMatchObject({
      resourceType: 'Practitioner', id: '42', active: true,
      identifier: [{ system: FHIR_SYSTEMS.jobNumber, value: 'J-1001' }],
      name: [{ family: 'Alqahtani', given: ['Sara', 'Ali'], text: 'Sara Ali Alqahtani' }],
      telecom: [{ system: 'email', value: 'sara@aigh.sa', use: 'work' }],
      qualification: [{ identifier: [{ system: FHIR_SYSTEMS.scfhs, value: '12-RN-3456' }], code: { text: 'SCFHS registration' }, period: { start: '2025-01-01', end: '2027-01-01' } }],
    });
    expect(p.id).toMatch(FHIR_ID);
    expect(toPractitioner({ ...sample, middleName: null }, []).qualification).toBeUndefined();
  });

  it('PractitionerRole: position as code, unit as specialty, contract as period — and no qualification (not an R4 element)', () => {
    const r = toPractitionerRole(sample);
    expect(r).toMatchObject({
      resourceType: 'PractitionerRole', id: '42', active: true, period: { start: '2026-01-01', end: '2027-12-31' },
      practitioner: { reference: 'Practitioner/42' },
      code: [{ coding: [{ system: FHIR_SYSTEMS.position, code: 'SN', display: 'Staff Nurse' }] }],
      specialty: [{ coding: [{ system: FHIR_SYSTEMS.unit, code: 'ICU-1' }] }],
    });
    expect(r).not.toHaveProperty('qualification');
    expect(toPractitionerRole({ ...sample, contract: null, unit: null })).toMatchObject({ active: false });
    expect(toPractitionerRole({ ...sample, contract: null })).not.toHaveProperty('period');
  });
});

describeDb('FHIR read API (spec §14.1)', () => {
  let db: Db;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let hr: Awaited<ReturnType<typeof signIn>>;
  let tplId: number;
  const app = () => testApp(db);

  beforeAll(async () => {
    db = openDb();
    org = await makeOrg(db);
    hr = await signIn(app(), (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    await db.credentialCategory.upsert({ where: { code: 'LICENSURE' }, update: {}, create: { code: 'LICENSURE', name: 'Licensure' } });
    const t = await db.credentialTemplate.create({ data: { code: uniq('SCFHS').toUpperCase(), name: 'SCFHS registration', categoryCode: 'LICENSURE', hasExpiry: true, requiresUpload: false } });
    const defs: FieldDef[] = [
      { key: 'scfhs_number', label: 'SCFHS number', type: 'text', required: true, displayOrder: 1, pdplCategory: 'SCFHS_REG' },
      { key: 'issue_date', label: 'Issue date', type: 'date', required: true, displayOrder: 2, isIssueDate: true },
      { key: 'expiry_date', label: 'Expiry date', type: 'date', required: true, displayOrder: 3, isExpiryDate: true },
    ];
    await db.credentialTemplateField.createMany({ data: fieldRows(t.id, defs) });
    tplId = t.id;
  });
  afterAll(async () => { await db.$disconnect(); });

  it('serves Practitioner with the verified licence (SCFHS number opened) and PractitionerRole, as application/fhir+json', async () => {
    const { emp } = await makeNurse(db, org.unitA.id);
    const scfhs = `RN-${Date.now()}`;
    const rec = await hr.post('/credentials', { employeeId: emp.id, templateId: tplId, trackingData: { scfhs_number: scfhs, issue_date: '2025-01-01', expiry_date: '2030-01-01' } });
    expect(rec.status).toBe(201);
    expect(JSON.stringify((await db.credential.findUniqueOrThrow({ where: { id: rec.body.id } })).trackingData)).not.toContain(scfhs); // stored sealed

    // Not yet verified: not a qualification.
    expect((await hr.get(`/fhir/Practitioner/${emp.id}`)).body.qualification).toBeUndefined();
    await db.credential.update({ where: { id: rec.body.id }, data: { status: 'Valid' } });

    const res = await hr.get(`/fhir/Practitioner/${emp.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/fhir\+json/);
    const p = res.body as Practitioner;
    expect(p).toMatchObject({ resourceType: 'Practitioner', id: String(emp.id), identifier: [{ value: emp.jobNumber }] });
    expect(p.qualification).toEqual([expect.objectContaining({ identifier: [{ system: FHIR_SYSTEMS.scfhs, value: scfhs }], period: { start: '2025-01-01', end: '2030-01-01' } })]);

    const role = (await hr.get(`/fhir/PractitionerRole/${emp.id}`)).body as PractitionerRole;
    expect(role).toMatchObject({ resourceType: 'PractitionerRole', active: true, practitioner: { reference: `Practitioner/${emp.id}` }, specialty: [{ text: 'Unit A' }] });
    expect(role.period?.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('search: Practitioner by job number, PractitionerRole by practitioner — searchset bundles', async () => {
    const { emp } = await makeNurse(db, org.unitA.id);
    const byId = await hr.get(`/fhir/Practitioner?identifier=${encodeURIComponent(`${FHIR_SYSTEMS.jobNumber}|${emp.jobNumber}`)}`);
    expect(byId.body).toMatchObject({ resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource: { id: String(emp.id) }, search: { mode: 'match' } }] });
    expect(byId.body.entry[0].fullUrl).toMatch(new RegExp(`/api/v1/fhir/Practitioner/${emp.id}$`));
    expect(byId.body.link).toEqual([{ relation: 'self', url: expect.stringMatching(/\/api\/v1\/fhir\/Practitioner\?identifier=/) }]);
    expect((await hr.get(`/fhir/Practitioner?identifier=${emp.jobNumber}`)).body.total).toBe(1);
    expect((await hr.get('/fhir/Practitioner?identifier=http://other.org|x')).body.total).toBe(0);
    const tooLong = await hr.get(`/fhir/Practitioner?identifier=${'9'.repeat(301)}`);
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toMatchObject({ resourceType: 'OperationOutcome', issue: [{ code: 'invalid' }] });
    expect((await hr.get(`/fhir/PractitionerRole?practitioner=Practitioner/${emp.id}`)).body.total).toBe(1);
    const noParam = await hr.get('/fhir/Practitioner');
    expect(noParam.status).toBe(400);
    expect(noParam.body).toMatchObject({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-supported' }] });
  });

  it('scope: a department HR Admin sees only their units; outside and unknown read as not found; deleted as gone', async () => {
    const inside = await makeNurse(db, org.unitA.id);
    const outside = await makeNurse(db, org.unitC.id);
    const deptHr = await signIn(app(), (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'DEPARTMENT', scopeIds: [org.dept.id] }] })).email);
    expect((await deptHr.get(`/fhir/Practitioner/${inside.emp.id}`)).status).toBe(200);
    const hidden = await deptHr.get(`/fhir/Practitioner/${outside.emp.id}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toMatchObject({ resourceType: 'OperationOutcome', issue: [{ code: 'not-found' }] });
    expect((await deptHr.get(`/fhir/Practitioner?identifier=${outside.emp.jobNumber}`)).body.total).toBe(0);
    expect((await hr.get('/fhir/Practitioner/abc')).status).toBe(404);

    await db.employee.update({ where: { id: inside.emp.id }, data: { deletedAt: new Date() } });
    expect((await hr.get(`/fhir/PractitionerRole/${inside.emp.id}`)).status).toBe(410);

    const sup = await signIn(app(), (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
    expect((await sup.get('/fhir/metadata')).status).toBe(403);
    expect((await hr.get('/fhir/metadata')).body).toMatchObject({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', kind: 'instance', software: { version: expect.stringMatching(/^\d+\.\d+\.\d+$/) }, implementation: { url: expect.stringMatching(/\/api\/v1\/fhir$/) } });
  });
});
