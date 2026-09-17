import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

  // Audit 11.6 / 0-A.30: the two tests below used to assert a LOCAL store
  // mutation with no server call — that was the defect (the daemon never
  // heard the decision). Inverted: the decision must reach
  // POST /api/monitor/task/:id/approve|skip, and the store mirrors it only
  // once the server confirmed.
  function jsonResponse(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  it('Approve POSTs to the approve endpoint and mirrors review_passed only after a 200', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const fetchMock = vi.fn(async () => jsonResponse(200, { status: 'approved', taskId: 't1' }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      mockTasks = { t1: makeTask({ id: 't1', title: 'Stuck', reviewStatus: 'review_stuck', rootId: 'root-1' }) }
      render(<GateDialog />)
      await user.click(screen.getByText('Approve Anyway'))
      await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledWith('t1', { reviewStatus: 'review_passed' }))
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('/api/monitor/task/t1/approve')
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body))).toEqual({ rootId: 'root-1' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('Skip POSTs to the skip endpoint and mirrors skipped only after a 200', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const fetchMock = vi.fn(async () => jsonResponse(200, { status: 'skipped', taskId: 't1' }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      mockTasks = { t1: makeTask({ id: 't1', title: 'Stuck', reviewStatus: 'review_stuck' }) }
      render(<GateDialog />)
      await user.click(screen.getByText('Skip Task'))
      await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledWith('t1', { status: 'skipped', reviewStatus: 'none' }))
      expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/monitor/task/t1/skip')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the dialog open and shows the refusal when the server has no gate consumer (503)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, { error: 'No gate consumer attached — approve not applied', taskId: 't1' })))
    try {
      mockTasks = { t1: makeTask({ id: 't1', title: 'Stuck', reviewStatus: 'review_stuck' }) }
      render(<GateDialog />)
      await user.click(screen.getByText('Approve Anyway'))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('No gate consumer attached — approve not applied')
      // Nothing was mirrored into the store and the gate is still up.
      expect(mockUpdateTask).not.toHaveBeenCalled()
      expect(screen.getByText('Review Gate')).toBeInTheDocument()
      expect(screen.getByText('Approve Anyway')).not.toBeDisabled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
