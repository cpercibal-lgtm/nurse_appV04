// Credential catalog (spec §5.1.1–5.1.3) and requirements (§5.1.4).
// Every requirement change re-evaluates the affected nurses in the same
// transaction (L6): "Adding a new mandatory requirement immediately affects
// eligibility for employees who lack that credential."

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { isIsoDate, toDbDate } from '../../lib/dates.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import type { CredentialCategory } from '../../generated/prisma/client.js';
import { Prisma, type Db, type DbClient } from '../../lib/prisma.js';
import { sameValue } from '../../lib/same.js';
import { refreshEligibility, refreshUnit } from '../eligibility/state.service.js';
import { unitScope, type AuthContext } from '../users/access.js';
import { HR_ROLES, REVIEW_ROLES } from './access.js';
import { canonicalField, fieldRows, presentTemplate, WITH_FIELDS, type TemplateView } from './fields.js';
import { assertNationalityRule, NationalityCodesSchema, NationalityRuleSchema } from './nationality-rule.js';

const FieldType = z.enum(['text', 'date', 'date_hijri', 'select', 'number', 'country', 'reference']);
export const FieldDefSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
  label: z.string().trim().min(1).max(100),
  /** Shown in the Arabic interface; the English label when absent. */
  labelAr: z.string().trim().min(1).max(100).optional(),
  type: FieldType,
  required: z.boolean(),
  displayOrder: z.number().int().min(0),
  isIssueDate: z.boolean().optional(),
  isExpiryDate: z.boolean().optional(),
  /** D-54: sensitive personal data (spec §8.3.1) — encrypted per employee and blind-indexed. Text fields only. */
  pdplCategory: z.enum(['IQAMA', 'PASSPORT', 'SCFHS_REG', 'NATIONAL_ID']).optional(),
});
export type FieldDef = z.infer<typeof FieldDefSchema>;

export const FieldDefs = z.array(FieldDefSchema).max(30).superRefine((defs, ctx) => {
  const keys = new Set<string>();
  for (const d of defs) {
    if (keys.has(d.key)) ctx.addIssue({ code: 'custom', message: `Duplicate field key ${d.key}` });
    keys.add(d.key);
    if ((d.isIssueDate || d.isExpiryDate) && d.type !== 'date' && d.type !== 'date_hijri') {
      ctx.addIssue({ code: 'custom', message: `${d.key}: issue/expiry fields must be Gregorian or Umm al-Qura dates` });
    }
    // One field as both would make every credential of the type expire on the day it was issued.
    if (d.isIssueDate && d.isExpiryDate) ctx.addIssue({ code: 'custom', message: `${d.key}: a field cannot be both the issue date and the expiry date` });
    if (d.pdplCategory && d.type !== 'text') ctx.addIssue({ code: 'custom', message: `${d.key}: only a text field can hold a sensitive identifier` });
  }
  if (defs.filter((d) => d.isIssueDate).length > 1) ctx.addIssue({ code: 'custom', message: 'At most one issue-date field' });
  if (defs.filter((d) => d.isExpiryDate).length > 1) ctx.addIssue({ code: 'custom', message: 'At most one expiry-date field' });
  const categories = defs.flatMap((d) => (d.pdplCategory ? [d.pdplCategory] : []));
  if (new Set(categories).size !== categories.length) ctx.addIssue({ code: 'custom', message: 'Each sensitive category at most once per credential type' });
}).transform((defs) => defs.map(canonicalField)); // same shape as stored rows, so comparisons are exact

/** Every catalog change goes to a second administrator (D-24), who needs to know why. */
const ChangeReason = z.string().trim().min(10, 'A catalog change needs a reason of at least 10 characters').max(1000);
const Name = z.string().trim().min(1).max(120);
/** Arabic name, shown in the Arabic interface (the English name when empty). */
const NameAr = z.string().trim().min(1).max(120);
const Description = z.string().trim().max(500);
/** Spec §6.1.1: 0–90 days, default 0; set by HR per hospital policy. */
const GraceDays = z.number().int().min(0).max(90);
const DisplayOrder = z.number().int().min(0);

