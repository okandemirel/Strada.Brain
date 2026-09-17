import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
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

// Node >= 22 exposes its own experimental `localStorage` global (no `.length`
// without --localstorage-file), which shadows jsdom's and crashes
// SessionPicker's history scan. Give the suite a real Storage-like object.
function createStorageMock() {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    key: (i: number) => Array.from(values.keys())[i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => { values.clear() },
  }
}
const originalLocalStorage = window.localStorage

describe('ChatView', () => {
  beforeEach(() => {
    // Mock scrollIntoView for jsdom
    Element.prototype.scrollIntoView = vi.fn()
    const storage = createStorageMock()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
  })

  afterEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true })
    Object.defineProperty(window, 'localStorage', { value: originalLocalStorage, configurable: true })
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

  it('finds a message older than the visible window and widens the window to it (HIST / 0-A.28)', () => {
    const messages: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m-${i + 1}`,
      sender: i % 2 === 0 ? 'user' : 'assistant',
      text: `msg-${i + 1}-end`,
      isMarkdown: false,
      timestamp: i,
    }))
    mockUseWS.mockReturnValue(createMockWS({ messages }))
    render(<ChatView />)
    // Only the newest 50 are rendered; message 1 is behind "Load earlier".
    expect(screen.getByText(/Load 10 earlier/)).toBeInTheDocument()
    expect(screen.queryByText('msg-1-end')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByPlaceholderText('Search messages...'), { target: { value: 'msg-1-end' } })

    expect(screen.getByText(/^1 results$/)).toBeInTheDocument()
    expect(screen.getByText('msg-1-end')).toBeInTheDocument()
    // The window grew to include the hit, so nothing is hidden any more.
    expect(screen.queryByText(/earlier messages/)).toBeNull()
  })

  it('still finds a message inside the visible window and leaves the window alone (guard)', () => {
    const messages: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m-${i + 1}`,
      sender: 'assistant',
      text: `msg-${i + 1}-end`,
      isMarkdown: false,
      timestamp: i,
    }))
    mockUseWS.mockReturnValue(createMockWS({ messages }))
    render(<ChatView />)
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByPlaceholderText('Search messages...'), { target: { value: 'msg-60-end' } })
    expect(screen.getByText(/^1 results$/)).toBeInTheDocument()
    expect(screen.getByText('msg-60-end')).toBeInTheDocument()
    // Clearing the search restores the plain 50-message window.
    fireEvent.change(screen.getByPlaceholderText('Search messages...'), { target: { value: '' } })
    expect(screen.getByText(/Load 10 earlier/)).toBeInTheDocument()
  })

  it('shows typing indicator when isTyping is true', () => {
    mockUseWS.mockReturnValue(createMockWS({ messages: [{ id: '1', sender: 'user', text: 'test', isMarkdown: false, timestamp: Date.now() }], isTyping: true }))
    const { container } = render(<ChatView />)
    // The typing indicator renders a TypingAnimation component inside a bubble
    const bubble = container.querySelector('.backdrop-blur.border.border-white\\/5.rounded-xl')
    expect(bubble).toBeInTheDocument()
  })
})
