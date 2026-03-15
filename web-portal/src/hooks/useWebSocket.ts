import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Attachment,
  ChatMessage,
  ConfirmationState,
  ConnectionStatus,
  IncomingMessage,
} from '../types/messages'

const MAX_RECONNECT_DELAY = 30000
const MAX_RECONNECT_ATTEMPTS = 8

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export interface UseWebSocketReturn {
  messages: ChatMessage[]
  status: ConnectionStatus
  confirmation: ConfirmationState | null
  isTyping: boolean
  sessionId: string | null
  sendMessage: (text: string, attachments?: Attachment[]) => boolean
  sendConfirmation: (confirmId: string, option: string) => void
  switchProvider: (provider: string, model?: string) => boolean
  toggleAutonomous: (enabled: boolean, hours?: number) => boolean
}

export function useWebSocket(): UseWebSocketReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null)
  const [isTyping, setIsTyping] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(localStorage.getItem('strada-chatId'))

  const wsRef = useRef<WebSocket | null>(null)
  const chatIdRef = useRef<string | null>(localStorage.getItem('strada-chatId'))
  const reconnectDelayRef = useRef(1000)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  // Use a ref for the streaming map so updates to it don't trigger re-renders
  // on their own -- we update `messages` state explicitly when streams change.
  const streamsRef = useRef<Map<string, string>>(new Map())

  const connect = useCallback(() => {
    if (!mountedRef.current) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}`)
    wsRef.current = ws

    ws.addEventListener('open', () => {
      if (!mountedRef.current) return
      setStatus('connected')
      reconnectDelayRef.current = 1000
      reconnectAttemptsRef.current = 0

      // Attempt reconnect with previous session (skip on first-run to get fresh chatId)
      if (localStorage.getItem('strada-firstRun') !== '1') {
        const savedChatId = localStorage.getItem('strada-chatId')
        if (savedChatId) {
          ws.send(JSON.stringify({ type: 'reconnect', chatId: savedChatId }))
        }
      }
    })

    ws.addEventListener('close', () => {
      if (!mountedRef.current) return
      setStatus('disconnected')

      // Fix 6.3: Reset typing indicator on disconnect
      setIsTyping(false)

      // Fix 6.2: Complete any orphaned streaming messages
      if (streamsRef.current.size > 0) {
        const orphanedStreamIds = new Set(streamsRef.current.keys())
        streamsRef.current.clear()
        setMessages((prev) =>
          prev.map((msg) =>
            msg.streamId && orphanedStreamIds.has(msg.streamId)
              ? { ...msg, isStreaming: false }
              : msg,
          ),
        )
      }

      // Fix 6.5: Cap reconnection attempts to avoid infinite loops
      reconnectAttemptsRef.current += 1
      if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
        return
      }

      // Auto-reconnect with exponential backoff
      reconnectTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return
        setStatus('reconnecting')
        connect()
      }, reconnectDelayRef.current)
      reconnectDelayRef.current = Math.min(
        reconnectDelayRef.current * 2,
        MAX_RECONNECT_DELAY,
      )
    })

    ws.addEventListener('message', (event) => {
      if (!mountedRef.current) return

      let data: IncomingMessage
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }

      switch (data.type) {
        case 'connected':
          chatIdRef.current = data.chatId
          setSessionId(data.chatId)
          localStorage.setItem('strada-chatId', data.chatId)
          // First-run: send sentinel to trigger deterministic onboarding (no user bubble)
          if (localStorage.getItem('strada-firstRun') === '1') {
            localStorage.removeItem('strada-firstRun')
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'message', text: '__onboarding__' }))
              }
            }, 500)
          }
          break

        case 'text':
        case 'markdown':
          setIsTyping(false)
          setMessages((prev) => [
            ...prev,
            {
              id: data.messageId || generateId(),
              sender: 'assistant',
              text: data.text,
              isMarkdown: data.type === 'markdown',
              timestamp: Date.now(),
            },
          ])
          break

        case 'typing':
          setIsTyping(data.active)
          break

        case 'stream_start':
          setIsTyping(false)
          streamsRef.current.set(data.streamId, data.text || '')
          setMessages((prev) => [
            ...prev,
            {
              id: generateId(),
              sender: 'assistant',
              text: data.text || '',
              isMarkdown: true,
              isStreaming: true,
              streamId: data.streamId,
              timestamp: Date.now(),
            },
          ])
          break

        case 'stream_update':
          streamsRef.current.set(data.streamId, data.text)
          setMessages((prev) =>
            prev.map((msg) =>
              msg.streamId === data.streamId
                ? { ...msg, text: data.text }
                : msg,
            ),
          )
          break

        case 'stream_end':
          streamsRef.current.delete(data.streamId)
          setMessages((prev) =>
            prev.map((msg) =>
              msg.streamId === data.streamId
                ? { ...msg, text: data.text, isStreaming: false }
                : msg,
            ),
          )
          break

        case 'confirmation':
          setConfirmation({
            confirmId: data.confirmId,
            question: data.question,
            options: data.options,
            details: data.details,
          })
          break
      }
    })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    connect()

    return () => {
      mountedRef.current = false
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [connect])

  const sendMessage = useCallback((text: string, attachments?: Attachment[]): boolean => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false

    // Add user message to display
    setMessages((prev) => [
      ...prev,
      {
        id: generateId(),
        sender: 'user',
        text,
        isMarkdown: false,
        timestamp: Date.now(),
        attachments,
      },
    ])

    const payload: Record<string, unknown> = { type: 'message', text }
    if (attachments && attachments.length > 0) {
      payload.attachments = attachments
    }
    ws.send(JSON.stringify(payload))
    return true
  }, [])

  const sendConfirmation = useCallback((confirmId: string, option: string) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    ws.send(JSON.stringify({ type: 'confirmation_response', confirmId, option }))
    setConfirmation(null)
  }, [])

  const switchProvider = useCallback((provider: string, model?: string): boolean => {
    const text = `/model ${provider}${model ? '/' + model : ''}`
    return sendMessage(text)
  }, [sendMessage])

  const toggleAutonomous = useCallback((enabled: boolean, hours?: number): boolean => {
    const text = `/autonomous ${enabled ? 'on' : 'off'}${hours ? ' ' + hours : ''}`
    return sendMessage(text)
  }, [sendMessage])

  return {
    messages,
    status,
    confirmation,
    isTyping,
    sessionId,
    sendMessage,
    sendConfirmation,
    switchProvider,
    toggleAutonomous,
  }
}
