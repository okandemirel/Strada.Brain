/**
 * Orchestrator End-Turn Handler — standalone functions for the non-REFLECTING
 * "Final response" blocks in both background and interactive loops.
 *
 * Extracted from orchestrator.ts to reduce its line count.
 * Each function returns an `EndTurnLoopAction` discriminated union that the
 * caller maps back to the loop control flow (`continue`, `return`, etc.).
 */

import type { AgentState } from "./agent-state.js";
import type { ConversationMessage, ProviderResponse } from "./providers/provider.interface.js";
import type {
  SupervisorAssignment,
  SupervisorExecutionStrategy,
} from "./orchestrator-supervisor-routing.js";
import type { Session } from "./orchestrator-session-manager.js";
import type { ExecutionJournal } from "./autonomy/execution-journal.js";
import type { SelfVerification } from "./autonomy/self-verification.js";
import type { StradaConformanceGuard } from "./autonomy/strada-conformance.js";
import type { ControlLoopTracker } from "./autonomy/control-loop-tracker.js";
import type { InteractionBoundaryDecision } from "./autonomy/visibility-boundary.js";
import type { TaskProgressKind, TaskProgressSignal, TaskProgressUpdate, TaskUsageEvent } from "../tasks/types.js";
import type { ProgressLanguage } from "../tasks/progress-signals.js";
import type { WorkspaceLease } from "./supervisor/supervisor-types.js";
import type { PhaseOutcomeTelemetry } from "../agent-core/routing/routing-types.js";
import type {
  InterventionDeps,
  LoopRecoveryIntervention,
  WorkerRunCollector,
} from "./orchestrator-intervention-pipeline.js";
import type { ClarificationContext } from "./orchestrator-clarification.js";
import { isTerminalFailureReport } from "./autonomy/verifier-pipeline.js";
import {
  decideUserVisibleBoundary as decideUserVisibleBoundaryHelper,
} from "./orchestrator-clarification.js";
import {
  handleBackgroundLoopRecovery as handleBackgroundLoopRecoveryPipeline,
  resolveVerifierIntervention as resolveVerifierInterventionPipeline,
  resolveDraftClarificationIntervention as resolveDraftClarificationInterventionPipeline,
  resolveVisibleDraftDecision as resolveVisibleDraftDecisionPipeline,
} from "./orchestrator-intervention-pipeline.js";
import {
  handleVerifierReplan,
} from "./orchestrator-loop-utils.js";
import {
  transitionToVerifierReplan as transitionToVerifierReplanModel,
  toExecutionPhase as toExecutionPhaseModel,
} from "./orchestrator-phase-telemetry.js";
import { getLogger } from "../utils/logger.js";
import {
  pushContinuationMessages,
  type RecordPhaseOutcomeParams,
  type BuildPhaseOutcomeTelemetryParams,
} from "./orchestrator-loop-shared.js";
import { shouldDeferRawBoundaryForDirectTarget } from "./prompt-targets.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type EndTurnLoopAction =
  | { flow: "continue"; newState: AgentState }
  | { flow: "done"; visibleText: string; newState: AgentState; status?: "blocked" | "completed" }
  | { flow: "blocked"; visibleText: string; status?: "blocked" | "completed" };

// ─── Context interfaces ────────────────────────────────────────────────────────

export interface EndTurnCoreContext {
  readonly chatId: string;
  readonly identityKey: string;
  readonly prompt: string;
  readonly responseText: string | undefined;
  readonly responseUsage: ProviderResponse["usage"];
  readonly executionStrategy: SupervisorExecutionStrategy;
  readonly executionJournal: ExecutionJournal;
  readonly selfVerification: SelfVerification;
  readonly stradaConformance: StradaConformanceGuard;
  readonly taskStartedAtMs: number;
  readonly currentToolNames: string[];
  readonly currentAssignment: SupervisorAssignment;
  readonly interventionDeps: InterventionDeps;
  readonly session: Session;
  readonly recordPhaseOutcome: (params: RecordPhaseOutcomeParams) => void;
  readonly buildPhaseOutcomeTelemetry: (params: BuildPhaseOutcomeTelemetryParams) => PhaseOutcomeTelemetry | undefined;
  readonly usageHandler: ((usage: TaskUsageEvent) => void) | undefined;
}

