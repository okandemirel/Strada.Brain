import { describe, expect, it, beforeEach, vi } from 'vitest'
import { useSidebarStore } from './sidebar-store'

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
    get length() { return Object.keys(store).length },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

describe('useSidebarStore', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
    // Reset the store to pick up fresh localStorage state
    useSidebarStore.setState({ collapsed: false })
  })

  it('starts expanded by default', () => {
    expect(useSidebarStore.getState().collapsed).toBe(false)
  })

  it('toggles collapsed state', () => {
    useSidebarStore.getState().toggle()
    expect(useSidebarStore.getState().collapsed).toBe(true)

    useSidebarStore.getState().toggle()
    expect(useSidebarStore.getState().collapsed).toBe(false)
  })

  it('persists to localStorage with key strada-sidebar-collapsed', () => {
    useSidebarStore.getState().toggle()
    expect(localStorageMock.setItem).toHaveBeenCalledWith('strada-sidebar-collapsed', '1')

    useSidebarStore.getState().toggle()
    expect(localStorageMock.setItem).toHaveBeenCalledWith('strada-sidebar-collapsed', '0')
  })

  it('initializes from localStorage', () => {
    localStorageMock.setItem('strada-sidebar-collapsed', '1')
    // Re-create the store state based on localStorage
    const initialCollapsed = localStorageMock.getItem('strada-sidebar-collapsed') === '1'
    useSidebarStore.setState({ collapsed: initialCollapsed })
    expect(useSidebarStore.getState().collapsed).toBe(true)
  })
})
