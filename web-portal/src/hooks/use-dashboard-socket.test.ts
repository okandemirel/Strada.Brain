import { describe, it, expect, beforeEach } from 'vitest'
import { useMonitorStore } from '../stores/monitor-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { dispatchWorkspaceMessage } from './use-dashboard-socket'

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
      taskId: 'n1',
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
