// Idempotency keys for creating operations ([I] in docs/API.md). A form keeps one key so a
// double click or a retry after a lost connection is applied once. The server stores every
// definite answer (2xx and 4xx) under the key and replays it for 24 hours, and refuses the key
// for a different request — so after a refusal the next submit (another employee, or the same
// one once the problem is fixed) needs a new key. The key is kept only while the outcome is
// unknown: no answer, a server error, or the first attempt still being processed.

import { ApiError } from '../services/http';

export const outcomeUnknown = (e: unknown) =>
  e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.code === 'IDEMPOTENCY_IN_PROGRESS');

/** The key for the next submit after `e`: the same while the outcome is unknown, otherwise a new one. */
export const keyAfterError = <K extends string>(key: K, e: unknown): K | ReturnType<Crypto['randomUUID']> => (outcomeUnknown(e) ? key : crypto.randomUUID());
