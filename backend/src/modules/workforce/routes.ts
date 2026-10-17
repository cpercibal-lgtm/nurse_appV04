// Workforce: departments, units, bed capacity, positions, coverage targets and
// the nurse-to-bed KPI (docs/API.md §2.4; rules W1–W8).

import { Router, type Response } from 'express';
import { z } from 'zod';
import { ifMatch } from '../../lib/concurrency.js';
import type { Db } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { KpiQuery, nurseToBed } from './kpi.js';
import { listNationalities } from './nationalities.js';
import { createRankGradeService, RankGradeCreateBody, RankGradeQuery, RankGradeUpdateBody } from './rank-grades.js';
import { createSpecialtyService, SpecialtyCreateBody, SpecialtyQuery, SpecialtyUpdateBody } from './specialties.js';
import { CityCreateBody, CityUpdateBody, createLocationService, LocationQuery, RegionCreateBody, RegionUpdateBody } from './locations.js';
import { createFacilityService, FacilityCreateBody, FacilityQuery, FacilityUpdateBody } from './facilities.js';
import {
  BedCountBody, BulkBedsBody, CoverageBody, CoverageQuery, DepartmentCreateBody, DepartmentUpdateBody, ImportBody,
  PositionCreateBody, PositionUpdateBody, UnitCreateBody, UnitsQuery, UnitUpdateBody, type OrgService,
} from './org.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const CodeParam = z.object({ code: z.string().min(1).max(20) });
const InactiveQuery = z.object({ includeInactive: z.enum(['true', 'false']).default('false') });

