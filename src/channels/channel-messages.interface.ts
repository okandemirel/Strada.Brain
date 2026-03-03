/**
 * Message Types for Channel Communication
 * 
 * Extracted from the main channel interface for better organization.
 */

/**
 * Supported channel types
 */
export type ChannelType = "telegram" | "whatsapp" | "cli" | "web" | "discord" | "slack";

/**
 * Represents an incoming message from any channel.
 */
export interface IncomingMessage {
  /** Which channel this message came from */
  channelType: ChannelType;
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

/**
 * File attachment
 */
export interface Attachment {
  type: "file" | "image" | "document" | "audio" | "video";
  name: string;
  url?: string;
  data?: Buffer;
  mimeType?: string;
  size?: number;
}

/**
 * Outgoing message
 */
export interface OutgoingMessage {
  chatId: string;
  text: string;
  format?: "plain" | "markdown" | "html";
  attachments?: Attachment[];
  replyTo?: string;
}

/**
 * Message metadata for tracking
 */
export interface MessageMetadata {
  messageId: string;
  chatId: string;
  userId: string;
  timestamp: Date;
  processedAt?: Date;
  responseTimeMs?: number;
}
