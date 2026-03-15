import { createContext, useContext, useMemo } from 'react'
import { useWebSocket, type UseWebSocketReturn } from '../hooks/useWebSocket'

const WebSocketContext = createContext<UseWebSocketReturn | null>(null)

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const ws = useWebSocket()
  // useWebSocket returns a new object every render, but its individual
  // properties are stable (useState values + useCallback refs). Memoize
  // the context value so consumers only re-render when actual data changes.
  const value = useMemo<UseWebSocketReturn>(
    () => ({
      messages: ws.messages,
      status: ws.status,
      confirmation: ws.confirmation,
      isTyping: ws.isTyping,
      sessionId: ws.sessionId,
      sendMessage: ws.sendMessage,
      sendConfirmation: ws.sendConfirmation,
      switchProvider: ws.switchProvider,
      toggleAutonomous: ws.toggleAutonomous,
    }),
    [ws.messages, ws.status, ws.confirmation, ws.isTyping, ws.sessionId, ws.sendMessage, ws.sendConfirmation, ws.switchProvider, ws.toggleAutonomous]
  )
  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>
}

export function useWS(): UseWebSocketReturn {
  const ctx = useContext(WebSocketContext)
  if (!ctx) throw new Error('useWS must be used within WebSocketProvider')
  return ctx
}
