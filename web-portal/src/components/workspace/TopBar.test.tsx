import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// Mock workspace store
let mockMode = 'chat'
vi.mock('../../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (s: { mode: string }) => unknown) => {
    const state = { mode: mockMode }
    return selector ? selector(state) : state
  },
}))

import TopBar from './TopBar'

describe('TopBar', () => {
  beforeEach(() => {
    mockMode = 'chat'
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders current mode label', () => {
    render(<TopBar />)
    expect(screen.getByText('Chat')).toBeInTheDocument()
  })

  it('renders mode icon (SVG element present)', () => {
    const { container } = render(<TopBar />)
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('updates label when mode changes', () => {
    mockMode = 'monitor'
    render(<TopBar />)
    expect(screen.getByText('Monitor')).toBeInTheDocument()
  })

  it('renders canvas mode label', () => {
    mockMode = 'canvas'
    render(<TopBar />)
    expect(screen.getByText('Canvas')).toBeInTheDocument()
  })

  it('renders code mode label', () => {
    mockMode = 'code'
    render(<TopBar />)
    expect(screen.getByText('Code')).toBeInTheDocument()
  })
})
