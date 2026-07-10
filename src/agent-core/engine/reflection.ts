/**
 * Agent Core v2 — engine reflection/end-turn dispatch (relocation Step 6b; blueprint:
 * project_v2_engine_relocation). HIGHEST-CARE: the port's reflection + end-turn + plan-phase
 * dispatch and their context builders — the agent's core terminate-vs-continue decision path.
 * Moved VERBATIM from orchestrator.ts (mechanical this.X -> deps.X / imported-helper / accounting-fn
 * / render-fn). The intervention-deps bundle builder (which wires executeToolCalls[Step 8] +
 * synthesizeUserFacingResponse[shell-stays]) is injected as an OPAQUE callback; the goal-decomposition
 * side-effects + clarification/consensus/dm-policy are injected too.
 *
 * Import rule (cycle safety): orchestrator-FREE leaves only (intervention-pipeline / clarification /
 * end-turn+reflection handlers / supervisor-routing are all leaves) — see engine-deps.ts.
 */

import { AgentPhase, transitionPhase, type AgentState } from "../../agents/agent-state.js";
import type { ProviderResponse, ConversationMessage } from "../../agents/providers/provider-core.interface.js";
import type { Session } from "../../agents/orchestrator-session-manager.js";
import type { TaskUsageEvent, TaskProgressSignal } from "../../tasks/types.js";
import type { ProgressLanguage } from "../../tasks/progress-signals.js";
import type { SupervisorExecutionStrategy, SupervisorAssignment } from "../../agents/orchestrator-supervisor-routing.js";
import {
  resolveConsensusReviewAssignment as resolveConsensusReviewAssignmentHelper,
  stripInternalDecisionMarkers as stripInternalDecisionMarkersHelper,
} from "../../agents/orchestrator-supervisor-routing.js";
import { buildPhaseOutcomeTelemetry as buildPhaseOutcomeTelemetryModel } from "../../agents/orchestrator-phase-telemetry.js";
import type { InterventionDeps } from "../../agents/orchestrator-intervention-pipeline.js";
import type { ConsensusManager } from "../routing/consensus-manager.js";
import type { ConfidenceEstimator } from "../routing/confidence-estimator.js";
import type { ClarificationContext } from "../../agents/orchestrator-clarification.js";
import type { TaskManager } from "../../tasks/task-manager.js";
import { userExplicitlyAskedForPlan, draftLooksLikeInternalPlanArtifact } from "../../agents/autonomy/index.js";
import { applyVisibleResponseContract } from "../../agents/orchestrator-text-utils.js";
import {
  handleInteractiveEndTurn,
  handleBgEndTurn,
  type BgEndTurnContext,
  type InteractiveEndTurnContext,
  type EndTurnLoopAction,
} from "../../agents/orchestrator-end-turn-handler.js";
import {
  handleInteractiveReflectionDone,
  handleInteractiveReflectionReplan,
  handleInteractiveReflectionContinue,
  handleBgReflectionDone,
  handleBgReflectionReplan,
  handleBgReflectionContinue,
  type InteractiveReflectionContext,
  type ReflectionCoreContext,
  type BgReflectionContext,
  type ReflectionLoopAction,
} from "../../agents/orchestrator-reflection-handler.js";
import { runConsensusVerification } from "../../agents/orchestrator-consensus.js";
import { parseGoalBlock, buildGoalTreeFromBlock } from "../../goals/types.js";
import { processReflectionPreamble, handlePlanPhaseTransition } from "../../agents/orchestrator-loop-utils.js";
import { recordExecutionTrace, recordPhaseOutcome } from "./accounting.js";
import { emitVisibleBoundary } from "./render.js";
import type { RenderDeps } from "./render.js";
import type { ReviewDeps } from "./review.js";
import type { EngineRunContext } from "./engine-deps.js";
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

