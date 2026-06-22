/**
 * Agent Core v2 — V2AgentRunner: the unified AgentLoop spine (ARCHITECTURE §4.1, §5–§7).
 *
 * The single `run()` reproduces v1's two loops (interactive + background) ONCE, parameterized
 * along exactly two axes — `io: IOStrategy` and the control-plane policy derived from `io.mode`.
 * Interactive is the degenerate single-epoch case of the background outer-epoch loop; the body
 * is the same ordered statement sequence (see the divergence table in the design header).
 *
 * Dependency rule (the structural invariant): V2AgentRunner depends ONLY on the four agent-core
 * foundations (ControlPlane, AgentRunEventBus, ModelGateway, the runner seam) + OrchestratorPort.
 * It NEVER imports the concrete Orchestrator. Every piece of v1 PAOR/reflection/compaction/
 * tool-exec logic is DELEGATED — either to a free helper (no `this`) or to the OrchestratorPort
 * (closes over `this`). This file rewrites NO v1 logic.
 *
 * Two correctness invariants encoded here (from the foundations):
 *  - Policy warnings are LOGGED, never thrown (resolveRunBudgetPolicy returns { policy, warnings }).
 *  - The spine never re-emits the gateway's events (model.call.* / model.delta / heartbeat) and
 *    never re-calls call.touch()/firstTokenSeen() — silentStream owns liveness. The gateway today
 *    passes `undefined` for the runClock slot (model-gateway.ts), so on the v2 route nothing yet
 *    re-arms the CallScope inactivity timer from token arrival. That single wiring decision is the
 *    live question the worker-route-flip increment resolves (Part 3, item 2); the spine leaves the
 *    `call` handle available for whichever wiring is chosen and deliberately does NOT call them.
 *
 * PURELY ADDITIVE: nothing in v1 routes here yet (the flag selector lands in the route-flip
 * increment). The concrete ControlPlane assembler (control/control-plane.ts) is likewise deferred;
 * the spine depends only on the {@link ControlPlane} interface declared here.
 */

import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
  IOStrategy,
  RunnerMode,
  TerminalStatus,
} from "./agent-runner.js";
import type {
  AgentRunSetupInput,
  OrchestratorPort,
  PlanPhaseYield,
  PreparedIteration,
  RecordExecutionTraceParams,
  RunSetup,
} from "./orchestrator-port.js";
import type { RunMode } from "../control/policy.js";
import { resolveRunBudgetPolicy } from "../control/policy.js";
import type { Budget, TokenUsage as BudgetTokenUsage } from "../control/budget.js";
import type { RunClock, CallLimits } from "../control/run-clock.js";
import type { RunClockView } from "../control/run-clock.js";
import type { FailureLedger, RunVerdict, VerdictInput } from "../control/failure-ledger.js";
import type { CancelReason } from "../control/cancel-reason.js";
import { describeCancelReason, isBenign } from "../control/cancel-reason.js";
import { mapVerdictToLoopAction } from "../control/verdict-loop-action.js";
import type { Clock } from "../control/clock.js";
import type { AgentRunEventBus } from "../events/event-bus.js";
import { guardedSleep } from "../events/heartbeat-guard.js";
import type { ModelGateway } from "../model/model-gateway.js";
import type { ModelCallResult } from "../model/model-gateway.js";
import type { ProviderResponse, TokenUsage } from "../../agents/providers/provider-core.interface.js";
import type { WorkerUsageEvent } from "../../agents/supervisor/supervisor-types.js";
import { AgentPhase, createInitialState, type AgentState } from "../../agents/agent-state.js";
import { getLoggerSafe } from "../../utils/logger.js";
// Free helpers imported directly by the spine (no `this`). The max_tokens continuation gate +
// pusher are the v1 shared helpers; nothing here closes over the Orchestrator.
import {
  pushContinuationMessages,
  MAX_TOKENS_CONTINUATION_GATE,
  firstClause,
} from "../../agents/orchestrator-loop-shared.js";

// ───────────────────────────────────────────────────────────────────────────
// ControlPlane — the thin assembler the spine reads the foundations through.
// The CONCRETE implementation (control/control-plane.ts) is deferred to the worker-route-flip
// increment; the spine depends ONLY on this interface (mirrors how the skeleton header described
// it). openRun wires the resolved policy into a RunClock + FailureLedger + Budget; openBus wraps
// io's sinks + the learning bridge as BoundedSinks behind the run-scoped bus.
// ───────────────────────────────────────────────────────────────────────────

export interface OpenRunResult {
  readonly clock: RunClock;
  readonly ledger: FailureLedger;
  readonly budget: Budget;
}

export interface ControlPlane {
  openRun(mode: RunMode, parentClockView?: RunClockView): OpenRunResult;
  openBus(runId: string, io: IOStrategy, parentRunId?: string): AgentRunEventBus;
}

/**
 * Dependencies threaded into the V2 runner. `orchestratorPort` is narrowed from the skeleton's
 * `unknown` to {@link OrchestratorPort}; `controlPlane` from `unknown` to {@link ControlPlane}.
 * `clock` is the injected time source (SystemClock in prod, FakeClock in P-E tests) — used for
 * the guardedSleep wait primitive (the bus stamps events from its own clock).
 */
