// Saudi Arabia location master (owner decision 2026-10-03): regions (ISO 3166-2
// codes, SA-01 …) and their cities, maintained on screen by hospital-wide HR and
// System Admins, every change audited, listed by sort order. An employee's Job Post
// (City) is a region and one of its cities. A region with cities or employees, or a
// city employees hold, is never deleted — only deactivated: hidden from new choices,
// still shown where it is used.

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { assertUnchanged } from '../../lib/concurrency.js';
import { conflict, HttpError, notFound, unprocessable } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { HR_ROLES } from '../credentials/access.js';
import { unitScope, type AuthContext } from '../users/access.js';

const RegionCode = z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z][A-Z0-9-]{0,9}$/, 'Region code: letters, digits and - (max 10), starting with a letter, e.g. SA-15'));
const Name = z.string().trim().min(1, 'A name is required').max(80);
const NameAr = z.string().trim().max(80);
const Order = z.number().int().min(0);
const Bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

export const LocationQuery = z.object({ includeInactive: Bool, regionCode: z.string().trim().toUpperCase().max(10).optional(), q: z.string().trim().max(80).optional() });
export const RegionCreateBody = z.strictObject({ code: RegionCode, name: Name, nameAr: NameAr.optional(), isActive: z.boolean().default(true), sortOrder: Order.default(0) });
// The code is the key cities and employees point to: it never changes.
export const RegionUpdateBody = z.strictObject({ name: Name.optional(), nameAr: NameAr.nullable().optional(), isActive: z.boolean().optional(), sortOrder: Order.optional() });
export const CityCreateBody = z.strictObject({ regionCode: RegionCode, name: Name, nameAr: NameAr.optional(), isActive: z.boolean().default(true), sortOrder: Order.default(0) });
// A city moves to another region only while nobody holds it (the service checks).
export const CityUpdateBody = z.strictObject({ regionCode: RegionCode.optional(), name: Name.optional(), nameAr: NameAr.nullable().optional(), isActive: z.boolean().optional(), sortOrder: Order.optional() });

/** The request fields on an employee: a region code and the id of one of its cities — never free text. */
export const JobPostFields = {
  jobPostRegionCode: z.string({ error: 'Job Post (City) is required.' }).trim().toUpperCase().pipe(z.string().min(1, 'Job Post (City) is required.').max(10)),
  jobPostCityId: z.number({ error: 'Job Post (City) is required.' }).int().positive(),
};

/**
 * Region and city must exist and the city must belong to the region; a new choice must be
 * active (an unchanged one may have been deactivated since and is kept).
 */
export async function assertJobPost(tx: DbClient, regionCode: string, cityId: number, unchanged = false) {
  const city = await tx.saudiCity.findUnique({ where: { id: cityId }, include: { region: { select: { isActive: true } } } });
  const region = await tx.saudiRegion.findUnique({ where: { code: regionCode }, select: { isActive: true } });
  if (!region) throw unprocessable('REGION_INVALID', `Not a listed region: ${regionCode}`);
  if (!city) throw unprocessable('CITY_INVALID', `Not a listed city: ${cityId}`);
  if (city.regionCode !== regionCode) throw unprocessable('CITY_NOT_IN_REGION', `${city.name} is not in region ${regionCode}`);
  if (!unchanged && !region.isActive) throw unprocessable('REGION_INACTIVE', `The region ${regionCode} is no longer in use — choose another`);
  if (!unchanged && !city.isActive) throw unprocessable('CITY_INACTIVE', `${city.name} is no longer in use — choose another city`);
}

const blank = (v: string | null | undefined) => (v ? v : null);
const changes = (before: Record<string, unknown>, body: Record<string, unknown>) =>
  Object.fromEntries(Object.keys(body).map((k) => [k, { from: before[k] ?? null, to: body[k] }]));
const activity = (prefix: string, before: { isActive: boolean }, isActive: boolean | undefined) =>
  isActive === false && before.isActive ? `${prefix}_DEACTIVATED` : isActive === true && !before.isActive ? `${prefix}_REACTIVATED` : `${prefix}_UPDATED`;

