/**
 * Daemon Event Map
 *
 * Typed event definitions for the daemon subsystem, compatible with TypedEventBus.
 * Events cover the full daemon lifecycle: heartbeat ticks, trigger fires/failures,
 * budget warnings/exceeded, and approval request/decision flow.
 */

import type { ApprovalStatus, CircuitState } from "./daemon-types.js";
import type { GoalStatus } from "../goals/types.js";

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

/** Unified budget warning event */
export interface UnifiedBudgetWarningEvent {
  readonly source: string;
  readonly pct: number;
  readonly usedUsd: number;
  readonly limitUsd: number;
}

/** Unified budget exceeded event */
export interface UnifiedBudgetExceededEvent {
  readonly source: string;
  readonly pct: number;
  readonly usedUsd: number;
  readonly limitUsd: number;
  readonly isGlobal: boolean;
}

/** Budget sub-limit exceeded event */
export interface BudgetSubExceededEvent {
  readonly source: string;
  readonly sourceId?: string;
  readonly usedUsd: number;
  readonly limitUsd: number;
}

/** Budget config updated event */
export interface BudgetConfigUpdatedEvent {
  readonly config: {
    readonly dailyLimitUsd: number;
    readonly monthlyLimitUsd: number;
    readonly warnPct: number;
  };
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
// GOAL LIFECYCLE EVENT TYPES (Phase 16)
// =============================================================================

/** Emitted when a goal tree starts execution */
export interface GoalStartedEvent {
  readonly rootId: string;
  readonly taskDescription: string;
  readonly nodeCount: number;
  readonly estimatedMinutes?: number;
  readonly timestamp: number;
}

/** Emitted when a wave of parallel goal nodes completes */
export interface GoalWaveCompleteEvent {
  readonly rootId: string;
  readonly waveIndex: number;
  readonly completedCount: number;
  readonly totalCount: number;
  readonly timestamp: number;
}

/** Emitted when a single goal node completes */
export interface GoalNodeCompleteEvent {
  readonly rootId: string;
  readonly nodeId: string;
  readonly task: string;
  readonly status: GoalStatus;
  readonly timestamp: number;
}

/** Emitted when a goal fails (node failure or budget exceeded) */
export interface GoalFailedEvent {
  readonly rootId: string;
  readonly error: string;
  readonly failureCount: number;
  readonly timestamp: number;
}

/** Emitted when a goal tree completes successfully */
export interface GoalCompleteEvent {
  readonly rootId: string;
  readonly taskDescription: string;
  readonly durationMs: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly timestamp: number;
}

// =============================================================================
// REPORTING EVENT TYPES (Phase 18)
// =============================================================================

/** Emitted when a digest report is sent to a channel */
export interface DigestSentEvent {
  readonly channelType: string;
  readonly sectionCount: number;
  readonly truncated: boolean;
  readonly timestamp: number;
}

/** Emitted when a notification is routed (delivered or buffered) */
export interface NotificationRoutedEvent {
  readonly urgency: string;
  readonly title: string;
  readonly deliveredTo: string[];
  readonly buffered: boolean;
  readonly timestamp: number;
}

// =============================================================================
// MAINTENANCE EVENT TYPES (Phase 21)
// =============================================================================

/** Emitted when a daemon maintenance task completes (e.g., pruning) */
export interface DaemonMaintenanceEvent {
  readonly type: string;
  readonly count: number;
  readonly timestamp: number;
}

// =============================================================================
// DEPLOYMENT EVENT TYPES (Phase 25)
// =============================================================================

/** Emitted when a deployment is proposed via ApprovalQueue */
export interface DeployProposedEvent {
  readonly proposalId: string;
  readonly agentId?: string;
  readonly timestamp: number;
}

/** Emitted when a deployment proposal is approved */
export interface DeployApprovedEvent {
  readonly proposalId: string;
  readonly approvedBy?: string;
  readonly timestamp: number;
}

/** Emitted when deployment script execution starts */
export interface DeployStartedEvent {
  readonly proposalId: string;
  readonly scriptPath: string;
  readonly timestamp: number;
}

/** Emitted when a deployment completes successfully */
export interface DeployCompletedEvent {
  readonly proposalId: string;
  readonly durationMs: number;
  readonly timestamp: number;
}

/** Emitted when a deployment fails */
export interface DeployFailedEvent {
  readonly proposalId: string;
  readonly error: string;
  readonly timestamp: number;
}

// =============================================================================
// EVENT MAP
// =============================================================================

/** Map of daemon event names to their payload types */
export interface DaemonEventMap {
  [key: string]: unknown;
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
  "goal:started": GoalStartedEvent;
  "goal:wave_complete": GoalWaveCompleteEvent;
  "goal:node_complete": GoalNodeCompleteEvent;
  "goal:failed": GoalFailedEvent;
  "goal:complete": GoalCompleteEvent;
  "daemon:digest_sent": DigestSentEvent;
  "daemon:notification_routed": NotificationRoutedEvent;
  "daemon:maintenance": DaemonMaintenanceEvent;
  "deploy:proposed": DeployProposedEvent;
  "deploy:approved": DeployApprovedEvent;
  "deploy:started": DeployStartedEvent;
  "deploy:completed": DeployCompletedEvent;
  "deploy:failed": DeployFailedEvent;
  "budget:warning": UnifiedBudgetWarningEvent;
  "budget:exceeded": UnifiedBudgetExceededEvent;
  "budget:sub_exceeded": BudgetSubExceededEvent;
  "budget:config_updated": BudgetConfigUpdatedEvent;
}
