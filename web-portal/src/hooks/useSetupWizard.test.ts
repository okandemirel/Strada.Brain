import { describe, expect, it } from 'vitest'
import {
  hasAutoEmbeddingCandidate,
  hasUsableEmbeddingCredential,
  hasUsableResponseCredential,
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
})
