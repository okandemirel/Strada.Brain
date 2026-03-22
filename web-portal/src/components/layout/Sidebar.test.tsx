import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

// Mock hooks before importing component
const mockUseWS = vi.fn()
const mockUseTheme = vi.fn()
const mockUseSidebar = vi.fn()

vi.mock('../../hooks/useWS', () => ({
  useWS: () => mockUseWS(),
}))

vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => mockUseTheme(),
}))

vi.mock('../../hooks/useSidebar', () => ({
  useSidebar: () => mockUseSidebar(),
}))

import Sidebar from './Sidebar'

function renderSidebar(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Sidebar />
    </MemoryRouter>,
  )
}

describe('Sidebar', () => {
  const toggleTheme = vi.fn()
  const toggleCollapse = vi.fn()

  beforeEach(() => {
    mockUseWS.mockReturnValue({ status: 'connected' })
    mockUseTheme.mockReturnValue({ theme: 'dark', toggleTheme })
    mockUseSidebar.mockReturnValue({ collapsed: false, toggle: toggleCollapse })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders all navigation items', () => {
    renderSidebar()
    expect(screen.getByText('Chat')).toBeInTheDocument()
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Config')).toBeInTheDocument()
    expect(screen.getByText('Tools')).toBeInTheDocument()
    expect(screen.getByText('Channels')).toBeInTheDocument()
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('Logs')).toBeInTheDocument()
    expect(screen.getByText('Identity')).toBeInTheDocument()
    expect(screen.getByText('Personality')).toBeInTheDocument()
    expect(screen.getByText('Memory')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('renders Lucide icons (SVG elements present)', () => {
    const { container } = renderSidebar()
    const svgs = container.querySelectorAll('svg')
    // There should be many SVGs: nav icons + theme toggle + collapse + etc.
    expect(svgs.length).toBeGreaterThanOrEqual(11)
  })

  it('highlights active route', () => {
    renderSidebar('/tools')
    const toolsLink = screen.getByText('Tools').closest('a')
    expect(toolsLink?.className).toContain('text-accent')
  })

  it('toggles collapsed state', async () => {
    const user = userEvent.setup()
    renderSidebar()
    const collapseBtn = screen.getByTitle('Collapse')
    await user.click(collapseBtn)
    expect(toggleCollapse).toHaveBeenCalledTimes(1)
  })

  it('theme toggle switches dark/light', async () => {
    const user = userEvent.setup()
    renderSidebar()
    const themeBtn = screen.getByTitle('Light Mode')
    await user.click(themeBtn)
    expect(toggleTheme).toHaveBeenCalledTimes(1)
  })

  it('collapsed sidebar hides labels', () => {
    mockUseSidebar.mockReturnValue({ collapsed: true, toggle: toggleCollapse })
    renderSidebar()
    // In collapsed mode, labels are hidden -- text content should not be in the DOM
    expect(screen.queryByText('Chat')).not.toBeInTheDocument()
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument()
    expect(screen.queryByText('Config')).not.toBeInTheDocument()
  })

  it('shows connected status when WS is connected', () => {
    renderSidebar()
    expect(screen.getByText('Health OK')).toBeInTheDocument()
  })

  it('shows Strada.Brain branding in header', () => {
    renderSidebar()
    expect(screen.getByText('Strada.Brain')).toBeInTheDocument()
  })

  it('shows disconnected status when WS is disconnected', () => {
    mockUseWS.mockReturnValue({ status: 'disconnected' })
    renderSidebar()
    expect(screen.getByText('disconnected')).toBeInTheDocument()
  })
})
