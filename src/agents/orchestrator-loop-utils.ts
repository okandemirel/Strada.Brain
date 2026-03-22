import { AgentPhase, transitionPhase, type AgentState, type StepResult } from "./agent-state.js";
import {
  buildPlanningPrompt,
  buildExecutionContext,
  buildReplanningPrompt,
} from "./paor-prompts.js";
import { mergeLearnedInsights } from "./orchestrator-runtime-utils.js";
import { shouldForceReplan } from "./failure-classifier.js";
import type { ExecutionJournal } from "./autonomy/execution-journal.js";
import type { ToolCall, ToolResult } from "./providers/provider-core.interface.js";
import type { ConsensusManager } from "../agent-core/routing/consensus-manager.js";
import type {
  TaskClassification,
  ExecutionPhase,
  ExecutionTraceSource,
  PhaseOutcomeStatus,
  OriginalOutput,
  ConsensusStrategy,
} from "../agent-core/routing/routing-types.js";
import { getLogger } from "../utils/logger.js";

/**
 * Builds the phase-aware prompt section that is appended to the system prompt
 * inside both `runBackgroundTask` and `runAgentLoop`.
 *
 * This is a pure function — it reads from the state and journal but mutates nothing.
 *
 * @returns The prompt suffix to append to the base system prompt.
 */
export function buildPhasePromptSection(
  agentState: AgentState,
  executionJournal: ExecutionJournal,
  options: { enableGoalDetection: boolean },
): string {
  let section = "";

  switch (agentState.phase) {
    case AgentPhase.PLANNING:
      section +=
        "\n\n" +
        buildPlanningPrompt(
          agentState.taskDescription,
          mergeLearnedInsights(
            agentState.learnedInsights,
            executionJournal.getLearnedInsights(),
          ),
          { enableGoalDetection: options.enableGoalDetection },
        );
      break;
    case AgentPhase.EXECUTING:
      section += buildExecutionContext(agentState);
      break;
    case AgentPhase.REPLANNING:
      section += "\n\n" + buildReplanningPrompt(agentState);
      break;
  }

  section += executionJournal.buildPromptSection(agentState.phase);

  return section;
}

// ─── Step result recording & reflection trigger ─────────────────────────────

export interface RecordStepResultsParams {
  agentState: AgentState;
  toolCalls: readonly ToolCall[];
  toolResults: readonly ToolResult[];
  reflectInterval: number;
}

export interface RecordStepResultsResult {
  agentState: AgentState;
  shouldReflect: boolean;
}

/**
 * Records tool execution results into agent state and determines whether
 * the agent should transition to the REFLECTING phase.
 *
 * Used identically in both `runBackgroundTask` and `runAgentLoop`.
 * If `shouldReflect` is true and the current phase is EXECUTING, the returned
 * state is already transitioned to REFLECTING.
 *
 * Pure function — no side effects.
 */
export function recordStepResultsAndCheckReflection(
  params: RecordStepResultsParams,
): RecordStepResultsResult {
  const { toolCalls, toolResults, reflectInterval } = params;
  let { agentState } = params;

  // Record each tool call as a step result
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!;
    const tr = toolResults[i]!;
    const stepResult: StepResult = {
      toolName: tc.name,
      success: !(tr.isError ?? false),
      summary: tr.content.slice(0, 200),
      timestamp: Date.now(),
    };
    agentState = {
      ...agentState,
      stepResults: [...agentState.stepResults, stepResult],
      iteration: agentState.iteration + 1,
      consecutiveErrors: tr.isError ? agentState.consecutiveErrors + 1 : 0,
    };
  }

  // Determine whether reflection is warranted
  const hasErrors = toolResults.some((tr) => tr.isError);
  const failedSteps = agentState.stepResults.filter((s) => !s.success);
  const shouldReflect =
    hasErrors ||
    (agentState.stepResults.length > 0 &&
      agentState.stepResults.length % reflectInterval === 0) ||
    shouldForceReplan(failedSteps);

  if (shouldReflect && agentState.phase === AgentPhase.EXECUTING) {
    agentState = transitionPhase(agentState, AgentPhase.REFLECTING);
  }

  return { agentState, shouldReflect };
}

// ─── Consensus verification ──────────────────────────────────────────────────

/** Assignment-like structure returned by resolveConsensusReviewAssignment. */
export interface ConsensusReviewAssignment {
  readonly provider?: import("./providers/provider.interface.js").IAIProvider | null;
  readonly reason?: string;
}

