import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../services/http';
import type { Paged } from '../../types/api';

export type ShiftType = 'Morning' | 'Evening' | 'Night';
export const SHIFTS: ShiftType[] = ['Morning', 'Evening', 'Night'];

export interface DepartmentRow { id: number; code: string; name: string; nameAr: string | null; description: string | null; isActive: boolean }
export type CriticalArea = 'ICU' | 'ER' | 'OR';
export interface UnitRow { id: number; code: string; name: string; nameAr: string | null; description: string | null; departmentId: number; bedCount: number; criticalArea: CriticalArea | null; patientCareArea: boolean; inpatientBeds: boolean; isActive: boolean }
export interface PositionRow { code: string; title: string; titleAr: string | null; tier: string; description: string | null; isSchedulable: boolean; countsAsNurse: boolean; isActive: boolean; displayOrder: number; replacedBy: string | null }
export interface CoverageTarget { id: number; unitId: number; shiftType: ShiftType; minimumStaff: number }
export interface BedLog { id: number; previousCount: number; newCount: number; reason: string; changedAt: string; changedBy: string | null }
export interface Summary { unitCount: number; totalBeds: number; byDepartment: Array<{ id: number; code: string; name: string; units: number; beds: number }> }
export interface ImportResult {
  dryRun: boolean; created: number; updated: number; unchanged: number; rejected: number;
  results: Array<{ line: number; unitCode: string; status: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED'; reason?: string }>;
}
export type Band = 'Standard' | 'Distress' | 'Failing' | 'Failed';
export interface Kpi {
  period: { date?: string; shift?: ShiftType; month?: string; from: string; to: string; shifts: number };
  source: string;
  basis: { nursePositions: string[]; areaUnits: Record<string, string>; nonPatientCareUnits: string[]; inpatientBedUnits: string[] };
  kpiA: { averageCode: number; band: Band; areas: Array<{ area: string; nurses: number; beds: number; code: number; band: Band; ratioLabel: string }> };
  kpiB: { nurses: number; beds: number; band: Band; ratioLabel: string };
}

export const TIERS = ['Executive', 'Administrative', 'Management', 'Specialist', 'Advanced Practice', 'Clinical Lead', 'Clinical', 'Clinical Specialist', 'Support'];

export const useAllDepartments = () => useQuery({ queryKey: ['departments', 'all'], queryFn: () => http.get<Paged<DepartmentRow>>('/departments?includeInactive=true') });
export const useAllUnits = () => useQuery({ queryKey: ['units', 'all'], queryFn: () => http.get<Paged<UnitRow>>('/units?includeInactive=true') });
export const usePositions = (includeInactive = false) => useQuery({ queryKey: ['positions', includeInactive], queryFn: () => http.get<Paged<PositionRow>>(`/positions${includeInactive ? '?includeInactive=true' : ''}`) });
export const useSummary = () => useQuery({ queryKey: ['units', 'summary'], queryFn: () => http.get<Summary>('/units/summary') });
export const useCoverage = () => useQuery({ queryKey: ['coverage'], queryFn: () => http.get<Paged<CoverageTarget>>('/coverage-targets') });
export const useBedHistory = (unitId: number | null) => useQuery({
  queryKey: ['bed-history', unitId], enabled: unitId !== null, queryFn: () => http.get<Paged<BedLog>>(`/units/${unitId}/bed-history`),
});
/** One shift, or one month (the MoH Ada'a cards report monthly). */
export type KpiPeriod = { date: string; shift: ShiftType } | { month: string };
export const useKpi = (p: KpiPeriod) => useQuery({
  queryKey: ['kpi', p],
  queryFn: () => http.get<Kpi>(`/kpi/nurse-to-bed?${'month' in p ? `month=${p.month}` : `date=${p.date}&shift=${p.shift}`}`),
});

type Action =
  | { kind: 'department'; id?: number; body: object }
  | { kind: 'unit'; id?: number; body: object }
  | { kind: 'beds'; id: number; bedCount: number; reason: string }
  | { kind: 'import'; csv: string; dryRun: boolean }
  | { kind: 'position'; code?: string; body: object }
  | { kind: 'coverage'; unitId: number; shiftType: ShiftType; minimumStaff: number | null };

export function useWorkforceAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: Action): Promise<unknown> => {
      switch (a.kind) {
        case 'department': return a.id ? http.patch(`/departments/${a.id}`, a.body) : http.post('/departments', a.body);
        case 'unit': return a.id ? http.patch(`/units/${a.id}`, a.body) : http.post('/units', a.body);
        case 'beds': return http.put(`/units/${a.id}/bed-capacity`, { bedCount: a.bedCount, reason: a.reason });
        case 'import': return http.post<ImportResult>('/units/import', { csv: a.csv, dryRun: a.dryRun }, { idempotencyKey: crypto.randomUUID() });
        case 'position': return a.code ? http.patch(`/positions/${a.code}`, a.body) : http.post('/positions', a.body);
        case 'coverage': return http.put('/coverage-targets', { unitId: a.unitId, shiftType: a.shiftType, minimumStaff: a.minimumStaff });
      }
    },
    onSuccess: () => Promise.all(['departments', 'units', 'positions', 'coverage', 'bed-history', 'eligibility'].map((k) => qc.invalidateQueries({ queryKey: [k] }))),
  });
}