export interface V2RunnerDeps {
  readonly controlPlane: ControlPlane;
  readonly gateway: ModelGateway;
  readonly orchestratorPort: OrchestratorPort;
  readonly clock: Clock;
}

/**
 * RunnerMode → RunMode. `"worker"` ≡ `"delegate"` (the structured-result background variant);
 * the other three names map 1:1.
 */
export function mapMode(m: RunnerMode): RunMode {
  return m === "worker" ? "delegate" : m;
}

/** Background-family modes share the outer-epoch loop; interactive is the single-epoch case. */
function isInteractive(mode: RunnerMode): boolean {
  return mode === "interactive";
}

/** The v1 trim modes collapse to two; everything non-interactive trims as "background". */
function trimMode(mode: RunnerMode): "interactive" | "background" {
  return mode === "interactive" ? "interactive" : "background";
}

/** Provider `TokenUsage` (totalTokens, no cost) → control-plane `Budget` usage (carries cost). */
function toBudgetUsage(usage: TokenUsage | undefined): BudgetTokenUsage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    // Provider usage carries no per-turn cost on this interface; cost gating is driven by the
    // provider-usage recorder (port.recordProviderUsage). Budget cost stays uncharged here so it
    // is never double-counted — tokens are the live gate.
    costUsd: 0,
  };
}

/** Accumulate provider usage into the run-total WorkerUsageEvent (the AgentRunResult.usage). */
function mergeUsage(
  acc: WorkerUsageEvent | undefined,
  provider: string,
  usage: TokenUsage | undefined,
): WorkerUsageEvent {
  return {
    provider,
    inputTokens: (acc?.inputTokens ?? 0) + (usage?.inputTokens ?? 0),
    outputTokens: (acc?.outputTokens ?? 0) + (usage?.outputTokens ?? 0),
  };
}

/** WorkerUsageEvent → the public AgentRunResult.usage (TokenUsage) shape. */
function toResultUsage(usage: WorkerUsageEvent | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
  };
}

/** A monotone-ish run id when the caller did not supply one (taskRunId). */
function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** What the gateway call collapsed to: a real response, an empty response, or a throw. */
type StepOutcome =
  | { readonly kind: "ok"; readonly response: ProviderResponse }
  | { readonly kind: "empty"; readonly response: ProviderResponse }
  | { readonly kind: "threw"; readonly error: unknown };

function classifyOutcome(result: ModelCallResult): StepOutcome {
  return result.empty
    ? { kind: "empty", response: result.response }
    : { kind: "ok", response: result.response };
}

/** A PhaseChanged event built only when the phase actually moved. */
function phaseChangedEvent(
  from: AgentPhase,
  to: AgentPhase,
): { type: "phase.changed"; from: AgentPhase; to: AgentPhase } | null {
  return from === to ? null : { type: "phase.changed", from, to };
}

/** AgentPhase → execution-trace phase string. Hoisted: built once, not re-allocated per step. */
const PHASE_TRACE_MAP: Record<string, RecordExecutionTraceParams["phase"]> = {
  [AgentPhase.PLANNING]: "planning",
  [AgentPhase.EXECUTING]: "executing",
  [AgentPhase.REFLECTING]: "reflecting",
  [AgentPhase.REPLANNING]: "replanning",
};

export class V2AgentRunner implements AgentRunner {
  constructor(private readonly deps: V2RunnerDeps) {}

  async run(request: AgentRunRequest, io: IOStrategy): Promise<AgentRunResult> {
    // Step 0 / gap #1 — establish v1's task-execution ALS scope around the ENTIRE run so deep readers
    // (goal-decomposition taskRunId, artifact-eval identityKey) see the context v1 set inside
    // runBackgroundTask. v2-only (V1AgentRunner doesn't call this); the port owns the scope since the
    // spine cannot import the orchestrator's AsyncLocalStorage.
    return await this.deps.orchestratorPort.withRunTaskContext(this.toSetupInput(request, io.mode), () =>
      this.runInner(request, io),
    );
  }

