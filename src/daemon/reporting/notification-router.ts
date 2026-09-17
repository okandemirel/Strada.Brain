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
import { getLoggerSafe } from "../../utils/logger.js";
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

/** How often the background timer flushes stale groups and checks for the quiet→active transition. */
const MAINTENANCE_INTERVAL_MS = 30_000;

export class NotificationRouter {
  private readonly config: NotificationConfig;
  private readonly eventBus: IEventBus<DaemonEventMap>;
  private readonly storage: DaemonStorage;
  private readonly channelSender?: IChannelSender;
  // The fallback chat for notifications that carry no owner: the configured
  // admin chat (constructor), else the FIRST inbound chat bound via setChatId()
  // (bootstrap calls it from channel.onMessage on every message; only the first
  // call sticks — plan 2.9, audit 12F1/D58: never "the last chat that spoke").
  // Until bound, the 'chat' delivery path for owner-less notifications is skipped.
  private chatId?: string;
  private readonly quietHoursManager: QuietHoursManager;

  /** Time-window grouping: key -> group state */
  private readonly groupMap = new Map<string, GroupEntry>();

  /** Per-urgency rate limiting: sliding window timestamps */
  private readonly rateLimitMap = new Map<UrgencyLevel, number[]>();

  /** Event listener references for cleanup */
  private readonly listeners: Array<{ event: string; fn: Function }> = [];

  /** Background maintenance timer (flush groups + drain on quiet→active). */
  private maintenanceTimer?: ReturnType<typeof setInterval>;

