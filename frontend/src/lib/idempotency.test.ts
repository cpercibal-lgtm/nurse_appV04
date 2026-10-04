import { describe, expect, it } from 'vitest';
import { ApiError } from '../services/http';
import { keyAfterError } from './idempotency';

const KEY = '0b6f3e0e-8d1a-4c55-9a43-2b1f0c7d9e11';

describe('keyAfterError', () => {
  it('keeps the key while the outcome is unknown, so a retry is applied once', () => {
    expect(keyAfterError(KEY, new ApiError(0, 'NETWORK_ERROR', 'offline'))).toBe(KEY);
    expect(keyAfterError(KEY, new ApiError(500, 'INTERNAL_ERROR', 'boom'))).toBe(KEY);
    expect(keyAfterError(KEY, new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'busy'))).toBe(KEY);
  });

  it('takes a new key after a definite refusal, which the server would otherwise replay', () => {
    for (const e of [
      new ApiError(422, 'CREDENTIALS_BLOCK_RENEWAL', 'renew first'),
      new ApiError(409, 'EMPLOYEE_HAS_CONTRACT', 'has one'),
      new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'different request'),
      new ApiError(400, 'VALIDATION_FAILED', 'invalid'),
      new Error('not an API error'),
    ]) {
      const next = keyAfterError(KEY, e);
      expect(next).not.toBe(KEY);
      expect(next).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
