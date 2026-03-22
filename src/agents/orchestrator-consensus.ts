import type { ConsensusManager } from "../agent-core/routing/consensus-manager.js";
import type {
  TaskClassification,
  OriginalOutput,
  ConsensusStrategy,
  ExecutionPhase,
  ExecutionTraceSource,
  PhaseOutcomeStatus,
} from "../agent-core/routing/routing-types.js";
import type { SupervisorAssignment } from "./orchestrator-supervisor-routing.js";
import { getLogger } from "../utils/logger.js";

export interface ConsensusVerificationParams {
  consensusManager: ConsensusManager;
  availableProviderCount: number;
  taskClass: TaskClassification;
  confidence: number;
  originalOutput: OriginalOutput;
  originalProviderName: string;
  prompt: string;
  reviewAssignment: SupervisorAssignment | null | undefined;
  chatId?: string;
  identityKey: string;
  /** Label for the warn log on disagreement (e.g. "background", "text-only, critical"). */
  logLabel?: string;
  recordExecutionTrace: (params: {
    chatId?: string;
    identityKey: string;
    assignment: SupervisorAssignment;
    phase: ExecutionPhase;
    source?: ExecutionTraceSource;
    task: TaskClassification;
    reason?: string;
  }) => void;
  recordPhaseOutcome: (params: {
    chatId?: string;
    identityKey: string;
    assignment: SupervisorAssignment;
    phase: ExecutionPhase;
    source?: ExecutionTraceSource;
    status: PhaseOutcomeStatus;
    task: TaskClassification;
    reason: string;
  }) => void;
}

/**
 * Runs the consensus verification flow shared across all loop paths.
 *
 * Given pre-computed task classification, confidence, and original output:
 * 1. Calls `consensusManager.shouldConsult` to decide whether to verify.
 * 2. If warranted, calls `consensusManager.verify`.
 * 3. Records execution trace and phase outcome via provided callbacks.
 * 4. Logs a warning on disagreement.
 *
 * Non-fatal: any error inside is caught and silently swallowed by the caller.
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
