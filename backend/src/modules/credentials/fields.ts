// Credential field definitions (spec §5.1.3) are stored one row per field in
// credential_template_fields. The API keeps its original shape — a `fieldDefs`
// array on each credential type — so this module is the one place that converts
// between the two. Both directions produce the same canonical object (flags only
// when true, keys in a fixed order), so four-eyes "before / after" comparisons
// see a change only when there is one.

import type { CredentialTemplate, CredentialTemplateField } from '../../generated/prisma/client.js';
import type { FieldDef } from './catalog.js';

/** Prisma `include` that loads a template's fields in their stored order. */
export const WITH_FIELDS = { fields: { orderBy: { ordinal: 'asc' } } } as const;

type FieldRow = Pick<CredentialTemplateField, 'key' | 'label' | 'labelAr' | 'type' | 'required' | 'displayOrder' | 'isIssueDate' | 'isExpiryDate' | 'pdplCategory'>;

/** Canonical form of one definition. */
export function canonicalField(d: FieldRow | FieldDef): FieldDef {
  return {
    key: d.key, label: d.label, ...(d.labelAr ? { labelAr: d.labelAr } : {}), type: d.type, required: d.required, displayOrder: d.displayOrder,
    ...(d.isIssueDate ? { isIssueDate: true } : {}),
    ...(d.isExpiryDate ? { isExpiryDate: true } : {}),
    ...(d.pdplCategory ? { pdplCategory: d.pdplCategory as FieldDef['pdplCategory'] } : {}),
  };
}

export const toFieldDefs = (rows: readonly FieldRow[]): FieldDef[] => rows.map(canonicalField);

/** Rows for `createMany`; `ordinal` is the position in the given list. */
export const fieldRows = (templateId: number, defs: readonly FieldDef[]) =>
  defs.map((d, ordinal) => ({
    templateId, ordinal, key: d.key, label: d.label, labelAr: d.labelAr ?? null, type: d.type, required: d.required,
    displayOrder: d.displayOrder, isIssueDate: d.isIssueDate === true, isExpiryDate: d.isExpiryDate === true,
    pdplCategory: d.pdplCategory ?? null,
  }));

export type TemplateView = CredentialTemplate & { fieldDefs: FieldDef[] };

/** A template as the API presents it: its field rows as the `fieldDefs` array. */
export function presentTemplate(t: CredentialTemplate & { fields: FieldRow[] }): TemplateView {
  const { fields, ...rest } = t;
  return { ...rest, fieldDefs: toFieldDefs(fields) };
}
