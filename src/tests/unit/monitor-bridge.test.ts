import { describe, it, expect, beforeEach } from 'vitest'
import { TypedEventBus } from '../../core/event-bus.js'
import type { WorkspaceEventMap } from '../../dashboard/workspace-events.js'
import { createMonitorBridge } from '../../dashboard/monitor-bridge.js'

function makeWorkspaceBus() {
  return new TypedEventBus<WorkspaceEventMap>()
}

describe('createMonitorBridge', () => {
  let workspaceBus: TypedEventBus<WorkspaceEventMap>
  let broadcasts: string[]

  beforeEach(() => {
    workspaceBus = makeWorkspaceBus()
    broadcasts = []
  })

  function makeBridge() {
    return createMonitorBridge(workspaceBus, (msg) => broadcasts.push(msg))
  }

  it('broadcasts monitor:task_update events after start()', () => {
    const bridge = makeBridge()
    bridge.start()

    workspaceBus.emit('monitor:task_update', {
      rootId: 'root-1',
      nodeId: 'node-1',
      status: 'executing',
    })

    expect(broadcasts).toHaveLength(1)
    const parsed = JSON.parse(broadcasts[0])
    expect(parsed.type).toBe('monitor:task_update')
    expect(parsed.payload.rootId).toBe('root-1')
    expect(parsed.payload.nodeId).toBe('node-1')
    expect(parsed.timestamp).toBeTypeOf('number')
  })

  // ── Audit 13F5 / plan 4.7: every frame carries the origin it belongs to ──

  it('stamps the emitting conversation scope as the frame origin', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', {
      rootId: 'ep-1',
      nodes: [],
      edges: [],
      conversationId: 'profile-A',
    })

    const parsed = JSON.parse(broadcasts[0])
    expect(parsed.origin).toBe('profile-A')
  })

  it('carries the origin over to a rootId-only incremental of the same root', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', {
      rootId: 'ep-1',
      nodes: [],
      edges: [],
      conversationId: 'profile-A',
    })
    // monitor:substep names no conversation — only the root it grows.
    workspaceBus.emit('monitor:substep', { rootId: 'ep-1', nodeId: 'n1', substep: 'writing' })

    expect(JSON.parse(broadcasts[1]).origin).toBe('profile-A')
  })

  it('keeps two profiles\' roots apart', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-A', nodes: [], edges: [], conversationId: 'profile-A' })
    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-B', nodes: [], edges: [], conversationId: 'profile-B' })
    workspaceBus.emit('monitor:substep', { rootId: 'ep-B', nodeId: 'n1', substep: 's' })
    workspaceBus.emit('monitor:substep', { rootId: 'ep-A', nodeId: 'n2', substep: 's' })

    expect(broadcasts.map((m) => JSON.parse(m).origin)).toEqual([
      'profile-A',
      'profile-B',
      'profile-B',
      'profile-A',
    ])
  })

  // Guard: a frame that names no scope must NOT acquire one, or the transport
  // would withhold traffic that belongs to every client.
  it('stamps no origin on a frame that names neither a conversation nor a known root', () => {
    makeBridge().start()

    workspaceBus.emit('workspace:mode_suggest', { mode: 'monitor', reason: 'x' })
    workspaceBus.emit('monitor:agent_activity', {
      activity: { taskId: undefined, action: 'tool_execute', detail: 'x', timestamp: 1 },
    })
    workspaceBus.emit('monitor:substep', { rootId: 'never-seen', nodeId: 'n1', substep: 's' })

    for (const [i, msg] of broadcasts.entries()) {
      expect(Object.hasOwn(JSON.parse(msg), 'origin'), `frame ${i}`).toBe(false)
    }
  })

  // A frame can name neither a conversation nor a root: progress:narrative carries
  // only nodeId, and its text is the milestone wording derived from the request.
  it("attributes a nodeId-only frame to the board that declared the node", () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', {
      rootId: 'ep-A',
      nodes: [{ id: 'goal-1' }, { id: 'goal-2' }],
      edges: [],
      conversationId: 'profile-A',
    })
    workspaceBus.emit('progress:narrative', { nodeId: 'goal-2', narrative: 'Aşama: ship the thing', lang: 'tr' })

    expect(JSON.parse(broadcasts[1]).origin).toBe('profile-A')
  })

  it('keeps two profiles\' nodeId-only narratives apart', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-A', nodes: [{ id: 'a1' }], edges: [], conversationId: 'profile-A' })
    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-B', nodes: [{ id: 'b1' }], edges: [], conversationId: 'profile-B' })
    workspaceBus.emit('progress:narrative', { nodeId: 'b1', narrative: 'B', lang: 'en' })
    workspaceBus.emit('progress:narrative', { nodeId: 'a1', narrative: 'A', lang: 'en' })

    expect(broadcasts.slice(2).map((m) => JSON.parse(m).origin)).toEqual(['profile-B', 'profile-A'])
  })

  it('learns a node from a rootId-only frame whose root is already attributed', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-A', nodes: [], edges: [], conversationId: 'profile-A' })
    // A worker's card arrives under the known root, naming a node the dag did not list.
    workspaceBus.emit('monitor:task_update', { rootId: 'ep-A', nodeId: 'late-node', status: 'executing' })
    workspaceBus.emit('progress:narrative', { nodeId: 'late-node', narrative: 'x', lang: 'en' })

    expect(JSON.parse(broadcasts[2]).origin).toBe('profile-A')
  })

  // Guard: an unknown node must NOT acquire an origin, or the transport would
  // withhold a frame that belongs to everyone.
  it('stamps no origin on a nodeId the bridge has never seen declared', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-A', nodes: [{ id: 'a1' }], edges: [], conversationId: 'profile-A' })
    workspaceBus.emit('progress:narrative', { nodeId: 'stranger', narrative: 'x', lang: 'en' })

    expect(Object.hasOwn(JSON.parse(broadcasts[1]), 'origin')).toBe(false)
  })

  it('forgets the node→origin pairings on monitor:clear too', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-A', nodes: [{ id: 'a1' }], edges: [], conversationId: 'profile-A' })
    workspaceBus.emit('monitor:clear', {})
    workspaceBus.emit('progress:narrative', { nodeId: 'a1', narrative: 'x', lang: 'en' })

    expect(Object.hasOwn(JSON.parse(broadcasts[2]), 'origin')).toBe(false)
  })

  it('forgets the root→origin pairings on monitor:clear', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-1', nodes: [], edges: [], conversationId: 'profile-A' })
    workspaceBus.emit('monitor:clear', {})
    workspaceBus.emit('monitor:substep', { rootId: 'ep-1', nodeId: 'n1', substep: 's' })

    expect(Object.hasOwn(JSON.parse(broadcasts[2]), 'origin')).toBe(false)
  })

  it('broadcasts workspace:mode_suggest events', () => {
    const bridge = makeBridge()
    bridge.start()

    workspaceBus.emit('workspace:mode_suggest', {
      mode: 'monitor',
      reason: 'Goal started',
    })

    expect(broadcasts).toHaveLength(1)
    const parsed = JSON.parse(broadcasts[0])
    expect(parsed.type).toBe('workspace:mode_suggest')
    expect(parsed.payload.mode).toBe('monitor')
  })

  it('broadcasts workspace:notification events', () => {
    const bridge = makeBridge()
    bridge.start()

    workspaceBus.emit('workspace:notification', {
      title: 'Alert',
      message: 'Something happened',
      severity: 'warning',
    })

    expect(broadcasts).toHaveLength(1)
    const parsed = JSON.parse(broadcasts[0])
    expect(parsed.type).toBe('workspace:notification')
    expect(parsed.payload.severity).toBe('warning')
  })

  it('broadcasts monitor:dag_init events', () => {
    const bridge = makeBridge()
    bridge.start()

    workspaceBus.emit('monitor:dag_init', {
      rootId: 'root-1',
      nodes: [{ id: 'n1', task: 'Do thing', status: 'pending', reviewStatus: 'none', depth: 1, dependsOn: [] }],
      edges: [],
    })

    expect(broadcasts).toHaveLength(1)
    const parsed = JSON.parse(broadcasts[0])
    expect(parsed.type).toBe('monitor:dag_init')
    expect(parsed.payload.nodes).toHaveLength(1)
  })

  it('broadcasts monitor:gate_request events', () => {
    const bridge = makeBridge()
    bridge.start()

    workspaceBus.emit('monitor:gate_request', {
      rootId: 'root-1',
      nodeId: 'node-1',
      gateType: 'review_stuck',
      message: 'Task stuck',
    })

    expect(broadcasts).toHaveLength(1)
    const parsed = JSON.parse(broadcasts[0])
    expect(parsed.type).toBe('monitor:gate_request')
    expect(parsed.payload.gateType).toBe('review_stuck')
  })

  it('stop() prevents further broadcasting', () => {
    const bridge = makeBridge()
    bridge.start()
    bridge.stop()

    workspaceBus.emit('monitor:task_update', {
      rootId: 'root-1',
      nodeId: 'node-1',
      status: 'completed',
    })

    expect(broadcasts).toHaveLength(0)
  })

  it('stop() is idempotent — calling twice does not throw', () => {
    const bridge = makeBridge()
    bridge.start()
    expect(() => {
      bridge.stop()
      bridge.stop()
    }).not.toThrow()
  })

  it('broadcasts multiple events in sequence', () => {
    const bridge = makeBridge()
    bridge.start()

    workspaceBus.emit('monitor:task_update', {
      rootId: 'root-1',
      nodeId: 'node-1',
      status: 'executing',
    })
    workspaceBus.emit('monitor:agent_activity', {
      taskId: 'node-1',
      action: 'tool_execute',
      tool: 'readFile',
      detail: 'Reading config',
      timestamp: 1000,
    })
    workspaceBus.emit('monitor:review_result', {
      rootId: 'root-1',
      nodeId: 'node-1',
      reviewType: 'spec_review',
      passed: true,
      issues: [],
      iteration: 1,
      maxIterations: 3,
    })

    expect(broadcasts).toHaveLength(3)
    expect(JSON.parse(broadcasts[0]).type).toBe('monitor:task_update')
    expect(JSON.parse(broadcasts[1]).type).toBe('monitor:agent_activity')
    expect(JSON.parse(broadcasts[2]).type).toBe('monitor:review_result')
  })
})
