// Facility master (owner decision 2026-10-03): the hospitals an employee actually works
// in ("Actual Work Place / Facility"), maintained by hospital-wide HR and System Admins —
// from Manage Facilities beside the field or Workforce -> Facilities — every change
// audited. Names are stored trimmed with single spaces and are unique ignoring case. A
// facility employees use is never deleted, only deactivated: hidden from new choices,
// still shown on those employees.

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { assertUnchanged } from '../../lib/concurrency.js';
import { conflict, HttpError, notFound, unprocessable } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { HR_ROLES } from '../credentials/access.js';
import { unitScope, type AuthContext } from '../users/access.js';

/** Trimmed, repeated spaces collapsed: "  King  Fahd   Hospital " → "King Fahd Hospital". */
const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');
const Name = z.string().transform(tidy).pipe(z.string().min(1, 'Facility Name is required.').max(150));
const NameAr = z.string().transform(tidy).pipe(z.string().max(150));

export const FacilityQuery = z.object({
  includeInactive: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  q: z.string().trim().max(80).optional(),
});
export const FacilityCreateBody = z.strictObject({ name: Name, nameAr: NameAr.optional(), isActive: z.boolean().default(true), sortOrder: z.number().int().min(0).optional() });
export const FacilityUpdateBody = z.strictObject({ name: Name.optional(), nameAr: NameAr.nullable().optional(), isActive: z.boolean().optional(), sortOrder: z.number().int().min(0).optional() });
/** The request field on an employee: a facility id, never free text. */
export const FacilityId = z.number({ error: 'Actual Work Place / Facility is required.' }).int().positive();

/** A new choice must be a listed, active facility (an unchanged one may have been deactivated since). */
export async function assertActiveFacility(tx: DbClient, id: number) {
  const f = await tx.facility.findUnique({ where: { id }, select: { isActive: true } });
  if (!f) throw unprocessable('FACILITY_INVALID', `Not a listed facility: ${id}`);
  if (!f.isActive) throw unprocessable('FACILITY_INACTIVE', 'This facility is no longer in use — choose another');
  return id;
}

export function createFacilityService(db: Db) {
  async function assertSystemWide(tx: DbClient, auth: AuthContext) {
    if (!(await unitScope(tx, auth, HR_ROLES)).all) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'Only system-wide administrators can change the Facility master');
  }
  async function assertNameFree(tx: DbClient, name: string, exceptId?: number) {
    const clash = await tx.facility.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, name: true } });
    if (clash) throw conflict('FACILITY_NAME_EXISTS', `A facility with this name already exists: ${clash.name}`, { id: clash.id });
  }

  return {
    /** By sort order, then name; q searches the English and Arabic names. */
    async list(q: z.infer<typeof FacilityQuery>) {
      const rows = await db.facility.findMany({
        where: { ...(q.includeInactive ? {} : { isActive: true }), ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { nameAr: { contains: q.q } }] } : {}) },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { employees: true } } },
      });
      return { items: rows.map(({ _count, ...f }) => ({ ...f, employeeCount: _count.employees })) };
    },

    async create(auth: AuthContext, body: z.infer<typeof FacilityCreateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        await assertNameFree(tx, body.name);
        // A new facility goes to the end of the list unless an order is given.
        const sortOrder = body.sortOrder ?? ((await tx.facility.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 1;
        const f = await tx.facility.create({ data: { ...body, nameAr: body.nameAr || null, sortOrder } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'FACILITY_CREATED', resource: 'facility', resourceId: f.id, changes: { after: { ...body, sortOrder } }, requestId });
        return f;
      });
    },

    async update(auth: AuthContext, id: number, body: z.infer<typeof FacilityUpdateBody>, requestId?: string, expected: Date | null = null) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        await tx.$queryRaw`SELECT id FROM facilities WHERE id = ${id} FOR UPDATE`;
        const before = await tx.facility.findUnique({ where: { id } });
        if (!before) throw notFound('Facility not found');
        assertUnchanged(expected, before);
        if (body.name !== undefined) await assertNameFree(tx, body.name, id);
        const f = await tx.facility.update({ where: { id }, data: { ...body, ...(body.nameAr !== undefined ? { nameAr: body.nameAr || null } : {}) } });
        const action = body.isActive === false && before.isActive ? 'FACILITY_DEACTIVATED'
          : body.isActive === true && !before.isActive ? 'FACILITY_REACTIVATED' : 'FACILITY_UPDATED';
        const changed = Object.fromEntries(Object.keys(body).map((k) => [k, { from: (before as Record<string, unknown>)[k] ?? null, to: (body as Record<string, unknown>)[k] }]));
        await appendAudit(tx, { actorUserId: auth.user.id, action, resource: 'facility', resourceId: id, changes: changed, requestId });
        return f;
      });
    },

    /** Deletes a facility no employee uses; otherwise refused with the count (deactivate it instead). */
    async remove(auth: AuthContext, id: number, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        const before = await tx.facility.findUnique({ where: { id } });
        if (!before) throw notFound('Facility not found');
        const employees = await tx.employee.count({ where: { facilityId: id } });
        if (employees > 0) throw conflict('FACILITY_IN_USE', `${before.name} is assigned to ${employees} employee(s): it cannot be permanently deleted. Deactivate it instead.`, { employees });
        await tx.facility.delete({ where: { id } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'FACILITY_DELETED', resource: 'facility', resourceId: id, changes: { before }, requestId });
        return { id, deleted: true };
      });
    },
  };
}