/** Rank/Grade master (owner decision 2026-10-03): the SCFHS nursing classification; employeeCount = employees holding it. */
export interface RankGrade { code: string; name: string; meaning: string | null; isActive: boolean; sortOrder: number; employeeCount: number }
export const useRankGrades = (includeInactive: boolean, enabled = true) => useQuery({
  queryKey: ['rank-grades', includeInactive], enabled,
  queryFn: () => http.get<{ items: RankGrade[] }>(`/rank-grades${includeInactive ? '?includeInactive=true' : ''}`),
});
type RankGradeAction =
  | { kind: 'create'; body: { code: string; name: string; meaning?: string; isActive: boolean; sortOrder: number } }
  | { kind: 'update'; code: string; body: { name?: string; meaning?: string | null; isActive?: boolean; sortOrder?: number } }
  | { kind: 'remove'; code: string };
export function useRankGradeAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: RankGradeAction): Promise<unknown> => {
      switch (a.kind) {
        case 'create': return http.post('/rank-grades', a.body);
        case 'update': return http.patch(`/rank-grades/${encodeURIComponent(a.code)}`, a.body);
        case 'remove': return http.delete(`/rank-grades/${encodeURIComponent(a.code)}`);
      }
    },
    onSuccess: () => Promise.all(['rank-grades', 'employees'].map((k) => qc.invalidateQueries({ queryKey: [k] }))),
  });
}

/** Nursing Specialty master (owner decision 2026-10-03); employeeCount = employees holding the specialty. */
export interface NursingSpecialty { code: string; name: string; nameAr: string | null; description: string | null; isActive: boolean; sortOrder: number; employeeCount: number }
export const useSpecialties = (includeInactive: boolean, enabled = true) => useQuery({
  queryKey: ['nursing-specialties', includeInactive], enabled,
  queryFn: () => http.get<{ items: NursingSpecialty[] }>(`/nursing-specialties${includeInactive ? '?includeInactive=true' : ''}`),
});
type SpecialtyAction =
  | { kind: 'create'; body: { code: string; name: string; nameAr?: string; description?: string; isActive: boolean; sortOrder: number } }
  | { kind: 'update'; code: string; body: { name?: string; nameAr?: string | null; description?: string | null; isActive?: boolean; sortOrder?: number } }
  | { kind: 'remove'; code: string };
export function useSpecialtyAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: SpecialtyAction): Promise<unknown> => {
      switch (a.kind) {
        case 'create': return http.post('/nursing-specialties', a.body);
        case 'update': return http.patch(`/nursing-specialties/${encodeURIComponent(a.code)}`, a.body);
        case 'remove': return http.delete(`/nursing-specialties/${encodeURIComponent(a.code)}`);
      }
    },
    onSuccess: () => Promise.all(['nursing-specialties', 'employees'].map((k) => qc.invalidateQueries({ queryKey: [k] }))),
  });
}

