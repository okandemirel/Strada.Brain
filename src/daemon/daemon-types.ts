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

/** Metadata describing a registered trigger */
export interface TriggerMetadata {
  readonly name: string;
  readonly description: string;
  readonly type: string;
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
}

/** Parsed trigger definition from HEARTBEAT.md */
export interface HeartbeatTriggerDef {
  name: string;
  cron: string;
  action: string;
  timeout?: number;
  enabled?: boolean;
}

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

/** Complete daemon configuration -- added to Config interface */
export interface DaemonConfig {
  readonly heartbeat: DaemonHeartbeatConfig;
  readonly security: DaemonSecurityConfig;
  readonly budget: DaemonBudgetConfig;
  readonly backoff: DaemonBackoffConfig;
  readonly timezone: string;
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
