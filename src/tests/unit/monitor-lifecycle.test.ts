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
    // Episode model: rootId is the EPISODE id (`ep-…`); the single node is the
    // per-request Kanban card (`req-…`), so they are distinct (a continued request
    // adds another card to the same episode root).
    expect(payload.rootId).toMatch(/^ep-/)
    expect(payload.nodes[0].id).toMatch(/^req-/)
    expect(payload.rootId).not.toBe(payload.nodes[0].id)
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
    const episodeId = events[0].rootId
    // Clear the requestStart event
    events.length = 0

    lifecycle.goalDecomposed('conv-1', goalTree)

    expect(events).toHaveLength(1)
    // The decomposed tree is emitted UNDER THE EPISODE ROOT (rootId overridden to
    // the episodeId) so decomposition grows the active board rather than spraying a
    // sibling root keyed by the goal tree's own id. The node/edge payload is still
    // the goalTreeToDagPayload conversion.
    const expected = goalTreeToDagPayload(goalTree, 'conv-1')
    expect(events[0]).toEqual({ ...expected, rootId: episodeId })
    // Root node is excluded from goalTreeToDagPayload, so 2 child nodes
    expect(events[0].nodes).toHaveLength(2)
    expect(events[0].rootId).toBe(episodeId)
    expect(events[0].rootId).not.toBe(String(goalTree.rootId))
  })

  // -------------------------------------------------------------------------
  // 4. goalDecomposed clears simple task tracking (requestEnd becomes no-op)
  // -------------------------------------------------------------------------
  it('goalDecomposed settles the simple task then clears tracking so requestEnd is a no-op', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const taskUpdates: WorkspaceEventMap['monitor:task_update'][] = []
    workspaceBus.on('monitor:task_update', (payload) => taskUpdates.push(payload))

    lifecycle.requestStart('conv-1', 'some task')

    const goalTree = makeGoalTree()
    lifecycle.goalDecomposed('conv-1', goalTree)

    // goalDecomposed settles the superseded simple node to completed (so its
    // Kanban card doesn't linger "executing"), then clears tracking — so the
    // subsequent requestEnd is a no-op (no second task_update).
    lifecycle.requestEnd('conv-1')
    expect(taskUpdates).toHaveLength(1)
    expect(taskUpdates[0].status).toBe('completed')
  })

  // -------------------------------------------------------------------------
  // 5. requestEnd emits monitor:task_update with status: completed
  // -------------------------------------------------------------------------
  it('requestEnd emits monitor:task_update with status: completed when no decomposition happened', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const taskUpdates: WorkspaceEventMap['monitor:task_update'][] = []
    workspaceBus.on('monitor:task_update', (payload) => taskUpdates.push(payload))

    const dagInits: WorkspaceEventMap['monitor:dag_init'][] = []
    workspaceBus.on('monitor:dag_init', (payload) => dagInits.push(payload))

    lifecycle.requestStart('conv-1', 'simple task')
    lifecycle.requestEnd('conv-1')

    expect(taskUpdates).toHaveLength(1)
    expect(taskUpdates[0].status).toBe('completed')
    // The settle targets the EPISODE root (`ep-…`) + the per-request CARD node
    // (`req-…`), so rootId and nodeId are intentionally distinct.
    expect(taskUpdates[0].rootId).toBe(dagInits[0].rootId)
    expect(taskUpdates[0].nodeId).toBe(dagInits[0].nodes[0].id)
    expect(taskUpdates[0].rootId).not.toBe(taskUpdates[0].nodeId)
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
    // goalRestructured threads the conversation scope through for grouping.
    const expected = goalTreeToDagPayload(goalTree, 'conv-1')
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

    // Decompose only conv-A — its simple node is settled to completed; conv-B
    // remains tracked as a simple task.
    lifecycle.goalDecomposed('conv-A', makeGoalTree())

    // End both — conv-A is a no-op (already settled by goalDecomposed), conv-B
    // emits its own terminal task_update. So two completed settles total: one
    // from conv-A's decomposition, one from conv-B's requestEnd.
    lifecycle.requestEnd('conv-A')
    lifecycle.requestEnd('conv-B')

    expect(taskUpdates).toHaveLength(2)
    expect(taskUpdates.every((u) => u.status === 'completed')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 11. Episode continues while in-progress; rolls over after terminal
  // -------------------------------------------------------------------------
  it('continues the same episode for an in-progress follow-up, then opens a new episode after terminal', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const dagInits: WorkspaceEventMap['monitor:dag_init'][] = []
    workspaceBus.on('monitor:dag_init', (payload) => dagInits.push(payload))

    // First request opens an episode.
    lifecycle.requestStart('conv-1', 'first')
    const episode1 = dagInits[0].rootId
    // Follow-up while in-progress JOINS the same episode (same root, new card).
    lifecycle.requestStart('conv-1', 'second')
    expect(dagInits[1].rootId).toBe(episode1)
    expect(dagInits[1].nodes[0].id).not.toBe(dagInits[0].nodes[0].id)

    // Active task goes terminal → episode closes.
    lifecycle.requestEnd('conv-1')
    // Next request rolls over to a fresh episode/workspace.
    lifecycle.requestStart('conv-1', 'third')
    const episode2 = dagInits[dagInits.length - 1].rootId
    expect(episode2).not.toBe(episode1)
    expect(episode2).toMatch(/^ep-/)
  })

  // -------------------------------------------------------------------------
  // 12. Identity/memory not re-keyed across episodes (conversationId stable)
  // -------------------------------------------------------------------------
  it('keeps the conversationId (chat-scope) stable across an episode rollover so identity/memory is never fragmented', () => {
    const lifecycle = createMonitorLifecycle(workspaceBus)
    const dagInits: WorkspaceEventMap['monitor:dag_init'][] = []
    workspaceBus.on('monitor:dag_init', (payload) => dagInits.push(payload))

    lifecycle.requestStart('conv-1', 'first')
    lifecycle.requestEnd('conv-1')
    lifecycle.requestStart('conv-1', 'second')

    // The episode root changes across the boundary ...
    expect(dagInits[0].rootId).not.toBe(dagInits[1].rootId)
    // ... but the conversationId (the chat-level grouping, identity-adjacent) is
    // the verbatim scope on BOTH episodes — episode boundaries never touch the
    // identity/session/memory keying, which is derived from chat/user.
    expect(dagInits[0].conversationId).toBe('conv-1')
    expect(dagInits[1].conversationId).toBe('conv-1')
  })
})
