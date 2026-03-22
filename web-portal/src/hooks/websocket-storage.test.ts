import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types/messages'
import { mergeSessionMessages, readSessionMessages, writeSessionMessages } from './websocket-storage'

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))

  return {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
  }
}

describe('websocket session storage', () => {
  it('round-trips sanitized chat messages for a session', () => {
    const storage = createStorage()
    const messages: ChatMessage[] = [
      {
        id: 'm1',
        sender: 'user',
        text: 'hello',
        isMarkdown: false,
        attachments: [{ name: 'secret.png', type: 'image/png', data: 'abc', size: 3 }],
        timestamp: 1,
      },
      {
        id: 'm2',
        sender: 'assistant',
        text: 'hi',
        isMarkdown: true,
        isStreaming: true,
        timestamp: 2,
      },
    ]

    writeSessionMessages('chat-1', messages, storage)

    expect(readSessionMessages('chat-1', storage)).toEqual([
      {
        id: 'm1',
        sender: 'user',
        text: 'hello',
        isMarkdown: false,
        isStreaming: false,
        timestamp: 1,
      },
      {
        id: 'm2',
        sender: 'assistant',
        text: 'hi',
        isMarkdown: true,
        isStreaming: false,
        timestamp: 2,
      },
    ])
  })

  it('returns an empty array for malformed stored data', () => {
    const storage = createStorage({
      'strada-session-messages:chat-1': '{"bad":true}',
    })

    expect(readSessionMessages('chat-1', storage)).toEqual([])
  })

  it('handles rapid sequential writes preserving order', () => {
    const storage = createStorage()
    const messages: ChatMessage[] = []
    for (let i = 0; i < 10; i++) {
      messages.push({
        id: `m${i}`,
        sender: i % 2 === 0 ? 'user' : 'assistant',
        text: `message ${i}`,
        isMarkdown: false,
        timestamp: i * 100,
      })
    }

    writeSessionMessages('chat-rapid', messages, storage)
    const result = readSessionMessages('chat-rapid', storage)

    expect(result).toHaveLength(10)
    // Verify order is preserved
    for (let i = 0; i < result.length; i++) {
      expect(result[i].id).toBe(`m${i}`)
      expect(result[i].text).toBe(`message ${i}`)
    }
  })

  it('preserves message order after merge', () => {
    const stored: ChatMessage[] = [
      { id: 'm1', sender: 'user', text: 'first', isMarkdown: false, timestamp: 100 },
      { id: 'm3', sender: 'user', text: 'third', isMarkdown: false, timestamp: 300 },
    ]
    const current: ChatMessage[] = [
      { id: 'm2', sender: 'assistant', text: 'second', isMarkdown: true, timestamp: 200 },
    ]

    const merged = mergeSessionMessages(stored, current, 5200)
    expect(merged).toHaveLength(3)
    expect(merged[0].id).toBe('m1')
    expect(merged[1].id).toBe('m2')
    expect(merged[2].id).toBe('m3')
  })

  it('preserves very recent assistant messages while switching session identities', () => {
    const stored: ChatMessage[] = [
      {
        id: 'm1',
        sender: 'user',
        text: 'hello',
        isMarkdown: false,
        timestamp: 100,
      },
    ]
    const current: ChatMessage[] = [
      {
        id: 'bootstrap-1',
        sender: 'assistant',
        text: 'Welcome to Strada',
        isMarkdown: true,
        timestamp: 4_900,
      },
      {
        id: 'old-assistant',
        sender: 'assistant',
        text: 'stale',
        isMarkdown: true,
        timestamp: 1,
      },
    ]

    expect(mergeSessionMessages(stored, current, 6_000)).toEqual([
      {
        id: 'm1',
        sender: 'user',
        text: 'hello',
        isMarkdown: false,
        timestamp: 100,
      },
      {
        id: 'bootstrap-1',
        sender: 'assistant',
        text: 'Welcome to Strada',
        isMarkdown: true,
        isStreaming: false,
        timestamp: 4_900,
      },
    ])
  })
})
