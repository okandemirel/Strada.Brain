/**
 * Agent Core v2 — Control Plane: RunBudgetPolicy (ARCHITECTURE §2.3).
 *
 * All base numbers come from existing v1 config (config-types.ts defaults preserved as
 * the seed) and are resolved ONCE here into a RunBudgetPolicy, parameterized by mode.
 * The single surviving ratio (`taskInactivityMs >= ratio × callStallMs`) is applied here
 * as ONE guarded clamp with a logged warning — relocated from v1's scattered `Math.max`,
 * not eliminated. Every other deadline is a `min()` slice at carve time (RunClock), so a
 * config that violates ordering is clamped + surfaced, never silently honored.
 */

export type RunMode = "interactive" | "background" | "supervisor-node" | "delegate";

export interface RunBudgetPolicy {
  readonly mode: RunMode;
  /** Absolute task wall-clock ceiling (Infinity = none); the hard limit, never re-armed. */
  readonly taskHardMs: number;
  /** Task-scope silence-accumulator ceiling (total silent ms across all calls). */
  readonly taskInactivityMs: number;
  /** Per-call wait-for-first-token deadline (fast failover). */
  readonly callFirstResponseMs: number;
  /** Per-call gap-between-tokens (dead-connection) deadline, re-armed on each chunk. */
  readonly callStallMs: number;
  /** Per-call absolute wall-clock ceiling. */
  readonly callHardMs: number;
  readonly outputTokenCap: number;
  readonly costCapUsd: number;
  /** Bounded pause→retry cycles per task before a stall escalates to stop (rule 6, §2.5). */
  readonly pauseRetryBudget: number;
}

/** The v1 config defaults, threaded in by the caller (no direct config import here). */
export interface PolicySeed {
  readonly streamInitialTimeoutMs: number; // DEFAULT_LLM_STREAM_INITIAL_TIMEOUT_MS (600000)
  readonly streamStallTimeoutMs: number; // DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS (300000)
  readonly providerFirstResponseMs: number; // DEFAULT_LLM_PROVIDER_FIRST_RESPONSE_TIMEOUT_MS (90000)
  readonly taskInactivityMs: number; // DEFAULT_TASK_INACTIVITY_TIMEOUT_MS (600000)
  readonly minInactivityOverStreamRatio: number; // 2
  readonly outputTokenCap: number;
  readonly costCapUsd: number;
  /** Optional absolute task ceiling; defaults to none (Infinity). */
  readonly taskHardMs?: number;
  /** Optional pause→retry budget; defaults to 5. */
  readonly pauseRetryBudget?: number;
}

export interface PolicyResolution {
  readonly policy: RunBudgetPolicy;
  /** Clamp warnings the caller should log (never thrown — the run still proceeds, clamped). */
  readonly warnings: readonly string[];
}

/**
 * Resolve a RunBudgetPolicy from the seed + mode. Applies the one surviving ratio clamp
 * (`taskInactivityMs >= ratio × callStallMs`) with a warning rather than silently honoring
 * an ordering-violating config.
 */
export function resolveRunBudgetPolicy(mode: RunMode, seed: PolicySeed): PolicyResolution {
  const warnings: string[] = [];

  const callHardMs = seed.streamInitialTimeoutMs;
  // First-response can't exceed the per-call hard ceiling.
  const callFirstResponseMs = Math.min(seed.providerFirstResponseMs, callHardMs);
  // Neither can the stall window — clamp + warn rather than silently honoring an ordering
  // violation (the spec's "every deadline is a clamped+warned min() slice" claim).
  let callStallMs = seed.streamStallTimeoutMs;
  if (callStallMs > callHardMs) {
    warnings.push(
      `streamStallTimeoutMs (${callStallMs}ms) > callHardMs (${callHardMs}ms); ` +
        `clamped to ${callHardMs}ms so the stall window never outlives the call's hard ceiling.`,
    );
    callStallMs = callHardMs;
  }

  const floor = seed.minInactivityOverStreamRatio * callStallMs;
  let taskInactivityMs = seed.taskInactivityMs;
  if (taskInactivityMs < floor) {
    warnings.push(
      `taskInactivityMs (${taskInactivityMs}ms) < ${seed.minInactivityOverStreamRatio}×callStallMs ` +
        `(${floor}ms); clamped to ${floor}ms so the task silence ceiling never trips before a single call's stall window.`,
    );
    taskInactivityMs = floor;
  }

  return {
    policy: {
      mode,
      taskHardMs: seed.taskHardMs ?? Number.POSITIVE_INFINITY,
      taskInactivityMs,
      callFirstResponseMs,
      callStallMs,
      callHardMs,
      outputTokenCap: seed.outputTokenCap,
      costCapUsd: seed.costCapUsd,
      pauseRetryBudget: seed.pauseRetryBudget ?? 5,
    },
    warnings,
  };
}
