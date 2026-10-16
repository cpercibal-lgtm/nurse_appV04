// Translation completeness, read from source text (i18n.ts touches `document`,
// and the tests run in node). The Record type already forces the Arabic table to
// carry every English key; this checks what the compiler cannot:
//   - every literal t('key') used in the code exists;
//   - every key built from an enum value (t(`shift_${s}`) …) exists for each value;
//   - no translation is empty, and no key is defined twice.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
// The English table is in i18n.en.ts and the Arabic one in i18n.ar.ts (loaded on demand).
const source = ['i18n.en.ts', 'i18n.ar.ts'].map((f) => readFileSync(join(__dirname, f), 'utf8')).join('\n');

function table(name: string) {
  const start = source.indexOf(name);
  const body = source.slice(start, source.indexOf('\n};', start));
  const entries = [...body.matchAll(/^ {2}(\w+): '((?:[^'\\]|\\.)*)',$/gm)].map((m) => [m[1]!, m[2]!] as const);
  return entries;
}
const en = table('const en = {');
const ar = table('const ar: Record<keyof typeof en, string> = {');
const keys = new Set(en.map(([k]) => k));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(f) && !f.endsWith('.test.ts') ? [p] : [];
  });
}
const code = files(SRC).map((f) => readFileSync(f, 'utf8')).join('\n');

