// Pages are separate files whose names change with every release, and a release
// replaces them all (the old names answer 404). A tab opened before a release
// therefore cannot load a page it has not visited yet: the import fails, and
// without this React would leave a blank screen. Such a failure reloads the page
// once, which picks up the new release. A reload is attempted at most once per
// 30 seconds and never while the browser is offline, so a file that is really
// missing ends at the error screen (ErrorBoundary) instead of a reload loop.

const KEY = 'aigh-update-reload';
const WINDOW_MS = 30_000;

// Chromium, Firefox and Safari word the failure differently.
const STALE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** True for the error a browser gives when a page file of another release cannot be loaded. */
export function isStaleChunkError(err: unknown): boolean {
  return err instanceof Error && STALE.test(err.message);
}

interface ReloadDeps { storage: Pick<Storage, 'getItem' | 'setItem'> | null; online: boolean; now: number; reload: () => void }

function browserDeps(): ReloadDeps {
  let storage: ReloadDeps['storage'] = null;
  try { storage = window.sessionStorage; } catch { /* blocked site data: no automatic reload */ }
  return { storage, online: navigator.onLine, now: Date.now(), reload: () => window.location.reload() };
}

/** Reloads to pick up the new release, unless offline or already done in the last 30 s. Returns whether it reloads. */
export function reloadForUpdate(deps: ReloadDeps = browserDeps()): boolean {
  if (!deps.online || !deps.storage) return false;
  try {
    if (deps.now - Number(deps.storage.getItem(KEY) ?? 0) < WINDOW_MS) return false;
    deps.storage.setItem(KEY, String(deps.now));
  } catch {
    return false; // cannot remember the attempt, so do not risk a loop
  }
  deps.reload();
  return true;
}

/**
 * Wraps a lazy import (`lazy(freshImport(() => import('./Page')))`). A file of a
 * replaced release reloads the page once and stays pending meanwhile, so the
 * loading skeleton shows instead of an error. Prefetching on hover uses the bare
 * import and never reloads.
 */
export function freshImport<T>(load: () => Promise<T>, reload: () => boolean = reloadForUpdate): () => Promise<T> {
  return () => load().catch((err: unknown) => {
    if (isStaleChunkError(err) && reload()) return new Promise<T>(() => {});
    throw err;
  });
}
