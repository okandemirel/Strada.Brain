/**
 * The loop recovery's choice of a delegate: which delegate tool it may run, and which one it runs.
 *
 * The recovery runs the delegate itself, at once, through the tool-call gate and with the state
 * it was handed (orchestrator-intervention-pipeline.ts handleBackgroundLoopRecovery), so it may
 * choose only among the tools the gate runs in that state's phase. The run's tool list no longer
 * says so: it is the same in every phase (agent-core/engine/phase-write-access.ts). While
 * reflecting, the recovery picked a delegate tool from it, the gate refused the write, and the
 * refusal was recorded as the delegated diagnosis, a journal insight, a worker-trace row and a
 * "Loop recovery delegation" progress line (QA, 2026-11-11). While the list still followed the
 * phase it held no delegate tool there, and the recovery fell back to its gate.
 */

import type { AgentPhase } from "./agent-state.js";
import { toolNamesRunnableIn, type PhaseRefuses } from "../agent-core/engine/phase-write-access.js";

/** The names of `toolNames` the recovery may delegate to in `phase`: those the gate runs there. */
export function delegationCandidatesIn(
  toolNames: readonly string[] | undefined,
  phase: AgentPhase,
  refuses: PhaseRefuses,
): readonly string[] | undefined {
  return toolNames ? toolNamesRunnableIn(toolNames, phase, refuses) : undefined;
}

export function selectLoopRecoveryDelegationTool(
  availableToolNames: readonly string[] | undefined,
  touchedFiles: readonly string[],
): "delegate_analysis" | "delegate_code_review" | null {
  if (!availableToolNames || availableToolNames.length === 0) {
    return null;
  }
  if (touchedFiles.length > 0 && availableToolNames.includes("delegate_code_review")) {
    return "delegate_code_review";
  }
  if (availableToolNames.includes("delegate_analysis")) {
    return "delegate_analysis";
  }
  if (availableToolNames.includes("delegate_code_review")) {
    return "delegate_code_review";
  }
  return null;
}
