import { create } from 'zustand'

export interface CanvasShape {
  type?: string
  id: string
  props: Record<string, unknown>
  source?: 'agent' | 'user'
  position?: { x: number; y: number }
}

export interface CanvasShapeUpdate {
  id: string
  props: Record<string, unknown>
  type?: string
  source?: 'agent' | 'user'
  position?: { x: number; y: number }
}

export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

export type CanvasLayout = 'auto' | 'grid' | 'tree' | 'flow'

interface PersistedCanvasState {
  pendingShapes: CanvasShape[]
  pendingUpdates: CanvasShapeUpdate[]
  pendingRemovals: string[]
  pendingViewport: CanvasViewport | null
  pendingLayout: CanvasLayout | null
}

export interface CanvasDraftState {
  snapshot: unknown
  updatedAt: number
  dirty: boolean
}

interface CanvasState extends PersistedCanvasState {
  sessionId: string | null
  isDirty: boolean

  setSessionId: (id: string | null) => void
  setDirty: (dirty: boolean) => void
  addPendingShapes: (shapes: CanvasShape[]) => void
  updatePendingShapes: (shapes: CanvasShapeUpdate[]) => void
  removePendingShapeIds: (ids: string[]) => void
  setPendingViewport: (viewport: CanvasViewport | null) => void
  setPendingLayout: (layout: CanvasLayout | null) => void
  clearPendingShapes: () => void
  clearPendingUpdates: () => void
  clearPendingRemovals: () => void
  clearPendingViewport: () => void
  clearPendingLayout: () => void
  reset: () => void
}

const CANVAS_STATE_STORAGE_PREFIX = 'strada-canvas-state:'
const CANVAS_DRAFT_STORAGE_PREFIX = 'strada-canvas-draft:'

const persistedInitialState: PersistedCanvasState = {
  pendingShapes: [],
  pendingUpdates: [],
  pendingRemovals: [],
  pendingViewport: null,
  pendingLayout: null,
}

const initialState = {
  sessionId: null as string | null,
  isDirty: false,
  ...persistedInitialState,
}

function getCanvasStateStorageKey(sessionId: string): string {
  return `${CANVAS_STATE_STORAGE_PREFIX}${sessionId}`
}

function getCanvasDraftStorageKey(sessionId: string): string {
  return `${CANVAS_DRAFT_STORAGE_PREFIX}${sessionId}`
}

