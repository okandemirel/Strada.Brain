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
})
