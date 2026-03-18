import { describe, expect, it } from 'vitest'
import {
  getSetupReviewBlockingReason,
  hasAutoEmbeddingCandidate,
  hasUsableEmbeddingCredential,
  hasUsableResponseCredential,
  probeSetupSurface,
} from './useSetupWizard'

describe('useSetupWizard helpers', () => {
  it('accepts OpenAI subscription for response providers only', () => {
    expect(hasUsableResponseCredential('openai', {}, { openai: 'chatgpt-subscription' })).toBe(true)
    expect(hasUsableEmbeddingCredential('openai', {})).toBe(false)
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
})
