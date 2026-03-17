import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchJsonError, fetchJson, firstSettledError, settledValue } from './api'

describe('fetchJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws FetchJsonError for non-ok HTTP responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(fetchJson('/api/test')).rejects.toMatchObject({
      name: 'FetchJsonError',
      message: 'nope',
      status: 503,
      url: '/api/test',
    } satisfies Partial<FetchJsonError>)
  })

  it('throws FetchJsonError for network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')))

    await expect(fetchJson('/api/test')).rejects.toMatchObject({
      message: 'socket hang up',
      url: '/api/test',
    } satisfies Partial<FetchJsonError>)
  })

  it('returns fulfilled values from settled results', () => {
    expect(settledValue({ status: 'fulfilled', value: { ok: true } })).toEqual({ ok: true })
    expect(settledValue({ status: 'rejected', reason: new Error('boom') })).toBeNull()
  })

  it('returns the first settled error message', () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: 'fulfilled', value: null },
      { status: 'rejected', reason: new Error('first failure') },
      { status: 'rejected', reason: new Error('second failure') },
    ]

    expect(firstSettledError(results)).toBe('first failure')
  })
})
