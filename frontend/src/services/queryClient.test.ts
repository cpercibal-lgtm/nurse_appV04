// react-query pauses a save, without sending it and without an error, while the browser says it is
// offline (its default networkMode "online"). Safari / WebKit reports "offline" briefly and wrongly
// (network changes, the CI browser), so a Submit button then did nothing until an "online" event came
// — the flaky WebKit department step in ops/e2e. Decision D-1 says there is no offline queue: the
// request is always sent and the caller shows the server's answer, or "the server could not be reached".

import { MutationObserver, onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './http';
import { queryClient } from './queryClient';

afterEach(() => onlineManager.setOnline(true));

const PAUSED = Symbol('paused');
/** The promise's result, or PAUSED when it has not settled by then (a paused request never settles). */
const settles = <T>(p: Promise<T>) => Promise.race([p, new Promise<typeof PAUSED>((r) => setTimeout(() => r(PAUSED), 300))]);

describe('query client network mode', () => {
  it('sends a save even when the browser reports it is offline', async () => {
    onlineManager.setOnline(false);
    const send = vi.fn().mockResolvedValue('saved');
    const outcome = await settles(new MutationObserver(queryClient, { mutationFn: send }).mutate(undefined));
    expect(outcome).toBe('saved');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports a failed send to the caller instead of waiting for the network to return', async () => {
    onlineManager.setOnline(false);
    const down = new ApiError(0, 'NETWORK_ERROR', 'The server could not be reached. Check your connection and try again.');
    const outcome = await settles(new MutationObserver(queryClient, { mutationFn: () => Promise.reject(down) }).mutate(undefined).catch((e: unknown) => e));
    expect(outcome).toBe(down);
  });

  it('loads data even when the browser reports it is offline', async () => {
    onlineManager.setOnline(false);
    const load = vi.fn().mockResolvedValue({ items: [] });
    const outcome = await settles(queryClient.fetchQuery({ queryKey: ['network-mode-test'], queryFn: load }));
    expect(outcome).toEqual({ items: [] });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
