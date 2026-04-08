import { beforeEach, describe, expect, it } from 'vitest'
import {
  useCanvasStore,
} from './canvas-store'

function createStorageMock() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

describe('useCanvasStore', () => {
  beforeEach(() => {
    const storage = createStorageMock()
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
    useCanvasStore.getState().reset()
  })

  it('starts with null sessionId', () => {
    expect(useCanvasStore.getState().sessionId).toBeNull()
  })

  it('sets session ID', () => {
    useCanvasStore.getState().setSessionId('s1')
    expect(useCanvasStore.getState().sessionId).toBe('s1')
  })

  it('restores pending agent state from localStorage when session changes', () => {
    localStorage.setItem('strada-canvas-state:s-restore', JSON.stringify({
      pendingShapes: [{ type: 'code-block', id: 'cb-restore', props: { code: 'restored' }, source: 'agent' }],
      pendingUpdates: [],
      pendingRemovals: [],
      pendingViewport: null,
      pendingLayout: null,
    }))

    useCanvasStore.getState().setSessionId('s-restore')

    expect(useCanvasStore.getState().pendingShapes).toEqual([
      { type: 'code-block', id: 'cb-restore', props: { code: 'restored' }, source: 'agent' },
    ])
  })

  it('manages shapes in store', () => {
    const shape = { id: 's1', type: 'code-block', x: 10, y: 20, w: 400, h: 240, props: { code: 'test' } }
    useCanvasStore.getState().addShape(shape)
    expect(useCanvasStore.getState().shapes).toHaveLength(1)
    expect(useCanvasStore.getState().shapes[0].id).toBe('s1')

    useCanvasStore.getState().updateShape('s1', { x: 50 })
    expect(useCanvasStore.getState().shapes[0].x).toBe(50)

    useCanvasStore.getState().removeShapes(['s1'])
    expect(useCanvasStore.getState().shapes).toHaveLength(0)
  })

  it('tracks dirty flag', () => {
    expect(useCanvasStore.getState().isDirty).toBe(false)
    useCanvasStore.getState().setDirty(true)
    expect(useCanvasStore.getState().isDirty).toBe(true)
  })

  it('stores pending shapes from agent', () => {
    useCanvasStore.getState().addPendingShapes([{ type: 'CodeBlock', id: 'c1', props: {} }])
    expect(useCanvasStore.getState().pendingShapes).toHaveLength(1)
  })

  it('clears pending shapes', () => {
    useCanvasStore.getState().addPendingShapes([{ type: 'CodeBlock', id: 'c1', props: {} }])
    useCanvasStore.getState().clearPendingShapes()
    expect(useCanvasStore.getState().pendingShapes).toEqual([])
  })

  it('preserves source field on pending shapes', () => {
    const { addPendingShapes } = useCanvasStore.getState()
    addPendingShapes([
      { type: 'code-block', id: 'cb1', props: { code: 'test' }, source: 'agent' },
    ])
    const shapes = useCanvasStore.getState().pendingShapes
    expect(shapes[0].source).toBe('agent')
  })

  it('allows shapes without source field (backward compat)', () => {
    const { addPendingShapes } = useCanvasStore.getState()
    addPendingShapes([
      { type: 'code-block', id: 'cb2', props: { code: 'test' } },
    ])
    const shapes = useCanvasStore.getState().pendingShapes
    expect(shapes[0].source).toBeUndefined()
  })

  it('queues updates for shapes that are already on canvas', () => {
    useCanvasStore.getState().updatePendingShapes([
      { id: 'cb3', props: { code: 'updated' }, source: 'agent' },
    ])

    const updates = useCanvasStore.getState().pendingUpdates
    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe('cb3')
    expect(updates[0].props.code).toBe('updated')
  })

  it('merges updates into a queued add before the editor mounts', () => {
    useCanvasStore.getState().addPendingShapes([
      { type: 'code-block', id: 'cb4', props: { code: 'before' }, source: 'agent' },
    ])
    useCanvasStore.getState().updatePendingShapes([
      { id: 'cb4', props: { code: 'after', status: 'ready' }, source: 'agent' },
    ])

    const state = useCanvasStore.getState()
    expect(state.pendingShapes).toHaveLength(1)
    expect(state.pendingShapes[0].props).toEqual({ code: 'after', status: 'ready' })
    expect(state.pendingUpdates).toEqual([])
  })

  it('queues removals and evicts pending adds/updates for the same id', () => {
    useCanvasStore.getState().addPendingShapes([
      { type: 'code-block', id: 'cb5', props: { code: 'test' }, source: 'agent' },
    ])
    useCanvasStore.getState().updatePendingShapes([
      { id: 'cb6', props: { code: 'later' }, source: 'agent' },
    ])
    useCanvasStore.getState().removePendingShapeIds(['cb5', 'cb6'])

    const state = useCanvasStore.getState()
    expect(state.pendingShapes).toEqual([])
    expect(state.pendingUpdates).toEqual([])
    expect(state.pendingRemovals).toEqual(['cb5', 'cb6'])
  })

  it('reset clears everything', () => {
    useCanvasStore.getState().setSessionId('s1')
    useCanvasStore.getState().setDirty(true)
    useCanvasStore.getState().updatePendingShapes([
      { id: 'cb7', props: { code: 'test' }, source: 'agent' },
    ])
    useCanvasStore.getState().removePendingShapeIds(['cb7'])
    useCanvasStore.getState().reset()
    expect(useCanvasStore.getState().sessionId).toBeNull()
    expect(useCanvasStore.getState().isDirty).toBe(false)
    expect(useCanvasStore.getState().pendingUpdates).toEqual([])
    expect(useCanvasStore.getState().pendingRemovals).toEqual([])
  })

  it('manages layoutMode with default freeform', () => {
    const store = useCanvasStore.getState()
    expect(store.layoutMode).toBe('freeform')
    store.setLayoutMode('kanban')
    expect(useCanvasStore.getState().layoutMode).toBe('kanban')
    store.setLayoutMode('flow')
    expect(useCanvasStore.getState().layoutMode).toBe('flow')
  })

  it('tracks userLayoutOverride on manual layout change', () => {
    const store = useCanvasStore.getState()
    expect(store.userLayoutOverride).toBe(false)
    store.setLayoutMode('flow')
    expect(useCanvasStore.getState().userLayoutOverride).toBe(true)
  })

  // ── Helpers ──────────────────────────────────────────────────────────────

  function makeShape(id: string, x = 0, y = 0): import('./canvas-store').CanvasShape & { type: string; x: number; y: number; w: number; h: number } {
    return { id, type: 'code-block', x, y, w: 200, h: 100, props: {} }
  }

  // ── selectShape ───────────────────────────────────────────────────────────

  describe('selectShape', () => {
    it('selects a single shape, replacing prior selection', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().addShape(makeShape('b'))
      useCanvasStore.getState().selectShape('a')
      useCanvasStore.getState().selectShape('b')
      expect(useCanvasStore.getState().selectedIds).toEqual(['b'])
    })

    it('adds to selection in multi-select mode', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().addShape(makeShape('b'))
      useCanvasStore.getState().selectShape('a')
      useCanvasStore.getState().selectShape('b', true)
      expect(useCanvasStore.getState().selectedIds).toEqual(['a', 'b'])
    })

    it('deselects an already-selected shape in multi-select mode', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().selectShape('a')
      useCanvasStore.getState().selectShape('a', true)
      expect(useCanvasStore.getState().selectedIds).toEqual([])
    })
  })

  // ── deselectAll ───────────────────────────────────────────────────────────

  describe('deselectAll', () => {
    it('clears selectedIds', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().selectShape('a')
      useCanvasStore.getState().deselectAll()
      expect(useCanvasStore.getState().selectedIds).toEqual([])
    })

    it('clears editingShapeId and connectingFromId', () => {
      useCanvasStore.getState().setEditingShape('a')
      useCanvasStore.getState().startConnecting('b')
      useCanvasStore.getState().deselectAll()
      const s = useCanvasStore.getState()
      expect(s.editingShapeId).toBeNull()
      expect(s.connectingFromId).toBeNull()
    })
  })

  // ── selectAll ────────────────────────────────────────────────────────────

  describe('selectAll', () => {
    it('selects every shape on the canvas', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().addShape(makeShape('b'))
      useCanvasStore.getState().addShape(makeShape('c'))
      useCanvasStore.getState().selectAll()
      expect(useCanvasStore.getState().selectedIds).toEqual(['a', 'b', 'c'])
    })

    it('returns empty selection when canvas is empty', () => {
      useCanvasStore.getState().selectAll()
      expect(useCanvasStore.getState().selectedIds).toEqual([])
    })
  })

  // ── deleteSelected ────────────────────────────────────────────────────────

  describe('deleteSelected', () => {
    it('removes selected shapes from the canvas', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().addShape(makeShape('b'))
      useCanvasStore.getState().selectShape('a')
      useCanvasStore.getState().deleteSelected()
      const ids = useCanvasStore.getState().shapes.map((s) => s.id)
      expect(ids).toEqual(['b'])
    })

    it('clears selectedIds after deletion', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().selectShape('a')
      useCanvasStore.getState().deleteSelected()
      expect(useCanvasStore.getState().selectedIds).toEqual([])
    })

    it('also removes connections touching deleted shapes', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().addShape(makeShape('b'))
      useCanvasStore.getState().addShape(makeShape('c'))
      useCanvasStore.getState().addConnection({ id: 'c1', from: 'a', to: 'b' })
      useCanvasStore.getState().addConnection({ id: 'c2', from: 'b', to: 'c' })
      useCanvasStore.getState().selectShape('a')
      useCanvasStore.getState().deleteSelected()
      const connIds = useCanvasStore.getState().connections.map((c) => c.id)
      // c1 touched 'a', c2 did not — only c2 survives
      expect(connIds).toEqual(['c2'])
    })

    it('does nothing when nothing is selected', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().deleteSelected()
      expect(useCanvasStore.getState().shapes).toHaveLength(1)
    })
  })

  // ── duplicateSelected ─────────────────────────────────────────────────────

  describe('duplicateSelected', () => {
    it('creates a copy with +20px offset on both axes', () => {
      useCanvasStore.getState().addShape(makeShape('a', 100, 50))
      useCanvasStore.getState().selectShape('a')
      useCanvasStore.getState().duplicateSelected()
      const shapes = useCanvasStore.getState().shapes
      expect(shapes).toHaveLength(2)
      const dup = shapes[1]!
      expect(dup.x).toBe(120)
      expect(dup.y).toBe(70)
    })

    it('selects only the newly duplicated shape(s)', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().selectShape('a')
      useCanvasStore.getState().duplicateSelected()
      const selectedIds = useCanvasStore.getState().selectedIds
      expect(selectedIds).toHaveLength(1)
      expect(selectedIds[0]).not.toBe('a')
    })

    it('marks duplicated shapes as user-sourced', () => {
      useCanvasStore.getState().addShape({ ...makeShape('a'), source: 'agent' } as never)
      useCanvasStore.getState().selectShape('a')
      useCanvasStore.getState().duplicateSelected()
      const dup = useCanvasStore.getState().shapes[1]!
      expect((dup as { source?: string }).source).toBe('user')
    })

    it('does nothing when nothing is selected', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().duplicateSelected()
      expect(useCanvasStore.getState().shapes).toHaveLength(1)
    })
  })

  // ── bringToFront / sendToBack ─────────────────────────────────────────────

  describe('bringToFront', () => {
    it('moves shape to the end of the array (highest z-order)', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().addShape(makeShape('b'))
      useCanvasStore.getState().addShape(makeShape('c'))
      useCanvasStore.getState().bringToFront('a')
      const ids = useCanvasStore.getState().shapes.map((s) => s.id)
      expect(ids).toEqual(['b', 'c', 'a'])
    })

    it('is a no-op when the shape is already at the front', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().addShape(makeShape('b'))
      const before = useCanvasStore.getState().shapes.map((s) => s.id)
      useCanvasStore.getState().bringToFront('b')
      expect(useCanvasStore.getState().shapes.map((s) => s.id)).toEqual(before)
    })
  })

  describe('sendToBack', () => {
    it('moves shape to the beginning of the array (lowest z-order)', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().addShape(makeShape('b'))
      useCanvasStore.getState().addShape(makeShape('c'))
      useCanvasStore.getState().sendToBack('c')
      const ids = useCanvasStore.getState().shapes.map((s) => s.id)
      expect(ids).toEqual(['c', 'a', 'b'])
    })

    it('is a no-op when the shape is already at the back', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().addShape(makeShape('b'))
      const before = useCanvasStore.getState().shapes.map((s) => s.id)
      useCanvasStore.getState().sendToBack('a')
      expect(useCanvasStore.getState().shapes.map((s) => s.id)).toEqual(before)
    })
  })

  // ── pushUndo / undo / redo ────────────────────────────────────────────────

  describe('undo / redo / pushUndo', () => {
    it('pushUndo snapshots current state onto the undo stack', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().pushUndo()
      expect(useCanvasStore.getState().undoStack).toHaveLength(1)
    })

    it('undo restores shapes to the previous snapshot', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().pushUndo()
      useCanvasStore.getState().addShape(makeShape('b'))
      useCanvasStore.getState().undo()
      const ids = useCanvasStore.getState().shapes.map((s) => s.id)
      expect(ids).toEqual(['a'])
    })

    it('undo clears selectedIds and editingShapeId', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().pushUndo()
      useCanvasStore.getState().selectShape('a')
      useCanvasStore.getState().setEditingShape('a')
      useCanvasStore.getState().undo()
      expect(useCanvasStore.getState().selectedIds).toEqual([])
      expect(useCanvasStore.getState().editingShapeId).toBeNull()
    })

    it('redo restores shapes after an undo', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().pushUndo()
      useCanvasStore.getState().addShape(makeShape('b'))
      useCanvasStore.getState().undo()
      useCanvasStore.getState().redo()
      const ids = useCanvasStore.getState().shapes.map((s) => s.id)
      expect(ids).toEqual(['a', 'b'])
    })

    it('pushUndo clears the redo stack', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().pushUndo()
      useCanvasStore.getState().addShape(makeShape('b'))
      useCanvasStore.getState().undo()
      // redo stack now has one entry; a new pushUndo should clear it
      useCanvasStore.getState().pushUndo()
      expect(useCanvasStore.getState().redoStack).toHaveLength(0)
    })

    it('undo is a no-op when the stack is empty', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().undo()
      expect(useCanvasStore.getState().shapes).toHaveLength(1)
    })

    it('redo is a no-op when the stack is empty', () => {
      useCanvasStore.getState().addShape(makeShape('a'))
      useCanvasStore.getState().redo()
      expect(useCanvasStore.getState().shapes).toHaveLength(1)
    })
  })

  // ── toggleGridSnap ────────────────────────────────────────────────────────

  describe('toggleGridSnap', () => {
    it('starts as false', () => {
      expect(useCanvasStore.getState().gridSnap).toBe(false)
    })

    it('toggles gridSnap from false to true', () => {
      useCanvasStore.getState().toggleGridSnap()
      expect(useCanvasStore.getState().gridSnap).toBe(true)
    })

    it('toggles gridSnap back to false on second call', () => {
      useCanvasStore.getState().toggleGridSnap()
      useCanvasStore.getState().toggleGridSnap()
      expect(useCanvasStore.getState().gridSnap).toBe(false)
    })
  })

  // ── addConnection / removeConnections ─────────────────────────────────────

  describe('addConnection / removeConnections', () => {
    it('adds a connection between two shapes', () => {
      useCanvasStore.getState().addConnection({ id: 'c1', from: 'a', to: 'b' })
      expect(useCanvasStore.getState().connections).toHaveLength(1)
      expect(useCanvasStore.getState().connections[0]).toMatchObject({ id: 'c1', from: 'a', to: 'b' })
    })

    it('removes connections by id', () => {
      useCanvasStore.getState().addConnection({ id: 'c1', from: 'a', to: 'b' })
      useCanvasStore.getState().addConnection({ id: 'c2', from: 'b', to: 'c' })
      useCanvasStore.getState().removeConnections(['c1'])
      const ids = useCanvasStore.getState().connections.map((c) => c.id)
      expect(ids).toEqual(['c2'])
    })

    it('is a no-op when removing a non-existent connection id', () => {
      useCanvasStore.getState().addConnection({ id: 'c1', from: 'a', to: 'b' })
      useCanvasStore.getState().removeConnections(['nope'])
      expect(useCanvasStore.getState().connections).toHaveLength(1)
    })
  })

  // ── startConnecting / finishConnecting / cancelConnecting ─────────────────

  describe('connection drawing flow', () => {
    it('startConnecting sets connectingFromId', () => {
      useCanvasStore.getState().startConnecting('shape-a')
      expect(useCanvasStore.getState().connectingFromId).toBe('shape-a')
    })

    it('finishConnecting creates a new connection and clears connectingFromId', () => {
      useCanvasStore.getState().startConnecting('shape-a')
      useCanvasStore.getState().finishConnecting('shape-b')
      const s = useCanvasStore.getState()
      expect(s.connectingFromId).toBeNull()
      expect(s.connections).toHaveLength(1)
      expect(s.connections[0]).toMatchObject({ from: 'shape-a', to: 'shape-b' })
    })

    it('finishConnecting does not create a duplicate connection', () => {
      useCanvasStore.getState().startConnecting('shape-a')
      useCanvasStore.getState().finishConnecting('shape-b')
      useCanvasStore.getState().startConnecting('shape-a')
      useCanvasStore.getState().finishConnecting('shape-b')
      expect(useCanvasStore.getState().connections).toHaveLength(1)
    })

    it('finishConnecting with the same source and target cancels the connection', () => {
      useCanvasStore.getState().startConnecting('shape-a')
      useCanvasStore.getState().finishConnecting('shape-a')
      const s = useCanvasStore.getState()
      expect(s.connectingFromId).toBeNull()
      expect(s.connections).toHaveLength(0)
    })

    it('cancelConnecting clears connectingFromId without creating a connection', () => {
      useCanvasStore.getState().startConnecting('shape-a')
      useCanvasStore.getState().cancelConnecting()
      const s = useCanvasStore.getState()
      expect(s.connectingFromId).toBeNull()
      expect(s.connections).toHaveLength(0)
    })
  })
})