export function createLocationService(db: Db) {
  async function assertSystemWide(tx: DbClient, auth: AuthContext) {
    if (!(await unitScope(tx, auth, HR_ROLES)).all) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'Only system-wide administrators can change the Saudi location master');
  }
  async function assertRegionNameFree(tx: DbClient, name: string, exceptCode?: string) {
    const clash = await tx.saudiRegion.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...(exceptCode ? { code: { not: exceptCode } } : {}) }, select: { code: true } });
    if (clash) throw conflict('REGION_NAME_EXISTS', `A region with this name already exists (${clash.code})`);
  }
  async function assertCityNameFree(tx: DbClient, regionCode: string, name: string, exceptId?: number) {
    const clash = await tx.saudiCity.findFirst({ where: { regionCode, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (clash) throw conflict('CITY_NAME_EXISTS', 'This region already has a city with this name');
  }
  async function assertRegionExists(tx: DbClient, code: string) {
    if (!(await tx.saudiRegion.findUnique({ where: { code }, select: { code: true } }))) throw unprocessable('REGION_INVALID', `Not a listed region: ${code}`);
  }

  return {
    async listRegions(q: z.infer<typeof LocationQuery>) {
      const rows = await db.saudiRegion.findMany({
        where: { ...(q.includeInactive ? {} : { isActive: true }), ...(q.q ? { OR: [{ code: { contains: q.q, mode: 'insensitive' } }, { name: { contains: q.q, mode: 'insensitive' } }, { nameAr: { contains: q.q } }] } : {}) },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        include: { _count: { select: { cities: true, employees: true } } },
      });
      return { items: rows.map(({ _count, ...r }) => ({ ...r, cityCount: _count.cities, employeeCount: _count.employees })) };
    },

    /** Cities by region sort order, then city sort order; regionCode limits to one region. */
    async listCities(q: z.infer<typeof LocationQuery>) {
      const rows = await db.saudiCity.findMany({
        where: {
          ...(q.includeInactive ? {} : { isActive: true, region: { isActive: true } }),
          ...(q.regionCode ? { regionCode: q.regionCode } : {}),
          ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { nameAr: { contains: q.q } }] } : {}),
        },
        orderBy: [{ region: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { employees: true } } },
      });
      return { items: rows.map(({ _count, ...c }) => ({ ...c, employeeCount: _count.employees })) };
    },

    async createRegion(auth: AuthContext, body: z.infer<typeof RegionCreateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        if (await tx.saudiRegion.findUnique({ where: { code: body.code } })) throw conflict('REGION_EXISTS', `A region with code ${body.code} already exists`);
        await assertRegionNameFree(tx, body.name);
        const r = await tx.saudiRegion.create({ data: { ...body, nameAr: blank(body.nameAr) } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'REGION_CREATED', resource: 'saudi_region', resourceId: r.code, changes: { after: body }, requestId });
        return r;
      });
    },

    async updateRegion(auth: AuthContext, code: string, body: z.infer<typeof RegionUpdateBody>, requestId?: string, expected: Date | null = null) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        await tx.$queryRaw`SELECT code FROM saudi_regions WHERE code = ${code} FOR UPDATE`;
        const before = await tx.saudiRegion.findUnique({ where: { code } });
        if (!before) throw notFound('Region not found');
        assertUnchanged(expected, before);
        if (body.name !== undefined) await assertRegionNameFree(tx, body.name, code);
        const r = await tx.saudiRegion.update({ where: { code }, data: { ...body, ...(body.nameAr !== undefined ? { nameAr: blank(body.nameAr) } : {}) } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: activity('REGION', before, body.isActive), resource: 'saudi_region', resourceId: code, changes: changes(before, body), requestId });
        return r;
      });
    },

    /** Deletes a region with no cities and no employees; otherwise refused with the counts (deactivate it instead). */
    async removeRegion(auth: AuthContext, code: string, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        const before = await tx.saudiRegion.findUnique({ where: { code } });
        if (!before) throw notFound('Region not found');
        const [cities, employees] = await Promise.all([tx.saudiCity.count({ where: { regionCode: code } }), tx.employee.count({ where: { jobPostRegionCode: code } })]);
        if (cities + employees > 0) throw conflict('REGION_IN_USE', `This region has ${cities} city(ies) and ${employees} employee(s): it cannot be deleted. Deactivate it instead.`, { cities, employees });
        await tx.saudiRegion.delete({ where: { code } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'REGION_DELETED', resource: 'saudi_region', resourceId: code, changes: { before }, requestId });
        return { code, deleted: true };
      });
    },

    async createCity(auth: AuthContext, body: z.infer<typeof CityCreateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        await assertRegionExists(tx, body.regionCode);
        await assertCityNameFree(tx, body.regionCode, body.name);
        const c = await tx.saudiCity.create({ data: { ...body, nameAr: blank(body.nameAr) } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'CITY_CREATED', resource: 'saudi_city', resourceId: c.id, changes: { after: body }, requestId });
        return c;
      });
    },

    async updateCity(auth: AuthContext, id: number, body: z.infer<typeof CityUpdateBody>, requestId?: string, expected: Date | null = null) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        await tx.$queryRaw`SELECT id FROM saudi_cities WHERE id = ${id} FOR UPDATE`;
        const before = await tx.saudiCity.findUnique({ where: { id } });
        if (!before) throw notFound('City not found');
        assertUnchanged(expected, before);
        const regionCode = body.regionCode ?? before.regionCode;
        if (regionCode !== before.regionCode) {
          await assertRegionExists(tx, regionCode);
          const held = await tx.employee.count({ where: { jobPostCityId: id } });
          if (held > 0) throw conflict('CITY_IN_USE', `${held} employee(s) hold this city: it cannot move to another region. Add the city to that region instead.`, { employees: held });
        }
        if (body.name !== undefined || regionCode !== before.regionCode) await assertCityNameFree(tx, regionCode, body.name ?? before.name, id);
        const c = await tx.saudiCity.update({ where: { id }, data: { ...body, ...(body.nameAr !== undefined ? { nameAr: blank(body.nameAr) } : {}) } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: activity('CITY', before, body.isActive), resource: 'saudi_city', resourceId: id, changes: changes(before, body), requestId });
        return c;
      });
    },

    /** Deletes a city nobody holds; otherwise refused with the count (deactivate it instead). */
    async removeCity(auth: AuthContext, id: number, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        const before = await tx.saudiCity.findUnique({ where: { id } });
        if (!before) throw notFound('City not found');
        const employees = await tx.employee.count({ where: { jobPostCityId: id } });
        if (employees > 0) throw conflict('CITY_IN_USE', `This city is assigned to ${employees} employee(s): it cannot be deleted. Deactivate it instead.`, { employees });
        await tx.saudiCity.delete({ where: { id } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'CITY_DELETED', resource: 'saudi_city', resourceId: id, changes: { before }, requestId });
        return { id, deleted: true };
      });
    },
  };
}
