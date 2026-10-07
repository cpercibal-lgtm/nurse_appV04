// The levels are those of the MoH Ada'a indicator profiles
// (docs/reference/MOH_ADAA_NURSE_TO_BED_KPI.md, D-70).
import { describe, expect, it } from 'vitest';
import { computeKpiA, computeKpiB, monthPeriod, scoreArea } from './kpi.js';

describe('nurse-to-bed KPI', () => {
  it.each([
    ['ICU', 10, 10, 1], ['ICU', 5, 10, 2], ['ICU', 4, 12, 3], ['ICU', 2, 10, 4],
    ['ER', 5, 10, 1], ['ER', 3, 10, 2], ['ER', 1, 10, 4],
    ['OR', 20, 10, 1], ['OR', 10, 10, 2], ['OR', 5, 10, 3], ['OR', 2, 10, 4],
  ] as const)('%s with %i nurses and %i beds codes %i', (area, nurses, beds, code) => {
    expect(scoreArea(area, nurses, beds).code).toBe(code);
  });

  it('no nurses is the worst code, never a division error', () => {
    expect(scoreArea('ICU', 0, 10)).toMatchObject({ code: 4, band: 'Failed', ratioLabel: '—' });
  });

  it('KPI A averages the three codes', () => {
    const a = computeKpiA({ ICU: { nurses: 10, beds: 10 }, ER: { nurses: 3, beds: 10 }, OR: { nurses: 2, beds: 10 } });
    expect(a.averageCode).toBe(2.3);
    expect(a.band).toBe('Distress');
  });

  it.each([[100, 500, 'Standard'], [100, 650, 'Distress'], [100, 900, 'Failing'], [100, 901, 'Failed'], [0, 10, 'Failed']] as const)(
    'KPI B: %i nurses for %i beds is %s', (nurses, beds, band) => { expect(computeKpiB(nurses, beds).band).toBe(band); },
  );

  it('the card levels themselves get their own code', () => {
    // ICU 1:1 / 1:2 / 1:3 / 1:4, ER 1:2 / 1:3 / 1:4 / 1:5, OR 2:1 / 1:1 / 1:2 / 1:3
    expect([1, 2, 3, 4].map((bpn) => scoreArea('ICU', 10, 10 * bpn).code)).toEqual([1, 2, 3, 4]);
    expect([2, 3, 4, 5].map((bpn) => scoreArea('ER', 10, 10 * bpn).code)).toEqual([1, 2, 3, 4]);
    expect([[20, 10], [10, 10], [10, 20], [10, 30]].map(([n, b]) => scoreArea('OR', n!, b!).code)).toEqual([1, 2, 3, 4]);
  });

  it('a monthly average can be a fraction of a nurse', () => {
    expect(computeKpiB(40.5, 286)).toMatchObject({ nurses: 40.5, band: 'Failing', ratioLabel: '1:7.1' });
  });

  it.each([
    ['2026-09', '2026-10-07', '2026-09-01', '2026-09-30', 90],
    ['2026-10', '2026-10-07', '2026-10-01', '2026-10-07', 21],
    ['2026-02', '2026-10-07', '2026-02-01', '2026-02-28', 84],
    ['2028-02', '2026-10-07', '2028-02-01', '2028-02-29', 87],
    ['2026-12', '2026-12-31', '2026-12-01', '2026-12-31', 93],
  ])('month %s on %s covers %s to %s (%i shifts)', (month, today, from, to, shifts) => {
    expect(monthPeriod(month, today)).toEqual({ from, to, shifts });
  });
});
