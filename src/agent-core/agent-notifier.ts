/**
 * Agent Notifier
 *
 * Sends proactive notifications to the user when the agent
 * takes autonomous actions or observes important events.
 */

import type { IChannelAdapter } from "../channels/channel.interface.js";
import { getLogger } from "../utils/logger.js";

export type AgentNotificationUrgency = "low" | "medium" | "high" | "critical";

export interface AgentNotificationOptions {
  readonly urgency?: AgentNotificationUrgency;
  readonly hardBlocker?: boolean;
  readonly finalCompletion?: boolean;
}

export interface AgentNotifierConfig {
  readonly mode?: "silent-first" | "standard";
  readonly minChatLevel?: AgentNotificationUrgency;
  readonly minNotificationIntervalMs?: number;
}

const URGENCY_ORDER: Record<AgentNotificationUrgency, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export class AgentNotifier {
  private readonly logger = getLogger();
  private lastNotificationMs = 0;
  private readonly config: Required<AgentNotifierConfig>;

  constructor(
    private readonly channel: IChannelAdapter,
    private readonly chatId: string,
    config: AgentNotifierConfig = {},
  ) {
    this.config = {
      mode: config.mode ?? "silent-first",
      minChatLevel: config.minChatLevel ?? "high",
      minNotificationIntervalMs: config.minNotificationIntervalMs ?? 30_000,
    };
  }

  /**
   * Notify user about an autonomous action.
   * Rate-limited to prevent notification spam.
   */
  async notifyAction(
    action: string,
    _reasoning: string,
    options: AgentNotificationOptions = {},
  ): Promise<void> {
    if (!this.shouldNotify(options)) return;

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
  async notifyObservation(
    summary: string,
    options: AgentNotificationOptions = {},
  ): Promise<void> {
    if (!this.shouldNotify(options)) return;

    try {
      await this.channel.sendText(
        this.chatId,
        `[Agent] ${summary}`,
      );
    } catch {
      this.logger.debug("AgentNotifier: failed to send observation notification");
    }
  }

  private shouldNotify(options: AgentNotificationOptions): boolean {
    const urgency = options.urgency ?? "medium";
    const bypassSilence = options.hardBlocker || options.finalCompletion || urgency === "critical";
    if (
      this.config.mode === "silent-first"
      && !bypassSilence
      && URGENCY_ORDER[urgency] < URGENCY_ORDER[this.config.minChatLevel]
    ) {
      return false;
    }

    const now = Date.now();
    if (!bypassSilence && now - this.lastNotificationMs < this.config.minNotificationIntervalMs) {
      return false;
    }
    this.lastNotificationMs = now;
    return true;
  }
}
