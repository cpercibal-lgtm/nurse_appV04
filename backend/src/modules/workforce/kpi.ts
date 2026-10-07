// Nurse-to-bed KPIs (owner decisions D-11, D-70), as defined by the MoH Ada'a
// indicator profiles the owner supplied on 2026-10-07
// (docs/reference/MOH_ADAA_NURSE_TO_BED_KPI.md):
//   A. Nurse to Bed Ratio (Critical Areas) — ICU / ER / OR each coded 1..4, averaged.
//   B. Hospital's Nurse to Bed Ratio (Hospital-Wide), QFR-55.
//
// What is counted is hospital data that HR keeps on screen, never unit or position
// codes in this file:
//   positions.countsAsNurse   — only nurses count (the cards: "nurses on duty")
//   units.criticalArea        — which units are ICU / ER / OR (KPI A)
//   units.patientCareArea     — KPI B leaves out nurses in non-patient-care areas
//   units.inpatientBeds       — KPI B denominator: hospital operational beds
// The numerator is the average number of nurses on duty per shift: one shift, or
// every shift of a month (the cards report monthly).

import { z } from 'zod';
import { addDays, daysBetween, isIsoDate, riyadhDate, toDbDate } from '../../lib/dates.js';
import type { Db } from '../../lib/prisma.js';

export type Band = 'Standard' | 'Distress' | 'Failing' | 'Failed';
export type CriticalArea = 'ICU' | 'ER' | 'OR';

export const SOURCE = 'MoH Ada\'a indicator profiles "Nurse to Bed Ratio (Critical Areas)" and QFR-55 "Hospital\'s Nurse to Bed Ratio (Hospital-Wide)", supplied by the owner on 2026-10-07';

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The cards: final score 1–1.5 Standard, 1.5–2.5 Distress, 2.5–3.5 Failing, 3.5–4 Failed. */
function codeToBand(code: number): Band {
  if (code <= 1.5) return 'Standard';
  if (code <= 2.5) return 'Distress';
  if (code <= 3.5) return 'Failing';
  return 'Failed';
}

// The cards give one ratio per level (ICU 1:1 / 1:2 / 1:3 / 1:4, ER 1:2 / 1:3 / 1:4 / 1:5,
// OR 2:1 / 1:1 / 1:2 / 1:3); a ratio between two levels takes the nearer one.
// ICU/ER: beds per nurse (lower is better). OR: nurses per bed (higher is better).
function codeIcu(bpn: number): 1 | 2 | 3 | 4 { return bpn <= 1.5 ? 1 : bpn <= 2.5 ? 2 : bpn <= 3.5 ? 3 : 4; }
function codeEr(bpn: number): 1 | 2 | 3 | 4 { return bpn <= 2.5 ? 1 : bpn <= 3.5 ? 2 : bpn <= 4.5 ? 3 : 4; }
function codeOr(npb: number): 1 | 2 | 3 | 4 { return npb >= 1.5 ? 1 : npb >= 0.75 ? 2 : npb >= 0.417 ? 3 : 4; }

export interface AreaResult { area: CriticalArea; nurses: number; beds: number; code: 1 | 2 | 3 | 4; band: Band; ratioLabel: string }

export function scoreArea(area: CriticalArea, nurses: number, beds: number): AreaResult {
  const bpn = nurses > 0 ? beds / nurses : Infinity;
  const npb = beds > 0 ? nurses / beds : 0;
  const code = area === 'ICU' ? codeIcu(bpn) : area === 'ER' ? codeEr(bpn) : codeOr(npb);
  let ratioLabel = '—';
  if (nurses > 0 && beds > 0) ratioLabel = area === 'OR' && npb >= 1 ? `${round1(npb)}:1` : `1:${round1(bpn)}`;
  return { area, nurses: round1(nurses), beds, code, band: codeToBand(code), ratioLabel };
}

export function computeKpiA(input: Record<CriticalArea, { nurses: number; beds: number }>) {
  const areas = (['ICU', 'ER', 'OR'] as const).map((a) => scoreArea(a, input[a].nurses, input[a].beds));
  const averageCode = areas.reduce((s, a) => s + a.code, 0) / areas.length;
  return { areas, averageCode: round1(averageCode), band: codeToBand(averageCode) };
}