export const TemplateCreateBody = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
  name: Name,
  nameAr: NameAr.optional(),
  categoryCode: z.string().min(1),
  description: Description.optional(),
  hasExpiry: z.boolean().default(true),
  requiresUpload: z.boolean().default(true),
  fieldDefs: FieldDefs.default([]),
  gracePeriodDays: GraceDays.default(0),
  displayOrder: DisplayOrder.default(0),
  // Spec §5.4 (D-64): check holders' licences with SCFHS; suspend on an adverse answer.
  scfhsEnabled: z.boolean().default(false),
  scfhsAutoSuspend: z.boolean().default(false),
  // Owner decision 2026-10-04: who the type applies to (nationality-rule.ts).
  nationalityRule: NationalityRuleSchema.default('ALL'),
  nationalityCodes: NationalityCodesSchema.default([]),
  reason: ChangeReason,
});
// Written out without defaults: `.partial()` of a schema with defaults would
// fill every omitted field with its default and overwrite the stored value.
export const TemplateUpdateBody = z.strictObject({
  name: Name.optional(),
  nameAr: NameAr.nullable().optional(),
  categoryCode: z.string().min(1).optional(),
  description: Description.optional(),
  hasExpiry: z.boolean().optional(),
  requiresUpload: z.boolean().optional(),
  fieldDefs: FieldDefs.optional(),
  gracePeriodDays: GraceDays.optional(),
  displayOrder: DisplayOrder.optional(),
  isActive: z.boolean().optional(),
  scfhsEnabled: z.boolean().optional(),
  scfhsAutoSuspend: z.boolean().optional(),
  nationalityRule: NationalityRuleSchema.optional(),
  nationalityCodes: NationalityCodesSchema.optional(),
  reason: ChangeReason,
});

/** Categories group credential types (spec §5.1.1). Hospital-wide and four-eyes like types (P8, D-24, D-25). */
export const CategoryCreateBody = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
  name: Name,
  description: Description.optional(),
  displayOrder: DisplayOrder.default(0),
  reason: ChangeReason,
});
export const CategoryUpdateBody = z.strictObject({
  name: Name.optional(),
  description: Description.nullable().optional(),
  displayOrder: DisplayOrder.optional(),
  reason: ChangeReason,
});
export const CategoryParam = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/) });

type CategoryData = Omit<z.infer<typeof CategoryCreateBody>, 'reason'>;
type CategoryChange = Omit<z.infer<typeof CategoryUpdateBody>, 'reason'>;
type CategoryBefore = Partial<Record<keyof CategoryChange, unknown>>;

type TemplateData = Omit<z.infer<typeof TemplateCreateBody>, 'reason'>;
type TemplateChange = Omit<z.infer<typeof TemplateUpdateBody>, 'reason'>;
type ChangedValues = Partial<Record<keyof TemplateChange, unknown>>;

/** Stored in approval_requests.payload for catalog changes (R10, D-24). */
export type CatalogApprovalPayload =
  | { kind: 'TEMPLATE_CREATE'; template: TemplateData; reason: string }
  /** `before` holds the stored values of the changed fields, to refuse a stale approval. */
  | { kind: 'TEMPLATE_UPDATE'; templateId: number; code: string; change: TemplateChange; before: ChangedValues; reason: string }
  | { kind: 'CATEGORY_CREATE'; category: CategoryData; reason: string }
  | { kind: 'CATEGORY_UPDATE'; code: string; change: CategoryChange; before: CategoryBefore; reason: string };

export const isCatalogPayload = (p: { kind: string }): p is CatalogApprovalPayload =>
  ['TEMPLATE_CREATE', 'TEMPLATE_UPDATE', 'CATEGORY_CREATE', 'CATEGORY_UPDATE'].includes(p.kind);

export type CatalogOutcome = { status: 'APPLIED'; template: TemplateView } | { status: 'PENDING_APPROVAL'; requestId: number };
export type CategoryOutcome = { status: 'APPLIED'; category: CredentialCategory } | { status: 'PENDING_APPROVAL'; requestId: number };


