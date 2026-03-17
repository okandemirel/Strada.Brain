/**
 * NotificationRouter -- Routes notifications to configured channels based on urgency level.
 *
 * Features:
 * - EventBus subscription auto-maps daemon events to urgency levels
 * - Explicit notify() API for custom notifications
 * - Time-window grouping collapses rapid-fire same-type events
 * - Per-urgency rate limiting (low=1/min, medium=5/min, high=10/min, critical=unlimited)
 * - Quiet hours integration: non-critical buffered, critical bypasses
 * - All notifications logged to SQLite notification_history
 * - Emits daemon:notification_routed on EventBus
 */

import type { DaemonStorage } from "../daemon-storage.js";
import type { DaemonEventMap } from "../daemon-events.js";
import type { IChannelSender } from "../../channels/channel-core.interface.js";
import type { IEventBus } from "../../core/event-bus.js";
import { QuietHoursManager } from "./quiet-hours.js";
import {
  URGENCY_ORDER,
  type UrgencyLevel,
  type NotificationConfig,
  type QuietHoursConfig,
  type NotificationPayload,
  type NotificationHistoryEntry,
} from "./notification-types.js";

// =============================================================================
// RATE LIMIT CONFIGURATION
// =============================================================================

/** Max notifications per minute per urgency level */
const RATE_LIMITS: Record<UrgencyLevel, number> = {
  silent: 0, // silent never delivered to channels
  low: 1,
  medium: 5,
  high: 10,
  critical: Infinity,
};

// =============================================================================
// TYPES
// =============================================================================

export interface NotificationRouterDeps {
  readonly config: NotificationConfig;
  readonly quietHoursConfig: QuietHoursConfig;
  readonly eventBus: IEventBus<DaemonEventMap>;
  readonly storage: DaemonStorage;
  readonly channelSender?: IChannelSender;
  readonly chatId?: string;
}

interface GroupEntry {
  count: number;
  lastPayload: NotificationPayload;
  windowStart: number;
}

// =============================================================================
// NOTIFICATION ROUTER
// =============================================================================

export class NotificationRouter {
  private readonly config: NotificationConfig;
  private readonly eventBus: IEventBus<DaemonEventMap>;
  private readonly storage: DaemonStorage;
  private readonly channelSender?: IChannelSender;
  private readonly chatId?: string;
  private readonly quietHoursManager: QuietHoursManager;

  /** Time-window grouping: key -> group state */
  private readonly groupMap = new Map<string, GroupEntry>();

  /** Per-urgency rate limiting: sliding window timestamps */
  private readonly rateLimitMap = new Map<UrgencyLevel, number[]>();

  /** Event listener references for cleanup */
  private readonly listeners: Array<{ event: string; fn: Function }> = [];

  constructor(deps: NotificationRouterDeps) {
    this.config = deps.config;
    this.eventBus = deps.eventBus;
    this.storage = deps.storage;
    this.channelSender = deps.channelSender;
    this.chatId = deps.chatId;
    this.quietHoursManager = new QuietHoursManager({
      config: deps.quietHoursConfig,
      storage: deps.storage,
    });
  }

