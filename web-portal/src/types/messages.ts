/** Incoming message types from the WebSocket server */

export interface ConnectedMessage {
  type: 'connected'
  chatId: string
  reconnectToken: string
  profileId?: string
  profileToken?: string
  language?: string
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
  /** The new text delta (not the full accumulated text). */
  delta: string
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

export interface MessageReceivedMessage {
  type: 'message_received'
  clientMessageId: string
}

export interface SystemMessage {
  type: 'system'
  text: string
  messageId?: string
}

export type IncomingMessage =
  | ConnectedMessage
  | TextMessage
  | MarkdownMessage
  | StreamStartMessage
  | StreamUpdateMessage
  | StreamEndMessage
  | ConfirmationMessage
  | MessageReceivedMessage
  | TypingMessage
  | SystemMessage

/** Outgoing message types to the WebSocket server */

export interface SendMessage {
  type: 'message'
  text: string
  clientMessageId?: string
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

// --- Level Completion Verifier messages ---

export type VerifyCheckType = 'build' | 'test' | 'manual'
export type VerifyCheckStatus = 'pass' | 'warn' | 'fail' | 'pending'
export type VerifyGateVerdict = 'approve' | 'request_changes' | 'escalate'

export interface VerifyCheckCriterionMessage {
  type: 'verify:check_criterion'
  taskId: string
  criterionId: string
  checkType: VerifyCheckType
}

export interface VerifyCheckResultMessage {
  type: 'verify:check_result'
  taskId: string
  criterionId: string
  status: VerifyCheckStatus
  evidence?: string
  error?: string
}

export interface VerifyGateDecisionMessage {
  type: 'verify:gate_decision'
  taskId: string
  verdict: VerifyGateVerdict
  note?: string
}

export interface VerifyGateAckMessage {
  type: 'verify:gate_ack'
  taskId: string
  accepted: boolean
  supervisorVerdict?: string
}

export type OutgoingMessage =
  | SendMessage
  | SessionInitMessage
  | ConfirmationResponse
  | ReconnectMessage
  | ProviderSwitchMessage
  | AutonomousToggleMessage
  | VerifyCheckCriterionMessage
  | VerifyGateDecisionMessage

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
  sender: 'user' | 'assistant' | 'system'
  text: string
  isMarkdown: boolean
  isStreaming?: boolean
  streamId?: string
  timestamp: number
  attachments?: Attachment[]
  instinctIds?: string[]
  feedback?: 'thumbs_up' | 'thumbs_down'
  deliveryState?: 'pending' | 'failed'
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
