import { describe, it, expect, beforeEach } from 'vitest'
import { useMonitorStore } from '../stores/monitor-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useCodeStore } from '../stores/code-store'
import { dispatchWorkspaceMessage, isWorkspaceMessage } from './use-dashboard-socket'

describe('dispatchWorkspaceMessage', () => {
  beforeEach(() => {
    useMonitorStore.getState().clearMonitor()
    useWorkspaceStore.getState().reset()
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

  it('handles workspace:mode_suggest by suggesting mode', () => {
    dispatchWorkspaceMessage({
      type: 'workspace:mode_suggest',
      mode: 'monitor',
    })

    expect(useWorkspaceStore.getState().mode).toBe('monitor')
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
  })

  it('code:file_open dispatches to useCodeStore.openFile and markTouched("new")', () => {
    dispatchWorkspaceMessage({
      type: 'code:file_open',
      path: 'src/index.ts',
      content: 'console.log("hi")',
      language: 'typescript',
    })

    const state = useCodeStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].path).toBe('src/index.ts')
    expect(state.tabs[0].content).toBe('console.log("hi")')
    expect(state.tabs[0].language).toBe('typescript')
    expect(state.activeTab).toBe('src/index.ts')
    expect(state.touchedFiles.get('src/index.ts')).toBe('new')
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
    expect(state.touchedFiles.get('src/app.ts')).toBe('modified')
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
      },
    })

    const state = useCodeStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].path).toBe('src/wrapped.ts')
    expect(state.tabs[0].content).toBe('wrapped content')
    expect(state.activeTab).toBe('src/wrapped.ts')
    expect(state.touchedFiles.get('src/wrapped.ts')).toBe('new')
  })
})
