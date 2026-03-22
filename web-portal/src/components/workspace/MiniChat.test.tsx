import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock useWS hook
const mockSendMessage = vi.fn()
const mockUseWS = vi.fn()
vi.mock('../../hooks/useWS', () => ({
  useWS: () => mockUseWS(),
}))

import MiniChat from './MiniChat'

describe('MiniChat', () => {
  beforeEach(() => {
    mockUseWS.mockReturnValue({ sendMessage: mockSendMessage, status: 'connected' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders input field', () => {
    render(<MiniChat />)
    expect(screen.getByPlaceholderText('Quick message...')).toBeInTheDocument()
  })

  it('send button is disabled when input is empty', () => {
    render(<MiniChat />)
    const btn = screen.getByRole('button', { name: /send/i })
    expect(btn).toBeDisabled()
  })

  it('send button is disabled when disconnected', () => {
    mockUseWS.mockReturnValue({ sendMessage: mockSendMessage, status: 'disconnected' })
    render(<MiniChat />)
    const btn = screen.getByRole('button', { name: /send/i })
    expect(btn).toBeDisabled()
  })

  it('send button is enabled when connected and text present', async () => {
    const user = userEvent.setup()
    render(<MiniChat />)
    const input = screen.getByPlaceholderText('Quick message...')
    await user.type(input, 'hello')
    const btn = screen.getByRole('button', { name: /send/i })
    expect(btn).not.toBeDisabled()
  })

  it('sends message on Enter key', async () => {
    const user = userEvent.setup()
    render(<MiniChat />)
    const input = screen.getByPlaceholderText('Quick message...')
    await user.type(input, 'hello')
    await user.keyboard('{Enter}')
    expect(mockSendMessage).toHaveBeenCalledWith('hello')
  })

  it('clears input after sending', async () => {
    const user = userEvent.setup()
    render(<MiniChat />)
    const input = screen.getByPlaceholderText('Quick message...')
    await user.type(input, 'hello')
    await user.keyboard('{Enter}')
    expect(input).toHaveValue('')
  })

  it('does not send empty message', async () => {
    const user = userEvent.setup()
    render(<MiniChat />)
    const input = screen.getByPlaceholderText('Quick message...')
    await user.click(input)
    await user.keyboard('{Enter}')
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('does not send on Shift+Enter', async () => {
    const user = userEvent.setup()
    render(<MiniChat />)
    const input = screen.getByPlaceholderText('Quick message...')
    await user.type(input, 'hello')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(mockSendMessage).not.toHaveBeenCalled()
  })
})
