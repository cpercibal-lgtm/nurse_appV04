// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConfirmEmailPage from './ConfirmEmailPage';
import { http } from '../../services/http';

const fixtures = vi.hoisted(() => ({ logout: vi.fn(async () => undefined), t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: fixtures.t }) }));
vi.mock('../../hooks/usePreferences', () => ({ usePreferences: () => ({ language: 'en', setLanguage: () => {} }) }));
vi.mock('../../hooks/useAuth', () => ({ useAuth: (select: (s: { logout: typeof fixtures.logout }) => unknown) => select({ logout: fixtures.logout }) }));
vi.mock('../../services/http', () => ({ http: { post: vi.fn() } }));
vi.mock('../../lib/errors', () => ({ describeApiError: (e: Error) => e.message }));
vi.mock('react-router', () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@ant-design/icons', () => ({ GlobalOutlined: () => null }));
vi.mock('antd', () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  Alert: ({ title }: { title: ReactNode }) => <div role="alert">{title}</div>,
  Result: ({ title, subTitle }: { title: ReactNode; subTitle: ReactNode }) => <div>{title}{subTitle}</div>,
  Spin: () => <div>working</div>,
}));

let container: HTMLDivElement;
let root: Root;
let requests: Array<{ token: string; resolve: (value: { email: string }) => void; reject: (error: Error) => void }>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  history.replaceState(null, '', '/confirm-email');
  requests = [];
  vi.mocked(http.post).mockImplementation((_path, body) => new Promise((resolve, reject) => {
    requests.push({ token: (body as { token: string }).token, resolve, reject });
  }) as never);
  fixtures.logout.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function mount(token = '') {
  history.replaceState(null, '', `/confirm-email${token ? `#token=${token}` : ''}`);
  await act(async () => root.render(<StrictMode><ConfirmEmailPage /></StrictMode>));
}
async function changeToken(token: string) {
  await act(async () => {
    history.replaceState(null, '', `/confirm-email#token=${token}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

describe('email confirmation links in one tab', () => {
  it('accepts a token after initially opening without one', async () => {
    await mount();
    expect(container.textContent).toContain('emailConfirmNoToken');
    await changeToken('new-token');
    expect(requests.map((r) => r.token)).toEqual(['new-token']);
    await act(async () => requests[0]!.resolve({ email: 'new@example.test' }));
    expect(container.textContent).toContain('new@example.test');
  });
  it('handles a replacement token and ignores an older response', async () => {
    await mount('old-token');
    await changeToken('new-token');
    expect(requests.map((r) => r.token)).toEqual(['old-token', 'new-token']);
    await act(async () => requests[1]!.resolve({ email: 'new@example.test' }));
    await act(async () => requests[0]!.reject(new Error('expired old token')));
    expect(container.textContent).toContain('new@example.test');
    expect(container.textContent).not.toContain('expired old token');
  });
  it('sends a token only once under StrictMode and repeated hash events', async () => {
    await mount('same-token');
    await changeToken('same-token');
    expect(requests.map((r) => r.token)).toEqual(['same-token']);
    await act(async () => requests[0]!.resolve({ email: 'same@example.test' }));
    expect(container.textContent).toContain('same@example.test');
    expect(fixtures.logout).toHaveBeenCalledTimes(1);
  });
  it('does not show an old success after the token is removed', async () => {
    await mount('old-token');
    await changeToken('');
    await act(async () => requests[0]!.resolve({ email: 'old@example.test' }));
    expect(container.textContent).toContain('emailConfirmNoToken');
    expect(container.textContent).not.toContain('old@example.test');
  });
});
