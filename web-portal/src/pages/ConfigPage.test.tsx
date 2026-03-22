import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const mockUseConfig = vi.fn()

vi.mock('../hooks/use-api', () => ({
  useConfig: () => mockUseConfig(),
}))

import ConfigPage from './ConfigPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ConfigPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ConfigPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders loading state', () => {
    mockUseConfig.mockReturnValue({ data: undefined, error: null, isLoading: true })
    renderPage()
    expect(screen.getByText('Loading configuration...')).toBeInTheDocument()
  })

  it('renders data with config table', () => {
    mockUseConfig.mockReturnValue({
      data: {
        config: {},
        entries: [
          { key: 'LOG_LEVEL', value: 'info', category: 'System', tier: 'core', description: 'Logging level' },
          { key: 'PORT', value: 3000, category: 'Network', tier: 'advanced', description: 'Server port' },
        ],
        summary: { core: 1, advanced: 1, experimental: 0 },
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('Configuration')).toBeInTheDocument()
    expect(screen.getByText('LOG_LEVEL')).toBeInTheDocument()
    expect(screen.getByText('PORT')).toBeInTheDocument()
    expect(screen.getByText('Logging level')).toBeInTheDocument()
    expect(screen.getByText('Server port')).toBeInTheDocument()
  })

  it('renders error state', () => {
    mockUseConfig.mockReturnValue({ data: undefined, error: new Error('Network failure'), isLoading: false })
    renderPage()
    expect(screen.getByText('Error: Network failure')).toBeInTheDocument()
  })

  it('renders summary badges when summary present', () => {
    mockUseConfig.mockReturnValue({
      data: {
        config: {},
        entries: [],
        summary: { core: 12, advanced: 45, experimental: 3 },
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('45')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('falls back to flat config when entries not provided', () => {
    mockUseConfig.mockReturnValue({
      data: {
        config: { DB_HOST: 'localhost', DB_PORT: 5432 },
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('DB_HOST')).toBeInTheDocument()
    expect(screen.getByText('DB_PORT')).toBeInTheDocument()
  })

  it('filters entries by search input', async () => {
    const user = userEvent.setup()
    mockUseConfig.mockReturnValue({
      data: {
        config: {},
        entries: [
          { key: 'LOG_LEVEL', value: 'info', category: 'System', tier: 'core', description: 'Logging level' },
          { key: 'PORT', value: 3000, category: 'Network', tier: 'advanced', description: 'Server port' },
        ],
      },
      error: null,
      isLoading: false,
    })
    renderPage()

    const filterInput = screen.getByPlaceholderText('Filter settings...')
    await user.type(filterInput, 'LOG')

    expect(screen.getByText('LOG_LEVEL')).toBeInTheDocument()
    expect(screen.queryByText('PORT')).not.toBeInTheDocument()
  })
})
