import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  advanceSetupPollSession,
  applyOpencodeConfig,
  buildProviderModelDefaults,
  getSetupReviewBlockingReason,
  hasAutoEmbeddingCandidate,
  hasUsableEmbeddingCredential,
  hasUsableResponseCredential,
  isSetupPollSessionActive,
  probeSetupSurface,
  readSetupHealthStatus,
  readSetupBootstrapStatus,
  useSetupWizard,
  BUDGET_UNLIMITED,
} from './useSetupWizard'
import { OPENCODE_PLATFORM_BASE_URLS } from '../types/setup-constants'

describe('useSetupWizard helpers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepts OpenAI subscription for response providers only', () => {
    expect(hasUsableResponseCredential('openai', {}, { openai: 'chatgpt-subscription' })).toBe(true)
    expect(hasUsableEmbeddingCredential('openai', {})).toBe(false)
  })

  it('prefers preset model defaults and otherwise falls back to curated provider defaults', () => {
    // Comes from the backend's SYSTEM_PRESETS, which this file imports rather
    // than duplicating — so this expectation has to move when the preset does.
    expect(buildProviderModelDefaults(['claude'], 'performance')).toEqual({
      claude: 'claude-sonnet-5',
    })

    expect(buildProviderModelDefaults(['deepseek', 'gemini'], null)).toEqual({
      deepseek: 'deepseek-chat',
      gemini: 'gemini-3-flash-preview',
    })
  })

  it('requires a real embedding-capable provider for auto embedding mode', () => {
    expect(hasAutoEmbeddingCandidate(new Set(['kimi']), { kimi: 'sk-kimi' })).toBe(false)
    expect(hasAutoEmbeddingCandidate(new Set(['kimi', 'gemini']), { kimi: 'sk-kimi', gemini: 'gem-key' })).toBe(true)
    expect(hasAutoEmbeddingCandidate(new Set(['ollama']), {})).toBe(true)
  })

  it('explains why save is blocked when rag has no usable embedding provider', () => {
    expect(
      getSetupReviewBlockingReason(true, 'auto', new Set(['kimi']), { kimi: 'sk-kimi' }, {}),
    ).toContain('no embedding-capable provider')

    expect(
      getSetupReviewBlockingReason(
        true,
        'openai',
        new Set(['openai']),
        {},
        { openai: 'chatgpt-subscription' },
      ),
    ).toContain('does not cover embeddings')

    expect(
      getSetupReviewBlockingReason(true, 'gemini', new Set(['kimi']), {}, {}),
    ).toContain('Gemini embeddings need a usable API key')
  })

  it('threads the chosen OpenCode platform base URL and model into the config', () => {
    const config: Record<string, string> = {}
    applyOpencodeConfig(config, new Set(['opencode']), 'go', { opencode: 'qwen3.6-plus' })

    expect(config.OPENCODE_BASE_URL).toBe(OPENCODE_PLATFORM_BASE_URLS.go)
    expect(config.OPENCODE_DEFAULT_MODEL).toBe('qwen3.6-plus')
  })

  it('uses the Zen base URL by default for OpenCode', () => {
    const config: Record<string, string> = {}
    applyOpencodeConfig(config, new Set(['opencode']), 'zen', { opencode: 'qwen3.6-plus' })

    expect(config.OPENCODE_BASE_URL).toBe(OPENCODE_PLATFORM_BASE_URLS.zen)
    expect(config.OPENCODE_DEFAULT_MODEL).toBe('qwen3.6-plus')
  })

  it('does not write OpenCode env vars when OpenCode is not enabled', () => {
    const config: Record<string, string> = {}
    applyOpencodeConfig(config, new Set(['claude']), 'go', { claude: 'claude-sonnet-5' })

    expect(config.OPENCODE_BASE_URL).toBeUndefined()
    expect(config.OPENCODE_DEFAULT_MODEL).toBeUndefined()
  })

  it('detects a live setup surface from the csrf endpoint', async () => {
    const result = await probeSetupSurface(async (input) => {
      if (String(input) === '/api/setup/csrf') {
        return {
          ok: true,
          json: async () => ({ token: 'csrf-token' }),
        } as Response
      }
      throw new Error('unexpected fetch')
    })

    expect(result).toEqual({ kind: 'available', token: 'csrf-token' })
  })

  it('redirects when the main app is already healthy during setup handoff', async () => {
    const result = await probeSetupSurface(async (input) => {
      if (String(input) === '/api/setup/csrf') {
        throw new Error('setup server restarting')
      }
      if (String(input) === '/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' }),
        } as Response
      }
      throw new Error('unexpected fetch')
    })

    expect(result).toEqual({ kind: 'redirect' })
  })

  it('keeps waiting when configuration was already saved and backend is handing off', async () => {
    const result = await probeSetupSurface(async (input) => {
      if (String(input) === '/api/setup/csrf') {
        return {
          ok: false,
          status: 409,
          json: async () => ({ handoff: true }),
        } as Response
      }
      throw new Error('unexpected fetch')
    })

    expect(result).toEqual({ kind: 'retry' })
  })

  it('reads explicit setup bootstrap status during handoff', async () => {
    const result = await readSetupBootstrapStatus(async (input) => {
      if (String(input) === '/api/setup/status') {
        return {
          ok: true,
          json: async () => ({ state: 'booting', detail: 'Strada is starting.', readyUrl: 'http://127.0.0.1:3000/' }),
        } as Response
      }
      throw new Error('unexpected fetch')
    })

    expect(result).toEqual({ state: 'booting', detail: 'Strada is starting.', readyUrl: 'http://127.0.0.1:3000/' })
  })

  it('times out a hung setup status request instead of waiting forever', async () => {
    vi.useFakeTimers()

    const resultPromise = readSetupBootstrapStatus(async () => new Promise(() => {}) as Promise<Response>)

    await vi.advanceTimersByTimeAsync(3000)

    await expect(resultPromise).resolves.toBeNull()
  })

  it('times out a hung health request instead of waiting forever', async () => {
    vi.useFakeTimers()

    const resultPromise = readSetupHealthStatus(async () => new Promise(() => {}) as Promise<Response>)

    await vi.advanceTimersByTimeAsync(3000)

    await expect(resultPromise).resolves.toBeNull()
  })

  it('falls back to health checks when the csrf endpoint hangs', async () => {
    vi.useFakeTimers()

    const fetchImpl = vi.fn(async (input) => {
      if (String(input) === '/api/setup/csrf') {
        return new Promise(() => {}) as Promise<Response>
      }
      if (String(input) === '/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' }),
        } as Response
      }
      throw new Error('unexpected fetch')
    })

    const resultPromise = probeSetupSurface(fetchImpl)
    await vi.advanceTimersByTimeAsync(3000)

    await expect(resultPromise).resolves.toEqual({ kind: 'redirect' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('invalidates older bootstrap poll sessions after polling is stopped', () => {
    const firstSession = advanceSetupPollSession(0)
    expect(isSetupPollSessionActive(firstSession, firstSession, true)).toBe(true)

    const stoppedSession = advanceSetupPollSession(firstSession)
    expect(isSetupPollSessionActive(firstSession, stoppedSession, true)).toBe(false)

    const restartedSession = advanceSetupPollSession(stoppedSession)
    expect(isSetupPollSessionActive(firstSession, restartedSession, true)).toBe(false)
    expect(isSetupPollSessionActive(restartedSession, restartedSession, true)).toBe(true)
  })

  it('treats unmounted bootstrap poll sessions as inactive', () => {
    const activeSession = advanceSetupPollSession(0)
    expect(isSetupPollSessionActive(activeSession, activeSession, false)).toBe(false)
  })

  it('preserves provider warnings in setup bootstrap status responses', async () => {
    const result = await readSetupBootstrapStatus(async (input) => {
      if (String(input) === '/api/setup/status') {
        return {
          ok: true,
          json: async () => ({
            state: 'saved',
            detail: 'Configuration accepted.',
            providerWarnings: [{
              providerId: 'kimi',
              providerName: 'Kimi (Moonshot)',
              detail: 'Kimi (Moonshot) health check failed. Verify the credential and network access.',
            }],
          }),
        } as Response
      }
      throw new Error('unexpected fetch')
    })

    expect(result).toEqual({
      state: 'saved',
      detail: 'Configuration accepted.',
      providerWarnings: [{
        providerId: 'kimi',
        providerName: 'Kimi (Moonshot)',
        detail: 'Kimi (Moonshot) health check failed. Verify the credential and network access.',
      }],
    })
  })
})

