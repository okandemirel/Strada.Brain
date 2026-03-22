import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { useConfig, useHealth, useTools } from './use-api'

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Disable refetchInterval in tests to avoid spurious refetches
        refetchInterval: false,
      },
    },
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client }, children)
  }
}

describe('use-api hooks', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('useConfig fetches /api/config successfully', async () => {
    const mockConfig = { config: { key: 'value' }, entries: [], summary: { core: 1, advanced: 2, experimental: 0 } }
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(mockConfig), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const { result } = renderHook(() => useConfig(), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(mockConfig)
    expect(fetchSpy).toHaveBeenCalledWith('/api/config', expect.objectContaining({
      headers: expect.objectContaining({ Accept: 'application/json' }),
    }))
  })

  it('useHealth fetches /health successfully', async () => {
    const mockHealth = { status: 'ok', timestamp: '2026-03-22T00:00:00Z', channel: 'web', uptime: 1000, clients: 2 }
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(mockHealth), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const { result } = renderHook(() => useHealth(), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(mockHealth)
  })

  it('handles fetch errors gracefully', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Internal Server Error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    }))

    const { result } = renderHook(() => useConfig(), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeTruthy()
    expect(result.current.data).toBeUndefined()
  })

  it('useTools fetches /api/tools successfully', async () => {
    const mockTools = { tools: [{ name: 'read', description: 'Read files', type: 'builtin' }] }
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(mockTools), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const { result } = renderHook(() => useTools(), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(mockTools)
  })

  it('handles network errors gracefully', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    const { result } = renderHook(() => useHealth(), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(Error)
  })
})