  private async runInner(request: AgentRunRequest, io: IOStrategy): Promise<AgentRunResult> {
    const { controlPlane, gateway, orchestratorPort: port, clock } = this.deps;
    const log = getLoggerSafe();
    const runId = request.taskRunId ?? newRunId();
    const mode = io.mode;

    // ─── PROLOGUE (once) ──────────────────────────────────────────────────────────────
    const seed = port.buildPolicySeed();
    const { policy, warnings } = resolveRunBudgetPolicy(mapMode(mode), seed);
    for (const w of warnings) log.warn("[v2-run-budget-policy]", { warning: w }); // LOG, never throw

    const { clock: runClock, ledger, budget } = controlPlane.openRun(
      policy.mode,
      request.parentClockView,
    );
    const bus = controlPlane.openBus(runId, io, request.parentClockView ? runId : undefined);
    const emit = (e: Parameters<AgentRunEventBus["emit"]>[0]): number => bus.emit(e);

    // ─── Bind the external (user/daemon) cancel signal to the task token (benign-cancel parity) ──
    // io.externalSignal is the dual-signal v1 carried verbatim, but on the v2 route nothing tied an
    // ABORT of it back to runClock.taskToken — so a mid-run /cancel surfaced ONLY as a gateway throw
    // ({kind:"threw"}) and the failure gate misread it as a provider HEALTH failure (recordFailure +
    // COMPLETE metric). Wiring it here stamps the token's reason = user-cancel the instant the signal
    // fires, so (a) the failure gate's user-cancel short-circuit and rule 1/1b see the benign reason,
    // and (b) the terminal reads it into AgentRunResult.cancelReason. {once:true} + a guarded cancel
    // (the token may already have ended) keep this a single, side-effect-free hook over the whole run.
    if (io.externalSignal) {
      io.externalSignal.addEventListener(
        "abort",
        () => {
          try {
            runClock.taskToken.cancel({ kind: "user-cancel" });
          } catch {
            /* run already ended — the token is the single source of truth, first write wins */
          }
        },
        { once: true },
      );
    }

    // Hoisted ABOVE the try so the finally can read the latest state + the resolved setup on EVERY
    // exit (happy or throw). The loop is the sole writer of AgentState; every mode seeds the same
    // initial PLANNING state (interactive vs background differ only via IOStrategy + policy).
    let state: AgentState = createInitialState(request.prompt);
    let setup: RunSetup | undefined;

    try {
      setup = await port.setupRun(this.toSetupInput(request, mode));
      // Step 0 / gap #6 — seed the prologue's retrieved instinct insights into the state so the PLANNING
      // prompt's "### Learned Patterns" block (buildPhasePromptSection → mergeLearnedInsights) renders
      // them, matching v1 (runBackgroundTask :3381). The base systemPrompt is also augmented by the port.
      if (setup.learnedInsights && setup.learnedInsights.length > 0) {
        state = { ...state, learnedInsights: setup.learnedInsights };
      }

      emit({ type: "run.started", prompt: request.prompt, mode });
      await this.intentAck(bus, clock, port, request);

      // Accumulators that replace __workerCollector (built BY VALUE at terminal).
      const toolTrace: { toolName: string; toolCallId: string; success: boolean }[] = [];
      const touchedFiles = new Set<string>();
      let lastProvider = "unknown";
      let usageTotal: WorkerUsageEvent | undefined;

      // The outer epoch loop exists ONLY for non-interactive (interactive = single epoch).
      const maxEpochs = isInteractive(mode) ? 1 : Number.POSITIVE_INFINITY;
      let epoch = 0;
      let stepNo = 0;
      // max_tokens continuation runaway guard (gauntlet #12): 3 consecutive truncated-with-no-tools
      // turns abort the run. Reset on every other path (v1 orchestrator.ts:5346 reset-on-any-non-
      // truncated-turn).
      let consecutiveMaxTokens = 0;
      let terminalReason: string | undefined;
      let terminalStatus: TerminalStatus = "completed";

      // The deriveCallLimits carve the spine hands enterCall (subtractive-min vs task remaining is
      // RunClock's own job — we pass the policy's per-call windows).
      const callLimits: CallLimits = {
        firstResponseMs: policy.callFirstResponseMs,
        stallMs: policy.callStallMs,
        hardMs: policy.callHardMs,
      };

      // ─── THE UNIFIED LOOP ───────────────────────────────────────────────────────────────
      epochLoop: while (epoch < maxEpochs) {
        const iterLimit = isInteractive(mode)
          ? port.getInteractiveIterationLimit()
          : port.getBackgroundEpochIterationLimit();

        for (let iter = 0; iter < iterLimit; iter++) {
          stepNo++;

          // ══ GATE (gauntlet #2: live budget re-read → verdict before any step) ════════════
          const gate = ledger.verdict(this.clockBudgetVerdict(runClock, budget, state));
          if (gate.decision === "stop") {
            terminalReason = describeCancelReason(gate.reason);
            terminalStatus = gate.finalize === "hard" ? "failed" : "completed";
            if (gate.reason.kind === "budget-exhausted") {
              await port.saveBudgetExceededCheckpoint(this.budgetCheckpoint(request, budget));
              // 3.3: on the INTERACTIVE token-budget stop, render the SPECIFIC token_budget_exceeded
              // notice (with {used, budget}) instead of the generic provider_abort — v1 parity. The port
              // renders inline (it owns the cumulative-output counter + session); "budget-exhausted:tokens"
              // is in the interactive skip-set so the adapter does NOT also render an abort.
              if (isInteractive(mode) && gate.reason.resource === "tokens") {
                await port.renderInteractiveBudgetExceeded();
              }
            }
            emit({ type: "run.ending", reason: terminalReason });
            break epochLoop;
          }
          if (gate.decision === "done") {
            terminalReason = "done";
            emit({ type: "run.ending", reason: terminalReason });
            break epochLoop;
          }
          if (gate.decision === "ask_user") {
            // ask_user at the gate: interactive emits + continues; background YIELDS "blocked".
            const yielded = await this.handleYield(bus, clock, io, emit, gate);
            if (yielded === "blocked") {
              terminalStatus = "blocked";
              terminalReason = terminalReason ?? "blocked:ask_user";
              break epochLoop;
            }
            continue; // a fresh gate tick after the user-facing pause
          }
          if (gate.decision === "retry" || gate.decision === "pause") {
            // A pending failure/stall asks for a backoff before THIS step. Back off (emitting the
            // beat first), then FALL THROUGH to take the step — the step's success is what clears
            // the failure run. Re-looping to the gate here would spin (the failure state is not
            // cleared until a call succeeds), so the backoff-then-step is the correct shape.
            await this.handleYield(bus, clock, io, emit, gate);
          }
          // continue / (post-backoff) retry / pause fall through to the step.

          // ══ enterCall: subtractive-min carve (gauntlet #6 prep) ══════════════════════════
          const call = runClock.enterCall(callLimits);

          // ══ assembleStepContext: prepareIteration + compaction + trim (gauntlet #3,#4,#5) ═
          const prepared = port.prepareIteration({
            prompt: request.prompt,
            identityKey: setup.identityKey,
            agentState: state,
            executionJournal: setup.executionJournal,
            systemPrompt: setup.systemPrompt,
            fallbackProvider: setup.fallbackProvider,
            toolTurnAffinity: null,
            enableGoalDetection: setup.enableGoalDetection,
            iterationHealth: setup.iterationHealth,
          });
          port.trimContextWindow(setup.session, trimMode(mode));
          port.maybeCompactSession(
            setup.session,
            prepared.currentAssignment.providerName,
            prepared.currentAssignment.modelId,
            prepared.activePrompt,
          );
          lastProvider = prepared.currentProvider.name || lastProvider;

          emit({ type: "step.started", step: stepNo, phase: state.phase });

          // ══ THE COLLAPSE POINT — the one LLM call (gauntlet #6,#7) ════════════════════════
          //   gateway.call emits model.call.started / model.delta / heartbeat / model.call.finished.
          //   The spine does NOT re-emit those, and does NOT call call.touch()/firstTokenSeen()
          //   (silentStream owns liveness — see the WIRING DECISION in the header / Part 3 item 2).
          let outcome: StepOutcome;
          try {
            const result = await gateway.call(
              {
                chatId: request.chatId,
                systemPrompt: prepared.activePrompt,
                session: setup.session,
                provider: prepared.currentProvider,
                toolDefinitions: prepared.currentToolDefinitions,
                externalSignal: io.externalSignal, // = task token (dual-signal preserved verbatim)
              },
              bus,
            );
            outcome = classifyOutcome(result);
          } catch (err) {
            outcome = { kind: "threw", error: err };
          } finally {
            call.leave(); // commits this call's silent contribution to the task accumulator
          }

          // ══ Accounting (gauntlet #8,#9): budget.debit + execution trace ══════════════════
          if (outcome.kind !== "threw") {
            budget.debit(toBudgetUsage(outcome.response.usage));
            usageTotal = mergeUsage(usageTotal, prepared.currentProvider.name, outcome.response.usage);
            port.recordProviderUsage(prepared.currentProvider.name, outcome.response.usage);
            port.recordExecutionTrace(this.traceParams(request, prepared, state, setup));
          }

          // ══ FAILURE / EMPTY → verdict GATE arbitrates (gauntlet #7,#10,#11) ═══════════════
          if (outcome.kind === "threw" || outcome.kind === "empty") {
            // BENIGN USER-CANCEL short-circuit (v1 parity: the bg loop's `if (signal.aborted) throw`
            // re-throws BEFORE recordPhase1bFailureAndVerdict — a /cancel is never a provider failure).
            // The signal→token wiring (run open) has already stamped runClock.taskToken.reason; if it is
            // a benign cancel, DO NOT call classifyFailureForVerdict (its unconditional recordFailure
            // would poison the per-run health counter). Stop the run gracefully with the typed reason so
            // the terminal surfaces it on AgentRunResult.cancelReason and persistTerminal records it as a
            // cancel (not COMPLETE). terminalStatus stays graceful ("completed" — a benign cancel is not
            // a failure); the metric phase is corrected via persistTerminal's cancel awareness below.
            const taskReason = runClock.taskToken.reason;
            if (taskReason && isBenign(taskReason)) {
              terminalReason = describeCancelReason(taskReason);
              emit({ type: "run.ending", reason: terminalReason });
              break epochLoop;
            }
            const contrib = port.classifyFailureForVerdict({
              kind: outcome.kind === "threw" ? "throw" : "empty",
              provider: prepared.currentProvider.name,
              error: outcome.kind === "threw" ? outcome.error : undefined,
              response: outcome.kind === "empty" ? outcome.response : undefined,
              failedCallReason: call.token.reason, // carried, never inferred
            });
            const failVerdict = ledger.verdict({
              ...this.clockBudgetVerdict(runClock, budget, state),
              taskCancelReason: taskReason ?? contrib.taskCancelReason,
              callStalled: contrib.callStalled,
            });
            const action = mapVerdictToLoopAction(failVerdict, "break");
            if (action.control === "break") {
              terminalReason =
                failVerdict.decision === "stop"
                  ? describeCancelReason(failVerdict.reason)
                  : "provider-failure";
              terminalStatus =
                failVerdict.decision === "stop" && failVerdict.finalize === "hard"
                  ? "failed"
                  : terminalStatus;
              emit({ type: "run.ending", reason: terminalReason });
              break epochLoop;
            }
            // retry / pause / ask_user → single owner: handleYield (emits before+after backoff).
            const yielded = await this.handleYield(bus, clock, io, emit, failVerdict, action.backoffMs);
            if (yielded === "blocked") {
              terminalStatus = "blocked";
              terminalReason = terminalReason ?? "blocked:ask_user";
              break epochLoop;
            }
            emit({ type: "step.completed", step: stepNo, phase: state.phase });
            continue;
          }

          // ══ SUCCESS: record health, apply outcome (gauntlet #12–#22) ══════════════════════
          port.recordHealthSuccess(prepared.currentProvider.name);
          const responseText = outcome.response.text;

          // max_tokens continuation (gauntlet #12) — only when the truncated turn carries NO tool
          // calls. A truncated turn that still emitted tool calls falls through to tool execution.
          if (outcome.response.stopReason === "max_tokens" && outcome.response.toolCalls.length === 0) {
            consecutiveMaxTokens++;
            if (consecutiveMaxTokens >= 3) {
              log.error(
                "max_tokens on 3 consecutive calls — aborting to prevent runaway accumulation",
                { chatId: request.chatId },
              );
              terminalReason = "max-tokens-runaway";
              // interactive break ≈ completed; bg ≈ bgFinishBlocked.
              terminalStatus = isInteractive(mode) ? "completed" : "blocked";
              emit({ type: "run.ending", reason: terminalReason });
              break epochLoop;
            }
            this.pushContinuation(setup, responseText);
            emit({ type: "step.completed", step: stepNo, phase: state.phase });
            continue;
          }
          consecutiveMaxTokens = 0; // reset on every non-(toolless-max_tokens) turn (v1 ~5346)

          // PLANNING: plan-phase transition + goal decomposition (gauntlet #13,#14,#15).
          if (state.phase === AgentPhase.PLANNING) {
            const prevPhase = state.phase;
            const plan = await port.handlePlanPhase({
              mode,
              agentState: state,
              responseText,
              providerName: prepared.currentProvider.name,
              modelId: prepared.currentAssignment.modelId,
              chatId: request.chatId,
              toolCallCount: outcome.response.toolCalls.length,
            });
            state = plan.agentState;
            if (plan.yield) {
              const y = await this.handlePlanYield(bus, clock, io, emit, plan.yield);
              if (y === "blocked") {
                terminalStatus = "blocked";
                terminalReason = "blocked:ask_user";
                break epochLoop;
              }
              // 3.5 plan-review / 3.6 goal-handoff: the interactive run ends cleanly HERE — BEFORE
              // decomposeGoalsIfPlanning below, which would re-run a handed-off goal inline (3.6
              // double-execution). terminalStatus "completed" + a happy reason (in the interactive
              // skip-set) so the resilience adapter renders no spurious abort. The visible text
              // (plan / ack) was already rendered once by handlePlanYield via the show_plan event.
              if (y === "terminate") {
                terminalStatus = "completed";
                terminalReason = plan.yield.kind === "goal_handoff" ? "goal-handoff" : "plan-review";
                emit({ type: "run.ending", reason: terminalReason });
                break epochLoop;
              }
            }
            state = await port.decomposeGoalsIfPlanning({
              agentState: state,
              responseText,
              chatId: request.chatId,
            });
            const pc = phaseChangedEvent(prevPhase, state.phase);
            if (pc) emit(pc);
            emit({ type: "step.completed", step: stepNo, phase: state.phase });
            continue;
          }

          // REFLECTING: parse the model's decision (v1 processReflectionPreamble) → boundary verdict
          // → dispatch (gauntlet #12,#13). The model's own DONE/REPLAN/CONTINUE drives the boundary,
          // not just the control-plane verdict (D1 fix — was hardcoded CONTINUE + always modelProposedDone).
          if (state.phase === AgentPhase.REFLECTING) {
            const prevPhase = state.phase;
            const parsed = await port.parseReflectionDecision({
              agentState: state,
              responseText,
              providerName: prepared.currentProvider.name,
              modelId: prepared.currentAssignment.modelId,
            });
            if (parsed.wasOverride) {
              // v1 (orchestrator.ts ~5437): a heuristic override bumps the reflection-override count.
              state = { ...state, reflectionOverrideCount: state.reflectionOverrideCount + 1 };
            }
            const modelProposedDone =
              parsed.decision === "DONE" || parsed.decision === "DONE_WITH_SUGGESTIONS";
            const reflectionVerdict = ledger.verdict({
              ...this.clockBudgetVerdict(runClock, budget, state),
              taskCancelReason: runClock.taskToken.reason,
              modelProposedDone, // only a DONE decision proposes completion (v1-faithful)
            });
            if (reflectionVerdict.decision === "stop") {
              // Terminators win (rule 2/8) over the reflection extend.
              terminalReason = describeCancelReason(reflectionVerdict.reason);
              terminalStatus = reflectionVerdict.finalize === "hard" ? "failed" : "completed";
              emit({ type: "run.ending", reason: terminalReason });
              break epochLoop;
            }
            const refl = await port.dispatchReflection({
              mode,
              agentState: state,
              decision: parsed.decision,
              responseText,
              chatId: request.chatId,
              session: setup.session,
            });
            state = refl.agentState;
            if (refl.terminal || reflectionVerdict.decision === "done") {
              terminalReason = refl.reason ?? "done";
              emit({ type: "run.ending", reason: terminalReason });
              break epochLoop;
            }
            const pc = phaseChangedEvent(prevPhase, state.phase);
            if (pc) emit(pc);
            emit({ type: "step.completed", step: stepNo, phase: state.phase });
            continue;
          }

          // EXECUTING with tool calls (gauntlet #16,#17,#18,#19,#20,#21,#22).
          if (outcome.response.toolCalls.length > 0) {
            const prevPhase = state.phase;
            for (const tc of outcome.response.toolCalls) {
              emit({ type: "tool.started", toolName: tc.name, toolCallId: tc.id });
            }
            const { trace, advancedState } = await this.executeTools(setup, outcome.response, state);
            for (const tr of trace) {
              toolTrace.push({ toolName: tr.toolName, toolCallId: tr.toolCallId, success: tr.success });
              for (const f of tr.touchedFiles ?? []) touchedFiles.add(f);
              // The learning-bridge sink mirrors tool.finished → "tool:result" (wired on the bus).
              emit({
                type: "tool.finished",
                toolName: tr.toolName,
                toolCallId: tr.toolCallId,
                success: tr.success,
                errorCategory: tr.errorCategory,
                touchedFiles: tr.touchedFiles,
              });
            }
            // PAOR phase transition (the loop is the sole writer of AgentState). The REAL port's
            // tool turn returns the recordStepResultsAndCheckReflection-advanced state; when absent
            // (mock port returns only the trace) the canonical EXECUTING→REFLECTING move applies.
            state = advancedState ?? this.advanceAfterTools(state);
            const pc = phaseChangedEvent(prevPhase, state.phase);
            if (pc) emit(pc);
            emit({ type: "step.completed", step: stepNo, phase: state.phase });
            continue;
          }

          // EXECUTING, no tools → end_turn terminal (gauntlet #16).
          const end = await port.dispatchEndTurn({
            mode,
            agentState: state,
            responseText,
            chatId: request.chatId,
            session: setup.session,
          });
          state = end.agentState;
          emit({ type: "step.completed", step: stepNo, phase: state.phase });
          emit({ type: "run.ending", reason: "end_turn" });
          break epochLoop;
        } // end iteration for

        // ══ Epoch rollover (gauntlet #1,#22; non-interactive only) ════════════════════════
        if (isInteractive(mode)) {
          // 3.4: interactive exhausted its iteration budget (the inner `for` completed without an
          // end_turn/done/stop). v1 (runAgentLoop "Hit max iterations") rendered a "send a follow-up"
          // notice here; emit a distinct terminal so the interactive adapter renders it. terminalStatus
          // stays "completed" (a benign budget-reached end, not a failure) — only an event is added.
          terminalReason = "max-iterations";
          emit({ type: "run.ending", reason: terminalReason });
          break;
        }
        if (!port.canAutoContinueBackgroundEpoch(epoch + 1)) {
          emit({ type: "run.ending", reason: "epoch-budget-exhausted" });
          break;
        }
        epoch++;
        await guardedSleep(bus, clock, 0, { type: "epoch.rolled", epoch });
      } // end epoch while

      // ─── TERMINAL ORDERING (load-bearing, exact sequence) ───────────────────────────────
      // synthesizeFinal → deliverFinal → run.ended, THEN buildResultProjection. persistTerminal +
      // dispose + bus.close moved to the finally so they run on EVERY exit (happy or throw) — see
      // below. deliverFinal still precedes bus.close (the finally runs after this return is computed).
      const final = port.synthesizeFinal(state, mode); // KEEP terminal-text assembly
      io.deliverFinal(final.text, state); // interactive renders / bg+worker no-op
      emit({ type: "run.ended", status: terminalStatus });

      const cancelReason: CancelReason | undefined = runClock.taskToken.reason ?? undefined;
      const proj = port.buildResultProjection({
        state,
        final,
        toolTrace,
        touchedFiles: [...touchedFiles],
        status: terminalStatus,
        reason: terminalReason,
        usage: usageTotal,
        cancelReason,
      });

      return {
        // BY VALUE — kills __workerCollector.
        status: terminalStatus,
        finalText: final.text,
        finalSummary: final.summary,
        reason: terminalReason,
        provider: proj.provider || lastProvider,
        model: proj.model,
        catalogVersion: proj.catalogVersion,
        assignmentVersion: proj.assignmentVersion,
        workspaceId: proj.workspaceId,
        touchedFiles: proj.touchedFiles,
        toolTrace: proj.toolTrace,
        verificationResults: proj.verificationResults,
        reviewFindings: proj.reviewFindings,
        artifacts: proj.artifacts,
        usage: toResultUsage(usageTotal),
        terminalState: state,
        cancelReason,
      };
    } finally {
      // Durability + cleanup on EVERY exit (happy or throw) — v1 did this in its finally
      // (orchestrator.ts:4645-4666). persistTerminal advances session.lastJournalSnapshot;
      // skipping it on a throw corrupts the next turn's prologue. dispose()+close() are idempotent.
      if (setup) {
        try {
          // Read the token reason BEFORE runClock.dispose() (which stamps a benign task-winddown on a
          // still-live token). A benign cancel here flips the recorded metric phase off COMPLETE (v1
          // parity: the bg catch transitions FAILED then the finally records state.phase) so a mid-run
          // /cancel no longer pollutes metrics/learning as a successful completion.
          await port.persistTerminal(state, setup, runClock.taskToken.reason ?? undefined);
        } catch (e) {
          log.warn("[v2-runner] terminal persist failed", { error: e instanceof Error ? e.message : String(e) });
        }
      }
      runClock.dispose();
      await bus.close();
    }
  }