const Policy = z.enum(['MANDATORY', 'TRANSITION', 'OPTIONAL']);
const RequirementFields = {
  templateId: z.number().int().positive(),
  unitId: z.number().int().positive(),
  positionCode: z.string().min(1).nullable().default(null),
  policyStatus: Policy.default('MANDATORY'),
  transitionDeadline: z.string().refine(isIsoDate, 'YYYY-MM-DD').nullable().default(null),
};
const checkDeadline = <T extends { policyStatus?: string; transitionDeadline?: string | null }>(r: T, ctx: z.RefinementCtx) => {
  if (r.policyStatus === 'TRANSITION' && !r.transitionDeadline) ctx.addIssue({ code: 'custom', path: ['transitionDeadline'], message: 'A TRANSITION requirement needs a transition deadline (spec §6.1.1.1)' });
  if (r.policyStatus && r.policyStatus !== 'TRANSITION' && r.transitionDeadline) ctx.addIssue({ code: 'custom', path: ['transitionDeadline'], message: 'Only TRANSITION requirements have a deadline' });
};
export const RequirementBody = z.strictObject(RequirementFields).superRefine(checkDeadline);
export const RequirementUpdateBody = z.strictObject({
  positionCode: RequirementFields.positionCode.optional(),
  policyStatus: Policy.optional(),
  transitionDeadline: RequirementFields.transitionDeadline.optional(),
}).superRefine(checkDeadline);
export const RequirementBulkBody = z.strictObject({ items: z.array(RequirementBody).min(1).max(500) });
export const RequirementQuery = z.object({
  unitId: z.coerce.number().int().positive().optional(),
  position: z.string().min(1).optional(),
  templateId: z.coerce.number().int().positive().optional(),
});

type RequirementInput = z.infer<typeof RequirementBody>;

