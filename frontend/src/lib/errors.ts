import i18n from 'i18next';
import { ApiError } from '../services/http';

/** Someone else saved the record after it was opened (409): the screen reloads it; the user redoes their change. */
export const isStaleRecord = (e: unknown) => e instanceof ApiError && e.code === 'STALE_RECORD';

/** A message fit to show a user, with the request id when the server gave one (for support). */
export function describeApiError(e: unknown): string {
  if (isStaleRecord(e)) return i18n.t('staleRecord');
  if (e instanceof ApiError) {
    const details = Array.isArray(e.details)
      ? (e.details as Array<{ path?: string; message?: string }>).map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join('; ')
      : '';
    return [e.message, details, e.requestId ? `(ref ${e.requestId.slice(0, 8)})` : ''].filter(Boolean).join(' ');
  }
  return e instanceof Error ? e.message : String(e);
}