  // ─── VerdictInput assembly: the clock/budget half the spine owns ──────────────────────
  /**
   * The CLOCK/BUDGET half of VerdictInput, queried every gate tick. The taskCancelReason is read
   * from clock.taskToken.reason (rule 1/1b — authoritative even between ticks). callers that
   * carry a failure contribution override taskCancelReason/callStalled on top of this base.
   */
  private clockBudgetVerdict(clock: RunClock, budget: Budget, state: AgentState): VerdictInput {
    const tokensOut = budget.remainingOutputTokens() <= 0;
    const costOut = budget.remainingCostUsd() <= 0;
    return {
      taskCancelReason: clock.taskToken.reason,
      hardTimeoutBlown: clock.hardTaskExpired(),
      hardTimeoutScope: "task", // call-scope hard fires via the token → taskCancelReason
      resourceExhausted: tokensOut ? "tokens" : costOut ? "cost" : false,
      taskInactivityExceeded: clock.silenceCeilingExceeded(),
      callStalled: false,
      modelProposedDone: false,
      reflectionWantsExtend: false,
      loopDetectionBlocked: state.loopDetectionBlocked,
    };
  }

  // ─── handleYield — the single owner of every wait (emits before AND after) ────────────
  /**
   * All backoff sleeps + ask_user route through here. Every wait goes through guardedSleep, whose
   * beat event is emitted BEFORE the timer arms (the heartbeat invariant). Background ask_user
   * YIELDS "blocked" (does NOT block; the bus does NOT auto-handle it).
   */
  private async handleYield(
    bus: AgentRunEventBus,
    clock: Clock,
    io: IOStrategy,
    emit: (e: Parameters<AgentRunEventBus["emit"]>[0]) => number,
    verdict: RunVerdict,
    backoffMs?: number,
  ): Promise<"continue" | "blocked"> {
    switch (verdict.decision) {
      case "retry": {
        const ms = backoffMs ?? verdict.backoffMs;
        await guardedSleep(bus, clock, ms, {
          type: "backoff",
          ms,
          reason: verdict.guidance ?? "retry",
        });
        return "continue";
      }
      case "pause": {
        // Recoverable: the call was already dropped (call.leave in the finally); retry under a
        // fresh scope next iteration. Emit a heartbeat so there is no silent spin.
        await guardedSleep(bus, clock, backoffMs ?? 0, { type: "heartbeat", source: "loop-yield" });
        return "continue";
      }
      case "ask_user": {
        if (isInteractive(io.mode)) {
          emit({ type: "ask_user", question: verdict.reason, visibleText: verdict.reason });
          await guardedSleep(bus, clock, verdict.backoffMs, {
            type: "heartbeat",
            source: "loop-yield",
          });
          return "continue";
        }
        // BACKGROUND ask_user → YIELD "blocked".
        emit({ type: "ask_user", question: verdict.reason, visibleText: verdict.reason });
        emit({ type: "run.ending", reason: "blocked:ask_user" });
        return "blocked";
      }
      default:
        return "continue";
    }
  }

