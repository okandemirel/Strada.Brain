import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../i18n'
import { PrimaryWorkerSelectorSurface } from './PrimaryWorkerSelector'

describe('PrimaryWorkerSelectorSurface', () => {
  it('renders the active provider and nested model choices', () => {
    const html = renderToStaticMarkup(
      <PrimaryWorkerSelectorSurface
        providers={[
          {
            name: 'Claude',
            configured: true,
            models: ['claude-haiku-4-5', 'claude-sonnet-5'],
            contextWindow: 1000000,
            thinkingSupported: true,
          },
        ]}
        active={{ provider: 'Claude', model: 'claude-sonnet-5' }}
        open
        loading={false}
        modelsLoading={false}
        expandedProvider="Claude"
        onToggleOpen={() => {}}
        onProviderClick={() => {}}
        onModelSelect={() => {}}
      />,
    )

    expect(html).toContain('Claude/claude-sonnet-5')
    expect(html).toContain('Claude')
    expect(html).toContain('claude-haiku-4-5')
    expect(html).toContain('claude-sonnet-5')
  })
})

// --- Full PrimaryWorkerSelector wiring (live catalog model source) ---

const switchProvider = vi.fn(() => true)

vi.mock('../hooks/useWS', () => ({
  useWS: () => ({ switchProvider, sessionId: 's1', profileId: 'p1' }),
}))

// The catalog hook is the model source. Tests override its return per case.
const useProviderModelsMock = vi.fn()
vi.mock('../hooks/use-api', () => ({
  useProviderModels: () => useProviderModelsMock(),
}))

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

// /api/providers/available returns ALL providers (configured + not); the
// switcher must only show configured ones. /api/providers/active returns the
// active selection. The catalog (/api/providers/models) is the MODEL source.
function mockAvailableAndActive(options?: {
  active?: { provider: string; model?: string } | null
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith('/api/providers/available')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            providers: [
              { name: 'claude', configured: true },
              { name: 'openai', configured: true },
              { name: 'gemini', configured: false }, // present in catalog but NOT configured
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }
    if (url.startsWith('/api/providers/active')) {
      return Promise.resolve(
        new Response(JSON.stringify({ active: options?.active ?? null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`))
  })
}

describe('PrimaryWorkerSelector (live catalog model source)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    switchProvider.mockClear()
    useProviderModelsMock.mockReset()
    // Default catalog: claude has two models, openai one, gemini (unconfigured) two.
    useProviderModelsMock.mockReturnValue({
      data: {
        providers: [
          { name: 'claude', models: ['claude-opus-live', 'claude-sonnet-live'] },
          { name: 'openai', models: ['gpt-live'] },
          { name: 'gemini', models: ['gemini-live-a', 'gemini-live-b'] },
        ],
      },
      isLoading: false,
      isFetching: false,
    })
    fetchSpy = mockAvailableAndActive()
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    vi.resetModules()
  })

  // The selector renders nothing until configured providers resolve; only the
  // trigger button (by title) is visible before the dropdown opens. Helper:
  // mount, wait for the trigger, click it to open, return the trigger.
  async function openSelector() {
    const trigger = await screen.findByTitle(/primary worker|worker/i)
    fireEvent.click(trigger)
    return trigger
  }

  it('renders configured providers with models sourced from the catalog, NOT from /available?withModels=true', async () => {
    const { default: PrimaryWorkerSelector } = await import('./PrimaryWorkerSelector')
    render(<PrimaryWorkerSelector />, { wrapper: Wrapper })

    await openSelector()

    // Configured providers appear, then expanding one reveals its catalog models.
    const claudeBtn = await screen.findByText('claude')
    fireEvent.click(claudeBtn)
    await waitFor(() => expect(screen.getByText('claude-opus-live')).toBeTruthy())
    expect(screen.getByText('claude-sonnet-live')).toBeTruthy()

    // No bespoke withModels fetch was ever issued — the catalog is the source.
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('withModels=true'))).toBe(false)
  })

  it('does NOT show a provider present in the catalog but not configured', async () => {
    const { default: PrimaryWorkerSelector } = await import('./PrimaryWorkerSelector')
    render(<PrimaryWorkerSelector />, { wrapper: Wrapper })

    await openSelector()

    // gemini is in the catalog but NOT configured → must not be rendered.
    await waitFor(() => expect(screen.getByText('openai')).toBeTruthy())
    expect(screen.queryByText('gemini')).toBeNull()
    expect(screen.queryByText('gemini-live-a')).toBeNull()
  })

  it('selecting a model calls switchProvider(name, model)', async () => {
    const { default: PrimaryWorkerSelector } = await import('./PrimaryWorkerSelector')
    render(<PrimaryWorkerSelector />, { wrapper: Wrapper })

    await openSelector()

    // claude has >1 model → clicking expands the submenu.
    const claudeBtn = await screen.findByText('claude')
    fireEvent.click(claudeBtn)

    const modelBtn = await screen.findByText('claude-sonnet-live')
    fireEvent.click(modelBtn)

    expect(switchProvider).toHaveBeenCalledWith('claude', 'claude-sonnet-live')
  })

  it('clicking a single-model provider calls switchProvider(name) directly', async () => {
    const { default: PrimaryWorkerSelector } = await import('./PrimaryWorkerSelector')
    render(<PrimaryWorkerSelector />, { wrapper: Wrapper })

    await openSelector()

    // openai has exactly one catalog model → clicking switches directly.
    const openaiBtn = await screen.findByText('openai')
    fireEvent.click(openaiBtn)

    expect(switchProvider).toHaveBeenCalledWith('openai')
  })

  it('reflects the catalog hook loading state when the dropdown is open', async () => {
    useProviderModelsMock.mockReturnValue({ data: undefined, isLoading: true, isFetching: true })
    const { default: PrimaryWorkerSelector } = await import('./PrimaryWorkerSelector')
    render(<PrimaryWorkerSelector />, { wrapper: Wrapper })

    await openSelector()

    await waitFor(() => expect(screen.getByText(/loading models/i)).toBeTruthy())
  })
})
