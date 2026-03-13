/**
 * Deployment Subsystem Types
 *
 * Interfaces for deployment readiness detection, execution, and logging.
 * Used by: ReadinessChecker, DeploymentExecutor, DeployTrigger, Dashboard, CLI
 *
 * Requirements: DEPLOY-01 (readiness detection), DEPLOY-02 (human approval),
 *               DEPLOY-03 (disabled by default)
 */

import type { CircuitState } from "../daemon-types.js";

// =============================================================================
// CONFIGURATION
// =============================================================================

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
}

// =============================================================================
// READINESS
// =============================================================================

/** Result of a readiness check */
export interface ReadinessResult {
  /** Whether the project is ready for deployment */
  readonly ready: boolean;
  /** Human-readable reason when not ready */
  readonly reason?: string;
  /** Whether the test command passed */
  readonly testPassed: boolean;
  /** Whether git working directory is clean */
  readonly gitClean: boolean;
  /** Whether the current branch matches targetBranch */
  readonly branchMatch: boolean;
  /** Timestamp of this check */
  readonly timestamp: number;
  /** Whether this result was returned from cache */
  readonly cached: boolean;
}

// =============================================================================
// EXECUTION
// =============================================================================

/** Result of a deployment script execution */
export interface DeployResult {
  /** Whether the deployment succeeded (exit code 0) */
  readonly success: boolean;
  /** Process exit code (null if killed by signal) */
  readonly exitCode: number | null;
  /** Signal that killed the process (null if exited normally) */
  readonly signal: string | null;
  /** Captured stdout (capped at 10KB) */
  readonly stdout: string;
  /** Captured stderr (capped at 10KB) */
  readonly stderr: string;
  /** Execution duration in ms */
  readonly durationMs: number;
}

// =============================================================================
// LOGGING
// =============================================================================

/** Status of a deployment log entry */
export type DeploymentStatus =
  | "proposed"
  | "approved"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled"
  | "post_verify_failed";

/** A single deployment log entry stored in SQLite */
export interface DeploymentLogEntry {
  readonly id: string;
  readonly proposedAt: number;
  readonly approvedAt?: number;
  readonly approvedBy?: string;
  readonly agentId?: string;
  readonly status: DeploymentStatus;
  readonly scriptOutput?: string;
  readonly duration?: number;
  readonly error?: string;
}

// =============================================================================
// STATISTICS
// =============================================================================

/** Aggregate deployment statistics */
export interface DeploymentStats {
  readonly totalDeployments: number;
  readonly successful: number;
  readonly failed: number;
  readonly lastDeployment?: DeploymentLogEntry;
  readonly circuitBreakerState: CircuitState;
}