  /** Route a plan-phase yield (show_plan emit+continue / ask_user interactive emit / bg block). */
  private async handlePlanYield(
    bus: AgentRunEventBus,
    clock: Clock,
    io: IOStrategy,
    emit: (e: Parameters<AgentRunEventBus["emit"]>[0]) => number,
    y: PlanPhaseYield,
  ): Promise<"continue" | "blocked" | "terminate"> {
    if (y.kind === "show_plan") {
      emit({ type: "show_plan", visibleText: y.visibleText });
      await guardedSleep(bus, clock, 0, { type: "heartbeat", source: "loop-yield" });
      return "continue";
    }
    // Interactive PLANNING terminal divergences (cutover Step 3 / 3.5 plan-review + 3.6 goal-handoff):
    // the port already decided to present a plan for review OR hand the goal to a background task.
    // Render the visible text ONCE — reuse the show_plan event (the interactive onEvent adapter renders
    // it verbatim; the port did NOT render it) — then signal the spine to TERMINATE the run.
    if (y.kind === "plan_review" || y.kind === "goal_handoff") {
      emit({ type: "show_plan", visibleText: y.visibleText });
      return "terminate";
    }
    // ask_user from the plan phase.
    emit({ type: "ask_user", question: y.question, visibleText: y.visibleText });
    if (isInteractive(io.mode)) {
      await guardedSleep(bus, clock, 0, { type: "heartbeat", source: "loop-yield" });
      return "continue";
    }
    emit({ type: "run.ending", reason: "blocked:ask_user" });
    return "blocked";
  }

