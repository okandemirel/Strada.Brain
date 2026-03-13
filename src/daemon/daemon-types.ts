/**
 * Daemon Subsystem Types
 *
 * Foundational type definitions for the daemon heartbeat loop, trigger system,
 * security policy, budget tracking, and circuit breaker resilience.
 *
 * Used by: HeartbeatLoop, TriggerRegistry, DaemonSecurityPolicy,
 *          BudgetTracker, CircuitBreaker, DaemonStorage, DaemonCLI
 */

// =============================================================================
// TASK ORIGIN
// =============================================================================

/** Distinguishes user-initiated vs daemon-initiated tasks for security policy */
export type TaskOrigin = "user" | "daemon";

// =============================================================================
// TRIGGER TYPES
// =============================================================================

/** Possible states for a trigger in the registry */
export type TriggerState = "active" | "paused" | "backed_off" | "disabled";

/** Circuit breaker states for per-trigger failure resilience */
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/** Supported trigger types */
export type TriggerType = "cron" | "file-watch" | "checklist" | "webhook" | "deploy";

/** Metadata describing a registered trigger */
export interface TriggerMetadata {
  readonly name: string;
  readonly description: string;
  readonly type: TriggerType;
  /** Per-trigger cooldown in seconds for deduplication (TRIG-05) */
  readonly cooldownSeconds?: number;
}

/** Pluggable trigger interface -- CronTrigger implements this in Plan 02 */
export interface ITrigger {
  readonly metadata: TriggerMetadata;
  /** Pure deterministic check -- no side effects, no LLM calls */
  shouldFire(now: Date): boolean;
  /** Called after successful fire to update internal state */
  onFired(now: Date): void;
  /** Get the next scheduled fire time (for display) */
  getNextRun(): Date | null;
  /** Get current trigger state */
  getState(): TriggerState;
  /** Optional cleanup for resource-holding triggers (e.g., file watchers) */
  dispose?(): Promise<void>;
}

// =============================================================================
// HEARTBEAT TRIGGER DEFINITIONS (Discriminated Union)
// =============================================================================

/** Shared fields for all trigger definitions parsed from HEARTBEAT.md */
export interface BaseTriggerDef {
  name: string;
  action: string;
  timeout?: number;
  enabled?: boolean;
  /** Per-trigger cooldown in seconds (TRIG-05) */
  cooldown?: number;
}

/** Cron-based trigger: fires on a cron schedule */
export interface CronTriggerDef extends BaseTriggerDef {
  type: "cron";
  cron: string;
}

/** File-watch trigger: fires when files change in a watched directory */
export interface FileWatchTriggerDef extends BaseTriggerDef {
  type: "file-watch";
  /** Directory path to watch */
  path: string;
  /** Glob pattern filter (e.g., '*.cs') */
  pattern?: string;
  /** Debounce interval in ms */
  debounce?: number;
  /** Watch subdirectories (default true) */
  recursive?: boolean;
  /** Ignore patterns (e.g., ['node_modules', '.git']) */
  ignore?: string[];
}

/** A single item in a checklist trigger */
export interface ChecklistItem {
  text: string;
  checked: boolean;
  priority: "high" | "medium" | "low";
  /** Cron schedule derived from NL time reference */
  schedule?: string;
  /** Multi-line description from indented continuation lines */
  multilineDescription?: string;
}

/** Checklist trigger: fires when checklist items are due */
export interface ChecklistTriggerDef extends BaseTriggerDef {
  type: "checklist";
  items: ChecklistItem[];
}

/** Webhook trigger: fires on incoming HTTP POST (config is env-var driven) */
export interface WebhookTriggerDef extends BaseTriggerDef {
  type: "webhook";
}

/** Discriminated union of all trigger definition types */
export type HeartbeatTriggerDef =
  | CronTriggerDef
  | FileWatchTriggerDef
  | ChecklistTriggerDef
  | WebhookTriggerDef;

// =============================================================================
// DAEMON CONFIGURATION
// =============================================================================

/** Heartbeat loop timing and file configuration */
export interface DaemonHeartbeatConfig {
  readonly intervalMs: number;
  readonly heartbeatFile: string;
  readonly idlePause: boolean;
}

/** Security policy configuration for daemon-initiated tool calls */
export interface DaemonSecurityConfig {
  readonly approvalTimeoutMin: number;
  readonly autoApproveTools: string[];
}

/** Daily LLM budget configuration */
export interface DaemonBudgetConfig {
  readonly dailyBudgetUsd: number | undefined;
  readonly warnPct: number;
}

/** Exponential backoff and circuit breaker configuration */
export interface DaemonBackoffConfig {
  readonly baseCooldownMs: number;
  readonly maxCooldownMs: number;
  readonly failureThreshold: number;
}

/** Phase 15 trigger-specific configuration */
export interface DaemonTriggersConfig {
  /** Webhook authentication secret (STRATA_WEBHOOK_SECRET) */
  readonly webhookSecret?: string;
  /** Webhook rate limit string e.g. '10/min' (STRATA_WEBHOOK_RATE_LIMIT) */
  readonly webhookRateLimit: string;
  /** Global cross-trigger dedup window in ms (STRATA_DAEMON_DEDUP_WINDOW_MS) */
  readonly dedupWindowMs: number;
  /** Default file watch debounce in ms (STRATA_DAEMON_DEFAULT_DEBOUNCE_MS) */
  readonly defaultDebounceMs: number;
  /** Hour for 'every morning' checklist items (STRATA_CHECKLIST_MORNING_HOUR) */
  readonly checklistMorningHour: number;
  /** Hour for 'every afternoon' checklist items (STRATA_CHECKLIST_AFTERNOON_HOUR) */
  readonly checklistAfternoonHour: number;
  /** Hour for 'every evening' checklist items (STRATA_CHECKLIST_EVENING_HOUR) */
  readonly checklistEveningHour: number;
}

/** Complete daemon configuration -- added to Config interface */
export interface DaemonConfig {
  readonly heartbeat: DaemonHeartbeatConfig;
  readonly security: DaemonSecurityConfig;
  readonly budget: DaemonBudgetConfig;
  readonly backoff: DaemonBackoffConfig;
  readonly timezone: string;
  readonly triggers: DaemonTriggersConfig;
  /** Retention period for trigger fire history entries in days (Phase 21) */
  readonly triggerFireRetentionDays: number;
}

// =============================================================================
// APPROVAL QUEUE
// =============================================================================

/** Status of a pending approval request */
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

/** An entry in the approval queue for write operations */
export interface ApprovalEntry {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  triggerName?: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
  expiresAt: number;
}

// =============================================================================
// AUDIT LOG
// =============================================================================

/** An entry in the persistent audit log */
export interface AuditEntry {
  id: number;
  toolName: string;
  paramsSummary?: string;
  decision: string;
  decidedBy?: string;
  triggerName?: string;
  timestamp: number;
}

// =============================================================================
// DAEMON STATUS SNAPSHOT
// =============================================================================

/** Status snapshot returned by HeartbeatLoop for introspection tools and dashboard */
export interface DaemonStatusSnapshot {
  running: boolean;
  intervalMs: number;
  triggerCount: number;
  lastTick: Date | null;
  budgetUsage: { usedUsd: number; limitUsd: number | undefined; pct: number };
}

// =============================================================================
// BUDGET TRACKING
// =============================================================================

/** A cost entry for LLM budget tracking */
export interface BudgetEntry {
  id: number;
  costUsd: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  triggerName?: string;
  timestamp: number;
}
