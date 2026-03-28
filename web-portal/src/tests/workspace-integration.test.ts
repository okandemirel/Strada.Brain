import { describe, it, expect, beforeEach } from 'vitest'
import { useMonitorStore } from '../stores/monitor-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useCanvasStore } from '../stores/canvas-store'
import { useCodeStore } from '../stores/code-store'
import { dispatchWorkspaceMessage } from '../hooks/use-dashboard-socket'

/**
 * Phase 6 — Workspace Integration Tests
 *
 * These tests exercise the full integration between dispatchWorkspaceMessage
 * and the Zustand stores. They verify auto-switch flows, override logic,
 * notification stacking, code event routing, and monitor event routing
 * using both flat messages and payload-wrapped envelopes.
 */

function resetAllStores(): void {
  useMonitorStore.getState().clearMonitor()
  useWorkspaceStore.getState().reset()
  useCanvasStore.getState().reset()
  useCodeStore.getState().reset()
}

// ─── Auto-switch flow ────────────────────────────────────────────────

describe('workspace integration — auto-switch flow', () => {
  beforeEach(resetAllStores)

  it('goal:started event via mode_suggest switches mode to monitor', () => {
    // Simulate backend sending a mode_suggest after goal:started
    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'monitor',
      reason: 'Goal execution started',
    })

    const ws = useWorkspaceStore.getState()
    expect(ws.mode).toBe('monitor')
    expect(ws.userOverride).toBe(false)
  })

  it('code:file_open event via mode_suggest switches mode to code', () => {
    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'code',
      reason: 'Agent opened a file',
    })

    expect(useWorkspaceStore.getState().mode).toBe('code')
  })

  it('canvas:shapes_add event dispatches shapes to canvas store', () => {
    dispatchWorkspaceMessage({
      type: 'canvas:shapes_add',
      payload: {
        shapes: [
          { type: 'Rectangle', id: 'r1', props: { width: 100, height: 50 } },
        ],
      },
    })

    const canvas = useCanvasStore.getState()
    expect(canvas.pendingShapes).toHaveLength(1)
    expect(canvas.pendingShapes[0].id).toBe('r1')
    expect(canvas.pendingShapes[0].source).toBe('agent')
    expect(useWorkspaceStore.getState().mode).toBe('canvas')
  })

  it('canvas:shapes_update event queues live canvas mutations', () => {
    dispatchWorkspaceMessage({
      type: 'canvas:shapes_update',
      payload: {
        shapes: [
          { id: 'r2', props: { width: 120, status: 'active' } },
        ],
      },
    })

    const canvas = useCanvasStore.getState()
    expect(canvas.pendingUpdates).toEqual([
      { id: 'r2', props: { source: 'agent', status: 'active', width: 120 }, source: 'agent' },
    ])
  })

  it('workspace:mode_suggest with reason shows reason text in notification', () => {
    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'monitor',
      reason: 'DAG execution began',
    })

    const notifications = useWorkspaceStore.getState().notifications
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Mode switched')
    expect(notifications[0].message).toBe('DAG execution began')
  })

  it('mode_suggest when userOverride=true does NOT change mode', () => {
    // User explicitly sets mode
    useWorkspaceStore.getState().setMode('canvas')
    expect(useWorkspaceStore.getState().userOverride).toBe(true)

    // Backend suggests switching to monitor
    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'monitor',
      reason: 'Goal started',
    })

    const ws = useWorkspaceStore.getState()
    expect(ws.mode).toBe('canvas')
    expect(ws.userOverride).toBe(true)
    // No notification should be added when mode didn't change
    expect(ws.notifications).toHaveLength(0)
  })
})

// ─── Override flow ───────────────────────────────────────────────────

