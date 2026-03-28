import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MonitorTask } from '../../stores/monitor-store'

const mockSendRawJSON = vi.fn().mockReturnValue(true)
let mockSelectedTaskId: string | null = null
let mockActiveRootId: string | null = null
let mockTasks: Record<string, MonitorTask> = {}

vi.mock('../../hooks/useWS', () => ({
  useWS: () => ({
    sendRawJSON: mockSendRawJSON,
  }),
}))

vi.mock('../../stores/monitor-store', () => ({
  useMonitorStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      selectedTaskId: mockSelectedTaskId,
      activeRootId: mockActiveRootId,
      tasks: mockTasks,
    }
    return selector ? selector(state) : state
  },
}))

vi.mock('lucide-react', () => ({
  RotateCcw: () => <svg data-testid="retry-icon" />,
  Play: () => <svg data-testid="resume-icon" />,
  Square: () => <svg data-testid="cancel-icon" />,
}))

import InterventionToolbar from './InterventionToolbar'

function makeTask(overrides: Partial<MonitorTask> & { id: string }): MonitorTask {
  return {
    id: overrides.id,
    nodeId: overrides.nodeId ?? overrides.id,
    rootId: overrides.rootId ?? 'root-1',
    title: overrides.title ?? `Task ${overrides.id}`,
    status: overrides.status ?? 'pending',
    reviewStatus: overrides.reviewStatus ?? 'none',
    ...overrides,
  }
}

describe('InterventionToolbar', () => {
  beforeEach(() => {
    mockSendRawJSON.mockClear()
    mockSelectedTaskId = null
    mockActiveRootId = null
    mockTasks = {}
  })

  it('renders placeholder copy when no task is selected', () => {
    render(<InterventionToolbar />)
    expect(screen.getByText('Select a task to retry, resume, or cancel it.')).toBeInTheDocument()
  })

  it('sends retry for failed tasks', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    mockTasks = { t1: makeTask({ id: 't1', status: 'failed' }) }
    mockSelectedTaskId = 't1'
    mockActiveRootId = 'root-1'

    render(<InterventionToolbar />)
    await user.click(screen.getByText('Retry'))

    expect(mockSendRawJSON).toHaveBeenCalledWith({
      type: 'monitor:retry_task',
      rootId: 'root-1',
      taskId: 't1',
      nodeId: 't1',
    })
  })

  it('sends resume for blocked tasks', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    mockTasks = { t1: makeTask({ id: 't1', status: 'blocked' }) }
    mockSelectedTaskId = 't1'
    mockActiveRootId = 'root-1'

    render(<InterventionToolbar />)
    await user.click(screen.getByText('Resume'))

    expect(mockSendRawJSON).toHaveBeenCalledWith({
      type: 'monitor:resume_task',
      rootId: 'root-1',
      taskId: 't1',
      nodeId: 't1',
    })
  })

  it('sends cancel for executing tasks', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    mockTasks = { t1: makeTask({ id: 't1', status: 'executing' }) }
    mockSelectedTaskId = 't1'
    mockActiveRootId = 'root-1'

    render(<InterventionToolbar />)
    await user.click(screen.getByText('Cancel'))

    expect(mockSendRawJSON).toHaveBeenCalledWith({
      type: 'monitor:cancel_task',
      rootId: 'root-1',
      taskId: 't1',
      nodeId: 't1',
    })
  })
})
