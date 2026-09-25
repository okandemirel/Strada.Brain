import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { MAX_IN_MEMORY_MESSAGES, useSessionStore } from './session-store'
import type { ChatMessage, ConfirmationState } from '../types/messages'

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? '1',
    sender: overrides.sender ?? 'user',
    text: overrides.text ?? 'hello',
    isMarkdown: overrides.isMarkdown ?? false,
    timestamp: overrides.timestamp ?? 1,
    ...overrides,
  }
}

describe('useSessionStore', () => {
  beforeEach(() => {
    useSessionStore.getState().reset()
  })

  it('starts with empty messages', () => {
    const { messages } = useSessionStore.getState()
    expect(messages).toEqual([])
  })

  it('adds a message', () => {
    const msg = makeMessage({ id: '1', sender: 'user', text: 'hello' })
    useSessionStore.getState().addMessage(msg)
    const { messages } = useSessionStore.getState()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual(msg)
  })

  it('updates a streaming message', () => {
    const msg = makeMessage({
      id: 'stream-1',
      sender: 'assistant',
      text: 'partial',
      isStreaming: true,
      streamId: 's1',
    })
    useSessionStore.getState().addMessage(msg)
    useSessionStore.getState().updateMessage('stream-1', { text: 'complete', isStreaming: false })

    const { messages } = useSessionStore.getState()
    expect(messages[0].text).toBe('complete')
    expect(messages[0].isStreaming).toBe(false)
  })

  it('removes a message by id', () => {
    useSessionStore.getState().addMessage(makeMessage({ id: 'a' }))
    useSessionStore.getState().addMessage(makeMessage({ id: 'b' }))
    useSessionStore.getState().removeMessage('a')

    const { messages } = useSessionStore.getState()
    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe('b')
  })

  it('sets connection status including reconnecting', () => {
    expect(useSessionStore.getState().status).toBe('disconnected')

    useSessionStore.getState().setStatus('connected')
    expect(useSessionStore.getState().status).toBe('connected')

    useSessionStore.getState().setStatus('reconnecting')
    expect(useSessionStore.getState().status).toBe('reconnecting')

    useSessionStore.getState().setStatus('connecting')
    expect(useSessionStore.getState().status).toBe('connecting')

    useSessionStore.getState().setStatus('disconnected')
    expect(useSessionStore.getState().status).toBe('disconnected')
  })

  it('sets session identity (sessionId, profileId)', () => {
    useSessionStore.getState().setSession('sess-1', 'prof-1')
    const state = useSessionStore.getState()
    expect(state.sessionId).toBe('sess-1')
    expect(state.profileId).toBe('prof-1')
  })

  it('sets and clears typing indicator', () => {
    expect(useSessionStore.getState().isTyping).toBe(false)

    useSessionStore.getState().setTyping(true)
    expect(useSessionStore.getState().isTyping).toBe(true)

    useSessionStore.getState().setTyping(false)
    expect(useSessionStore.getState().isTyping).toBe(false)
  })

  it('sets and clears confirmation using confirmId field', () => {
    const conf: ConfirmationState = {
      confirmId: 'c-1',
      question: 'Are you sure?',
      options: ['Yes', 'No'],
      details: 'This is permanent',
    }

    useSessionStore.getState().setConfirmation(conf)
    expect(useSessionStore.getState().confirmation).toEqual(conf)
    expect(useSessionStore.getState().confirmation!.confirmId).toBe('c-1')

    useSessionStore.getState().setConfirmation(null)
    expect(useSessionStore.getState().confirmation).toBeNull()
  })

  it('does not add duplicate message ids', () => {
    const msg = makeMessage({ id: 'dup-1' })
    useSessionStore.getState().addMessage(msg)
    useSessionStore.getState().addMessage(msg)

    expect(useSessionStore.getState().messages).toHaveLength(1)
  })

  it('sets messages in bulk for session restore', () => {
    const msgs = [
      makeMessage({ id: 'r1', text: 'restored 1' }),
      makeMessage({ id: 'r2', text: 'restored 2' }),
    ]

    useSessionStore.getState().setMessages(msgs)
    expect(useSessionStore.getState().messages).toEqual(msgs)
    expect(useSessionStore.getState().messages).toHaveLength(2)
  })

  it('reset clears all state back to disconnected', () => {
    // Populate state
    useSessionStore.getState().addMessage(makeMessage({ id: 'x' }))
    useSessionStore.getState().setStatus('connected')
    useSessionStore.getState().setTyping(true)
    useSessionStore.getState().setSession('s1', 'p1')
    useSessionStore.getState().setConfirmation({
      confirmId: 'c1',
      question: 'q',
      options: ['a'],
    })

    // Reset
    useSessionStore.getState().reset()

    const state = useSessionStore.getState()
    expect(state.messages).toEqual([])
    expect(state.status).toBe('disconnected')
    expect(state.isTyping).toBe(false)
    expect(state.sessionId).toBeNull()
    expect(state.profileId).toBeNull()
    expect(state.confirmation).toBeNull()
  })
})

