/**
 * Unified Channel Interface
 *
 * Combines all segregated interfaces into a single interface.
 * Implementations can choose which capabilities to support.
 */

import type { IChannelCore, IChannelReceiver, IChannelSender } from "./channel-core.interface.js";
import type { PostSetupBootstrapContext } from "../common/setup-contract.js";

/**
 * Common interface for all messaging channel adapters.
 * Implementations: Telegram (grammy), CLI (readline), Discord, Slack, Teams, Web
 *
 * Note: Not all channels support all features. Use type guards to check capabilities:
 * - supportsStreaming(channel) - for streaming support
 * - supportsRichMessaging(channel) - for typing indicators
 * - supportsInteractivity(channel) - for confirmation dialogs
 */
export interface IChannelAdapter extends IChannelCore, IChannelReceiver, IChannelSender {
  setPostSetupBootstrapHandler?(handler: ((context: PostSetupBootstrapContext) => Promise<void> | void) | null): void;

  /**
   * Optional channel-specific wiring hooks. Only some channels (e.g. WebChannel)
   * implement these; bootstrap calls them with `?.` so non-implementing
   * channels are simply skipped. Declared here so callers get compile-time
   * typing instead of `channel as unknown as { ... }` structural casts.
   */

  /** Resolve the chat/owner that a background task belongs to (e.g. for web routing). */
  setTaskOwnerResolver?(
    resolver: (taskId: string) => string | null | undefined | Promise<string | null | undefined>,
  ): void;

  /**
   * Bridge inbound workspace commands from the frontend into the workspace bus.
   * The emitter returns true when at least one consumer was subscribed to the
   * event, so a channel can ack "enforced" only for commands something received
   * (audited 2026-09-02); a void return is treated as "no consumer".
   */
  setWorkspaceBusEmitter?(
    emitter: ((event: string, payload: unknown) => boolean | void) | null,
  ): void;

  /** Receive user feedback reactions (thumbs up/down) for the learning system. */
  setFeedbackHandler?(
    handler: (
      type: "thumbs_up" | "thumbs_down",
      instinctIds: string[],
      userId?: string,
      source?: "reaction" | "button",
    ) => void,
  ): void;

  // Core features are required
  // Optional features use type guards
}

// Re-export all types for convenience
export type {
  IChannelCore,
  IChannelReceiver,
  IChannelSender,
  IChannelRichMessaging,
  IChannelInteractive,
  IChannelStreaming,
  IChannelMessageEditor,
  ConfirmationRequest,
} from "./channel-core.interface.js";

export type {
  IncomingMessage,
  OutgoingMessage,
  Attachment,
  MessageMetadata,
  ChannelType,
} from "./channel-messages.interface.js";

export {
  supportsStreaming,
  supportsRichMessaging,
  supportsInteractivity,
  supportsMessageEditing,
  sendChannelNotice,
} from "./channel-core.interface.js";
