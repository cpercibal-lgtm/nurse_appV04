import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../services/http';
import { isStaleRecord } from '../../lib/errors';
import type { Paged } from '../../types/api';

/** HR and own profile get every field; a Supervisor gets the baseline (§8.1, D-36). */
export interface EmployeeRow {
  id: number; jobNumber: string; firstName: string; middleName: string | null; lastName: string; fullName: string;
  jobTitle: string | null; specialty: string | null; unitId: number | null; unit: { code: string; name: string } | null;
  positionCode: string; position: { code: string; title: string }; status: string; hireDate: string | null;
  view: 'FULL' | 'BASELINE';
  /** The version for edits (If-Match); in the full view only. */
  updatedAt?: string;
  contactEmail: string; primaryPhone: string | null; actualWorkPlace: string | null;
  fileNo?: string | null; rankGrade?: string | null; nationality?: string | null;
  /** The listed nationality (ISO 3166-1 alpha-3); `nationality` is only unmatched free text from before the list. */
  nationalityCode?: string | null; nationalityName?: string | null; nationalityNameAr?: string | null;
  /** The SCFHS classification from the Rank/Grade master; `rankGrade` is only unmatched free text from before it. */
  rankGradeCode?: string | null; rankGradeName?: string | null; rankGradeActive?: boolean | null;
  /** From the Nursing Specialty master; `specialty` is only unmatched free text from before it. */
  specialtyCode?: string | null; specialtyName?: string | null; specialtyNameAr?: string | null; specialtyActive?: boolean | null;
  /** Job Post (City) = region + city of the location master; `jobPostLocation` is only unmatched free text from before it. */
  jobPostRegionCode?: string | null; jobPostCityId?: number | null; jobPostRegionName?: string | null; jobPostRegionNameAr?: string | null;
  jobPostCityName?: string | null; jobPostCityNameAr?: string | null;
  /** Actual Work Place / Facility from the Facility master (supervisors see it); `actualWorkPlace` is only unmatched free text from before it. */
  facilityId?: number | null; facilityName?: string | null; facilityNameAr?: string | null; facilityActive?: boolean | null; jobPostLocation?: string | null; emergencyContactPhone?: string | null;
  maritalStatus?: 'Single' | 'Married' | 'Others' | null; salary?: string | null;
}

export interface EmployeeFilter { q?: string; unitId?: number; page: number }

export const useEmployees = (f: EmployeeFilter, enabled = true) => useQuery({
  queryKey: ['employees', f], placeholderData: keepPreviousData, enabled,
  queryFn: () => {
    const p = new URLSearchParams({ page: String(f.page), pageSize: '50' });
    if (f.q) p.set('q', f.q);
    if (f.unitId) p.set('unitId', String(f.unitId));
    return http.get<Paged<EmployeeRow>>(`/employees?${p}`);
  },
});
export const useMyEmployee = () => useQuery({ queryKey: ['employees', 'me'], queryFn: () => http.get<EmployeeRow>('/employees/me'), retry: false });

/** D-35: the employee's own phone numbers — the only fields they maintain. */
export function useUpdateOwnContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ version, ...body }: { version?: string; primaryPhone?: string | null; emergencyContactPhone?: string | null }) =>
      http.patch<EmployeeRow>('/employees/me/contact', body, { ifMatch: version }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
    onError: (e) => isStaleRecord(e) && qc.invalidateQueries({ queryKey: ['employees'] }),
  });
}

/** Rule E6 defaults (Unassigned, default position if the hospital has it), from the server. */
export const useOnboardingDefaults = (enabled: boolean) => useQuery({
  queryKey: ['employees', 'onboarding-defaults'], enabled,
  queryFn: () => http.get<{ unitId: null; positionCode: string | null }>('/employees/onboarding-defaults'),
});

