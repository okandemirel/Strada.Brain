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
