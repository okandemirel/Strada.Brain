/**
 * The shapes of the Config sections whose subsystems sit above config.
 *
 * config is a foundation module: every module may import it, so it may import
 * only the foundation (types, utils, common, security). These sections used
 * to be declared in the subsystems that read them (agents, daemon, learning,
 * supervisor), which made config import upward and tied every config reader
 * to those modules. They are declared here now, and each subsystem re-exports
 * them from its own types file, so its importers keep their path.
 *
 * Types only: nothing here runs.
 */

// =============================================================================
// AGENTS (multi-agent and delegation)
// =============================================================================

/** Multi-agent subsystem configuration */
export interface AgentConfig {
  readonly enabled: boolean;
  readonly defaultBudgetUsd: number;
  readonly maxConcurrent: number;
  readonly idleTimeoutMs: number;
  readonly maxMemoryEntries: number;
}

/** Model tier for delegation routing */
export type ModelTier = "local" | "cheap" | "standard" | "premium";

/** Configuration for a single delegation type */
export interface DelegationTypeConfig {
  readonly name: string;
  readonly tier: ModelTier;
  readonly timeoutMs: number;
  readonly maxIterations: number;
  readonly systemPrompt?: string;
}

/** Top-level delegation subsystem configuration */
export interface DelegationConfig {
  readonly enabled: boolean;
  readonly maxDepth: number;
  readonly maxConcurrentPerParent: number;
  readonly tiers: Record<ModelTier, string>;
  readonly types: DelegationTypeConfig[];
  readonly verbosity: "quiet" | "normal" | "verbose";
}

// =============================================================================
// DAEMON
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

/**
 * What `dailyBudgetUsd` is a cap on: "daemon" when it is a dedicated daemon
 * sub-limit (STRADA_DAEMON_DAILY_BUDGET set), "system" when the daemon shares
 * the system-wide wallet (the STRADA_BUDGET_DAILY_USD fallback).
 */
export type DaemonBudgetScope = "daemon" | "system";

/** Daily LLM budget configuration */
export interface DaemonBudgetConfig {
  readonly dailyBudgetUsd: number | undefined;
  readonly warnPct: number;
  /** Defaults to "system" when absent — the shared-wallet reading. */
  readonly limitScope?: DaemonBudgetScope;
}

/** Exponential backoff and circuit breaker configuration */
export interface DaemonBackoffConfig {
  readonly baseCooldownMs: number;
  readonly maxCooldownMs: number;
  readonly failureThreshold: number;
}

