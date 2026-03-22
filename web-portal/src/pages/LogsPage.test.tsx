import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const mockUseLogs = vi.fn()

vi.mock('../hooks/use-api', () => ({
  useLogs: () => mockUseLogs(),
}))

import LogsPage from './LogsPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LogsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('LogsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders loading state', () => {
    mockUseLogs.mockReturnValue({ data: undefined, error: null, isLoading: true, isError: false })
    renderPage()
    expect(screen.getByText('Loading logs...')).toBeInTheDocument()
  })

  it('renders data with log entries', () => {
    mockUseLogs.mockReturnValue({
      data: {
        logs: [
          { timestamp: '2026-03-22T10:00:00Z', level: 'info', message: 'Server started' },
          { timestamp: '2026-03-22T10:01:00Z', level: 'warn', message: 'High memory usage', module: 'memory' },
          { timestamp: '2026-03-22T10:02:00Z', level: 'error', message: 'Connection lost' },
        ],
      },
      error: null,
      isLoading: false,
      isError: false,
    })
    renderPage()
    expect(screen.getByText('Logs')).toBeInTheDocument()
    expect(screen.getByText('Server started')).toBeInTheDocument()
    expect(screen.getByText(/High memory usage/)).toBeInTheDocument()
    expect(screen.getByText('Connection lost')).toBeInTheDocument()
  })

  it('renders error state when no logs available', () => {
    mockUseLogs.mockReturnValue({ data: undefined, error: new Error('Logs not available'), isLoading: false, isError: true })
    renderPage()
    expect(screen.getByText('Logs Unavailable')).toBeInTheDocument()
  })

  it('shows module name in log entry when present', () => {
    mockUseLogs.mockReturnValue({
      data: {
        logs: [
          { timestamp: '2026-03-22T10:00:00Z', level: 'info', message: 'Initialized', module: 'bootstrap' },
        ],
      },
      error: null,
      isLoading: false,
      isError: false,
    })
    renderPage()
    expect(screen.getByText(/\[bootstrap\] Initialized/)).toBeInTheDocument()
  })

  it('handles array-format logs response', () => {
    mockUseLogs.mockReturnValue({
      data: [
        { timestamp: '2026-03-22T10:00:00Z', level: 'info', message: 'Array format log' },
      ],
      error: null,
      isLoading: false,
      isError: false,
    })
    renderPage()
    expect(screen.getByText('Array format log')).toBeInTheDocument()
  })

  it('filters logs by level', async () => {
    const user = userEvent.setup()
    mockUseLogs.mockReturnValue({
      data: {
        logs: [
          { timestamp: '2026-03-22T10:00:00Z', level: 'info', message: 'Server started' },
          { timestamp: '2026-03-22T10:01:00Z', level: 'error', message: 'Connection lost' },
          { timestamp: '2026-03-22T10:02:00Z', level: 'debug', message: 'Debug trace' },
        ],
      },
      error: null,
      isLoading: false,
      isError: false,
    })
    renderPage()

    // Click the "error" level filter
    const errorBtn = screen.getByRole('button', { name: /^error/ })
    await user.click(errorBtn)

    expect(screen.getByText('Connection lost')).toBeInTheDocument()
    expect(screen.queryByText('Server started')).not.toBeInTheDocument()
    expect(screen.queryByText('Debug trace')).not.toBeInTheDocument()
  })
})
