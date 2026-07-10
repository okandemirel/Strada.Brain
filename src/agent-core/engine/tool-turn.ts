/**
 * Agent Core v2 — engine tool turn (relocation Step 8; blueprint: project_v2_engine_relocation).
 *
 * portExecuteToolTurn is the port's bound FULL TOOL TURN: it decodes the spine's positional args,
 * runs the tool batch (executeAndTrackTools), marks the control-loop tracker, runs consensus,
 * records step results + the PAOR REFLECTING transition, pushes the tool-result content blocks,
 * refreshes memory mid-run, and builds the per-batch progress signal. Moved VERBATIM from
 * orchestrator.ts. The RCE-sensitive tool-execution PRIMITIVES (executeToolCalls / emitToolResult)
 * and the batch-progress classifier stay in the shell and are injected as callbacks — this module
 * ORCHESTRATES a turn; it does not re-home the write gate.
 *
 * Import rule (cycle safety): orchestrator-FREE leaves only — see engine-deps.js.
 */

import type { AgentState } from "../../agents/agent-state.js";
import { createInitialState } from "../../agents/agent-state.js";
import type { ToolCall, ToolResult, ConversationMessage } from "../../agents/providers/provider.interface.js";
import type {
  SupervisorAssignment,
  SupervisorExecutionStrategy,
} from "../../agents/orchestrator-supervisor-routing.js";
import { resolveConsensusReviewAssignment as resolveConsensusReviewAssignmentHelper } from "../../agents/orchestrator-supervisor-routing.js";
import type { TaskProgressSignal } from "../../tasks/types.js";
import type { ProgressLanguage } from "../../tasks/progress-signals.js";
import type { ToolExecutionOptions } from "../../agents/orchestrator-intervention-pipeline.js";
import {
  executeAndTrackTools,
  runConsensusIfAvailable,
  refreshMemoryIfNeeded,
} from "../../agents/orchestrator-loop-shared.js";
import {
  recordStepResultsAndCheckReflection,
  buildToolResultContentBlocks,
} from "../../agents/orchestrator-loop-utils.js";
import { recordExecutionTrace, recordPhaseOutcome } from "./accounting.js";
import type { EngineRunContext } from "./engine-deps.js";
import type { SetupDeps } from "./setup.js";

/** v1 parity: the PAOR reflection cadence on the agent-core route (orchestrator const copy). */
const REFLECT_INTERVAL_AGENT_CORE = 3;

/** What the port's bound tool turn returns: the trace rows + the PAOR-advanced state. */
export interface AgentCoreToolTurnResult {
  readonly trace: ReadonlyArray<{
    toolName: string;
    toolCallId: string;
    success: boolean;
    errorCategory?: string;
    touchedFiles?: readonly string[];
  }>;
  readonly advancedState: AgentState;
  readonly progressSignal?: TaskProgressSignal;
}

/**
 * The dependency slice the tool turn reads. Extends {@link SetupDeps} so the already-injected
 * services (sessionManager, consensusManager, confidenceEstimator, providerRouter, providerManager,
 * taskClassifier, currentSessionInstinctIds, propagateInstinctIdsToChannel, getSupervisorRoutingContext,
 * + the accounting fns) are inherited; adds only the 3 shell-owned callbacks the turn delegates to.
 */
export interface ToolTurnDeps extends SetupDeps {
  executeToolCalls(
    chatId: string,
    toolCalls: ToolCall[],
    options?: ToolExecutionOptions,
  ): Promise<ToolResult[]>;
  emitToolResult(
    chatId: string,
    tc: { name: string; input: unknown },
    tr: { content: string; isError?: boolean; metadata?: Record<string, unknown> },
  ): void;
  buildToolBatchProgressSignal(params: {
    prompt: string;
    title: string;
    toolCalls: readonly ToolCall[];
    language?: ProgressLanguage;
  }): TaskProgressSignal;
}

