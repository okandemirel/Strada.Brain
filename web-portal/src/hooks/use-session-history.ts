import { useMemo, useSyncExternalStore } from 'react'
import { readSessionMessages } from './websocket-storage'

const SESSION_KEY_PREFIX = 'strada-session-messages:'

export interface SessionHistoryEntry {
  /** The chatId / profileId used as the localStorage key suffix. */
  sessionKey: string
  messageCount: number
  lastMessage: string
  lastTimestamp: number
}

/**
 * Revision counter that increments whenever we know localStorage has changed.
 * Subscribed via useSyncExternalStore so the hook re-renders reactively.
 */
let revision = 0
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getSnapshot(): number {
  return revision
}

/** Call this after writing to session storage to trigger a re-scan. */
export function notifySessionHistoryChanged(): void {
  revision++
  for (const cb of listeners) cb()
}

// Listen for cross-tab storage events so the list stays fresh.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key?.startsWith(SESSION_KEY_PREFIX) || e.key === null) {
      notifySessionHistoryChanged()
    }
  })
}

export function useSessionHistory(): SessionHistoryEntry[] {
  const rev = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return useMemo(() => {
    if (typeof window === 'undefined') return []
    const entries: SessionHistoryEntry[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(SESSION_KEY_PREFIX)) continue
      const sessionKey = key.slice(SESSION_KEY_PREFIX.length)
      try {
        const messages = readSessionMessages(sessionKey)
        if (messages.length === 0) continue
        const last = messages[messages.length - 1]
        entries.push({
          sessionKey,
          messageCount: messages.length,
          lastMessage: last.text?.slice(0, 80) ?? '',
          lastTimestamp: last.timestamp ?? 0,
        })
      } catch { continue }
    }
    return entries.sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev])
}
