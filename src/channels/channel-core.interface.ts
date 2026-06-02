/**
 * Core Channel Interface - Segregated
 *
 * Split from IChannelAdapter for better segregation of concerns.
 * This module contains only essential channel operations.
 */

import type { IncomingMessage, Attachment } from "./channel-messages.interface.js";

/**
 * Essential channel operations - all channels must implement these.
 */
export interface IChannelCore {
  /** Human-readable name for this channel */
  readonly name: string;

  /** Start the channel and begin listening for messages */
  connect(): Promise<void>;

  /** Gracefully shut down the channel */
  disconnect(): Promise<void>;

  /** Check if the channel is currently healthy */
  isHealthy(): boolean;
}

/**
 * Message receiving capability
 */
export interface IChannelReceiver {
  /** Register a handler for incoming messages */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
}

/**
 * Basic message sending capability
 */
export interface IChannelSender {
  /** Send a plain text message */
  sendText(chatId: string, text: string): Promise<void>;

  /** Send a markdown-formatted message */
  sendMarkdown(chatId: string, markdown: string): Promise<void>;

  /** Send a system notification message (renders differently from assistant messages) */
  sendSystemMessage?(chatId: string, text: string): Promise<void>;
}

/**
 * Rich messaging capabilities
 */
export interface IChannelRichMessaging {
  /** Send a typing/processing indicator */
  sendTypingIndicator(chatId: string): Promise<void>;

  /** Clear the typing/processing indicator */
  sendTypingStop?(chatId: string): void;

  /** Send file attachment */
  sendAttachment(chatId: string, attachment: Attachment): Promise<void>;
}

/**
 * Interactive capabilities
 */
export interface IChannelInteractive {
  /** Ask user for confirmation, returns the selected option */
  requestConfirmation(req: ConfirmationRequest): Promise<string>;
}

export interface ConfirmationRequest {
  chatId: string;
  userId?: string;
  question: string;
  options: string[];
  details?: string;
}

/**
 * Streaming message support
 */
export interface IChannelStreaming {
  /** Start a streaming message. Returns a stream ID for subsequent updates. */
  startStreamingMessage(chatId: string): Promise<string | undefined>;

  /** Update a streaming message with accumulated text so far. */
  updateStreamingMessage(chatId: string, streamId: string, accumulatedText: string): Promise<void>;

  /** Finalize a streaming message with the complete text. */
  finalizeStreamingMessage(chatId: string, streamId: string, finalText: string): Promise<void>;
}

/**
 * Message editing capability (for in-place progress updates)
 */
export interface IChannelMessageEditor {
  editMessage(chatId: string, messageId: string, newContent: string): Promise<void>;
}

/** Narrow unknown to a non-null object so member access is safe. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Type guard for streaming support
 */
export function supportsStreaming(channel: unknown): channel is IChannelStreaming {
  return (
    isObject(channel) &&
    typeof channel.startStreamingMessage === "function" &&
    typeof channel.updateStreamingMessage === "function" &&
    typeof channel.finalizeStreamingMessage === "function"
  );
}

/**
 * Type guard for rich messaging.
 *
 * Verifies BOTH required methods of IChannelRichMessaging (sendTypingIndicator
 * AND sendAttachment) so the narrowing is sound. sendTypingStop is optional and
 * intentionally not checked.
 */
export function supportsRichMessaging(channel: unknown): channel is IChannelRichMessaging {
  return (
    isObject(channel) &&
    typeof channel.sendTypingIndicator === "function" &&
    typeof channel.sendAttachment === "function"
  );
}

/**
 * Type guard for interactive features
 */
export function supportsInteractivity(channel: unknown): channel is IChannelInteractive {
  return (
    isObject(channel) && typeof channel.requestConfirmation === "function"
  );
}

/**
 * Type guard for message editing
 */
export function supportsMessageEditing(channel: unknown): channel is IChannelMessageEditor {
  return (
    isObject(channel) && typeof channel.editMessage === "function"
  );
}
