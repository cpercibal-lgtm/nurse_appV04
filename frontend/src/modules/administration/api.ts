import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../services/http';
import type { AppRole, DataSubjectRequest, DsrType, Paged, ScopeType } from '../../types/api';

export interface Account {
  id: number;
  email: string;
  displayName: string;
  isActive: boolean;
  isBreakGlass: boolean;
  employeeId: number | null;
  lastLoginAt: string | null;
  employee: { jobNumber: string; fullName: string; unitId: number | null } | null;
  roleAssignments: Array<{ role: AppRole; scopeType: ScopeType }>;
  /** An authenticator is set up (spec §3.5). */
  mfaEnabled: boolean;
  /** A Telegram chat is connected (D-66); the chat id itself is never listed. */
  telegramLinked: boolean;
}

export interface Assignment {
  id: number;
  userId: number;
  role: AppRole;
  scopeType: ScopeType;
  scopeIds: number[];
  reason: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  approvalRequestId: number | null;
  active: boolean;
  user: { email: string; displayName: string };
  grantedBy: { displayName: string };
}

export interface ApprovalRequest {
  id: number;
  actionType: string;
  payload:
    | { kind: 'GRANT'; grant: GrantInput }
    | { kind: 'UPDATE'; assignmentId: number; update: { scopeType?: ScopeType; scopeIds?: number[]; reason: string } }
    | { kind: 'TEMPLATE_CREATE'; template: { code: string; name: string }; reason: string }
    | { kind: 'TEMPLATE_UPDATE'; templateId: number; code: string; change: Record<string, unknown>; before: Record<string, unknown>; reason: string }
    | { kind: 'CATEGORY_CREATE'; category: { code: string; name: string }; reason: string }
    | { kind: 'CATEGORY_UPDATE'; code: string; change: Record<string, unknown>; before: Record<string, unknown>; reason: string }
    | { kind: 'BASELINE_IMPORT'; fileHash: string; totals: BaselineReport['totals']; reason: string }
    // D-69: an HR / System Admin announcement waiting for a second administrator.
    | { kind: 'ANNOUNCEMENT'; announcementId: number; announcementKind: 'MEMO' | 'MEETING' | 'SEMINAR'; title: string; audienceType: 'HOSPITAL' | 'DEPARTMENT' | 'UNIT' | 'PEOPLE'; audienceIds: number[]; recipients: number; emailOnly: number };
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'WITHDRAWN';
  createdAt: string;
  initiatorId: number;
  initiator: { displayName: string; email: string };
  approver: { displayName: string } | null;
  reason: string | null;
}

export interface GrantInput {
  userId: number;
  role: AppRole;
  scopeType: ScopeType;
  scopeIds: number[];
  reason: string;
  expiresAt?: string;
}

export type GrantOutcome = { status: 'GRANTED'; id: number } | { status: 'PENDING_APPROVAL'; requestId: number };

export interface Department { id: number; code: string; name: string }
export interface Unit { id: number; code: string; name: string; departmentId: number }

export interface Matrix {
  matrix: { columns: string[]; rows: Array<{ area: string; cells: string[] }>; source: string };
  permissions: Record<string, string[]>;
}

const keys = {
  accounts: ['accounts'] as const,
  assignments: ['role-assignments'] as const,
  approvals: ['approvals'] as const,
  pam: ['pam'] as const,
};

