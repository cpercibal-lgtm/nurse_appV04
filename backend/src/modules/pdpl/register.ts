// Processing register (spec §8.3.2, D-54): the documented lawful basis, purpose
// and retention for each category of sensitive personal data. A sensitive
// value is stored only while its category has an active row (protection.ts).
// HR and System Admins read it; System Admins maintain it (audited HIGH).
// The Data Protection Officer signs it off (B-18, D-56): the sign-off keeps
// the register as reviewed; a new one is due every SIGN_OFF_DAYS and after
// any change (System health: PDPL_REGISTER_SIGN_OFF_DUE).

import { Router } from 'express';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { notFound } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';

const Basis = z.enum(['EMPLOYMENT_CONTRACT', 'LEGAL_OBLIGATION', 'CONSENT', 'VITAL_INTEREST', 'PUBLIC_INTEREST']);
const Reason = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(1000);
export const RegisterCreateBody = z.strictObject({
  dataCategory: z.enum(['IQAMA', 'PASSPORT', 'SCFHS_REG', 'NATIONAL_ID', 'IDENTITY_SCAN']),
  lawfulBasis: Basis,
  purpose: z.string().trim().min(10).max(1000),
  retentionRule: z.string().trim().min(5).max(500),
  reason: Reason,
});
export const RegisterUpdateBody = z.strictObject({
  purpose: z.string().trim().min(10).max(1000).optional(),
  retentionRule: z.string().trim().min(5).max(500).optional(),
  isActive: z.boolean().optional(),
  reason: Reason,
});
const IdParam = z.object({ id: z.coerce.number().int().positive() });
export const SignOffBody = z.strictObject({
  title: z.string().trim().min(3).max(200),
  note: z.string().trim().max(2000).optional(),
  confirm: z.literal(true, { error: 'Confirm that every entry was reviewed' }),
});
/** A sign-off is due yearly, and again after any change to the register. */
export const SIGN_OFF_DAYS = 365;

/** The latest sign-off and whether the register changed since (or it is older than a year). */
export async function signOffState(db: DbClient, now = new Date()) {
  const last = await db.processingRegisterSignOff.findFirst({ orderBy: { reviewedAt: 'desc' }, include: { reviewedBy: { select: { id: true, displayName: true } } } });
  const changed = last ? await db.processingRegister.count({ where: { OR: [{ updatedAt: { gt: last.reviewedAt } }, { createdAt: { gt: last.reviewedAt } }] } }) : 0;
  const dueAt = last ? new Date(last.reviewedAt.getTime() + SIGN_OFF_DAYS * 86_400_000) : null;
  return {
    last: last ? { id: last.id, reviewedBy: last.reviewedBy, title: last.reviewerTitle, note: last.note, reviewedAt: last.reviewedAt } : null,
    changedSince: changed > 0, dueAt,
    due: !last || changed > 0 || now >= dueAt!,
  };
}

export function createPdplRouter(db: Db) {
  const r = Router();

  r.get('/pdpl/register', authorize('pdpl.read'), async (_req, res) => {
    const items = await db.processingRegister.findMany({ orderBy: [{ dataCategory: 'asc' }, { lawfulBasis: 'asc' }] });
    res.json({ items, total: items.length, signOff: await signOffState(db) });
  });

  r.get('/pdpl/register/sign-offs', authorize('pdpl.read'), async (_req, res) => {
    const items = await db.processingRegisterSignOff.findMany({ orderBy: { reviewedAt: 'desc' }, take: 100, include: { reviewedBy: { select: { id: true, displayName: true } } } });
    res.json({ items: items.map((i) => ({ id: i.id, reviewedBy: i.reviewedBy, title: i.reviewerTitle, note: i.note, reviewedAt: i.reviewedAt, register: i.registerSnapshot })), total: items.length });
  });

  // The signed-in DPO records their review; the register as it stands is kept with it.
  r.post('/pdpl/register/sign-offs', authorize('pdpl.signoff'), async (req, res) => {
    const body = SignOffBody.parse(req.body);
    const auth = authOf(res);
    const row = await db.$transaction(async (tx) => {
      const register = await tx.processingRegister.findMany({ orderBy: [{ dataCategory: 'asc' }, { lawfulBasis: 'asc' }], select: { id: true, dataCategory: true, lawfulBasis: true, purpose: true, retentionRule: true, isActive: true, updatedAt: true } });
      const created = await tx.processingRegisterSignOff.create({ data: { reviewedById: auth.user.id, reviewerTitle: body.title, note: body.note || null, registerSnapshot: register } });
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'PROCESSING_REGISTER_SIGNED_OFF', resource: 'processing_register', resourceId: created.id, changes: { title: body.title, entries: register.length, note: Boolean(body.note) }, requestId: res.locals.requestId, priority: 'HIGH' });
      return created;
    });
    res.status(201).json({ id: row.id, reviewedAt: row.reviewedAt });
  });

  r.post('/pdpl/register', authorize('pdpl.manage'), async (req, res) => {
    const { reason, ...body } = RegisterCreateBody.parse(req.body);
    const auth = authOf(res);
    const row = await db.$transaction(async (tx) => {
      const created = await tx.processingRegister.create({ data: { ...body, updatedById: auth.user.id } });
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'PROCESSING_REGISTER_ADDED', resource: 'processing_register', resourceId: created.id, changes: { ...body, reason }, requestId: res.locals.requestId, priority: 'HIGH' });
      return created;
    });
    res.status(201).json(row);
  });

  r.patch('/pdpl/register/:id', authorize('pdpl.manage'), async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const { reason, ...body } = RegisterUpdateBody.parse(req.body);
    const auth = authOf(res);
    const row = await db.$transaction(async (tx) => {
      const before = await tx.processingRegister.findUnique({ where: { id } });
      if (!before) throw notFound('Register entry not found');
      const after = await tx.processingRegister.update({ where: { id }, data: { ...body, updatedById: auth.user.id } });
      const changed = Object.fromEntries(Object.entries(body).filter(([k, v]) => before[k as keyof typeof before] !== v).map(([k, v]) => [k, { from: before[k as keyof typeof before], to: v }]));
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'PROCESSING_REGISTER_CHANGED', resource: 'processing_register', resourceId: id, changes: { dataCategory: before.dataCategory, changed, reason }, requestId: res.locals.requestId, priority: 'HIGH' });
      return after;
    });
    res.json(row);
  });

  return r;
}
