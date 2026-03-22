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

  it('reset clears everything', () => {
    useCanvasStore.getState().setSessionId('s1')
    useCanvasStore.getState().setDirty(true)
    useCanvasStore.getState().reset()
    expect(useCanvasStore.getState().sessionId).toBeNull()
    expect(useCanvasStore.getState().isDirty).toBe(false)
  })
})
