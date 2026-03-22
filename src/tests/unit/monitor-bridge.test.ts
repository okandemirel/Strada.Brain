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
