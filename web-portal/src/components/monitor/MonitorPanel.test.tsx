import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// Mock monitor store
let mockTasks: Record<string, unknown> = {}
let mockSelectedTaskId: string | null = null
let mockActivities: unknown[] = []

vi.mock('../../stores/monitor-store', () => ({
  useMonitorStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      tasks: mockTasks,
      selectedTaskId: mockSelectedTaskId,
      activities: mockActivities,
      dag: null,
      setSelectedTask: vi.fn(),
      updateTask: vi.fn(),
    }
    return selector ? selector(state) : state
  },
}))

// Mock useWS for InterventionToolbar
vi.mock('../../hooks/useWS', () => ({
  useWS: () => ({
    sendRawJSON: vi.fn().mockReturnValue(true),
  }),
}))

// Mock lazy-loaded components (they use canvas/dnd internally)
vi.mock('./DAGView', () => ({
  default: () => <div data-testid="dag-view">DAG View</div>,
}))

vi.mock('./KanbanBoard', () => ({
  default: () => <div data-testid="kanban-view">Kanban View</div>,
}))

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Pause: () => <svg data-testid="pause-icon" />,
  Play: () => <svg data-testid="play-icon" />,
}))

import MonitorPanel from './MonitorPanel'

describe('MonitorPanel', () => {
  beforeEach(() => {
    mockTasks = {}
    mockSelectedTaskId = null
    mockActivities = []
  })

  it('renders DAG/Kanban toggle buttons', () => {
    render(<MonitorPanel />)
    expect(screen.getByText('DAG')).toBeInTheDocument()
    expect(screen.getByText('Kanban')).toBeInTheDocument()
  })

  it('renders Task Detail section header', () => {
    render(<MonitorPanel />)
    expect(screen.getByText('Task Detail')).toBeInTheDocument()
  })

  it('renders Activity section header', () => {
    render(<MonitorPanel />)
    expect(screen.getByText('Activity')).toBeInTheDocument()
  })

  it('renders InterventionToolbar (Pause button)', () => {
    render(<MonitorPanel />)
    expect(screen.getByText('Pause')).toBeInTheDocument()
  })

  it('DAG view is shown by default', () => {
    render(<MonitorPanel />)
    expect(screen.getByTestId('dag-view')).toBeInTheDocument()
  })

  it('clicking Kanban shows Kanban view', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const { waitFor } = await import('@testing-library/react')
    const user = userEvent.setup()

    render(<MonitorPanel />)
    await user.click(screen.getByText('Kanban'))
    await waitFor(() => {
      expect(screen.getByTestId('kanban-view')).toBeInTheDocument()
    })
  })

  it('clicking DAG again returns to DAG view', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const { waitFor } = await import('@testing-library/react')
    const user = userEvent.setup()

    render(<MonitorPanel />)
    await user.click(screen.getByText('Kanban'))
    await waitFor(() => {
      expect(screen.getByTestId('kanban-view')).toBeInTheDocument()
    })
    await user.click(screen.getByText('DAG'))
    await waitFor(() => {
      expect(screen.getByTestId('dag-view')).toBeInTheDocument()
    })
  })

  it('shows task detail placeholder when no task selected', () => {
    render(<MonitorPanel />)
    expect(screen.getByText('Select a task to see details.')).toBeInTheDocument()
  })

  it('renders resize handles as separators', () => {
    render(<MonitorPanel />)
    const separators = screen.getAllByRole('separator')
    // 3 resize handles: sidebar horizontal, supervisor/detail vertical, detail/activity vertical
    expect(separators.length).toBe(3)
  })
})
