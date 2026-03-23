import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MonitorTask } from '../../stores/monitor-store'

let mockTasks: Record<string, MonitorTask> = {}
const mockUpdateTask = vi.fn()

vi.mock('../../stores/monitor-store', () => ({
  useMonitorStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = {
        tasks: mockTasks,
        updateTask: mockUpdateTask,
      }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({
        tasks: mockTasks,
        updateTask: mockUpdateTask,
      }),
    },
  ),
}))

// Mock radix dialog to render without portal (jsdom limitation)
vi.mock('@radix-ui/react-dialog', () => ({
  Root: ({ children, open }: { children?: React.ReactNode; open?: boolean }) => (open ? <div data-testid="dialog-root">{children}</div> : null),
  Trigger: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
  Portal: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Overlay: () => <div data-testid="dialog-overlay" />,
  Content: ({ children }: { children?: React.ReactNode }) => <div data-testid="dialog-content">{children}</div>,
  Title: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  Close: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
}))

import GateDialog from './GateDialog'

function makeTask(overrides: Partial<MonitorTask> & { id: string }): MonitorTask {
  return {
    nodeId: overrides.id,
    title: `Task ${overrides.id}`,
    status: 'executing',
    reviewStatus: 'none',
    ...overrides,
  }
}

describe('GateDialog', () => {
  beforeEach(() => {
    mockTasks = {}
    mockUpdateTask.mockClear()
  })

  it('renders nothing when no stuck tasks', () => {
    mockTasks = {
      t1: makeTask({ id: 't1', status: 'pending', reviewStatus: 'none' }),
    }
    const { container } = render(<GateDialog />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when tasks object is empty', () => {
    const { container } = render(<GateDialog />)
    expect(container.innerHTML).toBe('')
  })

  it('shows dialog when review_stuck task exists', () => {
    mockTasks = {
      t1: makeTask({ id: 't1', title: 'Stuck Task', reviewStatus: 'review_stuck' }),
    }
    render(<GateDialog />)
    expect(screen.getByText('Review Gate')).toBeInTheDocument()
    expect(screen.getByText(/Stuck Task/)).toBeInTheDocument()
  })

  it('Approve button calls updateTask with review_passed', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    mockTasks = {
      t1: makeTask({ id: 't1', title: 'Stuck', reviewStatus: 'review_stuck' }),
    }
    render(<GateDialog />)
    await user.click(screen.getByText('Approve Anyway'))

    expect(mockUpdateTask).toHaveBeenCalledWith('t1', { reviewStatus: 'review_passed' })
  })

  it('Skip button calls updateTask with skipped status', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    mockTasks = {
      t1: makeTask({ id: 't1', title: 'Stuck', reviewStatus: 'review_stuck' }),
    }
    render(<GateDialog />)
    await user.click(screen.getByText('Skip Task'))

    expect(mockUpdateTask).toHaveBeenCalledWith('t1', { status: 'skipped', reviewStatus: 'none' })
  })
})
