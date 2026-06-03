import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { useProviderModels } from './use-api'

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchInterval: false,
      },
    },
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client }, children)
  }
}

describe('useProviderModels', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('fetches the live model catalog from /api/providers/models', async () => {
    const mockCatalog = {
      providers: [
        { name: 'claude', models: ['claude-opus', 'claude-sonnet'], stale: false, fetchedAt: 123 },
        { name: 'openai', models: ['gpt-5'], stale: true },
      ],
    }
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(mockCatalog), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const { result } = renderHook(() => useProviderModels(), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(mockCatalog)
    expect(fetchSpy).toHaveBeenCalledWith('/api/providers/models', expect.objectContaining({
      headers: expect.objectContaining({ Accept: 'application/json' }),
    }))
  })

  it('surfaces errors from the catalog endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Internal Server Error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    }))

    const { result } = renderHook(() => useProviderModels(), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  })
})
