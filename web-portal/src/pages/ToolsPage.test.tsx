import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const mockUseTools = vi.fn()
const mockUseMetrics = vi.fn()

vi.mock('../hooks/use-api', () => ({
  useTools: () => mockUseTools(),
  useMetrics: () => mockUseMetrics(),
}))

import ToolsPage from './ToolsPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToolsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ToolsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseMetrics.mockReturnValue({ data: null, error: null, isLoading: false })
  })

  it('renders loading state', () => {
    mockUseTools.mockReturnValue({ data: undefined, error: null, isLoading: true })
    mockUseMetrics.mockReturnValue({ data: undefined, error: null, isLoading: true })
    renderPage()
    expect(screen.getByText('Loading tools...')).toBeInTheDocument()
  })

  it('renders data with tool cards', () => {
    mockUseTools.mockReturnValue({
      data: {
        tools: [
          { name: 'read_file', description: 'Read a file', type: 'builtin' },
          { name: 'web_search', description: 'Search the web', type: 'chain' },
        ],
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText(/Tools \(2\)/)).toBeInTheDocument()
    expect(screen.getByText('read_file')).toBeInTheDocument()
    expect(screen.getByText('web_search')).toBeInTheDocument()
    expect(screen.getByText('Read a file')).toBeInTheDocument()
  })

  it('renders error state', () => {
    mockUseTools.mockReturnValue({ data: undefined, error: new Error('Tools API down'), isLoading: false })
    mockUseMetrics.mockReturnValue({ data: undefined, error: new Error('Metrics API down'), isLoading: false })
    renderPage()
    expect(screen.getByText('Error: Tools API down')).toBeInTheDocument()
  })

  it('shows empty state when no tools available', () => {
    mockUseTools.mockReturnValue({ data: { tools: [] }, error: null, isLoading: false })
    renderPage()
    expect(screen.getByText('No Tools Available')).toBeInTheDocument()
  })

  it('shows call counts on tool cards', () => {
    mockUseTools.mockReturnValue({
      data: { tools: [{ name: 'read_file', description: 'Read', type: 'builtin' }] },
      error: null,
      isLoading: false,
    })
    mockUseMetrics.mockReturnValue({
      data: { toolCallCounts: { read_file: 42 }, toolErrorCounts: {} },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('42 calls')).toBeInTheDocument()
  })

  it('filters tools by type', async () => {
    const user = userEvent.setup()
    mockUseTools.mockReturnValue({
      data: {
        tools: [
          { name: 'read_file', description: 'Read a file', type: 'builtin' },
          { name: 'web_search', description: 'Search the web', type: 'chain' },
        ],
      },
      error: null,
      isLoading: false,
    })
    renderPage()

    // Click the "chain" type filter button
    const chainBtn = screen.getByRole('button', { name: 'chain' })
    await user.click(chainBtn)

    expect(screen.getByText('web_search')).toBeInTheDocument()
    expect(screen.queryByText('read_file')).not.toBeInTheDocument()
  })
})
