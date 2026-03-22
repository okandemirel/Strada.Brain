import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { useKeyboardShortcuts } from './use-keyboard-shortcuts'

describe('useKeyboardShortcuts', () => {
  const handlers = {
    setMode: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleSecondary: vi.fn(),
  }

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('Cmd+1 sets chat mode', () => {
    renderHook(() => useKeyboardShortcuts(handlers))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true }))
    expect(handlers.setMode).toHaveBeenCalledWith('chat')
  })

  it('Cmd+2 sets monitor mode', () => {
    renderHook(() => useKeyboardShortcuts(handlers))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true }))
    expect(handlers.setMode).toHaveBeenCalledWith('monitor')
  })

  it('Cmd+B toggles sidebar', () => {
    renderHook(() => useKeyboardShortcuts(handlers))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true }))
    expect(handlers.toggleSidebar).toHaveBeenCalled()
  })

  it('Cmd+\\ toggles secondary panel', () => {
    renderHook(() => useKeyboardShortcuts(handlers))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true }))
    expect(handlers.toggleSecondary).toHaveBeenCalled()
  })

  it('ignores shortcuts when typing in input', () => {
    renderHook(() => useKeyboardShortcuts(handlers))
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true }))
    expect(handlers.setMode).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it('also works with Ctrl key', () => {
    renderHook(() => useKeyboardShortcuts(handlers))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true }))
    expect(handlers.setMode).toHaveBeenCalledWith('chat')
  })
})
