import { describe, it, expect, beforeEach } from 'vitest'
import { useMonitorStore } from '../stores/monitor-store'
import { useCodeStore } from '../stores/code-store'
import { useCanvasStore } from '../stores/canvas-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { dispatchWorkspaceMessage } from '../hooks/use-dashboard-socket'

describe('workspace performance benchmarks', () => {
  beforeEach(() => {
    useMonitorStore.getState().clearMonitor()
    useWorkspaceStore.getState().reset()
    useCodeStore.getState().reset()
    useCanvasStore.getState().reset()
  })

  it('DAG with 50+ nodes initializes under 50ms', () => {
    const nodes = Array.from({ length: 60 }, (_, i) => ({
      id: `node-${i}`,
      title: `Task ${i}`,
      status: i < 20 ? 'completed' : i < 40 ? 'executing' : 'pending',
      reviewStatus: 'none',
    }))
    const edges = Array.from({ length: 50 }, (_, i) => ({
      source: `node-${i}`,
      target: `node-${i + 1}`,
    }))

    const start = performance.now()
    dispatchWorkspaceMessage({
      type: 'monitor:dag_init',
      rootId: 'perf-root',
      dag: { nodes, edges },
    })
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(50)
    const state = useMonitorStore.getState()
    expect(Object.keys(state.tasks)).toHaveLength(60)
    expect(state.dag?.nodes).toHaveLength(60)
  })

  it('100 rapid task updates process under 100ms', () => {
    // Initialize DAG first
    const nodes = Array.from({ length: 100 }, (_, i) => ({
      id: `n-${i}`,
      title: `Task ${i}`,
      status: 'pending',
      reviewStatus: 'none',
    }))
    dispatchWorkspaceMessage({
      type: 'monitor:dag_init',
      rootId: 'update-root',
      dag: { nodes, edges: [] },
    })

    const start = performance.now()
    for (let i = 0; i < 100; i++) {
      dispatchWorkspaceMessage({
        type: 'monitor:task_update',
        taskId: `n-${i}`,
        updates: { status: 'completed' },
      })
    }
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(100)
    const state = useMonitorStore.getState()
    expect(Object.values(state.tasks).every((t) => t.status === 'completed')).toBe(true)
  })

  it('opening 50 code tabs processes under 50ms', () => {
    const start = performance.now()
    for (let i = 0; i < 50; i++) {
      dispatchWorkspaceMessage({
        type: 'code:file_open',
        path: `src/file-${i}.ts`,
        content: `// File ${i}\n`.repeat(100),
        language: 'typescript',
        touchedStatus: 'new',
      })
    }
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(50)
    expect(useCodeStore.getState().tabs).toHaveLength(50)
    expect(useCodeStore.getState().touchedFiles.size).toBe(50)
  })

  it('5000 terminal output lines stay within cap', () => {
    const start = performance.now()
    for (let i = 0; i < 5100; i++) {
      useCodeStore.getState().appendTerminal(`[${i}] Build output line...`)
    }
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(500)
    // Cap is 5000
    expect(useCodeStore.getState().terminalOutput.length).toBeLessThanOrEqual(5000)
  })

  it('100 canvas shape additions process under 50ms', () => {
    const start = performance.now()
    for (let i = 0; i < 100; i++) {
      dispatchWorkspaceMessage({
        type: 'canvas:shapes_add',
        shapes: [{ type: 'code-block', id: `shape-${i}`, props: { code: `console.log(${i})` } }],
      })
    }
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(50)
    expect(useCanvasStore.getState().pendingShapes).toHaveLength(100)
  })

  it('50 rapid mode suggestions process under 20ms', () => {
    const modes = ['monitor', 'code', 'canvas', 'chat'] as const
    const start = performance.now()
    for (let i = 0; i < 50; i++) {
      dispatchWorkspaceMessage({
        type: 'workspace:mode_suggest',
        mode: modes[i % 4],
        reason: `Auto-switch ${i}`,
      })
    }
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(20)
  })

  it('notification queue caps at 50', () => {
    for (let i = 0; i < 60; i++) {
      useWorkspaceStore.getState().addNotification({
        title: `Notification ${i}`,
        message: `Message ${i}`,
        severity: 'info',
      })
    }
    expect(useWorkspaceStore.getState().notifications.length).toBeLessThanOrEqual(50)
  })

  it('WS event dispatch latency under 1ms per event', () => {
    const events = [
      { type: 'monitor:agent_activity', action: 'tool_execute', tool: 'file_write', detail: 'wrote file', timestamp: Date.now() },
      { type: 'workspace:notification', title: 'Info', message: 'test', severity: 'info' as const },
      { type: 'code:terminal_output', content: 'test output' },
    ]

    const iterations = 100
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      for (const event of events) {
        dispatchWorkspaceMessage(event)
      }
    }
    const elapsed = performance.now() - start
    const perEvent = elapsed / (iterations * events.length)

    expect(perEvent).toBeLessThan(1)
  })
})