  /**
   * Main notification API.
   * Applies: min level filter, time-window grouping, rate limiting,
   * silent-only logging, quiet hours buffering, channel delivery,
   * history persistence, and event emission.
   */
  async notify(payload: NotificationPayload): Promise<void> {
    // 1. Check min level filter
    if (URGENCY_ORDER[payload.level] < URGENCY_ORDER[this.config.minLevel]) {
      return;
    }

    // Evict stale group entries to prevent unbounded memory growth
    this.evictStaleGroups(payload.timestamp);

    // 2. Apply time-window grouping
    const groupKey = payload.sourceEvent || payload.title;
    const now = payload.timestamp;
    const existingGroup = this.groupMap.get(groupKey);

    if (existingGroup && (now - existingGroup.windowStart) < this.config.groupingWindowMs) {
      existingGroup.count++;
      existingGroup.lastPayload = payload;
      return; // Grouped, delivery deferred
    }

    // New group or window expired -- check if previous group had collapsed entries
    let deliveryPayload = payload;
    if (existingGroup && existingGroup.count > 1) {
      deliveryPayload = {
        ...existingGroup.lastPayload,
        title: `${existingGroup.count}x: ${existingGroup.lastPayload.title}`,
      };
    }
    // Start new group window
    this.groupMap.set(groupKey, { count: 1, lastPayload: payload, windowStart: now });

    // 3. Silent urgency: log to history only (never delivered to channels)
    if (payload.level === "silent") {
      this.logToHistory(deliveryPayload, ["dashboard"]);
      this.emitRoutedEvent(deliveryPayload, ["dashboard"], false);
      return;
    }

    // 4. Apply per-urgency rate limiting (critical is unlimited)
    if (payload.level !== "critical") {
      const limit = RATE_LIMITS[payload.level];
      const windowMs = 60000; // 1 minute sliding window
      const timestamps = this.rateLimitMap.get(payload.level) ?? [];
      const windowStart = now - windowMs;
      const recent = timestamps.filter((t) => t > windowStart);

      if (recent.length >= limit) {
        return; // Rate limited, drop
      }

      recent.push(now);
      this.rateLimitMap.set(payload.level, recent);
    }

    // 5. Check quiet hours
    if (this.quietHoursManager.isQuietHours() && !this.quietHoursManager.shouldBypass(deliveryPayload.level)) {
      this.quietHoursManager.bufferNotification(deliveryPayload);
      this.emitRoutedEvent(deliveryPayload, [], true);
      return;
    }

    // 6. Route to channels
    const channels = this.config.routing[deliveryPayload.level] ?? [];
    const deliveredTo: string[] = [];

    for (const channel of channels) {
      if (channel === "chat" && this.channelSender && this.chatId) {
        const markdown = this.formatNotification(deliveryPayload);
        try {
          await this.channelSender.sendMarkdown(this.chatId, markdown);
          deliveredTo.push("chat");
        } catch {
          // Fire-and-forget: log and continue
        }
      } else if (channel === "dashboard") {
        deliveredTo.push("dashboard");
      }
    }

    // 7. Log to notification history
    this.logToHistory(deliveryPayload, deliveredTo);

    // 8. Emit event
    this.emitRoutedEvent(deliveryPayload, deliveredTo, false);
  }

  /**
   * Subscribe to daemon events and start any scheduled tasks.
   */
  start(): void {
    this.subscribeToEvents();
  }

  /**
   * Stop event subscriptions and scheduled tasks.
   */
  stop(): void {
    for (const listener of this.listeners) {
      this.eventBus.off(listener.event as keyof DaemonEventMap & string, listener.fn as never);
    }
    this.listeners.length = 0;
  }

  /**
   * Get notification history from storage.
   */
  getHistory(limit: number, levelFilter?: UrgencyLevel): NotificationHistoryEntry[] {
    return this.storage.getNotificationHistory(limit, levelFilter);
  }

  // =========================================================================
  // PRIVATE: Event Subscription
  // =========================================================================

