import { describe, expect, it, vi } from 'vitest';
import { freshImport, isStaleChunkError, reloadForUpdate } from './freshImport';

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('a page file from a replaced release', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/assets/KpiPage-a1b2.js', // Chromium
    'error loading dynamically imported module: https://x/assets/KpiPage-a1b2.js', // Firefox
    'Importing a module script failed.', // Safari
    'Unable to preload CSS for /assets/KpiPage-a1b2.css', // Vite
  ])('is recognised: %s', (message) => {
    expect(isStaleChunkError(new TypeError(message))).toBe(true);
  });

  it('other errors are not', () => {
    expect(isStaleChunkError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isStaleChunkError('Failed to fetch dynamically imported module')).toBe(false); // not an Error
  });

  it('reloads once per 30 seconds, so a file that is really missing cannot loop', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadForUpdate({ storage, online: true, now: 1_000_000, reload })).toBe(true);
    expect(reloadForUpdate({ storage, online: true, now: 1_029_999, reload })).toBe(false);
    expect(reloadForUpdate({ storage, online: true, now: 1_030_000, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads offline, or when the attempt cannot be remembered', () => {
    const reload = vi.fn();
    expect(reloadForUpdate({ storage: memoryStorage(), online: false, now: 1, reload })).toBe(false);
    expect(reloadForUpdate({ storage: null, online: true, now: 1, reload })).toBe(false);
    const blocked = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(reloadForUpdate({ storage: blocked, online: true, now: 1, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('freshImport passes a loaded page through untouched', async () => {
    const page = { default: 'Page' };
    await expect(freshImport(async () => page, () => true)()).resolves.toBe(page);
  });

  it('freshImport reloads and stays pending (the skeleton shows) when the file is gone', async () => {
    const reload = vi.fn(() => true);
    const result = freshImport(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module: x')), reload)();
    const settled = await Promise.race([result.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 20))]);
    expect(settled).toBe('pending');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('freshImport rethrows when it may not reload, and for any other error', async () => {
    const stale = new TypeError('Failed to fetch dynamically imported module: x');
    await expect(freshImport(() => Promise.reject(stale), () => false)()).rejects.toBe(stale);
    const reload = vi.fn(() => true);
    const bug = new Error('a bug in the page');
    await expect(freshImport(() => Promise.reject(bug), reload)()).rejects.toBe(bug);
    expect(reload).not.toHaveBeenCalled();
  });
});