/** Phase 15 trigger-specific configuration */
export interface DaemonTriggersConfig {
  /** Webhook authentication secret (STRADA_WEBHOOK_SECRET) */
  readonly webhookSecret?: string;
  /** Webhook rate limit string e.g. '10/min' (STRADA_WEBHOOK_RATE_LIMIT) */
  readonly webhookRateLimit: string;
  /** Global cross-trigger dedup window in ms (STRADA_DAEMON_DEDUP_WINDOW_MS) */
  readonly dedupWindowMs: number;
  /** Default file watch debounce in ms (STRADA_DAEMON_DEFAULT_DEBOUNCE_MS) */
  readonly defaultDebounceMs: number;
  /** Hour for 'every morning' checklist items (STRADA_CHECKLIST_MORNING_HOUR) */
  readonly checklistMorningHour: number;
  /** Hour for 'every afternoon' checklist items (STRADA_CHECKLIST_AFTERNOON_HOUR) */
  readonly checklistAfternoonHour: number;
  /** Hour for 'every evening' checklist items (STRADA_CHECKLIST_EVENING_HOUR) */
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

/** Five-level urgency classification for notifications */
export type UrgencyLevel = "silent" | "low" | "medium" | "high" | "critical";

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

/** Deployment subsystem configuration (maps to DEPLOY_* env vars) */
export interface DeploymentConfig {
  /** Master switch -- defaults to false per DEPLOY-03 */
  readonly enabled: boolean;
  /** Path to deployment script (optional, validated at runtime against projectRoot) */
  readonly scriptPath?: string;
  /** Test command to run for readiness check */
  readonly testCommand: string;
  /** Git branch required for deployment */
  readonly targetBranch: string;
  /** Whether clean git state is required */
  readonly requireCleanGit: boolean;
  /** Timeout for test command in ms */
  readonly testTimeoutMs: number;
  /** Timeout for deployment script execution in ms */
  readonly executionTimeoutMs: number;
  /** Cooldown after rejection before re-proposing, in minutes */
  readonly cooldownMinutes: number;
  /** Notification urgency for deployment proposals */
  readonly notificationUrgency: "low" | "medium" | "high" | "critical";
  /** Optional post-deploy verification script path */
  readonly postScriptPath?: string;
  /** Optional rollback script path executed when deployment fails */
  readonly rollbackScriptPath?: string;
}

// =============================================================================
// LEARNING
// =============================================================================

/** Scope filter mode for cross-session retrieval */
export type ScopeFilterMode = 'project-only' | 'project+universal' | 'all';

/** Cross-session learning configuration */
export interface CrossSessionConfig {
  readonly enabled: boolean;
  readonly maxAgeDays: number;
  readonly scopeFilter: ScopeFilterMode;
  readonly recencyBoost: number;
  readonly scopeBoost: number;
  readonly promotionThreshold: number;
}

/** Confidence system configuration (hybrid weighted scoring with alpha/beta evidence tracking) */
export interface BayesianConfig {
  /** Master toggle for confidence system */
  readonly enabled: boolean;
  /** Threshold below which instinct is deprecated */
  readonly deprecatedThreshold: number;
  /** Threshold to become active */
  readonly activeThreshold: number;
  /** Threshold for evolution consideration */
  readonly evolutionThreshold: number;
  /** Auto-evolution threshold */
  readonly autoEvolveThreshold: number;
  /** Maximum initial confidence for new instincts */
  readonly maxInitial: number;
  /** Cooling period in days before deprecation */
  readonly coolingPeriodDays: number;
  /** Minimum total observations before cooling can start */
  readonly coolingMinObservations: number;
  /** Maximum consecutive failures during cooling before deprecation */
  readonly coolingMaxFailures: number;
  /** Minimum observations for permanent promotion */
  readonly promotionMinObservations: number;
  /** Verdict score for clean success (no retries) */
  readonly verdictCleanSuccess: number;
  /** Verdict score for retry success */
  readonly verdictRetrySuccess: number;
  /** Verdict score for hard failure */
  readonly verdictFailure: number;
}

/** Configuration for chain resilience features */
export interface ChainResilienceConfig {
  readonly rollbackEnabled: boolean;
  readonly parallelEnabled: boolean;
  readonly maxParallelBranches: number;
  readonly compensationTimeoutMs: number;
}

/**
 * Configuration for the tool chain synthesis system.
 * All fields are configurable via environment variables.
 */
export interface ToolChainConfig {
  /** Master toggle for tool chain detection and synthesis */
  readonly enabled: boolean;
  /** Minimum occurrences before a chain is considered for synthesis */
  readonly minOccurrences: number;
  /** Minimum success rate threshold for chain synthesis */
  readonly successRateThreshold: number;
  /** Maximum number of active composite tools */
  readonly maxActive: number;
  /** Maximum age in days before a chain is invalidated */
  readonly maxAgeDays: number;
  /** Maximum LLM calls per detection cycle */
  readonly llmBudgetPerCycle: number;
  /** Minimum number of tools in a chain */
  readonly minChainLength: number;
  /** Maximum number of tools in a chain */
  readonly maxChainLength: number;
  /** Interval between detection cycles in milliseconds */
  readonly detectionIntervalMs: number;
  /** Chain resilience configuration (Phase 22) */
  readonly resilience: ChainResilienceConfig;
}

// =============================================================================
// SUPERVISOR
// =============================================================================

/** Configuration for the verification subsystem */
export interface VerificationConfig {
  readonly mode: "always" | "critical-only" | "sampling" | "disabled";
  readonly samplingRate: number;
  readonly preferDifferentProvider: boolean;
  readonly maxVerificationCost: number;
}

/** Top-level configuration for the Supervisor Brain */
export interface SupervisorConfig {
  readonly enabled: boolean;
  readonly complexityThreshold: "moderate" | "complex";
  readonly maxParallelNodes: number;
  readonly nodeTimeoutMs: number;
  readonly verificationMode: VerificationConfig["mode"];
  readonly verificationBudgetPct: number;
  readonly triageProvider: string;
  readonly maxFailureBudget: number;
  readonly diversityCap: number;
}
