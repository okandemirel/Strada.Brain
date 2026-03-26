import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from './canvas-store'

describe('useCanvasStore', () => {
  beforeEach(() => useCanvasStore.getState().reset())

  it('starts with null sessionId', () => {
    expect(useCanvasStore.getState().sessionId).toBeNull()
  })

  it('sets session ID', () => {
    useCanvasStore.getState().setSessionId('s1')
    expect(useCanvasStore.getState().sessionId).toBe('s1')
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
})
