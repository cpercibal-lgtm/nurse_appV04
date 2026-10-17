// Business writes and replay data commit together. PostgreSQL owns the lock's
// lifetime, so a slow request cannot lose ownership to an expired wall-clock lease.
import type { Request, Response, RequestHandler } from 'express';
import { Prisma, type Db } from '../lib/prisma.js';
import { HttpError } from '../lib/http-errors.js';
import { sha256hex } from '../lib/tokens.js';
import { authOf } from './authorize.js';
import { toHttpError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETENTION_MS = 24 * 3600_000;
type Outcome = { code?: number; body: unknown };
type Execute = (req: Request, res: Response, tx: Prisma.TransactionClient) => Promise<Outcome>;

export function idempotent(db: Db, operation: string, execute: Execute, options?: { timeout?: number; maxWait?: number }): RequestHandler {
  return async (req, res) => {
    const key = req.get('idempotency-key') ?? '';
    if (!UUID.test(key)) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header (UUID) is required');
    const actorUserId = authOf(res).user.id;
    const requestHash = sha256hex(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? null)}`);
    const result = await db.$transaction(async (tx) => {
      const lock = `idempotency:${actorUserId}:${key.toLowerCase()}`;
      const [locked] = await tx.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${lock}, 0)) AS acquired`;
      if (!locked?.acquired) throw new HttpError(409, 'IDEMPOTENCY_IN_PROGRESS', 'This request is already being processed');
      const existing = await tx.idempotencyKey.findUnique({ where: { key_actorUserId: { key, actorUserId } } });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
        if (existing.status === 'COMPLETED' && existing.responseCode !== null) {
          return { code: existing.responseCode, body: existing.responseBody, replayed: true };
        }
        // Only the previous implementation can leave an incomplete committed row.
        // Its business transaction may have committed; never repeat an uncertain write.
        throw new HttpError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The previous outcome needs reconciliation before this request can be repeated');
      }
      const row = existing ?? await tx.idempotencyKey.create({ data: {
        key, actorUserId, operation, requestPath: req.originalUrl, requestHash,
        status: 'PROCESSING', expiresAt: new Date(Date.now() + RETENTION_MS),
      } });
      await tx.$executeRawUnsafe('SAVEPOINT idempotent_operation');
      let outcome: Outcome;
      try {
        outcome = await execute(req, res, tx);
      } catch (error) {
        const mapped = toHttpError(error);
        if (mapped.status >= 500) throw error;
        // A rejected operation must not commit partial writes. Preserve its 4xx
        // replay response, including database constraint errors that abort SQL.
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT idempotent_operation');
        outcome = { code: mapped.status, body: mapped.toBody() };
        res.locals.errorCode = mapped.code;
      }
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT idempotent_operation');
      const { code = 200, body } = outcome;
      if (code >= 500) throw new HttpError(code, 'INTERNAL_ERROR', 'Internal server error');
      // Store precisely the JSON representation that will be sent (including Date serialization).
      const serialized = JSON.stringify(body);
      const responseBody = JSON.parse(serialized) as Prisma.InputJsonValue;
      await tx.idempotencyKey.update({ where: { id: row.id }, data: {
        status: 'COMPLETED', responseCode: code, responseBody, responseHash: sha256hex(serialized),
        completedAt: new Date(), processingLeaseExpiresAt: null,
      } });
      return { code, body: responseBody, replayed: false };
    }, options);
    if (result.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(result.code).json(result.body);
  };
}
