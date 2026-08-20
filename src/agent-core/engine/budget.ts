/**
 * Agent Core v2 — engine budget/limits (relocation Step 2; blueprint: project_v2_engine_relocation).
 *
 * The run-budget + iteration-limit leaf of the port surface, moved VERBATIM from orchestrator.ts:
 * the live interactive token budget, the PolicySeed the control plane resolves per run, and the
 * interactive / background-epoch iteration limits + auto-continue gate. The rendering half
 * (renderInteractiveBudgetExceeded) stays with the rendering cluster (Step 6) — it belongs with
 * emitVisibleBoundary, not the pure limit math.
 *
 * Import rule (cycle safety): orchestrator-FREE leaves only — see engine-deps.ts.
 */

import type { PolicySeed } from "../control/policy.js";
import type { TaskConfig } from "../../config/config-types.js";
import {
  DEFAULT_LLM_PROVIDER_FIRST_RESPONSE_TIMEOUT_MS,
  DEFAULT_TASK_INACTIVITY_TIMEOUT_MS,
} from "../../config/config-types.js";
import { getLogger } from "../../utils/logger.js";

/** 1b/1c seed default for the task-scope silence ceiling ratio (mirrors orchestrator's local). */
const PHASE1B_MIN_INACTIVITY_OVER_STREAM_RATIO = 2;

/** The dependency slice the budget/limit functions read (grows only with this module). */
export interface BudgetDeps {
  /** LAZY GETTER — the unified budget manager is set AFTER construction (setter-backed). */
  readonly unifiedBudgetManager: () => {
    getConfig?: () => { interactiveTokenBudget?: number | null } | undefined;
    /** Subscribe to runtime budget-config changes (mid-task /token raise); returns unsubscribe. */
    onConfigUpdated?: (listener: () => void) => () => void;
  } | null;
  readonly taskConfig: TaskConfig;
  readonly maxIterations?: number;
  readonly streamInitialTimeoutMs: number;
  readonly streamStallTimeoutMs: number;
}

/**
 * The live interactive token budget: the unified budget manager's config wins (runtime-tunable);
 * an out-of-range value logs + falls back to the static task config. -1 = "unbounded".
 */
export function getLiveInteractiveTokenBudget(deps: BudgetDeps): number {
  const live = deps.unifiedBudgetManager()?.getConfig?.()?.interactiveTokenBudget;
  if (typeof live === "number" && live >= -1) return live;
  if (live !== undefined && live !== null) {
    getLogger().warn("getLiveInteractiveTokenBudget: live value out of range", {
      unifiedBudgetManagerSet: !!deps.unifiedBudgetManager(),
      rawConfigValue: live,
      fallbackUsed: deps.taskConfig.interactiveTokenBudget,
    });
  }
  return deps.taskConfig.interactiveTokenBudget;
}

/**
 * The live interactive OUTPUT-token cap with the -1→∞ "unbounded" sentinel resolved. THIS is what the
 * control-plane Budget is seeded with (buildPolicySeed) and what a mid-task `/token` raise re-reads —
 * the single source of the sentinel transform, so the two never drift.
 */
export function resolveLiveOutputTokenCap(deps: BudgetDeps): number {
  const live = getLiveInteractiveTokenBudget(deps);
  return live === -1 ? Number.POSITIVE_INFINITY : live;
}

/** Phase 1b — build the PolicySeed the control plane resolves the run's clock/budget from. */
export function buildPolicySeed(deps: BudgetDeps): PolicySeed {
  return {
    streamInitialTimeoutMs: deps.streamInitialTimeoutMs,
    streamStallTimeoutMs: deps.streamStallTimeoutMs,
    providerFirstResponseMs: DEFAULT_LLM_PROVIDER_FIRST_RESPONSE_TIMEOUT_MS,
    taskInactivityMs: DEFAULT_TASK_INACTIVITY_TIMEOUT_MS,
    minInactivityOverStreamRatio: PHASE1B_MIN_INACTIVITY_OVER_STREAM_RATIO,
    outputTokenCap: resolveLiveOutputTokenCap(deps),
    costCapUsd: Number.POSITIVE_INFINITY,
    // taskHardMs omitted → resolver uses Infinity (v1 has no wall-clock task ceiling). The
    // 3h27m-runaway bound stays the iteration limit + loopDetectionBlocked guard in 1b.
  };
}

export function getInteractiveIterationLimit(deps: BudgetDeps): number {
  const configLimit = Math.max(1, deps.taskConfig.interactiveMaxIterations);
  return deps.maxIterations ? Math.min(deps.maxIterations, configLimit) : configLimit;
}

export function getBackgroundEpochIterationLimit(deps: BudgetDeps): number {
  const configLimit = Math.max(1, deps.taskConfig.backgroundEpochMaxIterations);
  return deps.maxIterations ? Math.min(deps.maxIterations, configLimit) : configLimit;
}

/**
 * May an interactive run roll into another epoch rather than stop?
 *
 * Off unless the request asked for work that runs to a finish line. The
 * epoch cap is shared with background runs — the question is whether to
 * continue at all, not how many times.
 */
export function canAutoContinueInteractiveEpoch(deps: BudgetDeps, completedEpochCount: number): boolean {
  if (!deps.taskConfig.interactiveAutoContinue) {
    return false;
  }
  const maxEpochs = deps.taskConfig.backgroundMaxEpochs;
  return maxEpochs === 0 || completedEpochCount < maxEpochs;
}

export function canAutoContinueBackgroundEpoch(deps: BudgetDeps, completedEpochCount: number): boolean {
  if (!deps.taskConfig.backgroundAutoContinue) {
    return false;
  }
  const maxEpochs = deps.taskConfig.backgroundMaxEpochs;
  return maxEpochs === 0 || completedEpochCount < maxEpochs;
}
