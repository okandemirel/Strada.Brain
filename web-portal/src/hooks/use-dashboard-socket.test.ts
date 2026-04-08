import { describe, it, expect, beforeEach } from 'vitest'
import { useMonitorStore } from '../stores/monitor-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useCodeStore } from '../stores/code-store'
import { useCanvasStore } from '../stores/canvas-store'
import { dispatchWorkspaceMessage, isWorkspaceMessage } from './use-dashboard-socket'

describe('dispatchWorkspaceMessage', () => {
  beforeEach(() => {
    useMonitorStore.getState().clearMonitor()
    useWorkspaceStore.getState().reset()
    useCanvasStore.getState().reset()
  })

  it('handles monitor:dag_init by setting DAG and tasks', () => {
    dispatchWorkspaceMessage({
      type: 'monitor:dag_init',
      rootId: 'root-1',
      dag: {
        nodes: [
          { id: 'n1', title: 'Task 1', status: 'pending', reviewStatus: 'none' },
          { id: 'n2', title: 'Task 2', status: 'pending', reviewStatus: 'none' },
        ],
        edges: [{ source: 'n1', target: 'n2' }],
      },
    })

    const state = useMonitorStore.getState()
    expect(state.activeRootId).toBe('root-1')
    expect(state.dag).not.toBeNull()
    expect(state.dag!.nodes).toHaveLength(2)
    expect(state.dag!.edges).toHaveLength(1)
    expect(Object.keys(state.tasks)).toHaveLength(2)
    expect(state.tasks['n1'].title).toBe('Task 1')
  })

  it('handles monitor:task_update by updating a task', () => {
    // Add initial task
    useMonitorStore.getState().addTask({
      id: 'n1',
      nodeId: 'n1',
      title: 'Task 1',
      status: 'pending',
      reviewStatus: 'none',
    })

    dispatchWorkspaceMessage({
      type: 'monitor:task_update',
      nodeId: 'n1',
      updates: { status: 'executing', reviewStatus: 'spec_review' },
    })

    expect(useMonitorStore.getState().tasks['n1'].status).toBe('executing')
    expect(useMonitorStore.getState().tasks['n1'].reviewStatus).toBe('spec_review')
  })

  it('handles monitor:agent_activity by adding an activity entry', () => {
    dispatchWorkspaceMessage({
      type: 'monitor:agent_activity',
      activity: {
        taskId: 'n1',
        action: 'tool_execute',
        tool: 'read',
        detail: 'Reading config.ts',
        timestamp: Date.now(),
      },
    })

    const activities = useMonitorStore.getState().activities
    expect(activities).toHaveLength(1)
    expect(activities[0].tool).toBe('read')
  })

  it('handles progress:narrative by updating the task and activity feed', () => {
    useMonitorStore.getState().addTask({
      id: 'n1',
      nodeId: 'n1',
      title: 'Task 1',
      status: 'executing',
      reviewStatus: 'none',
    })

    dispatchWorkspaceMessage({
      type: 'progress:narrative',
      payload: {
        nodeId: 'n1',
        narrative: 'Plan ready: 3 steps are lined up.',
        milestone: { current: 0, total: 3, label: 'steps' },
      },
      timestamp: 123,
    })

    const state = useMonitorStore.getState()
    expect(state.tasks['n1'].narrative).toBe('Plan ready: 3 steps are lined up.')
    expect(state.tasks['n1'].milestone).toEqual({ current: 0, total: 3, label: 'steps' })
    expect(state.activities.at(-1)).toMatchObject({
      taskId: 'n1',
      action: 'progress_narrative',
      detail: 'Plan ready: 3 steps are lined up.',
      timestamp: 123,
    })
  })

  it('handles workspace:mode_suggest by suggesting mode', () => {
    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'monitor',
    })

    expect(useWorkspaceStore.getState().mode).toBe('monitor')
  })

  it('handles canvas:shapes_add by queueing agent shapes and switching to canvas', () => {
    dispatchWorkspaceMessage({
      type: 'canvas:shapes_add',
      payload: {
        shapes: [
          { type: 'note-block', id: 'shape-1', props: { content: 'hello' } },
        ],
      },
    })

    expect(useWorkspaceStore.getState().mode).toBe('canvas')
    expect(useCanvasStore.getState().pendingShapes[0].source).toBe('agent')
  })

  it('handles canvas:shapes_update by queueing mutation updates', () => {
    dispatchWorkspaceMessage({
      type: 'canvas:shapes_update',
      payload: {
        shapes: [
          { id: 'shape-2', type: 'note-block', props: { content: 'updated note', color: '#fbbf24' } },
        ],
      },
    })

    expect(useCanvasStore.getState().pendingUpdates).toEqual([
      {
        id: 'shape-2',
        type: 'note-block',
        props: { w: 280, h: 160, content: 'updated note', color: '#fbbf24', source: 'agent' },
        source: 'agent',
      },
    ])
  })

  it('handles canvas:shapes_remove by queueing removals', () => {
    dispatchWorkspaceMessage({
      type: 'canvas:shapes_remove',
      payload: {
        shapeIds: ['shape-3'],
      },
    })

    expect(useCanvasStore.getState().pendingRemovals).toEqual(['shape-3'])
  })

  it('handles canvas:viewport by queueing a viewport intent and switching to canvas', () => {
    dispatchWorkspaceMessage({
      type: 'canvas:viewport',
      payload: {
        x: 12,
        y: 24,
        zoom: 1.5,
      },
    })

    expect(useWorkspaceStore.getState().mode).toBe('canvas')
    expect(useCanvasStore.getState().pendingViewport).toEqual({ x: 12, y: 24, zoom: 1.5 })
  })

  it('handles canvas:arrange by queueing a layout intent and switching to canvas', () => {
    dispatchWorkspaceMessage({
      type: 'canvas:arrange',
      payload: {
        layout: 'flow',
      },
    })

    expect(useWorkspaceStore.getState().mode).toBe('canvas')
    expect(useCanvasStore.getState().pendingLayout).toBe('flow')
  })

  it('handles canvas:agent_draw updates by queueing updates and switching to canvas', () => {
    dispatchWorkspaceMessage({
      type: 'canvas:agent_draw',
      payload: {
        action: 'update',
        shapes: [
          { id: 'shape-4', type: 'diagram-node', props: { label: 'Updated' } },
        ],
      },
    })

    expect(useWorkspaceStore.getState().mode).toBe('canvas')
    expect(useCanvasStore.getState().pendingUpdates).toEqual([
      {
        id: 'shape-4',
        type: 'diagram-node',
        props: {
          w: 200,
          h: 100,
          label: 'Updated',
          nodeType: 'diagram',
          status: 'active',
          source: 'agent',
        },
        source: 'agent',
      },
    ])
  })

  it('handles canvas:agent_draw view metadata by queueing viewport and layout intents', () => {
    dispatchWorkspaceMessage({
      type: 'canvas:agent_draw',
      payload: {
        action: 'draw',
        layout: 'tree',
        viewport: { x: 5, y: 9, zoom: 1.25 },
        shapes: [
          { id: 'shape-meta-1', type: 'task-card', props: { title: 'Task' } },
        ],
      },
    })

    expect(useCanvasStore.getState().pendingLayout).toBe('tree')
    expect(useCanvasStore.getState().pendingViewport).toEqual({ x: 5, y: 9, zoom: 1.25 })
  })

  it('keeps the current mode when canvas:agent_draw opts out of auto-switch', () => {
    dispatchWorkspaceMessage({
      type: 'canvas:agent_draw',
      payload: {
        action: 'update',
        autoSwitch: false,
        shapes: [
          { id: 'shape-5', type: 'diagram-node', props: { label: 'Background sync' } },
        ],
      },
    })

    expect(useWorkspaceStore.getState().mode).toBe('chat')
    expect(useCanvasStore.getState().pendingUpdates).toEqual([
      {
        id: 'shape-5',
        type: 'diagram-node',
        props: { w: 200, h: 100, label: 'Background sync', nodeType: 'diagram', status: 'active', source: 'agent' },
        source: 'agent',
      },
    ])
  })

  it('does not override user-set mode on workspace:mode_suggest', () => {
    useWorkspaceStore.getState().setMode('canvas')

    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'monitor',
    })

    expect(useWorkspaceStore.getState().mode).toBe('canvas')
  })

  it('handles monitor:clear by clearing monitor state', () => {
    useMonitorStore.getState().addTask({
      id: 'n1',
      nodeId: 'n1',
      title: 'T',
      status: 'pending',
      reviewStatus: 'none',
    })

    dispatchWorkspaceMessage({ type: 'monitor:clear' })

    expect(useMonitorStore.getState().tasks).toEqual({})
    expect(useMonitorStore.getState().dag).toBeNull()
  })

  it('ignores unknown message types', () => {
    // Should not throw
    dispatchWorkspaceMessage({ type: 'unknown:something' })

    const state = useMonitorStore.getState()
    expect(state.tasks).toEqual({})
  })
})

