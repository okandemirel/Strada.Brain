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