describe('workspace integration — override flow', () => {
  beforeEach(resetAllStores)

  it('user setMode("canvas") sets userOverride=true and mode="canvas"', () => {
    useWorkspaceStore.getState().setMode('canvas')

    const ws = useWorkspaceStore.getState()
    expect(ws.mode).toBe('canvas')
    expect(ws.userOverride).toBe(true)
    expect(ws.previousMode).toBe('chat')
  })

  it('mode_suggest after user override keeps user choice', () => {
    useWorkspaceStore.getState().setMode('canvas')

    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'code',
      reason: 'File opened by agent',
    })

    expect(useWorkspaceStore.getState().mode).toBe('canvas')
    expect(useWorkspaceStore.getState().notifications).toHaveLength(0)
  })

  it('user sends chat message -> resetOverride -> mode="chat", userOverride=false', () => {
    // Simulate user having previously set a mode
    useWorkspaceStore.getState().setMode('code')
    expect(useWorkspaceStore.getState().userOverride).toBe(true)

    // Sending a chat message triggers resetOverride
    useWorkspaceStore.getState().resetOverride()

    const ws = useWorkspaceStore.getState()
    expect(ws.mode).toBe('chat')
    expect(ws.userOverride).toBe(false)
  })

  it('after resetOverride, mode_suggest works again', () => {
    // User sets override
    useWorkspaceStore.getState().setMode('canvas')
    expect(useWorkspaceStore.getState().userOverride).toBe(true)

    // User sends chat message (resetOverride)
    useWorkspaceStore.getState().resetOverride()
    expect(useWorkspaceStore.getState().userOverride).toBe(false)

    // Now mode_suggest should work
    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'monitor',
      reason: 'Goal resumed',
    })

    expect(useWorkspaceStore.getState().mode).toBe('monitor')
    expect(useWorkspaceStore.getState().notifications).toHaveLength(1)
  })

  it('undoModeSwitch after suggest restores previousMode', () => {
    // Start in chat, suggest monitor
    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'monitor',
      reason: 'Goal started',
    })

    expect(useWorkspaceStore.getState().mode).toBe('monitor')
    expect(useWorkspaceStore.getState().previousMode).toBe('chat')

    // User undoes the switch
    useWorkspaceStore.getState().undoModeSwitch()

    const ws = useWorkspaceStore.getState()
    expect(ws.mode).toBe('chat')
    expect(ws.previousMode).toBeNull()
    expect(ws.userOverride).toBe(false)
  })
})

// ─── Notification flow ──────────────────────────────────────────────

describe('workspace integration — notification flow', () => {
  beforeEach(resetAllStores)

  it('workspace:notification event adds notification to store', () => {
    dispatchWorkspaceMessage({
      type: 'workspace:notification',
      title: 'Build Complete',
      message: 'All tasks passed',
      severity: 'info',
    })

    const notifications = useWorkspaceStore.getState().notifications
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Build Complete')
    expect(notifications[0].message).toBe('All tasks passed')
    expect(notifications[0].severity).toBe('info')
  })

  it('multiple notifications stack (up to 50)', () => {
    for (let i = 0; i < 55; i++) {
      dispatchWorkspaceMessage({
        type: 'workspace:notification',
        title: `Notification ${i}`,
        message: `Message ${i}`,
        severity: 'info',
      })
    }

    const notifications = useWorkspaceStore.getState().notifications
    expect(notifications).toHaveLength(50)
    // First 5 should have been dropped
    expect(notifications[0].title).toBe('Notification 5')
    expect(notifications[49].title).toBe('Notification 54')
  })

  it('dismissNotification removes specific notification by id', () => {
    dispatchWorkspaceMessage({
      type: 'workspace:notification',
      title: 'Keep',
      message: 'stay',
      severity: 'info',
    })
    dispatchWorkspaceMessage({
      type: 'workspace:notification',
      title: 'Remove',
      message: 'go away',
      severity: 'warning',
    })

    const notifications = useWorkspaceStore.getState().notifications
    expect(notifications).toHaveLength(2)

    const removeId = notifications.find((n) => n.title === 'Remove')!.id
    useWorkspaceStore.getState().dismissNotification(removeId)

    const remaining = useWorkspaceStore.getState().notifications
    expect(remaining).toHaveLength(1)
    expect(remaining[0].title).toBe('Keep')
  })

  it('mode_suggest adds "Mode switched" notification with undo capability', () => {
    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'code',
      reason: 'Agent editing files',
    })

    const ws = useWorkspaceStore.getState()
    expect(ws.mode).toBe('code')
    expect(ws.notifications).toHaveLength(1)
    expect(ws.notifications[0].title).toBe('Mode switched')
    expect(ws.notifications[0].message).toBe('Agent editing files')

    // Verify undo is possible via previousMode
    expect(ws.previousMode).toBe('chat')
    useWorkspaceStore.getState().undoModeSwitch()
    expect(useWorkspaceStore.getState().mode).toBe('chat')
  })

  it('notification has correct timestamp and auto-generated id', () => {
    const before = Date.now()

    dispatchWorkspaceMessage({
      type: 'workspace:notification',
      title: 'Timestamped',
      message: 'Check timing',
      severity: 'info',
    })

    const after = Date.now()
    const notification = useWorkspaceStore.getState().notifications[0]

    expect(notification.id).toBeDefined()
    expect(typeof notification.id).toBe('string')
    expect(notification.id.length).toBeGreaterThan(0)
    expect(notification.timestamp).toBeGreaterThanOrEqual(before)
    expect(notification.timestamp).toBeLessThanOrEqual(after)
  })
})

