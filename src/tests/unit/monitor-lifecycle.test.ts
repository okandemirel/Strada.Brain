import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TypedEventBus } from '../../core/event-bus.js'
import type { WorkspaceEventMap } from '../../dashboard/workspace-events.js'
import { goalTreeToDagPayload } from '../../dashboard/workspace-events.js'
import { createMonitorLifecycle } from '../../dashboard/monitor-lifecycle.js'
import type { GoalTree, GoalNode, GoalNodeId } from '../../goals/types.js'

function makeWorkspaceBus() {
  return new TypedEventBus<WorkspaceEventMap>()
}

function makeGoalTree(overrides?: Partial<GoalTree>): GoalTree {
  const rootId = 'goal_root' as GoalNodeId
  const childA = 'goal_childA' as GoalNodeId
  const childB = 'goal_childB' as GoalNodeId
  const now = Date.now()

  const rootNode: GoalNode = {
    id: rootId,
    parentId: null,
    task: 'Root task',
    dependsOn: [],
    depth: 0,
    status: 'executing',
    createdAt: now,
    updatedAt: now,
  }

  const childNodeA: GoalNode = {
    id: childA,
    parentId: rootId,
    task: 'Sub-task A',
    dependsOn: [],
    depth: 1,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    reviewStatus: 'none',
  }

  const childNodeB: GoalNode = {
    id: childB,
    parentId: rootId,
    task: 'Sub-task B',
    dependsOn: [childA],
    depth: 1,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    reviewStatus: 'none',
  }

  const nodes = new Map<GoalNodeId, GoalNode>([
    [rootId, rootNode],
    [childA, childNodeA],
    [childB, childNodeB],
  ])

  return {
    rootId,
    sessionId: 'session-1',
    taskDescription: 'Root task',
    nodes,
    createdAt: now,
    ...overrides,
  }
}

