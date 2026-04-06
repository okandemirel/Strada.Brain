import { useMemo } from 'react'
import { useWebSocket, type UseWebSocketReturn } from '../hooks/useWebSocket'
import { WebSocketContext } from './ws-context'

// Side-effect import: registers sibling store resets as logout hooks
// so that useSessionStore.getState().logout() cascades to all stores.
import '../stores/logout-hooks'

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
      sendRawJSON: ws.sendRawJSON,
    }),
    [ws.messages, ws.status, ws.confirmation, ws.isTyping, ws.sessionId, ws.profileId, ws.sendMessage, ws.sendConfirmation, ws.switchProvider, ws.toggleAutonomous, ws.sendRawJSON]
  )
  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>
}