describe('dispatchWorkspaceMessage — workspace:notification', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset()
  })

  it('adds notification to workspace store', () => {
    dispatchWorkspaceMessage({
      type: 'workspace:notification',
      title: 'Build Complete',
      message: 'Project built successfully',
      severity: 'info',
    })

    const notifications = useWorkspaceStore.getState().notifications
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Build Complete')
    expect(notifications[0].message).toBe('Project built successfully')
    expect(notifications[0].severity).toBe('info')
  })

  it('handles payload wrapper for notification', () => {
    dispatchWorkspaceMessage({
      type: 'workspace:notification',
      payload: {
        title: 'Error',
        message: 'Something failed',
        severity: 'error',
      },
    })

    const notifications = useWorkspaceStore.getState().notifications
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Error')
    expect(notifications[0].severity).toBe('error')
  })
})

describe('dispatchWorkspaceMessage — payload envelope unwrap', () => {
  beforeEach(() => {
    useMonitorStore.getState().clearMonitor()
    useWorkspaceStore.getState().reset()
  })

  it('unwraps monitor:dag_init from payload envelope', () => {
    dispatchWorkspaceMessage({
      type: 'monitor:dag_init',
      payload: {
        rootId: 'wrapped-root',
        dag: {
          nodes: [{ id: 'w1', title: 'Wrapped', status: 'pending', reviewStatus: 'none' }],
          edges: [],
        },
      },
      timestamp: Date.now(),
    })

    const state = useMonitorStore.getState()
    expect(state.activeRootId).toBe('wrapped-root')
    expect(Object.keys(state.tasks)).toHaveLength(1)
    expect(state.tasks['w1'].title).toBe('Wrapped')
  })

  it('unwraps workspace:mode_suggest from payload envelope', () => {
    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      payload: { mode: 'monitor' },
      timestamp: Date.now(),
    })

    expect(useWorkspaceStore.getState().mode).toBe('monitor')
  })
})

