import '@testing-library/jest-dom/vitest'
import './i18n'

// IntersectionObserver is not available in jsdom — mock it for components
// that use motion/react's useInView (BlurFade, TypingAnimation, NumberTicker, etc.)
class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
})

// ResizeObserver is not available in jsdom — mock it for useVirtualScroll.
// Immediately invoke the callback with a fake contentRect so virtual-scroll
// hooks see a non-zero container height and render items.
class MockResizeObserver {
  private callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }
  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { height: 600, width: 400 } } as unknown as ResizeObserverEntry],
      this,
    )
  }
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  configurable: true,
  value: MockResizeObserver,
})

// Node >= 22 exposes its own experimental `localStorage` global (no `.length`,
// no `.removeItem` without --localstorage-file) that shadows jsdom's; every
// component that reads storage failed under Node 26 (13 tests on 2026-09-17).
// Give every test a fresh, real Storage-like object on both window and
// globalThis.
import { beforeEach } from 'vitest'

const OWN_MOCK = Symbol('strada-test-storage')

function createStorageMock(): Storage {
  const store = new Map<string, string>()
  return {
    [OWN_MOCK]: true,
    get length() {
      return store.size
    },
    key(index: number) {
      return [...store.keys()][index] ?? null
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null
    },
    setItem(key: string, value: string) {
      store.set(key, String(value))
    },
    removeItem(key: string) {
      store.delete(key)
    },
    clear() {
      store.clear()
    },
  } as Storage
}

// Decided per test, so a file that installs its own mock at import time keeps it.
function storageIsBroken(): boolean {
  const current = (globalThis as { localStorage?: Partial<Storage> & { [OWN_MOCK]?: boolean } }).localStorage
  // A previous test's mock of ours is replaced too, so no state leaks between tests.
  if (current !== undefined && current[OWN_MOCK] === true) return true
  return current === undefined || typeof current.removeItem !== 'function' || typeof current.getItem !== 'function'
}

beforeEach(() => {
  if (!storageIsBroken()) return
  const storage = createStorageMock()
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true })
})
