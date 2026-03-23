/**
 * Orchestrator Reflection Handler — standalone functions for the REFLECTING
 * phase DONE/REPLAN/CONTINUE branches in both background and interactive loops.
 *
 * Extracted from orchestrator.ts to reduce its line count.
 * Each function returns a `ReflectionLoopAction` discriminated union that the
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
  applyReflectionContinuation,
  handleReplanDecision,
  handleVerifierReplan,
} from "./orchestrator-loop-utils.js";
import { shouldSurfaceTerminalFailureFromReflection } from "./orchestrator-runtime-utils.js";
import {
  pushContinuationMessages,
  type RecordPhaseOutcomeParams,
  type BuildPhaseOutcomeTelemetryParams,
} from "./orchestrator-loop-shared.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ReflectionLoopAction =
  | { flow: "continue"; newState: AgentState }
  | { flow: "done"; visibleText: string; newState: AgentState; status?: "blocked" | "completed" }
  | { flow: "blocked"; visibleText: string; status?: "blocked" | "completed" };

// ─── Context interfaces ────────────────────────────────────────────────────────

export interface ReflectionCoreContext {
  readonly chatId: string;
  readonly identityKey: string;
  readonly prompt: string;
  readonly responseText: string | undefined;
  readonly responseUsage: ProviderResponse["usage"];
  readonly toolCallCount: number;
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

export interface BgReflectionContext extends ReflectionCoreContext {
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

export interface InteractiveReflectionContext extends ReflectionCoreContext {
  readonly systemPrompt: string;
}

// ─── Private helper: applyBgLoopRecoveryResult ─────────────────────────────────

function applyBgLoopRecoveryResult(
  loopRecovery: LoopRecoveryIntervention,
  ctx: BgReflectionContext,
  agentState: AgentState,
  opts: {
    fallbackGate: string;
    replanProgressMessage: string;
    defaultProgressKind: TaskProgressKind;
    defaultProgressMessage: string;
  },
): ReflectionLoopAction {
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
  const newState = applyReflectionContinuation(agentState, ctx.responseText);
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
  return { flow: "continue", newState };
}

// ─── Background loop recovery pipeline call helper ─────────────────────────────

async function runBgLoopRecovery(
  ctx: BgReflectionContext,
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
  }, ctx.interventionDeps);
}

// ─── Background DONE handler ───────────────────────────────────────────────────

export async function handleBgReflectionDone(
  agentState: AgentState,
  ctx: BgReflectionContext,
): Promise<ReflectionLoopAction> {
  const terminalFailureDetected = isTerminalFailureReport(ctx.responseText);

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

  if (clarificationIntervention.kind === "continue" && clarificationIntervention.gate) {
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
  if (
    (clarificationIntervention.kind === "ask_user" ||
      clarificationIntervention.kind === "blocked") &&
    clarificationIntervention.message
  ) {
    return { flow: "blocked", visibleText: clarificationIntervention.message };
  }

  // 2. First boundary check
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

  if (rawBoundary.kind === "internal_continue" && rawBoundary.gate) {
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
      phase: "reflecting",
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
    const newState = handleVerifierReplan({
      agentState,
      executionJournal: ctx.executionJournal,
      responseText: ctx.responseText,
      reason: loopRecovery.summary ?? verifierIntervention.result.summary,
      providerName: ctx.executionStrategy.reviewer.providerName,
      modelId: ctx.executionStrategy.reviewer.modelId,
      onBeforeTransition: () => ctx.recordPhaseOutcome({
        chatId: ctx.chatId,
        identityKey: ctx.identityKey,
        assignment: ctx.currentAssignment,
        phase: "reflecting",
        status: "replanned",
        task: ctx.executionStrategy.task,
        reason: verifierIntervention.result.summary,
        telemetry: ctx.buildPhaseOutcomeTelemetry({
          state: agentState,
          usage: ctx.responseUsage,
          verifierDecision: "replan",
          failureReason: verifierIntervention.result.summary,
        }),
      }),
    });
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
    phase: "reflecting",
    status: "approved",
    task: ctx.executionStrategy.task,
    reason: "Reflection accepted completion after the verifier pipeline cleared the task.",
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

// ─── Background REPLAN handler ─────────────────────────────────────────────────

export function handleBgReflectionReplan(
  agentState: AgentState,
  ctx: BgReflectionContext,
): ReflectionLoopAction {
  const newState = handleReplanDecision({
    agentState,
    executionJournal: ctx.executionJournal,
    responseText: ctx.responseText,
    providerName: ctx.currentAssignment.providerName,
    modelId: ctx.currentAssignment.modelId,
  });
  if (ctx.responseText) {
    ctx.session.messages.push({ role: "assistant", content: ctx.responseText });
  }
  ctx.recordPhaseOutcome({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    assignment: ctx.currentAssignment,
    phase: "reflecting",
    status: "replanned",
    task: ctx.executionStrategy.task,
    reason: ctx.responseText ?? "reflection requested a new plan",
    telemetry: ctx.buildPhaseOutcomeTelemetry({
      state: newState,
      usage: ctx.responseUsage,
      failureReason: ctx.responseText,
    }),
  });
  ctx.session.messages.push({ role: "user", content: "Please create a new plan." });
  ctx.emitProgress(ctx.buildStructuredProgressSignal(
    ctx.prompt,
    ctx.progressTitle,
    {
      kind: "replanning",
      message: "Replanning: current approach needs adjustment",
    },
    ctx.progressLanguage,
  ));
  return { flow: "continue", newState };
}

// ─── Background CONTINUE handler ──────────────────────────────────────────────

export function handleBgReflectionContinue(
  agentState: AgentState,
  ctx: BgReflectionContext,
  responseToolCallCount: number,
): ReflectionLoopAction {
  const newState = applyReflectionContinuation(agentState, ctx.responseText, { skipLastReflection: true });
  if (responseToolCallCount === 0) {
    pushContinuationMessages(ctx, "Please continue.");
  }
  return { flow: "continue", newState };
}

// ─── Interactive DONE handler ──────────────────────────────────────────────────

export async function handleInteractiveReflectionDone(
  agentState: AgentState,
  ctx: InteractiveReflectionContext,
): Promise<ReflectionLoopAction> {
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

  if (clarificationIntervention.kind === "continue" && clarificationIntervention.gate) {
    const newState = applyReflectionContinuation(agentState, ctx.responseText);
    pushContinuationMessages(ctx, clarificationIntervention.gate);
    return { flow: "continue", newState };
  }
  if (
    (clarificationIntervention.kind === "ask_user" ||
      clarificationIntervention.kind === "blocked") &&
    clarificationIntervention.message
  ) {
    return { flow: "done", visibleText: clarificationIntervention.message, newState: agentState, status: "blocked" };
  }

  // 2. Verifier intervention
  const verifierIntervention = await resolveVerifierInterventionPipeline({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
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
  ctx.executionJournal.recordVerifierResult(
    verifierIntervention.result,
    ctx.executionStrategy.reviewer.providerName,
    ctx.executionStrategy.reviewer.modelId,
  );

  // 2a. Verifier says "continue"
  if (verifierIntervention.kind === "continue" && verifierIntervention.gate) {
    ctx.recordPhaseOutcome({
      chatId: ctx.chatId,
      identityKey: ctx.identityKey,
      assignment: ctx.currentAssignment,
      phase: "reflecting",
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
    const newState = applyReflectionContinuation(agentState, ctx.responseText);
    pushContinuationMessages(ctx, verifierIntervention.gate);
    return { flow: "continue", newState };
  }

  // 2b. Verifier says "replan"
  if (verifierIntervention.kind === "replan" && verifierIntervention.gate) {
    const newState = handleVerifierReplan({
      agentState,
      executionJournal: ctx.executionJournal,
      responseText: ctx.responseText,
      reason: verifierIntervention.result.summary,
      providerName: ctx.executionStrategy.reviewer.providerName,
      modelId: ctx.executionStrategy.reviewer.modelId,
      onBeforeTransition: () => ctx.recordPhaseOutcome({
        chatId: ctx.chatId,
        identityKey: ctx.identityKey,
        assignment: ctx.currentAssignment,
        phase: "reflecting",
        status: "replanned",
        task: ctx.executionStrategy.task,
        reason: verifierIntervention.result.summary,
        telemetry: ctx.buildPhaseOutcomeTelemetry({
          state: agentState,
          usage: ctx.responseUsage,
          verifierDecision: "replan",
          failureReason: verifierIntervention.result.summary,
        }),
      }),
    });
    pushContinuationMessages(ctx, verifierIntervention.gate);
    return { flow: "continue", newState };
  }

  // 3. Visibility decision pipeline
  const visibilityDecision = await resolveVisibleDraftDecisionPipeline({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    prompt: ctx.prompt,
    draft: ctx.responseText ?? "",
    agentState,
    strategy: ctx.executionStrategy,
    systemPrompt: ctx.systemPrompt,
    selfVerification: ctx.selfVerification,
    taskStartedAtMs: ctx.taskStartedAtMs,
    availableToolNames: ctx.currentToolNames,
    usageHandler: ctx.usageHandler,
  }, ctx.interventionDeps);

  if (visibilityDecision.kind === "internal_continue" && visibilityDecision.gate) {
    pushContinuationMessages(ctx, visibilityDecision.gate);
    const newState = applyReflectionContinuation(agentState, ctx.responseText);
    return { flow: "continue", newState };
  }

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
      phase: "reflecting",
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

  // Approved path
  const finalText = visibilityDecision.visibleText?.trim() ?? "";
  ctx.recordPhaseOutcome({
    chatId: ctx.chatId,
    identityKey: ctx.identityKey,
    assignment: ctx.currentAssignment,
    phase: "reflecting",
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

// ─── Interactive REPLAN handler ────────────────────────────────────────────────

/**
 * State transition only. Does NOT push session messages or record telemetry.
 * The caller handles those AFTER goal decomposition to preserve message ordering.
 */
