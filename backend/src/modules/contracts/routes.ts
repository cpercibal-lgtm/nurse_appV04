// Contract endpoints (docs/API.md §2.6). The status map, scope and views
// live in the service.

import express, { Router, type Response } from 'express';
import { z } from 'zod';
import { ifMatch } from '../../lib/concurrency.js';
import type { Db } from '../../lib/prisma.js';
import { decodeFileName } from '../../lib/uploads.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { CreateBody, DateChangeBody, DateChangeDecisionBody, DatesBody, ListQuery, PickerQuery, RenewBody, TransitionBody, type ContractService } from './service.js';
import { fileHeaders, LinkBody } from '../documents/access.js';
import { ContractTypeCreateBody, ContractTypeQuery, ContractTypeUpdateBody, createContractTypeService } from './contract-types.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const DocParam = z.object({ id: z.coerce.number().int().positive(), docId: z.coerce.number().int().positive() });
const CodeParam = z.object({ code: z.string().trim().toUpperCase().max(20) });

export function createContractsRouter(db: Db, contracts: ContractService, maxUploadBytes: number) {
  const r = Router();
  const rid = (res: Response) => res.locals.requestId as string;
  const types = createContractTypeService(db);

  // Employment contract types (owner decision 2026-10-03): read with the contracts, changed by
  // system-wide contract managers (the service checks the scope). DELETE deactivates a used type.
  r.get('/contract-types', authorize('contracts.read'), async (req, res) => { res.json(await types.list(ContractTypeQuery.parse(req.query))); });
  r.post('/contract-types', authorize('contracts.manage'), async (req, res) => {
    res.status(201).json(await types.create(authOf(res), ContractTypeCreateBody.parse(req.body), rid(res)));
  });
  r.patch('/contract-types/:code', authorize('contracts.manage'), async (req, res) => {
    res.json(await types.update(authOf(res), CodeParam.parse(req.params).code, ContractTypeUpdateBody.parse(req.body), rid(res), ifMatch(req)));
  });
  r.delete('/contract-types/:code', authorize('contracts.manage'), async (req, res) => {
    res.json(await types.remove(authOf(res), CodeParam.parse(req.params).code, rid(res)));
  });

  r.get('/contracts', authorize('contracts.read'), async (req, res) => { res.json(await contracts.list(authOf(res), ListQuery.parse(req.query))); });
  r.get('/contracts/me', async (_req, res) => { res.json(await contracts.listOwn(authOf(res))); });
  r.get('/contracts/creatable', authorize('contracts.manage'), async (req, res) => { res.json(await contracts.creatable(authOf(res), PickerQuery.parse(req.query))); });
  r.get('/contracts/renewable', authorize('contracts.manage'), async (req, res) => { res.json(await contracts.renewable(authOf(res), PickerQuery.parse(req.query))); });
  r.post('/contracts', authorize('contracts.manage'), idempotent(db, 'contracts.create', async (req, res, tx) => {
    return { code: 201, body: await contracts.create(authOf(res), CreateBody.parse(req.body), rid(res), tx) };
  }));
  r.get('/contracts/:id', async (req, res) => { res.json(await contracts.get(authOf(res), IdParam.parse(req.params).id)); });
  r.post('/contracts/:id/renew', authorize('contracts.manage'), idempotent(db, 'contracts.renew', async (req, res, tx) => {
    return { code: 201, body: await contracts.renew(authOf(res), IdParam.parse(req.params).id, RenewBody.parse(req.body ?? {}), rid(res), tx) };
  }));
  // Draft only (owner request 2026-10-15); If-Match = the contract's updatedAt.
  r.patch('/contracts/:id/dates', authorize('contracts.manage'), async (req, res) => {
    res.json(await contracts.updateDates(authOf(res), IdParam.parse(req.params).id, DatesBody.parse(req.body), rid(res), ifMatch(req)));
  });
  // Approved or Active (owner request 2026-10-15): a request another HR administrator decides; If-Match = updatedAt.
  r.post('/contracts/:id/date-change', authorize('contracts.manage'), async (req, res) => {
    res.status(201).json(await contracts.requestDateChange(authOf(res), IdParam.parse(req.params).id, DateChangeBody.parse(req.body), rid(res), ifMatch(req)));
  });
  r.post('/contracts/:id/date-change/decision', authorize('contracts.manage'), async (req, res) => {
    res.json(await contracts.decideDateChange(authOf(res), IdParam.parse(req.params).id, DateChangeDecisionBody.parse(req.body), rid(res)));
  });
  r.post('/contracts/:id/transition', authorize('contracts.manage'), async (req, res) => {
    res.json(await contracts.transition(authOf(res), IdParam.parse(req.params).id, TransitionBody.parse(req.body), rid(res)));
  });

  // Contract copy: raw PDF body, name in X-File-Name (same as credential evidence).
  r.post('/contracts/:id/documents', authorize('contracts.manage'), express.raw({ type: () => true, limit: maxUploadBytes + 1 }), async (req, res) => {
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    res.status(201).json(await contracts.upload(authOf(res), IdParam.parse(req.params).id, bytes, req.get('content-type'), decodeFileName(req.get('x-file-name')), rid(res)));
  });
  r.get('/contracts/:id/documents', async (req, res) => { res.json(await contracts.listDocuments(authOf(res), IdParam.parse(req.params).id)); });
  r.get('/contracts/:id/documents/:docId', async (req, res) => {
    const { id, docId } = DocParam.parse(req.params);
    const file = await contracts.download(authOf(res), id, docId, rid(res));
    res.set(fileHeaders(file, false)).send(file.bytes);
  });
  // D-53: a 60-second single-use link, redeemed at GET /api/v1/files/:token (opens in a browser tab).
  r.post('/contracts/:id/documents/:docId/link', async (req, res) => {
    const { id, docId } = DocParam.parse(req.params);
    const { inline } = LinkBody.parse(req.body ?? {});
    res.status(201).json(await contracts.link(authOf(res), id, docId, inline, rid(res)));
  });

  return r;
}
