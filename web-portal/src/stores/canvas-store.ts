import { create } from 'zustand'
import type { ResolvedShape, CanvasConnection, ViewportState, LayoutMode } from '../components/canvas/canvas-types'

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

/** Alias for ViewportState — kept for backward compat with external imports */
export type CanvasViewport = ViewportState

export type CanvasLayout = 'auto' | 'grid' | 'tree' | 'flow'

interface PersistedCanvasState {
  pendingShapes: CanvasShape[]
  pendingUpdates: CanvasShapeUpdate[]
  pendingRemovals: string[]
  pendingViewport: CanvasViewport | null
  pendingLayout: CanvasLayout | null
}

interface UndoSnapshot {
  shapes: ResolvedShape[]
  connections: CanvasConnection[]
}

const MAX_UNDO_DEPTH = 50

interface CanvasState extends PersistedCanvasState {
  sessionId: string | null
  isDirty: boolean

  shapes: ResolvedShape[]
  connections: CanvasConnection[]
  viewport: ViewportState

  /* Interactive state */
  selectedIds: string[]
  editingShapeId: string | null
  connectingFromId: string | null
  gridSnap: boolean
  undoStack: UndoSnapshot[]
  redoStack: UndoSnapshot[]

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

  setShapes: (shapes: ResolvedShape[]) => void
  setConnections: (connections: CanvasConnection[]) => void
  setViewport: (viewport: ViewportState) => void
  addShape: (shape: ResolvedShape) => void
  updateShape: (id: string, updates: Partial<ResolvedShape>) => void
  removeShapes: (ids: string[]) => void
  addConnection: (connection: CanvasConnection) => void
  removeConnections: (ids: string[]) => void

  /* Selection */
  selectShape: (id: string, multi?: boolean) => void
  deselectAll: () => void
  selectAll: () => void

  /* Editing */
  setEditingShape: (id: string | null) => void

  /* Connecting */
  startConnecting: (fromId: string) => void
  finishConnecting: (toId: string) => void
  cancelConnecting: () => void

  /* Undo / Redo */
  pushUndo: () => void
  undo: () => void
  redo: () => void

  /* Bulk operations */
  deleteSelected: () => void
  duplicateSelected: () => void
  bringToFront: (id: string) => void
  sendToBack: (id: string) => void

  /* Grid */
  toggleGridSnap: () => void

  /* Layout */
  layoutMode: LayoutMode
  setLayoutMode: (mode: LayoutMode) => void
  userLayoutOverride: boolean
}

const CANVAS_STATE_STORAGE_PREFIX = 'strada-canvas-state:'
const CANVAS_SHAPES_STORAGE_PREFIX = 'strada-canvas-shapes:'
const CANVAS_VIEWPORT_STORAGE_PREFIX = 'strada-canvas-viewport:'

const persistedInitialState: PersistedCanvasState = {
  pendingShapes: [],
  pendingUpdates: [],
  pendingRemovals: [],
  pendingViewport: null,
  pendingLayout: null,
}

const defaultViewport: ViewportState = { x: 0, y: 0, zoom: 1 }

const initialState = {
  sessionId: null as string | null,
  isDirty: false,
  shapes: [] as ResolvedShape[],
  connections: [] as CanvasConnection[],
  viewport: { ...defaultViewport },
  selectedIds: [] as string[],
  editingShapeId: null as string | null,
  connectingFromId: null as string | null,
  gridSnap: false,
  layoutMode: 'freeform' as LayoutMode,
  userLayoutOverride: false,
  undoStack: [] as UndoSnapshot[],
  redoStack: [] as UndoSnapshot[],
  ...persistedInitialState,
}

function getCanvasStateStorageKey(sessionId: string): string {
  return `${CANVAS_STATE_STORAGE_PREFIX}${sessionId}`
}

function getCanvasShapesStorageKey(sessionId: string): string {
  return `${CANVAS_SHAPES_STORAGE_PREFIX}${sessionId}`
}

