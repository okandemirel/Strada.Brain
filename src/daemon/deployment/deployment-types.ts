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

/** Deployment subsystem configuration (maps to DEPLOY_* env vars): declared in config, the foundation layer. */
export type { DeploymentConfig } from "../../config/subsystem-config-types.js";

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
  | "rollback_completed"
  | "rollback_failed"
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