export const useEmployee = (id: number | null) => useQuery({ queryKey: ['employees', 'one', id], enabled: id !== null, queryFn: () => http.get<EmployeeRow>(`/employees/${id}`) });

type Action =
  | { kind: 'onboard'; body: object; key: string }
  | { kind: 'update'; id: number; version?: string; body: object }
  | { kind: 'position'; id: number; positionCode: string; reason: string }
  | { kind: 'assign'; id: number; key: string; body: AssignmentTarget & { reason: string } }
  | { kind: 'delete'; id: number; reason: string };

export function useEmployeeAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: Action): Promise<unknown> => {
      switch (a.kind) {
        case 'onboard': return http.post<{ employeeId: number; contractId: number }>('/employees/onboard', a.body, { idempotencyKey: a.key });
        case 'update': return http.patch(`/employees/${a.id}`, a.body, { ifMatch: a.version });
        case 'position': return http.post(`/employees/${a.id}/position`, { positionCode: a.positionCode, reason: a.reason });
        case 'assign': return http.post<AssignmentResult>(`/employees/${a.id}/assignment`, a.body, { idempotencyKey: a.key });
        case 'delete': return http.delete(`/employees/${a.id}`, { reason: a.reason });
      }
    },
    onSuccess: () => Promise.all(['employees', 'contracts', 'eligibility', 'roster', 'assignment-preview'].map((k) => qc.invalidateQueries({ queryKey: [k] }))),
    onError: (e) => isStaleRecord(e) && qc.invalidateQueries({ queryKey: ['employees'] }),
  });
}

// ── Assign unit and position (owner decision 2026-10-05) ────────────────────
/** `unitId: null` = Unassigned; a property left out keeps the current value. */
export interface AssignmentTarget { unitId?: number | null; positionCode?: string }
export interface AssignmentResult {
  id: number; unitId: number | null; positionCode: string;
  eligibility: { status: 'ELIGIBLE' | 'ELIGIBLE_WITH_GRACE' | 'ELIGIBLE_WITH_POLICY_WARNING' | 'INELIGIBLE'; reasons: Array<{ code: string; message: string; templateCode: string | null }> } | null;
}
export interface AssignmentPreview extends AssignmentResult { shiftsToDraft: Array<{ date: string; shiftType: string; unitCode: string | null }> }
/** What an assignment would do; the server runs it and rolls it back. Only asked when something changes. */
export const useAssignmentPreview = (id: number | null, target: AssignmentTarget | null) => useQuery({
  queryKey: ['assignment-preview', id, target?.unitId, target?.positionCode],
  enabled: id !== null && target !== null && (target.unitId !== undefined || target.positionCode !== undefined),
  retry: false,
  queryFn: () => {
    const q = new URLSearchParams();
    if (target!.unitId !== undefined) q.set('unitId', target!.unitId === null ? 'none' : String(target!.unitId));
    if (target!.positionCode !== undefined) q.set('positionCode', target!.positionCode);
    return http.get<AssignmentPreview>(`/employees/${id}/assignment/preview?${q.toString()}`);
  },
});

// ── Registration invitations (spec §3.2): HR sends; the link goes only by e-mail ──
export type InvitationStatus = 'OPEN' | 'CLAIMED' | 'REVOKED' | 'EXPIRED';
export interface InvitationRow { id: number; email: string; createdAt: string; expiresAt: string; status: InvitationStatus }
export const useInvitations = (employeeId: number | null, enabled: boolean) => useQuery({
  queryKey: ['invitations', employeeId], enabled: enabled && employeeId !== null,
  queryFn: () => http.get<{ items: InvitationRow[]; total: number }>(`/employees/${employeeId}/invitations`),
});
export function useInviteEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (employeeId: number) => http.post<{ id: number; email: string; expiresAt: string }>(`/employees/${employeeId}/invitations`),
    onSuccess: (_d, employeeId) => qc.invalidateQueries({ queryKey: ['invitations', employeeId] }),
  });
}
