// Announcement endpoints (D-69, docs/API.md). Route gates come from permissions.ts;
// own-draft, recipient and scope rules live in the service.

import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Db } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { CancelBody, CreateBody, PeopleQuery, ReceivedQuery, SentQuery, UpdateBody, type AnnouncementService } from './service.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });

export function createAnnouncementsRouter(db: Db, announcements: AnnouncementService) {
  const r = Router();
  const rid = (res: Response) => res.locals.requestId as string;
  const id = (req: { params: unknown }) => IdParam.parse(req.params).id;

  // Reading: the board (addressed to me), my own, and — for managers — those in scope.
  r.get('/announcements', authorize('announcements.read'), async (req, res) => { res.json(await announcements.received(authOf(res), ReceivedQuery.parse(req.query))); });
  r.get('/announcements/sent', authorize('announcements.write'), async (req, res) => { res.json(await announcements.sent(authOf(res), SentQuery.parse(req.query))); });
  r.get('/announcements/managed', authorize('announcements.manage'), async (_req, res) => { res.json(await announcements.managed(authOf(res))); });
  r.get('/announcements/people', authorize('announcements.write'), async (req, res) => { res.json(await announcements.people(authOf(res), PeopleQuery.parse(req.query))); });
  r.get('/announcements/:id', authorize('announcements.read'), async (req, res) => { res.json(await announcements.get(authOf(res), id(req))); });

  // Drafts.
  r.post('/announcements', authorize('announcements.write'), async (req, res) => {
    res.status(201).json(await announcements.create(authOf(res), CreateBody.parse(req.body), rid(res)));
  });
  r.patch('/announcements/:id', authorize('announcements.write'), async (req, res) => {
    res.json(await announcements.update(authOf(res), id(req), UpdateBody.parse(req.body), rid(res)));
  });
  r.delete('/announcements/:id', authorize('announcements.write'), async (req, res) => { res.json(await announcements.remove(authOf(res), id(req), rid(res))); });
  r.post('/announcements/:id/preview', authorize('announcements.write'), async (req, res) => { res.json(await announcements.preview(authOf(res), id(req))); });

  // Sending: publishes or opens a four-eyes request; then cancel.
  r.post('/announcements/:id/submit', authorize('announcements.write'), idempotent(db, 'announcements.submit'), async (req, res) => {
    res.json(await announcements.submit(authOf(res), id(req), rid(res)));
  });
  r.post('/announcements/:id/cancel', authorize('announcements.write'), async (req, res) => {
    res.json(await announcements.cancel(authOf(res), id(req), CancelBody.parse(req.body).reason, rid(res)));
  });

  return r;
}
