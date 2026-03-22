import type { ConsensusManager } from "../agent-core/routing/consensus-manager.js";
import type {
  TaskClassification,
  OriginalOutput,
  ConsensusStrategy,
} from "../agent-core/routing/routing-types.js";
import type { IAIProvider } from "./providers/provider.interface.js";
import { getLogger } from "../utils/logger.js";

/** Assignment resolved by the orchestrator before consensus verification. */
export interface ConsensusReviewAssignment {
  readonly provider?: IAIProvider | null;
  readonly reason?: string;
}

export interface ConsensusVerificationParams {
  consensusManager: ConsensusManager;
  availableProviderCount: number;
  taskClass: TaskClassification;
  confidence: number;
  originalOutput: OriginalOutput;
  originalProviderName: string;
  prompt: string;
  reviewAssignment: ConsensusReviewAssignment | null | undefined;
  chatId?: string;
  identityKey: string;
  /** Label for the warn log on disagreement (e.g. "background", "text-only, critical"). */
  logLabel?: string;
  recordExecutionTrace: (params: {
    chatId?: string;
    identityKey: string;
    assignment: ConsensusReviewAssignment;
    phase: string;
    source: string;
    task: TaskClassification;
    reason?: string;
  }) => void;
  recordPhaseOutcome: (params: {
    chatId?: string;
    identityKey: string;
    assignment: ConsensusReviewAssignment;
    phase: string;
    source: string;
    status: string;
    task: TaskClassification;
    reason: string;
  }) => void;
}

/**
 * Runs the consensus verification flow shared across all loop paths.
 *
 * Given pre-computed task classification, confidence, and original output,
 * this function:
 * 1. Calls `consensusManager.shouldConsult` to decide whether to verify.
 * 2. If verification is warranted, calls `consensusManager.verify`.
 * 3. Records execution trace and phase outcome via the provided callbacks.
 * 4. Logs a warning on disagreement.
 *
 * Non-fatal: any error inside is caught and silently swallowed.
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
    phase: "consensus-review",
    source: "consensus-review",
    task: taskClass,
    reason: reviewAssignment.reason,
  });

  recordPhaseOutcome({
    chatId,
    identityKey,
    assignment: reviewAssignment,
    phase: "consensus-review",
    source: "consensus-review",
    status: consensusResult.agreed ? "approved" : "continued",
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