/** Accounts, optionally filtered on the server by e-mail or display name. */
export const useAccounts = (q = '') => useQuery({
  queryKey: [...keys.accounts, q], placeholderData: keepPreviousData,
  queryFn: () => http.get<Paged<Account>>(q ? `/users?q=${encodeURIComponent(q)}` : '/users'),
});
export const useAssignments = () => useQuery({ queryKey: keys.assignments, queryFn: () => http.get<Paged<Assignment>>('/role-assignments') });
export const useApprovals = () => useQuery({ queryKey: keys.approvals, queryFn: () => http.get<Paged<ApprovalRequest>>('/approvals?status=PENDING') });
export const usePamStatus = () => useQuery({ queryKey: keys.pam, queryFn: () => http.get<{ eligible: boolean; active: boolean; expiresAt: string | null }>('/pam/status') });
export const useMatrix = () => useQuery({ queryKey: ['matrix'], queryFn: () => http.get<Matrix>('/roles/matrix'), staleTime: Infinity });
export const useDepartments = () => useQuery({ queryKey: ['departments'], queryFn: () => http.get<Paged<Department>>('/departments') });
export const useUnits = () => useQuery({ queryKey: ['units'], queryFn: () => http.get<Paged<Unit>>('/units') });

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, key }: { body: { email: string; displayName: string; password: string; employeeId?: number | null }; key: string }) =>
      http.post<{ id: number }>('/users', body, { idempotencyKey: key }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.accounts }),
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: { isActive?: boolean; displayName?: string } }) => http.patch(`/users/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.accounts }),
  });
}

export function useGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, key }: { body: GrantInput; key: string }) => http.post<GrantOutcome>('/role-assignments', body, { idempotencyKey: key }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: keys.assignments }), qc.invalidateQueries({ queryKey: keys.approvals }), qc.invalidateQueries({ queryKey: keys.accounts })]),
  });
}

export function useRevoke() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => http.post(`/role-assignments/${id}/revoke`, { reason }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: keys.assignments }), qc.invalidateQueries({ queryKey: keys.accounts })]),
  });
}

export function useDecide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, reason }: { id: number; decision: 'approve' | 'reject'; reason: string }) =>
      http.post<{ id: number; status: string }>(`/approvals/${id}/${decision}`, { reason }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: keys.approvals }), qc.invalidateQueries({ queryKey: keys.assignments }), qc.invalidateQueries({ queryKey: ['templates'] })]),
  });
}

export function useWithdraw() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      http.post<{ id: number; status: 'WITHDRAWN' }>(`/approvals/${id}/withdraw`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.approvals }),
  });
}

export function usePamActions() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries();
  return {
    elevate: useMutation({ mutationFn: (body: { reason: string; durationHours: number }) => http.post('/pam/elevate', body), onSuccess: done }),
    end: useMutation({ mutationFn: () => http.post('/pam/end'), onSuccess: done }),
  };
}

// ── Hospital baseline import (P7) ─────────────────────────────────────────────
export interface BaselineRow { section: string; code: string; status: 'CREATE' | 'UNCHANGED' | 'CONFLICT' | 'REJECTED'; issues: string[] }
export interface BaselineReport {
  fileHash: string;
  counts: Record<string, Record<BaselineRow['status'], number>>;
  totals: Record<BaselineRow['status'], number> & { beds: number; fields: number };
  rows: BaselineRow[];
  canImport: boolean;
}

export const useBaselinePreview = () => useMutation({
  mutationFn: (file: unknown) => http.post<BaselineReport>('/admin/baseline-import/preview', { file }),
});

export function useBaselineRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { file: unknown; reason: string }) =>
      http.post<{ status: 'PENDING_APPROVAL'; requestId: number } | { status: 'APPLIED' }>('/admin/baseline-import', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  });
}

/** Spec §8.3.2 (D-54): the lawful basis per category of sensitive data. */
export interface RegisterEntry {
  id: number; dataCategory: 'IQAMA' | 'PASSPORT' | 'SCFHS_REG' | 'NATIONAL_ID' | 'IDENTITY_SCAN';
  lawfulBasis: 'EMPLOYMENT_CONTRACT' | 'LEGAL_OBLIGATION' | 'CONSENT' | 'VITAL_INTEREST' | 'PUBLIC_INTEREST';
  purpose: string; retentionRule: string; isActive: boolean; updatedAt: string;
}
export interface RegisterSignOff {
  last: { id: number; reviewedBy: { id: number; displayName: string }; title: string; note: string | null; reviewedAt: string } | null;
  changedSince: boolean; dueAt: string | null; due: boolean;
}
export const useProcessingRegister = () => useQuery({ queryKey: ['pdpl', 'register'], queryFn: () => http.get<{ items: RegisterEntry[]; signOff: RegisterSignOff }>('/pdpl/register') });
/** B-18 (D-56): the Data Protection Officer signs off the register as it stands. */
export function useSignOffRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string; note?: string; confirm: true }) => http.post<{ id: number }>('/pdpl/register/sign-offs', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pdpl'] }),
  });
}
export function useUpdateRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: { purpose?: string; retentionRule?: string; isActive?: boolean; reason: string } }) => http.patch<RegisterEntry>(`/pdpl/register/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pdpl'] }),
  });
}