export interface BgEndTurnContext extends EndTurnCoreContext {
  readonly progressAssessmentEnabled?: boolean;
  readonly controlLoopTracker: ControlLoopTracker;
  readonly workerCollector: WorkerRunCollector | undefined;
  readonly progressTitle: string;
  readonly progressLanguage: ProgressLanguage;
  readonly iteration: number;
  readonly workspaceLease: WorkspaceLease | undefined;
  readonly systemPrompt: string;
  readonly emitProgress: (message: TaskProgressUpdate) => void;
  readonly buildStructuredProgressSignal: (
    prompt: string,
    title: string,
    signal: Omit<TaskProgressSignal, "userSummary"> & { userSummary?: string },
    language?: ProgressLanguage,
  ) => TaskProgressSignal;
  readonly getClarificationContext: () => ClarificationContext;
  readonly formatBoundaryVisibleText: (decision: InteractionBoundaryDecision) => string | undefined;
  readonly appendVisibleAssistantMessage: (session: Session, content: string) => void;
  readonly synthesizeUserFacingResponse: (params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    agentState: AgentState;
    strategy: SupervisorExecutionStrategy;
    systemPrompt: string;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }) => Promise<string>;
  readonly persistSessionToMemory: (chatId: string, messages: ConversationMessage[], force: boolean) => Promise<void>;
  readonly getVisibleTranscript: (session: Session) => ConversationMessage[];
}

export interface InteractiveEndTurnContext extends EndTurnCoreContext {
  readonly systemPrompt: string;
  readonly defaultLanguage: string;
  readonly profileLanguage: string | undefined;
  readonly progressAssessmentEnabled?: boolean;
  readonly controlLoopTracker?: ControlLoopTracker;
  // Consensus-related — type-erased to avoid coupling to ProviderCapabilities/ConfidenceEstimator
  readonly runTextConsensusIfCritical: (params: {
    agentState: AgentState;
    responseText: string;
    prompt: string;
    providerName: string;
  }) => Promise<void>;
}

// ─── Private helper: applyBgLoopRecoveryResult ─────────────────────────────────

function applyBgLoopRecoveryResult(
  loopRecovery: LoopRecoveryIntervention,
  ctx: BgEndTurnContext,
  agentState: AgentState,
  opts: {
    fallbackGate: string;
    replanProgressMessage: string;
    defaultProgressKind: TaskProgressKind;
    defaultProgressMessage: string;
  },
): EndTurnLoopAction {
  if (loopRecovery.action === "blocked" && loopRecovery.message) {
    return { flow: "blocked", visibleText: loopRecovery.message };
  }

  if (loopRecovery.action === "replan" && loopRecovery.gate) {
    const newState = handleVerifierReplan({
      agentState,
      executionJournal: ctx.executionJournal,
      responseText: ctx.responseText,
      reason: loopRecovery.summary ?? "Loop recovery requested a different approach.",
      providerName: ctx.executionStrategy.reviewer.providerName,
      modelId: ctx.executionStrategy.reviewer.modelId,
    });
    pushContinuationMessages(ctx, loopRecovery.gate);
    ctx.emitProgress(ctx.buildStructuredProgressSignal(
      ctx.prompt,
      ctx.progressTitle,
      {
        kind: "loop_recovery",
        message: opts.replanProgressMessage,
      },
      ctx.progressLanguage,
    ));
    return { flow: "continue", newState };
  }

  // Default: continue
  pushContinuationMessages(ctx, loopRecovery.gate ?? opts.fallbackGate);
  ctx.emitProgress(ctx.buildStructuredProgressSignal(
    ctx.prompt,
    ctx.progressTitle,
    {
      kind: opts.defaultProgressKind,
      message: opts.defaultProgressMessage,
    },
    ctx.progressLanguage,
  ));
  return { flow: "continue", newState: agentState };
}

// ─── Background loop recovery pipeline call helper ─────────────────────────────

async function runBgLoopRecovery(
  ctx: BgEndTurnContext,
  agentState: AgentState,
  kind: Parameters<typeof handleBackgroundLoopRecoveryPipeline>[0]["kind"],
  reason: string,
  gate: string | undefined,
): Promise<LoopRecoveryIntervention> {
  return handleBackgroundLoopRecoveryPipeline({
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
    daemonMode: true,
    progressAssessmentEnabled: ctx.progressAssessmentEnabled,
    taskStartedAtMs: ctx.taskStartedAtMs,
  }, ctx.interventionDeps);
}

