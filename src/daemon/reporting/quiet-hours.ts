/**
 * QuietHoursManager -- Handles quiet hours logic and notification buffering.
 *
 * During configured quiet hours, non-critical notifications are buffered in
 * SQLite via DaemonStorage. Critical notifications always bypass quiet hours.
 * At quiet hours end, buffered notifications can be drained as one aggregated message.
 *
 * Overnight ranges (e.g., 22:00-08:00) are supported: when startHour > endHour,
 * quiet = (hour >= start || hour < end).
 */

import type { DaemonStorage } from "../daemon-storage.js";
import type {
  UrgencyLevel,
  QuietHoursConfig,
  NotificationPayload,
  BufferedNotification,
} from "./notification-types.js";
import { URGENCY_ORDER } from "./notification-types.js";

// =============================================================================
// QUIET HOURS MANAGER
// =============================================================================

export interface QuietHoursManagerDeps {
  readonly config: QuietHoursConfig;
  readonly storage: DaemonStorage;
}

export class QuietHoursManager {
  private readonly config: QuietHoursConfig;
  private readonly storage: DaemonStorage;

  constructor(deps: QuietHoursManagerDeps) {
    this.config = deps.config;
    this.storage = deps.storage;
  }

  /**
   * Check if the current time falls within quiet hours.
   * Uses Intl.DateTimeFormat to convert to the configured timezone.
   * Returns false if quiet hours are disabled.
   */
  isQuietHours(now?: Date): boolean {
    if (!this.config.enabled) return false;

    const date = now ?? new Date();
    const hour = this.getLocalHour(date);
    const { startHour, endHour } = this.config;

    if (startHour > endHour) {
      // Overnight range: e.g., 22:00-08:00
      return hour >= startHour || hour < endHour;
    }

    // Same-day range: e.g., 14:00-18:00
    return hour >= startHour && hour < endHour;
  }

  /**
   * Check if a given urgency level should bypass quiet hours.
   * Only 'critical' bypasses quiet hours per discretion recommendation.
   */
  shouldBypass(level: UrgencyLevel): boolean {
    return level === "critical";
  }

  /**
   * Buffer a notification for later delivery.
   * After insertion, prunes buffer to config.bufferMax, protecting high/critical.
   */
  bufferNotification(notification: NotificationPayload): void {
    this.storage.insertNotificationBuffer({
      urgency: notification.level,
      title: notification.title,
      message: notification.message,
      actionHint: notification.actionHint,
      sourceEvent: notification.sourceEvent,
      createdAt: notification.timestamp,
    });

    this.storage.pruneNotificationBuffer(this.config.bufferMax, ["high", "critical"]);
  }

  /**
   * Drain all buffered notifications, clearing the buffer.
   * Returns sorted by urgency (critical first) then timestamp ascending.
   */
  drainBuffer(): BufferedNotification[] {
    const buffered = this.storage.getBufferedNotifications();
    this.storage.clearNotificationBuffer();

    // Sort: highest urgency first, then by timestamp ascending within same urgency
    return buffered.sort((a, b) => {
      const urgencyDiff = URGENCY_ORDER[b.urgency] - URGENCY_ORDER[a.urgency];
      if (urgencyDiff !== 0) return urgencyDiff;
      return a.createdAt - b.createdAt;
    });
  }

  /**
   * Get the local hour in the configured timezone using Intl.DateTimeFormat.
   */
  private getLocalHour(date: Date): number {
    const formatter = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: this.config.timezone,
    });
    const parts = formatter.formatToParts(date);
    const hourPart = parts.find((p) => p.type === "hour");
    return hourPart ? parseInt(hourPart.value, 10) : date.getUTCHours();
  }
}