  // ─── intentAck — the ≤2s ack contract (§6) ────────────────────────────────────────────
  /**
   * Fast path: the port's classifier resolves a summary. Fallback: a 2s guardedSleep races, and
   * if no fast summary landed the first clause of the prompt is used. Idempotent: the first
   * intent.ack emitted wins (the bus appends in order; consumers dedupe on `type`).
   */
  private async intentAck(
    bus: AgentRunEventBus,
    clock: Clock,
    port: OrchestratorPort,
    request: AgentRunRequest,
  ): Promise<void> {
    const summary = await Promise.race([
      port.classifyIntent(request.prompt).catch(() => firstClause(request.prompt)),
      (async () => {
        await guardedSleep(bus, clock, 2000, { type: "heartbeat", source: "loop-yield" });
        return firstClause(request.prompt);
      })(),
    ]);
    bus.emit({ type: "intent.ack", summary });
  }

  // ─── small spine-local glue (NO v1 logic — pure shape adapters) ───────────────────────

  private toSetupInput(request: AgentRunRequest, mode: RunnerMode): AgentRunSetupInput {
    return {
      prompt: request.prompt,
      chatId: request.chatId,
      channelType: String(request.channelType),
      userId: request.userId,
      conversationId: request.conversationId,
      attachments: request.attachments,
      userContent: request.userContent,
      mode,
      interactiveSession: request.interactiveSession,
      assignedProvider: request.assignedProvider,
      assignedModel: request.assignedModel,
      taskRunId: request.taskRunId,
      parentMetricId: request.parentMetricId,
      onUsage: request.onUsage,
      workspaceLease: request.workspaceLease,
      workspaceLeaseRetained: request.workspaceLeaseRetained,
      goalContext: request.goalContext,
    };
  }