/** The dependency slice the reflection/end-turn dispatch reads (grows only with this module). */
export interface ReflectionDeps extends ReviewDeps, RenderDeps {
  readonly progressAssessmentEnabled: boolean;
  /** LAZY GETTER — set after construction. Reads the submit entry the goal-handoff needs. */
  readonly taskManager: () => TaskManager | null;
  readonly dmPolicy?: {
    isAutonomousActive: (chatId: string, userId?: string) => boolean;
  };
  readonly interactionPolicy: {
    requirePlanReview: (chatId: string, reason: string, planText: string) => void;
  };
  readonly consensusManager?: ConsensusManager;
  readonly confidenceEstimator?: ConfidenceEstimator;
  // Callbacks that stay in the shell (they wire tool-turn[Step8] / shell synthesis / goal side-effects).
  readonly buildInterventionDeps: (getSystemPrompt?: () => string) => InterventionDeps;
  readonly buildStructuredProgressSignal: (
    prompt: string,
    title: string,
    signal: Omit<TaskProgressSignal, "userSummary"> & { userSummary?: string },
    language?: ProgressLanguage,
  ) => TaskProgressSignal;
  readonly getClarificationContext: () => ClarificationContext;
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
  readonly runProactiveGoalDecomposition: (opts: {
    conversationScope: string;
    userMessage: string;
    chatId: string;
    session: Session;
    agentState: AgentState;
  }) => Promise<AgentState>;
  readonly runReactiveGoalDecomposition: (opts: {
    conversationScope: string;
    chatId: string;
    session: Session;
    responseText: string;
  }) => Promise<void>;
}

export function buildReflectionCoreContext(
  deps: ReflectionDeps,
  runCtx: EngineRunContext,
  responseText: string | undefined,
  responseUsage: ProviderResponse["usage"] | undefined,
  toolCallCount: number,
): ReflectionCoreContext {
  return {
    chatId: runCtx.chatId,
    identityKey: runCtx.identityKey,
    prompt: deps.sessionManager.extractLastUserMessage(runCtx.session),
    responseText,
    // v1 threads response.usage; the v2 spine does not carry per-step usage into the dispatch
    // ctx, so a zero usage is the faithful default (telemetry treats it as optional).
    responseUsage: responseUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolCallCount,
    executionStrategy: runCtx.executionStrategy as SupervisorExecutionStrategy,
    executionJournal: runCtx.executionJournal,
    selfVerification: runCtx.selfVerification,
    stradaConformance: runCtx.stradaConformance,
    taskStartedAtMs: runCtx.taskStartedAtMs,
    currentToolNames: runCtx.lastToolNames,
    currentAssignment: runCtx.lastAssignment as SupervisorAssignment,
    interventionDeps: deps.buildInterventionDeps(() => runCtx.systemPrompt),
    session: runCtx.session,
    recordPhaseOutcome: (p) => recordPhaseOutcome(deps, p),
    buildPhaseOutcomeTelemetry: (p) => buildPhaseOutcomeTelemetryModel(p),
    usageHandler: runCtx.onUsage,
  };
}

/**
 * Compose the background-only ReflectionContext fields (orchestrator.ts ~3943-3978) from existing
 * this.* methods + runCtx. Every field is an EXISTING method or a runCtx value.
 */
export function buildBgReflectionContext(
  deps: ReflectionDeps,
  core: ReflectionCoreContext,
  runCtx: EngineRunContext,
  iteration: number,
): BgReflectionContext {
  return {
    ...core,
    progressAssessmentEnabled: deps.progressAssessmentEnabled,
    controlLoopTracker: runCtx.controlLoopTracker as BgReflectionContext["controlLoopTracker"],
    workerCollector: runCtx.workerCollector,
    progressTitle: runCtx.progressTitle,
    progressLanguage: runCtx.progressLanguage,
    iteration,
    workspaceLease: undefined,
    systemPrompt: runCtx.systemPrompt,
    emitProgress: runCtx.emitProgress,
    buildStructuredProgressSignal: (p, t, s, l) => deps.buildStructuredProgressSignal(p, t, s, l),
    getClarificationContext: () => deps.getClarificationContext(),
    formatBoundaryVisibleText: (b) => deps.sessionManager.formatBoundaryVisibleText(b),
    appendVisibleAssistantMessage: (s, t) => deps.sessionManager.appendVisibleAssistantMessage(s, t),
    synthesizeUserFacingResponse: (p) => deps.synthesizeUserFacingResponse(p),
    persistSessionToMemory: (c, t, f) => deps.sessionManager.persistSessionToMemory(c, t, f),
    getVisibleTranscript: (s) => deps.sessionManager.getVisibleTranscript(s),
  };
}

