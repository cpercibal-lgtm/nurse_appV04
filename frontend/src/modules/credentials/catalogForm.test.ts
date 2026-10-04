import { describe, expect, it } from 'vitest';
import type { Template } from './api';
import { changeBody, createBody, fieldProblems, toFieldDefs, toFormValues } from './catalogForm';

const stored: Template = {
  id: 7, code: 'SCFHS', name: 'SCFHS licence', categoryCode: 'LICENSE', description: null, hasExpiry: true, requiresUpload: true,
  gracePeriodDays: 0, displayOrder: 1, isActive: true, scfhsEnabled: false, scfhsAutoSuspend: false, nationalityRule: 'ALL', nationalityCodes: [],
  fieldDefs: [
    { key: 'licence_number', label: 'Licence number', type: 'text', required: true, displayOrder: 1 },
    { key: 'issue_date', label: 'Issue date', type: 'date', required: true, displayOrder: 2, isIssueDate: true },
    { key: 'expiry_date', label: 'Expiry date', type: 'date', required: true, displayOrder: 3, isExpiryDate: true },
  ],
};

describe('credential type form', () => {
  it('round-trips a stored type unchanged: an untouched edit sends only the reason', () => {
    expect(changeBody(stored, { ...toFormValues(stored), reason: 'nothing really' })).toEqual({ reason: 'nothing really' });
  });

  it('sends only what changed', () => {
    const v = toFormValues(stored);
    expect(changeBody(stored, { ...v, gracePeriodDays: 14, reason: 'hospital policy 2026' })).toEqual({ gracePeriodDays: 14, reason: 'hospital policy 2026' });
    expect(changeBody(stored, { ...v, description: '  ', isActive: false, reason: 'retired type' })).toEqual({ isActive: false, reason: 'retired type' });
  });

  it('sends the whole field list, renumbered, when a field is moved, added or removed', () => {
    const v = toFormValues(stored);
    const moved = { ...v, fields: [v.fields![0]!, v.fields![2]!, v.fields![1]!], reason: 'expiry first please' };
    expect((changeBody(stored, moved).fieldDefs as { key: string; displayOrder: number }[]).map((f) => [f.key, f.displayOrder]))
      .toEqual([['licence_number', 1], ['expiry_date', 2], ['issue_date', 3]]);
  });

  it('drops date flags on non-date fields and trims labels', () => {
    expect(toFieldDefs([{ key: 'ref', label: ' Reference ', type: 'text', required: false, isIssueDate: true, isExpiryDate: true }]))
      .toEqual([{ key: 'ref', label: 'Reference', type: 'text', required: false, displayOrder: 1 }]);
  });

  it('flags the field rules the server enforces', () => {
    const d = (key: string, extra: object = {}) => ({ key, label: key, type: 'date' as const, required: true, ...extra });
    expect(fieldProblems([d('a'), d('b')])).toEqual([]);
    expect(fieldProblems([d('a'), d('a')])).toEqual(['fieldKeyDuplicate']);
    expect(fieldProblems([d('a', { isExpiryDate: true }), d('b', { isExpiryDate: true })])).toEqual(['fieldDatesOnce']);
    expect(fieldProblems([d('iqama', { isIssueDate: true, isExpiryDate: true })])).toEqual(['fieldDatesSame']);
    // Flags on a non-date field are dropped when sent, so they are not a problem.
    expect(fieldProblems([{ ...d('t', { isIssueDate: true, isExpiryDate: true }), type: 'text' }])).toEqual([]);
  });

  it('sends a sensitive (PDPL) category only on text fields, once per category (D-54)', () => {
    const f = (key: string, type: 'text' | 'date', pdplCategory: 'IQAMA' | 'PASSPORT' | null) => ({ key, label: key, type, required: true, pdplCategory });
    expect(toFieldDefs([f('iqama_number', 'text', 'IQAMA')])[0]).toMatchObject({ pdplCategory: 'IQAMA' });
    expect(toFieldDefs([f('issued', 'date', 'IQAMA')])[0]).not.toHaveProperty('pdplCategory');
    expect(toFieldDefs([f('sponsor', 'text', null)])[0]).not.toHaveProperty('pdplCategory');
    expect(fieldProblems([f('a', 'text', 'IQAMA'), f('b', 'text', 'IQAMA')])).toEqual(['fieldPdplOnce']);
    expect(fieldProblems([f('a', 'text', 'IQAMA'), f('b', 'text', 'PASSPORT')])).toEqual([]);
  });

  it('builds a create body without an empty description', () => {
    const body = createBody({ ...toFormValues(stored), code: 'ACLS2', description: '', reason: 'new credential type' });
    expect(body).toMatchObject({ code: 'ACLS2', name: 'SCFHS licence', categoryCode: 'LICENSE', reason: 'new credential type' });
    expect(body).not.toHaveProperty('description');
    expect(body).not.toHaveProperty('isActive');
    expect((body.fieldDefs as unknown[]).length).toBe(3);
  });

  it('SCFHS switches (D-64): sends only the switch changed; auto-suspend never without the checks', () => {
    expect(changeBody(stored, { ...toFormValues(stored), scfhsEnabled: true, reason: 'r' })).toEqual({ scfhsEnabled: true, reason: 'r' });
    expect(changeBody(stored, { ...toFormValues(stored), scfhsAutoSuspend: true, reason: 'r' })).toEqual({ reason: 'r' });
    expect(changeBody({ ...stored, scfhsEnabled: true, scfhsAutoSuspend: true }, { ...toFormValues({ ...stored, scfhsEnabled: true, scfhsAutoSuspend: true }), scfhsEnabled: false, reason: 'r' }))
      .toEqual({ scfhsEnabled: false, scfhsAutoSuspend: false, reason: 'r' });
  });
  it('nationality rule (owner decision 2026-10-04): sends rule and codes as stored; "every nationality" sends no codes', () => {
    const v = toFormValues(stored);
    expect(changeBody(stored, { ...v, nationalityRule: 'EXCEPT', nationalityCodes: ['SAU', 'SAU'], reason: 'r' }))
      .toEqual({ nationalityRule: 'EXCEPT', nationalityCodes: ['SAU'], reason: 'r' });
    const limited = { ...stored, nationalityRule: 'EXCEPT' as const, nationalityCodes: ['SAU'] };
    // Codes left in the hidden field when switching back to every nationality are not sent.
    expect(changeBody(limited, { ...toFormValues(limited), nationalityRule: 'ALL', reason: 'r' })).toEqual({ nationalityRule: 'ALL', nationalityCodes: [], reason: 'r' });
    expect(changeBody(limited, { ...toFormValues(limited), nationalityCodes: ['SAU', 'KWT'], reason: 'r' })).toEqual({ nationalityCodes: ['KWT', 'SAU'], reason: 'r' });
    expect(createBody({ ...v, code: 'NID', nationalityRule: 'ONLY', nationalityCodes: ['SAU'], reason: 'r' })).toMatchObject({ nationalityRule: 'ONLY', nationalityCodes: ['SAU'] });
  });
});
