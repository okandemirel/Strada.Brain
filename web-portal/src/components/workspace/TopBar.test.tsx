import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mock workspace store
let mockMode = 'chat'
vi.mock('../../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (s: { mode: string }) => unknown) => {
    const state = { mode: mockMode }
    return selector ? selector(state) : state
  },
}))

import TopBar from './TopBar'

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <TopBar />
    </MemoryRouter>,
  )

describe('TopBar', () => {
  beforeEach(() => {
    mockMode = 'chat'
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders the current workspace mode label on non-admin routes', () => {
    renderAt('/')
    expect(screen.getByText('Chat')).toBeInTheDocument()
  })

  it('renders mode icon (SVG element present)', () => {
    const { container } = renderAt('/')
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('updates label when mode changes', () => {
    mockMode = 'monitor'
    renderAt('/')
    expect(screen.getByText('Monitor')).toBeInTheDocument()
  })

  it('renders canvas mode label', () => {
    mockMode = 'canvas'
    renderAt('/')
    expect(screen.getByText('Canvas')).toBeInTheDocument()
  })

  it('renders code mode label', () => {
    mockMode = 'code'
    renderAt('/')
    expect(screen.getByText('Code')).toBeInTheDocument()
  })

  // Admin routes render through the Outlet (not a workspace mode), so the title
  // must reflect the route, not the leftover mode (which stays 'chat').
  it('shows "Office" on /admin/office even though the mode is still chat', () => {
    mockMode = 'chat'
    renderAt('/admin/office')
    expect(screen.getByText('Office')).toBeInTheDocument()
    expect(screen.queryByText('Chat')).toBeNull()
  })

  it('shows the admin page title on other admin routes (e.g. Dashboard)', () => {
    mockMode = 'chat'
    renderAt('/admin/dashboard')
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
  })
})
