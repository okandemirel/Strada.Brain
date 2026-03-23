import { create } from 'zustand'

export type WorkspaceMode = 'chat' | 'monitor' | 'canvas' | 'code'

export interface WorkspaceNotification {
  id: string
  title: string
  message: string
  severity: 'info' | 'warning' | 'error'
  timestamp: number
}

interface PanelSizes {
  sidebar: number
  primary: number
  secondary: number
}

interface WorkspaceState {
  mode: WorkspaceMode
  previousMode: WorkspaceMode | null
  userOverride: boolean
  secondaryVisible: boolean
  panelSizes: PanelSizes
  notifications: WorkspaceNotification[]
  setMode: (mode: WorkspaceMode) => void
  suggestMode: (mode: WorkspaceMode) => void
  undoModeSwitch: () => void
  resetOverride: () => void
  toggleSecondary: () => void
  setPanelSizes: (sizes: Partial<PanelSizes>) => void
  addNotification: (n: Omit<WorkspaceNotification, 'id' | 'timestamp'>) => void
  dismissNotification: (id: string) => void
  reset: () => void
}

const MAX_NOTIFICATIONS = 50

const initialState = {
  mode: 'chat' as WorkspaceMode,
  previousMode: null as WorkspaceMode | null,
  userOverride: false,
  secondaryVisible: false,
  panelSizes: { sidebar: 15, primary: 70, secondary: 15 } as PanelSizes,
  notifications: [] as WorkspaceNotification[],
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  ...initialState,
  setMode: (mode) => set((state) => ({ mode, previousMode: state.mode, userOverride: true })),
  suggestMode: (mode) => set((state) => (state.userOverride || state.mode === mode ? state : { mode, previousMode: state.mode })),
  undoModeSwitch: () => set((state) => (state.previousMode ? { mode: state.previousMode, previousMode: null, userOverride: true } : state)),
  resetOverride: () => set({ userOverride: false, mode: 'chat' }),
  toggleSecondary: () => set((state) => ({ secondaryVisible: !state.secondaryVisible })),
  setPanelSizes: (sizes) => set((state) => ({ panelSizes: { ...state.panelSizes, ...sizes } })),
  addNotification: (n) =>
    set((state) => {
      const notification: WorkspaceNotification = {
        ...n,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: Date.now(),
      }
      const next = [...state.notifications, notification]
      return { notifications: next.length > MAX_NOTIFICATIONS ? next.slice(-MAX_NOTIFICATIONS) : next }
    }),
  dismissNotification: (id) =>
    set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) })),
  reset: () => set(initialState),
}))
