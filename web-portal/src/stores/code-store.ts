import { create } from 'zustand'

export interface CodeTab {
  path: string
  content: string
  language: string
  isDiff?: boolean
  diffContent?: string
}

export interface Annotation {
  path: string
  line: number
  message: string
  severity: 'error' | 'warning' | 'info'
}

export type TouchedStatus = 'modified' | 'new' | 'deleted'

interface CodeState {
  tabs: CodeTab[]
  activeTab: string | null
  terminalOutput: string[]
  annotations: Annotation[]
  touchedFiles: Map<string, TouchedStatus>

  openFile: (tab: CodeTab) => void
  closeFile: (path: string) => void
  setActiveTab: (path: string) => void
  appendTerminal: (line: string) => void
  clearTerminal: () => void
  addAnnotation: (ann: Annotation) => void
  clearAnnotations: (path: string) => void
  markTouched: (path: string, status: TouchedStatus) => void
  reset: () => void
}

const initialState = {
  tabs: [] as CodeTab[],
  activeTab: null as string | null,
  terminalOutput: [] as string[],
  annotations: [] as Annotation[],
  touchedFiles: new Map<string, TouchedStatus>(),
}

export const useCodeStore = create<CodeState>()((set) => ({
  ...initialState,

  openFile: (tab) =>
    set((s) => {
      const exists = s.tabs.some((t) => t.path === tab.path)
      if (exists) {
        return { tabs: s.tabs.map((t) => (t.path === tab.path ? { ...t, ...tab } : t)), activeTab: tab.path }
      }
      return { tabs: [...s.tabs, tab], activeTab: tab.path }
    }),

  closeFile: (path) =>
    set((s) => {
      const newTabs = s.tabs.filter((t) => t.path !== path)
      let newActive = s.activeTab
      if (s.activeTab === path) {
        const idx = s.tabs.findIndex((t) => t.path === path)
        newActive = newTabs[Math.min(idx, newTabs.length - 1)]?.path ?? null
      }
      return { tabs: newTabs, activeTab: newActive }
    }),

  setActiveTab: (path) => set({ activeTab: path }),

  appendTerminal: (line) =>
    set((s) => {
      const next = [...s.terminalOutput, line]
      return { terminalOutput: next.length > 5000 ? next.slice(-5000) : next }
    }),

  clearTerminal: () => set({ terminalOutput: [] }),

  addAnnotation: (ann) => set((s) => ({ annotations: [...s.annotations, ann] })),

  clearAnnotations: (path) => set((s) => ({ annotations: s.annotations.filter((a) => a.path !== path) })),

  markTouched: (path, status) =>
    set((s) => {
      const next = new Map(s.touchedFiles)
      next.set(path, status)
      return { touchedFiles: next }
    }),

  reset: () => set(initialState),
}))
