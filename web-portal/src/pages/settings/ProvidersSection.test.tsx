import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../../i18n'

// Identity-gated pattern (shared by Providers/Routing/Advanced): the section had
// no error branch and rendered empty chrome on failure. It now shows an error
// state once the (enabled) query fails.
vi.mock('../../hooks/useWS', () => ({
  useWS: () => ({ sessionId: 's1', profileId: 'p1' }),
}))

// PrimaryWorkerSelector fetches on mount; stub it so these tests focus on the
// model catalog rendering / refresh behaviour.
vi.mock('../../components/PrimaryWorkerSelector', () => ({
  default: () => null,
}))

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('ProvidersSection (error branch)', () => {
  it('renders an error state instead of empty chrome when the providers query fails', async () => {
    vi.resetModules()
    vi.doMock('../../hooks/use-api', () => ({
      useProviders: () => ({ data: undefined, error: new Error('boom') }),
      useRagStatus: () => ({ data: undefined }),
      useProviderModels: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
    }))
    const { default: ProvidersSection } = await import('./ProvidersSection')
    render(<ProvidersSection />, { wrapper: Wrapper })
    expect(screen.getByText(/load this section/i)).toBeTruthy()
    expect(screen.getByText('boom')).toBeTruthy()
  })
})

describe('ProvidersSection model catalog', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    vi.resetModules()
  })

  it('renders live models from the catalog and a stale hint; falls back to static options when a provider has no live models', async () => {
    vi.resetModules()
    const refetch = vi.fn()
    vi.doMock('../../hooks/use-api', () => ({
      useProviders: () => ({ data: { active: null, executionPool: [] }, error: null }),
      useRagStatus: () => ({ data: undefined }),
      useProviderModels: () => ({
        data: {
          providers: [
            { name: 'claude', models: ['claude-opus-live', 'claude-sonnet-live'], stale: true, fetchedAt: 1 },
            { name: 'openai', models: [] },
          ],
        },
        isLoading: false,
        error: null,
        refetch,
      }),
    }))
    const { default: ProvidersSection } = await import('./ProvidersSection')
    const { getProviderModelOptions } = await import('../../types/setup-constants')

    render(<ProvidersSection />, { wrapper: Wrapper })

    // Live models for claude are rendered.
    expect(screen.getByText('claude-opus-live')).toBeTruthy()
    expect(screen.getByText('claude-sonnet-live')).toBeTruthy()

    // A stale hint is shown for the claude provider.
    expect(screen.getAllByText(/stale/i).length).toBeGreaterThan(0)

    // openai has no live models, so it falls back to the static catalog.
    const staticOpenAi = getProviderModelOptions('openai')
    expect(staticOpenAi.length).toBeGreaterThan(0)
    expect(screen.getByText(staticOpenAi[0].model)).toBeTruthy()
  })

  it('Refresh button POSTs to the refresh route then refetches the catalog, with a loading state', async () => {
    vi.resetModules()
    const refetch = vi.fn().mockResolvedValue(undefined)
    const invalidateQueries = vi.fn()
    vi.doMock('@tanstack/react-query', async () => {
      const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
      return { ...actual, useQueryClient: () => ({ invalidateQueries }) }
    })
    vi.doMock('../../hooks/use-api', () => ({
      useProviders: () => ({ data: { active: null, executionPool: [] }, error: null }),
      useRagStatus: () => ({ data: undefined }),
      useProviderModels: () => ({
        data: { providers: [{ name: 'claude', models: ['claude-opus-live'] }] },
        isLoading: false,
        error: null,
        refetch,
      }),
    }))

    // Defer the POST so we can observe the loading state.
    let resolvePost: (v: Response) => void = () => {}
    const postPromise = new Promise<Response>((resolve) => { resolvePost = resolve })
    fetchSpy.mockReturnValueOnce(postPromise as unknown as Promise<Response>)

    const { default: ProvidersSection } = await import('./ProvidersSection')
    render(<ProvidersSection />, { wrapper: Wrapper })

    const button = screen.getByRole('button', { name: /refresh/i })
    fireEvent.click(button)

    // Loading state while the POST is in flight.
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true))

    resolvePost(new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    // POST hits the providers/models refresh route.
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith('/api/providers/models/refresh', expect.objectContaining({ method: 'POST' })),
    )
    // The catalog is refetched after the refresh completes.
    await waitFor(() => expect(refetch).toHaveBeenCalled())
    // Button returns to enabled state.
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  })
})
