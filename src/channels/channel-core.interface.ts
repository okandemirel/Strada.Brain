/**
 * Core Channel Interface - Segregated
 *
 * Split from IChannelAdapter for better segregation of concerns.
 * This module contains only essential channel operations.
 */

import type { IncomingMessage, Attachment } from "./channel-messages.interface.js";
import type { ResponseAttribution } from "../learning/feedback/response-attribution.js";

/** Per-send options for {@link IChannelSender.sendMarkdown}. */
export interface SendMarkdownOptions {
  /**
   * This message is a run's final response (LRN-20b). A channel that learns the
   * sent message's id records the attribution under it through its feedback
   * port, so a reaction on this message resolves to this run. A channel that
   * does not support feedback ignores it.
   */
  readonly responseAttribution?: ResponseAttribution;
}

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
  sendMarkdown(chatId: string, markdown: string, options?: SendMarkdownOptions): Promise<void>;

  /** Send a system notification message (renders differently from assistant messages) */
  sendSystemMessage?(chatId: string, text: string): Promise<void>;

  /**
   * Assert which channel a chat id belongs to before a send (plan 2.9, audit
   * 12F1/D58). A daemon/goal notification carries the owner's chatId and
   * channelType from the task/goal row; a multi-channel sender (HubChannel)
   * routes by them instead of by whichever chat spoke last. Single-channel
   * senders leave this undefined.
   */
  /**
   * Bind a chat to the channel that owns it. TRUE is the only answer that
   * authorizes delivery: FALSE means this hub has no such channel (round 8 #6)
   * and NO answer (a sender that implements this but returns nothing) is
   * refused too — silence is not consent (round 9 #32).
   *
   * A single-channel runtime hands the daemon the raw adapter, which leaves
   * this undefined; ownership is then proven by `IChannelCore.name`, which
   * every adapter sets to the same string it stamps on incoming messages'
   * `channelType` ("cli", "web", "telegram", "slack", "discord", "teams").
   * Keep those two in step or owned notifications stop being deliverable.
   */
  bindOwner?(chatId: string, channelType: string): boolean | void;
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

/**
 * Send a system notice (queue/burst notice, progress summary, error/resilience
 * message) so the client can render it as a distinct system pill rather than as
 * an assistant answer.
 *
 * Notices that go out via {@link IChannelSender.sendText} are visually
 * indistinguishable from a real answer in the portal. Routing them through
 * {@link IChannelSender.sendSystemMessage} (when the channel implements it)
 * surfaces them as the dedicated system message instead. Channels without that
 * optional capability degrade gracefully to plain text, matching the existing
 * fallback used by the auto-updater notifier.
 */
export function sendChannelNotice(
  channel: IChannelSender,
  chatId: string,
  text: string,
): Promise<void> {
  if (typeof channel.sendSystemMessage === "function") {
    return channel.sendSystemMessage(chatId, text);
  }
  return channel.sendText(chatId, text);
}
