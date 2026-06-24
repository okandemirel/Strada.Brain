import { describe, it, expect, beforeEach } from 'vitest'
import {
  selectActiveRootLabel,
  selectRootCount,
  selectRootSwitcher,
  useMonitorStore,
} from './monitor-store'

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

describe('useMonitorStore — multi-root scoping', () => {
  beforeEach(() => {
    useMonitorStore.getState().clearMonitor()
  })

  it('does not intermix tasks from two different roots', () => {
    const s = useMonitorStore.getState()
    // Root A becomes active, gets its own DAG + tasks
    s.setActiveRootId('root-a')
    s.setDAG({ nodes: [{ id: 'a1' }], edges: [] }, 'root-a')
    s.addTask({ id: 'a1', nodeId: 'a1', rootId: 'root-a', title: 'A1', status: 'executing', reviewStatus: 'none' })

    // Root B arrives (e.g. a second request): becomes active, gets its own bucket
    s.setActiveRootId('root-b')
    s.setDAG({ nodes: [{ id: 'b1' }], edges: [] }, 'root-b')
    s.addTask({ id: 'b1', nodeId: 'b1', rootId: 'root-b', title: 'B1', status: 'pending', reviewStatus: 'none' })

    // The mirror (what KanbanBoard/DAGView render) shows ONLY root B
    const afterB = useMonitorStore.getState()
    expect(Object.keys(afterB.tasks)).toEqual(['b1'])
    expect(afterB.dag!.nodes).toHaveLength(1)
    expect(afterB.dag!.nodes[0].id).toBe('b1')

    // Switching back to root A restores A's view, untouched by B
    afterB.setActiveRootId('root-a')
    const backToA = useMonitorStore.getState()
    expect(Object.keys(backToA.tasks)).toEqual(['a1'])
    expect(backToA.tasks['a1'].title).toBe('A1')
    expect(backToA.dag!.nodes[0].id).toBe('a1')
  })

  it('does not clobber a prior root DAG when a new root inits', () => {
    const s = useMonitorStore.getState()
    s.setActiveRootId('root-a')
    s.setDAG({ nodes: [{ id: 'a1' }, { id: 'a2' }], edges: [{ source: 'a1', target: 'a2' }] }, 'root-a')

    s.setActiveRootId('root-b')
    s.setDAG({ nodes: [{ id: 'b1' }], edges: [] }, 'root-b')

    // Root A's two-node DAG survives in its bucket
    const state = useMonitorStore.getState()
    expect(state.rootsById['root-a'].dag!.nodes).toHaveLength(2)
    expect(state.rootsById['root-b'].dag!.nodes).toHaveLength(1)
  })

  it('routes a task_update to the owning root even when another root is active', () => {
    const s = useMonitorStore.getState()
    s.setActiveRootId('root-a')
    s.addTask({ id: 'a1', nodeId: 'a1', rootId: 'root-a', title: 'A1', status: 'executing', reviewStatus: 'none' })
    s.setActiveRootId('root-b')
    s.addTask({ id: 'b1', nodeId: 'b1', rootId: 'root-b', title: 'B1', status: 'executing', reviewStatus: 'none' })

    // Background update for root A's task while root B is active
    s.updateTask('a1', { status: 'completed' })

    const state = useMonitorStore.getState()
    // Root A's bucket updated; the active (B) mirror is untouched
    expect(state.rootsById['root-a'].tasks['a1'].status).toBe('completed')
    expect(Object.keys(state.tasks)).toEqual(['b1'])
  })

  it('auto-created placeholder lands in the active root bucket', () => {
    const s = useMonitorStore.getState()
    s.setActiveRootId('root-a')
    s.updateTask('late', { status: 'executing' })

    const state = useMonitorStore.getState()
    expect(state.rootsById['root-a'].tasks['late']).toBeDefined()
    expect(state.tasks['late'].status).toBe('executing')
  })

  it('caps retained root buckets and evicts the oldest non-active roots', () => {
    const s = useMonitorStore.getState()
    // Mint 30 distinct roots — far above the cap — each with its own bucket.
    for (let i = 0; i < 30; i++) {
      const rootId = `root-${i}`
      s.setActiveRootId(rootId)
      s.setDAG({ nodes: [{ id: `n-${i}` }], edges: [] }, rootId)
      s.addTask({ id: `n-${i}`, nodeId: `n-${i}`, rootId, title: `T${i}`, status: 'pending', reviewStatus: 'none' })
    }

    const state = useMonitorStore.getState()
    const roots = Object.keys(state.rootsById)
    // Bucket count never exceeds the cap…
    expect(roots.length).toBeLessThanOrEqual(20)
    // …the oldest roots were evicted…
    expect(state.rootsById['root-0']).toBeUndefined()
    // …and the active root always survives so the mirror is never blank.
    expect(state.activeRootId).toBe('root-29')
    expect(state.rootsById['root-29']).toBeDefined()
    expect(Object.keys(state.tasks)).toEqual(['n-29'])
    expect(state.dag!.nodes[0].id).toBe('n-29')
  })

  it('never evicts the active root even when it is the oldest bucket', () => {
    const s = useMonitorStore.getState()
    // root-keep is created first (oldest) and stays active throughout.
    s.setActiveRootId('root-keep')
    s.setDAG({ nodes: [{ id: 'keep' }], edges: [] }, 'root-keep')
    // Fill background buckets without changing the active root.
    for (let i = 0; i < 30; i++) {
      s.setDAG({ nodes: [{ id: `bg-${i}` }], edges: [] }, `bg-root-${i}`)
    }

    const state = useMonitorStore.getState()
    expect(Object.keys(state.rootsById).length).toBeLessThanOrEqual(20)
    // The active root survives despite being the oldest insertion.
    expect(state.activeRootId).toBe('root-keep')
    expect(state.rootsById['root-keep']).toBeDefined()
    expect(state.dag!.nodes[0].id).toBe('keep')
  })

  describe('root-switcher metadata + selectors', () => {
    it('persists conversationId + label on the root bucket via setDAG meta', () => {
      const s = useMonitorStore.getState()
      s.setDAG({ nodes: [{ id: 'r1' }], edges: [] }, 'r1', {
        conversationId: 'conv-a',
        label: 'Build the login page',
      })
      const bucket = useMonitorStore.getState().rootsById['r1']
      expect(bucket.conversationId).toBe('conv-a')
      expect(bucket.label).toBe('Build the login page')
    })

    it('keeps the FIRST label (first-wins) when a later dag_init omits it', () => {
      const s = useMonitorStore.getState()
      s.setDAG({ nodes: [{ id: 'r1' }], edges: [] }, 'r1', {
        conversationId: 'conv-a',
        label: 'Original goal',
      })
      // Decomposition's later dag_init drops the root node → no label/conversationId.
      s.setDAG({ nodes: [{ id: 'child' }], edges: [] }, 'r1', {})
      const bucket = useMonitorStore.getState().rootsById['r1']
      expect(bucket.label).toBe('Original goal')
      expect(bucket.conversationId).toBe('conv-a')
    })

    it('selectRootCount excludes the default bucket and counts real roots', () => {
      const s = useMonitorStore.getState()
      expect(selectRootCount(useMonitorStore.getState())).toBe(0)
      s.setDAG({ nodes: [{ id: 'a' }], edges: [] }, 'root-a')
      s.setDAG({ nodes: [{ id: 'b' }], edges: [] }, 'root-b')
      expect(selectRootCount(useMonitorStore.getState())).toBe(2)
    })

    it('selectRootSwitcher groups roots by conversationId', () => {
      const s = useMonitorStore.getState()
      s.setDAG({ nodes: [{ id: 'a' }], edges: [] }, 'root-a', { conversationId: 'c1', label: 'A' })
      s.setDAG({ nodes: [{ id: 'b' }], edges: [] }, 'root-b', { conversationId: 'c1', label: 'B' })
      s.setDAG({ nodes: [{ id: 'c' }], edges: [] }, 'root-c', { conversationId: 'c2', label: 'C' })
      const groups = selectRootSwitcher(useMonitorStore.getState())
      expect(groups).toHaveLength(2)
      const c1 = groups.find((g) => g.conversationId === 'c1')!
      expect(c1.roots.map((r) => r.rootId).sort()).toEqual(['root-a', 'root-b'])
      const c2 = groups.find((g) => g.conversationId === 'c2')!
      expect(c2.roots.map((r) => r.label)).toEqual(['C'])
    })

    it('selectRootSwitcher falls back to rootId as group key when conversationId absent (legacy-safe)', () => {
      const s = useMonitorStore.getState()
      s.setDAG({ nodes: [{ id: 'a' }], edges: [] }, 'root-a')
      s.setDAG({ nodes: [{ id: 'b' }], edges: [] }, 'root-b')
      const groups = selectRootSwitcher(useMonitorStore.getState())
      // No conversationId → each root is its own group.
      expect(groups).toHaveLength(2)
      expect(groups.map((g) => g.conversationId).sort()).toEqual(['root-a', 'root-b'])
    })

    it('selectRootSwitcher marks the active root and falls back to first task title for label', () => {
      const s = useMonitorStore.getState()
      s.setActiveRootId('root-a')
      s.addTask({ id: 'a', nodeId: 'a', rootId: 'root-a', title: 'Task A', status: 'executing', reviewStatus: 'none' })
      const groups = selectRootSwitcher(useMonitorStore.getState())
      const entry = groups.flatMap((g) => g.roots).find((r) => r.rootId === 'root-a')!
      expect(entry.isActive).toBe(true)
      expect(entry.label).toBe('Task A')
    })

    it('selectActiveRootLabel returns the active root label (or null when none)', () => {
      expect(selectActiveRootLabel(useMonitorStore.getState())).toBeNull()
      const s = useMonitorStore.getState()
      s.setActiveRootId('root-a')
      s.setDAG({ nodes: [{ id: 'a' }], edges: [] }, 'root-a', { label: 'My request' })
      expect(selectActiveRootLabel(useMonitorStore.getState())).toBe('My request')
    })
  })
})
