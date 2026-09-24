import { StrictMode } from 'react'
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
  /** A fake server's view of outgoing frames (WEB-1 tests). */
  static onSend: ((socket: MockWebSocket, payload: string) => void) | null = null

  readonly sent: string[] = []
  readyState = MockWebSocket.CONNECTING
  private readonly listeners = new Map<string, Array<(event?: MessageEvent) => void>>()

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event?: MessageEvent) => void) {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  send(payload: string) {
    this.sent.push(payload)
    MockWebSocket.onSend?.(this, payload)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.emit('close')
  }

  /** The server closes the socket: the close event carries its code. */
  serverClose(code: number, reason = '') {
    this.readyState = MockWebSocket.CLOSED
    for (const listener of this.listeners.get('close') ?? []) {
      listener({ code, reason } as unknown as MessageEvent)
    }
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

function installTestEnvironment() {
  MockWebSocket.instances = []
  MockWebSocket.onSend = null
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
}

function restoreTestEnvironment() {
  cleanup()
  MockWebSocket.onSend = null
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
}

describe('buildModelSwitchCommand', () => {
  beforeEach(installTestEnvironment)

  afterEach(restoreTestEnvironment)

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

  it('renders a structured attachment frame, and falls back to its own fields (plan 2.8)', () => {
    renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    act(() => {
      socket!.emit('open')
      socket!.emit('message', { type: 'connected', chatId: 'chat-at', reconnectToken: 'r', profileId: 'p' })
      socket!.emit('message', {
        type: 'attachment', messageId: 'm-at', name: 'frame.png', href: '/attachments/tok',
        kind: 'image', mimeType: 'image/png', sizeBytes: 8, text: '![frame.png](/attachments/tok)',
      })
      // No markdown supplied: the fields alone still produce a working link.
      socket!.emit('message', { type: 'attachment', messageId: 'm-at2', name: 'HOW_TO_RUN.md', href: '/attachments/tok2', kind: 'file', text: '' })
    })
    const messages = useSessionStore.getState().messages
    const image = messages.find((m) => m.id === 'm-at')
    expect(image?.text).toBe('![frame.png](/attachments/tok)')
    expect(image?.isMarkdown).toBe(true)
    expect(messages.find((m) => m.id === 'm-at2')?.text).toBe('[HOW_TO_RUN.md](/attachments/tok2)')
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

  // Codex review of 0-A.26: "sent" is not "applied". The dialog stays until
  // the server's confirmation_ack; an "unknown" ack (expired server-side)
  // is shown as an error, never swallowed. (The earlier guard "clears the
  // dialog when the socket is open" is inverted here on purpose.)
  it('keeps the dialog through a disconnect, flushes the reply on reconnect, and clears only on the ack', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    act(() => {
      socket!.emit('open')
      socket!.emit('message', { type: 'connected', chatId: 'chat-cf', reconnectToken: 'r-cf', profileId: 'p-cf' })
      socket!.emit('message', { type: 'confirmation', confirmId: 'cf-1', question: 'Deploy?', options: ['yes', 'no'] })
    })
    act(() => { socket!.close() })
    act(() => { result.current.sendConfirmation('cf-1', 'yes') })
    expect(useSessionStore.getState().confirmation?.confirmId).toBe('cf-1')
    expect(socket!.sent.map((s) => JSON.parse(s).type)).not.toContain('confirmation_response')

    act(() => { vi.advanceTimersByTime(30000) })
    const next = MockWebSocket.instances[1]
    act(() => {
      next!.emit('open')
      next!.emit('message', { type: 'connected', chatId: 'chat-cf', reconnectToken: 'r-cf2', profileId: 'p-cf' })
    })
    expect(next!.sent.map((s) => JSON.parse(s))).toContainEqual({ type: 'confirmation_response', confirmId: 'cf-1', option: 'yes' })
    // Sent, but still up and marked pending: the orchestrator has not confirmed.
    expect(useSessionStore.getState().confirmation).toEqual(expect.objectContaining({ confirmId: 'cf-1', pending: true }))

    act(() => { next!.emit('message', { type: 'confirmation_ack', confirmId: 'cf-1', status: 'accepted' }) })
    expect(useSessionStore.getState().confirmation).toBeNull()
  })

  it('shows an expiry error when the server answers that the confirmation id is unknown', () => {
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    act(() => {
      socket!.emit('open')
      socket!.emit('message', { type: 'connected', chatId: 'chat-cf2', reconnectToken: 'r', profileId: 'p' })
      socket!.emit('message', { type: 'confirmation', confirmId: 'cf-2', question: 'Deploy?', options: ['yes', 'no'] })
    })
    act(() => { result.current.sendConfirmation('cf-2', 'no') })
    expect(JSON.parse(socket!.sent.at(-1)!)).toEqual({ type: 'confirmation_response', confirmId: 'cf-2', option: 'no' })
    expect(useSessionStore.getState().confirmation?.pending).toBe(true)

    act(() => { socket!.emit('message', { type: 'confirmation_ack', confirmId: 'cf-2', status: 'unknown' }) })
    expect(useSessionStore.getState().confirmation).toEqual(expect.objectContaining({ confirmId: 'cf-2', pending: false, error: 'expired' }))
    // The user can close it without sending another answer.
    act(() => { result.current.dismissConfirmation() })
    expect(useSessionStore.getState().confirmation).toBeNull()
  })

  it('ignores an ack for a confirmation that is not the one on screen (guard)', () => {
    renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    act(() => {
      socket!.emit('open')
      socket!.emit('message', { type: 'connected', chatId: 'chat-cf3', reconnectToken: 'r', profileId: 'p' })
      socket!.emit('message', { type: 'confirmation', confirmId: 'cf-3', question: 'Deploy?', options: ['yes'] })
      socket!.emit('message', { type: 'confirmation_ack', confirmId: 'someone-else', status: 'accepted' })
    })
    expect(useSessionStore.getState().confirmation?.confirmId).toBe('cf-3')
  })

  // Codex wave 0-A review 2026-09-17 #6 (follow-up to 0ee86669): a reply that
  // left the socket but whose confirmation_ack never arrived used to be gone
  // for good — sendConfirmation set pending:true, the entry was not kept in
  // the outbound queue, and the close handler never touched confirmation
  // state, so the dialog stayed frozen after reconnect.
  it('re-sends a confirmation reply once on reconnect when the socket dropped before the ack', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    act(() => {
      socket!.emit('open')
      socket!.emit('message', { type: 'connected', chatId: 'chat-cf', reconnectToken: 'r-cf', profileId: 'p-cf' })
      socket!.emit('message', { type: 'confirmation', confirmId: 'cf-1', question: 'Deploy?', options: ['yes', 'no'] })
    })
    // Approve while connected: ws.send succeeds locally.
    act(() => { result.current.sendConfirmation('cf-1', 'yes') })
    expect(socket!.sent.map((s) => JSON.parse(s))).toContainEqual({ type: 'confirmation_response', confirmId: 'cf-1', option: 'yes' })
    expect(useSessionStore.getState().confirmation).toEqual(expect.objectContaining({ confirmId: 'cf-1', pending: true }))

    // Socket dies before the confirmation_ack arrives.
    act(() => { socket!.close() })
    act(() => { vi.advanceTimersByTime(30000) })
    const next = MockWebSocket.instances[1]
    act(() => {
      next!.emit('open')
      next!.emit('message', { type: 'connected', chatId: 'chat-cf', reconnectToken: 'r-cf2', profileId: 'p-cf' })
    })

    const replies = next!.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'confirmation_response')
    expect(replies).toEqual([{ type: 'confirmation_response', confirmId: 'cf-1', option: 'yes' }])
    // Still up and pending until the server's ack, exactly as for a first send.
    expect(useSessionStore.getState().confirmation).toEqual(expect.objectContaining({ confirmId: 'cf-1', pending: true }))

    act(() => { next!.emit('message', { type: 'confirmation_ack', confirmId: 'cf-1', status: 'accepted' }) })
    expect(useSessionStore.getState().confirmation).toBeNull()
  })

  it('does not re-send a confirmation reply on a later reconnect once its ack has arrived (guard)', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]
    act(() => {
      socket!.emit('open')
      socket!.emit('message', { type: 'connected', chatId: 'chat-cf', reconnectToken: 'r-cf', profileId: 'p-cf' })
      socket!.emit('message', { type: 'confirmation', confirmId: 'cf-1', question: 'Deploy?', options: ['yes', 'no'] })
    })
    act(() => { result.current.sendConfirmation('cf-1', 'yes') })
    act(() => { socket!.emit('message', { type: 'confirmation_ack', confirmId: 'cf-1', status: 'accepted' }) })
    expect(useSessionStore.getState().confirmation).toBeNull()

    act(() => { socket!.close() })
    act(() => { vi.advanceTimersByTime(30000) })
    const next = MockWebSocket.instances[1]
    act(() => {
      next!.emit('open')
      next!.emit('message', { type: 'connected', chatId: 'chat-cf', reconnectToken: 'r-cf2', profileId: 'p-cf' })
    })
    expect(next!.sent.map((s) => JSON.parse(s).type)).not.toContain('confirmation_response')
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

// WEB-1: two tabs share one localStorage, so both hold the chat's reconnect
// token. The server hands the chat to whichever socket presents it last and
// closes the other; when that close looked like any other, the displaced tab
// reconnected a second later and took the chat back, forever.
describe('useWebSocket session ownership (WEB-1)', () => {
  beforeEach(() => {
    installTestEnvironment()
    vi.useFakeTimers()
  })

  afterEach(() => {
    restoreTestEnvironment()
    vi.useRealTimers()
  })

  const openSockets = () => MockWebSocket.instances.filter((s) => s.readyState === MockWebSocket.OPEN)

  /** A server that implements WebChannel's reclaim rule, answering asynchronously. */
  function createFakeServer() {
    const chats = new Map<string, { token: string; holder: MockWebSocket }>()
    const outbox: Array<() => void> = []
    let seq = 0
    MockWebSocket.onSend = (socket, payload) => {
      const frame = JSON.parse(payload) as { type: string; chatId?: string; reconnectToken?: string }
      if (frame.type !== 'session_init') return
      outbox.push(() => {
        if (socket.readyState !== MockWebSocket.OPEN) return
        const held = frame.chatId ? chats.get(frame.chatId) : undefined
        let chatId = `chat-${++seq}`
        if (frame.chatId && held && held.token === frame.reconnectToken) {
          chatId = frame.chatId
          if (held.holder !== socket && held.holder.readyState === MockWebSocket.OPEN) {
            held.holder.serverClose(4001, 'session_taken')
          }
        }
        const token = `token-${++seq}`
        chats.set(chatId, { token, holder: socket })
        socket.emit('message', { type: 'connected', chatId, reconnectToken: token, profileId: 'profile-1' })
      })
    }
    /** Let `ms` pass: dialing sockets open, the server answers, timers fire. */
    const run = (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 250) {
        act(() => {
          for (const socket of MockWebSocket.instances) {
            if (socket.readyState === MockWebSocket.CONNECTING) socket.emit('open')
          }
          while (outbox.length > 0) outbox.shift()!()
          vi.advanceTimersByTime(250)
        })
      }
    }
    return { run }
  }

  // Both hooks share this module's store here (real tabs each have their
  // own), so the assertions are about sockets, as a server would see them.
  it('two tabs sharing storage settle on one open socket; "use here" moves the chat once', () => {
    const server = createFakeServer()
    const tabA = renderHook(() => useWebSocket())
    server.run(1000)
    expect(localStorage.getItem('strada-chatId')).toBe('chat-1')

    // Tab B reads A's chat and token from the shared storage and takes the chat.
    renderHook(() => useWebSocket())
    server.run(120_000)
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(openSockets()).toEqual([MockWebSocket.instances[1]])

    // The user picks tab A: it takes the chat back, and B stays put this time.
    act(() => { tabA.result.current.resumeSession() })
    server.run(120_000)
    expect(MockWebSocket.instances).toHaveLength(3)
    expect(openSockets()).toEqual([MockWebSocket.instances[2]])
  })

  it('does not reconnect after a session_taken close, and queues sends until "use here"', () => {
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]!
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-x', reconnectToken: 'r', profileId: 'p' })
    })
    act(() => { socket.serverClose(4001, 'session_taken') })
    act(() => { result.current.sendRawJSON({ type: 'cancel_task' }) })
    act(() => { vi.advanceTimersByTime(120_000) })
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(useSessionStore.getState().sessionTaken).toBe(true)

    act(() => { result.current.resumeSession() })
    const next = MockWebSocket.instances[1]!
    act(() => {
      next.emit('open')
      next.emit('message', { type: 'connected', chatId: 'chat-x', reconnectToken: 'r2', profileId: 'p' })
    })
    expect(useSessionStore.getState().sessionTaken).toBe(false)
    expect(next.sent.map((s) => JSON.parse(s).type)).toEqual(['session_init', 'cancel_task'])
  })

  it('backs off after a rate-limit close instead of retrying a second later', () => {
    renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]!
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-rl', reconnectToken: 'r', profileId: 'p' })
    })
    act(() => { vi.advanceTimersByTime(60_000) })
    act(() => { socket.serverClose(1008, 'Rate limit exceeded') })
    act(() => { vi.advanceTimersByTime(9_000) })
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('keeps backing off while sockets close right after opening, and gives up at the cap', () => {
    renderHook(() => useWebSocket())
    act(() => {
      MockWebSocket.instances[0]!.emit('open')
      MockWebSocket.instances[0]!.close()
    })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(MockWebSocket.instances).toHaveLength(2)

    // A bare open must not reset the delay: the next retry waits 2 s, not 1 s.
    act(() => {
      MockWebSocket.instances[1]!.emit('open')
      MockWebSocket.instances[1]!.close()
    })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(MockWebSocket.instances).toHaveLength(2)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(MockWebSocket.instances).toHaveLength(3)

    for (let i = 0; i < 10; i++) {
      act(() => {
        const last = MockWebSocket.instances.at(-1)!
        last.emit('open')
        last.close()
      })
      act(() => { vi.advanceTimersByTime(30_000) })
    }
    expect(useSessionStore.getState().reconnectExhausted).toBe(true)
  })

  it('resets the backoff once a session has stayed up after its connected frame', () => {
    renderHook(() => useWebSocket())
    for (let i = 0; i < 3; i++) {
      act(() => { MockWebSocket.instances.at(-1)!.close() })
      act(() => { vi.advanceTimersByTime(30_000) })
    }
    const socket = MockWebSocket.instances.at(-1)!
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-ok', reconnectToken: 'r', profileId: 'p' })
    })
    act(() => { vi.advanceTimersByTime(5000) })
    const count = MockWebSocket.instances.length
    act(() => { socket.close() })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(MockWebSocket.instances).toHaveLength(count + 1)
  })

  it('ignores the late close of a socket it already replaced (StrictMode double mount)', () => {
    renderHook(() => useWebSocket(), { wrapper: StrictMode })
    expect(MockWebSocket.instances).toHaveLength(2)
    const [stale, live] = MockWebSocket.instances
    // A browser delivers the first socket's close after the second one exists.
    act(() => { stale!.emit('close') })
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(live!.readyState).toBe(MockWebSocket.CONNECTING)
  })
})

