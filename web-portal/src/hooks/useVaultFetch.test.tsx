import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useVaultFetch } from './useVaultFetch';

const originalFetch = globalThis.fetch;

function stubFetch(impl: typeof fetch) {
  (globalThis as { fetch: typeof fetch }).fetch = impl;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
});

describe('useVaultFetch', () => {
  it('stays idle when path is null', () => {
    const { result } = renderHook(() => useVaultFetch<{ ok: true }>(null));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('fetches JSON and surfaces data on success', async () => {
    stubFetch(
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ value: 42 }),
      })) as unknown as typeof fetch,
    );

    const { result } = renderHook(() =>
      useVaultFetch<{ value: number }>('/api/test'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ value: 42 });
    expect(result.current.error).toBeNull();
  });

  it('treats non-ok responses as errors', async () => {
    stubFetch(
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );

    const { result } = renderHook(() =>
      useVaultFetch<unknown>('/api/fail'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toMatch(/HTTP 500/);
    expect(result.current.data).toBeNull();
  });

  it('aborts in-flight fetch on unmount (no cancelled update)', async () => {
    let aborted = false;
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
        // Never resolve unless aborted.
        void resolve;
      });
    });
    stubFetch(fetchMock as unknown as typeof fetch);

    const { unmount } = renderHook(() => useVaultFetch('/api/slow'));
    unmount();
    await waitFor(() => expect(aborted).toBe(true));
  });

  it('retry() re-runs the fetch', async () => {
    let calls = 0;
    stubFetch(
      vi.fn(async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ calls }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    );

    const { result } = renderHook(() =>
      useVaultFetch<{ calls: number }>('/api/retry'),
    );
    await waitFor(() => expect(result.current.data?.calls).toBe(1));

    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.data?.calls).toBe(2));
  });

  it('enabled=false keeps hook idle even with a path', () => {
    const fetchMock = vi.fn();
    stubFetch(fetchMock as unknown as typeof fetch);
    const { result } = renderHook(() =>
      useVaultFetch<unknown>('/api/x', { enabled: false }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });
});
