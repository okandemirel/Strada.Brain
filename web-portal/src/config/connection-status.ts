import type { ConnectionStatus } from '../types/messages'

export interface StatusConfig {
  color: string
  label: string
}

export const CONNECTION_STATUS: Record<ConnectionStatus, StatusConfig> = {
  connected: { color: 'bg-success', label: 'Connected' },
  connecting: { color: 'bg-warning', label: 'Connecting...' },
  reconnecting: { color: 'bg-warning', label: 'Reconnecting...' },
  disconnected: { color: 'bg-error', label: 'Disconnected' },
}
