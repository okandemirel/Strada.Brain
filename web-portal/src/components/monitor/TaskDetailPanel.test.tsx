import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MonitorTask } from '../../stores/monitor-store'

let mockSelectedTaskId: string | null = null
let mockTasks: Record<string, MonitorTask> = {}

vi.mock('../../stores/monitor-store', () => ({
  useMonitorStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      selectedTaskId: mockSelectedTaskId,
      tasks: mockTasks,
    }
    return selector ? selector(state) : state
  },
}))

import TaskDetailPanel from './TaskDetailPanel'

function makeTask(overrides: Partial<MonitorTask> & { id: string }): MonitorTask {
  return {
    nodeId: overrides.id,
    title: `Task ${overrides.id}`,
    status: 'pending',
    reviewStatus: 'none',
    ...overrides,
  }
}

describe('TaskDetailPanel', () => {
  beforeEach(() => {
    mockSelectedTaskId = null
    mockTasks = {}
  })

  it('shows placeholder when no task is selected', () => {
    render(<TaskDetailPanel />)
    expect(screen.getByText('Select a task to see details.')).toBeInTheDocument()
  })

  it('shows placeholder when selectedTaskId does not match any task', () => {
    mockSelectedTaskId = 'nonexistent'
    render(<TaskDetailPanel />)
    expect(screen.getByText('Select a task to see details.')).toBeInTheDocument()
  })

  it('shows task title when selected', () => {
    mockTasks = { t1: makeTask({ id: 't1', title: 'Deploy Service' }) }
    mockSelectedTaskId = 't1'
    render(<TaskDetailPanel />)
    expect(screen.getByText('Deploy Service')).toBeInTheDocument()
  })

  it('shows task status and review status', () => {
    mockTasks = {
      t1: makeTask({ id: 't1', status: 'executing', reviewStatus: 'spec_review' }),
    }
    mockSelectedTaskId = 't1'
    render(<TaskDetailPanel />)
    expect(screen.getByText('executing')).toBeInTheDocument()
    expect(screen.getByText('spec review')).toBeInTheDocument()
  })

  it('shows agent ID when present', () => {
    mockTasks = {
      t1: makeTask({ id: 't1', agentId: 'agent-42' }),
    }
    mockSelectedTaskId = 't1'
    render(<TaskDetailPanel />)
    expect(screen.getByText('agent-42')).toBeInTheDocument()
  })

  it('shows dependencies when present', () => {
    mockTasks = {
      t1: makeTask({ id: 't1', dependencies: ['dep-a', 'dep-b'] }),
    }
    mockSelectedTaskId = 't1'
    render(<TaskDetailPanel />)
    expect(screen.getByText('dep-a')).toBeInTheDocument()
    expect(screen.getByText('dep-b')).toBeInTheDocument()
  })

  it('does not show agent section when agentId is absent', () => {
    mockTasks = {
      t1: makeTask({ id: 't1' }),
    }
    mockSelectedTaskId = 't1'
    render(<TaskDetailPanel />)
    expect(screen.queryByText('Agent:')).not.toBeInTheDocument()
  })

  it('shows the latest narrative update when present', () => {
    mockTasks = {
      t1: makeTask({
        id: 't1',
        narrative: 'Plan ready: 4 steps are lined up.',
        milestone: { current: 0, total: 4, label: 'steps' },
      }),
    }
    mockSelectedTaskId = 't1'
    render(<TaskDetailPanel />)
    expect(screen.getByText('Latest Update')).toBeInTheDocument()
    expect(screen.getByText('Plan ready: 4 steps are lined up.')).toBeInTheDocument()
    expect(screen.getByText('0/4')).toBeInTheDocument()
    expect(screen.getByText('steps')).toBeInTheDocument()
  })
})