  /** Tracks whether we were in quiet hours on the previous maintenance tick. */
  private wasQuiet = false;

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
    this.wasQuiet = this.quietHoursManager.isQuietHours();
  }

  /**
   * Bind the fallback chat for owner-less notifications. Bootstrap calls this
   * on every inbound message; only the first binding is kept, so the fallback
   * is never the most recent inbound chat (2.9). A configured admin chat
   * (constructor `chatId`) is never overridden.
   */
  setChatId(id: string): void {
    if (this.chatId !== undefined) return;
    this.chatId = id;
  }

  /** The chat owner-less notifications go to (admin chat, else first inbound). */
  fallbackChatId(): string | undefined {
    return this.chatId;
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

    // Flush any group whose window has expired. Unlike a silent eviction this
    // DELIVERS the residual collapsed summary (count > 1) instead of dropping
    // it, so a burst's final group is surfaced and memory stays bounded. This
    // also clears the current key's expired group, so the window-ending event
    // below is delivered on its own payload rather than masked by the summary.
    await this.flushExpiredGroups(payload.timestamp);

    // 2. Apply time-window grouping
    const groupKey = payload.sourceEvent || payload.title;
    const now = payload.timestamp;
    const existingGroup = this.groupMap.get(groupKey);

    if (existingGroup && (now - existingGroup.windowStart) < this.config.groupingWindowMs) {
      existingGroup.count++;
      existingGroup.lastPayload = payload;
      return; // Grouped, delivery deferred
    }

    // No active window (new key, or flushed above): start a fresh window for
    // this event and deliver it on its own payload.
    this.groupMap.set(groupKey, { count: 1, lastPayload: payload, windowStart: now });
    await this.deliver(payload);
  }

  /**
   * Apply silent-handling, rate limiting, quiet-hours buffering, channel
   * delivery, history persistence, and event emission for a single payload.
   * Grouping/min-level filtering happen upstream in {@link notify}.
   */
  private async deliver(deliveryPayload: NotificationPayload): Promise<void> {
    const now = deliveryPayload.timestamp;

    // 3. Silent urgency: log to history only (never delivered to channels)
    if (deliveryPayload.level === "silent") {
      this.logToHistory(deliveryPayload, ["dashboard"]);
      this.emitRoutedEvent(deliveryPayload, ["dashboard"], false);
      return;
    }

    // 4. Apply per-urgency rate limiting (critical is unlimited)
    if (deliveryPayload.level !== "critical") {
      const limit = RATE_LIMITS[deliveryPayload.level];
      const windowMs = 60000; // 1 minute sliding window
      const timestamps = this.rateLimitMap.get(deliveryPayload.level) ?? [];
      const windowStart = now - windowMs;
      const recent = timestamps.filter((t) => t > windowStart);

      if (recent.length >= limit) {
        return; // Rate limited, drop
      }

      recent.push(now);
      this.rateLimitMap.set(deliveryPayload.level, recent);
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

    // 2.9: the owner's chat (from the task/goal row) wins; the fallback is the
    // admin/first-bound chat, never the most recent inbound one.
    const targetChatId = deliveryPayload.chatId ?? this.chatId;
    for (const channel of channels) {
      if (channel === "chat" && this.channelSender && targetChatId) {
        const markdown = this.formatNotification(deliveryPayload);
        try {
          if (deliveryPayload.chatId && deliveryPayload.channelType) {
            this.channelSender.bindOwner?.(deliveryPayload.chatId, deliveryPayload.channelType);
          }
          await this.channelSender.sendMarkdown(targetChatId, markdown);
          deliveredTo.push("chat");
        } catch (err) {
          // Do not swallow silently: surface the failure so a broken channel
          // send is debuggable, then continue to the next channel.
          getLoggerSafe().warn("Notification channel send failed", {
            chatId: targetChatId,
            channelType: deliveryPayload.channelType,
            urgency: deliveryPayload.level,
            title: deliveryPayload.title,
            error: err instanceof Error ? err.message : String(err),
          });
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
    // Background maintenance: flush stale groups (so the final group in a burst
    // is actually delivered even without a follow-up event) and drain the
    // quiet-hours buffer on the quiet→active transition.
    if (!this.maintenanceTimer) {
      this.maintenanceTimer = setInterval(() => {
        this.runMaintenance().catch((err) => {
          getLoggerSafe().warn("Notification maintenance tick failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, MAINTENANCE_INTERVAL_MS);
      // Don't keep the event loop alive solely for this timer.
      this.maintenanceTimer.unref?.();
    }
  }

  /**
   * Stop event subscriptions and scheduled tasks.
   */
  stop(): void {
    for (const listener of this.listeners) {
      this.eventBus.off(listener.event as keyof DaemonEventMap & string, listener.fn as never);
    }
    this.listeners.length = 0;
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
    }
  }

  /**
   * Periodic maintenance: flush any group whose window has expired, and drain
   * buffered notifications when quiet hours have just ended.
   */
  async runMaintenance(now: number = Date.now()): Promise<void> {
    await this.flushExpiredGroups(now);
    await this.checkQuietHoursTransition(now);
  }

  /**
   * Flush groups whose window has expired so the residual collapsed summary
   * (count > 1) is delivered without waiting for a subsequent triggering event.
   * Single-event groups (count === 1) were already delivered when created.
   */
  async flushExpiredGroups(now: number = Date.now()): Promise<void> {
    const windowMs = this.config.groupingWindowMs;
    for (const [key, entry] of this.groupMap) {
      if (now - entry.windowStart >= windowMs) {
        this.groupMap.delete(key);
        if (entry.count > 1) {
          await this.deliver({
            ...entry.lastPayload,
            title: `${entry.count}x: ${entry.lastPayload.title}`,
          });
        }
      }
    }
  }

  /**
   * Detect the quiet→active transition and drain the SQLite buffer, delivering
   * the aggregated backlog so notifications generated during quiet hours are
   * not lost.
   */
  private async checkQuietHoursTransition(now: number): Promise<void> {
    const isQuiet = this.quietHoursManager.isQuietHours(new Date(now));
    if (this.wasQuiet && !isQuiet) {
      await this.drainBufferedNotifications();
    }
    this.wasQuiet = isQuiet;
  }

  /**
   * Drain all buffered notifications (cleared from SQLite) and deliver them as a
   * single aggregated chat message. Public so a digest/quiet-end hook can call
   * it explicitly in addition to the background timer.
   */
  async drainBufferedNotifications(now: number = Date.now()): Promise<void> {
    const buffered = this.quietHoursManager.drainBuffer();
    if (buffered.length === 0) return;

    const lines = buffered.map(
      (n) => `**[${n.urgency.toUpperCase()}]** ${n.title}${n.actionHint ? `\n> ${n.actionHint}` : ""}`,
    );
    const markdown = `**Buffered during quiet hours (${buffered.length})**\n\n${lines.join("\n\n")}`;

    const deliveredTo: string[] = [];
    if (this.channelSender && this.chatId) {
      try {
        await this.channelSender.sendMarkdown(this.chatId, markdown);
        deliveredTo.push("chat");
      } catch (err) {
        getLoggerSafe().warn("Quiet-hours buffer drain send failed", {
          chatId: this.chatId,
          count: buffered.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logToHistory(
      {
        level: "low",
        title: `Buffered during quiet hours (${buffered.length})`,
        message: markdown,
        timestamp: now,
      },
      deliveredTo,
    );
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
      const safeHandler = (payload: DaemonEventMap[K]): void => {
        try {
          const result = handler(payload);
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch((err) => {
              getLoggerSafe().warn("Notification handler error", {
                event,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        } catch (err) {
          getLoggerSafe().warn("Notification handler sync error", {
            event,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };
      this.eventBus.on(event, safeHandler);
      this.listeners.push({ event, fn: safeHandler });
    };

    subscribe("daemon:tick", (e) => {
      this.notify({
        level: "silent",
        title: "Heartbeat tick",
        message: `Daemon tick at ${new Date(e.timestamp).toISOString()}`,
        sourceEvent: "daemon:tick",
        timestamp: e.timestamp,
      });
    });

    subscribe("daemon:trigger_fired", (e) => {
      this.notify({
        level: "low",
        title: `Trigger fired: ${e.triggerName}`,
        // Approval-only triggers submit no task; say so instead of printing
        // "task undefined" (audited 2026-09-02).
        message: e.taskId
          ? `Trigger '${e.triggerName}' fired, task ${e.taskId}`
          : `Trigger '${e.triggerName}' fired; no task submitted (approval-only)`,
        sourceEvent: "daemon:trigger_fired",
        timestamp: e.timestamp,
      });
    });

    subscribe("daemon:trigger_failed", (e) => {
      this.notify({
        level: "medium",
        title: `Trigger failed: ${e.triggerName}`,
        message: `Trigger '${e.triggerName}' failed: ${e.error}`,
        actionHint: `Run: strada daemon reset ${e.triggerName}`,
        sourceEvent: "daemon:trigger_failed",
        timestamp: e.timestamp,
      });
    });

    subscribe("daemon:budget_warning", (e) => {
      this.notify({
        level: "medium",
        title: `Budget at ${Math.round(e.pct * 100)}%`,
        message: `Budget usage: $${e.usedUsd.toFixed(2)} / $${e.limitUsd.toFixed(2)}`,
        actionHint: "Run: strada daemon budget reset",
        sourceEvent: "daemon:budget_warning",
        timestamp: e.timestamp,
      });
    });

    subscribe("daemon:budget_exceeded", (e) => {
      this.notify({
        level: "high",
        title: "Budget exceeded",
        message: `Budget exhausted: $${e.usedUsd.toFixed(2)} / $${e.limitUsd.toFixed(2)}`,
        actionHint: "Run: strada daemon budget reset",
        sourceEvent: "daemon:budget_exceeded",
        timestamp: e.timestamp,
      });
    });

    subscribe("daemon:approval_requested", (e) => {
      this.notify({
        level: "medium",
        title: `Approval needed: ${e.toolName}`,
        message: `Write operation '${e.toolName}' requires approval (ID: ${e.approvalId})`,
        actionHint: `Run: strada daemon approve ${e.approvalId}`,
        sourceEvent: "daemon:approval_requested",
        timestamp: e.timestamp,
      });
    });

    subscribe("daemon:approval_decided", (e) => {
      this.notify({
        level: "low",
        title: `Approval ${e.decision}: ${e.approvalId}`,
        message: `Approval ${e.approvalId} was ${e.decision}`,
        sourceEvent: "daemon:approval_decided",
        timestamp: e.timestamp,
      });
    });

    subscribe("goal:failed", (e) => {
      this.notify({
        level: "high",
        title: `Goal failed: ${e.error}`,
        message: `Goal ${e.rootId} failed after ${e.failureCount} failures: ${e.error}`,
        sourceEvent: "goal:failed",
        timestamp: e.timestamp,
        chatId: e.chatId,
        channelType: e.channelType,
      });
    });

    subscribe("goal:complete", (e) => {
      this.notify({
        level: "low",
        title: `Goal complete: ${e.taskDescription}`,
        message: `Goal '${e.taskDescription}' completed in ${Math.round(e.durationMs / 1000)}s`,
        sourceEvent: "goal:complete",
        timestamp: e.timestamp,
        chatId: e.chatId,
        channelType: e.channelType,
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

  private formatNotification(payload: NotificationPayload): string {
    let md = `**[${payload.level.toUpperCase()}]** ${payload.title}\n\n${payload.message}`;
    if (payload.actionHint) {
      md += `\n\n> ${payload.actionHint}`;
    }
    return md;
  }
}
