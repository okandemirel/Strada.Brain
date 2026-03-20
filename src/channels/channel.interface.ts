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
 * Implementations: Telegram (grammy), WhatsApp (baileys), CLI (readline), Discord, Slack
 *
 * Note: Not all channels support all features. Use type guards to check capabilities:
 * - supportsStreaming(channel) - for streaming support
 * - supportsRichMessaging(channel) - for typing indicators
 * - supportsInteractivity(channel) - for confirmation dialogs
 */
export interface IChannelAdapter extends IChannelCore, IChannelReceiver, IChannelSender {
  setPostSetupBootstrapHandler?(handler: ((context: PostSetupBootstrapContext) => Promise<void> | void) | null): void;
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
} from "./channel-core.interface.js";
