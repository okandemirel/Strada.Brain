/**
 * Represents an incoming message from any channel.
 */
export interface IncomingMessage {
  /** Which channel this message came from */
  channelType: "telegram" | "whatsapp" | "cli" | "web";
  /** Unique identifier for the chat/conversation */
  chatId: string;
  /** Unique identifier for the user */
  userId: string;
  /** The text content of the message */
  text: string;
  /** Optional file attachments */
  attachments?: Attachment[];
  /** ID of message being replied to, if any */
  replyTo?: string;
  /** When the message was sent */
  timestamp: Date;
}

export interface Attachment {
  type: "file" | "image" | "document";
  name: string;
  url?: string;
  data?: Buffer;
  mimeType?: string;
}

/**
 * Confirmation request sent to the user before destructive operations.
 */
export interface ConfirmationRequest {
  chatId: string;
  question: string;
  options: string[];
  details?: string;
}

/**
 * Common interface for all messaging channel adapters.
 * Implementations: Telegram (grammy), WhatsApp (baileys), CLI (readline), Web (WS)
 */
export interface IChannelAdapter {
  /** Human-readable name for this channel */
  readonly name: string;

  /** Start the channel and begin listening for messages */
  connect(): Promise<void>;

  /** Gracefully shut down the channel */
  disconnect(): Promise<void>;

  /** Register a handler for incoming messages */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;

  /** Send a plain text message */
  sendText(chatId: string, text: string): Promise<void>;

  /** Send a markdown-formatted message */
  sendMarkdown(chatId: string, markdown: string): Promise<void>;

  /** Send a typing/processing indicator */
  sendTypingIndicator(chatId: string): Promise<void>;

  /** Ask user for confirmation, returns the selected option */
  requestConfirmation(req: ConfirmationRequest): Promise<string>;

  /** Check if the channel is currently healthy */
  isHealthy(): boolean;

  // ---- Streaming support (optional) ----

  /**
   * Start a streaming message. Returns a stream ID for subsequent updates.
   * Channels that don't support streaming should return undefined.
   */
  startStreamingMessage?(chatId: string): Promise<string | undefined>;

  /**
   * Update a streaming message with accumulated text so far.
   * Called repeatedly as chunks arrive from the LLM.
   */
  updateStreamingMessage?(chatId: string, streamId: string, accumulatedText: string): Promise<void>;

  /**
   * Finalize a streaming message with the complete text.
   */
  finalizeStreamingMessage?(chatId: string, streamId: string, finalText: string): Promise<void>;
}
