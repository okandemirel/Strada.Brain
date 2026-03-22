import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const mockUseDaemon = vi.fn()
const mockUseMetrics = vi.fn()

vi.mock('../hooks/use-api', () => ({
  useDaemon: () => mockUseDaemon(),
  useMetrics: () => mockUseMetrics(),
}))

import IdentityPage from './IdentityPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <IdentityPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('IdentityPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseMetrics.mockReturnValue({ data: null, error: null, isLoading: false })
  })

  it('renders loading state', () => {
    mockUseDaemon.mockReturnValue({ data: undefined, error: null, isLoading: true })
    mockUseMetrics.mockReturnValue({ data: undefined, error: null, isLoading: true })
    renderPage()
    expect(screen.getByText('Loading identity...')).toBeInTheDocument()
  })

  it('renders data with identity information', () => {
    mockUseDaemon.mockReturnValue({
      data: {
        running: true,
        identity: {
          agentName: 'Strada',
          version: '4.1.0',
          bootCount: 7,
          firstBoot: '2026-01-01T00:00:00Z',
          lastBoot: '2026-03-22T00:00:00Z',
          continuityHash: 'abc123def',
          mode: 'autonomous',
        },
        triggers: [],
        budget: { usedUsd: 1.5, limitUsd: 10.0, pct: 0.15 },
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('Identity')).toBeInTheDocument()
    expect(screen.getByText('Strada')).toBeInTheDocument()
    expect(screen.getByText('v4.1.0')).toBeInTheDocument()
    expect(screen.getByText('autonomous')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByText('abc123def')).toBeInTheDocument()
  })

  it('renders error state', () => {
    mockUseDaemon.mockReturnValue({ data: undefined, error: new Error('Daemon unreachable'), isLoading: false })
    mockUseMetrics.mockReturnValue({ data: undefined, error: new Error('Metrics unreachable'), isLoading: false })
    renderPage()
    expect(screen.getByText('Error: Daemon unreachable')).toBeInTheDocument()
  })

  it('renders daemon budget info', () => {
    mockUseDaemon.mockReturnValue({
      data: {
        running: true,
        identity: {
          agentName: 'Strada',
          version: '4.1.0',
          bootCount: 1,
          firstBoot: '2026-01-01T00:00:00Z',
          lastBoot: '2026-03-22T00:00:00Z',
          continuityHash: 'hash',
          mode: 'passive',
        },
        triggers: [],
        budget: { usedUsd: 5.75, limitUsd: 20.0, pct: 0.2875 },
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('$5.75 / $20.00')).toBeInTheDocument()
  })

  it('renders no identity state when daemon has no identity', () => {
    mockUseDaemon.mockReturnValue({
      data: {
        running: false,
        identity: null,
        triggers: [],
        budget: { usedUsd: 0, limitUsd: 0, pct: 0 },
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('No Identity State')).toBeInTheDocument()
  })
})
