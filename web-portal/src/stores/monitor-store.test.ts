import { describe, it, expect, beforeEach } from 'vitest'
import { useMonitorStore } from './monitor-store'

describe('useMonitorStore', () => {
  beforeEach(() => {
    useMonitorStore.getState().clearMonitor()
  })

  it('starts with empty state', () => {
    const s = useMonitorStore.getState()
    expect(s.tasks).toEqual({})
    expect(s.dag).toBeNull()
    expect(s.activities).toEqual([])
    expect(s.activeRootId).toBeNull()
    expect(s.selectedTaskId).toBeNull()
  })

  it('adds a task', () => {
    useMonitorStore.getState().addTask({
      id: 'n1',
      nodeId: 'n1',
      title: 'Task 1',
      status: 'pending',
      reviewStatus: 'none',
    })
    expect(Object.keys(useMonitorStore.getState().tasks)).toHaveLength(1)
    expect(useMonitorStore.getState().tasks['n1'].title).toBe('Task 1')
  })

  it('updates a task', () => {
    useMonitorStore.getState().addTask({
      id: 'n1',
      nodeId: 'n1',
      title: 'Task 1',
      status: 'pending',
      reviewStatus: 'none',
    })
    useMonitorStore.getState().updateTask('n1', { status: 'executing' })
    expect(useMonitorStore.getState().tasks['n1'].status).toBe('executing')
  })

  it('stores narrative and milestone updates on a task', () => {
    useMonitorStore.getState().addTask({
      id: 'n1',
      nodeId: 'n1',
      title: 'Task 1',
      status: 'pending',
      reviewStatus: 'none',
    })
    useMonitorStore.getState().updateTask('n1', {
      narrative: 'Progress: 1/3 steps are complete.',
      milestone: { current: 1, total: 3, label: 'steps' },
    })

    expect(useMonitorStore.getState().tasks['n1'].narrative).toBe('Progress: 1/3 steps are complete.')
    expect(useMonitorStore.getState().tasks['n1'].milestone).toEqual({
      current: 1,
      total: 3,
      label: 'steps',
    })
  })

  it('auto-creates a placeholder task when updating a non-existent ID with status', () => {
    useMonitorStore.getState().updateTask('missing', { status: 'done' })
    const task = useMonitorStore.getState().tasks['missing']
    expect(task).toBeDefined()
    expect(task!.status).toBe('done')
    expect(task!.title).toBe('missing')
  })

  it('ignores update for non-existent task without status or title', () => {
    useMonitorStore.getState().updateTask('ghost', { elapsed: 500 })
    expect(useMonitorStore.getState().tasks['ghost']).toBeUndefined()
  })

  it('sets DAG', () => {
    useMonitorStore.getState().setDAG({ nodes: [{ id: 'n1' }], edges: [] })
    expect(useMonitorStore.getState().dag).not.toBeNull()
    expect(useMonitorStore.getState().dag!.nodes).toHaveLength(1)
  })

  it('adds activity entries', () => {
    useMonitorStore.getState().addActivity({
      action: 'tool_execute',
      tool: 'read',
      detail: 'Reading file',
      timestamp: 1,
    })
    expect(useMonitorStore.getState().activities).toHaveLength(1)
    expect(useMonitorStore.getState().activities[0].tool).toBe('read')
  })

  it('caps activities at 200', () => {
    for (let i = 0; i < 210; i++) {
      useMonitorStore.getState().addActivity({
        action: 'test',
        detail: `entry ${i}`,
        timestamp: i,
      })
    }
    expect(useMonitorStore.getState().activities).toHaveLength(200)
    // Should keep the most recent entries (last 200)
    expect(useMonitorStore.getState().activities[0].detail).toBe('entry 10')
    expect(useMonitorStore.getState().activities[199].detail).toBe('entry 209')
  })

  it('sets active root ID', () => {
    useMonitorStore.getState().setActiveRootId('root1')
    expect(useMonitorStore.getState().activeRootId).toBe('root1')
  })

  it('sets active root ID to null', () => {
    useMonitorStore.getState().setActiveRootId('root1')
    useMonitorStore.getState().setActiveRootId(null)
    expect(useMonitorStore.getState().activeRootId).toBeNull()
  })

  it('sets selected task ID', () => {
    useMonitorStore.getState().setSelectedTask('t1')
    expect(useMonitorStore.getState().selectedTaskId).toBe('t1')
  })

  it('clears monitor state', () => {
    useMonitorStore.getState().addTask({
      id: 'n1',
      nodeId: 'n1',
      title: 'T',
      status: 'pending',
      reviewStatus: 'none',
    })
    useMonitorStore.getState().addActivity({
      action: 'test',
      detail: 'x',
      timestamp: 1,
    })
    useMonitorStore.getState().setDAG({ nodes: [], edges: [] })
    useMonitorStore.getState().setActiveRootId('root1')
    useMonitorStore.getState().setSelectedTask('t1')

    useMonitorStore.getState().clearMonitor()

    const s = useMonitorStore.getState()
    expect(s.tasks).toEqual({})
    expect(s.dag).toBeNull()
    expect(s.activities).toEqual([])
    expect(s.activeRootId).toBeNull()
    expect(s.selectedTaskId).toBeNull()
  })

  it('preserves other tasks when updating one', () => {
    useMonitorStore.getState().addTask({
      id: 'n1',
      nodeId: 'n1',
      title: 'Task 1',
      status: 'pending',
      reviewStatus: 'none',
    })
    useMonitorStore.getState().addTask({
      id: 'n2',
      nodeId: 'n2',
      title: 'Task 2',
      status: 'pending',
      reviewStatus: 'none',
    })
    useMonitorStore.getState().updateTask('n1', { status: 'done', reviewStatus: 'review_passed' })

    const tasks = useMonitorStore.getState().tasks
    expect(tasks['n1'].status).toBe('done')
    expect(tasks['n1'].reviewStatus).toBe('review_passed')
    expect(tasks['n2'].status).toBe('pending')
  })

  it('overwrites task with same id', () => {
    useMonitorStore.getState().addTask({
      id: 'n1',
      nodeId: 'n1',
      title: 'Original',
      status: 'pending',
      reviewStatus: 'none',
    })
    useMonitorStore.getState().addTask({
      id: 'n1',
      nodeId: 'n1',
      title: 'Replaced',
      status: 'executing',
      reviewStatus: 'none',
    })
    expect(useMonitorStore.getState().tasks['n1'].title).toBe('Replaced')
    expect(Object.keys(useMonitorStore.getState().tasks)).toHaveLength(1)
  })
})
