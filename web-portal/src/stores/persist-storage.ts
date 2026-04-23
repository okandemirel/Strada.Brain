import { createJSONStorage, type PersistStorage } from 'zustand/middleware';

/**
 * SSR-/sandbox-safe JSON persistence adapter for Zustand's `persist` middleware.
 *
 * Wraps `localStorage` behind a lazy one-shot probe so the first write attempt
 * determines whether the real storage is usable; if the probe throws (SSR,
 * Safari private mode, 3rd-party iframes, strict-cookie sandboxes) we fall
 * back to an in-memory Map. Methods are exposed as own properties because
 * Zustand's persist middleware reads them directly from the returned object;
 * jsdom's `localStorage` sometimes exposes them only on the prototype.
 *
 * Previously this logic lived inline in `vault-store.ts` (50+ lines). Keeping
 * it here lets us re-use it across stores and unit-test it independently.
 */
export function createSafeJSONStorage<T>(): PersistStorage<T> {
  return createJSONStorage<T>(() => {
    const mem = new Map<string, string>();
    let lsResolved = false;
    let ls: Storage | null = null;

    const resolveLs = (): Storage | null => {
      if (lsResolved) return ls;
      lsResolved = true;
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          // Probe that setItem actually works (throws in some sandboxes).
          window.localStorage.setItem('__strada_probe__', '1');
          window.localStorage.removeItem('__strada_probe__');
          ls = window.localStorage;
        }
      } catch { ls = null; }
      return ls;
    };

    return {
      getItem: (name: string): string | null => {
        const handle = resolveLs();
        try {
          if (handle) return handle.getItem(name);
        } catch { /* fall through to memory */ }
        return mem.get(name) ?? null;
      },
      setItem: (name: string, value: string): void => {
        const handle = resolveLs();
        try {
          if (handle) { handle.setItem(name, value); return; }
        } catch { /* fall through to memory */ }
        mem.set(name, value);
      },
      removeItem: (name: string): void => {
        const handle = resolveLs();
        try {
          if (handle) { handle.removeItem(name); return; }
        } catch { /* fall through to memory */ }
        mem.delete(name);
      },
    };
  }) as PersistStorage<T>;
}
