import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import type { ChatMessage, ConfirmationState, ConnectionStatus } from '../types/messages'

const mockUseWS = vi.fn()

vi.mock('../hooks/useWS', () => ({
  useWS: () => mockUseWS(),
}))

// Mock child components to isolate ChatView logic
vi.mock('./PrimaryWorkerSelector', () => ({
  default: () => <div data-testid="worker-selector">Worker Selector</div>,
}))

vi.mock('./VoiceRecorder', () => ({
  default: () => null,
}))

vi.mock('./VoiceOutput', () => ({
  default: () => null,
}))

vi.mock('./ui/blur-fade', () => ({
  BlurFade: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock virtualizer — jsdom has no layout so useVirtualizer returns no items
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({ index: i, start: i * 80, size: 80, key: i })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}))

import ChatView from './ChatView'

function createMockWS(overrides: {
  messages?: ChatMessage[]
  status?: ConnectionStatus
  confirmation?: ConfirmationState | null
  isTyping?: boolean
} = {}) {
  return {
    messages: overrides.messages ?? [],
    status: overrides.status ?? 'connected',
    confirmation: overrides.confirmation ?? null,
    isTyping: overrides.isTyping ?? false,
    sendMessage: vi.fn().mockReturnValue(true),
    sendConfirmation: vi.fn(),
    sessionId: 'test-session',
    profileId: null,
    switchProvider: vi.fn(),
    toggleAutonomous: vi.fn(),
  }
}

describe('ChatView', () => {
  beforeEach(() => {
    // Mock scrollIntoView for jsdom
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders empty state when no messages', () => {
    mockUseWS.mockReturnValue(createMockWS({ messages: [], isTyping: false }))
    render(<ChatView />)
    expect(screen.getByText('Strada.Brain')).toBeInTheDocument()
    expect(screen.getByText(/AI-powered Unity development assistant/)).toBeInTheDocument()
  })

  it('renders messages from WS hook', () => {
    const messages: ChatMessage[] = [
      { id: '1', sender: 'user', text: 'Hello', isMarkdown: false, timestamp: Date.now() },
      { id: '2', sender: 'assistant', text: 'Hi there!', isMarkdown: false, timestamp: Date.now() },
    ]
    mockUseWS.mockReturnValue(createMockWS({ messages }))
    render(<ChatView />)
    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(screen.getByText('Hi there!')).toBeInTheDocument()
  })

  it('does not show empty state when messages exist', () => {
    const messages: ChatMessage[] = [
      { id: '1', sender: 'user', text: 'Test', isMarkdown: false, timestamp: Date.now() },
    ]
    mockUseWS.mockReturnValue(createMockWS({ messages }))
    render(<ChatView />)
    expect(screen.queryByText(/AI-powered Unity development assistant/)).not.toBeInTheDocument()
  })

  it('shows typing indicator when isTyping is true', () => {
    mockUseWS.mockReturnValue(createMockWS({ messages: [{ id: '1', sender: 'user', text: 'test', isMarkdown: false, timestamp: Date.now() }], isTyping: true }))
    const { container } = render(<ChatView />)
    // The typing indicator renders a TypingAnimation component inside a bubble
    const bubble = container.querySelector('.backdrop-blur.border.border-white\\/5.rounded-xl')
    expect(bubble).toBeInTheDocument()
  })
})
