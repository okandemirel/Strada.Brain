/**
 * Agent Core v2 — OrchestratorPort: the bound-method surface V2AgentRunner drives.
 *
 * V2AgentRunner depends ONLY on this port + the four agent-core foundations (control,
 * events, model, runner seam). It NEVER imports the concrete Orchestrator — so there is no
 * cycle (this file imports only types already reachable from agent-core, exactly like
 * agent-runner.ts / model-gateway.ts). The Orchestrator implements this port in the
 * worker-route-flip increment by binding its private methods; until then
 * V2RunnerDeps.orchestratorPort stays `unknown` and run() narrows it to OrchestratorPort.
 *
 * Design rationale (3 decisions):
 *  1. The port is the SOLE bundle of v1 logic V2 drives that closes over Orchestrator `this`
 *     (provider router, session manager, metrics, config). Free functions
 *     (executeAndTrackTools, transitionPhase, mapVerdictToLoopAction, …) are imported directly
 *     by the spine — they do not need the port (no `this`). This keeps the port minimal and the
 *     cycle impossible.
 *  2. The provider call is the ONLY collapse point. The port does NOT expose silentStream to the
 *     spine — the spine calls gateway.call(...). The port's job around the model call is the
 *     NON-call gauntlet work: prepareIteration (produces the FallbackChain-selected provider),
 *     recordExecutionTrace, recordProviderUsage, saveBudgetExceededCheckpoint. The
 *     SilentStreamPort the gateway wraps is supplied at ModelGateway construction time, NOT here.
 *  3. Two methods collapse the entire verdict bridge: buildPolicySeed() and
 *     classifyFailureForVerdict(...). The spine assembles the clock/budget half of VerdictInput
 *     itself (it owns the RunClock/Budget); the port supplies the health/provider-failure half
 *     (it owns the IterationHealthTracker + the v1 failure-classification that decides `benign`).
 *
 * What is NOT here (imported directly by the spine — no `this`):
 *   - free helpers: executeAndTrackTools, refreshMemoryIfNeeded, runConsensusIfAvailable,
 *     checkPendingBlocks, pushContinuationMessages, MAX_TOKENS_CONTINUATION_GATE,
 *     buildPhasePromptSection, processReflectionPreamble, recordStepResultsAndCheckReflection,
 *     buildToolResultContentBlocks
 *   - agent-state: createInitialState, transitionPhase, canTransition,
 *     validateReflectionDecision, isEmptyProviderResponse
 *   - control plane: resolveRunBudgetPolicy, openRunClock, createFailureLedger,
 *     mapVerdictToLoopAction, ledger.verdict (the ledger instance is built by ControlPlane)
 *   - the model call: gateway.call(...) (V2RunnerDeps.gateway), whose SilentStreamPort the
 *     Orchestrator wires at gateway-construction time — NOT through this port.
 *
 * PURELY ADDITIVE: nothing in v1 imports this yet. It is the slot the Orchestrator fills in the
 * worker-route-flip increment (Part 3 of the design).
 */