// ─── Code event integration ─────────────────────────────────────────

describe('workspace integration — code event integration', () => {
  beforeEach(resetAllStores)

  it('code:file_open opens tab and marks file as touched', () => {
    dispatchWorkspaceMessage({
      type: 'code:file_open',
      path: 'src/main.ts',
      content: 'export default {}',
      language: 'typescript',
      touchedStatus: 'new',
    })

    const state = useCodeStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].path).toBe('src/main.ts')
    expect(state.tabs[0].content).toBe('export default {}')
    expect(state.tabs[0].language).toBe('typescript')
    expect(state.activeTab).toBe('src/main.ts')
    expect(state.touchedFiles.get('src/main.ts')).toBe('new')
    expect(useWorkspaceStore.getState().mode).toBe('code')
  })

  it('code:terminal_output appends with command prefix', () => {
    dispatchWorkspaceMessage({
      type: 'code:terminal_output',
      command: 'vitest run',
      content: 'Tests: 25 passed',
    })

    const output = useCodeStore.getState().terminalOutput
    expect(output).toHaveLength(1)
    expect(output[0]).toBe('$ vitest run\nTests: 25 passed')
  })

  it('code:annotation_add stores annotation', () => {
    dispatchWorkspaceMessage({
      type: 'code:annotation_add',
      path: 'src/config.ts',
      line: 15,
      message: 'Type mismatch',
      severity: 'error',
    })

    const annotations = useCodeStore.getState().annotations
    expect(annotations).toHaveLength(1)
    expect(annotations[0].path).toBe('src/config.ts')
    expect(annotations[0].line).toBe(15)
    expect(annotations[0].message).toBe('Type mismatch')
    expect(annotations[0].severity).toBe('error')
  })

  it('code:file_update updates existing tab with isDiff', () => {
    // First open the file normally
    dispatchWorkspaceMessage({
      type: 'code:file_open',
      path: 'src/utils.ts',
      content: 'export function add(a: number, b: number) { return a + b }',
      language: 'typescript',
      touchedStatus: 'new',
    })

    expect(useCodeStore.getState().touchedFiles.get('src/utils.ts')).toBe('new')

    // Then update it with a diff
    const diff = '--- a/src/utils.ts\n+++ b/src/utils.ts\n@@ -1 +1 @@\n-old\n+new'
    dispatchWorkspaceMessage({
      type: 'code:file_update',
      path: 'src/utils.ts',
      diff,
    })

    const state = useCodeStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].path).toBe('src/utils.ts')
    expect(state.tabs[0].isDiff).toBe(true)
    expect(state.tabs[0].diffContent).toBe(diff)
    // Content should be preserved from the original open
    expect(state.tabs[0].content).toBe('export function add(a: number, b: number) { return a + b }')
    expect(state.touchedFiles.get('src/utils.ts')).toBe('modified')
  })

  it('code:file_open without touchedStatus opens the tab without marking a change', () => {
    dispatchWorkspaceMessage({
      type: 'code:file_open',
      path: 'src/read.ts',
      content: 'export const read = true',
      language: 'typescript',
    })

    const state = useCodeStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTab).toBe('src/read.ts')
    expect(state.touchedFiles.size).toBe(0)
    expect(useWorkspaceStore.getState().mode).toBe('code')
  })

  it('code:terminal_clear empties terminal', () => {
    // Add some terminal output first
    dispatchWorkspaceMessage({
      type: 'code:terminal_output',
      content: 'line 1',
    })
    dispatchWorkspaceMessage({
      type: 'code:terminal_output',
      content: 'line 2',
    })
    expect(useCodeStore.getState().terminalOutput).toHaveLength(2)

    // Clear it
    dispatchWorkspaceMessage({ type: 'code:terminal_clear' })

    expect(useCodeStore.getState().terminalOutput).toEqual([])
  })
})

// ─── Monitor event integration ──────────────────────────────────────