export function buildBgEndTurnContext(
  deps: ReflectionDeps,
  core: ReflectionCoreContext,
  runCtx: EngineRunContext,
  iteration: number,
): BgEndTurnContext {
  return {
    chatId: core.chatId,
    identityKey: core.identityKey,
    prompt: core.prompt,
    taskClassification: deps.taskClassifier.classify(core.prompt),
    responseText: core.responseText,
    responseUsage: core.responseUsage,
    executionStrategy: core.executionStrategy,
    executionJournal: core.executionJournal,
    selfVerification: core.selfVerification,
    stradaConformance: core.stradaConformance,
    taskStartedAtMs: core.taskStartedAtMs,
    currentToolNames: core.currentToolNames,
    currentAssignment: core.currentAssignment,
    interventionDeps: core.interventionDeps,
    session: core.session,
    usageHandler: core.usageHandler,
    recordPhaseOutcome: core.recordPhaseOutcome,
    buildPhaseOutcomeTelemetry: core.buildPhaseOutcomeTelemetry,
    progressAssessmentEnabled: deps.progressAssessmentEnabled,
    controlLoopTracker: runCtx.controlLoopTracker as BgEndTurnContext["controlLoopTracker"],
    workerCollector: runCtx.workerCollector,
    progressTitle: runCtx.progressTitle,
    progressLanguage: runCtx.progressLanguage,
    iteration,
    workspaceLease: undefined,
    systemPrompt: runCtx.systemPrompt,
    daemonMode: true,
    emitProgress: runCtx.emitProgress,
    buildStructuredProgressSignal: (p, t, s, l) => deps.buildStructuredProgressSignal(p, t, s, l),
    getClarificationContext: () => deps.getClarificationContext(),
    formatBoundaryVisibleText: (b) => deps.sessionManager.formatBoundaryVisibleText(b),
    appendVisibleAssistantMessage: (s, t) => deps.sessionManager.appendVisibleAssistantMessage(s, t),
    synthesizeUserFacingResponse: (p) => deps.synthesizeUserFacingResponse(p),
    persistSessionToMemory: (c, t, f) => deps.sessionManager.persistSessionToMemory(c, t as ConversationMessage[], f),
    getVisibleTranscript: (s) => deps.sessionManager.getVisibleTranscript(s),
  };
}

export function buildInteractiveEndTurnContext(
  deps: ReflectionDeps,
  core: ReflectionCoreContext,
  runCtx: EngineRunContext,
): InteractiveEndTurnContext {
  const identityKey = runCtx.identityKey;
  const providerCaps = runCtx.lastProviderCapabilities;
  const executionStrategy = core.executionStrategy;
  const currentAssignment = core.currentAssignment;
  return {
    ...core,
    systemPrompt: runCtx.systemPrompt,
    defaultLanguage: deps.defaultLanguage,
    profileLanguage: runCtx.profileLanguage,
    progressAssessmentEnabled: deps.progressAssessmentEnabled,
    controlLoopTracker: runCtx.controlLoopTracker,
    runTextConsensusIfCritical: async (p) => {
      if (!deps.consensusManager || !deps.confidenceEstimator) return;
      const textTaskClass = deps.taskClassifier.classify(p.prompt);
      if (textTaskClass.criticality !== "critical") return;
      const textConfidence = deps.confidenceEstimator.estimate({
        task: textTaskClass,
        providerName: p.providerName,
        providerCapabilities: providerCaps ?? ({} as never),
        agentState: p.agentState,
        responseLength: p.responseText.length,
      });
      await runConsensusVerification({
        consensusManager: deps.consensusManager,
        availableProviderCount: deps.providerManager.listAvailable().length,
        taskClass: textTaskClass,
        confidence: textConfidence,
        originalOutput: { text: p.responseText },
        originalProviderName: p.providerName,
        prompt: p.prompt,
        reviewAssignment: resolveConsensusReviewAssignmentHelper(deps.getSupervisorRoutingContext(), executionStrategy.reviewer, currentAssignment, identityKey),
        chatId: core.chatId,
        identityKey,
        logLabel: "text-only, critical",
        recordExecutionTrace: (rp) => recordExecutionTrace(deps, rp as Parameters<typeof recordExecutionTrace>[1]),
        recordPhaseOutcome: (rp) => recordPhaseOutcome(deps, rp as Parameters<typeof recordPhaseOutcome>[1]),
      });
    },
  };
}

