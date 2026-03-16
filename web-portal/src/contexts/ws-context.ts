import { createContext } from 'react'
import type { UseWebSocketReturn } from '../hooks/useWebSocket'

export const WebSocketContext = createContext<UseWebSocketReturn | null>(null)
