import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Attachment,
  ChatMessage,
  ConfirmationState,
  ConnectionStatus,
  IncomingMessage,
} from '../types/messages'

const MAX_RECONNECT_DELAY = 30000

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

      // Attempt reconnect with previous session
      const savedChatId = localStorage.getItem('strada-chatId')
      if (savedChatId) {
        ws.send(JSON.stringify({ type: 'reconnect', chatId: savedChatId }))
      }
    })

    ws.addEventListener('close', () => {
      if (!mountedRef.current) return
      setStatus('disconnected')

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
          // First-run: auto-send greeting to trigger onboarding flow
          if (localStorage.getItem('strada-firstRun') === '1') {
            localStorage.removeItem('strada-firstRun')
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: generateId(),
                    sender: 'user',
                    text: 'Hello!',
                    isMarkdown: false,
                    timestamp: Date.now(),
                  },
                ])
                ws.send(JSON.stringify({ type: 'message', text: 'Hello!' }))
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

  return {
    messages,
    status,
    confirmation,
    isTyping,
    sessionId,
    sendMessage,
    sendConfirmation,
  }
}
