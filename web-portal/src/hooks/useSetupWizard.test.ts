import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  advanceSetupPollSession,
  buildProviderModelDefaults,
  getSetupReviewBlockingReason,
  hasAutoEmbeddingCandidate,
  hasUsableEmbeddingCredential,
  hasUsableResponseCredential,
  isSetupPollSessionActive,
  probeSetupSurface,
  readSetupHealthStatus,
  readSetupBootstrapStatus,
} from './useSetupWizard'

describe('useSetupWizard helpers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepts OpenAI subscription for response providers only', () => {
    expect(hasUsableResponseCredential('openai', {}, { openai: 'chatgpt-subscription' })).toBe(true)
    expect(hasUsableEmbeddingCredential('openai', {})).toBe(false)
  })

  it('prefers preset model defaults and otherwise falls back to curated provider defaults', () => {
    expect(buildProviderModelDefaults(['claude'], 'performance')).toEqual({
      claude: 'claude-sonnet-4-6-20250514',
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
