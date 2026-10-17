import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, type Db } from '../src/lib/prisma.js';
import { idempotent } from '../src/middleware/idempotency.js';
import { errorHandler } from '../src/middleware/errors.js';
import { HttpError } from '../src/lib/http-errors.js';
import { sha256hex } from '../src/lib/tokens.js';
import { makeUser, openDb, signIn, testApp, TEST_URL, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
describeDb('atomic idempotency', () => {
  let db: Db;
  let actorUserId: number;
  beforeAll(async () => { db = openDb(); actorUserId = (await makeUser(db)).id; });
  afterAll(async () => { await db.$disconnect(); });

  function appFor(client: Db, execute: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.auth = { user: { id: actorUserId, email: 'test@example.test', displayName: 'Test', employeeId: null, isBreakGlass: false },
        sessionFamily: 'test', csrfHash: '', grants: [], effective: [], pam: null, breakGlass: null };
      next();
    });
    app.post('/write', idempotent(client, 'test.write', async (_req, _res, tx) => ({ code: 201, body: await execute(tx) })));
    app.use(errorHandler);
    return app;
  }
  const post = (app: express.Express, key: string) => request(app).post('/write').set('Idempotency-Key', key).send({ value: 1 });

  it('replays client errors without preserving preceding business writes', async () => {
    const code = uniq('rejected');
    const app = appFor(db, async (tx) => {
      await tx.department.create({ data: { code, name: 'rejected' } });
      throw new HttpError(422, 'REJECTED', 'Rejected');
    });
    const key = randomUUID();
    expect((await post(app, key)).status).toBe(422);
    const retry = await post(app, key);
    expect(retry.status).toBe(422);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(await db.department.count({ where: { code } })).toBe(0);
  });

  it('recovers an aborted PostgreSQL transaction to save a constraint-error replay', async () => {
    const existing = await db.department.create({ data: { code: uniq('existing'), name: 'existing' } });
    const code = uniq('preceding');
    let attempts = 0;
    const app = appFor(db, async (tx) => {
      attempts++;
      await tx.department.create({ data: { code, name: 'must roll back' } });
      return tx.department.create({ data: { code: existing.code, name: 'duplicate' } });
    });
    const key = randomUUID();
    const first = await post(app, key);
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe('DUPLICATE');
    expect(await db.department.count({ where: { code } })).toBe(0);
    const retry = await post(app, key);
    expect(retry.status).toBe(409);
    expect(retry.body).toEqual(first.body);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(attempts).toBe(1);
  });

  it.each(['PROCESSING', 'FAILED'] as const)('does not repeat an uncertain %s outcome from the old middleware', async (status) => {
    const key = randomUUID();
    await db.idempotencyKey.create({ data: { key, actorUserId, operation: 'test.write', requestPath: '/write',
      requestHash: sha256hex('POST /write\n{"value":1}'), status, processingLeaseExpiresAt: new Date(0), expiresAt: new Date(Date.now() + 3600000) } });
    let writes = 0;
    const app = appFor(db, async () => ({ id: ++writes }));
    expect((await post(app, key)).status).toBe(409);
    expect(writes).toBe(0);
  });

  it('rolls back the business write when saving the response fails, then retries once', async () => {
    let fail = true;
    const client = db.$extends({ query: { idempotencyKey: { async update({ args, query }) {
      if (fail) { fail = false; throw new Error('injected response storage failure'); }
      return query(args);
    } } } }) as Db;
    const code = uniq('atomic');
    const app = appFor(client, (tx) => tx.department.create({ data: { code, name: 'atomic' }, select: { id: true } }));
    const key = randomUUID();
    expect((await post(app, key)).status).toBe(500);
    expect(await db.department.count({ where: { code } })).toBe(0);
    const retry = await post(app, key);
    expect(retry.status).toBe(201);
    expect((await post(app, key)).body).toEqual(retry.body);
    expect(await db.department.count({ where: { code } })).toBe(1);
  });

  it('rolls back writes preceding a handler failure and allows the same key to retry', async () => {
    let fail = true;
    const code = uniq('rollback');
    const app = appFor(db, async (tx) => {
      const out = await tx.department.create({ data: { code, name: 'rollback' }, select: { id: true } });
      if (fail) { fail = false; throw new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: '7' }); }
      return out;
    });
    const key = randomUUID();
    expect((await post(app, key)).status).toBe(503);
    expect(await db.department.count({ where: { code } })).toBe(0);
    expect((await post(app, key)).status).toBe(201);
  });

  it('rolls back account creation through the real protected route when replay storage fails', async () => {
    const hr = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    let fail = true;
    const client = db.$extends({ query: { idempotencyKey: { async update({ args, query }) {
      if (fail) { fail = false; throw new Error('injected response storage failure'); }
      return query(args);
    } } } }) as Db;
    const session = await signIn(testApp(client), hr.email);
    const email = `${uniq('atomic')}@test.aigh.sa`;
    const key = randomUUID();
    const create = () => session.post('/users', { email, displayName: 'Atomic account', password: 'initial-password-123' }).set('Idempotency-Key', key);
    expect((await create()).status).toBe(500);
    expect(await db.user.count({ where: { email } })).toBe(0);
    const retry = await create();
    expect(retry.status).toBe(201);
    expect((await create()).body).toEqual(retry.body);
    expect(await db.user.count({ where: { email } })).toBe(1);
  });

  it('excludes a concurrent request even when the legacy processing lease is expired', async () => {
    const key = randomUUID();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let writes = 0;
    const app = appFor(db, async () => { const id = ++writes; entered(); await waiting; return { id }; });
    const first = post(app, key).then((response) => response);
    await started;
    try {
      await db.idempotencyKey.updateMany({ where: { key, actorUserId }, data: { processingLeaseExpiresAt: new Date(0) } });
      expect((await post(app, key).timeout(2000)).status).toBe(409);
    } finally { release(); await first; }
    const replay = await post(app, key);
    expect(replay.body).toEqual({ id: 1 });
    expect(writes).toBe(1);
  });
});
