import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import VoiceSection from './VoiceSection'
import { VOICE_STORAGE_KEY } from '../../hooks/use-voice-settings'

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    json: () => Promise.resolve(data),
  } as Response
}

describe('VoiceSection', () => {
  beforeEach(() => {
    localStorage.removeItem(VOICE_STORAGE_KEY)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hydrates toggles from GET /api/settings/voice on mount', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(jsonResponse({ success: true }))
      return Promise.resolve(
        jsonResponse({ inputEnabled: false, outputEnabled: false, browserSttEnabled: true }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VoiceSection />)

    // fetchJson() passes a second options arg (headers/cache), so assert on
    // the URL of the GET (non-POST) call rather than an exact two-arg match.
    expect(
      fetchMock.mock.calls.some(([url, init]) => url === '/api/settings/voice' && init?.method !== 'POST'),
    ).toBe(true)

    // Default browserSttEnabled is false — true proves server hydration won.
    await waitFor(() => {
      const switches = screen.getAllByRole('switch')
      expect(switches[0].getAttribute('aria-checked')).toBe('false')
      expect(switches[1].getAttribute('aria-checked')).toBe('false')
      expect(switches[2].getAttribute('aria-checked')).toBe('true')
    })
  })

  it('syncs the Browser STT toggle to the backend via POST', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(jsonResponse({ success: true }))
      return Promise.resolve(
        jsonResponse({ inputEnabled: null, outputEnabled: null, browserSttEnabled: null }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VoiceSection />)

    const browserSttToggle = screen.getAllByRole('switch')[2]
    fireEvent.click(browserSttToggle)

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(postCall).toBeDefined()
      expect(postCall![0]).toBe('/api/settings/voice')
      const body = JSON.parse(String(postCall![1]?.body)) as Record<string, unknown>
      expect(body.browserSttEnabled).toBe(true)
    })
  })

  it('syncs exactly once per toggle under StrictMode', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(jsonResponse({ success: true }))
      return Promise.resolve(
        jsonResponse({ inputEnabled: null, outputEnabled: null, browserSttEnabled: null }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <StrictMode>
        <VoiceSection />
      </StrictMode>,
    )

    const browserSttToggle = screen.getAllByRole('switch')[2]
    fireEvent.click(browserSttToggle)

    const postCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
    await waitFor(() => {
      expect(postCalls()).toHaveLength(1)
    })
    // Flush pending microtasks so a StrictMode double-fired sync would surface.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(postCalls()).toHaveLength(1)
  })

  it('keeps local defaults and renders when hydration fails', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('offline')))
    vi.stubGlobal('fetch', fetchMock)

    render(<VoiceSection />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())

    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(3)
    // Default: browserSttEnabled is false (opt-in).
    expect(switches[2].getAttribute('aria-checked')).toBe('false')
  })
})
