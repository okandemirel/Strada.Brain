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

import { getLogger } from "../../utils/logger.js";
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
import { instinctScopeKey } from "./instinct-scope.js";

/** v1 parity: the PAOR reflection cadence on the agent-core route (orchestrator const copy). */
const REFLECT_INTERVAL_AGENT_CORE = 3;

/**
 * BUG#1 P2 — SUPPRESSION GUARD (engine half). `true` iff this run has NO parent/supervisor board it
 * would double-drive. This is the FIRST of a TWO-STAGE guard: the engine excludes supervisor sub-node
 * workers + parent-episode rollup workers here, and MonitorLifecycle.stepBatch applies the SECOND,
 * authoritative stage — it no-ops when the episode board was already re-rooted as a decomposed goal
 * tree (goalDecomposed/goalRestructured). See stepBatch for why the decomposition check MUST live in
 * MonitorLifecycle, not here.
 *
 * What each clause excludes — and, IMPORTANTLY, what it does NOT:
 *   - `!goalContext`      — excludes supervisor sub-node workers that carry goalContext {rootId,nodeId}
 *                           (bootstrap.ts createSupervisorExecuteNodeBridge stamps it) AND every
 *                           delegated child linked to a supervisor tree. It is NOT a complete supervisor
 *                           fence: in the FRESH-decompose path SupervisorBrain.execute decomposes into a
 *                           LOCAL tree but never writes it back into dispatchContext.goalTree
 *                           (supervisor-brain.ts:364), so the bridge stamps NO goalContext → such a
 *                           worker CAN pass this clause. That is fine — those workers present a parent
 *                           monitorScope (joinsParentEpisode below) and/or run on a board the supervisor
 *                           already flipped to a goal tree; the AUTHORITATIVE suppression is the dagKind
 *                           check in MonitorLifecycle.stepBatch, not this engine gate. (The supervisor
 *                           ROOT never reaches portExecuteToolTurn — it returns early in the bg-executor.)
 *   - `!joinsParentEpisode` — excludes a re-scoped worker that joined a PARENT episode (goalDecomposed/
 *                           supervisor owned); it must not seed a step DAG onto a board it does not own.
 *                           This catches the fresh-decompose supervisor worker above (it carries the
 *                           parent monitorScope), plus any future non-supervisor rollup.
 *
 * So this engine gate is a FIRST-STAGE filter, deliberately not a complete supervisor/decomposition
 * fence. The DECOMPOSITION check is deliberately NOT here (it was `goalsDecomposed === false`, a BUG
 * that made this feature DEAD): the spine flips runCtx.goalsDecomposed true UNCONDITIONALLY on the
 * first PLANNING turn (port.ts decomposeGoalsIfPlanning sets it BEFORE deciding whether anything
 * actually decomposes), and PLANNING runs BEFORE the first EXECUTING tool turn — so goalsDecomposed is
 * already true on EVERY run by the time portExecuteToolTurn fires, plain or decomposed. Whether the
 * board is ACTUALLY a goal tree is authoritatively known only by MonitorLifecycle (it alone received
 * goalDecomposed for a REAL tree — runProactiveGoalDecomposition returns early without touching the
 * monitor when goalDecomposer.shouldDecompose is false), so that check lives in stepBatch (dagKind).
 */
/**
 * What the shell reviewer should be told the task is.
 *
 * A worker's session holds no user turn — it was handed a task, not a
 * conversation — so the user-message lookup returns "" and the reviewer was
 * given "Task: (not provided)". Measured: it then refused commands with "Task
 * not provided; cannot verify alignment with the stated task", a reviewer
 * failing for want of its one required input rather than because anything was
 * wrong, at the cost of a turn each time.
 */
export function reviewTaskPrompt(
  lastUserMessage: string | undefined,
  taskDescription: string | undefined,
): string {
  return lastUserMessage || taskDescription || "";
}

export function isPlainLoop(runCtx: EngineRunContext): boolean {
  return runCtx.goalContext === undefined && runCtx.joinsParentEpisode === false;
}

