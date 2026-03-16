/**
 * Agent Notifier
 *
 * Sends proactive notifications to the user when the agent
 * takes autonomous actions or observes important events.
 */

import type { IChannelAdapter } from "../channels/channel.interface.js";
import { getLogger } from "../utils/logger.js";

export class AgentNotifier {
  private readonly logger = getLogger();
  private lastNotificationMs = 0;
  private static readonly MIN_NOTIFICATION_INTERVAL_MS = 30_000; // Don't spam

  constructor(
    private readonly channel: IChannelAdapter,
    private readonly chatId: string,
  ) {}

  /**
   * Notify user about an autonomous action.
   * Rate-limited to prevent notification spam.
   */
  async notifyAction(action: string, _reasoning: string): Promise<void> {
    if (!this.shouldNotify()) return;

    try {
      await this.channel.sendText(
        this.chatId,
        `[Agent] ${action}`,
      );
    } catch {
      this.logger.debug("AgentNotifier: failed to send notification");
    }
  }

  /**
   * Notify user about an important observation.
   */
  async notifyObservation(summary: string): Promise<void> {
    if (!this.shouldNotify()) return;

    try {
      await this.channel.sendText(
        this.chatId,
        `[Agent] ${summary}`,
      );
    } catch {
      this.logger.debug("AgentNotifier: failed to send observation notification");
    }
  }

  private shouldNotify(): boolean {
    const now = Date.now();
    if (now - this.lastNotificationMs < AgentNotifier.MIN_NOTIFICATION_INTERVAL_MS) {
      return false;
    }
    this.lastNotificationMs = now;
    return true;
  }
}
