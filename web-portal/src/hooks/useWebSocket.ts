import { useCallback, useEffect, useRef } from 'react'
import type {
  Attachment,
  ChatMessage,
  ConfirmationState,
  ConnectionStatus,
  IncomingMessage,
} from '../types/messages'
import { useSessionStore, onLogout } from '../stores/session-store'
import { useCanvasStore } from '../stores/canvas-store'
import { mergeSessionMessages, readSessionMessages, writeSessionMessages } from './websocket-storage'
import { dispatchWorkspaceMessage, isWorkspaceMessage } from './use-dashboard-socket'

const MAX_RECONNECT_DELAY = 30000
const MAX_RECONNECT_ATTEMPTS = 8
const MESSAGE_RECEIPT_TIMEOUT_MS = 8000
const CHAT_ID_STORAGE_KEY = 'strada-chatId'
const PROFILE_ID_STORAGE_KEY = 'strada-profileId'
const PROFILE_TOKEN_STORAGE_KEY = 'strada-profileToken'
const LEGACY_PROFILE_CHAT_ID_STORAGE_KEY = 'strada-profileChatId'
const RECONNECT_TOKEN_STORAGE_KEY = 'strada-reconnectToken'
const SESSION_RECLAIM_GRACE_MS = 1500

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function readStoredChatId(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(CHAT_ID_STORAGE_KEY)
}

function readStoredProfileId(): string | null {
  if (typeof window === 'undefined') return null
  return (
    window.localStorage.getItem(PROFILE_ID_STORAGE_KEY) ??
    window.localStorage.getItem(LEGACY_PROFILE_CHAT_ID_STORAGE_KEY) ??
    readStoredChatId()
  )
}

function readStoredProfileToken(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(PROFILE_TOKEN_STORAGE_KEY)
}

function readStoredReconnectToken(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(RECONNECT_TOKEN_STORAGE_KEY)
}

export interface UseWebSocketReturn {
  messages: ChatMessage[]
  status: ConnectionStatus
  confirmation: ConfirmationState | null
  isTyping: boolean
  sessionId: string | null
  profileId: string | null
  sendMessage: (text: string, attachments?: Attachment[]) => boolean
  sendConfirmation: (confirmId: string, option: string) => void
  switchProvider: (provider: string, model?: string) => boolean
  toggleAutonomous: (enabled: boolean, hours?: number) => boolean
  sendRawJSON: (payload: Record<string, unknown>) => boolean
}

export function buildModelSwitchCommand(provider: string, model?: string): string {
  const safeProvider = provider.replace(/[^a-zA-Z0-9._-]/g, '')
  const safeModel = model?.replace(/[^a-zA-Z0-9._:/-]/g, '')
  return `/model ${safeProvider}${safeModel ? '/' + safeModel : ''}`
}