  private subscribeToEvents(): void {
    const subscribe = <K extends keyof DaemonEventMap & string>(
      event: K,
      handler: (payload: DaemonEventMap[K]) => void | Promise<void>,
    ): void => {
      this.eventBus.on(event, handler);
      this.listeners.push({ event, fn: handler });
    };

    subscribe("daemon:tick", (e) => {
      void this.notify({
        level: "silent",
        title: "Heartbeat tick",
        message: `Daemon tick at ${new Date(e.timestamp).toISOString()}`,
        sourceEvent: "daemon:tick",
        timestamp: e.timestamp,
      });
    });

    subscribe("daemon:trigger_fired", (e) => {
      void this.notify({
        level: "low",
        title: `Trigger fired: ${e.triggerName}`,
        message: `Trigger '${e.triggerName}' fired, task ${e.taskId}`,
        sourceEvent: "daemon:trigger_fired",
        timestamp: e.timestamp,
      });
    });

    subscribe("daemon:trigger_failed", (e) => {
      void this.notify({
        level: "medium",
        title: `Trigger failed: ${e.triggerName}`,
        message: `Trigger '${e.triggerName}' failed: ${e.error}`,
        actionHint: `Run: strada daemon reset ${e.triggerName}`,
        sourceEvent: "daemon:trigger_failed",
        timestamp: e.timestamp,
      });
    });

    subscribe("daemon:budget_warning", (e) => {
      void this.notify({
        level: "medium",
        title: `Budget at ${Math.round(e.pct * 100)}%`,
        message: `Budget usage: $${e.usedUsd.toFixed(2)} / $${e.limitUsd.toFixed(2)}`,
        actionHint: "Run: strada daemon budget reset",
        sourceEvent: "daemon:budget_warning",
        timestamp: e.timestamp,
      });
    });

    subscribe("daemon:budget_exceeded", (e) => {
      void this.notify({
        level: "high",
        title: "Budget exceeded",
        message: `Budget exhausted: $${e.usedUsd.toFixed(2)} / $${e.limitUsd.toFixed(2)}`,
        actionHint: "Run: strada daemon budget reset",
        sourceEvent: "daemon:budget_exceeded",
        timestamp: e.timestamp,
      });
    });

    subscribe("daemon:approval_requested", (e) => {
      void this.notify({
        level: "medium",
        title: `Approval needed: ${e.toolName}`,
        message: `Write operation '${e.toolName}' requires approval (ID: ${e.approvalId})`,
        actionHint: `Run: strada daemon approve ${e.approvalId}`,
        sourceEvent: "daemon:approval_requested",
        timestamp: e.timestamp,
      });
    });

    subscribe("daemon:approval_decided", (e) => {
      void this.notify({
        level: "low",
        title: `Approval ${e.decision}: ${e.approvalId}`,
        message: `Approval ${e.approvalId} was ${e.decision}`,
        sourceEvent: "daemon:approval_decided",
        timestamp: e.timestamp,
      });
    });

    subscribe("goal:failed", (e) => {
      void this.notify({
        level: "high",
        title: `Goal failed: ${e.error}`,
        message: `Goal ${e.rootId} failed after ${e.failureCount} failures: ${e.error}`,
        sourceEvent: "goal:failed",
        timestamp: e.timestamp,
      });
    });

    subscribe("goal:complete", (e) => {
      void this.notify({
        level: "low",
        title: `Goal complete: ${e.taskDescription}`,
        message: `Goal '${e.taskDescription}' completed in ${Math.round(e.durationMs / 1000)}s`,
        sourceEvent: "goal:complete",
        timestamp: e.timestamp,
      });
    });
  }

  // =========================================================================
  // PRIVATE: Helpers
  // =========================================================================

  private logToHistory(payload: NotificationPayload, deliveredTo: string[]): void {
    this.storage.insertNotificationHistory({
      urgency: payload.level,
      title: payload.title,
      message: payload.message,
      deliveredTo,
      createdAt: payload.timestamp,
    });
  }

  private emitRoutedEvent(payload: NotificationPayload, deliveredTo: string[], buffered: boolean): void {
    this.eventBus.emit("daemon:notification_routed", {
      urgency: payload.level,
      title: payload.title,
      deliveredTo,
      buffered,
      timestamp: payload.timestamp,
    });
  }

  /** Remove group entries whose window has expired to bound memory usage */
  private evictStaleGroups(now: number): void {
    const windowMs = this.config.groupingWindowMs;
    for (const [key, entry] of this.groupMap) {
      if (now - entry.windowStart >= windowMs) {
        this.groupMap.delete(key);
      }
    }
  }

  private formatNotification(payload: NotificationPayload): string {
    let md = `**[${payload.level.toUpperCase()}]** ${payload.title}\n\n${payload.message}`;
    if (payload.actionHint) {
      md += `\n\n> ${payload.actionHint}`;
    }
    return md;
  }
}