import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type { ProviderResponse } from "../../agents/providers/provider-core.interface.js";
import type { AgentState } from "../../agents/agent-state.js";
import type { ExecutionJournal } from "../../agents/autonomy/execution-journal.js";
import type {
  SupervisorAssignment,
  SupervisorExecutionStrategy,
} from "../../agents/orchestrator-supervisor-routing.js";
import type { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import type { MemoryRefresher } from "../../agents/memory-refresher.js";
import type {
  WorkerArtifactMetadata,
  WorkerReviewFinding,
  WorkerToolTrace,
  WorkerUsageEvent,
  WorkerVerificationResult,
} from "../../agents/supervisor/supervisor-types.js";
import type { TaskClassification } from "../routing/routing-types.js";
import type { PolicySeed } from "../control/policy.js";
import type { CancelReason } from "../control/cancel-reason.js";
import type { GatewayToolDefinition } from "../model/model-gateway.js";
import type { RunnerMode } from "./agent-runner.js";

/** The runner-facing mode the port keys its mode-dependent dispatch on. */
export type RunnerModeLike = RunnerMode;

// ── Sub-result shapes the port returns (kept structural; mirror v1 internals) ──────────

/** Everything prepareIteration rebuilds for one step (gauntlet #2–#6, minus the call). */
export interface PreparedIteration {
  readonly executionStrategy: SupervisorExecutionStrategy;
  readonly activePrompt: string;
  readonly currentAssignment: SupervisorAssignment;
  /** The provider FallbackChain already selected — handed straight to gateway.call(). */
  readonly currentProvider: IAIProvider;
  readonly currentToolDefinitions: GatewayToolDefinition[];
  readonly currentToolNames: string[];
}

/** The per-run context the spine assembles ONCE in the prologue (gauntlet step C). */
export interface RunSetup {
  readonly systemPrompt: string;
  readonly session: { messages: unknown[] };
  readonly executionJournal: ExecutionJournal;
  readonly memoryRefresher: MemoryRefresher | null;
  readonly identityKey: string;
  readonly fallbackProvider: IAIProvider;
  /** The live IterationHealthTracker behind the FailureLedger's HealthCore adapter. */
  readonly iterationHealth: IterationHealthTracker;
  /** Read-only metrics handle id for recordMetricEnd at terminal. */
  readonly metricId: string;
  readonly enableGoalDetection: boolean;
}

// ── The verdict-bridge contribution type (the load-bearing one) ────────────────────────

/**
 * The HEALTH/FAILURE half of VerdictInput, produced by the port from a provider failure.
 * The spine merges this with the CLOCK/BUDGET half it owns. On a SUCCESSFUL step the spine
 * uses the NO-FAILURE default ({ callStalled:false, taskCancelReason:null, benign:false })
 * and calls port.recordHealthSuccess(provider) instead.
 */
export interface FailureVerdictContribution {
  /** Provider-stall on the call token → drives verdict rule 6 (pause/stop). */
  readonly callStalled: boolean;
  /** Typed reason if the TASK token aborted because of this failure; else null. */
  readonly taskCancelReason: CancelReason | null;
  /** Whether the failure was benign (already recorded as such in the health tracker). */
  readonly benign: boolean;
}

export interface ClassifyFailureParams {
  readonly kind: "throw" | "empty";
  readonly provider: string;
  /** The thrown error (throw path). */
  readonly error?: unknown;
  /** The empty response (empty path). */
  readonly response?: ProviderResponse;
  /** The CallScope token's reason if the call aborted; carried, never inferred (§2.2). */
  readonly failedCallReason: CancelReason | null;
}

// ── Supporting param/result types (the exact shapes the impl binds) ────────────────────

export interface AgentRunSetupInput {
  readonly prompt: string;
  readonly chatId: string;
  readonly channelType: string;
  readonly mode: RunnerModeLike;
  readonly interactiveSession?: unknown;
  readonly assignedProvider?: string;
  readonly assignedModel?: string;
  readonly taskRunId?: string;
  readonly parentMetricId?: string;
  readonly onUsage?: (u: WorkerUsageEvent) => void;
}

export interface PrepareIterationParams {
  readonly prompt: string;
  readonly identityKey: string;
  readonly agentState: AgentState;
  readonly executionJournal: ExecutionJournal;
  readonly systemPrompt: string;
  readonly fallbackProvider: IAIProvider;
  readonly toolTurnAffinity: SupervisorAssignment | null;
  readonly enableGoalDetection: boolean;
  readonly iterationHealth: IterationHealthTracker;
}

export interface RecordExecutionTraceParams {
  readonly chatId?: string;
  readonly identityKey: string;
  readonly assignment: SupervisorAssignment;
  readonly phase: "planning" | "executing" | "reflecting" | "replanning";
  readonly task: TaskClassification;
  readonly taskRunId?: string;
  readonly reason?: string;
}

export interface BudgetCheckpointParams {
  readonly taskId: string;
  readonly chatId: string;
  readonly lastUserMessage: string;
  readonly used: number;
  readonly budget: number;
}

export interface DispatchReflectionParams {
  readonly mode: RunnerModeLike;
  readonly agentState: AgentState;
  readonly decision: "CONTINUE" | "REPLAN" | "DONE" | "DONE_WITH_SUGGESTIONS";
  readonly wasOverride: boolean;
  readonly responseText: string | undefined;
  readonly chatId: string;
  readonly session: unknown;
}

export interface ReflectionDispatchResult {
  readonly agentState: AgentState;
  /** True when the dispatch resolved to a terminal DONE (→ spine emits run.ending + breaks). */
  readonly terminal: boolean;
  readonly reason?: string;
}

export interface DispatchEndTurnParams {
  readonly mode: RunnerModeLike;
  readonly agentState: AgentState;
  readonly responseText: string | undefined;
  readonly chatId: string;
  readonly session: unknown;
}

export interface EndTurnDispatchResult {
  readonly agentState: AgentState;
  readonly finalText: string;
}

export interface PlanPhaseParams {
  readonly mode: RunnerModeLike;
  readonly agentState: AgentState;
  readonly responseText: string | undefined;
  readonly providerName: string;
  readonly modelId?: string;
  readonly chatId: string;
}

/** Optional yield: show_plan (emit+continue) or ask_user (interactive emit+continue / bg block). */
export type PlanPhaseYield =
  | { readonly kind: "show_plan"; readonly visibleText: string }
  | { readonly kind: "ask_user"; readonly question: string; readonly visibleText: string };

export interface PlanPhaseResult {
  readonly agentState: AgentState;
  readonly yield?: PlanPhaseYield;
}

export interface GoalDecompositionParams {
  readonly agentState: AgentState;
  readonly responseText: string | undefined;
  readonly chatId: string;
}

export interface SynthesizedFinal {
  readonly text: string;
  readonly summary: string;
}

export interface ResultProjectionParams {
  readonly state: AgentState;
  readonly final: SynthesizedFinal;
  readonly toolTrace: readonly { toolName: string; toolCallId: string; success: boolean }[];
  readonly touchedFiles: readonly string[];
  readonly status: "completed" | "failed" | "blocked";
  readonly reason?: string;
  readonly usage?: WorkerUsageEvent;
  readonly cancelReason?: CancelReason;
}

export interface AgentRunResultProjection {
  readonly provider: string;
  readonly model?: string;
  readonly catalogVersion: string;
  readonly assignmentVersion: number;
  readonly workspaceId?: string;
  readonly touchedFiles: readonly string[];
  readonly toolTrace: readonly WorkerToolTrace[];
  readonly verificationResults: readonly WorkerVerificationResult[];
  readonly reviewFindings: readonly WorkerReviewFinding[];
  readonly artifacts: readonly WorkerArtifactMetadata[];
}

/** The tool-execution callback the spine threads into executeAndTrackTools (closes over `this`). */
export type ExecuteToolCallsFn = (...args: unknown[]) => Promise<unknown>;

export interface OrchestratorPort {
  // ════ Per-run setup (prologue; NOT per-iteration) ══════════════════════════════════
  /**
   * Assemble the whole per-run context the spine carries: system prompt, session, journal,
   * autonomy bundle, health tracker, metrics start. Wraps v1's buildSystemPromptWithContext +
   * createAutonomyBundle + metricsRecorder.startTask + createMemoryRefresher. The spine never
   * reaches into these; it threads the returned RunSetup through the loop.
   */
  setupRun(request: AgentRunSetupInput): Promise<RunSetup>;

  /** The policy seed (v1 config defaults) for resolveRunBudgetPolicy. Read-only. */
  buildPolicySeed(): PolicySeed;

  // ════ Per-iteration prep (gauntlet #2–#6, minus the call) ══════════════════════════
  /**
   * Rebuild strategy, phase-aware activePrompt (buildPhasePromptSection), pinned assignment,
   * tool defs, role prompt, health-awareness. The currentProvider it returns is the one
   * FallbackChain selected (task-aware build happens INSIDE here).
   */
  prepareIteration(params: PrepareIterationParams): PreparedIteration;

  /** Session compaction (gauntlet #5). */
  maybeCompactSession(
    session: unknown,
    providerName: string,
    modelId?: string,
    systemPrompt?: string,
  ): void;

  /** Context-window trim for non-interactive (gauntlet #4). */
  trimContextWindow(session: { messages: unknown[] }, mode: "interactive" | "background"): void;

  // ════ Accounting / trace (gauntlet #8–#9) ══════════════════════════════════════════
  /** Execution trace record. */
  recordExecutionTrace(params: RecordExecutionTraceParams): void;

  /**
   * Success accounting. Threads provider usage into v1's recorder AND forwards to the
   * request.onUsage sink.
   */
  recordProviderUsage(providerName: string, usage: ProviderResponse["usage"] | undefined): void;

  /** Persist the budget-exceeded checkpoint (gauntlet #9 stop path). */
  saveBudgetExceededCheckpoint(params: BudgetCheckpointParams): Promise<void>;

  // ════ THE verdict bridge — the health/failure half of VerdictInput ═════════════════
  /**
   * Build the FAILURE/HEALTH half of VerdictInput from a provider THROW or EMPTY response. The
   * single place v1's failure-classification (benign? provider-stall? typed CancelReason?) is
   * honored. Records the failure into the IterationHealthTracker (so the FailureLedger's
   * HealthCore adapter sees it) and returns the partial contribution the spine merges with its
   * clock/budget half. Returns INPUT, not a verdict — the ledger.verdict call stays in the spine
   * so there is exactly one gate site.
   */
  classifyFailureForVerdict(params: ClassifyFailureParams): FailureVerdictContribution;

  /** Record a REAL (non-probe) success into the health tracker — clears the failure run. */
  recordHealthSuccess(provider: string): void;

  // ════ Reflection + end-turn terminators (gauntlet #12c, #15, #16) ══════════════════
  /**
   * Dispatch the reflection decision (DONE / REPLAN / CONTINUE) for the active mode. Returns the
   * new AgentState (handlers RETURN newState, never mutate — the loop is sole writer) plus
   * whether this is a terminal DONE. Visible-text side effects (sendMarkdown) are the port's
   * concern; the spine only consumes the returned state + terminal flag and emits the matching
   * event.
   */
  dispatchReflection(params: DispatchReflectionParams): Promise<ReflectionDispatchResult>;

  /**
   * Handle end_turn / no-tool terminal for the active mode (gauntlet #16). Returns the terminal
   * AgentState + the visible final text.
   */
  dispatchEndTurn(params: DispatchEndTurnParams): Promise<EndTurnDispatchResult>;

  /**
   * Plan-review / autonomous-plan transition (gauntlet #15). Returns new state + an optional
   * yield directive: show_plan (emit + continue) or ask_user (interactive: emit + continue;
   * background: yield "blocked"). The spine routes the yield directive through handleYield.
   */
  handlePlanPhase(params: PlanPhaseParams): Promise<PlanPhaseResult>;

  /** Goal detection in PLANNING (interactive only, gauntlet #13/#14). Returns new state. */
  decomposeGoalsIfPlanning(params: GoalDecompositionParams): Promise<AgentState>;

  // ════ Tool execution (gauntlet #18) ════════════════════════════════════════════════
  /** The bound executeToolCalls closure threaded into the free executeAndTrackTools helper. */
  readonly executeToolCalls: ExecuteToolCallsFn;

  // ════ Limits / config (read-only) ══════════════════════════════════════════════════
  getInteractiveIterationLimit(): number;
  getBackgroundEpochIterationLimit(): number;
  canAutoContinueBackgroundEpoch(completedEpochCount: number): boolean;
  getLiveInteractiveTokenBudget(): number;

  // ════ Intent ack (≤2s contract, §6) ════════════════════════════════════════════════
  /**
   * Fast-path intent classification for the ack contract. Resolves to a short summary; the spine
   * races it against a 2s fallback that derives the first clause of the prompt.
   */
  classifyIntent(prompt: string): Promise<string>;

  // ════ Terminal (gauntlet #23) ═══════════════════════════════════════════════════════
  /**
   * Assemble the terminal visible text from final state (KEEP synthesizeUserFacingResponse /
   * the v1 finalVisibleResponse assembly). Pure read of state + session transcript.
   */
  synthesizeFinal(state: AgentState, mode: RunnerModeLike): SynthesizedFinal;

  /**
   * Durably persist the terminal state (execution memory + journal snapshot + recordMetricEnd).
   * The fire-and-forget-with-barrier target: kicked at run.ending, JOINED at the terminal.
   */
  persistTerminal(state: AgentState, setup: RunSetup): Promise<void>;

  /**
   * Project the terminal state + collected effects into the structured AgentRunResult fields the
   * worker path needs. Replaces __workerCollector: the spine accumulates the trace as events fly;
   * this turns the final state + accumulated trace into the result by value. Pure.
   */
  buildResultProjection(params: ResultProjectionParams): AgentRunResultProjection;
}
