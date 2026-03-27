import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ChatMessage as ChatMessageType } from '../types/messages'

// Mock VoiceOutput to avoid audio issues in jsdom
vi.mock('./VoiceOutput', () => ({
  default: () => null,
}))

import ChatMessage from './ChatMessage'

function makeMessage(overrides: Partial<ChatMessageType> = {}): ChatMessageType {
  return {
    id: 'msg-1',
    sender: 'user',
    text: 'Hello',
    isMarkdown: false,
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('ChatMessage', () => {
  it('renders user message with correct styling', () => {
    const { container } = render(<ChatMessage message={makeMessage({ sender: 'user', text: 'User message here' })} />)
    expect(screen.getByText('User message here')).toBeInTheDocument()
    // User messages are self-end (right-aligned)
    const msgDiv = container.firstChild as HTMLElement
    expect(msgDiv.className).toContain('self-end')
    expect(msgDiv.className).toContain('from-accent/10')
  })

  it('renders assistant message', () => {
    const { container } = render(
      <ChatMessage message={makeMessage({ sender: 'assistant', text: 'Bot reply', isMarkdown: false })} />,
    )
    expect(screen.getByText('Bot reply')).toBeInTheDocument()
    const msgDiv = container.firstChild as HTMLElement
    expect(msgDiv.className).toContain('self-start')
    expect(msgDiv.className).toContain('backdrop-blur')
  })

  it('renders assistant markdown message', () => {
    render(
      <ChatMessage
        message={makeMessage({
          sender: 'assistant',
          text: '**Bold text** and `code`',
          isMarkdown: true,
        })}
      />,
    )
    // ReactMarkdown should render the bold text
    expect(screen.getByText('Bold text')).toBeInTheDocument()
    expect(screen.getByText('code')).toBeInTheDocument()
  })

  it('renders attachments', () => {
    render(
      <ChatMessage
        message={makeMessage({
          sender: 'user',
          text: 'Check this file',
          attachments: [
            { name: 'report.pdf', type: 'application/pdf', data: 'base64data', size: 1024 },
          ],
        })}
      />,
    )
    expect(screen.getByText('Check this file')).toBeInTheDocument()
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
    expect(screen.getByText('PDF')).toBeInTheDocument()
  })

  it('renders image attachments inline', () => {
    render(
      <ChatMessage
        message={makeMessage({
          sender: 'user',
          text: 'Look at this',
          attachments: [
            { name: 'photo.png', type: 'image/png', data: 'base64imagedata', size: 2048 },
          ],
        })}
      />,
    )
    const img = screen.getByAltText('photo.png')
    expect(img).toBeInTheDocument()
    expect(img.getAttribute('src')).toContain('data:image/png;base64,base64imagedata')
  })

  it('does not render user message as markdown', () => {
    const { container } = render(
      <ChatMessage message={makeMessage({ sender: 'user', text: '**not bold**', isMarkdown: true })} />,
    )
    // User messages are rendered as plain text spans, not markdown
    const span = container.querySelector('span')
    expect(span?.textContent).toBe('**not bold**')
  })

  it('shows streaming cursor when isStreaming is true', () => {
    const { container } = render(
      <ChatMessage
        message={makeMessage({
          sender: 'assistant',
          text: 'Typing...',
          isStreaming: true,
        })}
      />,
    )
    // Streaming cursor is an animated span
    const cursor = container.querySelector('.animate-\\[blink_1s_step-end_infinite\\]')
    expect(cursor).toBeInTheDocument()
  })

  it('shows delivery failure state for unsent user messages', () => {
    render(
      <ChatMessage
        message={makeMessage({
          sender: 'user',
          text: 'Queued locally',
          deliveryState: 'failed',
        })}
      />,
    )

    expect(screen.getByText('Not delivered')).toBeInTheDocument()
  })
})
