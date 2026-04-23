import { useCallback, useEffect, useState } from 'react';

export interface UseVaultFetchOptions {
  /**
   * Gate the request without unmounting the component. When false the hook
   * stays idle (`data === null`, `loading === false`). Defaults to true.
   */
  enabled?: boolean;
}

export interface UseVaultFetchResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** Manually re-fetch; bumps an internal counter so the effect re-runs. */
  retry: () => void;
}

/**
 * Minimal JSON fetch hook scoped to vault endpoints (and safe for any JSON
 * API). Consolidates the repeated AbortController + try/catch pattern that
 * used to live in `VaultsPage`, `RightPanel`, `FileTreeSidebar`, etc.
 *
 *   - `path === null` → idle (no fetch, no loading).
 *   - Aborts in-flight requests on unmount / path change / retry.
 *   - Surfaces both HTTP failures (`HTTP <status>`) and JSON parse errors.
 *   - `retry()` re-runs the effect manually without otherwise disturbing state.
 *
 * Type param `T` is the expected JSON shape — the hook does not validate it;
 * callers should treat data as `unknown` at runtime if they need more safety.
 */
export function useVaultFetch<T>(
  path: string | null,
  options: UseVaultFetchOptions = {},
): UseVaultFetchResult<T> {
  const enabled = options.enabled ?? true;
  const active = enabled && path !== null;

  const [data, setData] = useState<T | null>(null);
  // Initialize `loading = active` so consumers never see a false-negative
  // loading flag during the render that kicks off the initial fetch.
  const [loading, setLoading] = useState(active);
  const [error, setError] = useState<Error | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  // Reset transient state during render when the key changes so the UI never
  // displays stale data from the previous path while a new fetch is in-flight.
  const key = `${path ?? '∅'}::${retryCount}::${active ? '1' : '0'}`;
  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setData(null);
    setError(null);
    setLoading(active);
  }

  useEffect(() => {
    if (!active || path === null) return;
    const ctrl = new AbortController();
    let cancelled = false;

    fetch(path, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<T>;
      })
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const e = err as Error;
        if (e && e.name === 'AbortError') return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [active, path, retryCount]);

  const retry = useCallback(() => {
    setRetryCount((n) => n + 1);
  }, []);

  return { data, loading, error, retry };
}