/**
 * Parse the model's reflection preamble into {decision, wasOverride} — v1's
 * processReflectionPreamble verbatim (orchestrator.ts ~4001 / ~5432). The spine calls this at a
 * REFLECTING boundary, then threads `decision` into portDispatchReflection so the model's own
 * DONE/REPLAN/CONTINUE drives the boundary. Records the reflection into the journal + learning
 * metrics exactly as v1 (the side effects live inside processReflectionPreamble).
 */
export async function portParseReflectionDecision(
  params: ParseReflectionDecisionParams,
  runCtx: EngineRunContext,
): Promise<ParsedReflectionDecision> {
  const { decision, wasOverride } = await processReflectionPreamble({
    agentState: params.agentState,
    executionJournal: runCtx.executionJournal,
    responseText: params.responseText,
    providerName: params.providerName,
    modelId: params.modelId,
    // v1 parity: the background/delegated loop tags override warnings "(bg)"; interactive none.
    logLabel: runCtx.toolExecMode === "interactive" ? undefined : "bg",
  });
  return { decision, wasOverride };
}

/**
 * COMPOSE the 4 reflection handlers on (mode, decision) and ADAPT the action-union to the flat
 * {@link ReflectionDispatchResult}. Faithful to the interactive call-site (orchestrator.ts
 * ~5380-5491) and the background call-site (~3943-4019).
 */
export async function portDispatchReflection(
  deps: ReflectionDeps,
  params: DispatchReflectionParams,
  runCtx: EngineRunContext,
): Promise<ReflectionDispatchResult> {
  const chatId = params.chatId;
  // step5-parity (trio catch): v1's checkPendingBlocks ran the self-managed write-rejection check
  // at BOTH the end-turn AND the REFLECTING boundary (v1 @ a3de7d1 :5936/:6204 + :4379/:4550). A
  // write rejected during EXECUTING can advance to REFLECTING and terminate on a low-signal DONE
  // here — surface WHY execution stopped, exactly as in portDispatchEndTurn.
  const writeRejectionText = deps.sessionManager.getPendingSelfManagedWriteRejectionVisibleText(
    runCtx.session,
    params.responseText,
  );
  if (writeRejectionText) {
    await emitVisibleBoundary(deps, chatId, runCtx.session, writeRejectionText);
    return { agentState: params.agentState, terminal: true, reason: "self-managed-write-rejected" };
  }
  const core = buildReflectionCoreContext(deps, runCtx, params.responseText, undefined, 0);
  let action: ReflectionLoopAction;

  if (params.mode === "interactive") {
    const ctx: InteractiveReflectionContext = {
      ...core,
      systemPrompt: runCtx.systemPrompt,
      progressAssessmentEnabled: deps.progressAssessmentEnabled,
      controlLoopTracker: runCtx.controlLoopTracker,
    };
    if (params.decision === "DONE" || params.decision === "DONE_WITH_SUGGESTIONS") {
      action = await handleInteractiveReflectionDone(params.agentState, ctx);
    } else if (params.decision === "REPLAN") {
      action = handleInteractiveReflectionReplan(params.agentState, ctx);
      // FAITHFUL: bundle v1's interactive REPLAN-continue special-case (orchestrator.ts
      // ~5409-5436): reactive goal-decomposition + transitionPhase(REPLANNING) + continuation.
      if (action.flow === "continue") {
        await deps.runReactiveGoalDecomposition({
          conversationScope: chatId,
          chatId,
          session: runCtx.session,
          responseText: params.responseText ?? "",
        });
        let replanState = transitionPhase(action.newState, AgentPhase.REPLANNING);
        if (params.responseText) {
          runCtx.session.messages.push({ role: "assistant", content: params.responseText });
        }
        runCtx.session.messages.push({ role: "user", content: "Please create a new plan." });
        return { agentState: replanState, terminal: false, extendRequested: true };
      }
    } else {
      action = await handleInteractiveReflectionContinue(params.agentState, ctx, {
        text: params.responseText,
        toolCalls: [],
        stopReason: "end_turn",
        usage: undefined,
      } as unknown as ProviderResponse);
    }
  } else {
    const ctx = buildBgReflectionContext(deps, core, runCtx, params.agentState.iteration);
    action =
      params.decision === "DONE" || params.decision === "DONE_WITH_SUGGESTIONS"
        ? await handleBgReflectionDone(params.agentState, ctx)
        : params.decision === "REPLAN"
          ? handleBgReflectionReplan(params.agentState, ctx)
          : await handleBgReflectionContinue(params.agentState, ctx, 0);
  }

  // ADAPT union → DTO (faithful to the pre-Step5 interactive call-site, v1 @ a3de7d1 ~5447-5491).
  switch (action.flow) {
    case "continue":
      // step5-parity: a "continue" out of a DONE dispatch = the verifier/loop-recovery
      // intervention extended the run — the spine must honor it over the parse-time verdict.
      return { agentState: action.newState, terminal: false, extendRequested: true };
    case "done": {
      await emitVisibleBoundary(deps, chatId, runCtx.session, action.visibleText);
      return { agentState: action.newState, terminal: true, reason: action.status ?? "done" };
    }
    case "blocked": {
      const safe = await emitVisibleBoundary(deps, chatId, runCtx.session, action.visibleText);
      return {
        agentState: safe.marked
          ? { ...params.agentState, loopDetectionBlocked: true }
          : params.agentState,
        terminal: true,
        reason: action.status ?? "blocked",
      };
    }
  }
}

