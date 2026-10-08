// Nursing Specialty master (owner decision 2026-10-03): NS001 Clinical Nursing …
// NS034 General / Unspecified to start, maintained on screen by hospital-wide HR and
// System Admins, every change audited, listed by sort order. Employees store the
// code. Names are unique ignoring case, so the dropdown never shows look-alikes. A
// record in use is never deleted, only deactivated: hidden from new choices, still
// shown on the employees who hold it.

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { assertUnchanged } from '../../lib/concurrency.js';
import { conflict, HttpError, notFound, unprocessable } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { HR_ROLES } from '../credentials/access.js';
import { unitScope, type AuthContext } from '../users/access.js';
import { Code } from './org.js';

const Name = z.string().trim().min(1, 'Specialty name is required').max(120);
const NameAr = z.string().trim().max(120);
const Description = z.string().trim().max(300);

export const SpecialtyQuery = z.object({
  includeInactive: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  q: z.string().trim().max(80).optional(),
});
export const SpecialtyCreateBody = z.strictObject({
  code: Code, name: Name, nameAr: NameAr.optional(), description: Description.optional(),
  isActive: z.boolean().default(true), sortOrder: z.number().int().min(0).default(0),
});
// The code is the key employees point to: it never changes.
export const SpecialtyUpdateBody = z.strictObject({
  name: Name.optional(), nameAr: NameAr.nullable().optional(), description: Description.nullable().optional(),
  isActive: z.boolean().optional(), sortOrder: z.number().int().min(0).optional(),
});
/** The request field on an employee: a listed code, never free text. */
export const SpecialtyCode = z.string({ error: 'Specialty is required.' }).trim().toUpperCase()
  .pipe(z.string().min(1, 'Specialty is required.').max(20));

/** A new choice must be a listed, active specialty. */
export async function assertActiveSpecialty(tx: DbClient, code: string) {
  const s = await tx.nursingSpecialty.findUnique({ where: { code }, select: { isActive: true } });
  if (!s) throw unprocessable('SPECIALTY_INVALID', `Not a listed specialty: ${code}`);
  if (!s.isActive) throw unprocessable('SPECIALTY_INACTIVE', `The specialty ${code} is no longer in use — choose another`);
  return code;
}

const blank = (v: string | null | undefined) => (v ? v : null);

export function createSpecialtyService(db: Db) {
  async function assertSystemWide(tx: DbClient, auth: AuthContext) {
    if (!(await unitScope(tx, auth, HR_ROLES)).all) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'Only system-wide administrators can change the Nursing Specialty master');
  }
  async function assertNameFree(tx: DbClient, name: string, exceptCode?: string) {
    const clash = await tx.nursingSpecialty.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...(exceptCode ? { code: { not: exceptCode } } : {}) }, select: { code: true } });
    if (clash) throw conflict('SPECIALTY_NAME_EXISTS', `A specialty with this name already exists (${clash.code})`, { code: clash.code });
  }

  return {
    /** Sort order, then code. Search covers code, name, Arabic name and description. */
    async list(q: z.infer<typeof SpecialtyQuery>) {
      const search = q.q ? { OR: (['code', 'name', 'nameAr', 'description'] as const).map((f) => ({ [f]: { contains: q.q, mode: 'insensitive' as const } })) } : {};
      const rows = await db.nursingSpecialty.findMany({
        where: { ...(q.includeInactive ? {} : { isActive: true }), ...search },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        include: { _count: { select: { employees: true } } },
      });
      return { items: rows.map(({ _count, ...s }) => ({ ...s, employeeCount: _count.employees })) };
    },

    async create(auth: AuthContext, body: z.infer<typeof SpecialtyCreateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        if (await tx.nursingSpecialty.findUnique({ where: { code: body.code } })) throw conflict('SPECIALTY_EXISTS', `A specialty with code ${body.code} already exists`);
        await assertNameFree(tx, body.name);
        const s = await tx.nursingSpecialty.create({ data: { ...body, nameAr: blank(body.nameAr), description: blank(body.description) } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'SPECIALTY_CREATED', resource: 'nursing_specialty', resourceId: s.code, changes: { after: body }, requestId });
        return s;
      });
    },

    async update(auth: AuthContext, code: string, body: z.infer<typeof SpecialtyUpdateBody>, requestId?: string, expected: Date | null = null) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        await tx.$queryRaw`SELECT code FROM nursing_specialties WHERE code = ${code} FOR UPDATE`;
        const before = await tx.nursingSpecialty.findUnique({ where: { code } });
        if (!before) throw notFound('Specialty not found');
        assertUnchanged(expected, before);
        if (body.name !== undefined) await assertNameFree(tx, body.name, code);
        const data = {
          ...body,
          ...(body.nameAr !== undefined ? { nameAr: blank(body.nameAr) } : {}),
          ...(body.description !== undefined ? { description: blank(body.description) } : {}),
        };
        const s = await tx.nursingSpecialty.update({ where: { code }, data });
        const action = body.isActive === false && before.isActive ? 'SPECIALTY_DEACTIVATED'
          : body.isActive === true && !before.isActive ? 'SPECIALTY_REACTIVATED' : 'SPECIALTY_UPDATED';
        const changed = Object.fromEntries(Object.keys(body).map((k) => [k, { from: (before as Record<string, unknown>)[k] ?? null, to: (body as Record<string, unknown>)[k] }]));
        await appendAudit(tx, { actorUserId: auth.user.id, action, resource: 'nursing_specialty', resourceId: code, changes: changed, requestId });
        return s;
      });
    },

    /** Deletes an unused specialty; one held by employees is refused with the count (deactivate it instead). */
    async remove(auth: AuthContext, code: string, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        const before = await tx.nursingSpecialty.findUnique({ where: { code } });
        if (!before) throw notFound('Specialty not found');
        const employees = await tx.employee.count({ where: { specialtyCode: code } });
        if (employees > 0) {
          throw conflict('SPECIALTY_IN_USE', `This specialty is assigned to ${employees} employee(s): it cannot be deleted. Deactivate it instead.`, { employees });
        }
        await tx.nursingSpecialty.delete({ where: { code } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'SPECIALTY_DELETED', resource: 'nursing_specialty', resourceId: code, changes: { before }, requestId });
        return { code, deleted: true };
      });
    },
  };
}
