import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const mockUseChannels = vi.fn()
const mockUseHealth = vi.fn()

vi.mock('../hooks/use-api', () => ({
  useChannels: () => mockUseChannels(),
  useHealth: () => mockUseHealth(),
}))

import ChannelsPage from './ChannelsPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ChannelsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ChannelsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseHealth.mockReturnValue({ data: null, error: null, isLoading: false })
  })

  it('renders loading state', () => {
    mockUseChannels.mockReturnValue({ data: undefined, error: null, isLoading: true })
    mockUseHealth.mockReturnValue({ data: undefined, error: null, isLoading: true })
    renderPage()
    expect(screen.getByText('Loading channels...')).toBeInTheDocument()
  })

  it('renders data with channels', () => {
    mockUseChannels.mockReturnValue({
      data: {
        channels: [
          { name: 'web', type: 'web', enabled: true, healthy: true, detail: '2 clients' },
          { name: 'discord', type: 'discord', enabled: true, healthy: false, detail: 'Rate limited' },
          { name: 'telegram', type: 'telegram', enabled: false, healthy: false },
        ],
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('Channels')).toBeInTheDocument()
    expect(screen.getByText('web')).toBeInTheDocument()
    expect(screen.getByText('discord')).toBeInTheDocument()
    expect(screen.getByText('telegram')).toBeInTheDocument()
    expect(screen.getByText('2 clients')).toBeInTheDocument()
  })

  it('renders error state', () => {
    mockUseChannels.mockReturnValue({ data: undefined, error: new Error('Channel error'), isLoading: false })
    mockUseHealth.mockReturnValue({ data: undefined, error: new Error('Health error'), isLoading: false })
    renderPage()
    expect(screen.getByText('Error: Channel error')).toBeInTheDocument()
  })

  it('renders server health section when health data available', () => {
    mockUseChannels.mockReturnValue({ data: { channels: [] }, error: null, isLoading: false })
    mockUseHealth.mockReturnValue({
      data: { status: 'ok', timestamp: '2026-03-22T00:00:00Z', channel: 'web', uptime: 3600, clients: 5 },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('Server Health')).toBeInTheDocument()
    expect(screen.getByText('ok')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
  })

  it('shows status dots for each channel', () => {
    mockUseChannels.mockReturnValue({
      data: {
        channels: [
          { name: 'web', type: 'web', enabled: true, healthy: true },
          { name: 'discord', type: 'discord', enabled: true, healthy: false },
          { name: 'irc', type: 'irc', enabled: false, healthy: false },
        ],
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    // Active = healthy + enabled, Degraded = enabled but not healthy, Disabled = not enabled
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('Degraded')).toBeInTheDocument()
    expect(screen.getByText('Disabled')).toBeInTheDocument()
  })
})
