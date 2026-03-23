import '@testing-library/jest-dom/vitest'

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
