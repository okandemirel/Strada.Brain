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
import { shouldDeferRawBoundaryForDirectTarget } from "./prompt-targets.js";

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

export interface InteractiveReflectionContext extends ReflectionCoreContext {
  readonly systemPrompt: string;
  readonly progressAssessmentEnabled?: boolean;
  readonly controlLoopTracker?: ControlLoopTracker;
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
    defaultContinueState?: AgentState;
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
  const newState = opts.defaultContinueState ?? applyReflectionContinuation(agentState, ctx.responseText);
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

type BgLoopRecoveryKind = Parameters<typeof handleBackgroundLoopRecoveryPipeline>[0]["kind"];

interface BgLoopRecoveryDirective {
  readonly kind: BgLoopRecoveryKind;
  readonly reason: string;
  readonly gate: string;
  readonly fallbackGate: string;
  readonly replanProgressMessage: string;
  readonly defaultProgressKind: TaskProgressKind;
  readonly defaultProgressMessage: string;
}

type BgReflectionCompletionEvaluation =
  | {
    readonly kind: "done";
    readonly visibleText: string;
    readonly status?: "blocked" | "completed";
    readonly approved?: boolean;
  }
  | {
    readonly kind: "blocked";
    readonly visibleText: string;
  }
  | {
    readonly kind: "loop_recovery";
    readonly directive: BgLoopRecoveryDirective;
  }
  | {
    readonly kind: "verifier_replan";
    readonly gate: string;
    readonly summary: string;
  };

function buildBgLoopRecoveryDirective(params: BgLoopRecoveryDirective): BgLoopRecoveryDirective {
  return params;
}

async function completeBgReflectionDone(
  agentState: AgentState,
  ctx: BgReflectionContext,
  evaluation: Extract<BgReflectionCompletionEvaluation, { kind: "done" }>,
): Promise<ReflectionLoopAction> {
  if (evaluation.visibleText) {
    ctx.appendVisibleAssistantMessage(ctx.session, evaluation.visibleText);
  }
  if (evaluation.approved) {
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
  }
  await ctx.persistSessionToMemory(
    ctx.chatId,
    ctx.getVisibleTranscript(ctx.session),
    /* force */ true,
  );
  return {
    flow: "done",
    visibleText: evaluation.visibleText || "Task completed without output.",
    newState: agentState,
    status: evaluation.status,
  };
}

async function applyBgReflectionLoopRecovery(
  agentState: AgentState,
  ctx: BgReflectionContext,
  directive: BgLoopRecoveryDirective,
  defaultContinueState?: AgentState,
): Promise<ReflectionLoopAction> {
  const loopRecovery = await runBgLoopRecovery(
    ctx,
    agentState,
    directive.kind,
    directive.reason,
    directive.gate,
  );
  return applyBgLoopRecoveryResult(loopRecovery, ctx, agentState, {
    fallbackGate: directive.fallbackGate,
    replanProgressMessage: directive.replanProgressMessage,
    defaultProgressKind: directive.defaultProgressKind,
    defaultProgressMessage: directive.defaultProgressMessage,
    defaultContinueState,
  });
}

async function applyBgVerifierReplan(
  agentState: AgentState,
  ctx: BgReflectionContext,
  summary: string,
  gate: string,
): Promise<ReflectionLoopAction> {
  const loopRecovery = await runBgLoopRecovery(
    ctx,
    agentState,
    "verifier_replan",
    summary,
    gate,
  );
  if (loopRecovery.action === "blocked" && loopRecovery.message) {
    return { flow: "blocked", visibleText: loopRecovery.message };
  }
  const newState = handleVerifierReplan({
    agentState,
    executionJournal: ctx.executionJournal,
    responseText: ctx.responseText,
    reason: loopRecovery.summary ?? summary,
    providerName: ctx.executionStrategy.reviewer.providerName,
    modelId: ctx.executionStrategy.reviewer.modelId,
    onBeforeTransition: () => ctx.recordPhaseOutcome({
      chatId: ctx.chatId,
      identityKey: ctx.identityKey,
      assignment: ctx.currentAssignment,
      phase: "reflecting",
      status: "replanned",
      task: ctx.executionStrategy.task,
      reason: summary,
      telemetry: ctx.buildPhaseOutcomeTelemetry({
        state: agentState,
        usage: ctx.responseUsage,
        verifierDecision: "replan",
        failureReason: summary,
      }),
    }),
  });
  pushContinuationMessages(ctx, loopRecovery.gate ?? gate);
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

async function evaluateBgReflectionCompletion(
  agentState: AgentState,
  ctx: BgReflectionContext,
): Promise<BgReflectionCompletionEvaluation> {
  const terminalFailureDetected = isTerminalFailureReport(ctx.responseText);

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
    return {
      kind: "loop_recovery",
      directive: buildBgLoopRecoveryDirective({
        kind: "clarification_internal_continue",
        reason: "Clarification review kept the task internal.",
        gate: clarificationIntervention.gate,
        fallbackGate: clarificationIntervention.gate,
        replanProgressMessage: "Loop recovery requested a replan after clarification review.",
        defaultProgressKind: "clarification",
        defaultProgressMessage: "Clarification review kept the task internal",
      }),
    };
  }
  if (
    (clarificationIntervention.kind === "ask_user" ||
      clarificationIntervention.kind === "blocked") &&
    clarificationIntervention.message
  ) {
    return { kind: "blocked", visibleText: clarificationIntervention.message };
  }

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

  if (
    rawBoundary.kind === "internal_continue"
    && rawBoundary.gate
    && !shouldDeferRawBoundaryForDirectTarget({
      prompt: ctx.prompt,
      touchedFileCount: ctx.selfVerification.getState().touchedFiles.size,
      hasCompilableChanges: ctx.selfVerification.getState().hasCompilableChanges,
    })
  ) {
    return {
      kind: "loop_recovery",
      directive: buildBgLoopRecoveryDirective({
        kind: "visibility_internal_continue",
        reason: "Visibility boundary kept the task internal.",
        gate: rawBoundary.gate,
        fallbackGate: rawBoundary.gate,
        replanProgressMessage: "Loop recovery requested a replan after visibility review.",
        defaultProgressKind: "visibility",
        defaultProgressMessage: "Visibility boundary kept the task internal",
      }),
    };
  }

  if (
    (rawBoundary.kind === "plan_review" || rawBoundary.kind === "terminal_failure") &&
    rawBoundary.visibleText
  ) {
    return {
      kind: "done",
      visibleText: ctx.formatBoundaryVisibleText(rawBoundary) ?? rawBoundary.visibleText ?? "",
      status: rawBoundary.kind === "plan_review" ? "blocked" : "completed",
    };
  }

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
    return {
      kind: "loop_recovery",
      directive: buildBgLoopRecoveryDirective({
        kind: "verifier_continue",
        reason: verifierIntervention.result.summary,
        gate: verifierIntervention.gate,
        fallbackGate: verifierIntervention.gate,
        replanProgressMessage: "Loop recovery requested a replan after repeated verifier feedback.",
        defaultProgressKind: "verification",
        defaultProgressMessage: "Verification required before completion",
      }),
    };
  }

