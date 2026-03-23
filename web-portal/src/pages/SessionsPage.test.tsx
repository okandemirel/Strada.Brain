import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const mockUseSessions = vi.fn()
const mockUseMetrics = vi.fn()
const mockUseAgents = vi.fn()

vi.mock('../hooks/use-api', () => ({
  useSessions: () => mockUseSessions(),
  useMetrics: () => mockUseMetrics(),
  useAgents: () => mockUseAgents(),
}))

import SessionsPage from './SessionsPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SessionsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SessionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseMetrics.mockReturnValue({ data: null, error: null, isLoading: false })
    mockUseAgents.mockReturnValue({ data: null, error: null, isLoading: false })
  })

  it('renders loading state', () => {
    mockUseSessions.mockReturnValue({ data: undefined, error: null, isLoading: true })
    mockUseMetrics.mockReturnValue({ data: undefined, error: null, isLoading: true })
    mockUseAgents.mockReturnValue({ data: undefined, error: null, isLoading: true })
    const { container } = renderPage()
    // Loading state renders Skeleton components (no text)
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
  })

  it('renders data with sessions list', () => {
    mockUseSessions.mockReturnValue({
      data: {
        sessions: [
          { id: 'sess-abc123', channel: 'web', startedAt: Date.now() - 60000, lastActivity: Date.now(), messageCount: 5 },
          { id: 'sess-def456', channel: 'discord', startedAt: Date.now() - 120000, lastActivity: Date.now() },
        ],
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('sess-abc123')).toBeInTheDocument()
    expect(screen.getByText('sess-def456')).toBeInTheDocument()
    expect(screen.getByText('web')).toBeInTheDocument()
    expect(screen.getByText('discord')).toBeInTheDocument()
    expect(screen.getByText('5 msgs')).toBeInTheDocument()
  })

  it('renders error state', () => {
    mockUseSessions.mockReturnValue({ data: undefined, error: new Error('Session fetch failed'), isLoading: false })
    mockUseMetrics.mockReturnValue({ data: undefined, error: new Error('Metrics failed'), isLoading: false })
    mockUseAgents.mockReturnValue({ data: undefined, error: new Error('Agents failed'), isLoading: false })
    renderPage()
    expect(screen.getByText('Failed to Load Sessions')).toBeInTheDocument()
    expect(screen.getByText('Session fetch failed')).toBeInTheDocument()
  })

  it('renders metrics overview when available', () => {
    mockUseSessions.mockReturnValue({ data: { sessions: [] }, error: null, isLoading: false })
    mockUseMetrics.mockReturnValue({
      data: { activeSessions: 3, totalMessages: 150 },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('150')).toBeInTheDocument()
  })

  it('renders empty state when no sessions', () => {
    mockUseSessions.mockReturnValue({ data: { sessions: [] }, error: null, isLoading: false })
    renderPage()
    expect(screen.getByText('No Active Sessions')).toBeInTheDocument()
  })
})