// WEB-9: once the retry cap was hit, the fired reconnect timer's stale id made
// every later send think a reconnect was pending, so none ever happened and
// the message stayed "Sending..." forever.
describe('useWebSocket after the retry cap (WEB-9)', () => {
  beforeEach(() => {
    installTestEnvironment()
    vi.useFakeTimers()
  })

  afterEach(() => {
    restoreTestEnvironment()
    vi.useRealTimers()
  })

  it('reconnects when the user sends after the retries ran out, and delivers the message', () => {
    const { result } = renderHook(() => useWebSocket())
    for (let i = 0; i < 9; i++) {
      act(() => { MockWebSocket.instances.at(-1)!.close() })
      act(() => { vi.advanceTimersByTime(31_000) })
    }
    expect(useSessionStore.getState().reconnectExhausted).toBe(true)
    const before = MockWebSocket.instances.length

    act(() => { result.current.sendMessage('hello again') })
    expect(MockWebSocket.instances).toHaveLength(before + 1)
    expect(useSessionStore.getState().reconnectExhausted).toBe(false)

    const socket = MockWebSocket.instances.at(-1)!
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-9', reconnectToken: 'r', profileId: 'p' })
    })
    expect(socket.sent.map((s) => JSON.parse(s))).toContainEqual(expect.objectContaining({ type: 'message', text: 'hello again' }))
  })
})

