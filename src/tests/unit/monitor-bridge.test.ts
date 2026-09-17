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

    // A run declares its board before it updates a card on it; round 10 #4 made
    // that ordering matter, because an update naming a board nothing declared is
    // withheld rather than broadcast (see the fail-closed cases below).
    workspaceBus.emit('monitor:dag_init', { rootId: 'root-1', nodes: [{ id: 'node-1' }], edges: [] })
    workspaceBus.emit('monitor:task_update', {
      rootId: 'root-1',
      nodeId: 'node-1',
      status: 'executing',
    })

    expect(broadcasts).toHaveLength(2)
    const parsed = JSON.parse(broadcasts[1])
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

  // Guard: a frame that names no board must NOT acquire an origin, or the
  // transport would withhold traffic that belongs to every client.
  it('stamps no origin on a frame that names neither a conversation nor a board', () => {
    makeBridge().start()

    workspaceBus.emit('workspace:mode_suggest', { mode: 'monitor', reason: 'x' })
    workspaceBus.emit('monitor:agent_activity', {
      activity: { taskId: undefined, action: 'tool_execute', detail: 'x', timestamp: 1 },
    })

    expect(broadcasts).toHaveLength(2)
    for (const [i, msg] of broadcasts.entries()) {
      expect(Object.hasOwn(JSON.parse(msg), 'origin'), `frame ${i}`).toBe(false)
    }
  })

  // Round 10 #4: the opposite direction. A frame that names a board NOBODY
  // declared used to be broadcast "because it is not attributable", which is
  // precisely how an evicted board's private narrative reached every profile.
  // It is withheld instead: to nobody rather than to everybody.
  it('withholds a conversation-scoped frame whose board was never declared', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:substep', { rootId: 'never-seen', nodeId: 'n1', substep: 's' })
    workspaceBus.emit('progress:narrative', { nodeId: 'never-seen-node', narrative: 'x', lang: 'en' })
    workspaceBus.emit('monitor:task_update', { rootId: 'never-seen', nodeId: 'n1', status: 'executing' })

    expect(broadcasts).toEqual([])
  })

  // …and the guard on that rule: a board declared WITHOUT a conversation scope
  // (monitor-lifecycle, the supervisor, a CLI run) is everybody's, so its own
  // rootId-only and nodeId-only incrementals keep flowing, with no origin.
  it('keeps broadcasting the incrementals of a board declared with no scope', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', { rootId: 'cli-root', nodes: [{ id: 'c1' }], edges: [] })
    workspaceBus.emit('monitor:substep', { rootId: 'cli-root', nodeId: 'c1', substep: 'writing' })
    workspaceBus.emit('progress:narrative', { nodeId: 'c1', narrative: 'step 1/3', lang: 'en' })

    expect(broadcasts).toHaveLength(3)
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

  // Round 10 #4: a nodeId nothing declared is not "everybody's" — it belongs to
  // whichever board owns that node, and not knowing which means nobody gets it.
  it('withholds a narrative for a nodeId the bridge has never seen declared', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-A', nodes: [{ id: 'a1' }], edges: [], conversationId: 'profile-A' })
    workspaceBus.emit('progress:narrative', { nodeId: 'stranger', narrative: 'x', lang: 'en' })

    expect(broadcasts).toHaveLength(1)
  })

  it('forgets the node→origin pairings on monitor:clear too', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-A', nodes: [{ id: 'a1' }], edges: [], conversationId: 'profile-A' })
    workspaceBus.emit('monitor:clear', {})
    workspaceBus.emit('progress:narrative', { nodeId: 'a1', narrative: 'x', lang: 'en' })

    // The boards are gone, so the node is no longer attributable — and an
    // unattributable narrative is withheld, not broadcast (round 10 #4).
    expect(broadcasts.map((m) => JSON.parse(m).type)).toEqual(['monitor:dag_init', 'monitor:clear'])
  })

  it('forgets the root→origin pairings on monitor:clear', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-1', nodes: [], edges: [], conversationId: 'profile-A' })
    workspaceBus.emit('monitor:clear', {})
    workspaceBus.emit('monitor:substep', { rootId: 'ep-1', nodeId: 'n1', substep: 's' })

    expect(broadcasts.map((m) => JSON.parse(m).type)).toEqual(['monitor:dag_init', 'monitor:clear'])
  })

  // ── Round 10 #4: capacity. Node ownership was a flat 200-entry LRU, which one
  // DAG exceeds: the 201st node evicted the FIRST node of the SAME board, so its
  // later progress:narrative — the milestone wording derived from Alice's
  // request — was broadcast to Bob. ──

  it('keeps attribution for every node of a 201-node board', () => {
    makeBridge().start()

    const nodes = Array.from({ length: 201 }, (_, i) => ({ id: `n${i}` }))
    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-A', nodes, edges: [], conversationId: 'profile-A' })
    // The FIRST node's narrative: the entry the old bound dropped.
    workspaceBus.emit('progress:narrative', { nodeId: 'n0', narrative: 'Alice: ship the secret thing', lang: 'en' })
    workspaceBus.emit('progress:narrative', { nodeId: 'n200', narrative: 'Alice: last node', lang: 'en' })

    expect(broadcasts.slice(1).map((m) => JSON.parse(m).origin)).toEqual(['profile-A', 'profile-A'])
  })

  it('keeps every board of 40 live 60-node DAGs apart', () => {
    makeBridge().start()

    for (let board = 0; board < 40; board++) {
      workspaceBus.emit('monitor:dag_init', {
        rootId: `ep-${board}`,
        nodes: Array.from({ length: 60 }, (_, i) => ({ id: `b${board}-n${i}` })),
        edges: [],
        conversationId: `profile-${board}`,
      })
    }
    broadcasts.length = 0
    // Every board's first node, in the order the boards were declared: the flat
    // LRU had long since evicted all but the last 200 node entries.
    for (let board = 0; board < 40; board++) {
      workspaceBus.emit('progress:narrative', { nodeId: `b${board}-n0`, narrative: 'x', lang: 'en' })
    }

    expect(broadcasts.map((m) => JSON.parse(m).origin)).toEqual(
      Array.from({ length: 40 }, (_, board) => `profile-${board}`),
    )
  })

  it('drops a whole least-recently-used board, never half of a live one', () => {
    makeBridge().start()

    // 201 boards: one more than the bound on tracked boards.
    for (let board = 0; board <= 200; board++) {
      workspaceBus.emit('monitor:dag_init', {
        rootId: `ep-${board}`,
        nodes: [{ id: `b${board}-n0` }, { id: `b${board}-n1` }],
        edges: [],
        conversationId: `profile-${board}`,
      })
    }
    broadcasts.length = 0
    // The oldest board is gone ENTIRELY — both its nodes fail closed, so nothing
    // of it reaches anybody…
    workspaceBus.emit('progress:narrative', { nodeId: 'b0-n0', narrative: 'x', lang: 'en' })
    workspaceBus.emit('progress:narrative', { nodeId: 'b0-n1', narrative: 'x', lang: 'en' })
    expect(broadcasts).toEqual([])
    // …while the newest board keeps both of its nodes.
    workspaceBus.emit('progress:narrative', { nodeId: 'b200-n0', narrative: 'x', lang: 'en' })
    workspaceBus.emit('progress:narrative', { nodeId: 'b200-n1', narrative: 'x', lang: 'en' })
    expect(broadcasts.map((m) => JSON.parse(m).origin)).toEqual(['profile-200', 'profile-200'])
  })

  // The extreme case: ONE board bigger than the whole node bound. It keeps what
  // it already declared (the first nodes stay attributed) and simply stops
  // remembering — the overflow fails closed instead of being broadcast, and the
  // board never forgets half of itself.
  it('a board larger than the node bound keeps its early nodes and fails closed on the rest', () => {
    makeBridge().start()

    const nodes = Array.from({ length: 10_001 }, (_, i) => ({ id: `n${i}` }))
    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-A', nodes, edges: [], conversationId: 'profile-A' })
    broadcasts.length = 0

    workspaceBus.emit('progress:narrative', { nodeId: 'n0', narrative: 'x', lang: 'en' })
    workspaceBus.emit('progress:narrative', { nodeId: 'n9999', narrative: 'x', lang: 'en' })
    workspaceBus.emit('progress:narrative', { nodeId: 'n10000', narrative: 'x', lang: 'en' })

    expect(broadcasts.map((m) => JSON.parse(m).origin)).toEqual(['profile-A', 'profile-A'])
  })

  it('a board still in use is not the one eviction picks', () => {
    makeBridge().start()

    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-old', nodes: [{ id: 'old-n' }], edges: [], conversationId: 'profile-A' })
    for (let board = 0; board < 199; board++) {
      workspaceBus.emit('monitor:dag_init', { rootId: `ep-${board}`, nodes: [], edges: [], conversationId: 'profile-B' })
    }
    // Using the oldest board makes it the newest…
    workspaceBus.emit('progress:narrative', { nodeId: 'old-n', narrative: 'x', lang: 'en' })
    // …so the next board to arrive evicts something else.
    workspaceBus.emit('monitor:dag_init', { rootId: 'ep-new', nodes: [], edges: [], conversationId: 'profile-C' })

    broadcasts.length = 0
    workspaceBus.emit('progress:narrative', { nodeId: 'old-n', narrative: 'x', lang: 'en' })
    expect(broadcasts.map((m) => JSON.parse(m).origin)).toEqual(['profile-A'])
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

    workspaceBus.emit('monitor:dag_init', { rootId: 'root-1', nodes: [{ id: 'node-1' }], edges: [] })
    workspaceBus.emit('monitor:gate_request', {
      rootId: 'root-1',
      nodeId: 'node-1',
      gateType: 'review_stuck',
      message: 'Task stuck',
    })

    expect(broadcasts).toHaveLength(2)
    const parsed = JSON.parse(broadcasts[1])
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

    workspaceBus.emit('monitor:dag_init', { rootId: 'root-1', nodes: [{ id: 'node-1' }], edges: [] })
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

    expect(broadcasts).toHaveLength(4)
    expect(JSON.parse(broadcasts[0]).type).toBe('monitor:dag_init')
    expect(JSON.parse(broadcasts[1]).type).toBe('monitor:task_update')
    expect(JSON.parse(broadcasts[2]).type).toBe('monitor:agent_activity')
    expect(JSON.parse(broadcasts[3]).type).toBe('monitor:review_result')
  })
})
