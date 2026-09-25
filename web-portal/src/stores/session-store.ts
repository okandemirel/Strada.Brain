import { create } from 'zustand'
import type { ChatMessage, ConnectionStatus, ConfirmationState } from '../types/messages'
import { type SupportedLanguage, SUPPORTED_LANGUAGES } from '../i18n'

// Re-export types for convenience
export type { ChatMessage, ConnectionStatus, ConfirmationState }

/** localStorage keys managed by the web portal session layer. */
const AUTH_STORAGE_KEYS = [
  'strada-chatId',
  'strada-profileId',
  'strada-profileToken',
  'strada-reconnectToken',
  'strada-profileChatId', // legacy key
] as const

/** Callbacks registered by external subsystems (e.g. WebSocket) for logout cleanup. */
const logoutHooks: Array<() => void> = []

/**
 * Register a callback that will be invoked during logout().
 * Returns an unregister function.
 */
export function onLogout(hook: () => void): () => void {
  logoutHooks.push(hook)
  return () => {
    const idx = logoutHooks.indexOf(hook)
    if (idx >= 0) logoutHooks.splice(idx, 1)
  }
}

function getInitialLanguage(): SupportedLanguage {
  try {
    const stored = localStorage.getItem('strada-language')
    if (stored && SUPPORTED_LANGUAGES.includes(stored as SupportedLanguage)) {
      return stored as SupportedLanguage
    }
  } catch { /* SSR / test */ }
  return 'en'
}

export interface SessionState {
  messages: ChatMessage[]
  status: ConnectionStatus
  isTyping: boolean
  /** Timestamp when typing started — used for timeout display */
  typingStartedAt: number | null
  sessionId: string | null
  profileId: string | null
  language: SupportedLanguage
  confirmation: ConfirmationState | null
  reconnectExhausted: boolean
  /**
   * The server handed this chat to another socket holding the same reconnect
   * token (another tab). The client stays disconnected until the user asks to
   * use the chat here again (WEB-1).
   */
  sessionTaken: boolean
  viewingHistorical: boolean
  /**
   * The live conversation, set aside while a stored session is on screen
   * (viewingHistorical). Receipts and stream frames for the live chat keep
   * applying to it: they used to find nothing, so returning showed a stale
   * snapshot with a stream that never ended (WEB-11).
   */
  liveMessages: ChatMessage[] | null
}

export interface SessionActions {
  addMessage: (message: ChatMessage) => void
  setMessages: (messages: ChatMessage[]) => void
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void
  removeMessage: (id: string) => void
  setStatus: (status: ConnectionStatus) => void
  setSession: (sessionId: string, profileId: string) => void
  setLanguage: (language: SupportedLanguage) => void
  setTyping: (isTyping: boolean) => void
  setConfirmation: (confirmation: ConfirmationState | null) => void
  setReconnectExhausted: (exhausted: boolean) => void
  setSessionTaken: (taken: boolean) => void
  setViewingHistorical: (viewing: boolean) => void
  /** Show a stored session, keeping the live conversation aside in liveMessages. */
  showHistoricalMessages: (messages: ChatMessage[]) => void
  /**
   * Back to the live conversation, followed by the live messages that arrived
   * while the stored session was on screen.
   */
  returnToLiveMessages: () => void
  /** Clear isStreaming on the messages of streams that will get no more frames. */
  endStreams: (streamIds: ReadonlySet<string>) => void
  reset: () => void
  /**
   * Full session logout: clears auth-related localStorage keys,
   * resets all Zustand stores to their initial state, and
   * closes the active WebSocket connection.
   */
  logout: () => void
}

const initialState: SessionState = {
  messages: [],
  status: 'disconnected',
  isTyping: false,
  typingStartedAt: null,
  sessionId: null,
  profileId: null,
  language: getInitialLanguage(),
  confirmation: null,
  reconnectExhausted: false,
  sessionTaken: false,
  viewingHistorical: false,
  liveMessages: null,
}

/** Ids of the stored sessions' messages shown since leaving the live view. */
let historicalIds = new Set<string>()

function patchMessages(
  messages: ChatMessage[],
  id: string,
  updates: Partial<ChatMessage>,
): ChatMessage[] {
  return messages.some((m) => m.id === id)
    ? messages.map((m) => (m.id === id ? { ...m, ...updates } : m))
    : messages
}

export const useSessionStore = create<SessionState & SessionActions>()((set) => ({
  ...initialState,

  addMessage: (message) =>
    set((state) => {
      if (state.messages.some((m) => m.id === message.id)) {
        return state
      }
      return { messages: [...state.messages, message] }
    }),

  setMessages: (messages) => set({ messages: Array.isArray(messages) ? messages : [] }),

  updateMessage: (id, updates) =>
    set((state) => ({
      messages: patchMessages(state.messages, id, updates),
      liveMessages: state.liveMessages && patchMessages(state.liveMessages, id, updates),
    })),

  removeMessage: (id) =>
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== id),
      liveMessages: state.liveMessages && state.liveMessages.filter((m) => m.id !== id),
    })),

  setStatus: (status) => set({ status }),

  setSession: (sessionId, profileId) => set({ sessionId, profileId }),

  setLanguage: (language) => set({ language }),

  setTyping: (isTyping) => set({ isTyping, typingStartedAt: isTyping ? Date.now() : null }),

  setConfirmation: (confirmation) => set({ confirmation }),

  setReconnectExhausted: (reconnectExhausted) => set({ reconnectExhausted }),

  setSessionTaken: (sessionTaken) => set({ sessionTaken }),

  setViewingHistorical: (viewingHistorical) => set({ viewingHistorical }),

  showHistoricalMessages: (messages) =>
    set((state) => {
      if (!state.viewingHistorical) historicalIds = new Set()
      for (const m of messages) historicalIds.add(m.id)
      return {
        messages,
        liveMessages: state.viewingHistorical ? state.liveMessages : state.messages,
        viewingHistorical: true,
      }
    }),

  returnToLiveMessages: () =>
    set((state) => {
      if (!state.viewingHistorical) return state
      const live = state.liveMessages ?? []
      const liveIds = new Set(live.map((m) => m.id))
      const arrived = state.messages.filter((m) => !liveIds.has(m.id) && !historicalIds.has(m.id))
      historicalIds = new Set()
      return { messages: [...live, ...arrived], liveMessages: null, viewingHistorical: false }
    }),

  endStreams: (streamIds) =>
    set((state) => {
      const end = (messages: ChatMessage[]) =>
        messages.map((m) => (m.streamId && streamIds.has(m.streamId) ? { ...m, isStreaming: false } : m))
      return {
        messages: end(state.messages),
        liveMessages: state.liveMessages && end(state.liveMessages),
      }
    }),

  reset: () => {
    historicalIds = new Set()
    set(initialState)
  },

  logout: () => {
    // 1. Clear auth-related localStorage keys
    if (typeof window !== 'undefined') {
      for (const key of AUTH_STORAGE_KEYS) {
        try { localStorage.removeItem(key) } catch { /* privacy / SSR */ }
      }
    }

    // 2. Reset session store to initial state
    historicalIds = new Set()
    set(initialState)

    // 3. Invoke registered logout hooks (WebSocket disconnect, sibling store resets, etc.)
    for (const hook of logoutHooks) {
      try { hook() } catch { /* tolerate individual hook failures */ }
    }
  },
}))
