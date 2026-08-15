/**
 * Message Types for Channel Communication
 * 
 * Extracted from the main channel interface for better organization.
 */

/**
 * Supported channel types
 */
export type ChannelType = "telegram" | "cli" | "web" | "discord" | "slack" | "teams";

/** Hard cap for inbound user text across all channels. */
export const MAX_INCOMING_TEXT_LENGTH = 16_000;

export function limitIncomingText(text: string): string {
  if (text.length <= MAX_INCOMING_TEXT_LENGTH) {
    return text;
  }
  let out = text.slice(0, MAX_INCOMING_TEXT_LENGTH);
  // Avoid splitting a surrogate pair at the cap: if the last code unit is a
  // lone high surrogate (0xD800-0xDBFF), its low surrogate was cut off, so drop it.
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Represents an incoming message from any channel.
 */
export interface IncomingMessage {
  /** Which channel this message came from */
  channelType: ChannelType;
  /** Unique identifier for the chat/conversation */
  chatId: string;
  /** Stable conversation identity when chatId is transient (optional). */
  conversationId?: string;
  /**
   * Whole-goal MONITOR scope (optional). When a single user request fans out into
   * multiple agent/worker runs (each with its own chatId), the originating request's
   * conversationScope is stamped here so each spawned run's monitor events roll UP
   * to the parent goal's episode/conversation (one workspace per whole goal) instead
   * of minting a sibling conversation. MONITOR-only: never re-keys identity/session/
   * memory (those stay on the run's own chatId/userId). Absent ⇒ the run is its own
   * whole-goal root (byte-identical to the prior per-chatId behavior).
   */
  monitorScope?: string;
  /** Unique identifier for the user */
  userId: string;
  /** The text content of the message */
  text: string;
  /** Optional file attachments */
  attachments?: Attachment[];
  /** ID of message being replied to, if any */
  replyTo?: string;
  /**
   * Opaque, channel-specific token correlating a reply back to a specific
   * inbound interaction (e.g. a Discord interaction token / id). Lets a channel
   * route the response to the exact interaction that triggered it rather than a
   * generic chat send.
   */
  replyToken?: string;
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
