import { create } from 'zustand'

export interface CanvasShape {
  type: string
  id: string
  props: Record<string, unknown>
}

interface CanvasState {
  sessionId: string | null
  isDirty: boolean
  pendingShapes: CanvasShape[]

  setSessionId: (id: string | null) => void
  setDirty: (dirty: boolean) => void
  addPendingShapes: (shapes: CanvasShape[]) => void
  clearPendingShapes: () => void
  reset: () => void
}

const initialState = {
  sessionId: null as string | null,
  isDirty: false,
  pendingShapes: [] as CanvasShape[],
}

export const useCanvasStore = create<CanvasState>()((set) => ({
  ...initialState,
  setSessionId: (sessionId) => set({ sessionId }),
  setDirty: (isDirty) => set({ isDirty }),
  addPendingShapes: (shapes) => set((s) => ({ pendingShapes: [...s.pendingShapes, ...shapes] })),
  clearPendingShapes: () => set({ pendingShapes: [] }),
  reset: () => set(initialState),
}))