describe('createMonitorLifecycle', () => {
  let workspaceBus: TypedEventBus<WorkspaceEventMap>

  beforeEach(() => {
    workspaceBus = makeWorkspaceBus()
  })

  // -------------------------------------------------------------------------
  // 1. requestStart emits monitor:dag_init with a single node
  // -------------------------------------------------------------------------
  it('requestStart emits monitor:dag_init with a single node (status: executing, reviewStatus: none)', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const events: WorkspaceEventMap['monitor:dag_init'][] = []
    workspaceBus.on('monitor:dag_init', (payload) => events.push(payload))

    lifecycle.requestStart('conv-1', 'Fix the login bug')

    expect(events).toHaveLength(1)
    const payload = events[0]
    expect(payload.nodes).toHaveLength(1)
    expect(payload.nodes[0].status).toBe('executing')
    expect(payload.nodes[0].reviewStatus).toBe('none')
    expect(payload.nodes[0].task).toBe('Fix the login bug')
    expect(payload.nodes[0].depth).toBe(1)
    expect(payload.nodes[0].dependsOn).toEqual([])
    expect(payload.rootId).toBe(payload.nodes[0].id)
    expect(payload.edges).toEqual([])
  })

  // -------------------------------------------------------------------------
  // 2. requestStart truncates messages longer than 200 chars
  // -------------------------------------------------------------------------
  it('requestStart truncates messages longer than 200 chars', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const events: WorkspaceEventMap['monitor:dag_init'][] = []
    workspaceBus.on('monitor:dag_init', (payload) => events.push(payload))

    const longMessage = 'A'.repeat(250)
    lifecycle.requestStart('conv-1', longMessage)

    expect(events).toHaveLength(1)
    const task = events[0].nodes[0].task
    // 200 chars + ellipsis character
    expect(task.length).toBe(201)
    expect(task.endsWith('\u2026')).toBe(true)
    expect(task.startsWith('A'.repeat(200))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 3. goalDecomposed emits monitor:dag_init with the full goal tree payload
  // -------------------------------------------------------------------------
  it('goalDecomposed emits monitor:dag_init with the full goal tree payload', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const events: WorkspaceEventMap['monitor:dag_init'][] = []
    workspaceBus.on('monitor:dag_init', (payload) => events.push(payload))

    const goalTree = makeGoalTree()
    lifecycle.requestStart('conv-1', 'some task')
    // Clear the requestStart event
    events.length = 0

    lifecycle.goalDecomposed('conv-1', goalTree)

    expect(events).toHaveLength(1)
    const expected = goalTreeToDagPayload(goalTree)
    expect(events[0]).toEqual(expected)
    // Root node is excluded from goalTreeToDagPayload, so 2 child nodes
    expect(events[0].nodes).toHaveLength(2)
    expect(events[0].rootId).toBe(String(goalTree.rootId))
  })

  // -------------------------------------------------------------------------
  // 4. goalDecomposed clears simple task tracking (requestEnd becomes no-op)
  // -------------------------------------------------------------------------
  it('goalDecomposed clears simple task tracking so requestEnd is a no-op', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const taskUpdates: WorkspaceEventMap['monitor:task_update'][] = []
    workspaceBus.on('monitor:task_update', (payload) => taskUpdates.push(payload))

    lifecycle.requestStart('conv-1', 'some task')

    const goalTree = makeGoalTree()
    lifecycle.goalDecomposed('conv-1', goalTree)

    // requestEnd should be no-op — no task_update emitted
    lifecycle.requestEnd('conv-1')
    expect(taskUpdates).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // 5. requestEnd emits monitor:task_update with status: completed
  // -------------------------------------------------------------------------
  it('requestEnd emits monitor:task_update with status: completed when no decomposition happened', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const taskUpdates: WorkspaceEventMap['monitor:task_update'][] = []
    workspaceBus.on('monitor:task_update', (payload) => taskUpdates.push(payload))

    lifecycle.requestStart('conv-1', 'simple task')
    lifecycle.requestEnd('conv-1')

    expect(taskUpdates).toHaveLength(1)
    expect(taskUpdates[0].status).toBe('completed')
    expect(taskUpdates[0].rootId).toBe(taskUpdates[0].nodeId)
  })

  // -------------------------------------------------------------------------
  // 6. requestEnd emits status: failed when failed=true
  // -------------------------------------------------------------------------
  it('requestEnd emits status: failed when failed=true', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const taskUpdates: WorkspaceEventMap['monitor:task_update'][] = []
    workspaceBus.on('monitor:task_update', (payload) => taskUpdates.push(payload))

    lifecycle.requestStart('conv-1', 'failing task')
    lifecycle.requestEnd('conv-1', true)

    expect(taskUpdates).toHaveLength(1)
    expect(taskUpdates[0].status).toBe('failed')
  })

  // -------------------------------------------------------------------------
  // 7. requestEnd is a no-op after goalDecomposed was called
  // -------------------------------------------------------------------------
  it('requestEnd is a no-op after goalDecomposed was called', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const emitSpy = vi.spyOn(workspaceBus, 'emit')

    lifecycle.requestStart('conv-1', 'task')
    lifecycle.goalDecomposed('conv-1', makeGoalTree())

    // Reset spy to track only requestEnd calls
    emitSpy.mockClear()

    lifecycle.requestEnd('conv-1')
    // No emit should have been called
    expect(emitSpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 8. requestEnd is a no-op if requestStart was never called
  // -------------------------------------------------------------------------
  it('requestEnd is a no-op if requestStart was never called', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const emitSpy = vi.spyOn(workspaceBus, 'emit')

    lifecycle.requestEnd('conv-never-started')

    expect(emitSpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 9. goalRestructured emits monitor:dag_restructure with the goal tree payload
  // -------------------------------------------------------------------------
  it('goalRestructured emits monitor:dag_restructure with the goal tree payload', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const restructureEvents: WorkspaceEventMap['monitor:dag_restructure'][] = []
    workspaceBus.on('monitor:dag_restructure', (payload) => restructureEvents.push(payload))

    const goalTree = makeGoalTree()
    lifecycle.goalRestructured('conv-1', goalTree)

    expect(restructureEvents).toHaveLength(1)
    const expected = goalTreeToDagPayload(goalTree)
    expect(restructureEvents[0]).toEqual(expected)
  })

  // -------------------------------------------------------------------------
  // 10. Multiple conversation scopes are tracked independently
  // -------------------------------------------------------------------------
  it('multiple conversation scopes are tracked independently', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const dagInits: WorkspaceEventMap['monitor:dag_init'][] = []
    const taskUpdates: WorkspaceEventMap['monitor:task_update'][] = []
    workspaceBus.on('monitor:dag_init', (payload) => dagInits.push(payload))
    workspaceBus.on('monitor:task_update', (payload) => taskUpdates.push(payload))

    // Start two independent conversations
    lifecycle.requestStart('conv-A', 'Task A')
    lifecycle.requestStart('conv-B', 'Task B')
    expect(dagInits).toHaveLength(2)

    // Decompose only conv-A — conv-B should still be tracked as simple task
    lifecycle.goalDecomposed('conv-A', makeGoalTree())

    // End both — conv-A should be no-op, conv-B should emit task_update
    lifecycle.requestEnd('conv-A')
    lifecycle.requestEnd('conv-B')

    expect(taskUpdates).toHaveLength(1)
    expect(taskUpdates[0].status).toBe('completed')
  })
})
