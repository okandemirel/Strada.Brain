/**
 * Agent Core v2 — the AgentEngine facade (relocation blueprint: project_v2_engine_relocation).
 *
 * Owns the relocated port method clusters over an injected {@link EngineDeps}; Step 9 moves
 * `createAgentCorePort` itself so the shell's runner hook becomes `this.engine.createPort()`.
 * Every method is a thin binding over its cluster module — the bodies live in the per-cluster
 * files (accounting.ts, …), matching the repo's *Deps-helper house style.
 */

import type { EngineDeps, EngineRunContext } from "./engine-deps.js";
import type { ProviderResponse } from "../../agents/providers/provider-core.interface.js";
import type { TaskUsageEvent } from "../../tasks/types.js";
import type { ClassifyFailureParams, FailureVerdictContribution } from "../runner/orchestrator-port.js";
import {
  recordProviderUsage,
  recordExecutionTrace,
  recordMetricEnd,
  recordAuxiliaryUsage,
  recordPhaseOutcome,
  classifyAgentCoreFailure,
  type RecordExecutionTraceParams,
  type RecordPhaseOutcomeParams,
  type RecordMetricEndResult,
} from "./accounting.js";
import {
  buildPolicySeed,
  getLiveInteractiveTokenBudget,
  getInteractiveIterationLimit,
  getBackgroundEpochIterationLimit,
  canAutoContinueBackgroundEpoch,
} from "./budget.js";
import type { PolicySeed } from "../control/policy.js";
import { prepareIteration, type PrepareIterationParams, type PreparedIteration } from "./prepare-iteration.js";
import { buildResultProjection } from "./synthesis.js";
import type { ResultProjectionParams, AgentRunResultProjection } from "../runner/orchestrator-port.js";
import {
  runVisibilityReview,
  runCompletionReviewStages,
  reviewShellCommandWithProvider,
} from "./review.js";

export class AgentEngine {
  constructor(private readonly deps: EngineDeps) {}

  // ── Accounting (relocation Step 1) ────────────────────────────────────────────────────────
  recordProviderUsage(
    providerName: string,
    usage: ProviderResponse["usage"] | undefined,
    onUsage?: (usage: TaskUsageEvent) => void,
  ): void {
    recordProviderUsage(this.deps, providerName, usage, onUsage);
  }

  recordExecutionTrace(params: RecordExecutionTraceParams): void {
    recordExecutionTrace(this.deps, params);
  }

  recordPhaseOutcome(params: RecordPhaseOutcomeParams): void {
    recordPhaseOutcome(this.deps, params);
  }

  recordMetricEnd(metricId: string | undefined, result: RecordMetricEndResult): void {
    recordMetricEnd(this.deps, metricId, result);
  }

  recordAuxiliaryUsage(
    provider: string,
    usage: ProviderResponse["usage"] | undefined,
    sink?: (usage: TaskUsageEvent) => void,
  ): void {
    recordAuxiliaryUsage(this.deps, provider, usage, sink);
  }

  classifyAgentCoreFailure(
    params: ClassifyFailureParams,
    runCtx: EngineRunContext,
  ): FailureVerdictContribution {
    return classifyAgentCoreFailure(params, runCtx);
  }

  // ── Budget / limits (relocation Step 2) ───────────────────────────────────────────────────
  getLiveInteractiveTokenBudget(): number {
    return getLiveInteractiveTokenBudget(this.deps);
  }

  buildPolicySeed(): PolicySeed {
    return buildPolicySeed(this.deps);
  }

  getInteractiveIterationLimit(): number {
    return getInteractiveIterationLimit(this.deps);
  }

  getBackgroundEpochIterationLimit(): number {
    return getBackgroundEpochIterationLimit(this.deps);
  }

  canAutoContinueBackgroundEpoch(completedEpochCount: number): boolean {
    return canAutoContinueBackgroundEpoch(this.deps, completedEpochCount);
  }

  // ── Per-iteration setup (relocation Step 3) ───────────────────────────────────────────────
  prepareIteration(params: PrepareIterationParams): PreparedIteration {
    return prepareIteration(this.deps, params);
  }

  // ── Result projection (relocation Step 4) ─────────────────────────────────────────────────
  buildResultProjection(params: ResultProjectionParams, runCtx: EngineRunContext): AgentRunResultProjection {
    return buildResultProjection(this.deps, params, runCtx);
  }

  // ── Review / verify (relocation Step 5b) ──────────────────────────────────────────────────
  runVisibilityReview(params: Parameters<typeof runVisibilityReview>[1]): ReturnType<typeof runVisibilityReview> {
    return runVisibilityReview(this.deps, params);
  }

  runCompletionReviewStages(params: Parameters<typeof runCompletionReviewStages>[1]): ReturnType<typeof runCompletionReviewStages> {
    return runCompletionReviewStages(this.deps, params);
  }

  reviewShellCommandWithProvider(
    ...args: Parameters<typeof reviewShellCommandWithProvider> extends [unknown, ...infer R] ? R : never
  ): ReturnType<typeof reviewShellCommandWithProvider> {
    return reviewShellCommandWithProvider(this.deps, ...args);
  }
}