describe('isWorkspaceMessage — code prefix', () => {
  it('returns true for code: prefix', () => {
    expect(isWorkspaceMessage('code:file_open')).toBe(true)
    expect(isWorkspaceMessage('code:file_update')).toBe(true)
    expect(isWorkspaceMessage('code:terminal_output')).toBe(true)
    expect(isWorkspaceMessage('code:terminal_clear')).toBe(true)
    expect(isWorkspaceMessage('code:annotation_add')).toBe(true)
    expect(isWorkspaceMessage('code:annotation_clear')).toBe(true)
  })

  it('returns true for progress: prefix', () => {
    expect(isWorkspaceMessage('progress:narrative')).toBe(true)
  })
})

describe('dispatchWorkspaceMessage — mode_suggest notifications', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset()
  })

  it('mode_suggest adds "Mode switched" notification when mode changes', () => {
    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'monitor',
    })

    const state = useWorkspaceStore.getState()
    expect(state.mode).toBe('monitor')
    expect(state.notifications).toHaveLength(1)
    expect(state.notifications[0].title).toBe('Mode switched')
    expect(state.notifications[0].message).toContain('monitor')
    expect(state.notifications[0].severity).toBe('info')
  })

  it('mode_suggest does NOT add notification when userOverride is true', () => {
    useWorkspaceStore.getState().setMode('canvas')

    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'monitor',
    })

    const state = useWorkspaceStore.getState()
    // Mode should NOT change because userOverride is true
    expect(state.mode).toBe('canvas')
    expect(state.notifications).toHaveLength(0)
  })

  it('mode_suggest does NOT add notification when mode is already the same', () => {
    // suggestMode to monitor first
    useWorkspaceStore.getState().suggestMode('monitor')
    expect(useWorkspaceStore.getState().mode).toBe('monitor')

    // Now suggest the same mode again
    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'monitor',
    })

    // No notification should be added because mode didn't change
    expect(useWorkspaceStore.getState().notifications).toHaveLength(0)
  })
})

