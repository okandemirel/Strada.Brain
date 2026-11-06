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

/** Key/value state one trigger keeps across daemon restarts (backed by daemon_state). */
export interface TriggerStateStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** Pluggable trigger interface -- CronTrigger implements this in Plan 02 */
export interface ITrigger {
  readonly metadata: TriggerMetadata;
  /** Pure deterministic check -- no side effects, no LLM calls */
  shouldFire(now: Date): boolean;
  /** Called after successful fire to update internal state */
  onFired(now: Date): void;
  /**
   * The description onFired(now) WOULD publish, computed without side effects.
   * Triggers that rewrite `metadata.description` in onFired implement this so
   * content dedup can judge the fire being evaluated (audited 2026-09-02:
   * hashing metadata.description before onFired judged the PREVIOUS fire).
   */
  previewFireDescription?(now: Date): string;
  /**
   * The fire did NOT become work: the submission threw.
   *
   * A trigger that CONSUMES something when it fires — a checklist item fires
   * once — must be able to put it back, or the item is gone and the work
   * never runs (Codex 2026-09-13 AG#12).
   */
  onSubmitFailed?(now: Date): void;
  /**
   * Durable state for "fire once" / "since the last look" semantics, which
   * an in-memory field loses on every restart (TSK-11, TSK-17). HeartbeatLoop
   * attaches a store scoped to this trigger before its first evaluation.
   */
  attachStateStore?(store: TriggerStateStore): void;
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

/** The daemon's configuration and its sections: declared in config, the foundation layer. */
export type {
  DaemonHeartbeatConfig,
  DaemonSecurityConfig,
  DaemonBudgetScope,
  DaemonBudgetConfig,
  DaemonBackoffConfig,
  DaemonTriggersConfig,
  DaemonConfig,
} from "../config/subsystem-config-types.js";

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
