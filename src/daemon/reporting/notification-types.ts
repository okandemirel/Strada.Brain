/**
 * Notification Types for Phase 18: Dual Reporting + Dashboard
 *
 * Defines urgency levels, notification payloads, routing config,
 * quiet hours config, digest config, and storage entry types.
 */

// =============================================================================
// URGENCY LEVELS
// =============================================================================

/** Five-level urgency classification for notifications */
export type UrgencyLevel = "silent" | "low" | "medium" | "high" | "critical";

/** Numeric priority mapping for urgency comparison (silent=0, critical=4) */
export const URGENCY_ORDER: Record<UrgencyLevel, number> = {
  silent: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
} as const;

// =============================================================================
// NOTIFICATION PAYLOADS
// =============================================================================

/** Payload for a single notification */
export interface NotificationPayload {
  readonly level: UrgencyLevel;
  readonly title: string;
  readonly message: string;
  readonly actionHint?: string;
  readonly sourceEvent?: string;
  readonly timestamp: number;
}

// =============================================================================
// CONFIG TYPES
// =============================================================================

/** Notification routing configuration */
export interface NotificationConfig {
  readonly minLevel: UrgencyLevel;
  readonly routing: Record<UrgencyLevel, string[]>;
  readonly groupingWindowMs: number;
}

/** Quiet hours configuration */
export interface QuietHoursConfig {
  readonly enabled: boolean;
  readonly startHour: number;
  readonly endHour: number;
  readonly timezone: string;
  readonly bufferMax: number;
}

/** Digest report configuration */
export interface DigestConfig {
  readonly enabled: boolean;
  readonly schedule: string;
  readonly timezone: string;
  readonly dashboardHistoryDepth: number;
}

// =============================================================================
// STORAGE ENTRY TYPES
// =============================================================================

/** Notification history entry (persisted in SQLite) */
export interface NotificationHistoryEntry {
  readonly id: number;
  readonly urgency: UrgencyLevel;
  readonly title: string;
  readonly message: string;
  readonly deliveredTo: string[];
  readonly createdAt: number;
}

/** Buffered notification (quiet hours buffer in SQLite) */
export interface BufferedNotification {
  readonly id: number;
  readonly urgency: UrgencyLevel;
  readonly title: string;
  readonly message: string;
  readonly actionHint?: string;
  readonly sourceEvent?: string;
  readonly createdAt: number;
}

/** Trigger fire history entry for dashboard */
export interface TriggerFireHistoryEntry {
  readonly id: number;
  readonly triggerName: string;
  readonly result: "success" | "failure" | "deduplicated";
  readonly durationMs?: number;
  readonly taskId?: string;
  readonly timestamp: number;
}
