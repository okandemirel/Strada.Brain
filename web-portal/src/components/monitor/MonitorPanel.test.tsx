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
  Play: () => <svg data-testid="play-icon" />,
  RotateCcw: () => <svg data-testid="retry-icon" />,
  Square: () => <svg data-testid="cancel-icon" />,
}))

import MonitorPanel from './MonitorPanel'

describe('MonitorPanel', () => {
  beforeEach(() => {
    mockTasks = {}
    mockSelectedTaskId = null
    mockActivities = []
    if (typeof localStorage.removeItem === 'function') {
      localStorage.removeItem('strada-monitor-overview-collapsed')
      localStorage.removeItem('strada-monitor-overview-height')
      localStorage.removeItem('strada-monitor-sidebar-width')
      localStorage.removeItem('strada-monitor-supervisor-height')
      localStorage.removeItem('strada-monitor-detail-height')
    }
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

  it('renders InterventionToolbar placeholder', () => {
    render(<MonitorPanel />)
    expect(screen.getByText('Select a task to retry, resume, or cancel it.')).toBeInTheDocument()
  })

  it('renders summary toggle button', () => {
    render(<MonitorPanel />)
    expect(screen.getByText('Hide Summary')).toBeInTheDocument()
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

  it('can collapse the summary panel', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    render(<MonitorPanel />)
    await user.click(screen.getByText('Hide Summary'))

    expect(screen.getByText('Show Summary')).toBeInTheDocument()
    expect(screen.queryByTestId('monitor-overview')).not.toBeInTheDocument()
  })

  it('renders resize handles as separators', () => {
    render(<MonitorPanel />)
    const separators = screen.getAllByRole('separator')
    // 4 resize handles: overview/main, sidebar, supervisor/detail, detail/activity
    expect(separators.length).toBe(4)
  })
})
