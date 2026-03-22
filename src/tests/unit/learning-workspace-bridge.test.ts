import { describe, it, expect, beforeEach } from 'vitest'
import { TypedEventBus } from '../../core/event-bus.js'
import type { LearningEventMap, ToolResultEvent } from '../../core/event-bus.js'
import type { DaemonEventMap } from '../../daemon/daemon-events.js'
import type { WorkspaceEventMap } from '../../dashboard/workspace-events.js'
import { createLearningWorkspaceBridge } from '../../dashboard/learning-workspace-bridge.js'

function makeLearningBus() {
  return new TypedEventBus<LearningEventMap>()
}

function makeDaemonBus() {
  return new TypedEventBus<DaemonEventMap>()
}

function makeWorkspaceBus() {
  return new TypedEventBus<WorkspaceEventMap>()
}

describe('createLearningWorkspaceBridge', () => {
  let learningBus: TypedEventBus<LearningEventMap>
  let daemonBus: TypedEventBus<DaemonEventMap>
  let workspaceBus: TypedEventBus<WorkspaceEventMap>

  beforeEach(() => {
    learningBus = makeLearningBus()
    daemonBus = makeDaemonBus()
    workspaceBus = makeWorkspaceBus()
  })

  it('tool:result on learning bus → monitor:agent_activity on workspace bus', () => {
    const bridge = createLearningWorkspaceBridge(learningBus, daemonBus, workspaceBus)
    bridge.start()

    const received: WorkspaceEventMap['monitor:agent_activity'][] = []
    workspaceBus.on('monitor:agent_activity', (ev) => received.push(ev))

    const toolEvent: ToolResultEvent = {
      sessionId: 'sess-1',
      toolName: 'readFile',
      input: { path: '/tmp/x' },
      output: 'content',
      success: true,
      timestamp: 1000,
    }
    learningBus.emit('tool:result', toolEvent)

    expect(received).toHaveLength(1)
    expect(received[0].tool).toBe('readFile')
    expect(received[0].action).toBe('tool_execute')
    expect(received[0].timestamp).toBe(1000)
    expect(received[0].detail).toContain('readFile')
  })

  it('tool:result with failed tool maps success=false to detail', () => {
    const bridge = createLearningWorkspaceBridge(learningBus, daemonBus, workspaceBus)
    bridge.start()

    const received: WorkspaceEventMap['monitor:agent_activity'][] = []
    workspaceBus.on('monitor:agent_activity', (ev) => received.push(ev))

    const toolEvent: ToolResultEvent = {
      sessionId: 'sess-2',
      toolName: 'writeFile',
      input: {},
      output: '',
      success: false,
      timestamp: 2000,
    }
    learningBus.emit('tool:result', toolEvent)

    expect(received).toHaveLength(1)
    expect(received[0].detail).toContain('failed')
  })

  it('goal:status-changed on learning bus → monitor:task_update on workspace bus', () => {
    const bridge = createLearningWorkspaceBridge(learningBus, daemonBus, workspaceBus)
    bridge.start()

    const received: WorkspaceEventMap['monitor:task_update'][] = []
    workspaceBus.on('monitor:task_update', (ev) => received.push(ev))

    learningBus.emit('goal:status-changed', {
      rootId: 'root-abc' as ReturnType<typeof String>,
      nodeId: 'node-xyz' as ReturnType<typeof String>,
      status: 'completed',
      depth: 1,
      timestamp: 3000,
    } as LearningEventMap['goal:status-changed'])

    expect(received).toHaveLength(1)
    expect(received[0].rootId).toBe('root-abc')
    expect(received[0].nodeId).toBe('node-xyz')
    expect(received[0].status).toBe('completed')
  })

  it('goal:started on daemon bus → workspace:mode_suggest with mode=monitor', () => {
    const bridge = createLearningWorkspaceBridge(learningBus, daemonBus, workspaceBus)
    bridge.start()

    const received: WorkspaceEventMap['workspace:mode_suggest'][] = []
    workspaceBus.on('workspace:mode_suggest', (ev) => received.push(ev))

    daemonBus.emit('goal:started', {
      rootId: 'root-1',
      taskDescription: 'Deploy to production',
      nodeCount: 5,
      timestamp: 4000,
    })

    expect(received).toHaveLength(1)
    expect(received[0].mode).toBe('monitor')
    expect(received[0].reason).toContain('Deploy to production')
  })

  it('bridge.stop() removes all listeners — no events forwarded after stop', () => {
    const bridge = createLearningWorkspaceBridge(learningBus, daemonBus, workspaceBus)
    bridge.start()
    bridge.stop()

    const toolReceived: WorkspaceEventMap['monitor:agent_activity'][] = []
    const goalReceived: WorkspaceEventMap['monitor:task_update'][] = []
    const modeReceived: WorkspaceEventMap['workspace:mode_suggest'][] = []

    workspaceBus.on('monitor:agent_activity', (ev) => toolReceived.push(ev))
    workspaceBus.on('monitor:task_update', (ev) => goalReceived.push(ev))
    workspaceBus.on('workspace:mode_suggest', (ev) => modeReceived.push(ev))

    learningBus.emit('tool:result', {
      sessionId: 's',
      toolName: 'anyTool',
      input: {},
      output: '',
      success: true,
      timestamp: 5000,
    })
    learningBus.emit('goal:status-changed', {
      rootId: 'r' as ReturnType<typeof String>,
      nodeId: 'n' as ReturnType<typeof String>,
      status: 'pending',
      depth: 0,
      timestamp: 5001,
    } as LearningEventMap['goal:status-changed'])
    daemonBus.emit('goal:started', {
      rootId: 'r2',
      taskDescription: 'task',
      nodeCount: 1,
      timestamp: 5002,
    })

    expect(toolReceived).toHaveLength(0)
    expect(goalReceived).toHaveLength(0)
    expect(modeReceived).toHaveLength(0)
  })

  it('bridge handles missing optional fields gracefully', () => {
    const bridge = createLearningWorkspaceBridge(learningBus, daemonBus, workspaceBus)
    bridge.start()

    const received: WorkspaceEventMap['monitor:agent_activity'][] = []
    workspaceBus.on('monitor:agent_activity', (ev) => received.push(ev))

    // ToolResultEvent without optional fields (retryCount, appliedInstinctIds, errorDetails)
    const minimalEvent: ToolResultEvent = {
      sessionId: 'sess-min',
      toolName: 'minTool',
      input: {},
      output: '',
      success: true,
      timestamp: 9000,
    }
    // Should not throw
    expect(() => learningBus.emit('tool:result', minimalEvent)).not.toThrow()
    expect(received).toHaveLength(1)
    expect(received[0].taskId).toBeUndefined()
  })

  it('stop() is idempotent — calling twice does not throw', () => {
    const bridge = createLearningWorkspaceBridge(learningBus, daemonBus, workspaceBus)
    bridge.start()
    expect(() => {
      bridge.stop()
      bridge.stop()
    }).not.toThrow()
  })
})