/** QFR-55: Standard 1:<6 · Distress 1:≥6–<7 · Failing 1:≥7–≤9 · Failed 1:>9. */
export function computeKpiB(nurses: number, beds: number) {
  const bpn = nurses > 0 ? beds / nurses : Infinity;
  const band: Band = bpn < 6 ? 'Standard' : bpn < 7 ? 'Distress' : bpn <= 9 ? 'Failing' : 'Failed';
  return { nurses: round1(nurses), beds, band, ratioLabel: nurses > 0 ? `1:${round1(bpn)}` : '—' };
}

const SHIFTS = ['Morning', 'Evening', 'Night'] as const;
/** One shift (`date` + `shift`) or one month (`month`, every shift of it). */
export const KpiQuery = z.union([
  z.object({ date: z.string().refine(isIsoDate, 'YYYY-MM-DD'), shift: z.enum(SHIFTS) }),
  z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM') }),
]);

/** A month's shifts: the whole month once it has ended, the month so far while it runs. */
export function monthPeriod(month: string, today: string) {
  const from = `${month}-01`;
  const end = addDays(`${addDays(from, 31).slice(0, 7)}-01`, -1); // day 31 is always in the next month
  const to = today >= from && today < end ? today : end;
  return { from, to, shifts: (daysBetween(from, to) + 1) * SHIFTS.length };
}

/** Nurses = Published assignments of nurse positions; beds = active units (bed counts as they are now). */
export async function nurseToBed(db: Db, q: z.infer<typeof KpiQuery>) {
  const period = 'month' in q
    ? { month: q.month, ...monthPeriod(q.month, riyadhDate()) }
    : { date: q.date, shift: q.shift, from: q.date, to: q.date, shifts: 1 };
  const [units, nursePositions, assignments] = await Promise.all([
    db.unit.findMany({ where: { isActive: true }, select: { id: true, code: true, bedCount: true, criticalArea: true, patientCareArea: true, inpatientBeds: true }, orderBy: { code: 'asc' } }),
    db.position.findMany({ where: { countsAsNurse: true }, select: { code: true }, orderBy: { displayOrder: 'asc' } }),
    db.shiftAssignment.groupBy({
      by: ['unitId'],
      where: {
        shiftDate: { gte: toDbDate(period.from), lte: toDbDate(period.to) },
        ...('shift' in period ? { shiftType: period.shift } : {}),
        status: 'Published',
        employee: { position: { countsAsNurse: true } },
      },
      _count: { _all: true },
    }),
  ]);
  // Average nurses on duty per shift, per unit.
  const onDuty = new Map(assignments.map((a) => [a.unitId, a._count._all / period.shifts]));
  const nursesIn = (list: typeof units) => list.reduce((s, u) => s + (onDuty.get(u.id) ?? 0), 0);
  const bedsIn = (list: typeof units) => list.reduce((s, u) => s + u.bedCount, 0);

  const areas = Object.fromEntries((['ICU', 'ER', 'OR'] as const).map((a) => {
    const mine = units.filter((u) => u.criticalArea === a);
    return [a, { nurses: nursesIn(mine), beds: bedsIn(mine) }];
  })) as Record<CriticalArea, { nurses: number; beds: number }>;
  const careUnits = units.filter((u) => u.patientCareArea);
  const bedUnits = units.filter((u) => u.inpatientBeds);

  return {
    period,
    kpiA: computeKpiA(areas),
    kpiB: computeKpiB(nursesIn(careUnits), bedsIn(bedUnits)),
    // What was counted, so the figures can be checked against the hospital's own.
    basis: {
      nursePositions: nursePositions.map((p) => p.code),
      areaUnits: Object.fromEntries(units.filter((u) => u.criticalArea).map((u) => [u.code, u.criticalArea!])),
      nonPatientCareUnits: units.filter((u) => !u.patientCareArea).map((u) => u.code),
      inpatientBedUnits: bedUnits.map((u) => u.code),
    },
    source: SOURCE,
  };
}
