import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// Mock workspace store
let mockSecondaryVisible = false
vi.mock('../../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (s: { secondaryVisible: boolean; mode: string }) => unknown) => {
    const state = { secondaryVisible: mockSecondaryVisible, mode: 'chat' }
    return selector ? selector(state) : state
  },
}))

// Mock useWS for StatusBar (rendered inside PanelLayout)
vi.mock('../../hooks/useWS', () => ({
  useWS: () => ({ status: 'connected', sendMessage: vi.fn() }),
}))

// Mock react-resizable-panels to avoid DOM measurement issues in tests
vi.mock('react-resizable-panels', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div data-testid="panel">{children}</div>,
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div data-testid="panel-group">{children}</div>,
  PanelResizeHandle: () => <div data-testid="resize-handle" />,
}))

import PanelLayout from './PanelLayout'

describe('PanelLayout', () => {
  beforeEach(() => {
    mockSecondaryVisible = false
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders primary content', () => {
    render(<PanelLayout primary={<div data-testid="primary-content">Primary</div>} />)
    expect(screen.getByTestId('primary-content')).toBeInTheDocument()
  })

  it('hides secondary panel when secondaryVisible is false', () => {
    mockSecondaryVisible = false
    render(
      <PanelLayout
        primary={<div>Primary</div>}
        secondary={<div data-testid="secondary-content">Secondary</div>}
      />,
    )
    expect(screen.queryByTestId('secondary-content')).not.toBeInTheDocument()
  })

  it('shows secondary panel when secondaryVisible is true', () => {
    mockSecondaryVisible = true
    render(
      <PanelLayout
        primary={<div>Primary</div>}
        secondary={<div data-testid="secondary-content">Secondary</div>}
      />,
    )
    expect(screen.getByTestId('secondary-content')).toBeInTheDocument()
  })

  it('renders TopBar (mode label visible)', () => {
    render(<PanelLayout primary={<div>Primary</div>} />)
    // TopBar renders the current mode label; mode is mocked as 'chat'
    expect(screen.getByText('Chat')).toBeInTheDocument()
  })

  it('renders StatusBar (connection label visible)', () => {
    render(<PanelLayout primary={<div>Primary</div>} />)
    expect(screen.getByText('Connected')).toBeInTheDocument()
  })

  it('renders resize handle when secondary is visible', () => {
    mockSecondaryVisible = true
    render(
      <PanelLayout
        primary={<div>Primary</div>}
        secondary={<div>Secondary</div>}
      />,
    )
    expect(screen.getByTestId('resize-handle')).toBeInTheDocument()
  })

  it('does not render resize handle when secondary is hidden', () => {
    mockSecondaryVisible = false
    render(
      <PanelLayout
        primary={<div>Primary</div>}
        secondary={<div>Secondary</div>}
      />,
    )
    expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument()
  })
})
