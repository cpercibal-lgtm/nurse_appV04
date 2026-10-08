// Rank/Grade master (owner decision 2026-10-03): the SCFHS nursing classification
// (N01 Senior Specialist Consultant Nurse … N05 Health Assistant Nurse to start),
// maintained on screen by system-wide HR and System Admins, every change audited.
// Employees store the code, and the SCFHS licence's "classification" field uses the
// same list. A record in use — by an employee or a licence — is never deleted, only
// deactivated: hidden from new choices, still shown where it is used.

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { assertUnchanged } from '../../lib/concurrency.js';
import { conflict, HttpError, notFound, unprocessable } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { HR_ROLES } from '../credentials/access.js';
import { unitScope, type AuthContext } from '../users/access.js';
import { Code } from './org.js';

/** The credential field that records the SCFHS classification (type `select`, any template). */
export const CLASSIFICATION_FIELD_KEY = 'classification';

const Name = z.string().trim().min(1, 'SCFHS Nursing Classification is required').max(120);
const Meaning = z.string().trim().max(300);

export const RankGradeQuery = z.object({
  includeInactive: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  q: z.string().trim().max(80).optional(),
});
export const RankGradeCreateBody = z.strictObject({
  code: Code, name: Name, meaning: Meaning.optional(), isActive: z.boolean().default(true), sortOrder: z.number().int().min(0).default(0),
});
// The code is the key employees and licences point to: it never changes.
export const RankGradeUpdateBody = z.strictObject({
  name: Name.optional(), meaning: Meaning.nullable().optional(), isActive: z.boolean().optional(), sortOrder: z.number().int().min(0).optional(),
});
/** The request field on an employee: a listed code, never free text. */
export const RankGradeCode = z.string({ error: 'Rank/Grade is required.' }).trim().toUpperCase()
  .pipe(z.string().min(1, 'Rank/Grade is required.').max(20));

/** A new choice must be a listed, active record. */
export async function assertActiveRankGrade(tx: DbClient, code: string) {
  const r = await tx.rankGrade.findUnique({ where: { code }, select: { isActive: true } });
  if (!r) throw unprocessable('RANK_GRADE_INVALID', `Not a listed Rank/Grade: ${code}`);
  if (!r.isActive) throw unprocessable('RANK_GRADE_INACTIVE', `The Rank/Grade ${code} is no longer in use — choose another`);
  return code;
}

/** Employees and credentials (the licence's classification) that use a code. */
async function usage(tx: DbClient, code: string) {
  const [employees, credentials] = await Promise.all([
    tx.employee.count({ where: { rankGradeCode: code } }),
    tx.credential.count({ where: { trackingData: { path: [CLASSIFICATION_FIELD_KEY], equals: code } } }),
  ]);
  return { employees, credentials };
}

export function createRankGradeService(db: Db) {
  async function assertSystemWide(tx: DbClient, auth: AuthContext) {
    if (!(await unitScope(tx, auth, HR_ROLES)).all) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'Only system-wide administrators can change the Rank/Grade master');
  }

  return {
    /** Sort order, then code. Search covers code, classification and meaning. */
    async list(q: z.infer<typeof RankGradeQuery>) {
      const search = q.q ? { OR: (['code', 'name', 'meaning'] as const).map((f) => ({ [f]: { contains: q.q, mode: 'insensitive' as const } })) } : {};
      const rows = await db.rankGrade.findMany({
        where: { ...(q.includeInactive ? {} : { isActive: true }), ...search },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        include: { _count: { select: { employees: true } } },
      });
      return { items: rows.map(({ _count, ...r }) => ({ ...r, employeeCount: _count.employees })) };
    },

    async create(auth: AuthContext, body: z.infer<typeof RankGradeCreateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        if (await tx.rankGrade.findUnique({ where: { code: body.code } })) throw conflict('RANK_GRADE_EXISTS', `A Rank/Grade with code ${body.code} already exists`);
        const r = await tx.rankGrade.create({ data: { ...body, meaning: body.meaning || null } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'RANK_GRADE_CREATED', resource: 'rank_grade', resourceId: r.code, changes: { after: body }, requestId });
        return r;
      });
    },

    async update(auth: AuthContext, code: string, body: z.infer<typeof RankGradeUpdateBody>, requestId?: string, expected: Date | null = null) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        await tx.$queryRaw`SELECT code FROM rank_grades WHERE code = ${code} FOR UPDATE`;
        const before = await tx.rankGrade.findUnique({ where: { code } });
        if (!before) throw notFound('Rank/Grade not found');
        assertUnchanged(expected, before);
        const r = await tx.rankGrade.update({ where: { code }, data: { ...body, ...(body.meaning !== undefined ? { meaning: body.meaning || null } : {}) } });
        const action = body.isActive === false && before.isActive ? 'RANK_GRADE_DEACTIVATED'
          : body.isActive === true && !before.isActive ? 'RANK_GRADE_REACTIVATED' : 'RANK_GRADE_UPDATED';
        const changed = Object.fromEntries(Object.keys(body).map((k) => [k, { from: (before as Record<string, unknown>)[k] ?? null, to: (body as Record<string, unknown>)[k] }]));
        await appendAudit(tx, { actorUserId: auth.user.id, action, resource: 'rank_grade', resourceId: code, changes: changed, requestId });
        return r;
      });
    },

    /** Deletes an unused record; one in use is refused with the counts (deactivate it instead). */
    async remove(auth: AuthContext, code: string, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        const before = await tx.rankGrade.findUnique({ where: { code } });
        if (!before) throw notFound('Rank/Grade not found');
        const used = await usage(tx, code);
        if (used.employees + used.credentials > 0) {
          throw conflict('RANK_GRADE_IN_USE', `This Rank/Grade is assigned to ${used.employees} employee(s) and ${used.credentials} licence(s): it cannot be deleted. Deactivate it instead.`, used);
        }
        await tx.rankGrade.delete({ where: { code } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'RANK_GRADE_DELETED', resource: 'rank_grade', resourceId: code, changes: { before }, requestId });
        return { code, deleted: true };
      });
    },
  };
}
