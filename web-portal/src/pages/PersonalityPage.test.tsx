import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const mockUsePersonality = vi.fn()

vi.mock('../hooks/use-api', () => ({
  usePersonality: () => mockUsePersonality(),
}))

vi.mock('../hooks/useWS', () => ({
  useWS: () => ({ profileId: 'test-session', sendRawJSON: vi.fn() }),
}))

// Mock fetch for mutations
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import PersonalityPage from './PersonalityPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PersonalityPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('PersonalityPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset confirm dialog mock
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
  })

  it('renders loading state', () => {
    mockUsePersonality.mockReturnValue({ data: undefined, error: null, isLoading: true })
    const { container } = renderPage()
    // Loading state renders Skeleton components (no text)
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
  })

  it('renders data with personality profiles', () => {
    mockUsePersonality.mockReturnValue({
      data: {
        personality: {
          activeProfile: 'default',
          profiles: ['default', 'casual', 'formal', 'minimal'],
          content: '# Strada personality',
          channelOverrides: {},
        },
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('Personality')).toBeInTheDocument()
    // "default" appears twice (active profile display + profile card), use getAllByText
    expect(screen.getAllByText('default').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('casual')).toBeInTheDocument()
    expect(screen.getByText('formal')).toBeInTheDocument()
    expect(screen.getByText('minimal')).toBeInTheDocument()
  })

  it('renders error state', () => {
    mockUsePersonality.mockReturnValue({
      data: undefined,
      error: new Error('Personality API unavailable'),
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('Personality Unavailable')).toBeInTheDocument()
  })

  it('switches profile', async () => {
    const user = userEvent.setup()
    mockUsePersonality.mockReturnValue({
      data: {
        personality: {
          activeProfile: 'default',
          profiles: ['default', 'casual'],
          channelOverrides: {},
        },
      },
      error: null,
      isLoading: false,
    })
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    renderPage()

    // The "casual" profile should have a "Select" button (not "Selected" since it's not active)
    const selectBtns = screen.getAllByRole('button', { name: 'Select' })
    expect(selectBtns.length).toBeGreaterThanOrEqual(1)
    await user.click(selectBtns[0])
    expect(mockFetch).toHaveBeenCalledWith('/api/personality/switch', expect.objectContaining({ method: 'POST' }))
  })

  it('shows create profile form', () => {
    mockUsePersonality.mockReturnValue({
      data: {
        personality: {
          activeProfile: 'default',
          profiles: ['default'],
          channelOverrides: {},
        },
      },
      error: null,
      isLoading: false,
    })
    renderPage()
    // "Create Profile" appears as both a section header and button label
    expect(screen.getByRole('button', { name: 'Create Profile' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('e.g. jarvis')).toBeInTheDocument()
  })

  it('allows deleting custom profiles', async () => {
    const user = userEvent.setup()
    mockUsePersonality.mockReturnValue({
      data: {
        personality: {
          activeProfile: 'default',
          profiles: ['default', 'my-custom'],
          channelOverrides: {},
        },
      },
      error: null,
      isLoading: false,
    })
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    renderPage()

    // Custom profiles should have a "Delete" button
    const deleteBtn = screen.getByRole('button', { name: 'Delete' })
    expect(deleteBtn).toBeInTheDocument()
    await user.click(deleteBtn)
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/personality/profiles/my-custom',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