// WEB-19: memory kept every message a long-lived tab ever saw, each one a
// thumbnail's worth of bytes or more.
describe('useSessionStore in-memory history bound', () => {
  const originalRevoke = URL.revokeObjectURL
  const revoked: string[] = []

  beforeEach(() => {
    useSessionStore.getState().reset()
    revoked.length = 0
    Object.defineProperty(URL, 'revokeObjectURL', { value: (url: string) => { revoked.push(url) }, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(URL, 'revokeObjectURL', { value: originalRevoke, configurable: true })
  })

  it('keeps only the newest messages', () => {
    for (let i = 0; i < MAX_IN_MEMORY_MESSAGES + 20; i++) {
      useSessionStore.getState().addMessage(makeMessage({ id: `m${i}` }))
    }
    const { messages } = useSessionStore.getState()
    expect(MAX_IN_MEMORY_MESSAGES).toBeGreaterThan(100) // more than storage keeps
    expect(messages).toHaveLength(MAX_IN_MEMORY_MESSAGES)
    expect(messages[0]!.id).toBe('m20')
    expect(messages.at(-1)!.id).toBe(`m${MAX_IN_MEMORY_MESSAGES + 19}`)
  })

  it('bounds a bulk restore the same way', () => {
    const many = Array.from({ length: MAX_IN_MEMORY_MESSAGES + 5 }, (_, i) => makeMessage({ id: `r${i}` }))
    useSessionStore.getState().setMessages(many)
    expect(useSessionStore.getState().messages).toHaveLength(MAX_IN_MEMORY_MESSAGES)
    expect(useSessionStore.getState().messages[0]!.id).toBe('r5')
  })

  it('still updates the right message after older ones were dropped', () => {
    for (let i = 0; i < MAX_IN_MEMORY_MESSAGES + 3; i++) {
      useSessionStore.getState().addMessage(makeMessage({ id: `m${i}`, text: 'before' }))
    }
    useSessionStore.getState().updateMessage('m10', { text: 'after' })
    const { messages } = useSessionStore.getState()
    expect(messages.find((m) => m.id === 'm10')!.text).toBe('after')
    expect(messages.filter((m) => m.text === 'after')).toHaveLength(1)
  })

  it('frees the thumbnail of a message that leaves memory, and only then', () => {
    const photo = { name: 'a.png', type: 'image/png', size: 3, previewUrl: 'blob:thumb-1' }
    useSessionStore.getState().addMessage(makeMessage({ id: 'with-photo', attachments: [photo] }))
    useSessionStore.getState().updateMessage('with-photo', { deliveryState: undefined })
    for (let i = 0; i < MAX_IN_MEMORY_MESSAGES - 1; i++) {
      useSessionStore.getState().addMessage(makeMessage({ id: `m${i}` }))
    }
    expect(revoked).toEqual([])

    useSessionStore.getState().addMessage(makeMessage({ id: 'one-too-many' }))
    expect(revoked).toEqual(['blob:thumb-1'])
  })

  it('keeps a thumbnail while its message is set aside for a stored session', () => {
    const photo = { name: 'a.png', type: 'image/png', size: 3, previewUrl: 'blob:thumb-2' }
    useSessionStore.getState().addMessage(makeMessage({ id: 'with-photo', attachments: [photo] }))
    useSessionStore.getState().showHistoricalMessages([makeMessage({ id: 'old' })])
    useSessionStore.getState().returnToLiveMessages()
    expect(revoked).toEqual([])

    useSessionStore.getState().reset()
    expect(revoked).toEqual(['blob:thumb-2'])
  })
})
