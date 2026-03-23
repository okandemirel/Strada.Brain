/** Incoming message types from the WebSocket server */

export interface ConnectedMessage {
  type: 'connected'
  chatId: string
  reconnectToken: string
  profileId?: string
  profileToken?: string
}

export interface TextMessage {
  type: 'text'
  text: string
  messageId?: string
  instinctIds?: string[]
}

export interface MarkdownMessage {
  type: 'markdown'
  text: string
  messageId?: string
  instinctIds?: string[]
}

export interface StreamStartMessage {
  type: 'stream_start'
  streamId: string
  text?: string
}

export interface StreamUpdateMessage {
  type: 'stream_update'
  streamId: string
  text: string
}

export interface StreamEndMessage {
  type: 'stream_end'
  streamId: string
  text: string
  instinctIds?: string[]
}

export interface ConfirmationMessage {
  type: 'confirmation'
  confirmId: string
  question: string
  options: string[]
  details?: string
}

export interface TypingMessage {
  type: 'typing'
  active: boolean
}

export type IncomingMessage =
  | ConnectedMessage
  | TextMessage
  | MarkdownMessage
  | StreamStartMessage
  | StreamUpdateMessage
  | StreamEndMessage
  | ConfirmationMessage
  | TypingMessage

/** Outgoing message types to the WebSocket server */

export interface SendMessage {
  type: 'message'
  text: string
  attachments?: Attachment[]
}

export interface SessionInitMessage {
  type: 'session_init'
  chatId?: string
  reconnectToken?: string
  profileId?: string
  profileToken?: string
  legacyProfileChatId?: string
}

export interface ConfirmationResponse {
  type: 'confirmation_response'
  confirmId: string
  option: string
}

export interface ReconnectMessage {
  type: 'reconnect'
  chatId: string
  reconnectToken: string
}

export interface ProviderSwitchMessage {
  type: 'provider_switch'
  provider: string
  model?: string
}

export interface AutonomousToggleMessage {
  type: 'autonomous_toggle'
  enabled: boolean
  hours?: number
}

export type OutgoingMessage =
  | SendMessage
  | SessionInitMessage
  | ConfirmationResponse
  | ReconnectMessage
  | ProviderSwitchMessage
  | AutonomousToggleMessage

/** Attachment for file uploads */
export interface Attachment {
  name: string
  type: string
  data: string // base64
  size: number
}

/** Chat message for display */
export interface ChatMessage {
  id: string
  sender: 'user' | 'assistant'
  text: string
  isMarkdown: boolean
  isStreaming?: boolean
  streamId?: string
  timestamp: number
  attachments?: Attachment[]
  instinctIds?: string[]
  feedback?: 'thumbs_up' | 'thumbs_down'
}

/** Connection status */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting'

/** Confirmation dialog state */
export interface ConfirmationState {
  confirmId: string
  question: string
  options: string[]
  details?: string
}