describe('dispatchWorkspaceMessage — code:* events', () => {
  beforeEach(() => {
    useCodeStore.getState().reset()
    useWorkspaceStore.getState().reset()
  })

  it('code:file_open dispatches to useCodeStore.openFile, marks touched when provided, and switches to code', () => {
    dispatchWorkspaceMessage({
      type: 'code:file_open',
      path: 'src/index.ts',
      content: 'console.log("hi")',
      language: 'typescript',
      touchedStatus: 'new',
    })

    const state = useCodeStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].path).toBe('src/index.ts')
    expect(state.tabs[0].content).toBe('console.log("hi")')
    expect(state.tabs[0].language).toBe('typescript')
    expect(state.activeTab).toBe('src/index.ts')
    expect(state.touchedFiles['src/index.ts']).toBe('new')
    expect(useWorkspaceStore.getState().mode).toBe('code')
  })

  it('code:file_update dispatches to useCodeStore.openFile with isDiff and markTouched("modified")', () => {
    dispatchWorkspaceMessage({
      type: 'code:file_update',
      path: 'src/app.ts',
      diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new',
      original: 'old',
      modified: 'new',
    })

    const state = useCodeStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].path).toBe('src/app.ts')
    expect(state.tabs[0].isDiff).toBe(true)
    expect(state.tabs[0].diffContent).toContain('-old')
    expect(state.tabs[0].originalContent).toBe('old')
    expect(state.tabs[0].modifiedContent).toBe('new')
    expect(state.activeTab).toBe('src/app.ts')
    expect(state.touchedFiles['src/app.ts']).toBe('modified')
  })

  it('code:terminal_output appends to terminal with command prefix', () => {
    dispatchWorkspaceMessage({
      type: 'code:terminal_output',
      command: 'npm test',
      content: 'All tests passed',
    })

    const output = useCodeStore.getState().terminalOutput
    expect(output).toHaveLength(1)
    expect(output[0]).toBe('$ npm test\nAll tests passed')
  })

  it('code:terminal_clear clears terminal', () => {
    useCodeStore.getState().appendTerminal('existing output')
    expect(useCodeStore.getState().terminalOutput).toHaveLength(1)

    dispatchWorkspaceMessage({ type: 'code:terminal_clear' })

    expect(useCodeStore.getState().terminalOutput).toEqual([])
  })

  it('code:annotation_add adds annotation', () => {
    dispatchWorkspaceMessage({
      type: 'code:annotation_add',
      path: 'src/util.ts',
      line: 42,
      message: 'Unused variable',
      severity: 'warning',
    })

    const anns = useCodeStore.getState().annotations
    expect(anns).toHaveLength(1)
    expect(anns[0].path).toBe('src/util.ts')
    expect(anns[0].line).toBe(42)
    expect(anns[0].message).toBe('Unused variable')
    expect(anns[0].severity).toBe('warning')
  })

  it('code:annotation_clear clears annotations for path', () => {
    useCodeStore.getState().addAnnotation({ path: 'a.ts', line: 1, message: 'err', severity: 'error' })
    useCodeStore.getState().addAnnotation({ path: 'b.ts', line: 2, message: 'warn', severity: 'warning' })

    dispatchWorkspaceMessage({
      type: 'code:annotation_clear',
      path: 'a.ts',
    })

    const anns = useCodeStore.getState().annotations
    expect(anns).toHaveLength(1)
    expect(anns[0].path).toBe('b.ts')
  })

  it('code:file_open handles payload wrapper (data.payload.path)', () => {
    dispatchWorkspaceMessage({
      type: 'code:file_open',
      payload: {
        path: 'src/wrapped.ts',
        content: 'wrapped content',
        language: 'typescript',
        touchedStatus: 'new',
      },
    })

    const state = useCodeStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].path).toBe('src/wrapped.ts')
    expect(state.tabs[0].content).toBe('wrapped content')
    expect(state.activeTab).toBe('src/wrapped.ts')
    expect(state.touchedFiles['src/wrapped.ts']).toBe('new')
  })

  it('code:file_open without touchedStatus leaves changed-files list untouched', () => {
    dispatchWorkspaceMessage({
      type: 'code:file_open',
      path: 'src/read-only.ts',
      content: 'const value = 1',
      language: 'typescript',
    })

    const state = useCodeStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(Object.keys(state.touchedFiles).length).toBe(0)
    expect(useWorkspaceStore.getState().mode).toBe('code')
  })
})