describe('useSetupWizard daemon toggle (audit 10.1 / 10.6 / D25)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  function installFetchMock(existing?: { daemonEnabled?: boolean | null, globalDailyBudget?: number | null }) {
    const saves: Array<Record<string, string>> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/setup/csrf')) {
        return new Response(JSON.stringify({ token: 'csrf-1' }), { status: 200 })
      }
      if (url.startsWith('/api/setup/existing')) {
        return existing === undefined
          ? new Response('{}', { status: 404 })
          : new Response(JSON.stringify(existing), { status: 200 })
      }
      if (url === '/api/setup' && init?.method === 'POST') {
        saves.push(JSON.parse(String(init.body)) as Record<string, string>)
        return new Response(JSON.stringify({ success: true, readyUrl: '/' }), { status: 200 })
      }
      // Bootstrap polling after a save: report failure so the poller stops.
      if (url.startsWith('/api/setup/status')) {
        return new Response(JSON.stringify({ state: 'failed', detail: 'test stop' }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return saves
  }

  it('saves STRADA_DAEMON_ENABLED=true when the user never touched the toggle (runtime default is on)', async () => {
    const saves = installFetchMock()
    const { result, unmount } = renderHook(() => useSetupWizard())
    expect(result.current.daemonEnabled).toBe(true)
    act(() => { result.current.setRagEnabled(false) }) // no embedding provider needed to reach save
    await act(async () => { await result.current.save() })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.STRADA_DAEMON_ENABLED).toBe('true')
    unmount()
  })

  it('saves STRADA_DAEMON_ENABLED=false only after an explicit opt-out (guard)', async () => {
    const saves = installFetchMock()
    const { result, unmount } = renderHook(() => useSetupWizard())
    act(() => {
      result.current.setRagEnabled(false)
      result.current.setDaemonEnabled(false)
    })
    await act(async () => { await result.current.save() })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.STRADA_DAEMON_ENABLED).toBe('false')
    unmount()
  })

  it('hydrates the toggle from an existing STRADA_DAEMON_ENABLED=false and keeps it false when untouched (Codex review of 0-A.25)', async () => {
    const saves = installFetchMock({ daemonEnabled: false })
    const { result, unmount } = renderHook(() => useSetupWizard())
    await waitFor(() => expect(result.current.daemonEnabled).toBe(false))
    act(() => { result.current.setRagEnabled(false) })
    await act(async () => { await result.current.save() })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.STRADA_DAEMON_ENABLED).toBe('false')
    unmount()
  })

  it('falls back to the runtime default (on) when the key is absent from the existing config (guard)', async () => {
    const saves = installFetchMock({ daemonEnabled: null })
    const { result, unmount } = renderHook(() => useSetupWizard())
    await waitFor(() => expect(result.current.setupAvailability).toBe('available'))
    expect(result.current.daemonEnabled).toBe(true)
    act(() => { result.current.setRagEnabled(false) })
    await act(async () => { await result.current.save() })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.STRADA_DAEMON_ENABLED).toBe('true')
    unmount()
  })
})