/**
 * Parameters for {@link runConsensusVerification}.
 * All loop-specific values are passed in so the function itself is loop-agnostic.
 */
export interface ConsensusVerificationParams {
  /** The consensus manager instance (must be non-null). */
  consensusManager: ConsensusManager;
  /** Number of providers currently available. */
  availableProviderCount: number;
  /** Task classification for this turn. */
  taskClass: TaskClassification;
  /** Estimated confidence in the current output (0-1). */
  confidence: number;
  /** The original output to verify. */
  originalOutput: OriginalOutput;
  /** Provider name that produced the original output. */
  originalProviderName: string;
  /** The prompt or user message associated with this turn. */
  prompt: string;
  /** Review assignment resolved by the orchestrator. */
  reviewAssignment: ConsensusReviewAssignment | null | undefined;
  /** Chat id for tracing. */
  chatId?: string;
  /** Identity key for tracing. */
  identityKey: string;
  /** Label for the warn log on disagreement (e.g. "background", "text-only, critical"). */
  logLabel?: string;
  /** Callback: record an execution trace entry. */
  recordExecutionTrace: (params: {
    chatId?: string;
    identityKey: string;
    assignment: ConsensusReviewAssignment;
    phase: ExecutionPhase;
    source: ExecutionTraceSource;
    task: TaskClassification;
    reason?: string;
  }) => void;
  /** Callback: record a phase outcome entry. */
  recordPhaseOutcome: (params: {
    chatId?: string;
    identityKey: string;
    assignment: ConsensusReviewAssignment;
    phase: ExecutionPhase;
    source: ExecutionTraceSource;
    status: PhaseOutcomeStatus;
    task: TaskClassification;
    reason: string;
  }) => void;
}

/**
 * Runs the consensus verification flow that is shared across both
 * `runBackgroundTask` and `runAgentLoop`.
 *
 * Given the already-computed task classification, confidence, and original
 * output, this function:
 * 1. Calls `consensusManager.shouldConsult` to decide whether to verify.
 * 2. If verification is warranted, calls `consensusManager.verify`.
 * 3. Records execution trace and phase outcome via the provided callbacks.
 * 4. Logs a warning on disagreement.
 *
 * Non-fatal: any error inside is caught and silently swallowed, matching
 * the original inline behaviour.
 */
export async function runConsensusVerification(
  params: ConsensusVerificationParams,
): Promise<void> {
  const {
    consensusManager,
    availableProviderCount,
    taskClass,
    confidence,
    originalOutput,
    originalProviderName,
    prompt,
    reviewAssignment,
    chatId,
    identityKey,
    logLabel,
    recordExecutionTrace,
    recordPhaseOutcome,
  } = params;

  const strategy: ConsensusStrategy = consensusManager.shouldConsult(
    confidence,
    taskClass,
    availableProviderCount,
  );

  if (strategy === "skip" || availableProviderCount < 2) {
    return;
  }

  if (!reviewAssignment?.provider) {
    return;
  }

  const consensusResult = await consensusManager.verify({
    originalOutput,
    originalProvider: originalProviderName,
    task: taskClass,
    confidence,
    reviewProvider: reviewAssignment.provider,
    prompt,
  });

  recordExecutionTrace({
    chatId,
    identityKey,
    assignment: reviewAssignment,
    phase: "consensus-review" as ExecutionPhase,
    source: "consensus-review" as ExecutionTraceSource,
    task: taskClass,
    reason: reviewAssignment.reason,
  });

  recordPhaseOutcome({
    chatId,
    identityKey,
    assignment: reviewAssignment,
    phase: "consensus-review" as ExecutionPhase,
    source: "consensus-review" as ExecutionTraceSource,
    status: (consensusResult.agreed ? "approved" : "continued") as PhaseOutcomeStatus,
    task: taskClass,
    reason:
      consensusResult.reasoning?.trim() ||
      (consensusResult.agreed
        ? "Consensus review agreed with the current path."
        : "Consensus review found a disagreement and kept execution open."),
  });

  if (!consensusResult.agreed) {
    const logger = getLogger();
    const label = logLabel ? `Consensus disagreement (${logLabel})` : "Consensus disagreement";
    logger.warn(label, {
      chatId,
      strategy: consensusResult.strategy,
      reasoning: consensusResult.reasoning?.slice(0, 200),
    });
  }
}
