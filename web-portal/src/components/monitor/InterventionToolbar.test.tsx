import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const mockSendRawJSON = vi.fn().mockReturnValue(true)

vi.mock('../../hooks/useWS', () => ({
  useWS: () => ({
    sendRawJSON: mockSendRawJSON,
  }),
}))

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Pause: () => <svg data-testid="pause-icon" />,
  Play: () => <svg data-testid="play-icon" />,
}))

import InterventionToolbar from './InterventionToolbar'

describe('InterventionToolbar', () => {
  beforeEach(() => {
    mockSendRawJSON.mockClear()
  })

  it('renders Pause button initially', () => {
    render(<InterventionToolbar />)
    expect(screen.getByText('Pause')).toBeInTheDocument()
    expect(screen.getByTestId('pause-icon')).toBeInTheDocument()
  })

  it('clicking Pause sends monitor:pause command', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    render(<InterventionToolbar />)
    await user.click(screen.getByText('Pause'))

    expect(mockSendRawJSON).toHaveBeenCalledWith({ type: 'monitor:pause' })
  })

  it('toggles to Resume after clicking Pause', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    render(<InterventionToolbar />)
    await user.click(screen.getByText('Pause'))

    expect(screen.getByText('Resume')).toBeInTheDocument()
    expect(screen.getByTestId('play-icon')).toBeInTheDocument()
  })

  it('clicking Resume sends monitor:resume command', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    render(<InterventionToolbar />)
    // Click Pause first to toggle to Resume
    await user.click(screen.getByText('Pause'))
    mockSendRawJSON.mockClear()

    // Now click Resume
    await user.click(screen.getByText('Resume'))
    expect(mockSendRawJSON).toHaveBeenCalledWith({ type: 'monitor:resume' })
  })

  it('toggles back to Pause after Resume', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    render(<InterventionToolbar />)
    await user.click(screen.getByText('Pause'))
    await user.click(screen.getByText('Resume'))

    expect(screen.getByText('Pause')).toBeInTheDocument()
  })
})