// WEB-2: a stream_update may replace the stream's text (`text`) instead of
// appending to it (`delta`); every frame used to be appended.
describe('useWebSocket stream updates (WEB-2)', () => {
  beforeEach(installTestEnvironment)
  afterEach(restoreTestEnvironment)

  it('replaces the streamed text on a `text` update and appends on a `delta` one', () => {
    renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]!
    const streamText = () => useSessionStore.getState().messages.find((m) => m.streamId === 'st-1')?.text
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-st', reconnectToken: 'r', profileId: 'p' })
      socket.emit('message', { type: 'stream_start', streamId: 'st-1', text: '' })
      socket.emit('message', { type: 'stream_update', streamId: 'st-1', delta: 'Phase: working. Reading the files.' })
    })
    expect(streamText()).toBe('Phase: working. Reading the files.')

    act(() => { socket.emit('message', { type: 'stream_update', streamId: 'st-1', text: 'Phase: editing.' }) })
    expect(streamText()).toBe('Phase: editing.')

    act(() => { socket.emit('message', { type: 'stream_update', streamId: 'st-1', delta: ' Running tests.' }) })
    expect(streamText()).toBe('Phase: editing. Running tests.')
  })
})

// WEB-3: a frame over the server's maxPayload gets the socket closed (1009);
// the message was then counted as sent and silently became "Not delivered".
describe('useWebSocket oversized frames (WEB-3)', () => {
  beforeEach(installTestEnvironment)
  afterEach(restoreTestEnvironment)

  it('marks a message whose frame the server would refuse as failed instead of sending it', () => {
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]!
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-big', reconnectToken: 'r', profileId: 'p' })
    })
    const data = 'A'.repeat(26 * 1024 * 1024)
    act(() => {
      result.current.sendMessage('two photos', [{ name: 'a.png', type: 'image/png', data, size: 19 * 1024 * 1024 }])
    })
    expect(socket.sent.map((s) => JSON.parse(s).type)).not.toContain('message')
    expect(useSessionStore.getState().messages.at(-1)?.deliveryState).toBe('failed')
  })
})