export function createWorkforceRouter(db: Db, org: OrgService) {
  const r = Router();
  const rid = (res: Response) => res.locals.requestId as string;

  // ── Departments (W1) ──
  r.get('/departments', authorize('workforce.read'), async (req, res) => {
    res.json(await org.listDepartments(InactiveQuery.parse(req.query).includeInactive === 'true'));
  });
  r.post('/departments', authorize('workforce.write'), async (req, res) => {
    res.status(201).json(await org.createDepartment(authOf(res), DepartmentCreateBody.parse(req.body), rid(res)));
  });
  r.patch('/departments/:id', authorize('workforce.write'), async (req, res) => {
    res.json(await org.updateDepartment(authOf(res), IdParam.parse(req.params).id, DepartmentUpdateBody.parse(req.body), rid(res), ifMatch(req)));
  });

  // ── Units and beds (W2–W5). Literal paths before /units/:id. ──
  r.get('/units', authorize('workforce.read'), async (req, res) => { res.json(await org.listUnits(UnitsQuery.parse(req.query))); });
  r.get('/units/summary', authorize('workforce.read'), async (_req, res) => { res.json(await org.summary()); });
  r.put('/units/bed-capacity/bulk', authorize('workforce.write'), idempotent(db, 'units.beds.bulk', async (req, res, tx) => {
    return { body: await org.bulkBeds(authOf(res), BulkBedsBody.parse(req.body), rid(res), tx) };
  }, { timeout: 60_000 }));
  r.post('/units/import', authorize('workforce.write'), idempotent(db, 'units.import', async (req, res, tx) => {
    return { body: await org.importUnits(authOf(res), ImportBody.parse(req.body), rid(res), tx) };
  }, { timeout: 60_000 }));
  r.post('/units', authorize('workforce.write'), async (req, res) => {
    res.status(201).json(await org.createUnit(authOf(res), UnitCreateBody.parse(req.body), rid(res)));
  });
  r.patch('/units/:id', authorize('workforce.write'), async (req, res) => {
    res.json(await org.updateUnit(authOf(res), IdParam.parse(req.params).id, UnitUpdateBody.parse(req.body), rid(res), ifMatch(req)));
  });
  r.put('/units/:id/bed-capacity', authorize('workforce.write'), async (req, res) => {
    res.json(await org.setBedCount(authOf(res), IdParam.parse(req.params).id, BedCountBody.parse(req.body), rid(res), ifMatch(req)));
  });
  r.get('/units/:id/bed-history', authorize('workforce.bedHistory'), async (req, res) => {
    res.json(await org.bedHistory(authOf(res), IdParam.parse(req.params).id));
  });

  // ── Nationalities (owner decision 2026-10-03): fixed reference list ──
  r.get('/nationalities', authorize('workforce.read'), async (_req, res) => { res.json(await listNationalities(db)); });

  // ── Rank/Grade master (owner decision 2026-10-03): read by everyone, changed by system-wide HR/SA ──
  const rankGrades = createRankGradeService(db);
  r.get('/rank-grades', authorize('workforce.read'), async (req, res) => { res.json(await rankGrades.list(RankGradeQuery.parse(req.query))); });
  r.post('/rank-grades', authorize('workforce.write'), async (req, res) => {
    res.status(201).json(await rankGrades.create(authOf(res), RankGradeCreateBody.parse(req.body), rid(res)));
  });
  r.patch('/rank-grades/:code', authorize('workforce.write'), async (req, res) => {
    res.json(await rankGrades.update(authOf(res), CodeParam.parse(req.params).code.toUpperCase(), RankGradeUpdateBody.parse(req.body), rid(res), ifMatch(req)));
  });
  r.delete('/rank-grades/:code', authorize('workforce.write'), async (req, res) => {
    res.json(await rankGrades.remove(authOf(res), CodeParam.parse(req.params).code.toUpperCase(), rid(res)));
  });

  // ── Nursing Specialty master (owner decision 2026-10-03): read by everyone, changed by system-wide HR/SA ──
  const specialties = createSpecialtyService(db);
  r.get('/nursing-specialties', authorize('workforce.read'), async (req, res) => { res.json(await specialties.list(SpecialtyQuery.parse(req.query))); });
  r.post('/nursing-specialties', authorize('workforce.write'), async (req, res) => {
    res.status(201).json(await specialties.create(authOf(res), SpecialtyCreateBody.parse(req.body), rid(res)));
  });
  r.patch('/nursing-specialties/:code', authorize('workforce.write'), async (req, res) => {
    res.json(await specialties.update(authOf(res), CodeParam.parse(req.params).code.toUpperCase(), SpecialtyUpdateBody.parse(req.body), rid(res), ifMatch(req)));
  });
  r.delete('/nursing-specialties/:code', authorize('workforce.write'), async (req, res) => {
    res.json(await specialties.remove(authOf(res), CodeParam.parse(req.params).code.toUpperCase(), rid(res)));
  });

  // ── Saudi location master (owner decision 2026-10-03): regions and cities; read by everyone, changed by system-wide HR/SA ──
  const locations = createLocationService(db);
  const CityId = z.object({ id: z.coerce.number().int().positive() });
  r.get('/saudi-regions', authorize('workforce.read'), async (req, res) => { res.json(await locations.listRegions(LocationQuery.parse(req.query))); });
  r.post('/saudi-regions', authorize('workforce.write'), async (req, res) => {
    res.status(201).json(await locations.createRegion(authOf(res), RegionCreateBody.parse(req.body), rid(res)));
  });
  r.patch('/saudi-regions/:code', authorize('workforce.write'), async (req, res) => {
    res.json(await locations.updateRegion(authOf(res), CodeParam.parse(req.params).code.toUpperCase(), RegionUpdateBody.parse(req.body), rid(res), ifMatch(req)));
  });
  r.delete('/saudi-regions/:code', authorize('workforce.write'), async (req, res) => {
    res.json(await locations.removeRegion(authOf(res), CodeParam.parse(req.params).code.toUpperCase(), rid(res)));
  });
  r.get('/saudi-cities', authorize('workforce.read'), async (req, res) => { res.json(await locations.listCities(LocationQuery.parse(req.query))); });
  r.post('/saudi-cities', authorize('workforce.write'), async (req, res) => {
    res.status(201).json(await locations.createCity(authOf(res), CityCreateBody.parse(req.body), rid(res)));
  });
  r.patch('/saudi-cities/:id', authorize('workforce.write'), async (req, res) => {
    res.json(await locations.updateCity(authOf(res), CityId.parse(req.params).id, CityUpdateBody.parse(req.body), rid(res), ifMatch(req)));
  });
  r.delete('/saudi-cities/:id', authorize('workforce.write'), async (req, res) => {
    res.json(await locations.removeCity(authOf(res), CityId.parse(req.params).id, rid(res)));
  });

  // ── Facility master (owner decision 2026-10-03): read by everyone, changed by system-wide HR/SA ──
  const facilities = createFacilityService(db);
  const FacilityParam = z.object({ id: z.coerce.number().int().positive() });
  r.get('/facilities', authorize('workforce.read'), async (req, res) => { res.json(await facilities.list(FacilityQuery.parse(req.query))); });
  r.post('/facilities', authorize('workforce.write'), async (req, res) => {
    res.status(201).json(await facilities.create(authOf(res), FacilityCreateBody.parse(req.body), rid(res)));
  });
  r.patch('/facilities/:id', authorize('workforce.write'), async (req, res) => {
    res.json(await facilities.update(authOf(res), FacilityParam.parse(req.params).id, FacilityUpdateBody.parse(req.body), rid(res), ifMatch(req)));
  });
  r.delete('/facilities/:id', authorize('workforce.write'), async (req, res) => {
    res.json(await facilities.remove(authOf(res), FacilityParam.parse(req.params).id, rid(res)));
  });

  // ── Positions (§3.1.1, W6, W7) ──
  r.get('/positions', authorize('workforce.read'), async (req, res) => {
    res.json(await org.listPositions(InactiveQuery.parse(req.query).includeInactive === 'true'));
  });
  r.get('/positions/:code', authorize('workforce.read'), async (req, res) => { res.json(await org.getPosition(CodeParam.parse(req.params).code)); });
  r.post('/positions', authorize('workforce.write'), async (req, res) => {
    res.status(201).json(await org.createPosition(authOf(res), PositionCreateBody.parse(req.body), rid(res)));
  });
  r.patch('/positions/:code', authorize('workforce.write'), async (req, res) => {
    res.json(await org.updatePosition(authOf(res), CodeParam.parse(req.params).code, PositionUpdateBody.parse(req.body), rid(res), ifMatch(req)));
  });

  // ── Coverage targets (§6.3, W8) ──
  r.get('/coverage-targets', authorize('workforce.read'), async (req, res) => { res.json(await org.listCoverage(CoverageQuery.parse(req.query))); });
  r.put('/coverage-targets', authorize('workforce.write'), async (req, res) => {
    res.json(await org.setCoverage(authOf(res), CoverageBody.parse(req.body), rid(res)));
  });

  // ── KPI (D-11) ──
  r.get('/kpi/nurse-to-bed', authorize('kpi.read'), async (req, res) => { res.json(await nurseToBed(db, KpiQuery.parse(req.query))); });

  return r;
}
