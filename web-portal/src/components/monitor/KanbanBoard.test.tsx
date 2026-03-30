import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MonitorTask } from '../../stores/monitor-store'

// Mock store state
let mockTasks: Record<string, MonitorTask> = {}
const mockSetSelectedTask = vi.fn()
const mockUpdateTask = vi.fn()

vi.mock('../../stores/monitor-store', () => ({
  useMonitorStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      tasks: mockTasks,
      setSelectedTask: mockSetSelectedTask,
      updateTask: mockUpdateTask,
      activeRootId: 'root-1',
    }
    return selector ? selector(state) : state
  },
}))

const mockSendRawJSON = vi.fn()
vi.mock('../../hooks/useWS', () => ({
  useWS: () => ({ sendRawJSON: mockSendRawJSON }),
}))

// Mock @dnd-kit (no pointer events in jsdom)
let capturedOnDragEnd: ((event: unknown) => void) | undefined

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: { children?: React.ReactNode; onDragEnd?: (e: unknown) => void }) => {
    capturedOnDragEnd = onDragEnd
    return <div data-testid="dnd-context">{children}</div>
  },
  closestCenter: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(),
  useDroppable: ({ id }: { id: string }) => ({
    setNodeRef: vi.fn(),
    isOver: false,
    active: null,
    over: null,
    node: { current: null },
    rect: { current: null },
    overRect: null,
    droppableId: id,
  }),
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
    isDragging: false,
  }),
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: (t: unknown) => (t ? 'transform' : undefined),
    },
  },
}))

vi.mock('../ui/number-ticker', () => ({
  NumberTicker: ({ value }: { value: number }) => <span>{value}</span>,
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
    mockUpdateTask.mockClear()
    mockSendRawJSON.mockClear()
    capturedOnDragEnd = undefined
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
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
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

  it('cross-column drag updates task and sends WS message', () => {
    mockTasks = {
      t1: makeTask({ id: 't1', title: 'Drag Me', status: 'failed', nodeId: 'node-1', rootId: 'root-1' }),
    }
    render(<KanbanBoard />)
    expect(capturedOnDragEnd).toBeDefined()

    // Simulate dragging from Issues column to Backlog column
    capturedOnDragEnd!({ active: { id: 't1' }, over: { id: 'backlog' } })

    expect(mockUpdateTask).toHaveBeenCalledWith('t1', { status: 'pending', reviewStatus: 'none' })
    expect(mockSendRawJSON).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'monitor:move_task',
        taskId: 't1',
        nodeId: 'node-1',
        toColumn: 'backlog',
        newStatus: 'pending',
      }),
    )
  })

  it('drag within same column does not trigger move', () => {
    mockTasks = {
      t1: makeTask({ id: 't1', status: 'pending' }),
      t2: makeTask({ id: 't2', status: 'pending' }),
    }
    render(<KanbanBoard />)
    expect(capturedOnDragEnd).toBeDefined()

    // Drag t1 onto t2 — both in backlog, same column
    capturedOnDragEnd!({ active: { id: 't1' }, over: { id: 't2' } })

    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockSendRawJSON).not.toHaveBeenCalled()
  })

  it('preserves skipped status when dragging to issues column', () => {
    // Task with skipped status + quality_review puts it in "review" column via filter priority
    mockTasks = {
      t1: makeTask({ id: 't1', status: 'skipped', reviewStatus: 'quality_review', nodeId: 'n1', rootId: 'r1' }),
    }
    render(<KanbanBoard />)

    // Drag from review column to issues — should preserve 'skipped', not coerce to 'failed'
    capturedOnDragEnd!({ active: { id: 't1' }, over: { id: 'issues' } })

    expect(mockUpdateTask).toHaveBeenCalledWith('t1', { status: 'skipped', reviewStatus: 'none' })
  })

  it('preserves quality_review status when dragging to review column', () => {
    // Task in backlog with quality_review set from a prior review
    mockTasks = {
      t1: makeTask({ id: 't1', status: 'pending', reviewStatus: 'quality_review', nodeId: 'n1', rootId: 'r1' }),
    }
    render(<KanbanBoard />)

    // Drag from backlog to review — should keep quality_review, not overwrite to spec_review
    capturedOnDragEnd!({ active: { id: 't1' }, over: { id: 'review' } })

    expect(mockUpdateTask).toHaveBeenCalledWith('t1', { status: 'executing', reviewStatus: 'quality_review' })
  })

  it('rolls back optimistic update when WS send fails', () => {
    mockSendRawJSON.mockReturnValue(false)
    mockTasks = {
      t1: makeTask({ id: 't1', status: 'failed', nodeId: 'n1', rootId: 'r1' }),
    }
    render(<KanbanBoard />)

    capturedOnDragEnd!({ active: { id: 't1' }, over: { id: 'backlog' } })

    // First call: optimistic update
    expect(mockUpdateTask).toHaveBeenNthCalledWith(1, 't1', { status: 'pending', reviewStatus: 'none' })
    // Second call: rollback
    expect(mockUpdateTask).toHaveBeenNthCalledWith(2, 't1', { status: 'failed', reviewStatus: 'none' })
  })
})