describe('workspace integration — monitor event integration', () => {
  beforeEach(resetAllStores)

  it('monitor:dag_init with payload wrapper initializes DAG correctly', () => {
    dispatchWorkspaceMessage({
      type: 'monitor:dag_init',
      payload: {
        rootId: 'goal-42',
        nodes: [
          { id: 't1', task: 'Implement feature', status: 'pending', reviewStatus: 'none', depth: 0, dependsOn: [] },
          { id: 't2', task: 'Write tests', status: 'pending', reviewStatus: 'none', depth: 1, dependsOn: ['t1'] },
        ],
        edges: [{ source: 't1', target: 't2' }],
      },
      timestamp: Date.now(),
    })

    const monitor = useMonitorStore.getState()
    expect(monitor.activeRootId).toBe('goal-42')
    expect(monitor.dag).not.toBeNull()
    expect(monitor.dag!.nodes).toHaveLength(2)
    expect(monitor.dag!.edges).toHaveLength(1)
    expect(monitor.dag!.edges[0]).toEqual({ source: 't1', target: 't2' })
    expect(Object.keys(monitor.tasks)).toHaveLength(2)
    expect(monitor.tasks['t1'].title).toBe('Implement feature')
    expect(monitor.tasks['t2'].title).toBe('Write tests')
  })

  it('monitor:task_update with payload wrapper updates task', () => {
    // Set up initial task
    useMonitorStore.getState().addTask({
      id: 'n1',
      nodeId: 'n1',
      title: 'Build module',
      status: 'pending',
      reviewStatus: 'none',
    })

    dispatchWorkspaceMessage({
      type: 'monitor:task_update',
      payload: {
        taskId: 'n1',
        updates: { status: 'executing', agentId: 'agent-1' },
      },
      timestamp: Date.now(),
    })

    const task = useMonitorStore.getState().tasks['n1']
    expect(task.status).toBe('executing')
    expect(task.agentId).toBe('agent-1')
  })

  it('monitor:review_result updates task review status', () => {
    // Set up task
    useMonitorStore.getState().addTask({
      id: 'n1',
      nodeId: 'n1',
      title: 'Feature task',
      status: 'executing',
      reviewStatus: 'spec_review',
    })

    dispatchWorkspaceMessage({
      type: 'monitor:review_result',
      payload: {
        rootId: 'root-1',
        nodeId: 'n1',
        reviewType: 'spec_review',
        passed: true,
        issues: [],
        iteration: 1,
        maxIterations: 3,
      },
      timestamp: Date.now(),
    })

    const task = useMonitorStore.getState().tasks['n1']
    expect(task.reviewStatus).toBe('passed')
    expect(task.specReviewResult).toBeDefined()
    expect((task.specReviewResult as Record<string, unknown>).passed).toBe(true)
  })

  it('monitor:gate_request marks task as review_stuck', () => {
    // Set up task
    useMonitorStore.getState().addTask({
      id: 'n1',
      nodeId: 'n1',
      title: 'Stuck task',
      status: 'executing',
      reviewStatus: 'quality_review',
    })

    dispatchWorkspaceMessage({
      type: 'monitor:gate_request',
      payload: {
        rootId: 'root-1',
        nodeId: 'n1',
        gateType: 'review_stuck',
        message: 'Quality review failed 3 times',
      },
      timestamp: Date.now(),
    })

    const task = useMonitorStore.getState().tasks['n1']
    expect(task.reviewStatus).toBe('review_stuck')
  })

  it('monitor:dag_restructure rebuilds DAG', () => {
    // Initial DAG
    dispatchWorkspaceMessage({
      type: 'monitor:dag_init',
      rootId: 'root-1',
      dag: {
        nodes: [
          { id: 'a', title: 'Original A', status: 'done', reviewStatus: 'passed' },
        ],
        edges: [],
      },
    })

    expect(useMonitorStore.getState().dag!.nodes).toHaveLength(1)

    // Restructure with new nodes
    dispatchWorkspaceMessage({
      type: 'monitor:dag_restructure',
      payload: {
        rootId: 'root-1',
        nodes: [
          { id: 'a', task: 'Task A', status: 'done', reviewStatus: 'passed', depth: 0, dependsOn: [] },
          { id: 'b', task: 'Task B', status: 'pending', reviewStatus: 'none', depth: 1, dependsOn: ['a'] },
          { id: 'c', task: 'Task C', status: 'pending', reviewStatus: 'none', depth: 1, dependsOn: ['a'] },
        ],
        edges: [
          { source: 'a', target: 'b' },
          { source: 'a', target: 'c' },
        ],
      },
      timestamp: Date.now(),
    })

    const monitor = useMonitorStore.getState()
    expect(monitor.dag!.nodes).toHaveLength(3)
    expect(monitor.dag!.edges).toHaveLength(2)
    expect(Object.keys(monitor.tasks)).toHaveLength(3)
    expect(monitor.tasks['b'].title).toBe('Task B')
    expect(monitor.tasks['c'].title).toBe('Task C')
  })
})