/** Human-readable label for a plain-loop batch node: the batch's tool names (deduped, capped). */
export function summarizePlainLoopBatch(toolCalls: readonly ToolCall[]): string {
  const names = [...new Set(toolCalls.map((tc) => tc.name).filter(Boolean))];
  if (names.length === 0) return "Working…";
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
}

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
  /**
   * BUG#1 P2 — emit ONE live plain-loop step-DAG node for a tool batch. The shell wires this to
   * MonitorLifecycle.stepBatch (under the active episode root); a cycle-safe callback because the
   * engine must not import workspaceBus / MonitorLifecycle directly (the tool-turn import rule).
   * The engine calls it ONLY when its suppression guard admits a plain loop (no supervisor, no
   * goal-tree/decomposition), so it can never collide with the supervisor node-id stream.
   */
  emitPlainLoopStep(params: {
    conversationScope: string;
    monitorScope?: string;
    batchIndex: number;
    toolLabel: string;
  }): void;
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
        // A worker's session holds no user turn — it was given a task, not a
        // conversation — so extractLastUserMessage returns "" and the shell
        // reviewer was handed "Task: (not provided)". Measured: it then refused
        // commands with "Task not provided; cannot verify alignment with the
        // stated task", which is a reviewer failing for lack of the one input
        // it needs rather than because anything was wrong. The task description
        // is right there in agent state, and is already used for drift
        // detection twenty lines below.
        taskPrompt: reviewTaskPrompt(lastUserMessage, agentState.taskDescription),
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
      for (const tc of toolCalls) {
        // Fingerprint the call, not just the tool: reading forty different
        // files is progress, reading one file forty times is not.
        runCtx.controlLoopTracker.markToolExecution(
          tc.name,
          `${tc.name}:${JSON.stringify(tc.input ?? {}).slice(0, 300)}`,
        );
      }
      // The tracker's own read-only-stall check sits inside recordGate(), which
      // runs only once something else raises a gate. A run that does nothing
      // but read raises nothing, so the stall went unseen for 108 calls against
      // a threshold of 8. Ask here, where every tool turn passes.
      const stall = runCtx.controlLoopTracker.takeUnreportedReadOnlyStall();
      if (stall) {
        getLogger().warn("Read-only stall", {
          chatId: runCtx.chatId,
          calls: stall.calls,
          reason: stall.reason,
        });
      }
    }

    // STEP D — consensus (non-fatal; gated on the managers existing).
    if (deps.consensusManager && deps.confidenceEstimator && deps.providerRouter) {
      const consensusVerdict = await runConsensusIfAvailable({
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
        return undefined;
      });
      // ACTIONABLE disagreement: the tools already ran (this hook is post-
      // execution), so the lever is the NEXT iteration — put the reviewer's
      // objection in front of the model as a message it must address, instead
      // of a warn-log nobody reads (audited 2026-08-30: advisory-only).
      if (consensusVerdict && !consensusVerdict.agreed) {
        (session as { messages: ConversationMessage[] }).messages.push({
          role: "user",
          content:
            "[CONSENSUS REVIEWER OBJECTION] A second model reviewed the last critical step and disagreed: " +
            `${(consensusVerdict.reasoning ?? "no reasoning returned").slice(0, 600)}\n` +
            "Address this objection explicitly before proceeding: re-verify the result, and correct course if the objection holds.",
        });
      }
    }

    // STEP E — record step results + PAOR transition (the REAL transition; returns new state).
    const step = recordStepResultsAndCheckReflection({
      agentState,
      toolCalls,
      toolResults,
      reflectInterval: REFLECT_INTERVAL_AGENT_CORE,
    });

    // STEP E.5 — BUG#1 P2: live plain-loop step DAG. Model each tool batch as a node so the plain
    // interactive/background loop drives per-node monitor status (executing→completed) instead of
    // one static "executing" card for the whole run. NON-FATAL: a monitor emit must never fail the
    // tool turn. TWO-STAGE suppression: isPlainLoop here excludes supervisor sub-node + parent-rollup
    // workers (they carry goalContext / joinsParentEpisode); MonitorLifecycle.stepBatch then applies
    // the AUTHORITATIVE decomposition guard (no-op when the board is a real goal tree). Both are needed
    // — the decomposition state is NOT reliably on runCtx at tool-turn time (goalsDecomposed flips true
    // in PLANNING for every run), only MonitorLifecycle knows the board was actually re-rooted a tree.
    if (isPlainLoop(runCtx) && runCtx.conversationScope) {
      const batchIndex = runCtx.plainLoopStepIndex;
      runCtx.plainLoopStepIndex = batchIndex + 1; // SINGLE source: `step-<batchIndex>` for BOTH events.
      try {
        deps.emitPlainLoopStep({
          conversationScope: runCtx.conversationScope,
          monitorScope: runCtx.workerMonitorScope,
          batchIndex,
          toolLabel: summarizePlainLoopBatch(toolCalls),
        });
      } catch {
        /* non-fatal — monitor is best-effort */
      }
    }

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
              // audited 2026-09-02: same run scope the prologue stashed under.
              const key = instinctScopeKey(chatId, deps.getTaskExecutionContext()?.taskRunId);
              const current = deps.currentSessionInstinctIds.get(key) ?? [];
              const merged = [...new Set([...current, ...ids])].slice(0, 200);
              deps.currentSessionInstinctIds.set(key, merged);
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
        // The tool's own words. Without this the projection stamped
        // summary:"" on every trace entry and deriveTestVerdict — the
        // mechanical red/green gate — read empty evidence on EVERY run
        // (audited 2026-09-02: tasks.verification_json was never written).
        resultText: typeof tr?.content === "string" ? tr.content.slice(0, 4000) : "",
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
