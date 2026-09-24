import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { CoolMode } from './cool-mode'

const container = () => document.getElementById('_coolMode_effect')

/** jsdom has `ontouchstart`, so the component listens for touches, not the mouse. */
const tap = (element: HTMLElement) =>
  'ontouchstart' in window
    ? fireEvent.touchStart(element, { touches: [{ clientX: 40, clientY: 40 }] })
    : fireEvent.mouseDown(element, { clientX: 40, clientY: 40 })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CoolMode', () => {
  it('runs no animation loop while nothing is animating', () => {
    // It used to request a frame at mount and every frame after, at 60 fps,
    // for as long as the chat input was on screen.
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame')
    const { unmount } = render(<CoolMode><button>Send</button></CoolMode>)
    expect(raf).not.toHaveBeenCalled()
    unmount()
  })

  it('animates from a tap, and an unmount cancels the frame and removes every particle at once', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame')
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame')
    const { getByText, unmount } = render(<CoolMode options={{ particle: '✦' }}><button>Send</button></CoolMode>)
    tap(getByText('Send'))
    expect(raf).toHaveBeenCalledTimes(1)
    const frame = raf.mock.results[0]?.value as number
    expect(container()).not.toBeNull()

    unmount()

    expect(cancel).toHaveBeenCalledWith(frame)
    expect(container()).toBeNull()
  })

  it('leaves no timer behind an unmount, even where cancelAnimationFrame does not exist', () => {
    // A torn-down jsdom has no cancelAnimationFrame: the old 500 ms cleanup
    // interval fired after teardown and threw, failing the portal test run.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.stubGlobal('cancelAnimationFrame', undefined)
    const { getByText, unmount } = render(<CoolMode><button>Send</button></CoolMode>)
    tap(getByText('Send'))

    // The frame in flight cannot be cancelled here, but the unmount must not
    // schedule anything of its own, and nothing left may throw when it runs.
    const pending = vi.getTimerCount()
    expect(() => unmount()).not.toThrow()
    expect(vi.getTimerCount()).toBeLessThanOrEqual(pending)
    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow()
    expect(container()).toBeNull()
  })

  it('an inline options literal does not restart the effect on every render', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame')
    const { getByText, rerender, unmount } = render(
      <CoolMode options={{ particle: '✦', speedUp: 18 }}><button>Send</button></CoolMode>,
    )
    tap(getByText('Send'))
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame')
    // The parent re-renders (a keystroke in the chat input) with an equal, new object.
    rerender(<CoolMode options={{ particle: '✦', speedUp: 18 }}><button>Send</button></CoolMode>)
    expect(cancel).not.toHaveBeenCalled()
    expect(raf).toHaveBeenCalledTimes(1)
    unmount()
  })
})
