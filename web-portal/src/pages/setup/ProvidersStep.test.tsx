import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import ProvidersStep from './ProvidersStep'
import { OPENCODE_PLATFORM_BASE_URLS } from '../../types/setup-constants'

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

function baseProps(overrides: Partial<React.ComponentProps<typeof ProvidersStep>> = {}) {
  return {
    selectedPreset: null,
    selectPreset: vi.fn(),
    checkedProviders: new Set<string>(['deepseek']),
    toggleProvider: vi.fn(),
    providerKeys: { deepseek: 'sk-deepseek-key' },
    providerAuthModes: {},
    providerModels: {},
    setProviderKey: vi.fn(),
    setProviderAuthMode: vi.fn(),
    setProviderModel: vi.fn(),
    opencodePlatform: 'zen' as const,
    setOpencodePlatform: vi.fn(),
    openaiSubscription: { status: 'idle' as const },
    signInWithChatGpt: vi.fn(async () => {}),
    refreshOpenAiSubscriptionStatus: vi.fn(async () => true),
    onNext: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  }
}

describe('ProvidersStep live model probe', () => {
  let calls: FetchCall[]

  beforeEach(() => {
    calls = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function stubFetch(handler: (call: FetchCall) => unknown) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url: String(url), init }
      calls.push(call)
      const body = handler(call)
      return { ok: true, json: async () => body } as Response
    }))
  }

  it('fetches live models via POST with the key in the body (never the URL)', async () => {
    stubFetch(() => ({ providers: [{ name: 'deepseek', models: ['deepseek-live-model'] }] }))

    render(<ProvidersStep {...baseProps()} />)

    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/providers/models')).toBe(true)
    })

    const probeCall = calls.find((c) => c.url === '/api/providers/models')
    expect(probeCall).toBeDefined()
    expect(probeCall?.init?.method).toBe('POST')
    // Key must NOT appear in the URL
    expect(probeCall?.url).not.toContain('sk-deepseek-key')
    // Key MUST be in the POST body
    const parsedBody = JSON.parse(String(probeCall?.init?.body))
    expect(parsedBody.provider).toBe('deepseek')
    expect(parsedBody.key).toBe('sk-deepseek-key')

    // The live model appears in the dropdown (model-id cell within a model card)
    await waitFor(() => {
      const cells = screen.getAllByText('deepseek-live-model')
      expect(cells.some((el) => el.className.includes('provider-model-id'))).toBe(true)
    })

    // Indicator marks the source as live
    expect(screen.getByText('live')).toBeInTheDocument()
  })

  it('falls back to the static model list when the probe returns no providers', async () => {
    stubFetch(() => ({ providers: [] }))

    render(<ProvidersStep {...baseProps()} />)

    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/providers/models')).toBe(true)
    })

    // Static DeepSeek catalog includes deepseek-chat (rendered in a model-id cell)
    await waitFor(() => {
      const cells = screen.getAllByText('deepseek-chat')
      expect(cells.some((el) => el.className.includes('provider-model-id'))).toBe(true)
    })

    // Indicator marks the source as the default/static list
    expect(screen.getByText('default list')).toBeInTheDocument()
  })

  it('includes the chosen OpenCode platform baseUrl in the probe body', async () => {
    stubFetch(() => ({ providers: [] }))

    render(
      <ProvidersStep
        {...baseProps({
          checkedProviders: new Set(['opencode']),
          providerKeys: { opencode: 'sk-opencode-key' },
          opencodePlatform: 'go',
        })}
      />,
    )

    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/providers/models')).toBe(true)
    })

    const probeCall = calls.find((c) => c.url === '/api/providers/models')
    const parsedBody = JSON.parse(String(probeCall?.init?.body))
    expect(parsedBody.provider).toBe('opencode')
    expect(parsedBody.baseUrl).toBe(OPENCODE_PLATFORM_BASE_URLS.go)
  })

  it('does not probe a provider that has no key entered', async () => {
    stubFetch(() => ({ providers: [] }))

    render(
      <ProvidersStep
        {...baseProps({
          checkedProviders: new Set(['deepseek']),
          providerKeys: {},
        })}
      />,
    )

    // Give effects a chance to run
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 50))

    expect(calls.some((c) => c.url === '/api/providers/models')).toBe(false)
  })

  it('renders the OpenCode Zen/Go toggle when OpenCode is enabled', async () => {
    stubFetch(() => ({ providers: [] }))

    render(
      <ProvidersStep
        {...baseProps({
          checkedProviders: new Set(['opencode']),
          providerKeys: { opencode: 'sk-opencode-key' },
        })}
      />,
    )

    await waitFor(() => {
      const toggle = screen.getByRole('group')
      const buttons = toggle.querySelectorAll('button')
      const labels = Array.from(buttons).map((b) => b.textContent?.trim())
      expect(labels).toEqual(['Zen', 'Go'])
    })
  })
})