export async function portDispatchEndTurn(
  deps: ReflectionDeps,
  params: DispatchEndTurnParams,
  runCtx: EngineRunContext,
): Promise<EndTurnDispatchResult> {
  const chatId = params.chatId;
  // step5-parity: v1 checked pending blocks at the end-turn boundary (deleted checkPendingBlocks).
  // The plan-review half is surfaced on v2 during the plan phase, but the self-managed
  // write-REJECTION half had no v2 home: when the model ends the turn with only a low-signal ack
  // after a write was blocked by autonomous safety review, surface WHY execution stopped instead
  // of terminating on the empty ack. Terminal (v1 recorded COMPLETE + returned the block text).
  const writeRejectionText = deps.sessionManager.getPendingSelfManagedWriteRejectionVisibleText(
    runCtx.session,
    params.responseText,
  );
  if (writeRejectionText) {
    const safe = await emitVisibleBoundary(deps, chatId, runCtx.session, writeRejectionText);
    return { agentState: params.agentState, finalText: safe.text };
  }
  const core = buildReflectionCoreContext(deps, runCtx, params.responseText, undefined, 0);
  const action: EndTurnLoopAction =
    params.mode === "interactive"
      ? await handleInteractiveEndTurn(
          params.agentState,
          buildInteractiveEndTurnContext(deps, core, runCtx),
        )
      : await handleBgEndTurn(
          params.agentState,
          buildBgEndTurnContext(deps, core, runCtx, params.agentState.iteration),
        );

  switch (action.flow) {
    case "done": {
      const safe = await emitVisibleBoundary(deps, chatId, runCtx.session, action.visibleText);
      return { agentState: action.newState, finalText: safe.text };
    }
    case "blocked": {
      const safe = await emitVisibleBoundary(deps, chatId, runCtx.session, action.visibleText);
      return {
        agentState: safe.marked
          ? { ...params.agentState, loopDetectionBlocked: true }
          : params.agentState,
        finalText: safe.text,
      };
    }
    case "continue":
      // step5-parity (the former "one end-turn fidelity gap", now CLOSED): the handler
      // (verifier partial-closure / loop-recovery) converted a genuine end_turn into a
      // continuation and already re-pushed the gate onto the session — signal the spine to
      // keep iterating instead of terminating with an empty finalText.
      return { agentState: action.newState, finalText: "", continueRun: true };
  }
}

