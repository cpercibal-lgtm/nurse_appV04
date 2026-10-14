import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../services/http';
import type { Paged } from '../../types/api';
import type { EligibilityStatus, Reason } from '../credentials/api';
import type { ShiftType } from '../workforce/api';

export interface Assignment {
  id: number; employeeId: number; jobNumber: string; fullName: string; unitId: number; shiftDate: string; shiftType: ShiftType;
  status: 'Draft' | 'Published'; notes: string | null; eligibilityAtPublish: EligibilityStatus | null;
  eligibility: { status: EligibilityStatus; reasons: Reason[] };
}
export interface CoverageCell {
  date: string; shiftType: ShiftType; target: number | null;
  draft: { total: number; eligible: number }; published: { total: number; eligible: number }; publishedShortage: number | null;
}
export interface Board { unitId: number; from: string; to: string; assignments: Assignment[]; coverage: CoverageCell[] }
export interface PoolRow { id: number; jobNumber: string; fullName: string; positionCode: string; shiftsThatDay: ShiftType[]; eligibility: { status: EligibilityStatus; reasons: Reason[] } }
export interface PublishResult {
  published: number;
  blocked: Array<{ id: number; jobNumber: string; fullName: string; shiftDate: string; shiftType: ShiftType; reasons: Array<{ code: string; message: string }> }>;
  reliedOnGraceOrWaiver: Array<{ id: number; status: string; reasons: string[] }>;
}
export interface GenerateResult {
  dryRun: boolean; targetsMissing: ShiftType[];
  proposed: Array<{ employeeId: number; jobNumber: string; fullName: string; date: string; shiftType: ShiftType; eligibility: string }>;
  unfilled: Array<{ date: string; shiftType: ShiftType; target: number; have: number }>;
}
export interface OwnShift { id: number; employeeId: number; jobNumber: string; fullName: string; unitCode: string; shiftDate: string; shiftType: ShiftType; notes: string | null }
export interface Gap {
  assignmentId: number; employeeId: number; jobNumber: string; fullName: string; shiftType: ShiftType; shiftStart: string; shiftEnd: string;
  clockInAt: string | null; status: 'UPCOMING' | 'PENDING' | 'MISSING' | 'PRESENT' | 'INELIGIBLE_ON_DUTY'; reasons: string[];
}
export interface ClockEvent { id: number; employeeId: number; eventType: string; eventTimestamp: string; source: string | null; employee?: { jobNumber: string; fullName: string } }

export type ApprovalStatus = 'Pending' | 'Approved' | 'Rejected' | 'Withdrawn';
export interface RosterApproval {
  id: number; unitId: number; from: string; to: string; status: ApprovalStatus;
  requestedBy: { id: number; name: string | null }; requestedAt: string;
  decidedBy: { id: number; name: string | null } | null; decidedAt: string | null; note: string | null;
}

export const useApprovals = (unitId: number | undefined) => useQuery({
  queryKey: ['roster', 'approvals', unitId], enabled: unitId !== undefined, retry: false,
  queryFn: () => http.get<{ items: RosterApproval[]; total: number }>(`/roster/approvals?unitId=${unitId}`),
});
export const useBoard = (unitId: number | undefined, from: string, to: string) => useQuery({
  queryKey: ['roster', unitId, from, to], enabled: unitId !== undefined, retry: false,
  queryFn: () => http.get<Board>(`/roster?unitId=${unitId}&from=${from}&to=${to}`),
});
export const usePool = (slot: { unitId: number; date: string; shiftType: ShiftType } | null) => useQuery({
  queryKey: ['roster', 'pool', slot], enabled: slot !== null,
  queryFn: () => http.get<Paged<PoolRow>>(`/roster/pool?unitId=${slot!.unitId}&date=${slot!.date}&shiftType=${slot!.shiftType}`),
});
export const useOwnRoster = (from: string, to: string, enabled: boolean) => useQuery({
  queryKey: ['roster', 'me', from, to], enabled, queryFn: () => http.get<{ own: OwnShift[]; homeUnit: OwnShift[] }>(`/roster/me?from=${from}&to=${to}`),
});
export const useGaps = (unitId: number | undefined, date: string) => useQuery({
  queryKey: ['attendance', 'gaps', unitId, date], enabled: unitId !== undefined, retry: false, refetchInterval: 60_000,
  queryFn: () => http.get<{ date: string; gapMinutes: number; earlyClockInMinutes: number; items: Gap[] }>(`/attendance/gaps?unitId=${unitId}&date=${date}`),
});
export const useOwnEvents = (from: string, to: string, enabled: boolean) => useQuery({
  queryKey: ['attendance', 'me', from, to], enabled, queryFn: () => http.get<Paged<ClockEvent>>(`/attendance/me?from=${from}&to=${to}`),
});

type Action =
  | { kind: 'assign'; body: { employeeId: number; unitId: number; shiftDate: string; shiftType: ShiftType; notes?: string } }
  | { kind: 'remove'; id: number; reason?: string }
  | { kind: 'generate'; body: { unitId: number; from: string; to: string; dryRun: boolean } }
  | { kind: 'publish'; body: { unitId: number; from: string; to: string }; key: string }
  | { kind: 'ask'; body: { unitId: number; from: string; to: string } }
  | { kind: 'decide'; id: number; decision: 'approve' | 'reject'; note?: string };

export function useRosterAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: Action): Promise<unknown> => {
      switch (a.kind) {
        case 'assign': return http.post('/shift-assignments', a.body);
        case 'remove': return http.delete(`/shift-assignments/${a.id}`, a.reason ? { reason: a.reason } : undefined);
        case 'generate': return http.post<GenerateResult>('/roster/auto-generate', a.body);
        case 'publish': return http.post<PublishResult>('/roster/publish', a.body, { idempotencyKey: a.key });
        case 'ask': return http.post('/roster/approvals', a.body);
        case 'decide': return http.post(`/roster/approvals/${a.id}/decision`, { decision: a.decision, ...(a.note ? { note: a.note } : {}) });
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['roster'] }),
  });
}
