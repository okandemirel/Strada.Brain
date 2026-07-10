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
import {
  emitVisibleBoundary,
  portRenderInteractiveBudgetExceeded,
  renderInteractiveResilienceEvent,
} from "./render.js";
import {
  portDispatchReflection,
  portDispatchEndTurn,
  portParseReflectionDecision,
  portHandlePlanPhase,
} from "./reflection.js";
import {
  setupAgentCoreRun,
  resolvePersonaContent,
  trimContextWindowForRun,
} from "./setup.js";
import type { UserProfile } from "../../memory/unified/user-profile-store.js";
import type { AgentRunSetupInput, RunSetup as PortRunSetup } from "../runner/orchestrator-port.js";
import type { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import type { IterationHealthCoreAdapter } from "../control/iteration-health-core-adapter.js";
import type {
  DispatchReflectionParams,
  ReflectionDispatchResult,
  DispatchEndTurnParams,
  EndTurnDispatchResult,
  ParseReflectionDecisionParams,
  ParsedReflectionDecision,
  PlanPhaseParams,
  PlanPhaseResult,
} from "../runner/orchestrator-port.js";
import type { Session } from "../../agents/orchestrator-session-manager.js";
import type { AgentEvent } from "../events/agent-event.js";

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

  // ── Rendering (relocation Step 6a) ────────────────────────────────────────────────────────
  emitVisibleBoundary(chatId: string, session: Session, visibleText: string | undefined): ReturnType<typeof emitVisibleBoundary> {
    return emitVisibleBoundary(this.deps, chatId, session, visibleText);
  }

  portRenderInteractiveBudgetExceeded(runCtx: EngineRunContext): Promise<void> {
    return portRenderInteractiveBudgetExceeded(this.deps, runCtx);
  }

  renderInteractiveResilienceEvent(
    e: AgentEvent,
    language: string,
    enqueue: (text: string, transient?: boolean) => void,
  ): void {
    renderInteractiveResilienceEvent(e, language, enqueue);
  }

  // ── Reflection / end-turn dispatch (relocation Step 6b, HIGHEST CARE) ──────────────────────
  portParseReflectionDecision(params: ParseReflectionDecisionParams, runCtx: EngineRunContext): Promise<ParsedReflectionDecision> {
    return portParseReflectionDecision(params, runCtx);
  }

  portDispatchReflection(params: DispatchReflectionParams, runCtx: EngineRunContext): Promise<ReflectionDispatchResult> {
    return portDispatchReflection(this.deps, params, runCtx);
  }

  portDispatchEndTurn(params: DispatchEndTurnParams, runCtx: EngineRunContext): Promise<EndTurnDispatchResult> {
    return portDispatchEndTurn(this.deps, params, runCtx);
  }

  portHandlePlanPhase(params: PlanPhaseParams, runCtx: EngineRunContext): Promise<PlanPhaseResult> {
    return portHandlePlanPhase(this.deps, params, runCtx);
  }

  // ── Run setup / bootstrap (relocation Step 7) ─────────────────────────────────────────────────
  setupAgentCoreRun(
    request: AgentRunSetupInput,
    iterationHealth: IterationHealthTracker,
    healthAdapter: IterationHealthCoreAdapter,
  ): Promise<{ setup: PortRunSetup; runCtx: EngineRunContext }> {
    return setupAgentCoreRun(this.deps, request, iterationHealth, healthAdapter);
  }

  resolvePersonaContent(profile: UserProfile | null): Promise<string | undefined> {
    return resolvePersonaContent(this.deps, profile);
  }

  trimContextWindowForRun(
    session: Session,
    mode: "interactive" | "background",
    runCtx: EngineRunContext,
  ): void {
    trimContextWindowForRun(this.deps, session, mode, runCtx);
  }
}