function getCanvasViewportStorageKey(sessionId: string): string {
  return `${CANVAS_VIEWPORT_STORAGE_PREFIX}${sessionId}`
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

export function isValidResolvedShape(s: unknown): s is ResolvedShape {
  if (!s || typeof s !== 'object') return false
  const shape = s as Record<string, unknown>
  return typeof shape.id === 'string' && typeof shape.type === 'string' &&
    typeof shape.x === 'number' && Number.isFinite(shape.x) &&
    typeof shape.y === 'number' && Number.isFinite(shape.y) &&
    typeof shape.w === 'number' && Number.isFinite(shape.w) &&
    typeof shape.h === 'number' && Number.isFinite(shape.h)
}

function readPersistedShapes(sessionId: string): ResolvedShape[] {
  if (typeof window === 'undefined') return []
  try {
    if (typeof window.localStorage?.getItem !== 'function') return []
    const raw = window.localStorage.getItem(getCanvasShapesStorageKey(sessionId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidResolvedShape)
  } catch {
    return []
  }
}

function readPersistedViewport(sessionId: string): ViewportState {
  if (typeof window === 'undefined') return { ...defaultViewport }
  try {
    if (typeof window.localStorage?.getItem !== 'function') return { ...defaultViewport }
    const raw = window.localStorage.getItem(getCanvasViewportStorageKey(sessionId))
    if (!raw) return { ...defaultViewport }
    const parsed = JSON.parse(raw) as Partial<ViewportState>
    return {
      x: typeof parsed.x === 'number' ? parsed.x : 0,
      y: typeof parsed.y === 'number' ? parsed.y : 0,
      zoom: typeof parsed.zoom === 'number' ? parsed.zoom : 1,
    }
  } catch {
    return { ...defaultViewport }
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

function persistShapes(sessionId: string, shapes: ResolvedShape[]): void {
  if (
    typeof window === 'undefined' ||
    typeof window.localStorage?.setItem !== 'function' ||
    typeof window.localStorage?.removeItem !== 'function'
  ) {
    return
  }
  const key = getCanvasShapesStorageKey(sessionId)
  if (shapes.length === 0) {
    window.localStorage.removeItem(key)
    return
  }
  window.localStorage.setItem(key, JSON.stringify(shapes))
}

function persistViewport(sessionId: string, viewport: ViewportState): void {
  if (
    typeof window === 'undefined' ||
    typeof window.localStorage?.setItem !== 'function'
  ) {
    return
  }
  window.localStorage.setItem(getCanvasViewportStorageKey(sessionId), JSON.stringify(viewport))
}

type CanvasDataState = Pick<CanvasState, 'sessionId' | 'isDirty'> & PersistedCanvasState

let persistTimer: ReturnType<typeof setTimeout> | null = null

function withPersistence<T extends CanvasDataState>(nextState: T): T {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => { persistCanvasState(useCanvasStore.getState()) }, 500)
  return nextState
}

function takeSnapshot(state: CanvasState): UndoSnapshot {
  return {
    shapes: [...state.shapes.map(s => ({ ...s }))],
    connections: [...state.connections.map(c => ({ ...c }))],
  }
}

export const useCanvasStore = create<CanvasState>()((set) => ({
  ...initialState,
  setSessionId: (sessionId) => set((state) => {
    if (state.sessionId === sessionId) return state
    const restored = sessionId ? readPersistedCanvasState(sessionId) : null
    const restoredShapes = sessionId ? readPersistedShapes(sessionId) : []
    const restoredViewport = sessionId ? readPersistedViewport(sessionId) : { ...defaultViewport }
    return withPersistence({
      ...initialState,
      sessionId,
      shapes: restoredShapes,
      viewport: restoredViewport,
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
      window.localStorage.removeItem(getCanvasShapesStorageKey(state.sessionId))
      window.localStorage.removeItem(getCanvasViewportStorageKey(state.sessionId))
    }
    return { ...initialState }
  }),

  setShapes: (shapes) => set((state) => {
    if (state.sessionId) persistShapes(state.sessionId, shapes)
    return { ...state, shapes }
  }),
  setConnections: (connections) => set((state) => ({ ...state, connections })),
  setViewport: (viewport) => set((state) => {
    if (state.sessionId) persistViewport(state.sessionId, viewport)
    return { ...state, viewport }
  }),
  addShape: (shape) => set((state) => {
    const exists = state.shapes.some((s) => s.id === shape.id)
    const shapes = exists
      ? state.shapes.map((s) => (s.id === shape.id ? shape : s))
      : [...state.shapes, shape]
    if (state.sessionId) persistShapes(state.sessionId, shapes)
    return { ...state, shapes }
  }),
  updateShape: (id, updates) => set((state) => {
    const shapes = state.shapes.map((s) => (s.id === id ? { ...s, ...updates } : s))
    if (state.sessionId) persistShapes(state.sessionId, shapes)
    return { ...state, shapes }
  }),
  removeShapes: (ids) => set((state) => {
    const removeSet = new Set(ids)
    const shapes = state.shapes.filter((s) => !removeSet.has(s.id))
    if (state.sessionId) persistShapes(state.sessionId, shapes)
    return { ...state, shapes }
  }),
  addConnection: (connection) => set((state) => ({
    ...state,
    connections: [...state.connections, connection],
  })),
  removeConnections: (ids) => set((state) => {
    const removeSet = new Set(ids)
    return {
      ...state,
      connections: state.connections.filter((c) => !removeSet.has(c.id)),
    }
  }),

  /* ── Selection ──────────────────────────────────────────────── */
  selectShape: (id, multi) => set((state) => {
    if (multi) {
      const already = state.selectedIds.includes(id)
      return {
        ...state,
        selectedIds: already
          ? state.selectedIds.filter((s) => s !== id)
          : [...state.selectedIds, id],
      }
    }
    return { ...state, selectedIds: [id] }
  }),
  deselectAll: () => set((state) => ({
    ...state,
    selectedIds: [],
    editingShapeId: null,
    connectingFromId: null,
  })),
  selectAll: () => set((state) => ({
    ...state,
    selectedIds: state.shapes.map((s) => s.id),
  })),

  /* ── Editing ────────────────────────────────────────────────── */
  setEditingShape: (id) => set((state) => ({
    ...state,
    editingShapeId: id,
    selectedIds: id ? [id] : state.selectedIds,
  })),

  /* ── Connecting ─────────────────────────────────────────────── */
  startConnecting: (fromId) => set((state) => ({
    ...state,
    connectingFromId: fromId,
  })),
  finishConnecting: (toId) => set((state) => {
    if (!state.connectingFromId || state.connectingFromId === toId) {
      return { ...state, connectingFromId: null }
    }
    const exists = state.connections.some(
      (c) => c.from === state.connectingFromId && c.to === toId,
    )
    if (exists) return { ...state, connectingFromId: null }
    const newConn: CanvasConnection = {
      id: `conn-${state.connectingFromId}-${toId}-${Date.now()}`,
      from: state.connectingFromId,
      to: toId,
    }
    return {
      ...state,
      connectingFromId: null,
      connections: [...state.connections, newConn],
    }
  }),
  cancelConnecting: () => set((state) => ({
    ...state,
    connectingFromId: null,
  })),

  /* ── Undo / Redo ────────────────────────────────────────────── */
  pushUndo: () => set((state) => ({
    ...state,
    undoStack: [
      ...state.undoStack.slice(-(MAX_UNDO_DEPTH - 1)),
      takeSnapshot(state),
    ],
    redoStack: [],
  })),
  undo: () => set((state) => {
    if (state.undoStack.length === 0) return state
    const snapshot = state.undoStack[state.undoStack.length - 1]!
    if (state.sessionId) persistShapes(state.sessionId, snapshot.shapes)
    return {
      ...state,
      shapes: snapshot.shapes,
      connections: snapshot.connections,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, takeSnapshot(state)],
      selectedIds: [],
      editingShapeId: null,
    }
  }),
  redo: () => set((state) => {
    if (state.redoStack.length === 0) return state
    const snapshot = state.redoStack[state.redoStack.length - 1]!
    if (state.sessionId) persistShapes(state.sessionId, snapshot.shapes)
    return {
      ...state,
      shapes: snapshot.shapes,
      connections: snapshot.connections,
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, takeSnapshot(state)],
      selectedIds: [],
      editingShapeId: null,
    }
  }),

  /* ── Bulk operations ────────────────────────────────────────── */
  deleteSelected: () => set((state) => {
    if (state.selectedIds.length === 0) return state
    const removeSet = new Set(state.selectedIds)
    const shapes = state.shapes.filter((s) => !removeSet.has(s.id))
    const connections = state.connections.filter(
      (c) => !removeSet.has(c.from) && !removeSet.has(c.to),
    )
    if (state.sessionId) persistShapes(state.sessionId, shapes)
    return {
      ...state,
      shapes,
      connections,
      selectedIds: [],
      editingShapeId: null,
    }
  }),
  duplicateSelected: () => set((state) => {
    if (state.selectedIds.length === 0) return state
    const selectedSet = new Set(state.selectedIds)
    const newShapes: ResolvedShape[] = []
    const newIds: string[] = []
    for (const s of state.shapes) {
      if (!selectedSet.has(s.id)) continue
      const newId = `${s.id}-dup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      newShapes.push({ ...s, id: newId, x: s.x + 20, y: s.y + 20, source: 'user' })
      newIds.push(newId)
    }
    const shapes = [...state.shapes, ...newShapes]
    if (state.sessionId) persistShapes(state.sessionId, shapes)
    return { ...state, shapes, selectedIds: newIds }
  }),
  bringToFront: (id) => set((state) => {
    const idx = state.shapes.findIndex((s) => s.id === id)
    if (idx < 0 || idx === state.shapes.length - 1) return state
    const shapes = [...state.shapes.filter((s) => s.id !== id), state.shapes[idx]!]
    if (state.sessionId) persistShapes(state.sessionId, shapes)
    return { ...state, shapes }
  }),
  sendToBack: (id) => set((state) => {
    const idx = state.shapes.findIndex((s) => s.id === id)
    if (idx <= 0) return state
    const shapes = [state.shapes[idx]!, ...state.shapes.filter((s) => s.id !== id)]
    if (state.sessionId) persistShapes(state.sessionId, shapes)
    return { ...state, shapes }
  }),

  /* ── Grid ───────────────────────────────────────────────────── */
  toggleGridSnap: () => set((state) => ({ ...state, gridSnap: !state.gridSnap })),

  /* ── Layout ─────────────────────────────────────────────────── */
  setLayoutMode: (mode) => set({ layoutMode: mode, userLayoutOverride: true }),
}))