// Enum-driven key families: prefix → every value the API can return.
const FAMILIES: Record<string, string[]> = {
  health_: ['HEALTHY', 'ATTENTION'], // GET /system/health/business (spec §10.8)
  logicFilter_: ['undecided', 'approved', 'rejected', 'all'], // shadow mode (spec §10.9, D-60)
  logicDecision_: ['APPROVED', 'REJECTED'],
  logicStatus_: ['ACTIVE', 'SHADOW', 'RETIRED'],
  scfhsStatus_: ['VERIFIED', 'EXPIRED', 'SUSPENDED', 'REVOKED', 'NOT_FOUND', 'ERROR'], // SCFHS answers (spec §5.4, D-64)
  scfhsTrigger_: ['MANUAL', 'ON_SUBMIT', 'SCHEDULED'],
  scfhsAction_: ['HR_NOTIFIED', 'SUSPENDED'],
  scfhsResult_: ['NONE', 'HR_NOTIFIED', 'SUSPENDED', 'KNOWN', 'ERROR'],
  pdpl_: ['IQAMA', 'PASSPORT', 'SCFHS_REG', 'NATIONAL_ID', 'IDENTITY_SCAN'], // D-54 sensitive data categories
  dsr_: ['ACCESS', 'PORTABILITY', 'RECTIFICATION', 'ERASURE'], // D-55 data-subject requests
  dsrHint_: ['ACCESS', 'PORTABILITY', 'RECTIFICATION', 'ERASURE'],
  dsrStatus_: ['RECEIVED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED'],
  dsrApproveConfirm_: ['EXPORT', 'RECTIFICATION'],
  basis_: ['EMPLOYMENT_CONTRACT', 'LEGAL_OBLIGATION', 'CONSENT', 'VITAL_INTEREST', 'PUBLIC_INTEREST'], // processing register
  invitationStatus_: ['OPEN', 'CLAIMED', 'REVOKED', 'EXPIRED'], // GET /employees/:id/invitations (spec §3.2)
  shift_: ['Morning', 'Evening', 'Night'],
  badgeType_: ['CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END'], // badge events (spec §14.2, D-65)
  band_: ['Standard', 'Distress', 'Failing', 'Failed'],
  marital_: ['Single', 'Married', 'Others'],
  contract_: ['Draft', 'PendingApproval', 'Approved', 'Active', 'Expired', 'Suspended', 'Terminated', 'Superseded'],
  contractAction_: ['submit', 'return', 'approve', 'suspend', 'reinstate', 'terminate'],
  dateChangeDone_: ['approve', 'reject', 'withdraw'],
  elig_: ['ELIGIBLE', 'ELIGIBLE_WITH_GRACE', 'ELIGIBLE_WITH_POLICY_WARNING', 'INELIGIBLE'],
  cred_: ['PendingVerification', 'Valid', 'ExpiringSoon', 'Expired', 'Suspended', 'Revoked'],
  life_: ['Active', 'SubjectToRenew', 'OnProcess', 'Expired'],
  gap_: ['UPCOMING', 'PENDING', 'MISSING', 'PRESENT', 'INELIGIBLE_ON_DUTY'],
  priority_: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
  baselineSection_: ['departments', 'units', 'positions', 'credentialCategories', 'credentialTemplates'],
  baselineStatus_: ['CREATE', 'UNCHANGED', 'CONFLICT', 'REJECTED'],
  importStatus_: ['CREATE', 'UNCHANGED', 'CONFLICT', 'REJECTED'], // staff import (D-72)
  importStaffFile_: ['NOT_XLSX', 'NO_SHEET', 'TOO_LARGE', 'EMPTY', 'VERSION_2', 'WRONG_HEADER', 'TOO_MANY_ROWS'],
  approvalStatus_: ['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'WITHDRAWN'],
  fieldType_: ['text', 'date', 'date_hijri', 'select', 'number', 'country', 'reference'],
  nationalityRule_: ['ALL', 'ONLY', 'EXCEPT'], // credential types by nationality (owner decision 2026-10-04)
  annKind_: ['MEMO', 'MEETING', 'SEMINAR'], // announcements (D-69)
  annStatus_: ['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'REJECTED', 'CANCELLED'],
  annAudience_: ['HOSPITAL', 'DEPARTMENT', 'UNIT', 'PEOPLE'],
  annRole_: ['SYSTEM_ADMIN', 'HR_ADMIN', 'SUPERVISOR'],
};

describe('translations', () => {
  it('parses both tables', () => {
    expect(en.length).toBeGreaterThan(300);
    expect(ar.length).toBe(en.length);
  });

  it('has no duplicate keys and no empty values', () => {
    for (const t of [en, ar]) {
      expect(new Set(t.map(([k]) => k)).size).toBe(t.length);
      expect(t.filter(([, v]) => v.trim() === '').map(([k]) => k)).toEqual([]);
    }
  });

  it('every literal key used in the code exists', () => {
    const used = new Set([...code.matchAll(/\bt\('([A-Za-z_]+)'/g)].map((m) => m[1]!));
    // Page labels in the module registry are keys too.
    for (const m of code.matchAll(/page\('[^']*', '([A-Za-z]+)'/g)) used.add(m[1]!);
    expect([...used].filter((k) => !keys.has(k)).sort()).toEqual([]);
  });

  it('every enum-driven key family is complete', () => {
    const prefixes = new Set([...code.matchAll(/t\(`([A-Za-z]+_)\$\{/g)].map((m) => m[1]!));
    expect([...prefixes].filter((p) => !FAMILIES[p]).sort()).toEqual([]); // a new family must be listed above
    const missing = Object.entries(FAMILIES).flatMap(([p, values]) => values.map((v) => p + v)).filter((k) => !keys.has(k));
    expect(missing).toEqual([]);
  });

  it.each([
    ['English', en, 'typing error', 'must match the uploaded contract copy', 'match it exactly', 'no discrepancy', 'Open contract copy'],
    ['Arabic', ar, 'خطأ في الكتابة', 'يجب أن تطابق التواريخ الجديدة نسخة العقد المرفوعة', 'تطابقها تماماً', 'لم يوجد أي اختلاف', 'فتح نسخة العقد'],
  ] as const)('%s describes date changes as corrections checked against the contract copy', (_, entries, typo, match, exact, discrepancy, openCopy) => {
    const strings = Object.fromEntries(entries);
    expect(strings.editContractDatesApprovalHint).toContain(typo);
    expect(strings.editContractDatesApprovalHint).toContain(match);
    expect(strings.dateChangeReviewHint).toContain(exact);
    expect(strings.dateChangeReviewHint).toContain(discrepancy);
    expect(strings.dateChangeOpenCopy).toBe(openCopy);
    expect(`${strings.editContractDatesApprovalHint} ${strings.dateChangeReviewHint}`).not.toMatch(/addendum|ملحق/i);
  });

  it.each([
    ['English', en, {
      approver: 'another HR administrator approves your request',
      unchanged: 'the current dates stay in force',
      immediate: 'approving changes the contract at once',
      rejection: 'Rejecting needs a note',
      ownApprover: 'another HR administrator must approve or reject it',
      withdraw: 'You can withdraw it',
    }],
    ['Arabic', ar, {
      approver: 'يعتمد طلبك مسؤول موارد بشرية آخر',
      unchanged: 'تبقى التواريخ الحالية سارية',
      immediate: 'الاعتماد يغيّر العقد فوراً',
      rejection: 'الرفض يتطلب ملاحظة',
      ownApprover: 'يعتمده أو يرفضه مسؤول موارد بشرية آخر',
      withdraw: 'يمكنك سحبه',
    }],
  ] as const)('%s explains approval safeguards and the consequences of each review action', (_, entries, expected) => {
    const strings = Object.fromEntries(entries);
    expect(strings.editContractDatesApprovalHint).toContain(expected.approver);
    expect(strings.editContractDatesApprovalHint).toContain(expected.unchanged);
    expect(strings.dateChangeReviewHint).toContain(expected.immediate);
    expect(strings.dateChangeReviewHint).toContain(expected.rejection);
    expect(strings.dateChangeOwnHint).toContain(expected.ownApprover);
    expect(strings.dateChangeOwnHint).toContain(expected.withdraw);
  });
});