/** Saudi location master (owner decision 2026-10-03): regions (ISO 3166-2 codes) and their cities. */
export interface SaudiRegion { code: string; name: string; nameAr: string | null; isActive: boolean; sortOrder: number; cityCount: number; employeeCount: number }
export interface SaudiCity { id: number; regionCode: string; name: string; nameAr: string | null; isActive: boolean; sortOrder: number; employeeCount: number }
export const useRegions = (includeInactive: boolean, enabled = true) => useQuery({
  queryKey: ['saudi-regions', includeInactive], enabled,
  queryFn: () => http.get<{ items: SaudiRegion[] }>(`/saudi-regions${includeInactive ? '?includeInactive=true' : ''}`),
});
/** Cities of one region (or all with regionCode null). */
export const useCities = (regionCode: string | null, includeInactive: boolean, enabled = true) => useQuery({
  queryKey: ['saudi-cities', regionCode, includeInactive], enabled,
  queryFn: () => {
    const p = new URLSearchParams();
    if (regionCode) p.set('regionCode', regionCode);
    if (includeInactive) p.set('includeInactive', 'true');
    return http.get<{ items: SaudiCity[] }>(`/saudi-cities${p.size ? `?${p}` : ''}`);
  },
});
type LocationAction =
  | { kind: 'createRegion'; body: { code: string; name: string; nameAr?: string; isActive: boolean; sortOrder: number } }
  | { kind: 'updateRegion'; code: string; body: { name?: string; nameAr?: string | null; isActive?: boolean; sortOrder?: number } }
  | { kind: 'removeRegion'; code: string }
  | { kind: 'createCity'; body: { regionCode: string; name: string; nameAr?: string; isActive: boolean; sortOrder: number } }
  | { kind: 'updateCity'; id: number; body: { regionCode?: string; name?: string; nameAr?: string | null; isActive?: boolean; sortOrder?: number } }
  | { kind: 'removeCity'; id: number };
export function useLocationAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: LocationAction): Promise<unknown> => {
      switch (a.kind) {
        case 'createRegion': return http.post('/saudi-regions', a.body);
        case 'updateRegion': return http.patch(`/saudi-regions/${encodeURIComponent(a.code)}`, a.body);
        case 'removeRegion': return http.delete(`/saudi-regions/${encodeURIComponent(a.code)}`);
        case 'createCity': return http.post('/saudi-cities', a.body);
        case 'updateCity': return http.patch(`/saudi-cities/${a.id}`, a.body);
        case 'removeCity': return http.delete(`/saudi-cities/${a.id}`);
      }
    },
    onSuccess: () => Promise.all(['saudi-regions', 'saudi-cities', 'employees'].map((k) => qc.invalidateQueries({ queryKey: [k] }))),
  });
}

/** Facility master (owner decision 2026-10-03): the hospitals an employee actually works in; employeeCount = employees there. */
export interface Facility { id: number; name: string; nameAr: string | null; isActive: boolean; sortOrder: number; employeeCount: number }
export const useFacilities = (includeInactive: boolean, enabled = true) => useQuery({
  queryKey: ['facilities', includeInactive], enabled,
  queryFn: () => http.get<{ items: Facility[] }>(`/facilities${includeInactive ? '?includeInactive=true' : ''}`),
});
type FacilityAction =
  | { kind: 'create'; body: { name: string; nameAr?: string } }
  | { kind: 'update'; id: number; body: { name?: string; nameAr?: string | null; isActive?: boolean } }
  | { kind: 'remove'; id: number };
export function useFacilityAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: FacilityAction): Promise<unknown> => {
      switch (a.kind) {
        case 'create': return http.post<Facility>('/facilities', a.body);
        case 'update': return http.patch<Facility>(`/facilities/${a.id}`, a.body);
        case 'remove': return http.delete(`/facilities/${a.id}`);
      }
    },
    onSuccess: () => Promise.all(['facilities', 'employees'].map((k) => qc.invalidateQueries({ queryKey: [k] }))),
  });
}
