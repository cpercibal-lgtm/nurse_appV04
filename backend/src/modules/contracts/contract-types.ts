// Employment contract types (owner decision 2026-10-03): one hospital-wide list,
// maintained on screen by system-wide HR and System Admins — directly, like
// positions, with every change audited. A type no contract uses is deleted; a
// used one is deactivated instead, so old contracts keep their meaning and new
// contracts can no longer choose it. Information only: no rule reads it.

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { assertUnchanged } from '../../lib/concurrency.js';
import { conflict, HttpError, notFound, unprocessable } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { HR_ROLES } from '../credentials/access.js';
import { unitScope, type AuthContext } from '../users/access.js';
import { Code, Name, NameAr } from '../workforce/org.js';

export const ContractTypeQuery = z.object({ includeInactive: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') });
export const ContractTypeCreateBody = z.strictObject({
  code: Code, name: Name, nameAr: NameAr.optional(), displayOrder: z.number().int().min(0).default(0),
});
export const ContractTypeUpdateBody = z.strictObject({
  name: Name.optional(), nameAr: NameAr.nullable().optional(), isActive: z.boolean().optional(), displayOrder: z.number().int().min(0).optional(),
});

/** Every new contract names a type that exists and is active; an inactive one is kept for old contracts only. */
export async function assertActiveContractType(tx: DbClient, code: string) {
  const t = await tx.contractType.findUnique({ where: { code }, select: { isActive: true } });
  if (!t) throw unprocessable('CONTRACT_TYPE_INVALID', `Unknown employment contract type: ${code}`);
  if (!t.isActive) throw unprocessable('CONTRACT_TYPE_INACTIVE', `The employment contract type ${code} is no longer in use — choose another`);
  return code;
}

/** The request field, shared by new contracts, renewals and onboarding. */
export const ContractTypeCode = z.string({ error: 'Employment Contract Type is required.' }).trim().min(1, 'Employment Contract Type is required.').max(20);

export function createContractTypeService(db: Db) {
  async function assertSystemWide(tx: DbClient, auth: AuthContext) {
    if (!(await unitScope(tx, auth, HR_ROLES)).all) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'Only system-wide administrators can change the employment contract types');
  }
  const usage = (tx: DbClient, code: string) => tx.contract.count({ where: { contractTypeCode: code } });

  return {
    /** Active types for the contract form; with includeInactive, all of them and how many contracts use each. */
    async list(q: z.infer<typeof ContractTypeQuery>) {
      const rows = await db.contractType.findMany({
        where: q.includeInactive ? {} : { isActive: true },
        orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
        include: { _count: { select: { contracts: true } } },
      });
      return { items: rows.map(({ _count, ...t }) => ({ ...t, contractCount: _count.contracts })) };
    },

    async create(auth: AuthContext, body: z.infer<typeof ContractTypeCreateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        if (await tx.contractType.findUnique({ where: { code: body.code } })) throw conflict('CONTRACT_TYPE_EXISTS', `A contract type with code ${body.code} already exists`);
        const t = await tx.contractType.create({ data: body });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'CONTRACT_TYPE_CREATED', resource: 'contract_type', resourceId: t.code, changes: body, requestId });
        return t;
      });
    },

    async update(auth: AuthContext, code: string, body: z.infer<typeof ContractTypeUpdateBody>, requestId?: string, expected: Date | null = null) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        await tx.$queryRaw`SELECT code FROM contract_types WHERE code = ${code} FOR UPDATE`;
        const before = await tx.contractType.findUnique({ where: { code } });
        if (!before) throw notFound('Contract type not found');
        assertUnchanged(expected, before);
        const t = await tx.contractType.update({ where: { code }, data: body });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'CONTRACT_TYPE_UPDATED', resource: 'contract_type', resourceId: code, changes: { before, after: body }, requestId });
        return t;
      });
    },

    /** Delete when unused; otherwise deactivate (owner decision 2026-10-03). */
    async remove(auth: AuthContext, code: string, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertSystemWide(tx, auth);
        const before = await tx.contractType.findUnique({ where: { code } });
        if (!before) throw notFound('Contract type not found');
        const used = await usage(tx, code);
        if (used === 0) {
          await tx.contractType.delete({ where: { code } });
          await appendAudit(tx, { actorUserId: auth.user.id, action: 'CONTRACT_TYPE_DELETED', resource: 'contract_type', resourceId: code, changes: { before }, requestId });
          return { code, outcome: 'DELETED' as const, contractCount: 0 };
        }
        if (before.isActive) {
          await tx.contractType.update({ where: { code }, data: { isActive: false } });
          await appendAudit(tx, { actorUserId: auth.user.id, action: 'CONTRACT_TYPE_DEACTIVATED', resource: 'contract_type', resourceId: code, changes: { before, contractCount: used }, requestId });
        }
        return { code, outcome: 'DEACTIVATED' as const, contractCount: used };
      });
    },
  };
}
export type ContractTypeService = ReturnType<typeof createContractTypeService>;
