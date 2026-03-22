import { create } from 'zustand'

export type WorkspaceMode = 'chat' | 'monitor' | 'canvas' | 'code'

interface PanelSizes {
  sidebar: number
  primary: number
  secondary: number
}

interface WorkspaceState {
  mode: WorkspaceMode
  userOverride: boolean
  secondaryVisible: boolean
  panelSizes: PanelSizes
  setMode: (mode: WorkspaceMode) => void
  suggestMode: (mode: WorkspaceMode) => void
  resetOverride: () => void
  toggleSecondary: () => void
  setPanelSizes: (sizes: Partial<PanelSizes>) => void
  reset: () => void
}

const initialState = {
  mode: 'chat' as WorkspaceMode,
  userOverride: false,
  secondaryVisible: false,
  panelSizes: { sidebar: 15, primary: 70, secondary: 15 } as PanelSizes,
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  ...initialState,
  setMode: (mode) => set({ mode, userOverride: true }),
  suggestMode: (mode) => set((state) => (state.userOverride ? state : { mode })),
  resetOverride: () => set({ userOverride: false, mode: 'chat' }),
  toggleSecondary: () => set((state) => ({ secondaryVisible: !state.secondaryVisible })),
  setPanelSizes: (sizes) => set((state) => ({ panelSizes: { ...state.panelSizes, ...sizes } })),
  reset: () => set(initialState),
}))