export async function portHandlePlanPhase(
  deps: ReflectionDeps,
  params: PlanPhaseParams,
  runCtx: EngineRunContext,
): Promise<PlanPhaseResult> {
  const chatId = params.chatId;
  const phase = params.agentState.phase;

  // Interactive PLANNING-phase terminal divergences (cutover Step 3). Background/worker/supervisor
  // runs fall straight to the default auto-transition below (v1 ran these only in the interactive loop).
  if (
    params.mode === "interactive" &&
    (phase === AgentPhase.PLANNING || phase === AgentPhase.REPLANNING)
  ) {
    const lastUserMessage = deps.sessionManager.extractLastUserMessage(runCtx.session);

    // ── 3.6: goal-block → background submit (v1 orchestrator.ts:5754-5796). FIRST, matching v1
    // precedence (a goal-block short-circuits to background before the plan-review / end-turn logic).
    // Returns a TERMINATING yield so the spine ends the interactive run BEFORE decomposeGoalsIfPlanning
    // — the handed-off goal must NOT also execute inline (no double-run).
    const taskManager = deps.taskManager();
    if (phase === AgentPhase.PLANNING && taskManager) {
      const goalBlock = parseGoalBlock(params.responseText ?? "");
      if (goalBlock && goalBlock.isGoal) {
        const lastUserContent = deps.sessionManager.extractLastUserContent(runCtx.session);
        const lastUserHasRichInput =
          (runCtx.attachments?.length ?? 0) > 0 ||
          (Array.isArray(lastUserContent) && lastUserContent.some((b) => b.type !== "text"));
        const conversationScope = runCtx.conversationScope ?? chatId;
        const goalTree = lastUserHasRichInput
          ? undefined
          : buildGoalTreeFromBlock(goalBlock, conversationScope, lastUserMessage, params.responseText ?? undefined);
        const nodeCount = goalTree ? goalTree.nodes.size - 1 : goalBlock.nodes.length;
        const ackMsg =
          `Working on: ${lastUserMessage.slice(0, 80)}` +
          ` (${nodeCount} step${nodeCount !== 1 ? "s" : ""}, ~${goalBlock.estimatedMinutes} min). I'll update you as I go.`;
        taskManager.submit(chatId, runCtx.channelType ?? "cli", lastUserMessage, {
          ...(goalTree ? { goalTree } : {}),
          ...(lastUserHasRichInput ? { forceSharedPlanning: true } : {}),
          ...(lastUserContent ? { userContent: lastUserContent } : {}),
          attachments: runCtx.attachments?.length ? [...runCtx.attachments] : undefined,
          conversationId: conversationScope,
          userId: runCtx.identityKey,
        });
        return { agentState: params.agentState, yield: { kind: "goal_handoff", visibleText: ackMsg } };
      }
    }

    // ── 3.5: explicit plan-review gate (v1 orchestrator.ts:5799-5857). NON-autonomous only —
    // autonomous mode auto-executes via the default auto-transition below. Records the plan WITHOUT
    // transitioning, parks the write-blocking review gate, and returns a TERMINATING yield that
    // presents the plan; the user approves on the next message (cleared upstream by
    // interactionPolicy.noteUserMessage in processMessage, so this gate won't re-trigger).
    if (
      params.toolCallCount === 0 && // v1 parity (orchestrator.ts:5812): text-only PLANNING responses only
      userExplicitlyAskedForPlan(lastUserMessage) &&
      draftLooksLikeInternalPlanArtifact(params.responseText ?? "", { toolNames: runCtx.lastToolNames }) &&
      !deps.dmPolicy?.isAutonomousActive(chatId, runCtx.userId)
    ) {
      let agentState = handlePlanPhaseTransition({
        agentState: params.agentState,
        executionJournal: runCtx.executionJournal,
        responseText: params.responseText,
        providerName: params.providerName,
        modelId: params.modelId,
        autoTransition: false,
      });
      if (agentState.phase === AgentPhase.PLANNING) {
        agentState = await deps.runProactiveGoalDecomposition({
          conversationScope: runCtx.conversationScope ?? chatId,
          userMessage: lastUserMessage,
          chatId,
          session: runCtx.session,
          agentState,
        });
      }
      deps.interactionPolicy.requirePlanReview(
        chatId,
        "user explicitly asked to review a plan first",
        applyVisibleResponseContract(
          lastUserMessage,
          stripInternalDecisionMarkersHelper(params.responseText) || params.responseText || "",
        ),
      );
      const planText = deps.sessionManager.getPendingPlanReviewVisibleText(chatId) ?? "";
      return { agentState, yield: { kind: "plan_review", visibleText: planText } };
    }
  }

  // ── default: auto-transition (existing behavior — autonomous auto-execute + the non-divergent path).
  const agentState = handlePlanPhaseTransition({
    agentState: params.agentState,
    executionJournal: runCtx.executionJournal,
    responseText: params.responseText,
    providerName: params.providerName,
    modelId: params.modelId,
    autoTransition: true,
  });
  return { agentState };
}