// WEB-20: logout() closed the socket, but its close handler reconnected on its
// own with the identity still held in memory, and the server's answer wrote
// the logged-out profile token back into storage.
describe('useWebSocket logout (WEB-20)', () => {
  beforeEach(() => {
    installTestEnvironment()
    vi.useFakeTimers()
  })

  afterEach(() => {
    restoreTestEnvironment()
    vi.useRealTimers()
  })

  it('does not reconnect on its own, and a later connect presents no old identity', () => {
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]!
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-old', reconnectToken: 'r-old', profileId: 'p-old', profileToken: 'tok-old' })
    })

    act(() => { useSessionStore.getState().logout() })
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(localStorage.getItem('strada-profileToken')).toBeNull()

    act(() => { result.current.sendMessage('hello again') })
    const next = MockWebSocket.instances[1]!
    act(() => { next.emit('open') })
    const init = JSON.parse(next.sent[0]!)
    expect(init).toEqual(expect.objectContaining({ type: 'session_init' }))
    expect(init.profileId).toBeUndefined()
    expect(init.profileToken).toBeUndefined()
    expect(init.chatId).toBeUndefined()
  })
})

// WEB-16: with site data blocked even reading `window.localStorage` throws;
// the hook read it during render (taking the whole shell into the error
// boundary), and a throwing setItem in the connected handler left the
// session "connected" but mute.
describe('useWebSocket with blocked storage (WEB-16)', () => {
  beforeEach(installTestEnvironment)
  afterEach(() => {
    // Working storage again before teardown: other stores' resets read it.
    const storage = createStorageMock()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
    restoreTestEnvironment()
  })

  function blockStorage() {
    const blocked = { get: () => { throw new DOMException('The operation is insecure.', 'SecurityError') }, configurable: true }
    Object.defineProperty(globalThis, 'localStorage', blocked)
    Object.defineProperty(window, 'localStorage', blocked)
  }

  it('connects and delivers messages without storage', () => {
    blockStorage()
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]!
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-nostore', reconnectToken: 'r', profileId: 'p', profileToken: 't' })
    })
    act(() => { result.current.sendMessage('still works') })
    expect(socket.sent.map((s) => JSON.parse(s))).toContainEqual(expect.objectContaining({ type: 'message', text: 'still works' }))
  })

  it('stays usable when storage is full', () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError') },
      removeItem: () => {},
    }
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]!
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-full', reconnectToken: 'r', profileId: 'p' })
    })
    act(() => { result.current.sendMessage('quota') })
    expect(socket.sent.map((s) => JSON.parse(s))).toContainEqual(expect.objectContaining({ type: 'message', text: 'quota' }))
  })
})