async function runInteractiveLoopRecovery(
  ctx: InteractiveEndTurnContext,
  agentState: AgentState,
  kind: Parameters<typeof handleBackgroundLoopRecoveryPipeline>[0]["kind"],
  reason: string,
  gate: string | undefined,
): Promise<LoopRecoveryIntervention | null> {
  if (!ctx.controlLoopTracker) {
    return null;
  }

  return handleBackgroundLoopRecoveryPipeline({
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

// ─── Background end-turn handler ────────────────────────────────────────────────

export async function handleBgEndTurn(
  agentState: AgentState,
  ctx: BgEndTurnContext,
): Promise<EndTurnLoopAction> {
  // 1. Clarification intervention
  const clarificationIntervention = await resolveDraftClarificationInterventionPipeline({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    prompt: ctx.prompt,
    draft: ctx.responseText ?? "",
    state: agentState,
    strategy: ctx.executionStrategy,
    touchedFiles: [...ctx.selfVerification.getState().touchedFiles],
    usageHandler: ctx.usageHandler,
  }, ctx.interventionDeps);

  // 1a. Clarification: internal continue with loop recovery
  if (
    clarificationIntervention.kind === "continue" &&
    clarificationIntervention.gate
  ) {
    const loopRecovery = await runBgLoopRecovery(
      ctx,
      agentState,
      "clarification_internal_continue",
      "Clarification review kept the task internal.",
      clarificationIntervention.gate,
    );
    return applyBgLoopRecoveryResult(loopRecovery, ctx, agentState, {
      fallbackGate: clarificationIntervention.gate,
      replanProgressMessage: "Loop recovery requested a replan after clarification review.",
      defaultProgressKind: "clarification",
      defaultProgressMessage: "Clarification review kept the task internal",
    });
  }

  // 1b. Clarification: ask_user / blocked
  if (
    (clarificationIntervention.kind === "ask_user" ||
      clarificationIntervention.kind === "blocked") &&
    clarificationIntervention.message
  ) {
    ctx.appendVisibleAssistantMessage(ctx.session, clarificationIntervention.message);
    await ctx.persistSessionToMemory(
      ctx.chatId,
      ctx.getVisibleTranscript(ctx.session),
      /* force */ true,
    );
    return {
      flow: "done",
      visibleText: clarificationIntervention.message,
      newState: agentState,
      status: "blocked",
    };
  }

  // 2. First boundary check
  const terminalFailureDetected = isTerminalFailureReport(ctx.responseText);
  const rawBoundary = decideUserVisibleBoundaryHelper(ctx.getClarificationContext(), {
    chatId: ctx.chatId,
    prompt: ctx.prompt,
    workerDraft: ctx.responseText ?? "",
    task: ctx.executionStrategy.task,
    state: agentState,
    selfVerification: ctx.selfVerification,
    taskStartedAtMs: ctx.taskStartedAtMs,
    availableToolNames: ctx.currentToolNames,
    terminalFailureReported: terminalFailureDetected,
  });

  // 2a. Boundary: internal continue with loop recovery
  if (
    rawBoundary.kind === "internal_continue"
    && rawBoundary.gate
    && !shouldDeferRawBoundaryForDirectTarget({
      prompt: ctx.prompt,
      touchedFileCount: ctx.selfVerification.getState().touchedFiles.size,
      hasCompilableChanges: ctx.selfVerification.getState().hasCompilableChanges,
    })
  ) {
    const loopRecovery = await runBgLoopRecovery(
      ctx,
      agentState,
      "visibility_internal_continue",
      "Visibility boundary kept the task internal.",
      rawBoundary.gate,
    );
    return applyBgLoopRecoveryResult(loopRecovery, ctx, agentState, {
      fallbackGate: rawBoundary.gate,
      replanProgressMessage: "Loop recovery requested a replan after visibility review.",
      defaultProgressKind: "visibility",
      defaultProgressMessage: "Visibility boundary kept the task internal",
    });
  }

  // 2b. Boundary: plan_review or terminal_failure
  if (
    (rawBoundary.kind === "plan_review" || rawBoundary.kind === "terminal_failure") &&
    rawBoundary.visibleText
  ) {
    const surfacedText = ctx.formatBoundaryVisibleText(rawBoundary) ?? rawBoundary.visibleText ?? "";
    ctx.appendVisibleAssistantMessage(ctx.session, surfacedText);
    await ctx.persistSessionToMemory(
      ctx.chatId,
      ctx.getVisibleTranscript(ctx.session),
      /* force */ true,
    );
    return {
      flow: "done",
      visibleText: surfacedText,
      newState: agentState,
      status: rawBoundary.kind === "plan_review" ? "blocked" : "completed",
    };
  }

  // 3. Verifier intervention
  const verifierIntervention = await resolveVerifierInterventionPipeline({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    executionMode: "background",
    prompt: ctx.prompt,
    state: agentState,
    draft: ctx.responseText,
    selfVerification: ctx.selfVerification,
    stradaConformance: ctx.stradaConformance,
    strategy: ctx.executionStrategy,
    taskStartedAtMs: ctx.taskStartedAtMs,
    availableToolNames: ctx.currentToolNames,
    usageHandler: ctx.usageHandler,
  }, ctx.interventionDeps);

  if (ctx.workerCollector) {
    ctx.workerCollector.verifierResult = verifierIntervention.result;
  }
  ctx.executionJournal.recordVerifierResult(
    verifierIntervention.result,
    ctx.executionStrategy.reviewer.providerName,
    ctx.executionStrategy.reviewer.modelId,
  );

  // 3a. Verifier says "continue"
  if (verifierIntervention.kind === "continue" && verifierIntervention.gate) {
    ctx.recordPhaseOutcome({
      chatId: ctx.chatId,
      identityKey: ctx.identityKey,
      assignment: ctx.currentAssignment,
      phase: toExecutionPhaseModel(agentState.phase),
      status: "continued",
      task: ctx.executionStrategy.task,
      reason: verifierIntervention.result.summary,
      telemetry: ctx.buildPhaseOutcomeTelemetry({
        state: agentState,
        usage: ctx.responseUsage,
        verifierDecision: "continue",
        failureReason: verifierIntervention.result.summary,
      }),
    });
    const loopRecovery = await runBgLoopRecovery(
      ctx,
      agentState,
      "verifier_continue",
      verifierIntervention.result.summary,
      verifierIntervention.gate,
    );
    return applyBgLoopRecoveryResult(loopRecovery, ctx, agentState, {
      fallbackGate: verifierIntervention.gate,
      replanProgressMessage: "Loop recovery requested a replan after repeated verifier feedback.",
      defaultProgressKind: "verification",
      defaultProgressMessage: "Verification required before completion",
    });
  }

  // 3b. Verifier says "replan"
  if (verifierIntervention.kind === "replan" && verifierIntervention.gate) {
    const loopRecovery = await runBgLoopRecovery(
      ctx,
      agentState,
      "verifier_replan",
      verifierIntervention.result.summary,
      verifierIntervention.gate,
    );
    if (loopRecovery.action === "blocked" && loopRecovery.message) {
      return { flow: "blocked", visibleText: loopRecovery.message };
    }
    ctx.recordPhaseOutcome({
      chatId: ctx.chatId,
      identityKey: ctx.identityKey,
      assignment: ctx.currentAssignment,
      phase: toExecutionPhaseModel(agentState.phase),
      status: "replanned",
      task: ctx.executionStrategy.task,
      reason: verifierIntervention.result.summary,
      telemetry: ctx.buildPhaseOutcomeTelemetry({
        state: agentState,
        usage: ctx.responseUsage,
        verifierDecision: "replan",
        failureReason: verifierIntervention.result.summary,
      }),
    });
    const newState = transitionToVerifierReplanModel(agentState, ctx.responseText);
    pushContinuationMessages(ctx, loopRecovery.gate ?? verifierIntervention.gate);
    ctx.emitProgress(ctx.buildStructuredProgressSignal(
      ctx.prompt,
      ctx.progressTitle,
      {
        kind: loopRecovery.action === "replan" ? "loop_recovery" : "replanning",
        message:
          loopRecovery.action === "replan"
            ? "Loop recovery requested a replan after repeated verifier feedback."
            : "Verifier pipeline requested a replan",
      },
      ctx.progressLanguage,
    ));
    return { flow: "continue", newState };
  }

  // 4. Synthesize user-facing response
  const finalText = await ctx.synthesizeUserFacingResponse({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    prompt: ctx.prompt,
    draft: ctx.responseText ?? "",
    agentState,
    strategy: ctx.executionStrategy,
    systemPrompt: ctx.systemPrompt,
    usageHandler: ctx.usageHandler,
  });
  if (ctx.workerCollector) {
    ctx.workerCollector.lastAssignment = ctx.executionStrategy.synthesizer;
  }

  // 5. Second boundary check on synthesized text
  const finalBoundary = decideUserVisibleBoundaryHelper(ctx.getClarificationContext(), {
    chatId: ctx.chatId,
    prompt: ctx.prompt,
    workerDraft: ctx.responseText ?? "",
    visibleDraft: finalText,
    task: ctx.executionStrategy.task,
    state: agentState,
    selfVerification: ctx.selfVerification,
    taskStartedAtMs: ctx.taskStartedAtMs,
    availableToolNames: ctx.currentToolNames,
    terminalFailureReported: terminalFailureDetected,
  });

  if (finalBoundary.kind === "internal_continue" && finalBoundary.gate) {
    const loopRecovery = await runBgLoopRecovery(
      ctx,
      agentState,
      "visibility_internal_continue",
      "Visibility boundary rejected the draft.",
      finalBoundary.gate,
    );
    return applyBgLoopRecoveryResult(loopRecovery, ctx, agentState, {
      fallbackGate: finalBoundary.gate,
      replanProgressMessage: "Loop recovery requested a replan after the draft was rejected.",
      defaultProgressKind: "visibility",
      defaultProgressMessage: "Visibility boundary rejected the draft",
    });
  }

  // 6. Approved finish path
  const surfacedFinalText = finalBoundary.visibleText ?? finalText;
  if (surfacedFinalText) {
    ctx.appendVisibleAssistantMessage(ctx.session, surfacedFinalText);
  }
  ctx.recordPhaseOutcome({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    assignment: ctx.currentAssignment,
    phase: toExecutionPhaseModel(agentState.phase),
    status: "approved",
    task: ctx.executionStrategy.task,
    reason:
      "Execution produced a final response after the verifier pipeline cleared the task.",
    telemetry: ctx.buildPhaseOutcomeTelemetry({
      state: agentState,
      usage: ctx.responseUsage,
      verifierDecision: "approve",
    }),
  });
  await ctx.persistSessionToMemory(
    ctx.chatId,
    ctx.getVisibleTranscript(ctx.session),
    /* force */ true,
  );
  return {
    flow: "done",
    visibleText: surfacedFinalText || "Task completed without output.",
    newState: agentState,
  };
}

// ─── Interactive end-turn handler ───────────────────────────────────────────────

export async function handleInteractiveEndTurn(
  agentState: AgentState,
  ctx: InteractiveEndTurnContext,
): Promise<EndTurnLoopAction> {
  const logger = getLogger();

  // 1. Clarification intervention
  const clarificationIntervention = await resolveDraftClarificationInterventionPipeline({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    prompt: ctx.prompt,
    draft: ctx.responseText ?? "",
    state: agentState,
    strategy: ctx.executionStrategy,
    touchedFiles: [...ctx.selfVerification.getState().touchedFiles],
    usageHandler: ctx.usageHandler,
  }, ctx.interventionDeps);

  // 1a. Clarification: internal continue
  if (clarificationIntervention.kind === "continue" && clarificationIntervention.gate) {
    const loopRecovery = await runInteractiveLoopRecovery(
      ctx,
      agentState,
      "clarification_internal_continue",
      "Clarification review kept the task internal.",
      clarificationIntervention.gate,
    );
    if (loopRecovery?.action === "blocked" && loopRecovery.message) {
      return { flow: "blocked", visibleText: loopRecovery.message };
    }
    if (loopRecovery?.action === "replan" && loopRecovery.gate) {
      pushContinuationMessages(ctx, loopRecovery.gate);
      return {
        flow: "continue",
        newState: transitionToVerifierReplanModel(agentState, ctx.responseText),
      };
    }
    pushContinuationMessages(ctx, loopRecovery?.gate ?? clarificationIntervention.gate);
    return { flow: "continue", newState: agentState };
  }

  // 1b. Clarification: ask_user / blocked
  if (
    (clarificationIntervention.kind === "ask_user" ||
      clarificationIntervention.kind === "blocked") &&
    clarificationIntervention.message
  ) {
    return {
      flow: "done",
      visibleText: clarificationIntervention.message,
      newState: agentState,
      status: "blocked",
    };
  }

  // 2. Verification gate: catch unverified exits
  const verifierIntervention = await resolveVerifierInterventionPipeline({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    executionMode: "interactive",
    prompt: ctx.prompt,
    state: agentState,
    draft: ctx.responseText,
    selfVerification: ctx.selfVerification,
    stradaConformance: ctx.stradaConformance,
    strategy: ctx.executionStrategy,
    taskStartedAtMs: ctx.taskStartedAtMs,
    availableToolNames: ctx.currentToolNames,
    usageHandler: ctx.usageHandler,
  }, ctx.interventionDeps);

  // 2a. Verifier: continue
  if (verifierIntervention.kind === "continue" && verifierIntervention.gate) {
    const loopRecovery = await runInteractiveLoopRecovery(
      ctx,
      agentState,
      "verifier_continue",
      verifierIntervention.result.summary,
      verifierIntervention.gate,
    );
    const status =
      loopRecovery?.action === "replan"
        ? "replanned"
        : loopRecovery?.action === "blocked"
          ? "blocked"
          : "continued";
    ctx.recordPhaseOutcome({
      chatId: ctx.chatId,
      identityKey: ctx.identityKey,
      assignment: ctx.currentAssignment,
      phase: toExecutionPhaseModel(agentState.phase),
      status,
      task: ctx.executionStrategy.task,
      reason: verifierIntervention.result.summary,
      telemetry: ctx.buildPhaseOutcomeTelemetry({
        state: agentState,
        usage: ctx.responseUsage,
        verifierDecision: loopRecovery?.action === "replan" ? "replan" : "continue",
        failureReason: verifierIntervention.result.summary,
      }),
    });
    if (loopRecovery?.action === "blocked" && loopRecovery.message) {
      return { flow: "blocked", visibleText: loopRecovery.message };
    }
    if (loopRecovery?.action === "replan" && loopRecovery.gate) {
      pushContinuationMessages(ctx, loopRecovery.gate);
      return {
        flow: "continue",
        newState: transitionToVerifierReplanModel(agentState, ctx.responseText),
      };
    }
    pushContinuationMessages(ctx, loopRecovery?.gate ?? verifierIntervention.gate);
    logger.debug("Verification gate triggered", { chatId: ctx.chatId });
    return { flow: "continue", newState: agentState };
  }

  // 2b. Verifier: replan
  if (verifierIntervention.kind === "replan" && verifierIntervention.gate) {
    ctx.recordPhaseOutcome({
      chatId: ctx.chatId,
      identityKey: ctx.identityKey,
      assignment: ctx.currentAssignment,
      phase: toExecutionPhaseModel(agentState.phase),
      status: "replanned",
      task: ctx.executionStrategy.task,
      reason: verifierIntervention.result.summary,
      telemetry: ctx.buildPhaseOutcomeTelemetry({
        state: agentState,
        usage: ctx.responseUsage,
        verifierDecision: "replan",
        failureReason: verifierIntervention.result.summary,
      }),
    });
    const newState = transitionToVerifierReplanModel(agentState, ctx.responseText);
    pushContinuationMessages(ctx, verifierIntervention.gate);
    logger.debug("Verifier pipeline triggered replan", { chatId: ctx.chatId });
    return { flow: "continue", newState };
  }

  // 3. Consensus for text-only responses on critical tasks
  if (ctx.responseText) {
    try {
      await ctx.runTextConsensusIfCritical({
        agentState,
        responseText: ctx.responseText,
        prompt: ctx.prompt,
        providerName: ctx.currentAssignment.providerName,
      });
    } catch {
      // Consensus failure is non-fatal
    }
  }

  // 4. Visibility decision pipeline
  if (ctx.responseText) {
    const visibilityDecision = await resolveVisibleDraftDecisionPipeline({
      chatId: ctx.chatId,
      identityKey: ctx.identityKey,
      prompt: ctx.prompt,
      draft: ctx.responseText,
      agentState,
      strategy: ctx.executionStrategy,
      systemPrompt: ctx.systemPrompt,
      selfVerification: ctx.selfVerification,
      taskStartedAtMs: ctx.taskStartedAtMs,
      availableToolNames: ctx.currentToolNames,
      usageHandler: ctx.usageHandler,
    }, ctx.interventionDeps);

    // 4a. Internal continue
    if (visibilityDecision.kind === "internal_continue" && visibilityDecision.gate) {
      const loopRecovery = await runInteractiveLoopRecovery(
        ctx,
        agentState,
        "visibility_internal_continue",
        visibilityDecision.reason,
        visibilityDecision.gate,
      );
      if (loopRecovery?.action === "blocked" && loopRecovery.message) {
        return { flow: "blocked", visibleText: loopRecovery.message };
      }
      if (loopRecovery?.action === "replan" && loopRecovery.gate) {
        pushContinuationMessages(ctx, loopRecovery.gate);
        return {
          flow: "continue",
          newState: transitionToVerifierReplanModel(agentState, ctx.responseText),
        };
      }
      ctx.session.messages.push({ role: "assistant", content: ctx.responseText });
      ctx.session.messages.push({ role: "user", content: loopRecovery?.gate ?? visibilityDecision.gate });
      return { flow: "continue", newState: agentState };
    }

    // 4b. plan_review / blocked / ask_user
    if (
      (visibilityDecision.kind === "plan_review" ||
        visibilityDecision.kind === "blocked" ||
        visibilityDecision.kind === "ask_user") &&
      visibilityDecision.visibleText
    ) {
      ctx.recordPhaseOutcome({
        chatId: ctx.chatId,
        identityKey: ctx.identityKey,
        assignment: ctx.currentAssignment,
        phase: toExecutionPhaseModel(agentState.phase),
        status: "blocked",
        task: ctx.executionStrategy.task,
        reason: visibilityDecision.reason,
        telemetry: ctx.buildPhaseOutcomeTelemetry({
          state: agentState,
          usage: ctx.responseUsage,
          verifierDecision: "approve",
        }),
      });
      return {
        flow: "done",
        visibleText: visibilityDecision.visibleText,
        newState: agentState,
        status: "blocked",
      };
    }

    // 4c. Approved path
    const finalText = visibilityDecision.visibleText?.trim() ?? "";
    ctx.recordPhaseOutcome({
      chatId: ctx.chatId,
      identityKey: ctx.identityKey,
      assignment: ctx.currentAssignment,
      phase: toExecutionPhaseModel(agentState.phase),
      status: "approved",
      task: ctx.executionStrategy.task,
      reason: visibilityDecision.reason,
      telemetry: ctx.buildPhaseOutcomeTelemetry({
        state: agentState,
        usage: ctx.responseUsage,
        verifierDecision: "approve",
      }),
    });
    return {
      flow: "done",
      visibleText: finalText,
      newState: agentState,
    };
  }

  // 5. Empty response fallback
  const lang = ctx.profileLanguage ?? ctx.defaultLanguage;
  const fallback =
    lang === "tr"
      ? "Bir yanıt oluşturamadım. Sorunuzu yeniden ifade edebilir misiniz?"
      : lang === "ja"
        ? "応答を生成できませんでした。質問を言い換えていただけますか？"
        : lang === "ko"
          ? "응답을 생성할 수 없었습니다. 질문을 다시 표현해 주시겠어요?"
          : lang === "zh"
            ? "我无法生成回复。您能重新表述您的问题吗？"
            : lang === "de"
              ? "Ich konnte keine Antwort generieren. Könnten Sie Ihre Frage umformulieren?"
              : lang === "es"
                ? "No pude generar una respuesta. ¿Podría reformular su pregunta?"
                : lang === "fr"
                  ? "Je n'ai pas pu générer de réponse. Pourriez-vous reformuler votre question ?"
                  : "I wasn't able to generate a response. Could you rephrase your question?";
  logger.warn("LLM returned empty response", {
    chatId: ctx.chatId,
    provider: ctx.currentAssignment.providerName,
  });
  return {
    flow: "done",
    visibleText: fallback,
    newState: agentState,
  };
}