describe('useSetupWizard global budget (Codex 2026-09-17 round 8 #12)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  function installFetchMock(existing?: { daemonEnabled?: boolean | null, globalDailyBudget?: number | null }) {
    const saves: Array<Record<string, string>> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/setup/csrf')) {
        return new Response(JSON.stringify({ token: 'csrf-1' }), { status: 200 })
      }
      if (url.startsWith('/api/setup/existing')) {
        return existing === undefined
          ? new Response('{}', { status: 404 })
          : new Response(JSON.stringify(existing), { status: 200 })
      }
      if (url === '/api/setup' && init?.method === 'POST') {
        saves.push(JSON.parse(String(init.body)) as Record<string, string>)
        return new Response(JSON.stringify({ success: true, readyUrl: '/' }), { status: 200 })
      }
      if (url.startsWith('/api/setup/status')) {
        return new Response(JSON.stringify({ state: 'failed', detail: 'test stop' }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return saves
  }

  it('says unlimited by name, not by omitting the key, once the person chose it', async () => {
    const saves = installFetchMock({ daemonEnabled: null, globalDailyBudget: null })
    const { result, unmount } = renderHook(() => useSetupWizard())
    act(() => {
      result.current.setRagEnabled(false)
      result.current.setGlobalDailyBudget(BUDGET_UNLIMITED)
    })
    expect(result.current.globalDailyBudget).toBe(BUDGET_UNLIMITED)
    await act(async () => { await result.current.save() })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!._budgetUnlimited).toBe('true')
    expect(saves[0]!.STRADA_BUDGET_DAILY_USD).toBeUndefined()
    unmount()
  })

  it('submits an explicit zero, so nothing may spend', async () => {
    // The slider used to read 0 as "unlimited": a person who wanted spending
    // frozen got no limit at all, and the key never left the portal.
    const saves = installFetchMock()
    const { result, unmount } = renderHook(() => useSetupWizard())
    act(() => {
      result.current.setRagEnabled(false)
      result.current.setGlobalDailyBudget(0)
    })
    expect(result.current.globalDailyBudget).toBe(0)
    await act(async () => { await result.current.save() })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.STRADA_BUDGET_DAILY_USD).toBe('0')
    expect(saves[0]!._budgetUnlimited).toBeUndefined()
    unmount()
  })

  it('submits a numeric limit verbatim', async () => {
    const saves = installFetchMock()
    const { result, unmount } = renderHook(() => useSetupWizard())
    act(() => {
      result.current.setRagEnabled(false)
      result.current.setGlobalDailyBudget(12)
    })
    await act(async () => { await result.current.save() })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.STRADA_BUDGET_DAILY_USD).toBe('12')
    unmount()
  })

  it('hydrates an existing zero and resends it, never lifting the limit', async () => {
    const saves = installFetchMock({ daemonEnabled: null, globalDailyBudget: 0 })
    const { result, unmount } = renderHook(() => useSetupWizard())
    await waitFor(() => expect(result.current.globalDailyBudget).toBe(0))
    act(() => { result.current.setRagEnabled(false) })
    await act(async () => { await result.current.save() })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.STRADA_BUDGET_DAILY_USD).toBe('0')
    unmount()
  })

  it('keeps a deliberate change over a late hydration (guard)', async () => {
    const saves = installFetchMock({ daemonEnabled: null, globalDailyBudget: 0 })
    const { result, unmount } = renderHook(() => useSetupWizard())
    act(() => {
      result.current.setRagEnabled(false)
      result.current.setGlobalDailyBudget(25)
    })
    await waitFor(() => expect(result.current.setupAvailability).toBe('available'))
    expect(result.current.globalDailyBudget).toBe(25)
    await act(async () => { await result.current.save() })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.STRADA_BUDGET_DAILY_USD).toBe('25')
    unmount()
  })

  it('reads an unlimited or absent budget back as unlimited (guard)', async () => {
    const saves = installFetchMock({ daemonEnabled: null, globalDailyBudget: null })
    const { result, unmount } = renderHook(() => useSetupWizard())
    await waitFor(() => expect(result.current.globalDailyBudgetKnown).toBe(true))
    expect(result.current.globalDailyBudget).toBe(BUDGET_UNLIMITED)
    act(() => { result.current.setRagEnabled(false) })
    await act(async () => { await result.current.save() })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!._budgetUnlimited).toBe('true')
    unmount()
  })
})

