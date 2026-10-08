import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, http, refreshSession, setSessionExpiredHandler, setTokens } from './http';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setTokens(null);
  setSessionExpiredHandler(() => {});
});
afterEach(() => vi.unstubAllGlobals());

const calls = () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${String(url)}`);

describe('http client', () => {
  it('sends the bearer token and CSRF header under /api/v1', async () => {
    setTokens({ token: 'T1', csrfToken: 'C1' });
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await expect(http.post('/things', { a: 1 })).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/things');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer T1', 'X-CSRF-Token': 'C1', 'Content-Type': 'application/json' });
    expect(init.body).toBe('{"a":1}');
  });

  it('sends an Idempotency-Key when given one', async () => {
    fetchMock.mockResolvedValueOnce(json(201, { id: 7 }));
    await http.post('/role-assignments', {}, { idempotencyKey: 'k-1' });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': 'k-1' });
  });

  it('sends the record version as a quoted If-Match on an edit, and nothing without one', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {})).mockResolvedValueOnce(json(200, {}));
    await http.patch('/units/3', { name: 'x' }, { ifMatch: '2026-10-08T11:19:39.123Z' });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'If-Match': '"2026-10-08T11:19:39.123Z"' });
    await http.patch('/units/3', { name: 'y' });
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).not.toHaveProperty('If-Match');
  });

  it('turns the error envelope into an ApiError with code, message and request id', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: { code: 'CONTRACT_PERIOD_OVERLAP', message: 'Overlaps' } }, { 'X-Request-Id': 'r-1' }));
    const err = await http.get('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'CONTRACT_PERIOD_OVERLAP', message: 'Overlaps', requestId: 'r-1' });
  });

  it('reports a non-JSON failure without inventing a code', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }));
    await expect(http.get('/x')).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
  });

  it('reports an unreachable server as NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(http.get('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    setTokens({ token: 'OLD', csrfToken: 'C' });
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }))
      .mockResolvedValueOnce(json(200, { token: 'NEW', csrfToken: 'C2', expiresIn: 900 }))
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    await expect(http.get('/x')).resolves.toEqual({ ok: 1 });
    expect(calls()).toEqual(['GET /api/v1/x', 'POST /api/v1/auth/refresh', 'GET /api/v1/x']);
    expect((fetchMock.mock.calls[2]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer NEW' });
  });

  it('shares one refresh between concurrent callers (rotation must not look like replay)', async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/auth/refresh') ? new Promise<Response>((r) => { release = r; }) : Promise.resolve(json(200, {})));
    const a = refreshSession();
    const b = refreshSession();
    release(json(200, { token: 'N', csrfToken: 'C', expiresIn: 900 }));
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
    expect(calls().filter((c) => c.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('ends the session when refresh fails', async () => {
    const expired = vi.fn();
    setSessionExpiredHandler(expired);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }))
      .mockResolvedValueOnce(json(401, { error: { code: 'REFRESH_INVALID', message: 'no' } }));
    await expect(http.get('/x')).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledOnce();
  });

  it('never refreshes for auth endpoints (a failed login is just a failed login)', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }));
    await expect(http.post('/auth/login', {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(calls()).toEqual(['POST /api/v1/auth/login']);
  });
});
