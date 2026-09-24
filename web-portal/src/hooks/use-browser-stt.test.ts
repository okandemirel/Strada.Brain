import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useBrowserStt } from './use-browser-stt'
import { VOICE_STORAGE_KEY } from './use-voice-settings'

const originalWorker = globalThis.Worker

/** A worker whose script never loads: it reports `error`, the way a blocked or missing script does. */
class FailingWorker extends EventTarget {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  terminated = false

  postMessage(msg: { type: string }) {
    if (msg.type !== 'load') return
    setTimeout(() => {
      const event = new Event('error')
      this.onerror?.(event)
      this.dispatchEvent(event)
    }, 0)
  }

  terminate() {
    this.terminated = true
  }
}

function useWorker(value: unknown) {
  Object.defineProperty(globalThis, 'Worker', { value, configurable: true, writable: true })
}

/** Resolves to 'hung' when `promise` does not settle within `ms`. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'hung'> {
  return Promise.race([promise, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), ms))])
}

// WEB-4: the CSP blocked the portal's own module worker, and a worker that
// fails to load fires `error` rather than a message; waitForReady listened
// only for messages, so the recording hung in "transcribing" and was never
// sent, not even as the audio fallback.
describe('useBrowserStt when the worker cannot load (WEB-4)', () => {
  beforeEach(() => {
    window.localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify({ browserSttEnabled: true }))
  })

  afterEach(() => {
    window.localStorage.removeItem(VOICE_STORAGE_KEY)
    useWorker(originalWorker)
  })

  it('resolves transcribe() to null when the worker errors during load', async () => {
    useWorker(FailingWorker)
    const { result } = renderHook(() => useBrowserStt())
    expect(result.current.enabled).toBe(true)

    let outcome: string | null | 'hung' = 'hung'
    await act(async () => {
      outcome = await settleWithin(result.current.transcribe(new Blob(['x'])), 500)
    })
    expect(outcome).toBeNull()
    expect(result.current.status).toBe('error')
  })

  it('resolves transcribe() to null when the browser refuses to create the worker', async () => {
    useWorker(class {
      constructor() {
        throw new DOMException('blocked by CSP', 'SecurityError')
      }
    })
    const { result } = renderHook(() => useBrowserStt())

    let outcome: string | null | 'hung' = 'hung'
    await act(async () => {
      outcome = await settleWithin(result.current.transcribe(new Blob(['x'])), 500)
    })
    expect(outcome).toBeNull()
  })
})
