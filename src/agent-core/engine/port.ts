/**
 * Agent Core v2 — the OrchestratorPort assembly (relocation Step 9, FINAL; blueprint:
 * project_v2_engine_relocation). createAgentCorePort wires the relocated engine methods + the few
 * shell-owned callbacks into the OrchestratorPort object the V2AgentRunner drives, and builds the
 * shared per-run FailureLedger tracker (runHealth/runHealthAdapter — the SAME instance threaded into
 * BOTH createHealthCore and setupRun's runCtx; the v2-background-livelock fix). Moved VERBATIM from
 * orchestrator.ts. The AgentEngine's own facade methods are called directly (engine.X); the shell
 * residue (buildTaskAwareProvider / maybeCompactSession / saveBudgetExceededCheckpoint /
 * withTaskExecutionContext / portOnEpochRollover / recordInRunTrajectoryCredit /
 * mapTerminalReasonToMessageKey / createGateway) is injected via PortDeps.
 *
 * Import rule (cycle safety): AgentEngine is a TYPE-only import (erased) — no runtime cycle with
 * agent-engine.ts, which imports createAgentCorePort as a value.
 */

import type { AgentEngine } from "./agent-engine.js";
import type { ToolTurnDeps } from "./tool-turn.js";
import type { EngineRunContext } from "./engine-deps.js";
import { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import { IterationHealthCoreAdapter } from "../control/iteration-health-core-adapter.js";
import { AgentPhase } from "../../agents/agent-state.js";
import type { AgentState, StepResult } from "../../agents/agent-state.js";
import type { Session } from "../../agents/orchestrator-session-manager.js";
import type { MessageContent } from "../../agents/providers/provider-core.interface.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type { TaskClassification } from "../routing/routing-types.js";
import { resolveIdentityKey } from "../../agents/orchestrator-text-utils.js";
import { randomUUID } from "node:crypto";
import { firstClause } from "../../agents/orchestrator-loop-shared.js";
import { getResilienceMessage, type MessageKey } from "../../agents/resilience-messages.js";
import type { ModelGateway } from "../model/model-gateway.js";
import type { PolicySeed } from "../control/policy.js";
import type { HealthCore } from "../control/failure-ledger.js";
import { isBenign, type CancelReason } from "../control/index.js";
import type { TerminalStatus } from "../runner/index.js";
import type {
  OrchestratorPort,
  AgentRunSetupInput,
  RunSetup as PortRunSetup,
  PrepareIterationParams,
  PreparedIteration as PortPreparedIteration,
  ClassifyFailureParams,
  FailureVerdictContribution,
  DispatchReflectionParams,
  ReflectionDispatchResult,
  DispatchEndTurnParams,
  EndTurnDispatchResult,
  ParseReflectionDecisionParams,
  ParsedReflectionDecision,
  PlanPhaseParams,
  PlanPhaseResult,
  ResultProjectionParams,
  AgentRunResultProjection,
  SynthesizedFinal,
  ExecuteToolCallsFn,
} from "../runner/orchestrator-port.js";

/** The shell residue the port assembly injects (the engine facade methods are called directly). */
export interface PortDeps extends ToolTurnDeps {
  /**
   * audited 2026-09-02: settle the goal tree this run decomposed. Interactive
   * trees were upserted 'executing' at decomposition and never given a terminal
   * status, so pruneOldTrees could never reclaim them and getInterruptedTrees
   * reported finished turns as interrupted work.
   */
  settleGoalTree(conversationScope: string, status: TerminalStatus): void;
  buildTaskAwareProvider(
    primaryName: string,
    task?: TaskClassification,
    phase?: string,
    options?: { modelId?: string; identityKey?: string; usesMultipleProviders?: boolean },
  ): IAIProvider | null;
  maybeCompactSession(session: Session, providerName: string, modelId?: string, systemPrompt?: string): void;
  saveBudgetExceededCheckpoint(params: {
    taskId: string;
    chatId: string;
    lastUserMessage: string;
    used: number;
    budget: number;
  }): Promise<void>;
  saveRollingCheckpoint(params: {
    taskId: string;
    chatId: string;
    userId?: string;
    lastUserMessage: string;
    epoch: number;
    touchedFiles?: readonly string[];
  }): Promise<void>;
  withTaskExecutionContext<T>(
    context: { chatId: string; conversationId?: string; userId?: string; identityKey: string; taskRunId: string },
    run: () => Promise<T>,
  ): Promise<T>;
  portOnEpochRollover(continued: boolean, epoch: number, agentState: AgentState, runCtx: EngineRunContext): void;
  recordInRunTrajectoryCredit(params: {
    chatId: string;
    sessionId: string;
    taskDescription: string;
    success: boolean;
    finalOutput?: string;
    stepResults: readonly StepResult[];
  }): void;
  mapTerminalReasonToMessageKey(reason: string | undefined, status: TerminalStatus | undefined): MessageKey | undefined;
  createGateway(): ModelGateway;
}

/**
 * Extract the text from a visible assistant message. The interactive path always has a plain string,
 * but a worker/background answer can be `MessageContent[]`; in that case join ONLY the `text` blocks
 * (a final answer must not leak serialized tool_use/tool_result/image blocks). Returns "" when there
 * is no genuine text to surface. Moved VERBATIM from orchestrator.ts.
 */
function extractAssistantText(content: string | MessageContent[] | null | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Extract<MessageContent, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function createAgentCorePort(
  engine: AgentEngine,
  deps: PortDeps,
): {
    port: OrchestratorPort;
    gateway: ModelGateway;
    seed: PolicySeed;
    createHealthCore: () => HealthCore;
  } {
    // The closure cell the runCtx-bound methods read lazily. setupRun populates it before the
    // first per-iteration call; the spine never touches it.
    const cell: { ctx: EngineRunContext | undefined } = { ctx: undefined };
    const ctx = (): EngineRunContext => {
      if (!cell.ctx) throw new Error("AgentCorePort: setupRun must run before this method");
      return cell.ctx;
    };

    // BUG FIX (v2 background livelock): the FailureLedger's health core (createHealthCore, consumed by
    // controlPlane.openRun) MUST be the SAME IterationHealthTracker the spine records into via the port
    // (runCtx.iterationHealth/healthAdapter). openRun runs BEFORE setupRun builds runCtx, so the shared
    // per-run instance is created HERE and threaded into BOTH. Without this the ledger read a permanently
    // EMPTY tracker → rule 5 (5-consecutive-failure abort), rule 7 (ask_user), and the stale-failure
    // retry were ALL dead → background runs LIVELOCKED under persistent provider failure instead of
    // aborting (v1 aborted via a task-scoped consecutiveProviderFailures). One run = one port = one tracker.
    const runHealth = new IterationHealthTracker();
    const runHealthAdapter = new IterationHealthCoreAdapter(runHealth, "");

    const portImpl: OrchestratorPort = {
      // ── A. setup / seed ──────────────────────────────────────────────────────────────────
      setupRun: async (request: AgentRunSetupInput): Promise<PortRunSetup> => {
        const built = await engine.setupAgentCoreRun(request, runHealth, runHealthAdapter);
        cell.ctx = built.runCtx;
        return built.setup;
      },
      // Step 0 / gap #1 — wrap the v2 run in v1's task-execution ALS scope (mirrors runBackgroundTask
      // :3214-3225). Resolves the SAME ctx v1 builds {chatId, conversationId, userId, identityKey,
      // taskRunId}; the per-run readers (decomposeGoalsIfPlanning taskRunId, recordEvaluation
      // identityKey) then see it instead of `undefined`. taskRunId mirrors v1's fallback chain.
      withRunTaskContext: <T>(input: AgentRunSetupInput, fn: () => Promise<T>): Promise<T> => {
        const identityKey = resolveIdentityKey(
          input.chatId,
          input.userId,
          input.conversationId,
          deps.userProfileStore,
          input.channelType,
        );
        const taskRunId =
          input.taskRunId?.trim() ||
          deps.getTaskExecutionContext()?.taskRunId ||
          `taskrun_${randomUUID()}`; // v1-parity token (runBackgroundTask :3218 / handleMessage :3059)
        return deps.withTaskExecutionContext(
          {
            chatId: input.chatId,
            conversationId: input.conversationId,
            userId: input.userId,
            identityKey,
            taskRunId,
          },
          fn,
        );
      },
      buildPolicySeed: () => engine.buildPolicySeed(),

      // ── B. per-iteration prep ────────────────────────────────────────────────────────────
      prepareIteration: (params: PrepareIterationParams): PortPreparedIteration => {
        const prepared = engine.prepareIteration({
          prompt: params.prompt,
          identityKey: params.identityKey,
          agentState: params.agentState,
          executionJournal: params.executionJournal,
          // trio HIGH catch: use the LIVE prompt (runCtx.systemPrompt — STEP G's memory refresh
          // reassigns it mid-run), NOT the spine's frozen setup.systemPrompt snapshot; v1's loops
          // consumed the reassigned loop-local the same way. Without this the refreshed
          // "## Relevant Memory"/RAG sections were computed and silently dropped.
          systemPrompt: ctx().systemPrompt,
          fallbackProvider: params.fallbackProvider,
          toolTurnAffinity: params.toolTurnAffinity,
          enableGoalDetection: params.enableGoalDetection,
          iterationHealth: params.iterationHealth,
          // step5-parity: the supervisor provider pin (all roles on the pinned provider+model).
          fixedExecutionStrategy: ctx().fixedExecutionStrategy,
        });
        // ADAPT: capture the last strategy/assignment/toolNames so the handler contexts can read
        // them (they are loop-locals in v1; here the port threads them through runCtx).
        const c = ctx();
        c.executionStrategy = prepared.executionStrategy;
        c.lastAssignment = prepared.currentAssignment;
        c.lastToolNames = prepared.currentToolNames;
        // RAW provider capabilities (v1 parity :4705 — v1 reads capabilities off the unwrapped
        // assignment provider even though the CALL goes through the resilient wrap below).
        c.lastProviderCapabilities = prepared.currentProvider.capabilities;
        // v1 parity (deletion-map risk catch): BOTH v1 loops wrap the assignment provider with
        // buildTaskAwareProvider before the LLM call (:3980 background / :5561 interactive) — a
        // router-ranked multi-provider resilient chain (primary first), honoring a hard pin via
        // usesMultipleProviders=false. The spine consumed prepared.currentProvider RAW, silently
        // dropping the in-call fallback chain on the now-default v2 path. Wrap here so every
        // gateway call gets the identical resilient provider v1 used.
        const resilientProvider =
          deps.buildTaskAwareProvider(
            prepared.currentAssignment.providerName,
            prepared.executionStrategy.task,
            params.agentState.phase,
            {
              modelId: prepared.currentAssignment.modelId,
              identityKey: params.identityKey,
              usesMultipleProviders: prepared.executionStrategy.usesMultipleProviders,
            },
          ) ?? prepared.currentProvider;
        return { ...prepared, currentProvider: resilientProvider } as PortPreparedIteration; // currentToolDefinitions is GatewayToolDefinition[]
      },
      maybeCompactSession: (session, providerName, modelId, systemPrompt) =>
        deps.maybeCompactSession(session as Session, providerName, modelId, systemPrompt),
      trimContextWindow: (session, mode) =>
        engine.trimContextWindowForRun(session as unknown as Session, mode, ctx()),

      // ── C. accounting / trace ──────────────────────────────────────────────────────────────
      recordExecutionTrace: (params) =>
        engine.recordExecutionTrace({
          chatId: params.chatId,
          identityKey: params.identityKey,
          assignment: params.assignment,
          phase: params.phase,
          task: params.task,
          taskRunId: params.taskRunId,
          reason: params.reason,
        }),
      recordProviderUsage: (providerName, usage, modelId) => {
        const c = ctx();
        engine.recordProviderUsage(providerName, usage, c.onUsage, modelId); // CURRY onUsage
        c.cumulativeOutputTokens += usage?.outputTokens ?? 0; // 3.3: feed the interactive budget gate (output-only)
      },
      // audited 2026-09-02: every handler context reads runCtx.lastAssignment for its phase
      // outcomes; stamp the member that served this turn on it so those outcomes are
      // attributed to the server, not the router's pick. lastAssignment is re-set from
      // prepareIteration each step, so a stamp never outlives its turn.
      noteServedBy: (servedBy) => {
        const c = ctx();
        if (c.lastAssignment) c.lastAssignment = { ...c.lastAssignment, servedBy };
      },
      saveBudgetExceededCheckpoint: (params) => deps.saveBudgetExceededCheckpoint(params),
      saveRollingCheckpoint: (params) => deps.saveRollingCheckpoint(params),

      // ── D. the verdict bridge (ADAPT: record into tracker, RETURN INPUT, no verdict) ─────────
      classifyFailureForVerdict: (params: ClassifyFailureParams): FailureVerdictContribution =>
        engine.classifyAgentCoreFailure(params, ctx()),
      recordHealthSuccess: (_provider: string) => {
        // v1 success pair: the ledger half (bgFailureLedger.recordSuccess(provider,"real")) is the
        // spine's concern; the port owns the tracker half (iterationHealth.recordSuccess()).
        ctx().iterationHealth.recordSuccess();
      },

      // ── E. reflection + end-turn (COMPOSE handler + ADAPT union→DTO) ─────────────────────────
      dispatchReflection: (params: DispatchReflectionParams): Promise<ReflectionDispatchResult> =>
        engine.portDispatchReflection(params, ctx()),
      parseReflectionDecision: (
        params: ParseReflectionDecisionParams,
      ): Promise<ParsedReflectionDecision> => engine.portParseReflectionDecision(params, ctx()),
      dispatchEndTurn: (params: DispatchEndTurnParams): Promise<EndTurnDispatchResult> =>
        engine.portDispatchEndTurn(params, ctx()),
      handlePlanPhase: (params: PlanPhaseParams): Promise<PlanPhaseResult> =>
        engine.portHandlePlanPhase(params, ctx()),
      decomposeGoalsIfPlanning: async (params) => {
        // H2: once-per-run guard (rationale on EngineRunContext.goalsDecomposed).
        const c = ctx();
        if (c.goalsDecomposed) return params.agentState;
        c.goalsDecomposed = true;
        return deps.runProactiveGoalDecomposition({
          // SCOPE-KEY ALIGNMENT (BUG#1 P2 HIGH): key the decomposition off the RESOLVED conversation
          // scope, not the raw chatId. The monitor episode + stepBatch + requestStart/End all key off
          // resolveConversationScope(chatId, conversationId) (= runCtx.conversationScope), and
          // activeGoalTrees cleanup deletes by session.conversationScope (also resolved). Passing raw
          // chatId here flipped monitorLifecycle.goalDecomposed's dagKind on a DIFFERENT map entry than
          // stepBatch reads → on the web channel (conversationId=profileId≠chatId) the goal-tree
          // suppression missed and the plain-loop step DAG collided with the goal tree. It ALSO leaked
          // the tree (set by chatId, deleted by resolved scope). runCtx already carries the resolved
          // scope (used for joinEpisodeEnd at :377).
          conversationScope: c.conversationScope ?? params.chatId,
          userMessage: deps.sessionManager.extractLastUserMessage(c.session),
          chatId: params.chatId,
          session: c.session,
          agentState: params.agentState,
        });
      },

      // ── F. tool execution (the bound FULL TOOL TURN; see portExecuteToolTurn) ────────────────
      executeToolCalls: (async (...args: unknown[]) =>
        engine.portExecuteToolTurn(args, ctx())) as ExecuteToolCallsFn,

      // ── G. limits / config (1:1) ─────────────────────────────────────────────────────────────
      getInteractiveIterationLimit: () => engine.getInteractiveIterationLimit(),
      getBackgroundEpochIterationLimit: () => engine.getBackgroundEpochIterationLimit(),
      canAutoContinueBackgroundEpoch: (n) => engine.canAutoContinueBackgroundEpoch(n),
      canAutoContinueInteractiveEpoch: (n) => engine.canAutoContinueInteractiveEpoch(n),
      onEpochRollover: (continued, epoch, agentState) =>
        deps.portOnEpochRollover(continued, epoch, agentState, ctx()),
      getLiveInteractiveTokenBudget: () => engine.getLiveInteractiveTokenBudget(),
      getLiveOutputTokenCap: () => engine.getLiveOutputTokenCap(),
      renderInteractiveBudgetExceeded: () => engine.portRenderInteractiveBudgetExceeded(ctx()),
      // Mid-task /token raise: bridge the run to UnifiedBudgetManager config changes (no-op when unwired).
      onBudgetConfigChanged: (listener) =>
        deps.unifiedBudgetManager()?.onConfigUpdated?.(listener) ?? (() => {}),

      // ── H. GAP: classifyIntent → mirror the spine's first-clause fallback ────────────────────
      classifyIntent: async (prompt: string) => firstClause(prompt),

      // ── Terminal ─────────────────────────────────────────────────────────────────────────────
      synthesizeFinal: (_state: AgentState, _mode, terminal): SynthesizedFinal => {
        // GAP: PURE read of the already-synthesized transcript (synthesizeUserFacingResponse is
        // async+impure and would re-bill; the visible text was assembled by the dispatch handlers).
        const c = ctx();
        const transcript = deps.sessionManager.getVisibleTranscript(c.session);
        const lastVisible = [...transcript].reverse().find((m) => m.role === "assistant");
        // GAP4: extract the text from the last visible assistant message — handle BOTH a plain
        // string AND structured/multimodal MessageContent[] (join the text blocks; ignore image/
        // tool blocks). The interactive path always has a string here (dispatch → markdown).
        const readBack = extractAssistantText(lastVisible?.content).trim();
        if (readBack) return { text: readBack, summary: readBack }; // happy path — verbatim, no regress.
        // No visible read-back. This is the VERDICT-STOP terminal shape (budget/timeout/persistent
        // failure/ask_user broke epochLoop BEFORE any dispatch handler appended a visible message),
        // OR a genuinely clean completion that emitted no text. A bare "Task completed." on a STOP is
        // a FALSE success → surface the real, localized stop reason instead (GAP4). Only a clean
        // terminal (done/end_turn/plan-review/goal-handoff/benign-cancel) keeps the neutral fallback.
        const messageKey = deps.mapTerminalReasonToMessageKey(terminal?.reason, terminal?.status);
        if (messageKey) {
          // Language: worker/background sets profileLanguage=undefined → defaults to this.defaultLanguage
          // (EN unless configured) — matches portRenderInteractiveBudgetExceeded's resolution. The
          // interactive path never reaches here (it has a read-back via dispatch).
          const language = (c.profileLanguage ?? deps.defaultLanguage) as string;
          const text = getResilienceMessage(messageKey, language);
          return { text, summary: text };
        }
        const text = "Task completed.";
        return { text, summary: text };
      },
      persistTerminal: async (state: AgentState, _setup, cancelReason?: CancelReason, terminalStatus?: TerminalStatus) => {
        const c = ctx();
        // A BENIGN cancel (mid-run user /cancel, daemon winddown, …) must NOT be recorded as a
        // successful completion — that polluted metrics + the learning signal. v1 recorded the
        // terminal phase (its catch transitioned to FAILED on the `signal.aborted` re-throw, so the
        // finally recorded FAILED, never COMPLETE). Mirror that: a benign cancel records FAILED; every
        // other terminal (success / verdict-stop / non-cancel) keeps COMPLETE exactly as before.
        const cancelled = cancelReason !== undefined && isBenign(cancelReason);
        try {
        engine.recordMetricEnd(c.metricId, {
          agentPhase: cancelled ? AgentPhase.FAILED : AgentPhase.COMPLETE,
          iterations: state.iteration,
          toolCallCount: state.stepResults.length,
          hitMaxIterations: false,
        });
        // Step 3 / gap #6 — execution-journal continuity (v1 parity: runAgentLoop finally :6061-6062,
        // runBackgroundTask finally :4509-4510). v1 wrote the journal to execution memory + snapshotted
        // it onto the session on every terminal path; the v2 prologue READS session.lastJournalSnapshot
        // (setupAgentCoreRun) as previousJournalSnapshot for cross-turn continuity, so WITHOUT this
        // write-back every v2 turn after the first reads a stale snapshot — silent multi-turn memory
        // corruption. Runs on the same normal-terminal path as persistSessionToMemory below (v2 failures
        // are verdicts, not throws, so this covers every path the spine actually takes).
        deps.sessionManager.persistExecutionMemory(c.identityKey, c.executionJournal);
        c.session.lastJournalSnapshot = c.executionJournal.snapshot();
        await deps.sessionManager.persistSessionToMemory(
          c.chatId,
          deps.sessionManager.getVisibleTranscript(c.session),
          true,
        );
        // Issue #22 (SIBLING A) — IN-RUN trajectory-credit trigger. MUST run BEFORE the
        // currentSessionInstinctIds.delete below (the participating set is read inside). Default-OFF
        // ⇒ no-op ⇒ byte-identical. Success-only: a benign cancel (`cancelled`) or a non-COMPLETE
        // terminal passes success=false ⇒ no reinforcement. (#22's sole writer under flag-on — the
        // route-level endTask record is suppressed when the flag is on; see endTask's
        // suppressTrajectoryRecord.)
        deps.recordInRunTrajectoryCredit({
          chatId: c.chatId,
          sessionId: c.chatId,
          taskDescription: state.taskDescription,
          success: !cancelled && state.phase === AgentPhase.COMPLETE,
          stepResults: state.stepResults,
        });
        // audited 2026-09-02: the tree decomposed by THIS run (goalsDecomposed
        // is the once-per-run guard above) gets the run's real terminal status;
        // a benign cancel settles failed, as the metric above does. Trees a
        // "resume" reply placed in activeGoalTrees are not this run's to settle.
        if (c.goalsDecomposed) {
          deps.settleGoalTree(
            c.conversationScope ?? c.chatId,
            cancelled ? "failed" : (terminalStatus ?? "completed"),
          );
        }
        // GAP1 teardown — symmetric to v1's runAgentLoop finally (:6232-6234): clear the per-session
        // instinct IDs so a later, unrelated emitToolResult on this chatId cannot mis-attribute to a
        // prior run's instincts, and prevent the Map growing unbounded. Runs from the spine's finally
        // on EVERY exit (happy or throw), exactly once per run.
        deps.currentSessionInstinctIds.delete(c.chatId);
        // audited 2026-09-02: the pipeline's per-run credit ledger ends with the run too.
        deps.clearRunInstinctCredits(c.chatId);
        deps.propagateInstinctIdsToChannel(c.chatId, []);
        } finally {
          // v1 parity (runBackgroundTask finally :4894-4896): settle the joined worker card WITHOUT
          // marking the parent whole-goal episode terminal — the episode stays open until the ROOT
          // run's requestEnd. In a FINALLY so a persistence throw above can never leave the card
          // dangling "executing" (trio catch). failed mirrors v1's workerRequestFailed (:4884:
          // finalStatus failed/blocked → true) from the spine's REAL terminal status — NOT from
          // state.phase, which never reaches COMPLETE in production (trio HIGH catch); a benign
          // cancel also settles as failed (v1: the abort catch transitioned FAILED).
          if (c.joinsParentEpisode && c.conversationScope) {
            deps.monitorLifecycle()?.joinEpisodeEnd(
              c.conversationScope,
              cancelled || terminalStatus === "failed" || terminalStatus === "blocked",
              c.workerMonitorScope,
            );
          }
        }
      },
      buildResultProjection: (params: ResultProjectionParams): AgentRunResultProjection =>
        engine.buildResultProjection(params, ctx()),
    };
    const port: OrchestratorPort = Object.freeze(portImpl);

    return {
      port,
      // silentStream's 8th param is typed `runClock?: RunClock`; the gateway's SilentStreamPort
      // types it `runClock: unknown` (carrying no control-plane dependency). The bodies are
      // identical — the cast localizes the variance mismatch to this one line. Phase 1c: the
      // gateway now FORWARDS the run's RunClock (req.runClock) into that slot; this real method
      // narrows the `unknown` back to RunClock and re-arms call liveness per chunk (v1 parity).
      gateway: deps.createGateway(),
      seed: engine.buildPolicySeed(),
      // Returns the SHARED per-run adapter (see the bug-fix note above) — the SAME instance the spine
      // records failures/successes into via the port, so the ledger's verdict rules read live health.
      createHealthCore: () => runHealthAdapter,
    };
  }
