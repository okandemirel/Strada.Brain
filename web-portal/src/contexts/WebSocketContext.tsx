import { useMemo } from 'react'
import { useWebSocket, type UseWebSocketReturn } from '../hooks/useWebSocket'
import { WebSocketContext } from './ws-context'

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const ws = useWebSocket()
  // Read state now comes from the Zustand store (useSessionStore).
  // The context primarily carries action methods. We still memoize
  // the full value so legacy consumers using useWS() continue to work.
  const value = useMemo<UseWebSocketReturn>(
    () => ({
      messages: ws.messages,
      status: ws.status,
      confirmation: ws.confirmation,
      isTyping: ws.isTyping,
      sessionId: ws.sessionId,
      profileId: ws.profileId,
      sendMessage: ws.sendMessage,
      sendConfirmation: ws.sendConfirmation,
      switchProvider: ws.switchProvider,
      toggleAutonomous: ws.toggleAutonomous,
    }),
    [ws.messages, ws.status, ws.confirmation, ws.isTyping, ws.sessionId, ws.profileId, ws.sendMessage, ws.sendConfirmation, ws.switchProvider, ws.toggleAutonomous]
  )
  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>
}