export function handleInteractiveReflectionReplan(
  agentState: AgentState,
  ctx: InteractiveReflectionContext,
): ReflectionLoopAction {
  const replannedState = handleReplanDecision({
    agentState,
    executionJournal: ctx.executionJournal,
    responseText: ctx.responseText,
    providerName: ctx.currentAssignment.providerName,
    modelId: ctx.currentAssignment.modelId,
    autoTransition: false,
  });
  return { flow: "continue", newState: replannedState };
}

// ─── Interactive CONTINUE handler ──────────────────────────────────────────────

export async function handleInteractiveReflectionContinue(
  agentState: AgentState,
  ctx: InteractiveReflectionContext,
  response: ProviderResponse,
): Promise<ReflectionLoopAction> {
  const newState = applyReflectionContinuation(agentState, ctx.responseText, { skipLastReflection: true });

  if (response.toolCalls.length === 0) {
    if (shouldSurfaceTerminalFailureFromReflection(response)) {
      const visibilityDecision = await resolveVisibleDraftDecisionPipeline({
        chatId: ctx.chatId,
        identityKey: ctx.identityKey,
        prompt: ctx.prompt,
        draft: ctx.responseText ?? "",
        agentState: newState,
        strategy: ctx.executionStrategy,
        systemPrompt: ctx.systemPrompt,
        selfVerification: ctx.selfVerification,
        taskStartedAtMs: ctx.taskStartedAtMs,
        availableToolNames: ctx.currentToolNames,
        terminalFailureReported: true,
        usageHandler: ctx.usageHandler,
      }, ctx.interventionDeps);
      if (visibilityDecision.kind === "internal_continue" && visibilityDecision.gate) {
        pushContinuationMessages(ctx, visibilityDecision.gate);
        return { flow: "continue", newState };
      }
      return {
        flow: "done",
        visibleText: visibilityDecision.visibleText ?? "",
        newState,
      };
    }

    pushContinuationMessages(ctx, "Please continue.");
  }

  return { flow: "continue", newState };
}
