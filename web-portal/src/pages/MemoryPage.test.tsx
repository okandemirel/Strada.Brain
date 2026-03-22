import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const mockUseMemoryStats = vi.fn()
const mockUseConsolidation = vi.fn()
const mockUseMaintenance = vi.fn()

vi.mock('../hooks/use-api', () => ({
  useMemoryStats: () => mockUseMemoryStats(),
  useConsolidation: () => mockUseConsolidation(),
  useMaintenance: () => mockUseMaintenance(),
}))

import MemoryPage from './MemoryPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemoryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('MemoryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseConsolidation.mockReturnValue({ data: null, error: null, isLoading: false })
    mockUseMaintenance.mockReturnValue({ data: null, error: null, isLoading: false })
  })

  it('renders loading state', () => {
    mockUseMemoryStats.mockReturnValue({ data: undefined, error: null, isLoading: true })
    mockUseConsolidation.mockReturnValue({ data: undefined, error: null, isLoading: true })
    mockUseMaintenance.mockReturnValue({ data: undefined, error: null, isLoading: true })
    renderPage()
    expect(screen.getByText('Loading memory data...')).toBeInTheDocument()
  })

  it('renders data with tier distribution', () => {
    mockUseMemoryStats.mockReturnValue({
      data: {
        memory: {
          totalEntries: 1500,
          hasAnalysisCache: true,
          entriesByTier: { core: 500, episodic: 300, semantic: 700 },
        },
      },
      error: null,
      isLoading: false,
    })
    mockUseConsolidation.mockReturnValue({
      data: {
        enabled: true,
        perTier: {
          core: { total: 500, pending: 10, clustered: 490 },
          episodic: { total: 300, pending: 5, clustered: 295 },
          semantic: { total: 700, pending: 20, clustered: 680 },
        },
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('Memory')).toBeInTheDocument()
    expect(screen.getByText('1,500')).toBeInTheDocument()
    expect(screen.getByText('core')).toBeInTheDocument()
    expect(screen.getByText('episodic')).toBeInTheDocument()
    expect(screen.getByText('semantic')).toBeInTheDocument()
  })

  it('renders error state', () => {
    mockUseMemoryStats.mockReturnValue({ data: undefined, error: new Error('Memory endpoint down'), isLoading: false })
    mockUseConsolidation.mockReturnValue({ data: undefined, error: new Error('Consolidation error'), isLoading: false })
    mockUseMaintenance.mockReturnValue({ data: undefined, error: new Error('Maintenance error'), isLoading: false })
    renderPage()
    expect(screen.getByText('Error: Memory endpoint down')).toBeInTheDocument()
  })

  it('renders memory health info when available', () => {
    mockUseMemoryStats.mockReturnValue({
      data: {
        memory: {
          totalEntries: 100,
          hasAnalysisCache: false,
          health: { healthy: true, indexHealth: 'optimal', storageUsagePercent: 42, issues: [] },
        },
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('optimal')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  it('renders no memory data state when nothing available', () => {
    mockUseMemoryStats.mockReturnValue({ data: { memory: null }, error: null, isLoading: false })
    mockUseConsolidation.mockReturnValue({ data: { enabled: false }, error: null, isLoading: false })
    mockUseMaintenance.mockReturnValue({ data: null, error: null, isLoading: false })
    renderPage()
    expect(screen.getByText('No Memory Data')).toBeInTheDocument()
  })
})