export function createCatalogService(db: Db) {
  /** Templates are one hospital-wide catalog: only system-wide HR/System Admins may change them (D-25). */
  async function assertSystemWide(tx: DbClient, auth: AuthContext) {
    if (!(await unitScope(tx, auth, HR_ROLES)).all) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'Only system-wide administrators can change the hospital credential catalog');
  }

  async function validateCreate(tx: DbClient, t: TemplateData) {
    if (!(await tx.credentialCategory.findUnique({ where: { code: t.categoryCode } }))) throw new HttpError(422, 'CATEGORY_NOT_FOUND', 'The category does not exist');
    if (await tx.credentialTemplate.findUnique({ where: { code: t.code }, select: { id: true } })) throw new HttpError(409, 'TEMPLATE_EXISTS', `A credential type with code ${t.code} already exists`);
  }

  async function loadTemplate(tx: DbClient, id: number): Promise<TemplateView | null> {
    const t = await tx.credentialTemplate.findUnique({ where: { id }, include: WITH_FIELDS });
    return t ? presentTemplate(t) : null;
  }

  /** The fields the change really alters, with their stored values. */
  async function changedFields(tx: DbClient, id: number, change: TemplateChange) {
    const current = await loadTemplate(tx, id);
    if (!current) throw notFound('Template not found');
    const before: ChangedValues = {};
    for (const [k, v] of Object.entries(change) as Array<[keyof TemplateChange, unknown]>) {
      if (v !== undefined && !sameValue(current[k], v)) before[k] = current[k];
    }
    if (Object.keys(before).length === 0) throw new HttpError(400, 'NO_CHANGES', 'The request does not change the credential type');
    if (change.categoryCode && before.categoryCode !== undefined && !(await tx.credentialCategory.findUnique({ where: { code: change.categoryCode } }))) {
      throw new HttpError(422, 'CATEGORY_NOT_FOUND', 'The category does not exist');
    }
    return { current, before };
  }

  /**
   * Field rules are re-applied when an approved request runs: a request stored
   * before a rule existed must be refused, not written.
   */
  function assertFieldRules(fieldDefs: unknown) {
    const check = FieldDefs.safeParse(fieldDefs);
    if (!check.success) throw new HttpError(422, 'FIELD_DEFINITIONS_INVALID', 'The field definitions break a catalog rule — reject this request and submit a corrected one', check.error.issues.map((i) => i.message));
  }

  /** D-64: SCFHS checks need a field holding the registration number; auto-suspend needs the checks. */
  function assertScfhsRules(t: { scfhsEnabled?: boolean; scfhsAutoSuspend?: boolean; fieldDefs: FieldDef[] }) {
    if (t.scfhsAutoSuspend && !t.scfhsEnabled) throw new HttpError(422, 'SCFHS_AUTO_SUSPEND_NEEDS_CHECKS', 'Automatic suspension needs SCFHS checks turned on');
    if (t.scfhsEnabled && !t.fieldDefs.some((d) => d.pdplCategory === 'SCFHS_REG')) {
      throw new HttpError(422, 'SCFHS_FIELD_REQUIRED', 'SCFHS checks need a field holding the SCFHS registration number (data category SCFHS_REG)');
    }
  }

  async function createNow(tx: DbClient, auth: AuthContext, t: TemplateData, reason: string, approvalRequestId: number | null, requestId?: string) {
    await assertSystemWide(tx, auth);
    assertFieldRules(t.fieldDefs);
    assertScfhsRules(t);
    // A request stored before the setting existed carries none: every nationality.
    await assertNationalityRule(tx, t.nationalityRule ?? 'ALL', t.nationalityCodes ?? []);
    await validateCreate(tx, t);
    const { fieldDefs, ...columns } = t;
    const created = await tx.credentialTemplate.create({ data: columns });
    await tx.credentialTemplateField.createMany({ data: fieldRows(created.id, fieldDefs) });
    const row = (await loadTemplate(tx, created.id))!;
    await appendAudit(tx, { actorUserId: auth.user.id, action: 'TEMPLATE_CREATED', resource: 'credential_template', resourceId: row.id, changes: { template: t, reason, approvalRequestId }, requestId, priority: 'HIGH' });
    return row;
  }

  /** `expected` (from the approval request) must still match, or the approver would sign off on values nobody saw. */
  async function updateNow(tx: DbClient, auth: AuthContext, id: number, change: TemplateChange, reason: string, expected: ChangedValues | null, approvalRequestId: number | null, requestId?: string) {
    await assertSystemWide(tx, auth);
    const { current, before } = await changedFields(tx, id, change);
    if (expected) {
      for (const [k, v] of Object.entries(expected) as Array<[keyof TemplateChange, unknown]>) {
        if (!sameValue(current[k], v)) throw new HttpError(409, 'TEMPLATE_CHANGED_SINCE_REQUEST', 'The credential type has changed since this request was made — reject it and submit a new one');
      }
    }
    const { fieldDefs, ...columns } = change;
    if (fieldDefs !== undefined) assertFieldRules(fieldDefs);
    assertScfhsRules({ scfhsEnabled: change.scfhsEnabled ?? current.scfhsEnabled, scfhsAutoSuspend: change.scfhsAutoSuspend ?? current.scfhsAutoSuspend, fieldDefs: fieldDefs ?? current.fieldDefs });
    const nationalityChanged = 'nationalityRule' in before || 'nationalityCodes' in before;
    if (nationalityChanged) await assertNationalityRule(tx, change.nationalityRule ?? current.nationalityRule, change.nationalityCodes ?? current.nationalityCodes);
    if (Object.keys(columns).length) await tx.credentialTemplate.update({ where: { id }, data: columns });
    // Field definitions are replaced as a set; the audit entry keeps before → after.
    if (fieldDefs !== undefined) {
      await tx.credentialTemplateField.deleteMany({ where: { templateId: id } });
      await tx.credentialTemplateField.createMany({ data: fieldRows(id, fieldDefs) });
    }
    const row = (await loadTemplate(tx, id))!;
    await appendAudit(tx, { actorUserId: auth.user.id, action: 'TEMPLATE_UPDATED', resource: 'credential_template', resourceId: id, changes: { before, after: change, reason, approvalRequestId }, requestId, priority: 'HIGH' });
    // Grace, expiry handling or activity changed: re-evaluate everyone who holds it.
    if (change.gracePeriodDays !== undefined || change.hasExpiry !== undefined || change.isActive !== undefined) {
      const holders = await tx.credential.findMany({ where: { templateId: id }, select: { employeeId: true }, distinct: ['employeeId'] });
      for (const h of holders) await refreshEligibility(tx, h.employeeId, 'TEMPLATE_UPDATED', { actorUserId: auth.user.id, requestId });
    }
    // Who the type applies to changed: everyone in a unit that requires it is re-evaluated (L6).
    if (nationalityChanged) {
      const units = await tx.credentialRequirement.findMany({ where: { templateId: id }, select: { unitId: true }, distinct: ['unitId'] });
      for (const u of units) await refreshUnit(tx, u.unitId, null, 'TEMPLATE_UPDATED', { actorUserId: auth.user.id, requestId });
    }
    return row;
  }

  async function assertCategoryFree(tx: DbClient, code: string) {
    if (await tx.credentialCategory.findUnique({ where: { code } })) throw new HttpError(409, 'CATEGORY_EXISTS', `A category with code ${code} already exists`);
  }

  async function createCategoryNow(tx: DbClient, auth: AuthContext, c: CategoryData, reason: string, approvalRequestId: number | null, requestId?: string) {
    await assertSystemWide(tx, auth);
    await assertCategoryFree(tx, c.code);
    const row = await tx.credentialCategory.create({ data: c });
    await appendAudit(tx, { actorUserId: auth.user.id, action: 'CATEGORY_CREATED', resource: 'credential_category', resourceId: c.code, changes: { category: c, reason, approvalRequestId }, requestId, priority: 'HIGH' });
    return row;
  }

  async function categoryChanges(tx: DbClient, code: string, change: CategoryChange) {
    const current = await tx.credentialCategory.findUnique({ where: { code } });
    if (!current) throw notFound('Category not found');
    const before: CategoryBefore = {};
    for (const [k, v] of Object.entries(change) as Array<[keyof CategoryChange, unknown]>) {
      if (v !== undefined && !sameValue(current[k], v)) before[k] = current[k];
    }
    if (Object.keys(before).length === 0) throw new HttpError(400, 'NO_CHANGES', 'The request does not change the category');
    return { current, before };
  }

  async function updateCategoryNow(tx: DbClient, auth: AuthContext, code: string, change: CategoryChange, reason: string, expected: CategoryBefore | null, approvalRequestId: number | null, requestId?: string) {
    await assertSystemWide(tx, auth);
    const { current, before } = await categoryChanges(tx, code, change);
    if (expected) {
      for (const [k, v] of Object.entries(expected) as Array<[keyof CategoryChange, unknown]>) {
        if (!sameValue(current[k], v)) throw new HttpError(409, 'CATEGORY_CHANGED_SINCE_REQUEST', 'The category has changed since this request was made — reject it and submit a new one');
      }
    }
    const row = await tx.credentialCategory.update({ where: { code }, data: change });
    await appendAudit(tx, { actorUserId: auth.user.id, action: 'CATEGORY_UPDATED', resource: 'credential_category', resourceId: code, changes: { before, after: change, reason, approvalRequestId }, requestId, priority: 'HIGH' });
    return row;
  }

  async function initiateApproval(auth: AuthContext, actionType: string, payload: CatalogApprovalPayload, requestId?: string) {
    return db.$transaction(async (tx) => {
      const req = await tx.approvalRequest.create({ data: { initiatorId: auth.user.id, actionType, payload: payload as Prisma.InputJsonObject } });
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'APPROVAL_INITIATED', resource: 'approval_request', resourceId: req.id, changes: { actionType, payload }, requestId, priority: 'HIGH' });
      return req.id;
    });
  }

  async function assertUnitInScope(tx: DbClient, auth: AuthContext, unitId: number) {
    const scope = await unitScope(tx, auth, HR_ROLES);
    if (!scope.all && !scope.unitIds.has(unitId)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This unit is outside your assigned scope');
  }

  async function assertRequirementTargets(tx: DbClient, r: { templateId: number; unitId: number; positionCode: string | null }) {
    // Sequential: `tx` is a transaction client (one pinned pg connection; no concurrent queries).
    const tpl = await tx.credentialTemplate.findUnique({ where: { id: r.templateId }, select: { isActive: true } });
    const unit = await tx.unit.findUnique({ where: { id: r.unitId }, select: { id: true } });
    const pos = r.positionCode ? await tx.position.findUnique({ where: { code: r.positionCode }, select: { isActive: true } }) : { isActive: true };
    if (!tpl) throw new HttpError(422, 'TEMPLATE_NOT_FOUND', 'The credential template does not exist');
    if (!tpl.isActive) throw new HttpError(422, 'TEMPLATE_INACTIVE', 'The credential template is inactive');
    if (!unit) throw new HttpError(422, 'UNIT_NOT_FOUND', 'The unit does not exist');
    if (!pos) throw new HttpError(422, 'POSITION_NOT_FOUND', 'The position does not exist');
    if (!pos.isActive) throw new HttpError(422, 'POSITION_NOT_ACTIVE', 'The position is not active');
  }

  const toRow = (r: RequirementInput) => ({
    templateId: r.templateId, unitId: r.unitId, positionCode: r.positionCode, policyStatus: r.policyStatus,
    transitionDeadline: r.transitionDeadline ? toDbDate(r.transitionDeadline) : null,
  });

  return {
    listCategories: () => db.credentialCategory.findMany({ orderBy: { displayOrder: 'asc' } }),
    listTemplates: async (includeInactive: boolean) => (await db.credentialTemplate.findMany({
      where: includeInactive ? {} : { isActive: true }, orderBy: [{ categoryCode: 'asc' }, { displayOrder: 'asc' }], include: WITH_FIELDS,
    })).map(presentTemplate),

    // R10 as decided in D-24: every catalog change needs a second system-wide
    // administrator. Break-glass bypasses four-eyes (spec §3.6), as for roles.
    async createTemplate(auth: AuthContext, body: z.infer<typeof TemplateCreateBody>, requestId?: string): Promise<CatalogOutcome> {
      const { reason, ...template } = body;
      if (auth.breakGlass) return { status: 'APPLIED', template: await db.$transaction((tx) => createNow(tx, auth, template, reason, null, requestId)) };
      // Validate now so an impossible request never reaches the approval queue.
      await assertSystemWide(db, auth);
      await validateCreate(db, template);
      assertScfhsRules(template);
      await assertNationalityRule(db, template.nationalityRule, template.nationalityCodes);
      return { status: 'PENDING_APPROVAL', requestId: await initiateApproval(auth, `TEMPLATE_CREATE:${template.code}`, { kind: 'TEMPLATE_CREATE', template, reason }, requestId) };
    },

    async updateTemplate(auth: AuthContext, id: number, body: z.infer<typeof TemplateUpdateBody>, requestId?: string): Promise<CatalogOutcome> {
      const { reason, ...given } = body;
      // "Every nationality" clears the list even when the request does not say so.
      const change = given.nationalityRule === 'ALL' && given.nationalityCodes === undefined ? { ...given, nationalityCodes: [] } : given;
      if (auth.breakGlass) return { status: 'APPLIED', template: await db.$transaction((tx) => updateNow(tx, auth, id, change, reason, null, null, requestId)) };
      await assertSystemWide(db, auth);
      const { current, before } = await changedFields(db, id, change);
      assertScfhsRules({ scfhsEnabled: change.scfhsEnabled ?? current.scfhsEnabled, scfhsAutoSuspend: change.scfhsAutoSuspend ?? current.scfhsAutoSuspend, fieldDefs: change.fieldDefs ?? current.fieldDefs });
      if ('nationalityRule' in before || 'nationalityCodes' in before) {
        await assertNationalityRule(db, change.nationalityRule ?? current.nationalityRule, change.nationalityCodes ?? current.nationalityCodes);
      }
      const only = Object.fromEntries(Object.keys(before).map((k) => [k, change[k as keyof TemplateChange]])) as TemplateChange;
      return { status: 'PENDING_APPROVAL', requestId: await initiateApproval(auth, `TEMPLATE_UPDATE:${id}`, { kind: 'TEMPLATE_UPDATE', templateId: id, code: current.code, change: only, before, reason }, requestId) };
    },

    // Categories follow the same four-eyes path as credential types (P8).
    async createCategory(auth: AuthContext, body: z.infer<typeof CategoryCreateBody>, requestId?: string): Promise<CategoryOutcome> {
      const { reason, ...category } = body;
      if (auth.breakGlass) return { status: 'APPLIED', category: await db.$transaction((tx) => createCategoryNow(tx, auth, category, reason, null, requestId)) };
      await assertSystemWide(db, auth);
      await assertCategoryFree(db, category.code);
      return { status: 'PENDING_APPROVAL', requestId: await initiateApproval(auth, `CATEGORY_CREATE:${category.code}`, { kind: 'CATEGORY_CREATE', category, reason }, requestId) };
    },

    async updateCategory(auth: AuthContext, code: string, body: z.infer<typeof CategoryUpdateBody>, requestId?: string): Promise<CategoryOutcome> {
      const { reason, ...change } = body;
      if (auth.breakGlass) return { status: 'APPLIED', category: await db.$transaction((tx) => updateCategoryNow(tx, auth, code, change, reason, null, null, requestId)) };
      await assertSystemWide(db, auth);
      const { before } = await categoryChanges(db, code, change);
      const only = Object.fromEntries(Object.keys(before).map((k) => [k, change[k as keyof CategoryChange]])) as CategoryChange;
      return { status: 'PENDING_APPROVAL', requestId: await initiateApproval(auth, `CATEGORY_UPDATE:${code}`, { kind: 'CATEGORY_UPDATE', code, change: only, before, reason }, requestId) };
    },

    /** Executes an approved catalog request as the approver, inside the approval's transaction (R11). */
    async executeApproved(tx: DbClient, approver: AuthContext, payload: CatalogApprovalPayload, approvalRequestId: number, requestId?: string): Promise<number | string> {
      switch (payload.kind) {
        case 'TEMPLATE_CREATE': return (await createNow(tx, approver, payload.template, payload.reason, approvalRequestId, requestId)).id;
        case 'TEMPLATE_UPDATE': return (await updateNow(tx, approver, payload.templateId, payload.change, payload.reason, payload.before, approvalRequestId, requestId)).id;
        case 'CATEGORY_CREATE': return (await createCategoryNow(tx, approver, payload.category, payload.reason, approvalRequestId, requestId)).code;
        case 'CATEGORY_UPDATE': return (await updateCategoryNow(tx, approver, payload.code, payload.change, payload.reason, payload.before, approvalRequestId, requestId)).code;
      }
    },

    async listRequirements(auth: AuthContext, q: z.infer<typeof RequirementQuery>) {
      const scope = await unitScope(db, auth, REVIEW_ROLES);
      // The caller's unit scope must constrain even an explicitly requested
      // unitId; otherwise a supervisor could read the hospital's other rules.
      if (q.unitId && !scope.all && !scope.unitIds.has(q.unitId)) return { items: [], total: 0 };
      const unitId = q.unitId ?? (scope.all ? undefined : { in: [...scope.unitIds] });
      const rows = await db.credentialRequirement.findMany({
        where: { ...(unitId === undefined ? {} : { unitId }), ...(q.position ? { positionCode: q.position } : {}), ...(q.templateId ? { templateId: q.templateId } : {}) },
        include: { template: { select: { code: true, name: true, nameAr: true } }, unit: { select: { code: true, name: true } } },
        orderBy: [{ unitId: 'asc' }, { templateId: 'asc' }, { positionCode: 'asc' }],
      });
      return { items: rows, total: rows.length };
    },

    async createRequirement(auth: AuthContext, body: RequirementInput, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertUnitInScope(tx, auth, body.unitId);
        await assertRequirementTargets(tx, body);
        const r = await tx.credentialRequirement.create({ data: toRow(body) });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'REQUIREMENT_CREATED', resource: 'credential_requirement', resourceId: r.id, changes: body, requestId, priority: 'HIGH' });
        const affected = await refreshUnit(tx, body.unitId, body.positionCode, 'REQUIREMENT_CREATED', { actorUserId: auth.user.id, requestId });
        return { ...r, affectedEmployees: affected };
      });
    },

    async updateRequirement(auth: AuthContext, id: number, body: z.infer<typeof RequirementUpdateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const before = await tx.credentialRequirement.findUnique({ where: { id } });
        if (!before) throw notFound('Requirement not found');
        await assertUnitInScope(tx, auth, before.unitId);
        const next = {
          templateId: before.templateId, unitId: before.unitId,
          positionCode: body.positionCode !== undefined ? body.positionCode : before.positionCode,
          policyStatus: body.policyStatus ?? before.policyStatus,
          transitionDeadline: body.transitionDeadline !== undefined ? body.transitionDeadline : (before.transitionDeadline ? before.transitionDeadline.toISOString().slice(0, 10) : null),
        };
        if (next.policyStatus === 'TRANSITION' && !next.transitionDeadline) throw new HttpError(400, 'VALIDATION_FAILED', 'A TRANSITION requirement needs a transition deadline');
        if (next.policyStatus !== 'TRANSITION') next.transitionDeadline = null;
        await assertRequirementTargets(tx, next);
        const r = await tx.credentialRequirement.update({ where: { id }, data: toRow(next) });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'REQUIREMENT_UPDATED', resource: 'credential_requirement', resourceId: id, changes: { before, after: next }, requestId, priority: 'HIGH' });
        // Old and new position scopes may differ: refresh the whole unit.
        const affected = await refreshUnit(tx, before.unitId, null, 'REQUIREMENT_UPDATED', { actorUserId: auth.user.id, requestId });
        return { ...r, affectedEmployees: affected };
      });
    },

    async deleteRequirement(auth: AuthContext, id: number, requestId?: string) {
      return db.$transaction(async (tx) => {
        const before = await tx.credentialRequirement.findUnique({ where: { id } });
        if (!before) throw notFound('Requirement not found');
        await assertUnitInScope(tx, auth, before.unitId);
        // Deleting a rule never deletes credentials employees hold (§5.1.4).
        await tx.credentialRequirement.delete({ where: { id } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'REQUIREMENT_DELETED', resource: 'credential_requirement', resourceId: id, changes: { before }, requestId, priority: 'HIGH' });
        const affected = await refreshUnit(tx, before.unitId, before.positionCode, 'REQUIREMENT_DELETED', { actorUserId: auth.user.id, requestId });
        return { id, affectedEmployees: affected };
      });
    },

    /** §5.1.4 bulk set: all entries in one transaction (initial hospital configuration). */
    async bulkSetRequirements(auth: AuthContext, items: RequirementInput[], requestId?: string) {
      return db.$transaction(async (tx) => {
        const units = new Set<number>();
        let created = 0;
        let updated = 0;
        for (const item of items) {
          await assertUnitInScope(tx, auth, item.unitId);
          await assertRequirementTargets(tx, item);
          const existing = await tx.credentialRequirement.findFirst({ where: { templateId: item.templateId, unitId: item.unitId, positionCode: item.positionCode } });
          if (existing) { await tx.credentialRequirement.update({ where: { id: existing.id }, data: toRow(item) }); updated++; }
          else { await tx.credentialRequirement.create({ data: toRow(item) }); created++; }
          units.add(item.unitId);
        }
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'REQUIREMENTS_BULK_SET', resource: 'credential_requirement', changes: { created, updated, items }, requestId, priority: 'HIGH' });
        let affected = 0;
        for (const u of units) affected += await refreshUnit(tx, u, null, 'REQUIREMENTS_BULK_SET', { actorUserId: auth.user.id, requestId });
        return { created, updated, affectedEmployees: affected };
      }, { timeout: 60_000 });
    },
  };
}

export type CatalogService = ReturnType<typeof createCatalogService>;
