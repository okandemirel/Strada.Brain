import { createContext, useContext } from 'react'
import { useWebSocket, type UseWebSocketReturn } from '../hooks/useWebSocket'

const WebSocketContext = createContext<UseWebSocketReturn | null>(null)

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const ws = useWebSocket()
  return <WebSocketContext.Provider value={ws}>{children}</WebSocketContext.Provider>
}

export function useWS(): UseWebSocketReturn {
  const ctx = useContext(WebSocketContext)
  if (!ctx) throw new Error('useWS must be used within WebSocketProvider')
  return ctx
}
