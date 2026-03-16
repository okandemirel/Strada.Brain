import { useContext } from 'react'
import { WebSocketContext } from '../contexts/ws-context'
import type { UseWebSocketReturn } from './useWebSocket'

export function useWS(): UseWebSocketReturn {
  const ctx = useContext(WebSocketContext)
  if (!ctx) throw new Error('useWS must be used within WebSocketProvider')
  return ctx
}
