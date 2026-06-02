/**
 * Tiny, testable feature-detection helper for the 3D office.
 *
 * The 3D scene is only enabled when:
 *   1. The browser can actually create a WebGL rendering context, and
 *   2. The user has NOT requested reduced motion.
 *
 * When either check fails we fall back to the 2D card grid. Keeping this in a
 * standalone module lets the page mock it in tests to force the (unit-tested)
 * fallback path without ever touching WebGL in jsdom.
 */

/** True when the user prefers reduced motion (a11y / vestibular safety). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** True when the browser can create a WebGL (or experimental-webgl) context. */
export function hasWebGLSupport(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    const gl =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')
    return gl != null
  } catch {
    return false
  }
}

/**
 * Whether the interactive 3D office should render. False if WebGL is
 * unavailable or the user prefers reduced motion — in which case the page
 * renders the 2D card fallback instead.
 */
export function isOffice3DEnabled(): boolean {
  if (prefersReducedMotion()) return false
  return hasWebGLSupport()
}
