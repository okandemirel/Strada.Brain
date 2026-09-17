/**
 * Codex round 13 #7 — THE OWNER OF A SHARED INSTANCE MUST KEEP WORKING.
 *
 * One daemon serves more than one browser, and only the instance OWNER may write
 * settings, control the daemon or decide a change review. The identity is a
 * verified pair (`x-strada-profile-id` / `x-strada-profile-token`) and the portal
 * sent it over the WebSocket only — so every HTTP call was anonymous. The moment
 * a second browser appeared, the owner's own settings page started answering 403:
 * a security model that locked out the person it was protecting.
 *
 * These tests are about both halves of that: the pair IS attached, and it is
 * attached everywhere (including the modules that call `fetch` directly, which is
 * what the last test in this file enforces for every future caller too).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { apiFetch, fetchJson, isSameOriginApiRequest, readSessionCredentials } from './api'

const OWNER = { profileId: 'owner-profile-1', profileToken: 'token-of-owner' }

function storeCredentials(credentials: { profileId: string; profileToken: string }): void {
  localStorage.setItem('strada-profileId', credentials.profileId)
  localStorage.setItem('strada-profileToken', credentials.profileToken)
}

function lastRequestHeaders(mock: ReturnType<typeof vi.fn>): Headers {
  const init = mock.mock.calls.at(-1)?.[1] as RequestInit | undefined
  return new Headers(init?.headers ?? {})
}

describe('the portal attaches its verified session to its own API calls', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('sends the pair on a settings write — the owner-only request that used to 403', async () => {
    storeCredentials(OWNER)

    await fetchJson('/api/settings/env', {
      method: 'POST',
      body: JSON.stringify({ ANTHROPIC_API_KEY: 'sk-owner' }),
    })

    const headers = lastRequestHeaders(fetchMock)
    expect(headers.get('x-strada-profile-id')).toBe(OWNER.profileId)
    expect(headers.get('x-strada-profile-token')).toBe(OWNER.profileToken)
    // …and does not lose what fetchJson already set.
    expect(headers.get('Accept')).toBe('application/json')
  })

  it('sends it through the direct-fetch path as well', async () => {
    storeCredentials(OWNER)
    await apiFetch('/api/daemon/stop', { method: 'POST' })
    const headers = lastRequestHeaders(fetchMock)
    expect(headers.get('x-strada-profile-id')).toBe(OWNER.profileId)
    expect(headers.get('x-strada-profile-token')).toBe(OWNER.profileToken)
  })

  it('sends it on reads too, so a read is scoped to the caller and not to a guess', async () => {
    storeCredentials(OWNER)
    await apiFetch('/api/workspace/history')
    expect(lastRequestHeaders(fetchMock).get('x-strada-profile-id')).toBe(OWNER.profileId)
  })

  it('sends nothing when this browser holds no pair, or only half of one', async () => {
    await apiFetch('/api/settings/env', { method: 'POST' })
    expect(lastRequestHeaders(fetchMock).has('x-strada-profile-id')).toBe(false)

    // An id without its token proves nothing and the server refuses a half pair.
    localStorage.setItem('strada-profileId', OWNER.profileId)
    await apiFetch('/api/settings/env', { method: 'POST' })
    expect(lastRequestHeaders(fetchMock).has('x-strada-profile-id')).toBe(false)
    expect(readSessionCredentials()).toBeNull()
  })

  it('never leaks the session token off this origin', async () => {
    storeCredentials(OWNER)

    for (const url of [
      'https://evil.example.com/api/settings/env',
      '//evil.example.com/api/settings/env',
      'http://127.0.0.1:9999/api/daemon/stop',
    ]) {
      await apiFetch(url, { method: 'POST' })
      expect(lastRequestHeaders(fetchMock).has('x-strada-profile-token'), url).toBe(false)
    }

    // Its own origin, spelled absolutely, still gets the pair.
    await apiFetch(`${window.location.origin}/api/settings/env`, { method: 'POST' })
    expect(lastRequestHeaders(fetchMock).get('x-strada-profile-token')).toBe(OWNER.profileToken)
  })

  it('leaves non-API requests alone', async () => {
    storeCredentials(OWNER)
    await apiFetch('/index.html')
    expect(lastRequestHeaders(fetchMock).has('x-strada-profile-id')).toBe(false)
    expect(isSameOriginApiRequest('/assets/app.js')).toBe(false)
    expect(isSameOriginApiRequest('/api/config')).toBe(true)
  })

  it('lets an explicit header win over the stored pair', async () => {
    storeCredentials(OWNER)
    await apiFetch('/api/settings/env', {
      method: 'POST',
      headers: { 'x-strada-profile-id': 'someone-else', 'x-strada-profile-token': 'their-token' },
    })
    expect(lastRequestHeaders(fetchMock).get('x-strada-profile-id')).toBe('someone-else')
  })
})

/**
 * THE GUARD THAT KEEPS #7 CLOSED. Attaching the credentials centrally is only
 * worth anything if every caller goes through the centre: a single
 * `fetch('/api/…')` somewhere in the portal is an unattributed request and, on a
 * shared instance, a 403 the user cannot explain. This walks the source and fails
 * on one — including one added next month.
 */
describe('no portal module calls the API without the session', () => {
  const portalSrc = join(__dirname, '..')

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        out.push(...sourceFiles(full))
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue
      if (/\.test\.(ts|tsx)$/.test(entry)) continue
      // api.ts is the centre: it is the one place that may call fetch.
      if (full === join(portalSrc, 'utils', 'api.ts')) continue
      out.push(full)
    }
    return out
  }

  // Any bare call, not only a literal /api path: half of the callers build their
  // URL from a variable or a base, and those are exactly the ones a narrower
  // check would miss.
  it('finds no bare fetch() call anywhere in the portal', () => {
    const bare = /(?<![.\w])fetch\(/
    const offenders: string[] = []

    for (const file of sourceFiles(portalSrc)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        const trimmed = line.trim()
        // Prose about fetch is not a call to it.
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
        if (bare.test(line)) offenders.push(`${file.slice(portalSrc.length + 1)}:${index + 1}: ${trimmed}`)
      })
    }

    expect(offenders, `use apiFetch (utils/api) so the request carries this browser's identity:\n${offenders.join('\n')}`)
      .toEqual([])
  })
})