// Data-subject requests (spec §8.3.3, D-55).
export interface DsrFilter { open?: boolean; type?: DsrType }
export const useDataSubjectRequests = (f: DsrFilter) => useQuery({
  queryKey: ['pdpl', 'requests', f],
  queryFn: () => {
    const p = new URLSearchParams();
    if (f.open) p.set('open', 'true');
    if (f.type) p.set('type', f.type);
    return http.get<{ items: DataSubjectRequest[] }>(`/pdpl/requests?${p}`);
  },
});
export type DsrAction =
  | { kind: 'log'; body: { employeeId: number; type: DsrType; details?: string } }
  | { kind: 'review' | 'approve'; id: number; note?: string }
  | { kind: 'reject' | 'complete'; id: number; note: string }
  | { kind: 'erase'; id: number; note: string; confirmJobNumber: string };
export function useDsrAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: DsrAction) => {
      switch (a.kind) {
        case 'log': return http.post<DataSubjectRequest>('/pdpl/requests', a.body);
        case 'review': return http.post<DataSubjectRequest>(`/pdpl/requests/${a.id}/review`);
        case 'erase': return http.post<DataSubjectRequest>(`/pdpl/requests/${a.id}/erase`, { note: a.note, confirmJobNumber: a.confirmJobNumber });
        default: return http.post<DataSubjectRequest>(`/pdpl/requests/${a.id}/${a.kind}`, a.note ? { note: a.note } : {});
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pdpl'] }),
  });
}

// ── Dev Console: Telegram inbox (D-66), System Admin ──
export interface MockTelegram { id: number; chatId: string; messageText: string; parseMode: string | null; status: string; createdAt: string }
export const useTelegramInbox = () => useQuery({
  queryKey: ['telegramInbox'],
  queryFn: () => http.get<{ driver: 'mock' | 'telegram'; items: MockTelegram[]; total: number }>('/dev-console/telegram-inbox?limit=200'),
  refetchInterval: 10_000, // a demonstration shows new messages as they arrive
});
export function useSendTestTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { chatId: string; message: string }) => http.post<{ accepted: boolean; messageId: string; driver: string }>('/dev-console/telegram-inbox/test', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telegramInbox'] }),
  });
}
/** Mock driver only: what the bot would receive if this chat sent the text (e.g. "/start <token>"). */
export function useSimulateTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { chatId: string; text: string }) => http.post<{ handled: boolean }>('/dev-console/telegram-inbox/simulate', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telegramInbox'] }),
  });
}

// ── Eligibility logic, shadow mode (spec §10.9, D-60) ──
export interface LogicVersion {
  version: number; status: 'ACTIVE' | 'SHADOW' | 'RETIRED'; shadowSince: string | null; promotedAt: string | null; retiredAt: string | null; note: string | null; createdAt: string;
  promotedBy: { id: number; displayName: string } | null; retiredBy: { id: number; displayName: string } | null;
}
export interface ShadowState {
  version: number; shadowSince: string; daysInShadow: number; findings: number; undecided: number; approved: number; rejected: number; errors: number;
  promotable: boolean; blocker: string | null;
}
export interface ShadowFinding {
  id: number; logicVersion: number; evalDate: string; activeVersion: number; activeStatus: string; candidateStatus: string;
  activeReasons: Array<{ code: string; message: string }>; candidateReasons: Array<{ code: string; message: string }>; event: string; createdAt: string;
  decision: 'APPROVED' | 'REJECTED' | null; decisionNote: string | null; decidedAt: string | null; decidedBy: { id: number; displayName: string } | null;
  employee: { id: number; jobNumber: string; fullName: string; unitId: number | null };
}
export type FindingFilter = 'undecided' | 'approved' | 'rejected' | 'all';
export const useEligibilityLogic = () => useQuery({
  queryKey: ['eligibilityLogic'],
  queryFn: () => http.get<{ active: number | null; shadow: ShadowState | null; versions: LogicVersion[] }>('/eligibility/logic'),
});
export const useShadowFindings = (version: number | undefined, decision: FindingFilter, page: number) => useQuery({
  queryKey: ['eligibilityLogic', 'findings', version, decision, page],
  queryFn: () => http.get<Paged<ShadowFinding>>(`/eligibility/logic/${version}/findings?decision=${decision}&page=${page}&pageSize=25`),
  enabled: version !== undefined,
  placeholderData: keepPreviousData,
});
export function useDecideFinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; decision: 'APPROVED' | 'REJECTED'; note: string }) => http.post<ShadowFinding>(`/eligibility/logic/findings/${id}/decision`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eligibilityLogic'] }),
  });
}
export function useLogicLifecycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ version, action, reason }: { version: number; action: 'promote' | 'retire'; reason: string }) => http.post<unknown>(`/eligibility/logic/${version}/${action}`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eligibilityLogic'] }),
  });
}