// WEB-18: the server can hold several confirmations for one chat; each new
// frame replaced the dialog, and the replaced question could only time out.
describe('useWebSocket concurrent confirmations (WEB-18)', () => {
  beforeEach(installTestEnvironment)
  afterEach(restoreTestEnvironment)

  it('queues a second confirmation behind the first and shows it once the first is answered', () => {
    const { result } = renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]!
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-q', reconnectToken: 'r', profileId: 'p' })
      socket.emit('message', { type: 'confirmation', confirmId: 'bg-ask', question: 'Overwrite?', options: ['yes', 'no'] })
      socket.emit('message', { type: 'confirmation', confirmId: 'plan', question: 'Approve plan?', options: ['Approve', 'Reject'] })
    })
    expect(useSessionStore.getState().confirmation?.confirmId).toBe('bg-ask')

    act(() => { result.current.sendConfirmation('bg-ask', 'yes') })
    act(() => { socket.emit('message', { type: 'confirmation_ack', confirmId: 'bg-ask', status: 'accepted' }) })
    expect(useSessionStore.getState().confirmation?.confirmId).toBe('plan')

    act(() => { result.current.sendConfirmation('plan', 'Approve') })
    act(() => { socket.emit('message', { type: 'confirmation_ack', confirmId: 'plan', status: 'accepted' }) })
    expect(useSessionStore.getState().confirmation).toBeNull()
    const replies = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'confirmation_response')
    expect(replies.map((m) => m.confirmId)).toEqual(['bg-ask', 'plan'])
  })

  it('drops a queued confirmation the server settles before it is shown', () => {
    renderHook(() => useWebSocket())
    const socket = MockWebSocket.instances[0]!
    act(() => {
      socket.emit('open')
      socket.emit('message', { type: 'connected', chatId: 'chat-q2', reconnectToken: 'r', profileId: 'p' })
      socket.emit('message', { type: 'confirmation', confirmId: 'first', question: 'A?', options: ['yes'] })
      socket.emit('message', { type: 'confirmation', confirmId: 'second', question: 'B?', options: ['yes'] })
      socket.emit('message', { type: 'confirmation_ack', confirmId: 'second', status: 'unknown' })
      socket.emit('message', { type: 'confirmation_ack', confirmId: 'first', status: 'accepted' })
    })
    expect(useSessionStore.getState().confirmation).toBeNull()
  })
})

// WEB-14: `vite dev` proxies only /ws to the daemon, and the hook connected
// to `/`, so chat never connected under the dev server.
describe('useWebSocket chat socket URL (WEB-14)', () => {
  beforeEach(installTestEnvironment)
  afterEach(restoreTestEnvironment)

  it('opens the chat socket on the path the dev proxy forwards', () => {
    renderHook(() => useWebSocket())
    expect(MockWebSocket.instances[0]!.url).toBe(`ws://${window.location.host}/ws`)
  })
})
