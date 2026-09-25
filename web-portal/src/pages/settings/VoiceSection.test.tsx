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
    // jsdom has no speech synthesis; without it the Voice Output toggle is
    // disabled. (These tests used the Browser STT toggle, which needed no
    // browser support, until in-browser STT was removed: WEB-15.)
    vi.stubGlobal('speechSynthesis', {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hydrates toggles from GET /api/settings/voice on mount', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(jsonResponse({ success: true }))
      return Promise.resolve(
        jsonResponse({ inputEnabled: false, outputEnabled: false }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VoiceSection />)

    // fetchJson() passes a second options arg (headers/cache), so assert on
    // the URL of the GET (non-POST) call rather than an exact two-arg match.
    expect(
      fetchMock.mock.calls.some(([url, init]) => url === '/api/settings/voice' && init?.method !== 'POST'),
    ).toBe(true)

    // Default outputEnabled is true (and the toggle is supported here), so
    // false proves server hydration won.
    await waitFor(() => {
      const switches = screen.getAllByRole('switch')
      expect(switches[0].getAttribute('aria-checked')).toBe('false')
      expect(switches[1].getAttribute('aria-checked')).toBe('false')
    })
  })

  it('syncs the Voice Output toggle to the backend via POST', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(jsonResponse({ success: true }))
      return Promise.resolve(
        jsonResponse({ inputEnabled: null, outputEnabled: null }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<VoiceSection />)

    const outputToggle = screen.getAllByRole('switch')[1]
    fireEvent.click(outputToggle)

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(postCall).toBeDefined()
      expect(postCall![0]).toBe('/api/settings/voice')
      const body = JSON.parse(String(postCall![1]?.body)) as Record<string, unknown>
      expect(body.outputEnabled).toBe(false)
    })
  })

  it('syncs exactly once per toggle under StrictMode', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(jsonResponse({ success: true }))
      return Promise.resolve(
        jsonResponse({ inputEnabled: null, outputEnabled: null }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <StrictMode>
        <VoiceSection />
      </StrictMode>,
    )

    const outputToggle = screen.getAllByRole('switch')[1]
    fireEvent.click(outputToggle)

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
    // Voice input and voice output; there is no in-browser STT toggle (WEB-15).
    expect(switches).toHaveLength(2)
    // Default: outputEnabled is true.
    expect(switches[1].getAttribute('aria-checked')).toBe('true')
  })
})
