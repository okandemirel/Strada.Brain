import { AgentPhase, transitionPhase, type AgentState } from "./agent-state.js";
import type { ExecutionJournal } from "./autonomy/execution-journal.js";
import {
  extractApproachSummary,
  parseReflectionDecision,
  validateReflectionDecision,
  type ReflectionDecision,
} from "./orchestrator-runtime-utils.js";
import {
  transitionToVerifierReplan,
} from "./orchestrator-phase-telemetry.js";
import { getLogger } from "../utils/logger.js";

/** Shared parameter shape for functions that operate on a single PAOR loop step. */
export interface LoopStepParams {
  agentState: AgentState;
  executionJournal: ExecutionJournal;
  responseText: string | undefined;
  providerName: string;
  modelId: string;
}

export interface PlanPhaseTransitionParams extends LoopStepParams {
  /** When false, the caller handles the transition (e.g. goal decomposition inserts steps first). Defaults to true. */
  autoTransition?: boolean;
}

/**
 * Records the plan in the execution journal, updates state, and optionally transitions to EXECUTING.
 * Enforces identical plan-recording behavior between background and interactive loops.
 */
export function handlePlanPhaseTransition(params: PlanPhaseTransitionParams): AgentState {
  const { executionJournal, responseText, providerName, modelId, autoTransition = true } = params;
  let { agentState } = params;

  executionJournal.recordPlan(responseText, agentState.phase, providerName, modelId);
  agentState = { ...agentState, plan: responseText ?? null };

  if (autoTransition) {
    agentState = transitionPhase(agentState, AgentPhase.EXECUTING);
  }

  return agentState;
}

export interface ReflectionPreambleParams extends LoopStepParams {
  /** Label for the warn log (e.g. "bg"). */
  logLabel?: string;
}

export interface ReflectionPreambleResult {
  decision: ReflectionDecision;
}

/**
 * Parses and validates the reflection decision, records learning metrics,
 * and writes the reflection into the execution journal.
 *
 * Async because LearningMetrics is lazily imported to avoid circular deps.
 */
export async function processReflectionPreamble(
  params: ReflectionPreambleParams,
): Promise<ReflectionPreambleResult> {
  const { agentState, executionJournal, responseText, providerName, modelId, logLabel } = params;

  const { decision, overrideReason } = validateReflectionDecision(
    parseReflectionDecision(responseText),
    agentState,
  );

  if (overrideReason) {
    const label = logLabel
      ? `PAOR reflection override (${logLabel})`
      : "PAOR reflection override";
    getLogger().warn(label, { overrideReason });
  }

  try {
    const { LearningMetrics } = await import("../learning/learning-metrics.js");
    LearningMetrics.getInstance().recordReflectionDone();
    if (overrideReason) LearningMetrics.getInstance().recordReflectionOverride();
  } catch { /* non-fatal */ }

  executionJournal.recordReflection(decision, responseText, providerName, modelId);

  return { decision };
}

/**
 * Updates the agent state after a reflection that continues execution:
 * increments reflection count, resets consecutive errors if the last step
 * succeeded, and transitions to EXECUTING.
 *
 * @param skipLastReflection — When true, preserves the existing `lastReflection`
 *   value. Used by the plain CONTINUE fallthrough path where the response is not
 *   a meaningful reflection artifact worth persisting.
 */
export function applyReflectionContinuation(
  agentState: AgentState,
  responseText: string | undefined,
  options?: { skipLastReflection?: boolean },
): AgentState {
  let state: AgentState = {
    ...agentState,
    lastReflection: options?.skipLastReflection
      ? agentState.lastReflection
      : (responseText ?? agentState.lastReflection),
    reflectionCount: agentState.reflectionCount + 1,
    consecutiveErrors: agentState.stepResults.at(-1)?.success ? 0 : agentState.consecutiveErrors,
  };
  state = transitionPhase(state, AgentPhase.EXECUTING);
  return state;
}

export interface ReplanDecisionParams extends LoopStepParams {
  /** When false, the caller handles the transition (e.g. goal decomposition inserts steps first). Defaults to true. */
  autoTransition?: boolean;
}

/**
 * Handles the REPLAN reflection decision: begins a replan cycle in the journal,
 * archives the failed approach, and transitions to REPLANNING.
 *
 * Note: the verifier/loop-recovery replan path uses `transitionToVerifierReplan`
 * (from orchestrator-phase-telemetry) instead, which additionally resets
 * `consecutiveErrors` and handles multi-step phase transitions (EXECUTING→REFLECTING→REPLANNING).
 */
export function handleReplanDecision(params: ReplanDecisionParams): AgentState {
  const { executionJournal, responseText, providerName, modelId, autoTransition = true } = params;
  let { agentState } = params;

  executionJournal.beginReplan({
    state: agentState,
    reason: responseText ?? "reflection requested a new plan",
    providerName,
    modelId,
  });

  agentState = {
    ...agentState,
    failedApproaches: [
      ...agentState.failedApproaches,
      extractApproachSummary(agentState),
    ],
    lastReflection: responseText ?? null,
    reflectionCount: agentState.reflectionCount + 1,
  };

  if (autoTransition) {
    agentState = transitionPhase(agentState, AgentPhase.REPLANNING);
  }

  return agentState;
}

export interface VerifierReplanParams {
  agentState: AgentState;
  executionJournal: ExecutionJournal;
  responseText: string | undefined;
  reason: string;
  providerName: string;
  modelId: string;
}

/**
 * Combines `executionJournal.beginReplan()` + `transitionToVerifierReplan()` for
 * the verifier/loop-recovery replan path. Unlike `handleReplanDecision` (which handles
 * the PAOR reflection REPLAN decision), this path resets `consecutiveErrors` and
 * handles multi-step phase transitions via `transitionToVerifierReplan`.
 */
export function handleVerifierReplan(params: VerifierReplanParams): AgentState {
  const { agentState, executionJournal, responseText, reason, providerName, modelId } = params;

  executionJournal.beginReplan({
    state: agentState,
    reason,
    providerName,
    modelId,
  });

  return transitionToVerifierReplan(agentState, responseText);
}
