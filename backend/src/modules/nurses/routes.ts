// Employee master endpoints (docs/API.md §2.5). Scope and field views are
// decided in the service; the route only checks the permission.

import { Router, type Response } from 'express';
import { z } from 'zod';
import { ifMatch } from '../../lib/concurrency.js';
import type { Db } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { ImportBody, type StaffImportService } from './staff-import.js';
import { AssignmentBody, AssignmentPreviewQuery, DeleteBody, ListQuery, OnboardBody, OwnContactBody, PositionBody, UpdateBody, type NurseService } from './service.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });

export function createNursesRouter(db: Db, nurses: NurseService, staffImport: StaffImportService) {
  const r = Router();
  const rid = (res: Response) => res.locals.requestId as string;

  r.get('/employees', authorize('employees.read'), async (req, res) => { res.json(await nurses.list(authOf(res), ListQuery.parse(req.query))); });
  r.get('/employees/me', async (_req, res) => { res.json(await nurses.me(authOf(res))); });
  // Own record only (D-35): no permission, the caller's employee id is the target.
  r.patch('/employees/me/contact', async (req, res) => { res.json(await nurses.updateOwnContact(authOf(res), OwnContactBody.parse(req.body), rid(res), ifMatch(req))); });
  r.get('/employees/onboarding-defaults', authorize('employees.write'), async (_req, res) => { res.json(await nurses.onboardingDefaults()); });
  r.post('/employees/onboard', authorize('employees.write'), idempotent(db, 'employees.onboard', async (req, res, tx) => {
    return { code: 201, body: await nurses.onboard(authOf(res), OnboardBody.parse(req.body), rid(res), tx) };
  }));
  // Staff import (D-72). Literal paths before /employees/:id. `check` writes nothing; the import is all or nothing.
  r.get('/employees/import/lists', authorize('employees.write'), async (_req, res) => { res.json(await staffImport.lists(authOf(res))); });
  r.post('/employees/import/check', authorize('employees.write'), async (req, res) => { res.json(await staffImport.check(authOf(res), ImportBody.parse(req.body))); });
  r.post('/employees/import', authorize('employees.write'), idempotent(db, 'employees.import', async (req, res, tx) => {
    return { code: 201, body: await staffImport.commit(authOf(res), ImportBody.parse(req.body), rid(res), tx) };
  }, { timeout: 120_000, maxWait: 10_000 }));
  // Own-or-scoped checks happen in the service.
  r.get('/employees/:id', async (req, res) => { res.json(await nurses.get(authOf(res), IdParam.parse(req.params).id)); });
  r.patch('/employees/:id', authorize('employees.write'), async (req, res) => {
    res.json(await nurses.update(authOf(res), IdParam.parse(req.params).id, UpdateBody.parse(req.body), rid(res), ifMatch(req)));
  });
  r.post('/employees/:id/position', authorize('employees.position'), async (req, res) => {
    res.json(await nurses.assignPosition(authOf(res), IdParam.parse(req.params).id, PositionBody.parse(req.body), rid(res)));
  });
  // Owner decision 2026-10-05: unit and position from the Nurses list (right-click); the preview changes nothing.
  r.get('/employees/:id/assignment/preview', authorize('employees.assign'), async (req, res) => {
    res.json(await nurses.previewAssignment(authOf(res), IdParam.parse(req.params).id, AssignmentPreviewQuery.parse(req.query)));
  });
  r.post('/employees/:id/assignment', authorize('employees.assign'), idempotent(db, 'employees.assign', async (req, res, tx) => {
    return { body: await nurses.assign(authOf(res), IdParam.parse(req.params).id, AssignmentBody.parse(req.body), rid(res), tx) };
  }));
  r.delete('/employees/:id', authorize('employees.write'), async (req, res) => {
    res.json(await nurses.remove(authOf(res), IdParam.parse(req.params).id, DeleteBody.parse(req.body).reason, rid(res)));
  });

  return r;
}
