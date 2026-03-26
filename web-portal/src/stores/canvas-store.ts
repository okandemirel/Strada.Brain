import { create } from 'zustand'

export interface CanvasShape {
  type?: string
  id: string
  props: Record<string, unknown>
  source?: 'agent' | 'user'
}

export interface CanvasShapeUpdate {
  id: string
  props: Record<string, unknown>
  type?: string
  source?: 'agent' | 'user'
}

interface CanvasState {
  sessionId: string | null
  isDirty: boolean
  pendingShapes: CanvasShape[]
  pendingUpdates: CanvasShapeUpdate[]
  pendingRemovals: string[]

  setSessionId: (id: string | null) => void
  setDirty: (dirty: boolean) => void
  addPendingShapes: (shapes: CanvasShape[]) => void
  updatePendingShapes: (shapes: CanvasShapeUpdate[]) => void
  removePendingShapeIds: (ids: string[]) => void
  clearPendingShapes: () => void
  clearPendingUpdates: () => void
  clearPendingRemovals: () => void
  reset: () => void
}

const initialState = {
  sessionId: null as string | null,
  isDirty: false,
  pendingShapes: [] as CanvasShape[],
  pendingUpdates: [] as CanvasShapeUpdate[],
  pendingRemovals: [] as string[],
}

export const useCanvasStore = create<CanvasState>()((set) => ({
  ...initialState,
  setSessionId: (sessionId) => set({ sessionId }),
  setDirty: (isDirty) => set({ isDirty }),
  addPendingShapes: (shapes) => set((s) => {
    const addIds = new Set(shapes.map((shape) => shape.id))
    return {
      pendingShapes: [...s.pendingShapes, ...shapes],
      pendingUpdates: s.pendingUpdates.filter((shape) => !addIds.has(shape.id)),
      pendingRemovals: s.pendingRemovals.filter((shapeId) => !addIds.has(shapeId)),
    }
  }),
  updatePendingShapes: (shapes) => set((s) => {
    const queuedAddIds = new Set(s.pendingShapes.map((shape) => shape.id))
    const nextPendingShapes = s.pendingShapes.map((existing) => {
      const update = shapes.find((shape) => shape.id === existing.id)
      if (!update) return existing
      return {
        ...existing,
        ...(update.type ? { type: update.type } : {}),
        ...(update.source ? { source: update.source } : {}),
        props: { ...existing.props, ...update.props },
      }
    })

    const nextPendingUpdates = [...s.pendingUpdates]
    for (const update of shapes) {
      if (queuedAddIds.has(update.id)) continue
      const existingIndex = nextPendingUpdates.findIndex((shape) => shape.id === update.id)
      if (existingIndex >= 0) {
        const existing = nextPendingUpdates[existingIndex]!
        nextPendingUpdates[existingIndex] = {
          ...existing,
          ...(update.type ? { type: update.type } : {}),
          ...(update.source ? { source: update.source } : {}),
          props: { ...existing.props, ...update.props },
        }
      } else {
        nextPendingUpdates.push(update)
      }
    }

    return {
      pendingShapes: nextPendingShapes,
      pendingUpdates: nextPendingUpdates,
      pendingRemovals: s.pendingRemovals.filter((shapeId) => !shapes.some((shape) => shape.id === shapeId)),
    }
  }),
  removePendingShapeIds: (ids) => set((s) => {
    const removeIds = new Set(ids)
    return {
      pendingShapes: s.pendingShapes.filter((shape) => !removeIds.has(shape.id)),
      pendingUpdates: s.pendingUpdates.filter((shape) => !removeIds.has(shape.id)),
      pendingRemovals: [...new Set([...s.pendingRemovals, ...ids])],
    }
  }),
  clearPendingShapes: () => set({ pendingShapes: [] }),
  clearPendingUpdates: () => set({ pendingUpdates: [] }),
  clearPendingRemovals: () => set({ pendingRemovals: [] }),
  reset: () => set(initialState),
}))
