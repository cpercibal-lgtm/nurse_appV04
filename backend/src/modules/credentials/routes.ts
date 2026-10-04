import express, { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../lib/http-errors.js';
import { decodeFileName } from '../../lib/uploads.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { EvaluateQuery, StateQuery, WaiverBody, WaiverQuery, type createEligibilityService } from '../eligibility/service.js';
import {
  CategoryCreateBody, CategoryParam, CategoryUpdateBody, RequirementBody, RequirementBulkBody, RequirementQuery, RequirementUpdateBody, TemplateCreateBody, TemplateUpdateBody, type CatalogService,
} from './catalog.js';
import { ApproveRenewalBody, DecisionBody, ListQuery, RecordBody, RenewalBody, SelfRecordBody, VerifyBody, type RecordService } from './records.js';
import { fileHeaders, LinkBody } from '../documents/access.js';
import type { ScfhsService } from './scfhs.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const DocParam = z.object({ id: z.coerce.number().int().positive(), docId: z.coerce.number().int().positive() });

/** Credentials, requirements, eligibility and waivers (spec §5, §6.1). */
export function createCredentialsRouter(catalog: CatalogService, records: RecordService, eligibility: ReturnType<typeof createEligibilityService>, maxUploadBytes: number, scfhs: ScfhsService) {
  const r = Router();
  const rid = (res: express.Response) => res.locals.requestId as string;

  // ── Catalog (§5.1.1–5.1.3) ────────────────────────────────────────────────
  r.get('/credential-categories', authorize('credentials.catalog.read'), async (_req, res) => { res.json({ items: await catalog.listCategories() }); });
  r.post('/credential-categories', authorize('credentials.catalog.write'), async (req, res) => {
    const out = await catalog.createCategory(authOf(res), CategoryCreateBody.parse(req.body), rid(res));
    res.status(out.status === 'PENDING_APPROVAL' ? 202 : 201).json(out);
  });
  r.patch('/credential-categories/:code', authorize('credentials.catalog.write'), async (req, res) => {
    const out = await catalog.updateCategory(authOf(res), CategoryParam.parse(req.params).code, CategoryUpdateBody.parse(req.body), rid(res));
    res.status(out.status === 'PENDING_APPROVAL' ? 202 : 200).json(out);
  });
  r.get('/credential-templates', authorize('credentials.catalog.read'), async (req, res) => {
    res.json({ items: await catalog.listTemplates(req.query.includeInactive === 'true') });
  });
  r.post('/credential-templates', authorize('credentials.catalog.write'), async (req, res) => {
    const out = await catalog.createTemplate(authOf(res), TemplateCreateBody.parse(req.body), rid(res));
    res.status(out.status === 'PENDING_APPROVAL' ? 202 : 201).json(out);
  });
  r.patch('/credential-templates/:id', authorize('credentials.catalog.write'), async (req, res) => {
    const out = await catalog.updateTemplate(authOf(res), IdParam.parse(req.params).id, TemplateUpdateBody.parse(req.body), rid(res));
    res.status(out.status === 'PENDING_APPROVAL' ? 202 : 200).json(out);
  });

  // ── Requirements (§5.1.4) ─────────────────────────────────────────────────
  r.get('/credential-requirements', authorize('requirements.read'), async (req, res) => { res.json(await catalog.listRequirements(authOf(res), RequirementQuery.parse(req.query))); });
  r.post('/credential-requirements', authorize('requirements.write'), async (req, res) => {
    res.status(201).json(await catalog.createRequirement(authOf(res), RequirementBody.parse(req.body), rid(res)));
  });
  r.post('/credential-requirements/bulk', authorize('requirements.write'), async (req, res) => {
    res.json(await catalog.bulkSetRequirements(authOf(res), RequirementBulkBody.parse(req.body).items, rid(res)));
  });
  r.put('/credential-requirements/:id', authorize('requirements.write'), async (req, res) => {
    res.json(await catalog.updateRequirement(authOf(res), IdParam.parse(req.params).id, RequirementUpdateBody.parse(req.body), rid(res)));
  });
  r.delete('/credential-requirements/:id', authorize('requirements.write'), async (req, res) => {
    res.json(await catalog.deleteRequirement(authOf(res), IdParam.parse(req.params).id, rid(res)));
  });

  // ── Own credentials (self-service, §8.1 Employee column) ──────────────────
  r.get('/credentials/me', authorize('credentials.self'), async (_req, res) => { res.json(await records.listOwn(authOf(res))); });
  r.get('/credentials/me/requirements', authorize('credentials.self'), async (_req, res) => { res.json(await records.ownRequirements(authOf(res))); });
  r.post('/credentials/me', authorize('credentials.self'), async (req, res) => {
    const auth = authOf(res);
    if (auth.user.employeeId === null) throw new HttpError(403, 'NO_EMPLOYEE_RECORD', 'Your account is not linked to an employee record');
    const created = await records.record(auth, { ...SelfRecordBody.parse(req.body), employeeId: auth.user.employeeId }, true, rid(res));
    // Spec §5.4: checked with SCFHS on submission; the nurse sees only that it was recorded.
    await scfhs.check(created.id, 'ON_SUBMIT', auth.user.id, rid(res));
    res.status(201).json(created);
  });

  // ── Records and lifecycle (§5.1.5, §5.2) ──────────────────────────────────
  r.get('/credentials', authorize('credentials.read'), async (req, res) => { res.json(await records.list(authOf(res), ListQuery.parse(req.query), rid(res))); });
  r.post('/credentials', authorize('credentials.manage'), async (req, res) => {
    const auth = authOf(res);
    const created = await records.record(auth, RecordBody.parse(req.body), false, rid(res));
    res.status(201).json({ ...created, scfhs: await scfhs.check(created.id, 'ON_SUBMIT', auth.user.id, rid(res)) });
  });
  // Own-or-scoped checks happen in the service, so these accept any signed-in user.
  r.get('/credentials/:id', async (req, res) => { res.json(await records.get(authOf(res), IdParam.parse(req.params).id)); });
  r.post('/credentials/:id/verify', authorize('credentials.manage'), async (req, res) => {
    res.json(await records.verify(authOf(res), IdParam.parse(req.params).id, VerifyBody.parse(req.body ?? {}), rid(res)));
  });
  // Spec §5.4 (D-64): check with SCFHS now, and the history of checks. HR within scope.
  r.post('/credentials/:id/scfhs-check', authorize('credentials.manage'), async (req, res) => {
    const auth = authOf(res);
    const { id } = IdParam.parse(req.params);
    await scfhs.assertHr(auth, id);
    const result = await scfhs.check(id, 'MANUAL', auth.user.id, rid(res));
    if (!result.checked) throw new HttpError(422, `SCFHS_${result.skipped}`, result.skipped === 'NOT_ENABLED'
      ? 'This credential type is not checked with SCFHS' : result.skipped === 'ERASED' ? 'The registration number was erased (data-subject request)' : 'No SCFHS registration number is recorded on this credential');
    res.json({ ...result, driver: scfhs.driver });
  });
  r.get('/credentials/:id/scfhs-checks', authorize('credentials.manage'), async (req, res) => {
    const auth = authOf(res);
    const { id } = IdParam.parse(req.params);
    await scfhs.assertHr(auth, id);
    res.json({ items: await scfhs.history(id), driver: scfhs.driver });
  });
  r.post('/credentials/:id/suspend', authorize('credentials.manage'), async (req, res) => {
    res.json(await records.decide(authOf(res), IdParam.parse(req.params).id, 'Suspended', DecisionBody.parse(req.body).reason, rid(res)));
  });
  r.post('/credentials/:id/revoke', authorize('credentials.manage'), async (req, res) => {
    res.json(await records.decide(authOf(res), IdParam.parse(req.params).id, 'Revoked', DecisionBody.parse(req.body).reason, rid(res)));
  });
  r.post('/credentials/:id/renewal', async (req, res) => {
    res.json(await records.stageRenewal(authOf(res), IdParam.parse(req.params).id, RenewalBody.parse(req.body), rid(res)));
  });
  r.post('/credentials/:id/renewal/approve', authorize('credentials.manage'), async (req, res) => {
    res.json(await records.approveRenewal(authOf(res), IdParam.parse(req.params).id, ApproveRenewalBody.parse(req.body ?? {}), rid(res)));
  });
  r.post('/credentials/:id/renewal/reject', authorize('credentials.manage'), async (req, res) => {
    res.json(await records.rejectRenewal(authOf(res), IdParam.parse(req.params).id, DecisionBody.parse(req.body).reason, rid(res)));
  });

  // ── Evidence (§5.1.5, D1–D5). The body is the raw file; the name travels in X-File-Name. ─
  r.post('/credentials/:id/documents', express.raw({ type: () => true, limit: maxUploadBytes + 1 }), async (req, res) => {
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    res.status(201).json(await records.upload(authOf(res), IdParam.parse(req.params).id, bytes, req.get('content-type'), decodeFileName(req.get('x-file-name')), rid(res)));
  });
  r.get('/credentials/:id/documents', async (req, res) => { res.json(await records.listDocuments(authOf(res), IdParam.parse(req.params).id)); });
  r.get('/credentials/:id/documents/:docId', async (req, res) => {
    const { id, docId } = DocParam.parse(req.params);
    const file = await records.download(authOf(res), id, docId, rid(res));
    res.set(fileHeaders(file, false)).send(file.bytes);
  });
  // D-53: a 60-second single-use link, redeemed at GET /api/v1/files/:token (opens in a browser tab).
  r.post('/credentials/:id/documents/:docId/link', async (req, res) => {
    const { id, docId } = DocParam.parse(req.params);
    const { inline } = LinkBody.parse(req.body ?? {});
    res.status(201).json(await records.link(authOf(res), id, docId, inline, rid(res)));
  });

  // ── Eligibility (§6.1) and waivers (§6.1.2) ───────────────────────────────
  r.get('/eligibility', authorize('eligibility.read'), async (req, res) => { res.json(await eligibility.listStates(authOf(res), StateQuery.parse(req.query))); });
  r.get('/eligibility/me', async (_req, res) => {
    const auth = authOf(res);
    if (auth.user.employeeId === null) throw new HttpError(404, 'NOT_FOUND', 'Your account is not linked to an employee record');
    res.json(await eligibility.getState(auth, auth.user.employeeId));
  });
  r.get('/eligibility/:id', async (req, res) => { res.json(await eligibility.getState(authOf(res), IdParam.parse(req.params).id)); });
  r.get('/eligibility/:id/evaluate', authorize('eligibility.read'), async (req, res) => {
    res.json(await eligibility.evaluate(authOf(res), IdParam.parse(req.params).id, EvaluateQuery.parse(req.query).date));
  });
  r.post('/eligibility/:id/refresh', authorize('credentials.manage'), async (req, res) => {
    res.json(await eligibility.refresh(authOf(res), IdParam.parse(req.params).id, rid(res)));
  });
  r.get('/waivers', authorize('waivers.read'), async (req, res) => { res.json(await eligibility.listWaivers(authOf(res), WaiverQuery.parse(req.query))); });
  r.post('/waivers', authorize('waivers.write'), async (req, res) => {
    res.status(201).json(await eligibility.createWaiver(authOf(res), WaiverBody.parse(req.body), rid(res)));
  });

  return r;
}
