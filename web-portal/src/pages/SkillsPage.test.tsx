import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

// ---------------------------------------------------------------------------
// Mock the API hook
// ---------------------------------------------------------------------------

const mockUseSkills = vi.fn()
const mockUseSkillRegistry = vi.fn()

vi.mock('../hooks/use-api', () => ({
  useSkills: () => mockUseSkills(),
  useSkillRegistry: () => mockUseSkillRegistry(),
}))

import SkillsPage from './SkillsPage'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SkillsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const SAMPLE_SKILLS = [
  {
    manifest: { name: 'unity-build', version: '1.0.0', description: 'Build Unity projects' },
    status: 'active' as const,
    tier: 'bundled' as const,
    path: '/skills/unity-build',
  },
  {
    manifest: { name: 'web-search', version: '0.9.0', description: 'Search the web' },
    status: 'disabled' as const,
    tier: 'managed' as const,
    path: '/skills/web-search',
  },
  {
    manifest: { name: 'git-ops', version: '1.2.0', description: 'Git operations' },
    status: 'gated' as const,
    tier: 'bundled' as const,
    path: '/skills/git-ops',
    gateReason: 'Missing: git binary',
  },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default marketplace mock — not loading, empty
    mockUseSkillRegistry.mockReturnValue({ data: { skills: [] }, error: null, isLoading: false })
  })

  it('renders loading state', () => {
    mockUseSkills.mockReturnValue({ data: undefined, error: null, isLoading: true })
    renderPage()
    // New layout uses skeleton loaders instead of text
    const skeletons = document.querySelectorAll('.animate-pulse')
    expect(skeletons.length).toBeGreaterThan(0)
  })

  it('renders error state', () => {
    mockUseSkills.mockReturnValue({
      data: undefined,
      error: new Error('Skills API down'),
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('Failed to Load Skills')).toBeInTheDocument()
  })

  it('renders empty state when no skills loaded', () => {
    mockUseSkills.mockReturnValue({ data: { skills: [] }, error: null, isLoading: false })
    renderPage()
    expect(screen.getByText('No Skills Loaded')).toBeInTheDocument()
  })

  it('renders skills table with all columns', () => {
    mockUseSkills.mockReturnValue({
      data: { skills: SAMPLE_SKILLS },
      error: null,
      isLoading: false,
    })
    renderPage()

    expect(screen.getByText('Skills')).toBeInTheDocument()
    expect(screen.getByText('unity-build')).toBeInTheDocument()
    expect(screen.getByText('web-search')).toBeInTheDocument()
    expect(screen.getByText('git-ops')).toBeInTheDocument()
    expect(screen.getByText('Build Unity projects')).toBeInTheDocument()
    expect(screen.getByText('Missing: git binary')).toBeInTheDocument()
  })

  it('displays status badges with correct text', () => {
    mockUseSkills.mockReturnValue({
      data: { skills: SAMPLE_SKILLS },
      error: null,
      isLoading: false,
    })
    renderPage()

    // Each status appears at least once (as badge; also as filter pill — use getAllByText)
    expect(screen.getAllByText('active').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('disabled').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('gated').length).toBeGreaterThanOrEqual(1)
  })

  it('displays tier badges', () => {
    mockUseSkills.mockReturnValue({
      data: { skills: SAMPLE_SKILLS },
      error: null,
      isLoading: false,
    })
    renderPage()

    // bundled appears twice, managed once
    const bundledBadges = screen.getAllByText('bundled')
    expect(bundledBadges.length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('managed')).toBeInTheDocument()
  })

  it('shows Disable button for active skills and Enable for disabled', () => {
    mockUseSkills.mockReturnValue({
      data: { skills: SAMPLE_SKILLS },
      error: null,
      isLoading: false,
    })
    renderPage()

    // active skill → Disable button (aria-label is just the skill name)
    const disableBtn = screen.getByRole('button', { name: 'unity-build' })
    expect(disableBtn).toBeInTheDocument()
    expect(disableBtn.textContent).toBe('Disable')
    // disabled skill → Enable button
    const enableBtn = screen.getByRole('button', { name: 'web-search' })
    expect(enableBtn).toBeInTheDocument()
    expect(enableBtn.textContent).toBe('Enable')
  })

  it('gated and error skills have disabled action buttons', () => {
    mockUseSkills.mockReturnValue({
      data: { skills: SAMPLE_SKILLS },
      error: null,
      isLoading: false,
    })
    renderPage()

    const gatedBtn = screen.getByRole('button', { name: 'git-ops' })
    expect(gatedBtn).toBeDisabled()
  })

  it('filters skills by search text', async () => {
    const user = userEvent.setup()
    mockUseSkills.mockReturnValue({
      data: { skills: SAMPLE_SKILLS },
      error: null,
      isLoading: false,
    })
    renderPage()

    const input = screen.getByPlaceholderText('Search installed skills...')
    await user.type(input, 'unity')

    expect(screen.getByText('unity-build')).toBeInTheDocument()
    expect(screen.queryByText('web-search')).not.toBeInTheDocument()
  })

  it('filters skills by status pill', async () => {
    const user = userEvent.setup()
    mockUseSkills.mockReturnValue({
      data: { skills: SAMPLE_SKILLS },
      error: null,
      isLoading: false,
    })
    renderPage()

    // Click the "active" filter pill (text within a button, not a badge)
    const pills = screen.getAllByRole('button', { name: 'active' })
    // The filter pill is one of the buttons; click the first one that looks like a pill
    // (it won't be an aria-label button — we find it by text)
    const activePill = pills[0]
    await user.click(activePill)

    expect(screen.getByText('unity-build')).toBeInTheDocument()
    expect(screen.queryByText('web-search')).not.toBeInTheDocument()
    expect(screen.queryByText('git-ops')).not.toBeInTheDocument()
  })

  it('calls enable endpoint when Enable button is clicked', async () => {
    const user = userEvent.setup()
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    })
    vi.stubGlobal('fetch', mockFetch)

    mockUseSkills.mockReturnValue({
      data: { skills: SAMPLE_SKILLS },
      error: null,
      isLoading: false,
    })
    renderPage()

    const enableBtn = screen.getByRole('button', { name: 'web-search' })
    await user.click(enableBtn)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/skills/web-search/enable',
        { method: 'POST' },
      )
    })

    vi.unstubAllGlobals()
  })

  it('calls disable endpoint when Disable button is clicked', async () => {
    const user = userEvent.setup()
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    })
    vi.stubGlobal('fetch', mockFetch)

    mockUseSkills.mockReturnValue({
      data: { skills: SAMPLE_SKILLS },
      error: null,
      isLoading: false,
    })
    renderPage()

    const disableBtn = screen.getByRole('button', { name: 'unity-build' })
    await user.click(disableBtn)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/skills/unity-build/disable',
        { method: 'POST' },
      )
    })

    vi.unstubAllGlobals()
  })

  it('shows "no match" message when filter yields no results', async () => {
    const user = userEvent.setup()
    mockUseSkills.mockReturnValue({
      data: { skills: SAMPLE_SKILLS },
      error: null,
      isLoading: false,
    })
    renderPage()

    const input = screen.getByPlaceholderText('Search installed skills...')
    await user.type(input, 'xyznonexistent')

    expect(screen.getByText('No skills match your filter.')).toBeInTheDocument()
  })
})