  private budgetCheckpoint(
    request: AgentRunRequest,
    budget: Budget,
  ): { taskId: string; chatId: string; lastUserMessage: string; used: number; budget: number } {
    return {
      taskId: request.taskRunId ?? request.chatId,
      chatId: request.chatId,
      lastUserMessage: request.prompt,
      used: 0,
      budget: budget.remainingOutputTokens(),
    };
  }

  private traceParams(
    request: AgentRunRequest,
    prepared: PreparedIteration,
    state: AgentState,
    setup: RunSetup,
  ): RecordExecutionTraceParams {
    return {
      chatId: request.chatId,
      identityKey: setup.identityKey,
      assignment: prepared.currentAssignment,
      phase: PHASE_TRACE_MAP[state.phase] ?? "executing",
      task: prepared.executionStrategy.task,
      taskRunId: request.taskRunId,
    };
  }

  /**
   * max_tokens continuation: push the partial text back + the continuation gate so the next turn
   * resumes where the model was truncated. Routes through the v1 free helper
   * `pushContinuationMessages` + `MAX_TOKENS_CONTINUATION_GATE` (the same gate v1 injects).
   */
  private pushContinuation(setup: RunSetup, responseText: string): void {
    pushContinuationMessages(
      {
        responseText,
        session: setup.session as { messages: Array<{ role: string; content: string | unknown[] }> },
      },
      MAX_TOKENS_CONTINUATION_GATE,
    );
  }

