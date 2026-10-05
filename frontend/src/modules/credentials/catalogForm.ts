// The credential-type form (Catalog tab) as API bodies. Kept pure so the
// "send only what changed" rule is testable: the approver of a catalog change
// (D-24) sees exactly what the requester changed, nothing else.

import type { FieldDef, NationalityRule, PdplCategory, Template } from './api';

export type FieldRowValue = { key: string; label: string; labelAr?: string | null; type: FieldDef['type']; required: boolean; isIssueDate?: boolean; isExpiryDate?: boolean; pdplCategory?: PdplCategory | null };
export type TemplateFormValues = {
  code?: string; name: string; /** Arabic name (owner, 2026-10-05); empty = the English one is shown. */ nameAr?: string | null; categoryCode: string; description?: string | null; hasExpiry: boolean; requiresUpload: boolean;
  gracePeriodDays: number; displayOrder: number; isActive: boolean; fields?: FieldRowValue[]; reason: string;
  /** Spec §5.4 (D-64): checked with SCFHS; suspended on an adverse answer. */
  scfhsEnabled?: boolean; scfhsAutoSuspend?: boolean;
  /** Owner decision 2026-10-04: who the type applies to. */
  nationalityRule?: NationalityRule; nationalityCodes?: string[];
};

export const isDateType = (type?: string) => type === 'date' || type === 'date_hijri';

/** The form's rows as the API's `fieldDefs`: the order on screen is the display order. */
export const toFieldDefs = (rows: readonly FieldRowValue[] = []): FieldDef[] => rows.map((f, i) => ({
  key: f.key, label: f.label.trim(), ...(f.labelAr?.trim() ? { labelAr: f.labelAr.trim() } : {}), type: f.type, required: f.required === true, displayOrder: i + 1,
  ...(isDateType(f.type) && f.isIssueDate ? { isIssueDate: true } : {}),
  ...(isDateType(f.type) && f.isExpiryDate ? { isExpiryDate: true } : {}),
  ...(f.type === 'text' && f.pdplCategory ? { pdplCategory: f.pdplCategory } : {}),
}));

/** The catalog field rules the form can check before sending: i18n keys of the problems found. */
export function fieldProblems(rows: readonly (Partial<FieldRowValue> | undefined)[] = []): string[] {
  const out: string[] = [];
  const keys = rows.map((f) => f?.key).filter(Boolean);
  if (new Set(keys).size !== keys.length) out.push('fieldKeyDuplicate');
  const dated = (flag: 'isIssueDate' | 'isExpiryDate') => rows.filter((f) => f?.[flag] && isDateType(f.type)).length;
  if (dated('isIssueDate') > 1 || dated('isExpiryDate') > 1) out.push('fieldDatesOnce');
  if (rows.some((f) => f?.isIssueDate && f.isExpiryDate && isDateType(f.type))) out.push('fieldDatesSame');
  const categories = rows.flatMap((f) => (f?.type === 'text' && f.pdplCategory ? [f.pdplCategory] : []));
  if (new Set(categories).size !== categories.length) out.push('fieldPdplOnce');
  return out;
}

/** A stored template as form values. */
export const toFormValues = (x: Template): TemplateFormValues => ({
  name: x.name, nameAr: x.nameAr, categoryCode: x.categoryCode, description: x.description, hasExpiry: x.hasExpiry, requiresUpload: x.requiresUpload,
  gracePeriodDays: x.gracePeriodDays, displayOrder: x.displayOrder, isActive: x.isActive, reason: '',
  scfhsEnabled: x.scfhsEnabled, scfhsAutoSuspend: x.scfhsAutoSuspend,
  nationalityRule: x.nationalityRule, nationalityCodes: x.nationalityCodes,
  fields: x.fieldDefs.map((f) => ({ key: f.key, label: f.label, labelAr: f.labelAr ?? null, type: f.type, required: f.required, isIssueDate: f.isIssueDate === true, isExpiryDate: f.isExpiryDate === true, pdplCategory: f.pdplCategory ?? null })),
});

const comparable = (v: Omit<TemplateFormValues, 'code' | 'reason'>) => ({
  name: v.name.trim(), nameAr: v.nameAr?.trim() || null, categoryCode: v.categoryCode, description: v.description?.trim() ?? '', hasExpiry: v.hasExpiry, requiresUpload: v.requiresUpload,
  gracePeriodDays: v.gracePeriodDays, displayOrder: v.displayOrder, fieldDefs: toFieldDefs(v.fields),
  scfhsEnabled: v.scfhsEnabled === true, scfhsAutoSuspend: v.scfhsEnabled === true && v.scfhsAutoSuspend === true,
  // "Every nationality" lists none; codes sorted without repeats, as the server stores them.
  nationalityRule: v.nationalityRule ?? 'ALL',
  nationalityCodes: (v.nationalityRule ?? 'ALL') === 'ALL' ? [] : [...new Set(v.nationalityCodes ?? [])].sort(),
});

/** Body for POST /credential-templates. */
export function createBody(v: TemplateFormValues): Record<string, unknown> {
  const { description, nameAr, ...rest } = comparable(v);
  return { code: v.code, ...rest, ...(nameAr ? { nameAr } : {}), ...(description ? { description } : {}), reason: v.reason };
}

/** Body for PATCH /credential-templates/:id — only the properties that differ from `before`, plus the reason. */
export function changeBody(before: Template, v: TemplateFormValues): Record<string, unknown> {
  const was: Record<string, unknown> = { ...comparable(toFormValues(before)), isActive: before.isActive };
  const now: Record<string, unknown> = { ...comparable(v), isActive: v.isActive };
  return { ...Object.fromEntries(Object.entries(now).filter(([k, val]) => JSON.stringify(val) !== JSON.stringify(was[k]))), reason: v.reason };
}
