import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTheme } from './useTheme'

describe('useTheme', () => {
  let storage: Record<string, string>

  beforeEach(() => {
    storage = {}
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => { storage[key] = value }),
      removeItem: vi.fn((key: string) => { delete storage[key] }),
    })
    // Mock document.documentElement.setAttribute
    vi.spyOn(document.documentElement, 'setAttribute').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('defaults to dark theme', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('dark')
  })

  it('toggles between dark and light', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('dark')

    act(() => {
      result.current.toggleTheme()
    })
    expect(result.current.theme).toBe('light')

    act(() => {
      result.current.toggleTheme()
    })
    expect(result.current.theme).toBe('dark')
  })

  it('persists to localStorage', () => {
    const { result } = renderHook(() => useTheme())

    act(() => {
      result.current.toggleTheme()
    })

    expect(localStorage.setItem).toHaveBeenCalledWith('strada-theme', 'light')
  })

  it('sets data-theme attribute on document element', () => {
    renderHook(() => useTheme())
    expect(document.documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'dark')
  })

  it('reads from localStorage on init', () => {
    storage['strada-theme'] = 'light'
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('light')
  })
})