export async function portExecuteToolTurn(
    deps: ToolTurnDeps,
    args: unknown[],
    runCtx: EngineRunContext,
  ): Promise<AgentCoreToolTurnResult> {
    const toolCalls = args[0] as ToolCall[];
    const agentState = (args[2] as AgentState | undefined) ?? createInitialState("");
    const chatId = runCtx.chatId;
    const session = runCtx.session;
    const assignment = runCtx.lastAssignment as SupervisorAssignment;
    const strategy = runCtx.executionStrategy as SupervisorExecutionStrategy;
    const lastUserMessage = deps.sessionManager.extractLastUserMessage(session);

    // STEP A — assistant-message push + executeToolCalls (CORRECT arg order) + autonomy tracking.
    // D2 fix: the spine threads the assistant's pre-tool text as the 4th positional arg; v1 pushes
    // response.text onto the session before the tool results (executeAndTrackTools does the push).
    const responseText = (args[3] as string | undefined) ?? "";
    const { toolResults } = await executeAndTrackTools({
      chatId,
      responseText,
      toolCalls,
      session: session as { messages: ConversationMessage[] },
      executeToolCalls: (c, tc, opts) => deps.executeToolCalls(c, tc, opts),
      executeOptions: {
        mode: runCtx.toolExecMode, // #3 fix: was hardcoded "background" (broke the interactive route)
        // v1 parity (flip trio-review catch): the v1 INTERACTIVE loop threads userId (@ :6350)
        // so identity-keyed gates (dm-policy autonomy prefs, `${userId}:${chatId}` keys) resolve
        // the USER's stored prefs, not the chat-scoped fallback — critical on multi-user channels
        // where userId != chatId. The v1 background/worker loop does NOT thread it (@ :4642), so
        // keep byte-parity per route; unconditional threading is its own decision post-deletion.
        userId: runCtx.toolExecMode === "interactive" ? runCtx.userId : undefined,
        taskPrompt: lastUserMessage,
        sessionMessages: session.messages,
        onUsage: runCtx.onUsage,
        identityKey: runCtx.identityKey,
        strategy,
        agentState,
        touchedFiles: [...runCtx.selfVerification.getState().touchedFiles],
        workspaceLease: runCtx.workspaceLease, // #1: scopes tools to the worktree (v1 parity @ :7175)
        goalContext: runCtx.goalContext, // supervisor-tree linkage for delegated child tasks
      },
      trackingParams: {
        taskPlanner: runCtx.taskPlanner,
        selfVerification: runCtx.selfVerification,
        stradaConformance: runCtx.stradaConformance,
        errorRecovery: runCtx.errorRecovery,
        executionJournal: runCtx.executionJournal,
        agentPhase: agentState.phase,
        providerName: assignment.providerName,
        modelId: assignment.modelId,
        emitToolResult: (c, tc, tr) => deps.emitToolResult(c, tc, tr),
        workerCollector: runCtx.workerCollector ?? undefined,
      },
    });

    // STEP B — control-loop tracker mark (per call), as v1 does.
    if (runCtx.controlLoopTracker) {
      for (const tc of toolCalls) runCtx.controlLoopTracker.markToolExecution(tc.name);
    }

    // STEP D — consensus (non-fatal; gated on the managers existing).
    if (deps.consensusManager && deps.confidenceEstimator && deps.providerRouter) {
      await runConsensusIfAvailable({
        consensusManager: deps.consensusManager,
        confidenceEstimator: deps.confidenceEstimator,
        providerManager: deps.providerManager,
        taskClassifier: deps.taskClassifier,
        prompt: lastUserMessage,
        responseText,
        toolCalls,
        currentAssignment: assignment,
        currentProviderCapabilities: runCtx.lastProviderCapabilities ?? ({} as never),
        agentState,
        executionStrategy: strategy,
        identityKey: runCtx.identityKey,
        chatId,
        logLabel: "agent-core",
        resolveConsensusReviewAssignment: (r, c, k) => resolveConsensusReviewAssignmentHelper(deps.getSupervisorRoutingContext(), r, c, k),
        recordExecutionTrace: (p) => recordExecutionTrace(deps, p),
        recordPhaseOutcome: (p) => recordPhaseOutcome(deps, p),
      }).catch(() => {
        /* non-fatal */
      });
    }

    // STEP E — record step results + PAOR transition (the REAL transition; returns new state).
    const step = recordStepResultsAndCheckReflection({
      agentState,
      toolCalls,
      toolResults,
      reflectInterval: REFLECT_INTERVAL_AGENT_CORE,
    });

    // STEP C+F — content blocks pushed AFTER the REFLECTING transition (E first).
    const stateCtx = runCtx.taskPlanner.getStateInjection();
    // Reuse the centralizing helper (single source for the user-facing health string + the guard).
    const providerHealthContext = runCtx.iterationHealth.buildHealthSummary();
    const blocks = buildToolResultContentBlocks(stateCtx, step.agentState, toolResults, {
      providerHealthContext,
    });
    session.messages.push({
      role: "user",
      content: (blocks.length === 1 && stateCtx ? stateCtx : blocks) as unknown as ConversationMessage["content"],
    } as ConversationMessage);

    // STEP G — memory refresh (non-fatal; reassigns systemPrompt + state). step5-parity: the
    // run's MemoryRefresher threads through runCtx so mid-run re-retrieval fires exactly as the
    // v1 loops did (it was passed null — "opt-in" — which silently killed re-retrieval on v2).
    const isInteractiveTurn = runCtx.toolExecMode === "interactive";
    const mem = await refreshMemoryIfNeeded({
      memoryRefresher: runCtx.memoryRefresher,
      iteration: step.agentState.iteration,
      // v1 parity per route (trio catch): interactive re-scans the session (a fresh extract —
      // the tool-result block was pushed above); background/delegated pins the STABLE task
      // prompt (v1 @ a3de7d1 :4756) so drift detection never runs against planner boilerplate.
      queryContext: isInteractiveTurn
        ? deps.sessionManager.extractLastUserMessage(session)
        : agentState.taskDescription || lastUserMessage,
      chatId,
      systemPrompt: runCtx.systemPrompt,
      agentState: step.agentState,
      // v1 interactive parity (trio catch, a3de7d1 :6444-6452): surface refreshed instinct IDs —
      // dedupe+cap into the run's set and propagate to the channel for attribution. v1's
      // background loop passed no callback; keep that asymmetry.
      ...(isInteractiveTurn
        ? {
            onNewInstinctIds: (ids: string[]) => {
              const current = deps.currentSessionInstinctIds.get(chatId) ?? [];
              const merged = [...new Set([...current, ...ids])].slice(0, 200);
              deps.currentSessionInstinctIds.set(chatId, merged);
              deps.propagateInstinctIdsToChannel(chatId, merged);
            },
          }
        : {}),
    });
    runCtx.systemPrompt = mem.systemPrompt;

    const trace = toolCalls.map((tc, i) => {
      const tr = toolResults[i];
      const touched = (tr?.metadata?.touchedFiles as string[] | undefined) ?? undefined;
      return {
        toolName: tc.name,
        toolCallId: tc.id,
        success: !(tr?.isError ?? false),
        errorCategory: tr?.isError ? "tool-error" : undefined,
        touchedFiles: touched,
      };
    });

    // v1 parity (bg loop :4687): the per-tool-batch structured progress signal (kind + toolNames
    // + files, localized). v1 emitProgress'd it inline; the port RETURNS it so the spine emits it
    // as a `narrative` bus event — the background io adapter unwraps it back into the v1
    // TaskProgressUpdate stream. Non-fatal: a classification error must never fail the tool turn.
    let progressSignal: TaskProgressSignal | undefined;
    try {
      progressSignal = deps.buildToolBatchProgressSignal({
        prompt: agentState.taskDescription || lastUserMessage,
        title: runCtx.progressTitle,
        toolCalls,
        language: runCtx.progressLanguage,
      });
    } catch {
      progressSignal = undefined;
    }

    return { trace, advancedState: mem.agentState, progressSignal };
  }
