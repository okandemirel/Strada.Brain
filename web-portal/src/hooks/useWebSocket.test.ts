import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildModelSwitchCommand,
  useWebSocket,
} from './useWebSocket'
import { useSessionStore } from '../stores/session-store'
import { useCanvasStore } from '../stores/canvas-store'

const originalWebSocket = globalThis.WebSocket
const originalLocalStorage = window.localStorage

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: MockWebSocket[] = []

  readonly sent: string[] = []
  readyState = MockWebSocket.CONNECTING
  private readonly listeners = new Map<string, Array<(event?: MessageEvent) => void>>()

  constructor(_url: string) {
    MockWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event?: MessageEvent) => void) {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  send(payload: string) {
    this.sent.push(payload)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.emit('close')
  }

  emit(type: string, data?: unknown) {
    if (type === 'open') {
      this.readyState = MockWebSocket.OPEN
    }
    const listeners = this.listeners.get(type) ?? []
    for (const listener of listeners) {
      listener(data === undefined ? undefined : ({ data: JSON.stringify(data) } as MessageEvent))
    }
  }
}

function createStorageMock() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    clear: () => {
      values.clear()
    },
  }
}

describe('buildModelSwitchCommand', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    const storage = createStorageMock()
    Object.defineProperty(globalThis, 'WebSocket', {
      value: MockWebSocket,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
    })
    Object.defineProperty(window, 'localStorage', {
      value: storage,
      configurable: true,
    })
    useSessionStore.getState().reset()
    useCanvasStore.getState().reset()
  })

  afterEach(() => {
    cleanup()
    useSessionStore.getState().reset()
    useCanvasStore.getState().reset()
    Object.defineProperty(globalThis, 'WebSocket', {
      value: originalWebSocket,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
    })
    Object.defineProperty(window, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
    })
  })

  it('preserves slash-delimited model ids for provider workers that use path-style names', () => {
    expect(
      buildModelSwitchCommand('fireworks', 'accounts/fireworks/models/llama4-maverick-instruct-basic'),
    ).toBe('/model fireworks/accounts/fireworks/models/llama4-maverick-instruct-basic')
  })

  it('sanitizes unsafe characters without breaking valid model separators', () => {
    expect(
      buildModelSwitchCommand('together<script>', 'meta-llama/Llama-4-Maverick-17B-128E-Instruct??'),
    ).toBe('/model togetherscript/meta-llama/Llama-4-Maverick-17B-128E-Instruct')
  })

  it('queues user messages until the session handshake is acknowledged, then flushes them', () => {
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    expect(socket).toBeDefined()

    act(() => {
      socket!.emit('open')
    })
    expect(socket!.sent).toHaveLength(1)
    expect(JSON.parse(socket!.sent[0]!)).toEqual(expect.objectContaining({ type: 'session_init' }))

    act(() => {
      expect(result.current.sendMessage('follow up after reconnect')).toBe(true)
    })

    expect(socket!.sent).toHaveLength(1)
    const pendingMessage = useSessionStore.getState().messages.at(-1)
    expect(pendingMessage).toEqual(expect.objectContaining({
      sender: 'user',
      text: 'follow up after reconnect',
      deliveryState: 'pending',
    }))

    act(() => {
      socket!.emit('message', {
        type: 'connected',
        chatId: 'chat-1',
        reconnectToken: 'reconnect-1',
        profileId: 'profile-1',
      })
    })

    expect(socket!.sent).toHaveLength(2)
    const flushedPayload = JSON.parse(socket!.sent[1]!)
    expect(flushedPayload).toEqual(expect.objectContaining({
      type: 'message',
      text: 'follow up after reconnect',
      clientMessageId: pendingMessage?.id,
    }))

    act(() => {
      socket!.emit('message', {
        type: 'message_received',
        clientMessageId: flushedPayload.clientMessageId,
      })
    })

    expect(useSessionStore.getState().messages.at(-1)?.deliveryState).toBeUndefined()
  })

  it('flags a markdown frame for the renderer and leaves a text frame plain (audit 11.1 / D31)', () => {
    renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    act(() => {
      socket!.emit('open')
      socket!.emit('message', { type: 'connected', chatId: 'chat-md', reconnectToken: 'r', profileId: 'p' })
      socket!.emit('message', { type: 'markdown', text: '![frame.png](/attachments/tok)', messageId: 'm-md' })
      socket!.emit('message', { type: 'text', text: 'plain ![not-an-image](x)', messageId: 'm-txt' })
    })
    const messages = useSessionStore.getState().messages
    expect(messages.find((m) => m.id === 'm-md')?.isMarkdown).toBe(true)
    // Guard: a text frame is still shown verbatim, never parsed as markdown.
    expect(messages.find((m) => m.id === 'm-txt')?.isMarkdown).toBe(false)
  })

  it('keeps the confirmation dialog and queues the reply while the socket is closed, sending it on reconnect (audit 11.5 / D35)', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    act(() => {
      socket!.emit('open')
      socket!.emit('message', { type: 'connected', chatId: 'chat-cf', reconnectToken: 'r-cf', profileId: 'p-cf' })
      socket!.emit('message', { type: 'confirmation', confirmId: 'cf-1', question: 'Deploy?', options: ['yes', 'no'] })
    })
    expect(useSessionStore.getState().confirmation?.confirmId).toBe('cf-1')

    act(() => { socket!.close() })
    act(() => { result.current.sendConfirmation('cf-1', 'yes') })

    // The answer is not lost: the dialog is still up and nothing was sent on the dead socket.
    expect(useSessionStore.getState().confirmation?.confirmId).toBe('cf-1')
    expect(socket!.sent.map((s) => JSON.parse(s).type)).not.toContain('confirmation_response')

    // Reconnect: the queued reply is flushed once the session handshake completes.
    act(() => { vi.advanceTimersByTime(30000) })
    const next = MockWebSocket.instances[1]
    expect(next).toBeDefined()
    act(() => {
      next!.emit('open')
      next!.emit('message', { type: 'connected', chatId: 'chat-cf', reconnectToken: 'r-cf2', profileId: 'p-cf' })
    })
    expect(next!.sent.map((s) => JSON.parse(s))).toContainEqual({ type: 'confirmation_response', confirmId: 'cf-1', option: 'yes' })
    expect(useSessionStore.getState().confirmation).toBeNull()
  })

  it('sends a confirmation reply immediately and clears the dialog when the socket is open (guard)', () => {
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    act(() => {
      socket!.emit('open')
      socket!.emit('message', { type: 'connected', chatId: 'chat-cf2', reconnectToken: 'r', profileId: 'p' })
      socket!.emit('message', { type: 'confirmation', confirmId: 'cf-2', question: 'Deploy?', options: ['yes', 'no'] })
    })
    act(() => { result.current.sendConfirmation('cf-2', 'no') })
    expect(JSON.parse(socket!.sent.at(-1)!)).toEqual({ type: 'confirmation_response', confirmId: 'cf-2', option: 'no' })
    expect(useSessionStore.getState().confirmation).toBeNull()
  })

  it('marks queued outbound messages as failed when no receipt arrives in time', () => {
    vi.useFakeTimers()

    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    expect(socket).toBeDefined()

    act(() => {
      socket!.emit('open')
      socket!.emit('message', {
        type: 'connected',
        chatId: 'chat-2',
        reconnectToken: 'reconnect-2',
        profileId: 'profile-2',
      })
      expect(result.current.sendMessage('still waiting')).toBe(true)
    })

    expect(useSessionStore.getState().messages.at(-1)?.deliveryState).toBe('pending')

    act(() => {
      vi.advanceTimersByTime(8000)
    })

    expect(useSessionStore.getState().messages.at(-1)?.deliveryState).toBe('failed')
  })

  it('keeps sent messages pending across a transient close until the receipt timeout expires', () => {
    vi.useFakeTimers()

    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    expect(socket).toBeDefined()

    act(() => {
      socket!.emit('open')
      socket!.emit('message', {
        type: 'connected',
        chatId: 'chat-3',
        reconnectToken: 'reconnect-3',
        profileId: 'profile-3',
      })
      expect(result.current.sendMessage('transient disconnect')).toBe(true)
      socket!.close()
    })

    expect(useSessionStore.getState().messages.at(-1)?.deliveryState).toBe('pending')

    act(() => {
      vi.advanceTimersByTime(8000)
    })

    expect(useSessionStore.getState().messages.at(-1)?.deliveryState).toBe('failed')
  })

  it('queues raw workspace commands until the session is ready', () => {
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    expect(socket).toBeDefined()

    act(() => {
      socket!.emit('open')
      expect(result.current.sendRawJSON({ type: 'monitor:retry_task', rootId: 'root-1' })).toBe(true)
    })

    expect(socket!.sent).toHaveLength(1)

    act(() => {
      socket!.emit('message', {
        type: 'connected',
        chatId: 'chat-raw',
        reconnectToken: 'reconnect-raw',
        profileId: 'profile-raw',
      })
    })

    expect(JSON.parse(socket!.sent.at(-1)!)).toEqual({
      type: 'monitor:retry_task',
      rootId: 'root-1',
    })
    expect(useCanvasStore.getState().sessionId).toBe('profile-raw')
  })

  it('drops queued raw commands if the claimed session changes before flush', () => {
    vi.useFakeTimers()
    localStorage.setItem('strada-chatId', 'chat-old')
    localStorage.setItem('strada-profileId', 'profile-old')

    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    expect(socket).toBeDefined()

    act(() => {
      socket!.emit('open')
      expect(result.current.sendRawJSON({ type: 'monitor:cancel_task', rootId: 'root-old' })).toBe(true)
      socket!.emit('message', {
        type: 'connected',
        chatId: 'chat-new',
        reconnectToken: 'reconnect-new',
        profileId: 'profile-new',
      })
      vi.advanceTimersByTime(1500)
    })

    expect(socket!.sent.some((payload) => payload.includes('monitor:cancel_task'))).toBe(false)
  })
})
