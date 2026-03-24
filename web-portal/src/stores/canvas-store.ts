import { create } from 'zustand'

export interface CanvasShape {
  type: string
  id: string
  props: Record<string, unknown>
  source?: 'agent' | 'user'
}

interface CanvasState {
  sessionId: string | null
  isDirty: boolean
  pendingShapes: CanvasShape[]

  setSessionId: (id: string | null) => void
  setDirty: (dirty: boolean) => void
  addPendingShapes: (shapes: CanvasShape[]) => void
  updatePendingShapes: (shapes: CanvasShape[]) => void
  removePendingShapeIds: (ids: string[]) => void
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
  updatePendingShapes: (shapes) => set((s) => ({
    pendingShapes: s.pendingShapes.map(existing => {
      const update = shapes.find(u => u.id === existing.id)
      return update ? { ...existing, ...update } : existing
    }),
  })),
  removePendingShapeIds: (ids) => set((s) => ({
    pendingShapes: s.pendingShapes.filter(shape => !ids.includes(shape.id)),
  })),
  clearPendingShapes: () => set({ pendingShapes: [] }),
  reset: () => set(initialState),
}))