// ── FHIR API clients (D-63) ──
export type FhirScope = 'system/Practitioner.read' | 'system/PractitionerRole.read' | 'attendance.ingest';
export interface ApiClient {
  id: number; clientId: string; name: string; scopes: FhirScope[]; secretVersion: number;
  createdAt: string; secretRotatedAt: string | null; lastTokenAt: string | null; revokedAt: string | null;
  createdBy: { id: number; displayName: string }; revokedBy: { id: number; displayName: string } | null;
}
export const useApiClients = () => useQuery({
  queryKey: ['apiClients'],
  queryFn: () => http.get<{ items: ApiClient[]; scopes: FhirScope[] }>('/api-clients'),
});
function useApiClientMutation<V>(fn: (v: V) => Promise<{ client: ApiClient; clientSecret?: string }>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['apiClients'] }) });
}
export const useCreateApiClient = () => useApiClientMutation((body: { name: string; scopes: FhirScope[] }) => http.post<{ client: ApiClient; clientSecret: string }>('/api-clients', body));
export const useReplaceApiClientSecret = () => useApiClientMutation((id: number) => http.post<{ client: ApiClient; clientSecret: string }>(`/api-clients/${id}/secret`, {}));
export const useRevokeApiClient = () => useApiClientMutation((id: number) => http.post<{ client: ApiClient }>(`/api-clients/${id}/revoke`, {}));

// ── Simulated SCFHS registry (D-64) ──
export type RegistryStatus = 'VERIFIED' | 'EXPIRED' | 'SUSPENDED' | 'REVOKED' | 'ERROR';
export interface RegistryEntry { registrationNumber: string; status: RegistryStatus; expiryDate: string | null; specialty: string | null; note: string | null; updatedAt: string }
export const useScfhsRegistry = () => useQuery({
  queryKey: ['scfhsRegistry'],
  queryFn: () => http.get<{ driver: 'mock' | 'live'; items: RegistryEntry[] }>('/dev-console/scfhs-registry'),
});
export function useScfhsRegistryChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { kind: 'set'; reg: string; body: Omit<RegistryEntry, 'registrationNumber' | 'updatedAt'> } | { kind: 'remove'; reg: string }) =>
      a.kind === 'set' ? http.put<unknown>(`/dev-console/scfhs-registry/${encodeURIComponent(a.reg)}`, a.body) : http.delete<unknown>(`/dev-console/scfhs-registry/${encodeURIComponent(a.reg)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scfhsRegistry'] }),
  });
}

// ── Badge simulator (D-65) ──
export interface SimulatedEvent { id: number; eventType: 'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_START' | 'BREAK_END'; eventTimestamp: string; createdAt: string; employee: { jobNumber: string; fullName: string } }
export const useBadgeSimulator = () => useQuery({
  queryKey: ['badgeSimulator'],
  queryFn: () => http.get<{ enabled: boolean; recent: SimulatedEvent[]; total: number }>('/dev-console/badge-simulator'),
});
/** What a simulation answers: counts for a swipe or a shift, `deleted` for a clear. */
export interface BadgeSimResult { accepted?: number; duplicates?: number; alreadyIn?: number; leftOut?: string[]; date?: string; deleted?: number }
export function useBadgeSimulation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { kind: 'swipe'; body: { jobNumber: string; type: string } } | { kind: 'shift'; body: { unitId: number; date?: string; shiftType: string; leaveOut: number } } | { kind: 'clear' }) =>
      a.kind === 'swipe' ? http.post<BadgeSimResult>('/dev-console/badge-simulator/events', a.body)
        : a.kind === 'shift' ? http.post<BadgeSimResult>('/dev-console/badge-simulator/shift', a.body)
          : http.delete<BadgeSimResult>('/dev-console/badge-simulator/events'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['badgeSimulator'] }),
  });
}
