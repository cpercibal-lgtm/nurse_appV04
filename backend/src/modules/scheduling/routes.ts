// Roster and attendance endpoints (docs/API.md §2.9, §2.10). Scope,
// home-unit and eligibility rules live in the services.

import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { Db } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { EventsQuery, GapsQuery, OwnEventsQuery, type AttendanceService } from '../attendance/service.js';
import { IngestBody, ingestEvents } from '../attendance/ingest.js';
import { HttpError } from '../../lib/http-errors.js';
import { ApprovalListQuery, ApprovalRequestBody, BoardQuery, CancelBody, CreateBody, DecideBody, GenerateBody, OwnQuery, PoolQuery, PublishBody, type SchedulingService } from './service.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });

/**
 * D-65: badge events come only from another system — an API client holding the
 * attendance.ingest scope. A person's token meets the `attendance.ingest`
 * permission, which no role holds (tagged for the route-matrix test).
 */
const badgeSystem: RequestHandler & { permission: 'attendance.ingest' } = Object.assign(((req, res, next) => {
  const client = res.locals.client;
  if (!client) return authorize('attendance.ingest')(req, res, next);
  if (!client.scopes.includes('attendance.ingest')) return next(new HttpError(403, 'FORBIDDEN', "This client's token does not grant attendance.ingest"));
  next();
}) as RequestHandler, { permission: 'attendance.ingest' as const });

export function createSchedulingRouter(db: Db, roster: SchedulingService, attendance: AttendanceService) {
  const r = Router();
  const rid = (res: Response) => res.locals.requestId as string;

  r.get('/roster', authorize('roster.read'), async (req, res) => { res.json(await roster.board(authOf(res), BoardQuery.parse(req.query))); });
  r.get('/roster/me', async (req, res) => { res.json(await roster.own(authOf(res), OwnQuery.parse(req.query))); });
  r.get('/roster/pool', authorize('roster.write'), async (req, res) => { res.json(await roster.pool(authOf(res), PoolQuery.parse(req.query))); });
  r.post('/roster/auto-generate', authorize('roster.write'), async (req, res) => {
    res.json(await roster.generate(authOf(res), GenerateBody.parse(req.body), rid(res)));
  });
  // D-71: the preparer asks, the Nursing Director decides, then the roster can be published.
  r.get('/roster/approvals', authorize('roster.read'), async (req, res) => { res.json(await roster.approvals(authOf(res), ApprovalListQuery.parse(req.query))); });
  r.post('/roster/approvals', authorize('roster.write'), async (req, res) => {
    res.status(201).json(await roster.requestApproval(authOf(res), ApprovalRequestBody.parse(req.body), rid(res)));
  });
  r.post('/roster/approvals/:id/decision', authorize('roster.approve'), async (req, res) => {
    res.json(await roster.decideApproval(authOf(res), IdParam.parse(req.params).id, DecideBody.parse(req.body), rid(res)));
  });
  r.post('/roster/publish', authorize('roster.publish'), idempotent(db, 'roster.publish', async (req, res, tx) => {
    return { body: await roster.publish(authOf(res), PublishBody.parse(req.body), rid(res), tx) };
  }, { timeout: 120_000 }));
  r.get('/coverage', authorize('roster.read'), async (req, res) => { res.json(await roster.coverage(authOf(res), BoardQuery.parse(req.query))); });
  r.post('/shift-assignments', authorize('roster.write'), async (req, res) => {
    res.status(201).json(await roster.create(authOf(res), CreateBody.parse(req.body), rid(res)));
  });
  r.delete('/shift-assignments/:id', authorize('roster.write'), async (req, res) => {
    res.json(await roster.remove(authOf(res), IdParam.parse(req.params).id, CancelBody.parse(req.body ?? {}).reason, rid(res)));
  });

  // Spec §14.2 (D-65): the badge system delivers clock events; idempotent, each event judged on its own.
  r.post('/attendance/events', badgeSystem, async (req, res) => {
    const { events } = IngestBody.parse(req.body);
    const result = await ingestEvents(db, events, `client:${res.locals.client!.clientId}`);
    res.json(result);
  });
  r.get('/attendance/events', authorize('attendance.read'), async (req, res) => { res.json(await attendance.events(authOf(res), EventsQuery.parse(req.query))); });
  r.get('/attendance/me', async (req, res) => { res.json(await attendance.own(authOf(res), OwnEventsQuery.parse(req.query))); });
  r.get('/attendance/gaps', authorize('attendance.read'), async (req, res) => { res.json(await attendance.gaps(authOf(res), GapsQuery.parse(req.query))); });

  return r;
}
