/**
 * IterationHealthTracker — per-task provider health tracking with sliding window
 * failure rate, exponential backoff, and status levels.
 *
 * Used by the orchestrator to decide whether to retry, ask the user, or abort
 * when provider calls fail during an iteration loop.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BACKOFF_SCHEDULE_MS = [0, 10_000, 30_000, 60_000, 120_000] as const;
export const ABORT_FAILURE_RATE = 0.6;
export const ASK_USER_CONSECUTIVE = 3;
export const ABORT_CONSECUTIVE = 3;
export const SLIDING_WINDOW_SIZE = 10;

/** Failure rate at which ask_user is suggested (below abort threshold). */
const ASK_USER_FAILURE_RATE = 0.4;

/**
 * Minimum number of results in the sliding window before the failure-rate
 * threshold is considered meaningful. Without this guard the very first
 * failure would yield a 100% rate and immediately trigger ask_user.
 */
const MIN_WINDOW_FOR_RATE = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailureAction =
  | { kind: "retry"; backoffMs: number }
  | { kind: "ask_user"; backoffMs: number }
  | { kind: "abort"; reason: string };

export type StatusLevel = "ok" | "degraded" | "critical";

export interface HealthResult {
  readonly success: boolean;
  readonly timestamp: number;
  readonly provider?: string;
}

// ---------------------------------------------------------------------------
// IterationHealthTracker
// ---------------------------------------------------------------------------

export class IterationHealthTracker {
  private readonly results: HealthResult[] = [];
  private consecutiveFailures = 0;
  private totalFailures = 0;
  private backoffIndex = 0;
  private readonly taskStartedAt: number;

  constructor(taskStartedAt: number = Date.now()) {
    this.taskStartedAt = taskStartedAt;
  }

  // -----------------------------------------------------------------------
  // Recording
  // -----------------------------------------------------------------------

  recordFailure(provider: string): FailureAction {
    this.consecutiveFailures++;
    this.totalFailures++;
    this.results.push({ success: false, timestamp: Date.now(), provider });

    const backoffMs: number =
      BACKOFF_SCHEDULE_MS[
        Math.min(this.backoffIndex, BACKOFF_SCHEDULE_MS.length - 1)
      ] ?? 0;
    this.backoffIndex++;

    if (this.shouldAbort()) {
      return {
        kind: "abort",
        reason: `Failure rate ${(this.getFailureRate() * 100).toFixed(0)}% with ${this.consecutiveFailures} consecutive failures`,
      };
    }

    const rateTriggered =
      this.results.length >= MIN_WINDOW_FOR_RATE &&
      this.getFailureRate() >= ASK_USER_FAILURE_RATE;

    if (this.consecutiveFailures >= ASK_USER_CONSECUTIVE || rateTriggered) {
      return { kind: "ask_user", backoffMs };
    }

    return { kind: "retry", backoffMs };
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.backoffIndex = 0;
    this.results.push({ success: true, timestamp: Date.now() });
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  getBackoffMs(): number {
    if (this.consecutiveFailures === 0) return 0;
    return BACKOFF_SCHEDULE_MS[
      Math.min(this.backoffIndex, BACKOFF_SCHEDULE_MS.length - 1)
    ] ?? 0;
  }

  getFailureRate(): number {
    const window = this.results.slice(-SLIDING_WINDOW_SIZE);
    if (window.length === 0) return 0;
    const failures = window.filter((r) => !r.success).length;
    return failures / window.length;
  }

  shouldAbort(): boolean {
    return (
      this.results.length >= MIN_WINDOW_FOR_RATE &&
      this.getFailureRate() >= ABORT_FAILURE_RATE &&
      this.consecutiveFailures >= ABORT_CONSECUTIVE
    );
  }

  getStatusLevel(): StatusLevel {
    if (this.consecutiveFailures === 0) return "ok";
    if (this.consecutiveFailures <= 2) return "degraded";
    return "critical";
  }

  getTaskDurationMs(): number {
    return Date.now() - this.taskStartedAt;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getTotalFailures(): number {
    return this.totalFailures;
  }
}
