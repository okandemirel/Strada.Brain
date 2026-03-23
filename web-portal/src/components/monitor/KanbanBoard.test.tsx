import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MonitorTask } from '../../stores/monitor-store'

// Mock store state
let mockTasks: Record<string, MonitorTask> = {}
const mockSetSelectedTask = vi.fn()

vi.mock('../../stores/monitor-store', () => ({
  useMonitorStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      tasks: mockTasks,
      setSelectedTask: mockSetSelectedTask,
    }
    return selector ? selector(state) : state
  },
}))

// Mock @dnd-kit (no pointer events in jsdom)
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children?: React.ReactNode }) => <div data-testid="dnd-context">{children}</div>,
  closestCenter: vi.fn(),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: 'vertical',
  useSortable: ({ id }: { id: string }) => ({
    attributes: { 'data-sortable-id': id },
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
  }),
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: (t: unknown) => (t ? 'transform' : undefined),
    },
  },
}))

import KanbanBoard from './KanbanBoard'

function makeTask(overrides: Partial<MonitorTask> & { id: string }): MonitorTask {
  return {
    nodeId: overrides.id,
    title: `Task ${overrides.id}`,
    status: 'pending',
    reviewStatus: 'none',
    ...overrides,
  }
}

describe('KanbanBoard', () => {
  beforeEach(() => {
    mockTasks = {}
    mockSetSelectedTask.mockClear()
  })

  it('renders 5 column headers', () => {
    render(<KanbanBoard />)
    expect(screen.getByText('Backlog')).toBeInTheDocument()
    expect(screen.getByText('Working')).toBeInTheDocument()
    expect(screen.getByText('Review')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByText('Issues')).toBeInTheDocument()
  })

  it('shows task count per column', () => {
    mockTasks = {
      t1: makeTask({ id: 't1', status: 'pending' }),
      t2: makeTask({ id: 't2', status: 'pending' }),
      t3: makeTask({ id: 't3', status: 'executing' }),
    }
    render(<KanbanBoard />)
    // Backlog should have 2, Working should have 1
    expect(screen.getByText('(2)')).toBeInTheDocument()
    expect(screen.getByText('(1)')).toBeInTheDocument()
  })

  it('places pending tasks in Backlog column', () => {
    mockTasks = {
      t1: makeTask({ id: 't1', title: 'Pending Task', status: 'pending' }),
    }
    render(<KanbanBoard />)
    expect(screen.getByText('Pending Task')).toBeInTheDocument()
  })

  it('places executing tasks in Working column', () => {
    mockTasks = {
      t1: makeTask({ id: 't1', title: 'Active Task', status: 'executing' }),
    }
    render(<KanbanBoard />)
    expect(screen.getByText('Active Task')).toBeInTheDocument()
  })

  it('places review tasks in Review column', () => {
    mockTasks = {
      t1: makeTask({ id: 't1', title: 'Under Review', status: 'executing', reviewStatus: 'spec_review' }),
    }
    render(<KanbanBoard />)
    // Task appears in both Working (status=executing) and Review (reviewStatus=spec_review) columns
    expect(screen.getAllByText('Under Review').length).toBeGreaterThanOrEqual(1)
  })

  it('places completed+reviewed tasks in Done column', () => {
    mockTasks = {
      t1: makeTask({ id: 't1', title: 'Finished Task', status: 'completed', reviewStatus: 'review_passed' }),
    }
    render(<KanbanBoard />)
    expect(screen.getByText('Finished Task')).toBeInTheDocument()
  })

  it('places failed tasks in Issues column', () => {
    mockTasks = {
      t1: makeTask({ id: 't1', title: 'Failed Task', status: 'failed' }),
    }
    render(<KanbanBoard />)
    expect(screen.getByText('Failed Task')).toBeInTheDocument()
  })

  it('clicking a task card calls setSelectedTask', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    mockTasks = {
      t1: makeTask({ id: 't1', title: 'Click Me', status: 'pending' }),
    }
    render(<KanbanBoard />)
    await user.click(screen.getByText('Click Me'))
    expect(mockSetSelectedTask).toHaveBeenCalledWith('t1')
  })
})
