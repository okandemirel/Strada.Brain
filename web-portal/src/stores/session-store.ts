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
  sessionId: string | null
  profileId: string | null
  language: SupportedLanguage
  confirmation: ConfirmationState | null
  reconnectExhausted: boolean
  viewingHistorical: boolean
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
  setViewingHistorical: (viewing: boolean) => void
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
  sessionId: null,
  profileId: null,
  language: getInitialLanguage(),
  confirmation: null,
  reconnectExhausted: false,
  viewingHistorical: false,
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

  setMessages: (messages) => set({ messages }),

  updateMessage: (id, updates) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, ...updates } : m,
      ),
    })),

  removeMessage: (id) =>
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== id),
    })),

  setStatus: (status) => set({ status }),

  setSession: (sessionId, profileId) => set({ sessionId, profileId }),

  setLanguage: (language) => set({ language }),

  setTyping: (isTyping) => set({ isTyping }),

  setConfirmation: (confirmation) => set({ confirmation }),

  setReconnectExhausted: (reconnectExhausted) => set({ reconnectExhausted }),

  setViewingHistorical: (viewingHistorical) => set({ viewingHistorical }),

  reset: () => set(initialState),

  logout: () => {
    // 1. Clear auth-related localStorage keys
    if (typeof window !== 'undefined') {
      for (const key of AUTH_STORAGE_KEYS) {
        try { localStorage.removeItem(key) } catch { /* privacy / SSR */ }
      }
    }

    // 2. Reset session store to initial state
    set(initialState)

    // 3. Invoke registered logout hooks (WebSocket disconnect, sibling store resets, etc.)
    for (const hook of logoutHooks) {
      try { hook() } catch { /* tolerate individual hook failures */ }
    }
  },
}))