  if (verifierIntervention.kind === "replan" && verifierIntervention.gate) {
    return {
      kind: "verifier_replan",
      gate: verifierIntervention.gate,
      summary: verifierIntervention.result.summary,
    };
  }

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
    return {
      kind: "loop_recovery",
      directive: buildBgLoopRecoveryDirective({
        kind: "visibility_internal_continue",
        reason: "Visibility boundary rejected the draft.",
        gate: finalBoundary.gate,
        fallbackGate: finalBoundary.gate,
        replanProgressMessage: "Loop recovery requested a replan after the draft was rejected.",
        defaultProgressKind: "visibility",
        defaultProgressMessage: "Visibility boundary rejected the draft",
      }),
    };
  }

  return {
    kind: "done",
    visibleText: finalBoundary.visibleText ?? finalText,
    approved: true,
  };
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
    daemonMode: true,
    progressAssessmentEnabled: ctx.progressAssessmentEnabled,
    taskStartedAtMs: ctx.taskStartedAtMs,
  }, ctx.interventionDeps);
}

async function runInteractiveLoopRecovery(
  ctx: InteractiveReflectionContext,
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

// ─── Background DONE handler ───────────────────────────────────────────────────

export async function handleBgReflectionDone(
  agentState: AgentState,
  ctx: BgReflectionContext,
): Promise<ReflectionLoopAction> {
  const evaluation = await evaluateBgReflectionCompletion(agentState, ctx);

  if (evaluation.kind === "blocked") {
    return { flow: "blocked", visibleText: evaluation.visibleText };
  }
  if (evaluation.kind === "done") {
    return completeBgReflectionDone(agentState, ctx, evaluation);
  }
  if (evaluation.kind === "verifier_replan") {
    return applyBgVerifierReplan(agentState, ctx, evaluation.summary, evaluation.gate);
  }

  return applyBgReflectionLoopRecovery(agentState, ctx, evaluation.directive);
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

export async function handleBgReflectionContinue(
  agentState: AgentState,
  ctx: BgReflectionContext,
  responseToolCallCount: number,
): Promise<ReflectionLoopAction> {
  const newState = applyReflectionContinuation(agentState, ctx.responseText, { skipLastReflection: true });
  if (responseToolCallCount === 0) {
    const cleanedDraft = ctx.interventionDeps.stripInternalDecisionMarkers(ctx.responseText ?? "").trim();
    if (cleanedDraft) {
      const evaluation = await evaluateBgReflectionCompletion(agentState, ctx);
      if (evaluation.kind === "blocked") {
        return { flow: "blocked", visibleText: evaluation.visibleText };
      }
      if (evaluation.kind === "done") {
        return completeBgReflectionDone(agentState, ctx, evaluation);
      }
      if (evaluation.kind === "verifier_replan") {
        return applyBgVerifierReplan(agentState, ctx, evaluation.summary, evaluation.gate);
      }
      return applyBgReflectionLoopRecovery(agentState, ctx, evaluation.directive, newState);
    }
    const loopRecovery = await runBgLoopRecovery(
      ctx,
      agentState,
      "reflection_continue",
      "Reflection requested continuation without tool execution.",
      "Please continue.",
    );
    if (loopRecovery.action === "blocked" && loopRecovery.message) {
      return { flow: "blocked", visibleText: loopRecovery.message };
    }
    if (loopRecovery.action === "replan" && loopRecovery.gate) {
      const replannedState = handleVerifierReplan({
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
          message: "Loop recovery requested a replan after reflection continue.",
        },
        ctx.progressLanguage,
      ));
      return { flow: "continue", newState: replannedState };
    }
    return applyBgLoopRecoveryResult(loopRecovery, ctx, agentState, {
      fallbackGate: "Please continue.",
      replanProgressMessage: "Loop recovery requested a replan after reflection continue.",
      defaultProgressKind: "analysis",
      defaultProgressMessage: "Reflection continued without tool execution",
      defaultContinueState: newState,
    });
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
        newState: handleVerifierReplan({
          agentState,
          executionJournal: ctx.executionJournal,
          responseText: ctx.responseText,
          reason: loopRecovery.summary ?? "Loop recovery requested a different approach.",
          providerName: ctx.executionStrategy.reviewer.providerName,
          modelId: ctx.executionStrategy.reviewer.modelId,
        }),
      };
    }
    const newState = applyReflectionContinuation(agentState, ctx.responseText);
    pushContinuationMessages(ctx, loopRecovery?.gate ?? clarificationIntervention.gate);
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
  ctx.executionJournal.recordVerifierResult(
    verifierIntervention.result,
    ctx.executionStrategy.reviewer.providerName,
    ctx.executionStrategy.reviewer.modelId,
  );

  // 2a. Verifier says "continue"
  if (verifierIntervention.kind === "continue" && verifierIntervention.gate) {
    const loopRecovery = await runInteractiveLoopRecovery(
      ctx,
      agentState,
      "verifier_continue",
      verifierIntervention.result.summary,
      verifierIntervention.gate,
    );
    const continuedState = applyReflectionContinuation(agentState, ctx.responseText);
    const recoveryStatus =
      loopRecovery?.action === "replan"
        ? "replanned"
        : loopRecovery?.action === "blocked"
          ? "blocked"
          : "continued";
    ctx.recordPhaseOutcome({
      chatId: ctx.chatId,
      identityKey: ctx.identityKey,
      assignment: ctx.currentAssignment,
      phase: "reflecting",
      status: recoveryStatus,
      task: ctx.executionStrategy.task,
      reason: verifierIntervention.result.summary,
      telemetry: ctx.buildPhaseOutcomeTelemetry({
        state: loopRecovery?.action === "replan" ? continuedState : agentState,
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
        newState: handleVerifierReplan({
          agentState,
          executionJournal: ctx.executionJournal,
          responseText: ctx.responseText,
          reason: loopRecovery.summary ?? verifierIntervention.result.summary,
          providerName: ctx.executionStrategy.reviewer.providerName,
          modelId: ctx.executionStrategy.reviewer.modelId,
        }),
      };
    }
    pushContinuationMessages(ctx, loopRecovery?.gate ?? verifierIntervention.gate);
    return { flow: "continue", newState: continuedState };
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
        newState: handleVerifierReplan({
          agentState,
          executionJournal: ctx.executionJournal,
          responseText: ctx.responseText,
          reason: loopRecovery.summary ?? visibilityDecision.reason,
          providerName: ctx.executionStrategy.reviewer.providerName,
          modelId: ctx.executionStrategy.reviewer.modelId,
        }),
      };
    }
    pushContinuationMessages(ctx, loopRecovery?.gate ?? visibilityDecision.gate);
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

    const loopRecovery = await runInteractiveLoopRecovery(
      ctx,
      agentState,
      "reflection_continue",
      "Reflection requested continuation without tool execution.",
      "Please continue.",
    );
    if (loopRecovery?.action === "blocked" && loopRecovery.message) {
      return { flow: "blocked", visibleText: loopRecovery.message };
    }
    if (loopRecovery?.action === "replan" && loopRecovery.gate) {
      pushContinuationMessages(ctx, loopRecovery.gate);
      return {
        flow: "continue",
        newState: handleVerifierReplan({
          agentState,
          executionJournal: ctx.executionJournal,
          responseText: ctx.responseText,
          reason: loopRecovery.summary ?? "Loop recovery requested a different approach.",
          providerName: ctx.executionStrategy.reviewer.providerName,
          modelId: ctx.executionStrategy.reviewer.modelId,
        }),
      };
    }

    pushContinuationMessages(ctx, loopRecovery?.gate ?? "Please continue.");
  }

  return { flow: "continue", newState };
}
