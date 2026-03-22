import { create } from 'zustand'

const STORAGE_KEY = 'strada-sidebar-collapsed'

function readInitialCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(STORAGE_KEY) === '1'
}

export interface SidebarState {
  collapsed: boolean
}

export interface SidebarActions {
  toggle: () => void
}

export const useSidebarStore = create<SidebarState & SidebarActions>()((set) => ({
  collapsed: readInitialCollapsed(),

  toggle: () =>
    set((state) => {
      const next = !state.collapsed
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      return { collapsed: next }
    }),
}))
