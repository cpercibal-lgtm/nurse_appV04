// The only HTTP client (ported from V03 app/src/lib/api.ts).
//
// - Same origin only: the dev server and the production reverse proxy both
//   serve /api, so the SameSite=Lax refresh cookie scoped to /api/v1/auth works
//   without cross-site cookie handling.
// - The access token (short-lived JWT) is held in memory only, never in
//   localStorage, so injected script cannot read it back and it clears when the
//   tab closes. The refresh token is an HttpOnly cookie JS never sees.
// - The CSRF token is echoed as X-CSRF-Token (double submit), read from memory
//   or, after a reload, from the non-HttpOnly nurseapp_csrf cookie.
// - Every failure surfaces as an ApiError. There is no offline fallback and no
//   fire-and-forget write (decision D-1): callers show the server's answer.

import type { ErrorBody, Health, TokenResponse } from '../types/api';

export const API_PREFIX = '/api/v1';
const AUTH_PREFIX = `${API_PREFIX}/auth/`;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
let csrfToken: string | null = null;

export function setTokens(t: Pick<TokenResponse, 'token' | 'csrfToken'> | null) {
  accessToken = t?.token ?? null;
  csrfToken = t?.csrfToken ?? null;
}

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = /(?:^|;\s*)nurseapp_csrf=([^;]*)/.exec(document.cookie);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  /** For operations marked [I] in API.md: a UUID reused on retry so the server applies the write once. */
  idempotencyKey?: string;
  /** A file sent as the raw body (evidence uploads); its name travels in X-File-Name. */
  file?: File;
  /** Edits: the version of the record as loaded (its updatedAt). A record changed since is refused (409 STALE_RECORD). */
  ifMatch?: string;
}

async function send(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.ifMatch) headers['If-Match'] = `"${opts.ifMatch}"`;
  if (opts.file) {
    headers['Content-Type'] = opts.file.type || 'application/octet-stream';
    headers['X-File-Name'] = encodeURIComponent(opts.file.name);
  } else if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const csrf = csrfToken ?? readCsrfCookie();
  if (csrf) headers['X-CSRF-Token'] = csrf;
  try {
    return await fetch(`${API_PREFIX}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.file ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The server could not be reached. Check your connection and try again.');
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const requestId = res.headers.get('X-Request-Id') ?? undefined;
  let body: Partial<ErrorBody> | undefined;
  try { body = (await res.json()) as Partial<ErrorBody>; } catch { /* not JSON (e.g. proxy error page) */ }
  const e = body?.error;
  if (e && typeof e.code === 'string' && typeof e.message === 'string') {
    return new ApiError(res.status, e.code, e.message, e.details, requestId);
  }
  return new ApiError(res.status, `HTTP_${res.status}`, `The server answered ${res.status}.`, undefined, requestId);
}

// Single-flight refresh. Refresh ROTATES the token server-side, so two parallel
// refreshes would present the same cookie and the second would look like a
// replay — tripping reuse detection and revoking the whole session family.
// React StrictMode's double-invoked effects and racing 401s both do this.
let refreshInFlight: Promise<boolean> | null = null;

/** Exchanges the refresh cookie for a new access token. Never throws. */
export function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await send('POST', '/auth/refresh');
      if (!res.ok) return false;
      const r = (await res.json()) as Partial<TokenResponse>;
      if (!r.token || !r.csrfToken) return false;
      setTokens({ token: r.token, csrfToken: r.csrfToken });
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Called when the session cannot be renewed (set by the session store). */
let onSessionExpired: () => void = () => {};
export function setSessionExpiredHandler(fn: () => void) { onSessionExpired = fn; }

/** Sends a request, refreshing the session once on 401. Resolves to the successful Response. */
async function exchange(method: Method, path: string, body?: unknown, opts?: RequestOptions): Promise<Response> {
  let res = await send(method, path, body, opts);
  // Access token expired mid-session → one silent refresh, then retry once.
  if (res.status === 401 && !`${API_PREFIX}${path}`.startsWith(AUTH_PREFIX)) {
    if (await refreshSession()) {
      res = await send(method, path, body, opts);
    } else {
      setTokens(null);
      onSessionExpired();
    }
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}

async function request<T>(method: Method, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  const res = await exchange(method, path, body, opts);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const http = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body, opts),
  /** A body is allowed where the API asks for a reason (e.g. soft-deleting an employee). */
  delete: <T = void>(path: string, body?: unknown) => request<T>('DELETE', path, body),
  /** Uploads a file as the raw request body. */
  upload: <T>(path: string, file: File) => request<T>('POST', path, undefined, { file }),
  /**
   * Opens a stored document in a new tab through a single-use, 60-second link
   * (D-53): the tab is opened first, inside the click, so no pop-up blocker
   * intervenes; the link is issued after the server's usual checks.
   */
  async openDocument(path: string) {
    const tab = window.open('', '_blank');
    try {
      const { url } = await request<{ url: string }>('POST', `${path}/link`, { inline: true });
      if (tab) { tab.opener = null; tab.location.href = url; } else window.location.assign(url);
    } catch (e) {
      tab?.close();
      throw e;
    }
  },
  /** Downloads a protected file and hands it to the browser as a save. */
  async download(path: string, fallbackName = 'document') {
    const res = await exchange('GET', path);
    const m = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition') ?? '');
    const name = m?.[1] ? decodeURIComponent(m[1]) : fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};

/** GET /health. A 503 is an answer ("database down"), not a failure, so its body is returned. */
export async function getHealth(): Promise<Health> {
  const res = await send('GET', '/health');
  if (res.status !== 200 && res.status !== 503) throw await toApiError(res);
  return (await res.json()) as Health;
}
