import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WebSocketProvider } from '../contexts/WebSocketContext'
import { useSessionStore } from '../stores/session-store'

vi.mock('./PrimaryWorkerSelector', () => ({ default: () => null }))
vi.mock('./VoiceRecorder', () => ({ default: () => null }))
vi.mock('./VoiceOutput', () => ({ default: () => null }))
vi.mock('./ui/blur-fade', () => ({
  BlurFade: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
// jsdom has no layout, so the real virtualizer would render no rows.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 80, size: 80, key: i })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}))

import ChatView from './ChatView'

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: MockWebSocket[] = []
  readonly sent: string[] = []
  readyState = MockWebSocket.CONNECTING
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>()
  constructor() { MockWebSocket.instances.push(this) }
  addEventListener(type: string, listener: (event?: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(payload: string) { this.sent.push(payload) }
  close() { this.readyState = MockWebSocket.CLOSED; this.emit('close') }
  emit(type: string, data?: unknown) {
    if (type === 'open') this.readyState = MockWebSocket.OPEN
    for (const listener of this.listeners.get(type) ?? []) {
      listener(data === undefined ? undefined : { data: JSON.stringify(data) })
    }
  }
}

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

const originalWebSocket = globalThis.WebSocket
const originalLocalStorage = window.localStorage

function storeSession(key: string, id: string, text: string, timestamp: number) {
  window.localStorage.setItem(
    `strada-session-messages:${key}`,
    JSON.stringify([{ id, sender: 'user', text, isMarkdown: false, timestamp }]),
  )
}

// WEB-11: opening a stored session while a reply was streaming set the live
// conversation aside where no frame reached it. The rest of the stream was
// dropped, and "Back to current" showed the half reply still streaming.
describe('ChatView with a stored session on screen during a live stream', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    MockWebSocket.instances = []
    const storage = createStorageMock()
    Object.defineProperty(globalThis, 'WebSocket', { value: MockWebSocket, configurable: true })
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
    useSessionStore.getState().reset()
    storeSession('profile-live', 'live-1', 'the live question', Date.now() - 1000)
    storeSession('profile-old', 'old-1', 'an older question', Date.now() - 86_400_000)
  })

  afterEach(() => {
    cleanup()
    useSessionStore.getState().reset()
    Object.defineProperty(globalThis, 'WebSocket', { value: originalWebSocket, configurable: true })
    Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true })
    Object.defineProperty(window, 'localStorage', { value: originalLocalStorage, configurable: true })
  })

  it('keeps the stream going and shows the finished reply after returning', () => {
    render(<WebSocketProvider><ChatView /></WebSocketProvider>)
    const socket = MockWebSocket.instances[0]!
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-live', reconnectToken: 'r', profileId: 'profile-live' })
      socket.emit('message', { type: 'stream_start', streamId: 'st-1', text: '' })
      socket.emit('message', { type: 'stream_update', streamId: 'st-1', delta: 'Hello ' })
    })

    fireEvent.click(screen.getByLabelText('Session history'))
    fireEvent.click(screen.getByText('an older question'))
    expect(useSessionStore.getState().viewingHistorical).toBe(true)

    act(() => {
      socket.emit('message', { type: 'stream_update', streamId: 'st-1', delta: 'world' })
      socket.emit('message', { type: 'stream_end', streamId: 'st-1', text: 'Hello world, the whole answer.' })
    })
    // The stored session on screen is left alone.
    expect(screen.queryByText('Hello world, the whole answer.')).toBeNull()

    fireEvent.click(screen.getByText('Back to current'))
    expect(useSessionStore.getState().viewingHistorical).toBe(false)
    expect(screen.getByText('Hello world, the whole answer.')).toBeInTheDocument()
    const reply = useSessionStore.getState().messages.find((m) => m.streamId === 'st-1')
    expect(reply).toMatchObject({ text: 'Hello world, the whole answer.', isStreaming: false })
    expect(screen.getByText('the live question')).toBeInTheDocument()
  })

  it('ends the live stream on a disconnect while the stored session is on screen', () => {
    render(<WebSocketProvider><ChatView /></WebSocketProvider>)
    const socket = MockWebSocket.instances[0]!
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-live', reconnectToken: 'r', profileId: 'profile-live' })
      socket.emit('message', { type: 'stream_start', streamId: 'st-2', text: 'Working' })
    })
    fireEvent.click(screen.getByLabelText('Session history'))
    fireEvent.click(screen.getByText('an older question'))

    act(() => { socket.close() })
    fireEvent.click(screen.getByText('Back to current'))

    const reply = useSessionStore.getState().messages.find((m) => m.streamId === 'st-2')
    expect(reply).toMatchObject({ text: 'Working', isStreaming: false })
  })

  it('still brings back a live message that arrived during the history view (guard)', () => {
    render(<WebSocketProvider><ChatView /></WebSocketProvider>)
    const socket = MockWebSocket.instances[0]!
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-live', reconnectToken: 'r', profileId: 'profile-live' })
    })
    fireEvent.click(screen.getByLabelText('Session history'))
    fireEvent.click(screen.getByText('an older question'))
    act(() => { socket.emit('message', { type: 'text', text: 'a reply that came meanwhile', messageId: 'm-new' }) })

    fireEvent.click(screen.getByText('Back to current'))
    expect(useSessionStore.getState().messages.map((m) => m.id)).toEqual(['live-1', 'm-new'])
  })
})