// =============================================================================
// ROUND 9 #16 — "we do not know yet" is not "unlimited"
//
// The slider starts at BUDGET_UNLIMITED, so a Save made before (or without) a
// successful /api/setup/existing explicitly asked for no limit: an existing
// STRADA_BUDGET_DAILY_USD=0 — the freeze that stops every system from
// spending — was silently lifted by a person who never touched the control.
// Until hydration succeeds the budget is UNKNOWN and Save says nothing about
// it, so the .env keeps whatever it has.
// =============================================================================
describe('useSetupWizard budget hydration failures (round 9 #16)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  /** `existing` describes what /api/setup/existing does: fail, hang, or answer. */
  function installFetchMock(existing: 'not-found' | 'rejected' | 'pending' | { daemonEnabled?: boolean | null, globalDailyBudget?: number | null }) {
    const saves: Array<Record<string, string>> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/setup/csrf')) {
        return new Response(JSON.stringify({ token: 'csrf-1' }), { status: 200 })
      }
      if (url.startsWith('/api/setup/existing')) {
        if (existing === 'not-found') return new Response('{}', { status: 500 })
        if (existing === 'rejected') throw new Error('network down')
        if (existing === 'pending') return await new Promise<Response>(() => { /* never settles */ })
        return new Response(JSON.stringify(existing), { status: 200 })
      }
      if (url === '/api/setup' && init?.method === 'POST') {
        saves.push(JSON.parse(String(init.body)) as Record<string, string>)
        return new Response(JSON.stringify({ success: true, readyUrl: '/' }), { status: 200 })
      }
      if (url.startsWith('/api/setup/status')) {
        return new Response(JSON.stringify({ state: 'failed', detail: 'test stop' }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return saves
  }

  for (const hydration of ['not-found', 'rejected', 'pending'] as const) {
    it(`sends no budget field at all when hydration is ${hydration}, so an existing zero survives`, async () => {
      const saves = installFetchMock(hydration)
      const { result, unmount } = renderHook(() => useSetupWizard())
      expect(result.current.globalDailyBudgetKnown).toBe(false)
      act(() => { result.current.setRagEnabled(false) })
      await act(async () => { await result.current.save() })
      await waitFor(() => expect(saves).toHaveLength(1))
      // Neither "unlimited" nor a number: the wizard does not know, so it says
      // nothing and the server keeps the configured limit.
      expect(saves[0]!._budgetUnlimited).toBeUndefined()
      expect(saves[0]!.STRADA_BUDGET_DAILY_USD).toBeUndefined()
      unmount()
    })
  }

  it('a deliberate choice is sent even while hydration hangs (guard)', async () => {
    const saves = installFetchMock('pending')
    const { result, unmount } = renderHook(() => useSetupWizard())
    act(() => {
      result.current.setRagEnabled(false)
      result.current.setGlobalDailyBudget(0)
    })
    expect(result.current.globalDailyBudgetKnown).toBe(true)
    await act(async () => { await result.current.save() })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.STRADA_BUDGET_DAILY_USD).toBe('0')
    unmount()
  })

  it('a successful hydration makes the budget known, and Save states it (guard)', async () => {
    const saves = installFetchMock({ daemonEnabled: null, globalDailyBudget: 7 })
    const { result, unmount } = renderHook(() => useSetupWizard())
    await waitFor(() => expect(result.current.globalDailyBudgetKnown).toBe(true))
    expect(result.current.globalDailyBudget).toBe(7)
    act(() => { result.current.setRagEnabled(false) })
    await act(async () => { await result.current.save() })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.STRADA_BUDGET_DAILY_USD).toBe('7')
    unmount()
  })
})
