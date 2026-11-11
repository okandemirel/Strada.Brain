/**
 * The one call from the end-turn and reflection handlers into loop recovery.
 *
 * Both handlers hand loop recovery the same run state from their contexts; the
 * background call differs only in daemon mode, which the caller states.
 */

import {
  handleBackgroundLoopRecovery,
  type InterventionDeps,
  type LoopRecoveryIntervention,
} from "./orchestrator-intervention-pipeline.js";
import type { AgentState } from "./agent-state.js";

type RecoveryParams = Parameters<typeof handleBackgroundLoopRecovery>[0];

export type LoopRecoveryKind = RecoveryParams["kind"];

/** What an interactive handler context carries for loop recovery. */
export interface InteractiveLoopRecoveryCaller {
  readonly chatId: string;
  readonly identityKey: string;
  readonly prompt: string;
  readonly executionStrategy: RecoveryParams["strategy"];
  readonly controlLoopTracker?: RecoveryParams["tracker"];
  readonly executionJournal: RecoveryParams["executionJournal"];
  readonly currentToolNames: string[];
  readonly selfVerification: RecoveryParams["selfVerification"];
  readonly usageHandler: RecoveryParams["usageHandler"];
  readonly session: RecoveryParams["session"];
  readonly progressAssessmentEnabled?: boolean;
  readonly taskStartedAtMs: number;
  readonly interventionDeps: InterventionDeps;
}

/** What a background handler context carries for loop recovery. */
export interface BgLoopRecoveryCaller extends InteractiveLoopRecoveryCaller {
  readonly controlLoopTracker: RecoveryParams["tracker"];
  readonly progressTitle: string;
  readonly progressLanguage: NonNullable<RecoveryParams["language"]>;
  readonly iteration: number;
  readonly emitProgress: RecoveryParams["onProgress"];
  readonly workerCollector: RecoveryParams["workerCollector"];
  readonly workspaceLease: RecoveryParams["workspaceLease"];
}

export async function runBgLoopRecovery(
  ctx: BgLoopRecoveryCaller,
  daemonMode: boolean,
  agentState: AgentState,
  kind: LoopRecoveryKind,
  reason: string,
  gate: string | undefined,
): Promise<LoopRecoveryIntervention> {
  return handleBackgroundLoopRecovery({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    prompt: ctx.prompt,
    title: ctx.progressTitle,
    language: ctx.progressLanguage,
    state: agentState,
    strategy: ctx.executionStrategy,
    tracker: ctx.controlLoopTracker,
    executionJournal: ctx.executionJournal,
    kind,
    reason,
    gate,
    iteration: ctx.iteration,
    availableToolNames: ctx.currentToolNames,
    selfVerification: ctx.selfVerification,
    usageHandler: ctx.usageHandler,
    onProgress: ctx.emitProgress,
    session: ctx.session,
    workerCollector: ctx.workerCollector,
    workspaceLease: ctx.workspaceLease,
    daemonMode,
    progressAssessmentEnabled: ctx.progressAssessmentEnabled,
    taskStartedAtMs: ctx.taskStartedAtMs,
  }, ctx.interventionDeps);
}

export async function runInteractiveLoopRecovery(
  ctx: InteractiveLoopRecoveryCaller,
  agentState: AgentState,
  kind: LoopRecoveryKind,
  reason: string,
  gate: string | undefined,
): Promise<LoopRecoveryIntervention | null> {
  if (!ctx.controlLoopTracker) {
    return null;
  }

  return handleBackgroundLoopRecovery({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    prompt: ctx.prompt,
    title: ctx.prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "Task",
    state: agentState,
    strategy: ctx.executionStrategy,
    tracker: ctx.controlLoopTracker,
    executionJournal: ctx.executionJournal,
    kind,
    reason,
    gate,
    iteration: agentState.iteration,
    availableToolNames: ctx.currentToolNames,
    selfVerification: ctx.selfVerification,
    usageHandler: ctx.usageHandler,
    onProgress: () => {},
    session: ctx.session,
    progressAssessmentEnabled: ctx.progressAssessmentEnabled,
    taskStartedAtMs: ctx.taskStartedAtMs,
  }, ctx.interventionDeps);
}
