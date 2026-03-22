import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

// Mock matchMedia for responsive breakpoint logic in Sidebar
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock hooks before importing component
const mockUseWS = vi.fn()
const mockUseTheme = vi.fn()

vi.mock('../../hooks/useWS', () => ({
  useWS: () => mockUseWS(),
}))

vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => mockUseTheme(),
}))

// Mock sidebar store
const mockToggle = vi.fn()
let mockCollapsed = false
vi.mock('../../stores/sidebar-store', () => ({
  useSidebarStore: Object.assign(
    (selector?: (s: { collapsed: boolean; toggle: () => void }) => unknown) => {
      const state = { collapsed: mockCollapsed, toggle: mockToggle }
      return selector ? selector(state) : state
    },
    { getState: () => ({ collapsed: mockCollapsed, toggle: mockToggle }) },
  ),
}))

// Mock workspace store
const mockSetMode = vi.fn()
let mockMode = 'chat'
vi.mock('../../stores/workspace-store', async () => {
  const actual = await vi.importActual('../../stores/workspace-store')
  return {
    ...actual,
    useWorkspaceStore: Object.assign(
      (selector?: (s: { mode: string; setMode: (m: string) => void }) => unknown) => {
        const state = { mode: mockMode, setMode: mockSetMode }
        return selector ? selector(state) : state
      },
      { getState: () => ({ mode: mockMode, setMode: mockSetMode }) },
    ),
  }
})

// Mock radix tooltip to avoid portal issues in tests
vi.mock('../ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, asChild, ...props }: { children: React.ReactNode; asChild?: boolean; [k: string]: unknown }) => {
    if (asChild) return <>{children}</>
    return <span {...props}>{children}</span>
  },
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span data-testid="tooltip-content">{children}</span>,
}))

// Mock AdminDropdown to isolate Sidebar tests
vi.mock('./AdminDropdown', () => ({
  default: ({ collapsed }: { collapsed: boolean }) => (
    <div data-testid="admin-dropdown" data-collapsed={collapsed}>Admin</div>
  ),
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

  beforeEach(() => {
    mockUseWS.mockReturnValue({ status: 'connected' })
    mockUseTheme.mockReturnValue({ theme: 'dark', toggleTheme })
    mockCollapsed = false
    mockMode = 'chat'
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders mode buttons', () => {
    renderSidebar()
    expect(screen.getByText('Chat')).toBeInTheDocument()
    expect(screen.getByText('Monitor')).toBeInTheDocument()
    expect(screen.getByText('Canvas')).toBeInTheDocument()
    expect(screen.getByText('Code')).toBeInTheDocument()
  })

  it('renders Lucide icons (SVG elements present)', () => {
    const { container } = renderSidebar()
    const svgs = container.querySelectorAll('svg')
    // Mode icons (4) + Bell + theme toggle + collapse + health dot = 7+ SVGs
    expect(svgs.length).toBeGreaterThanOrEqual(6)
  })

  it('highlights active mode button', () => {
    renderSidebar()
    const chatBtn = screen.getByText('Chat').closest('button')
    expect(chatBtn?.className).toContain('text-accent')
  })

  it('clicking Chat mode calls setMode', async () => {
    const user = userEvent.setup()
    renderSidebar()
    const chatBtn = screen.getByText('Chat').closest('button')!
    await user.click(chatBtn)
    expect(mockSetMode).toHaveBeenCalledWith('chat')
  })

  it('disabled mode buttons are disabled', () => {
    renderSidebar()
    const monitorBtn = screen.getByText('Monitor').closest('button')
    expect(monitorBtn).toBeDisabled()
    const canvasBtn = screen.getByText('Canvas').closest('button')
    expect(canvasBtn).toBeDisabled()
    const codeBtn = screen.getByText('Code').closest('button')
    expect(codeBtn).toBeDisabled()
  })

  it('shows "Coming soon" tooltip for disabled modes', () => {
    renderSidebar()
    // Tooltip content is rendered inline due to mock
    const tooltipContents = screen.getAllByTestId('tooltip-content')
    expect(tooltipContents.length).toBe(3) // Monitor, Canvas, Code
    tooltipContents.forEach((el) => {
      expect(el.textContent).toContain('Coming soon')
    })
  })

  it('renders AdminDropdown', () => {
    renderSidebar()
    expect(screen.getByTestId('admin-dropdown')).toBeInTheDocument()
  })

  it('passes collapsed prop to AdminDropdown', () => {
    mockCollapsed = true
    renderSidebar()
    const dropdown = screen.getByTestId('admin-dropdown')
    expect(dropdown.getAttribute('data-collapsed')).toBe('true')
  })

  it('toggles collapsed state', async () => {
    const user = userEvent.setup()
    renderSidebar()
    const collapseBtn = screen.getByTitle('Collapse')
    await user.click(collapseBtn)
    expect(mockToggle).toHaveBeenCalledTimes(1)
  })

  it('theme toggle switches dark/light', async () => {
    const user = userEvent.setup()
    renderSidebar()
    const themeBtn = screen.getByTitle('Light Mode')
    await user.click(themeBtn)
    expect(toggleTheme).toHaveBeenCalledTimes(1)
  })

  it('collapsed sidebar hides labels', () => {
    mockCollapsed = true
    renderSidebar()
    // In collapsed mode, text labels are hidden
    expect(screen.queryByText('Chat')).not.toBeInTheDocument()
    expect(screen.queryByText('Monitor')).not.toBeInTheDocument()
    expect(screen.queryByText('Notifications')).not.toBeInTheDocument()
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

  it('renders notification bell', () => {
    renderSidebar()
    expect(screen.getByTitle('Notifications')).toBeInTheDocument()
  })
})
