import type { ChatMessage } from '../types/messages'

const SESSION_MESSAGE_STORAGE_PREFIX = 'strada-session-messages:'
const MAX_STORED_MESSAGES = 100
const TRANSIENT_SESSION_MESSAGE_WINDOW_MS = 5000

type StorageReader = Pick<Storage, 'getItem'>
type StorageWriter = Pick<Storage, 'setItem'>

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  return window.localStorage
}

export function clearSessionMessages(chatId: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(getStorageKey(chatId))
  } catch {
    // Ignore privacy-mode or quota failures.
  }
}

function getStorageKey(chatId: string): string {
  return `${SESSION_MESSAGE_STORAGE_PREFIX}${chatId}`
}

function isValidSender(sender: unknown): sender is ChatMessage['sender'] {
  return sender === 'user' || sender === 'assistant'
}

function normalizeStoredMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null

  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string') return null
  if (!isValidSender(candidate.sender)) return null
  if (typeof candidate.text !== 'string') return null
  if (typeof candidate.timestamp !== 'number' || !Number.isFinite(candidate.timestamp)) return null

  return {
    id: candidate.id,
    sender: candidate.sender,
    text: candidate.text,
    isMarkdown: Boolean(candidate.isMarkdown),
    isStreaming: false,
    timestamp: candidate.timestamp,
  }
}

export function readSessionMessages(
  chatId: string | null,
  storage: StorageReader | null = getSessionStorage(),
): ChatMessage[] {
  if (!chatId || !storage) return []

  const raw = storage.getItem(getStorageKey(chatId))
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => normalizeStoredMessage(entry))
      .filter((entry): entry is ChatMessage => entry !== null)
      .slice(-MAX_STORED_MESSAGES)
  } catch {
    return []
  }
}

export function writeSessionMessages(
  chatId: string | null,
  messages: ChatMessage[],
  storage: StorageWriter | null = getSessionStorage(),
): void {
  if (!chatId || !storage) return

  const sanitized = messages
    .slice(-MAX_STORED_MESSAGES)
    .map((message) => ({
      id: message.id,
      sender: message.sender,
      text: message.text,
      isMarkdown: message.isMarkdown,
      timestamp: message.timestamp,
    }))

  try {
    storage.setItem(getStorageKey(chatId), JSON.stringify(sanitized))
  } catch {
    // Ignore storage quota or privacy-mode failures.
  }
}

export function mergeSessionMessages(
  storedMessages: ChatMessage[],
  currentMessages: ChatMessage[],
  nowMs: number = Date.now(),
): ChatMessage[] {
  const cutoff = nowMs - TRANSIENT_SESSION_MESSAGE_WINDOW_MS
  const merged = [...storedMessages]

  for (const message of currentMessages) {
    if (message.sender !== 'assistant' || message.timestamp < cutoff) {
      continue
    }

    const alreadyPresent = merged.some((entry) =>
      entry.id === message.id
      || (
        entry.sender === message.sender
        && entry.text === message.text
        && Math.abs(entry.timestamp - message.timestamp) < 1000
      ),
    )

    if (!alreadyPresent) {
      merged.push({
        ...message,
        isStreaming: false,
      })
    }
  }

  return merged
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-MAX_STORED_MESSAGES)
}