function readPersistedCanvasState(sessionId: string): PersistedCanvasState | null {
  if (typeof window === 'undefined') return null
  try {
    if (typeof window.localStorage?.getItem !== 'function') {
      return null
    }
    const raw = window.localStorage.getItem(getCanvasStateStorageKey(sessionId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedCanvasState>
    return {
      pendingShapes: Array.isArray(parsed.pendingShapes) ? parsed.pendingShapes : [],
      pendingUpdates: Array.isArray(parsed.pendingUpdates) ? parsed.pendingUpdates : [],
      pendingRemovals: Array.isArray(parsed.pendingRemovals) ? parsed.pendingRemovals : [],
      pendingViewport: parsed.pendingViewport ?? null,
      pendingLayout: parsed.pendingLayout ?? null,
    }
  } catch {
    return null
  }
}

function hasPersistableCanvasState(state: PersistedCanvasState): boolean {
  return (
    state.pendingShapes.length > 0 ||
    state.pendingUpdates.length > 0 ||
    state.pendingRemovals.length > 0 ||
    Boolean(state.pendingViewport) ||
    Boolean(state.pendingLayout)
  )
}

function persistCanvasState(state: Pick<CanvasState, 'sessionId'> & PersistedCanvasState): void {
  if (
    typeof window === 'undefined' ||
    !state.sessionId ||
    typeof window.localStorage?.removeItem !== 'function' ||
    typeof window.localStorage?.setItem !== 'function'
  ) {
    return
  }
  const key = getCanvasStateStorageKey(state.sessionId)
  if (!hasPersistableCanvasState(state)) {
    window.localStorage.removeItem(key)
    return
  }
  window.localStorage.setItem(key, JSON.stringify({
    pendingShapes: state.pendingShapes,
    pendingUpdates: state.pendingUpdates,
    pendingRemovals: state.pendingRemovals,
    pendingViewport: state.pendingViewport,
    pendingLayout: state.pendingLayout,
  }))
}

export function readPersistedCanvasDraft(sessionId: string): CanvasDraftState | null {
  if (typeof window === 'undefined') return null
  try {
    if (typeof window.localStorage?.getItem !== 'function') {
      return null
    }
    const raw = window.localStorage.getItem(getCanvasDraftStorageKey(sessionId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CanvasDraftState>
    if (typeof parsed.updatedAt !== 'number' || !('snapshot' in parsed)) {
      return null
    }
    return {
      snapshot: parsed.snapshot,
      updatedAt: parsed.updatedAt,
      dirty: parsed.dirty !== false,
    }
  } catch {
    return null
  }
}

export function persistCanvasDraft(
  sessionId: string,
  snapshot: unknown,
  options?: { dirty?: boolean; updatedAt?: number },
): void {
  if (
    typeof window === 'undefined' ||
    typeof window.localStorage?.setItem !== 'function'
  ) {
    return
  }

  window.localStorage.setItem(getCanvasDraftStorageKey(sessionId), JSON.stringify({
    snapshot,
    updatedAt: options?.updatedAt ?? Date.now(),
    dirty: options?.dirty !== false,
  }))
}

export function clearPersistedCanvasDraft(sessionId: string): void {
  if (
    typeof window === 'undefined' ||
    typeof window.localStorage?.removeItem !== 'function'
  ) {
    return
  }
  window.localStorage.removeItem(getCanvasDraftStorageKey(sessionId))
}

type CanvasDataState = Pick<CanvasState, 'sessionId' | 'isDirty'> & PersistedCanvasState

function withPersistence<T extends CanvasDataState>(nextState: T): T {
  persistCanvasState(nextState)
  return nextState
}

export const useCanvasStore = create<CanvasState>()((set) => ({
  ...initialState,
  setSessionId: (sessionId) => set((state) => {
    if (state.sessionId === sessionId) return state
    const restored = sessionId ? readPersistedCanvasState(sessionId) : null
    return withPersistence({
      ...initialState,
      sessionId,
      ...(restored ?? persistedInitialState),
    })
  }),
  setDirty: (isDirty) => set((state) => ({ ...state, isDirty })),
  addPendingShapes: (shapes) => set((state) => {
    const addIds = new Set(shapes.map((shape) => shape.id))
    return withPersistence({
      ...state,
      pendingShapes: [...state.pendingShapes, ...shapes],
      pendingUpdates: state.pendingUpdates.filter((shape) => !addIds.has(shape.id)),
      pendingRemovals: state.pendingRemovals.filter((shapeId) => !addIds.has(shapeId)),
    })
  }),
  updatePendingShapes: (shapes) => set((state) => {
    const queuedAddIds = new Set(state.pendingShapes.map((shape) => shape.id))
    const nextPendingShapes = state.pendingShapes.map((existing) => {
      const update = shapes.find((shape) => shape.id === existing.id)
      if (!update) return existing
      return {
        ...existing,
        ...(update.type ? { type: update.type } : {}),
        ...(update.source ? { source: update.source } : {}),
        ...(update.position ? { position: update.position } : {}),
        props: { ...existing.props, ...update.props },
      }
    })

    const nextPendingUpdates = [...state.pendingUpdates]
    for (const update of shapes) {
      if (queuedAddIds.has(update.id)) continue
      const existingIndex = nextPendingUpdates.findIndex((shape) => shape.id === update.id)
      if (existingIndex >= 0) {
        const existing = nextPendingUpdates[existingIndex]!
        nextPendingUpdates[existingIndex] = {
          ...existing,
          ...(update.type ? { type: update.type } : {}),
          ...(update.source ? { source: update.source } : {}),
          ...(update.position ? { position: update.position } : {}),
          props: { ...existing.props, ...update.props },
        }
      } else {
        nextPendingUpdates.push(update)
      }
    }

    return withPersistence({
      ...state,
      pendingShapes: nextPendingShapes,
      pendingUpdates: nextPendingUpdates,
      pendingRemovals: state.pendingRemovals.filter((shapeId) => !shapes.some((shape) => shape.id === shapeId)),
    })
  }),
  removePendingShapeIds: (ids) => set((state) => {
    const removeIds = new Set(ids)
    return withPersistence({
      ...state,
      pendingShapes: state.pendingShapes.filter((shape) => !removeIds.has(shape.id)),
      pendingUpdates: state.pendingUpdates.filter((shape) => !removeIds.has(shape.id)),
      pendingRemovals: [...new Set([...state.pendingRemovals, ...ids])],
    })
  }),
  setPendingViewport: (pendingViewport) => set((state) => withPersistence({ ...state, pendingViewport })),
  setPendingLayout: (pendingLayout) => set((state) => withPersistence({ ...state, pendingLayout })),
  clearPendingShapes: () => set((state) => withPersistence({ ...state, pendingShapes: [] })),
  clearPendingUpdates: () => set((state) => withPersistence({ ...state, pendingUpdates: [] })),
  clearPendingRemovals: () => set((state) => withPersistence({ ...state, pendingRemovals: [] })),
  clearPendingViewport: () => set((state) => withPersistence({ ...state, pendingViewport: null })),
  clearPendingLayout: () => set((state) => withPersistence({ ...state, pendingLayout: null })),
  reset: () => set((state) => {
    if (
      typeof window !== 'undefined' &&
      state.sessionId &&
      typeof window.localStorage?.removeItem === 'function'
    ) {
      window.localStorage.removeItem(getCanvasStateStorageKey(state.sessionId))
    }
    return { ...initialState }
  }),
}))
