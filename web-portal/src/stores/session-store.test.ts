import { describe, expect, it, beforeEach } from 'vitest'
import { useSessionStore } from './session-store'
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
