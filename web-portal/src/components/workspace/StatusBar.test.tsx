import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// Mock useWS hook
const mockUseWS = vi.fn()
vi.mock('../../hooks/useWS', () => ({
  useWS: () => mockUseWS(),
}))

import StatusBar from './StatusBar'

describe('StatusBar', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  beforeEach(() => {
    mockUseWS.mockReturnValue({ status: 'connected' })
  })

  it('renders "Connected" label when connected', () => {
    mockUseWS.mockReturnValue({ status: 'connected' })
    render(<StatusBar />)
    expect(screen.getByText('Connected')).toBeInTheDocument()
  })

  it('renders green dot when connected', () => {
    mockUseWS.mockReturnValue({ status: 'connected' })
    const { container } = render(<StatusBar />)
    const dot = container.querySelector('.bg-success')
    expect(dot).not.toBeNull()
  })

  it('renders "Disconnected" label when disconnected', () => {
    mockUseWS.mockReturnValue({ status: 'disconnected' })
    render(<StatusBar />)
    expect(screen.getByText('Disconnected')).toBeInTheDocument()
  })

  it('renders red dot when disconnected', () => {
    mockUseWS.mockReturnValue({ status: 'disconnected' })
    const { container } = render(<StatusBar />)
    const dot = container.querySelector('.bg-error')
    expect(dot).not.toBeNull()
  })

  it('renders "Reconnecting" label when reconnecting', () => {
    mockUseWS.mockReturnValue({ status: 'reconnecting' })
    render(<StatusBar />)
    expect(screen.getByText('Reconnecting')).toBeInTheDocument()
  })

  it('renders yellow dot when reconnecting', () => {
    mockUseWS.mockReturnValue({ status: 'reconnecting' })
    const { container } = render(<StatusBar />)
    const dot = container.querySelector('.bg-warning')
    expect(dot).not.toBeNull()
  })
})
