import { create } from 'zustand'
import type { ChatMessage, ConnectionStatus, ConfirmationState } from '../types/messages'

// Re-export types for convenience
export type { ChatMessage, ConnectionStatus, ConfirmationState }

export interface SessionState {
  messages: ChatMessage[]
  status: ConnectionStatus
  isTyping: boolean
  sessionId: string | null
  profileId: string | null
  confirmation: ConfirmationState | null
}

export interface SessionActions {
  addMessage: (message: ChatMessage) => void
  setMessages: (messages: ChatMessage[]) => void
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void
  removeMessage: (id: string) => void
  setStatus: (status: ConnectionStatus) => void
  setSession: (sessionId: string, profileId: string) => void
  setTyping: (isTyping: boolean) => void
  setConfirmation: (confirmation: ConfirmationState | null) => void
  reset: () => void
}

const initialState: SessionState = {
  messages: [],
  status: 'disconnected',
  isTyping: false,
  sessionId: null,
  profileId: null,
  confirmation: null,
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

  setTyping: (isTyping) => set({ isTyping }),

  setConfirmation: (confirmation) => set({ confirmation }),

  reset: () => set(initialState),
}))
