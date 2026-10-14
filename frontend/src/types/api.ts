// DTO types shared by the frontend. The backend is authoritative; these mirror
// its responses (docs/API.md) and grow with each domain module.

export type AppRole = 'SYSTEM_ADMIN' | 'HR_ADMIN' | 'SUPERVISOR' | 'NURSING_ADMIN' | 'NURSING_DIRECTOR';
export type ScopeType = 'SYSTEM' | 'DEPARTMENT' | 'UNIT';

export interface RoleGrant {
  id: number | null;
  role: AppRole;
  scopeType: ScopeType;
  scopeIds: number[];
  expiresAt: string | null;
  /** A System Admin assignment that needs PAM elevation before it counts (R13). */
  dormant?: boolean;
}

export interface SessionUser {
  id: number;
  email: string;
  displayName: string;
  /** Set when the account belongs to an employee (self-service). */
  employeeId: number | null;
  isBreakGlass: boolean;
}

export type EffectiveRole = AppRole | 'EMPLOYEE';

/** GET /api/v1/auth/me */
export interface MeResponse {
  user: SessionUser;
  roles: RoleGrant[];
  effectiveRoles: EffectiveRole[];
  pam: { expiresAt: string } | null;
  breakGlass: { expiresAt: string } | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

/** POST /api/v1/auth/login and /refresh */
export interface TokenResponse {
  token: string;
  csrfToken: string;
  expiresIn: number;
}

/** Login when a second step is due (spec §3.5): no session yet, only the challenge. */
export interface MfaPrompt {
  mfa: { step: 'VERIFY' | 'ENROLL'; challenge: string; expiresIn: number };
}

/** A new authenticator seed, for the QR code and for typing in by hand. */
export interface MfaSetup {
  secret: string;
  otpauthUri: string;
  account?: string;
}

/** D-67: the signed-in account's sign-in e-mail and any change waiting for confirmation. */
export interface EmailChangeStatus {
  email: string;
  pending: { newEmail: string; expiresAt: string; mode: 'SELF' | 'ASSISTED' } | null;
  /** False for the break-glass account. */
  available: boolean;
}

/** D-66: the signed-in account's Telegram connection. */
export interface TelegramStatus {
  linked: boolean;
  linkedAt: string | null;
  botUsername: string | null;
  driver: 'mock' | 'telegram';
  /** False for the break-glass account. */
  available: boolean;
}

/** A single-use link that connects an account to Telegram (15 minutes). */
export interface TelegramLinkOffer {
  /** https://t.me/<bot>?start=<token>; null while no bot username is configured. */
  url: string | null;
  startParameter: string;
  expiresAt: string;
}

export interface MfaStatus {
  enabled: boolean;
  enabledAt: string | null;
  /** The account's roles require it (it cannot be turned off). */
  required: boolean;
  /** False for the break-glass account (spec §3.6). */
  available: boolean;
  recoveryCodesLeft: number;
}

/** Every API error body: {error: {code, message, details?}} */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** GET /api/v1/health (200 when the database answers, 503 otherwise) */
export interface Health {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
}

/** Data-subject rights (spec §8.3.3, D-55). */
export type DsrType = 'ACCESS' | 'PORTABILITY' | 'RECTIFICATION' | 'ERASURE';
export type DsrStatus = 'RECEIVED' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'COMPLETED';
export interface DataSubjectRequest {
  id: number; type: DsrType; status: DsrStatus; details: string | null;
  employee: { id: number; fullName: string; jobNumber: string; unitId: number | null };
  requestedBy: { id: number; displayName: string }; requestedAt: string;
  reviewedBy: { id: number; displayName: string } | null; reviewedAt: string | null;
  decidedBy: { id: number; displayName: string } | null; decidedAt: string | null; decisionNote: string | null; completedAt: string | null;
  dueAt: string; overdue: boolean;
  exportAvailable: boolean; exportExpiresAt: string | null;
  erasure: { keyDestroyedAt: string; backupsExpireAt: string; documentsErased: number } | null;
}
