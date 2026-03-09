/**
 * Daemon Event Map
 *
 * Typed event definitions for the daemon subsystem, compatible with TypedEventBus.
 * Events cover the full daemon lifecycle: heartbeat ticks, trigger fires/failures,
 * budget warnings/exceeded, and approval request/decision flow.
 */

import type { ApprovalStatus, CircuitState } from "./daemon-types.js";

// =============================================================================
// EVENT PAYLOAD TYPES
// =============================================================================

/** Emitted on each heartbeat tick */
export interface DaemonTickEvent {
  readonly timestamp: number;
  readonly triggerCount: number;
}

/** Emitted when a trigger fires and submits a task */
export interface TriggerFiredEvent {
  readonly triggerName: string;
  readonly taskId: string;
  readonly timestamp: number;
}

/** Emitted when a trigger evaluation or fire fails */
export interface TriggerFailedEvent {
  readonly triggerName: string;
  readonly error: string;
  readonly circuitState: CircuitState;
  readonly timestamp: number;
}

/** Emitted when budget usage crosses the warning threshold */
export interface BudgetWarningEvent {
  readonly usedUsd: number;
  readonly limitUsd: number;
  readonly pct: number;
  readonly timestamp: number;
}

/** Emitted when budget is fully exhausted */
export interface BudgetExceededEvent {
  readonly usedUsd: number;
  readonly limitUsd: number;
  readonly timestamp: number;
}

/** Emitted when a write operation is queued for approval */
export interface ApprovalRequestedEvent {
  readonly approvalId: string;
  readonly toolName: string;
  readonly triggerName?: string;
  readonly timestamp: number;
}

/** Emitted when an approval is decided (approved, denied, or expired) */
export interface ApprovalDecidedEvent {
  readonly approvalId: string;
  readonly decision: ApprovalStatus;
  readonly decidedBy?: string;
  readonly timestamp: number;
}

/** Emitted when a file-watch trigger detects file changes */
export interface FileChangeEvent {
  readonly triggerName: string;
  readonly paths: string[];
  readonly eventTypes: string[];
  readonly timestamp: number;
}

/** Emitted when checklist items become due */
export interface ChecklistDueEvent {
  readonly triggerName: string;
  readonly items: ReadonlyArray<{ text: string; priority: string }>;
  readonly timestamp: number;
}

/** Emitted when a webhook trigger receives an HTTP POST */
export interface WebhookReceivedEvent {
  readonly triggerName: string;
  readonly action: string;
  readonly source?: string;
  readonly timestamp: number;
}

/** Emitted when a trigger action is suppressed by deduplication */
export interface TriggerDeduplicatedEvent {
  readonly triggerName: string;
  readonly reason: "cooldown" | "content_duplicate";
  readonly timestamp: number;
}

// =============================================================================
// EVENT MAP
// =============================================================================

/** Map of daemon event names to their payload types */
export interface DaemonEventMap {
  "daemon:tick": DaemonTickEvent;
  "daemon:trigger_fired": TriggerFiredEvent;
  "daemon:trigger_failed": TriggerFailedEvent;
  "daemon:budget_warning": BudgetWarningEvent;
  "daemon:budget_exceeded": BudgetExceededEvent;
  "daemon:approval_requested": ApprovalRequestedEvent;
  "daemon:approval_decided": ApprovalDecidedEvent;
  "daemon:file_change": FileChangeEvent;
  "daemon:checklist_due": ChecklistDueEvent;
  "daemon:webhook_received": WebhookReceivedEvent;
  "daemon:trigger_deduplicated": TriggerDeduplicatedEvent;
}