export function useWebSocket(): UseWebSocketReturn {
  // Read reactive state from Zustand store
  const messages = useSessionStore((s) => s.messages)
  const status = useSessionStore((s) => s.status)
  const confirmation = useSessionStore((s) => s.confirmation)
  const isTyping = useSessionStore((s) => s.isTyping)
  const sessionId = useSessionStore((s) => s.sessionId)
  const profileId = useSessionStore((s) => s.profileId)

  // Initialize store with restored session messages on first mount
  const initializedRef = useRef(false)
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true
    const storedProfileId = readStoredProfileId()
    const storedChatId = readStoredChatId()
    const restoredMessages = readSessionMessages(storedProfileId)
    if (restoredMessages.length > 0) {
      useSessionStore.getState().setMessages(restoredMessages)
    }
    useSessionStore.getState().setStatus('connecting')
    if (storedChatId) {
      useSessionStore.getState().setSession(
        storedChatId,
        storedProfileId ?? storedChatId,
      )
      useCanvasStore.getState().setSessionId(storedProfileId ?? storedChatId)
    }
  }, [])

  const wsRef = useRef<WebSocket | null>(null)
  const chatIdRef = useRef<string | null>(readStoredChatId())
  const profileIdRef = useRef<string | null>(readStoredProfileId())
  const profileTokenRef = useRef<string | null>(readStoredProfileToken())
  const reconnectDelayRef = useRef(1000)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingReconnectChatIdRef = useRef<string | null>(null)
  const pendingMessageTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const pendingOutboundMessagesRef = useRef<Array<{
    payload: Record<string, unknown>
    clientMessageId?: string
    expectedChatId?: string | null
  }>>([])
  const sessionReadyRef = useRef(false)
  const mountedRef = useRef(true)
  const connectRef = useRef<(() => void) | null>(null)

  // Use a ref for the streaming map so updates to it don't trigger re-renders
  // on their own -- we update `messages` state explicitly when streams change.
  const streamsRef = useRef<Map<string, string>>(new Map())

  const acceptConnectedSession = useCallback((
    chatId: string,
    reconnectToken: string,
    profileId?: string,
    profileToken?: string,
    language?: string,
  ) => {
    const previousChatId = chatIdRef.current
    const nextProfileId = profileId?.trim() || profileIdRef.current || previousChatId || chatId

    chatIdRef.current = chatId
    profileIdRef.current = nextProfileId
    profileTokenRef.current = profileToken?.trim() || profileTokenRef.current
    useSessionStore.getState().setSession(chatId, nextProfileId)
    if (language) {
      const validLangs = ['en', 'tr', 'ja', 'ko', 'zh', 'de', 'es', 'fr']
      if (validLangs.includes(language)) {
        useSessionStore.getState().setLanguage(language as 'en')
      }
    }
    useCanvasStore.getState().setSessionId(nextProfileId)
    localStorage.setItem(CHAT_ID_STORAGE_KEY, chatId)
    localStorage.setItem(PROFILE_ID_STORAGE_KEY, nextProfileId)
    localStorage.removeItem(LEGACY_PROFILE_CHAT_ID_STORAGE_KEY)
    if (profileTokenRef.current) {
      localStorage.setItem(PROFILE_TOKEN_STORAGE_KEY, profileTokenRef.current)
    }
    localStorage.setItem(RECONNECT_TOKEN_STORAGE_KEY, reconnectToken)

    if (previousChatId !== chatId) {
      const store = useSessionStore.getState()
      store.setMessages(mergeSessionMessages(readSessionMessages(nextProfileId), store.messages))
    }
  }, [])

  const clearPendingMessageTimer = useCallback((messageId: string) => {
    const timer = pendingMessageTimersRef.current.get(messageId)
    if (!timer) return
    clearTimeout(timer)
    pendingMessageTimersRef.current.delete(messageId)
  }, [])

  const markMessageFailed = useCallback((messageId: string) => {
    clearPendingMessageTimer(messageId)
    useSessionStore.getState().updateMessage(messageId, {
      deliveryState: 'failed',
    })
  }, [clearPendingMessageTimer])

  const armPendingMessageTimer = useCallback((messageId: string) => {
    clearPendingMessageTimer(messageId)
    pendingMessageTimersRef.current.set(messageId, setTimeout(() => {
      pendingMessageTimersRef.current.delete(messageId)
      useSessionStore.getState().updateMessage(messageId, {
        deliveryState: 'failed',
      })
    }, MESSAGE_RECEIPT_TIMEOUT_MS))
  }, [clearPendingMessageTimer])

  const markAllPendingMessagesFailed = useCallback(() => {
    const store = useSessionStore.getState()
    for (const message of store.messages) {
      if (message.sender === 'user' && message.deliveryState === 'pending') {
        markMessageFailed(message.id)
      }
    }
  }, [markMessageFailed])

  const deliverOutboundMessage = useCallback((entry: {
    payload: Record<string, unknown>
    clientMessageId?: string
    expectedChatId?: string | null
  }): 'sent' | 'defer' | 'failed' => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionReadyRef.current) {
      return 'defer'
    }

    try {
      ws.send(JSON.stringify(entry.payload))
      if (entry.clientMessageId) {
        armPendingMessageTimer(entry.clientMessageId)
      }
      return 'sent'
    } catch {
      if (entry.clientMessageId) {
        markMessageFailed(entry.clientMessageId)
      }
      return 'failed'
    }
  }, [armPendingMessageTimer, markMessageFailed])

  const flushPendingOutboundMessages = useCallback(() => {
    while (pendingOutboundMessagesRef.current.length > 0) {
      const next = pendingOutboundMessagesRef.current[0]
      if (
        next?.expectedChatId != null &&
        chatIdRef.current &&
        chatIdRef.current !== next.expectedChatId
      ) {
        pendingOutboundMessagesRef.current.shift()
        continue
      }
      const outcome = deliverOutboundMessage(next)
      if (outcome === 'defer') {
        return
      }
      pendingOutboundMessagesRef.current.shift()
    }
  }, [deliverOutboundMessage])

  const connect = useCallback(() => {
    if (!mountedRef.current) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}`)
    wsRef.current = ws
    sessionReadyRef.current = false

    ws.addEventListener('open', () => {
      if (!mountedRef.current) return
      useSessionStore.getState().setStatus('connected')
      reconnectDelayRef.current = 1000
      reconnectAttemptsRef.current = 0

      const savedChatId = readStoredChatId()
      const savedReconnectToken = readStoredReconnectToken()
      const savedProfileId = profileIdRef.current ?? savedChatId ?? undefined
      const savedProfileToken = profileTokenRef.current ?? undefined
      const legacyProfileChatId = !savedProfileToken
        ? localStorage.getItem(LEGACY_PROFILE_CHAT_ID_STORAGE_KEY) ?? undefined
        : undefined

      pendingReconnectChatIdRef.current = savedChatId
      ws.send(JSON.stringify({
        type: 'session_init',
        chatId: savedChatId ?? undefined,
        reconnectToken: savedReconnectToken ?? undefined,
        profileId: savedProfileId,
        profileToken: savedProfileToken,
        legacyProfileChatId,
      }))
    })

    ws.addEventListener('close', () => {
      if (!mountedRef.current) return
      sessionReadyRef.current = false
      useSessionStore.getState().setStatus('disconnected')

      // Fix 6.3: Reset typing indicator on disconnect
      useSessionStore.getState().setTyping(false)

      // Fix 6.2: Complete any orphaned streaming messages
      if (streamsRef.current.size > 0) {
        const orphanedStreamIds = new Set(streamsRef.current.keys())
        streamsRef.current.clear()
        const store = useSessionStore.getState()
        store.setMessages(
          store.messages.map((msg) =>
            msg.streamId && orphanedStreamIds.has(msg.streamId)
              ? { ...msg, isStreaming: false }
              : msg,
          ),
        )
      }

      // Fix 6.5: Cap reconnection attempts to avoid infinite loops
      reconnectAttemptsRef.current += 1
      if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
        markAllPendingMessagesFailed()
        return
      }

      // Auto-reconnect with exponential backoff
      reconnectTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return
        useSessionStore.getState().setStatus('reconnecting')
        connectRef.current?.()
      }, reconnectDelayRef.current)
      reconnectDelayRef.current = Math.min(
        reconnectDelayRef.current * 2,
        MAX_RECONNECT_DELAY,
      )
    })

    ws.addEventListener('message', (event) => {
      if (!mountedRef.current) return

      let parsed: { type: string; [key: string]: unknown }
      try {
        parsed = JSON.parse(event.data)
      } catch {
        return
      }

      // Route workspace/monitor messages to their dedicated stores
      if (isWorkspaceMessage(parsed.type)) {
        dispatchWorkspaceMessage(parsed)
        return
      }

      const data = parsed as unknown as IncomingMessage

      switch (data.type) {
        case 'connected': {
          if (
            pendingReconnectChatIdRef.current &&
            data.chatId !== pendingReconnectChatIdRef.current
          ) {
            if (pendingReconnectTimerRef.current) {
              clearTimeout(pendingReconnectTimerRef.current)
            }

            pendingReconnectTimerRef.current = setTimeout(() => {
              pendingReconnectTimerRef.current = null
              pendingReconnectChatIdRef.current = null
              acceptConnectedSession(data.chatId, data.reconnectToken, data.profileId, data.profileToken, data.language)
              sessionReadyRef.current = true
              flushPendingOutboundMessages()
            }, SESSION_RECLAIM_GRACE_MS)
            break
          }

          if (pendingReconnectTimerRef.current) {
            clearTimeout(pendingReconnectTimerRef.current)
            pendingReconnectTimerRef.current = null
          }

          pendingReconnectChatIdRef.current = null
          acceptConnectedSession(data.chatId, data.reconnectToken, data.profileId, data.profileToken, data.language)
          sessionReadyRef.current = true
          flushPendingOutboundMessages()
          break
        }

        case 'message_received': {
          clearPendingMessageTimer(data.clientMessageId)
          useSessionStore.getState().updateMessage(data.clientMessageId, {
            deliveryState: undefined,
          })
          break
        }

        case 'text':
        case 'markdown': {
          const store = useSessionStore.getState()
          store.setTyping(false)
          const instinctIds = Array.isArray(data.instinctIds)
            ? (data.instinctIds as unknown[]).filter((id): id is string => typeof id === 'string')
            : undefined
          store.addMessage({
            id: data.messageId || generateId(),
            sender: 'assistant',
            text: data.text,
            isMarkdown: data.type === 'markdown',
            timestamp: Date.now(),
            ...(instinctIds && instinctIds.length > 0 ? { instinctIds } : {}),
          })
          break
        }

        case 'typing':
          useSessionStore.getState().setTyping(data.active)
          break

        case 'stream_start':
          useSessionStore.getState().setTyping(false)
          streamsRef.current.set(data.streamId, data.text || '')
          useSessionStore.getState().addMessage({
            id: generateId(),
            sender: 'assistant',
            text: data.text || '',
            isMarkdown: true,
            isStreaming: true,
            streamId: data.streamId,
            timestamp: Date.now(),
          })
          break

        case 'stream_update': {
          streamsRef.current.set(data.streamId, data.text)
          const store = useSessionStore.getState()
          const streamMsg = store.messages.find((m) => m.streamId === data.streamId)
          if (streamMsg) {
            store.updateMessage(streamMsg.id, { text: data.text })
          }
          break
        }

        case 'stream_end': {
          streamsRef.current.delete(data.streamId)
          const store = useSessionStore.getState()
          const streamMsg = store.messages.find((m) => m.streamId === data.streamId)
          if (streamMsg) {
            if (data.text) {
              const streamEndInstinctIds = Array.isArray(data.instinctIds)
                ? (data.instinctIds as unknown[]).filter((id): id is string => typeof id === 'string')
                : undefined
              store.updateMessage(streamMsg.id, {
                text: data.text,
                isStreaming: false,
                ...(streamEndInstinctIds && streamEndInstinctIds.length > 0 ? { instinctIds: streamEndInstinctIds } : {}),
              })
            } else {
              store.removeMessage(streamMsg.id)
            }
          }
          break
        }

        case 'confirmation':
          useSessionStore.getState().setConfirmation({
            confirmId: data.confirmId,
            question: data.question,
            options: data.options,
            details: data.details,
          })
          break
      }
    })
  }, [
    acceptConnectedSession,
    clearPendingMessageTimer,
    flushPendingOutboundMessages,
    markAllPendingMessagesFailed,
  ])

  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  const writeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    clearTimeout(writeTimeoutRef.current)
    writeTimeoutRef.current = setTimeout(() => {
      writeSessionMessages(profileIdRef.current ?? chatIdRef.current, messages)
    }, 1000)
  }, [messages])

  useEffect(() => {
    mountedRef.current = true
    connectRef.current?.()

    // Register a logout hook so logout() can close the WebSocket
    const unregisterLogout = onLogout(() => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (pendingReconnectTimerRef.current) {
        clearTimeout(pendingReconnectTimerRef.current)
        pendingReconnectTimerRef.current = null
      }
      for (const timer of pendingMessageTimersRef.current.values()) {
        clearTimeout(timer)
      }
      pendingMessageTimersRef.current.clear()
      pendingOutboundMessagesRef.current = []
      sessionReadyRef.current = false
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    })

    return () => {
      unregisterLogout()
      mountedRef.current = false
      clearTimeout(writeTimeoutRef.current)
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
      if (pendingReconnectTimerRef.current) {
        clearTimeout(pendingReconnectTimerRef.current)
      }
      for (const timer of pendingMessageTimersRef.current.values()) {
        clearTimeout(timer)
      }
      pendingMessageTimersRef.current.clear()
      pendingOutboundMessagesRef.current = []
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [connect])

  const enqueueOrReconnect = useCallback((outbound: {
    payload: Record<string, unknown>
    clientMessageId?: string
    expectedChatId?: string | null
  }): boolean => {
    const delivery = deliverOutboundMessage(outbound)
    if (delivery === 'sent') return true

    if (delivery === 'defer') {
      pendingOutboundMessagesRef.current.push(outbound)
      const ws = wsRef.current
      if (
        mountedRef.current &&
        (!ws || ws.readyState === WebSocket.CLOSED) &&
        !reconnectTimerRef.current
      ) {
        useSessionStore.getState().setStatus('reconnecting')
        connectRef.current?.()
      }
      return true
    }

    return false
  }, [deliverOutboundMessage])

  const sendMessage = useCallback((text: string, attachments?: Attachment[]): boolean => {
    const clientMessageId = generateId()

    // Add user message to display
    useSessionStore.getState().addMessage({
      id: clientMessageId,
      sender: 'user',
      text,
      isMarkdown: false,
      timestamp: Date.now(),
      attachments,
      deliveryState: 'pending',
    })

    const payload: Record<string, unknown> = {
      type: 'message',
      text,
      clientMessageId,
    }
    if (attachments && attachments.length > 0) {
      payload.attachments = attachments
    }

    return enqueueOrReconnect({ payload, clientMessageId })
  }, [enqueueOrReconnect])

  const sendConfirmation = useCallback((confirmId: string, option: string) => {
    try {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ type: 'confirmation_response', confirmId, option }))
    } catch {
      // Connection closed between check and send -- silently fail
    } finally {
      useSessionStore.getState().setConfirmation(null)
    }
  }, [])

  const switchProvider = useCallback((provider: string, model?: string): boolean => {
    return sendMessage(buildModelSwitchCommand(provider, model))
  }, [sendMessage])

  const toggleAutonomous = useCallback((enabled: boolean, hours?: number): boolean => {
    const text = `/autonomous ${enabled ? 'on' : 'off'}${hours ? ' ' + hours : ''}`
    return sendMessage(text)
  }, [sendMessage])

  const sendRawJSON = useCallback((payload: Record<string, unknown>): boolean => {
    return enqueueOrReconnect({
      payload,
      expectedChatId: chatIdRef.current,
    })
  }, [enqueueOrReconnect])

  return {
    messages,
    status,
    confirmation,
    isTyping,
    sessionId,
    profileId,
    sendMessage,
    sendConfirmation,
    switchProvider,
    toggleAutonomous,
    sendRawJSON,
  }
}
