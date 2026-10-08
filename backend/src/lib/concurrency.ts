// Optimistic concurrency for edits (QA checklist DB-03, finding F5). A screen
// sends the version of the record it loaded — its updatedAt, as an HTTP
// If-Match entity tag — and the service, holding the row with SELECT … FOR
// UPDATE, refuses the change with 409 STALE_RECORD when someone changed the
// record since. Without the header the edit is applied as before (callers that
// load and save in one step); the application's screens always send it.

import type { Request } from 'express';
import { HttpError } from './http-errors.js';

/** The version the caller loaded, or null when it sent none. `If-Match: "2026-10-08T11:19:39.123Z"` (W/ allowed). */
export function ifMatch(req: Request): Date | null {
  const raw = req.get('If-Match')?.trim();
  if (!raw) return null;
  const tag = raw.replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
  const at = new Date(tag);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(tag) || Number.isNaN(at.getTime())) {
    throw new HttpError(400, 'IF_MATCH_INVALID', 'If-Match must be the record version you loaded: its updatedAt in quotes');
  }
  return at;
}

/**
 * Refuses a change to a record that is no longer the version the caller loaded. Call it after locking the row
 * (FOR UPDATE) in the same transaction, so no other edit can slip in between the check and the write.
 * Versions compare to the millisecond, the precision the API returns.
 */
export function assertUnchanged(expected: Date | null, current: { updatedAt: Date }) {
  if (expected && expected.getTime() !== current.updatedAt.getTime()) {
    throw new HttpError(409, 'STALE_RECORD', 'Someone else changed this record after you opened it. Reload it, check their change, then make yours again.', { currentVersion: current.updatedAt.toISOString() });
  }
}