  /**
   * Tool execution. DELEGATES the entire v1 tool turn to the port's bound executeToolCalls (the
   * REAL port runs executeAndTrackTools → controlLoopTracker.markToolExecution → consensus →
   * recordStepResultsAndCheckReflection → content-block append → refreshMemoryIfNeeded, returning
   * `{ trace, advancedState }`). The MOCK port returns only the trace array; this method normalizes
   * BOTH shapes so the V2 unit tests (mock) and the real port both work. The spine stays the sole
   * writer of AgentState — it applies `advancedState` when the port supplied one.
   */
  private async executeTools(
    setup: RunSetup,
    response: ProviderResponse,
    state: AgentState,
  ): Promise<{
    trace: {
      toolName: string;
      toolCallId: string;
      success: boolean;
      errorCategory?: string;
      touchedFiles?: readonly string[];
    }[];
    advancedState?: AgentState;
  }> {
    const port = this.deps.orchestratorPort;
    // The port's executeToolCalls is the existing ExecuteToolCallsFn seam (variadic). We pass the
    // tool calls, the session, the live AgentState (the real port reads the 3rd arg to drive
    // recordStepResultsAndCheckReflection), AND response.text as the 4th arg (D2 fix: the port pushes
    // it onto the session before the tool results, v1 parity); the mock ignores extra args.
    const raw = (await port.executeToolCalls(
      response.toolCalls,
      setup.session,
      state,
      response.text,
    )) as
      | {
          toolName: string;
          toolCallId: string;
          success: boolean;
          errorCategory?: string;
          touchedFiles?: readonly string[];
        }[]
      | {
          trace: {
            toolName: string;
            toolCallId: string;
            success: boolean;
            errorCategory?: string;
            touchedFiles?: readonly string[];
          }[];
          advancedState?: AgentState;
        }
      | undefined;

    if (Array.isArray(raw)) return { trace: raw };
    if (raw && typeof raw === "object" && "trace" in raw) {
      return { trace: raw.trace ?? [], advancedState: raw.advancedState };
    }
    return { trace: [] };
  }

  /**
   * PAOR phase transition after a tool turn — the FALLBACK applied only when the port did not
   * return an advanced state (the mock port). The canonical EXECUTING→REFLECTING move keeps the
   * loop progressing toward a reflection boundary. The REAL port supplies
   * recordStepResultsAndCheckReflection's returned state instead (see executeTools).
   */
  private advanceAfterTools(state: AgentState): AgentState {
    if (state.phase === AgentPhase.EXECUTING) {
      return { ...state, phase: AgentPhase.REFLECTING, iteration: state.iteration + 1 };
    }
    return state;
  }
}
