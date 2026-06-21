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
import { describeCancelReason } from "../control/cancel-reason.js";
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

/** The first clause of the prompt — the ack fallback when no classifier resolves in time. */
function firstClause(prompt: string): string {
  const trimmed = prompt.trim();
  const cut = trimmed.search(/[.!?\n]/);
  const clause = (cut === -1 ? trimmed : trimmed.slice(0, cut)).trim();
  return clause.length > 0 ? clause.slice(0, 120) : "Working on your request.";
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

export class V2AgentRunner implements AgentRunner {
  constructor(private readonly deps: V2RunnerDeps) {}

  async run(request: AgentRunRequest, io: IOStrategy): Promise<AgentRunResult> {
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

    const setup = await port.setupRun(this.toSetupInput(request, mode));
    // The loop is the sole writer of AgentState; every mode seeds the same initial PLANNING state
    // (interactive vs background differ only via IOStrategy + policy, never the state machine).
    let state: AgentState = createInitialState(request.prompt);

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
          const contrib = port.classifyFailureForVerdict({
            kind: outcome.kind === "threw" ? "throw" : "empty",
            provider: prepared.currentProvider.name,
            error: outcome.kind === "threw" ? outcome.error : undefined,
            response: outcome.kind === "empty" ? outcome.response : undefined,
            failedCallReason: call.token.reason, // carried, never inferred
          });
          const failVerdict = ledger.verdict({
            ...this.clockBudgetVerdict(runClock, budget, state),
            taskCancelReason: runClock.taskToken.reason ?? contrib.taskCancelReason,
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

        // max_tokens continuation (gauntlet #12).
        if (outcome.response.stopReason === "max_tokens") {
          this.pushContinuation(setup, responseText);
          emit({ type: "step.completed", step: stepNo, phase: state.phase });
          continue;
        }

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
          });
          state = plan.agentState;
          if (plan.yield) {
            const y = await this.handlePlanYield(bus, clock, io, emit, plan.yield);
            if (y === "blocked") {
              terminalStatus = "blocked";
              terminalReason = "blocked:ask_user";
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

        // REFLECTING: reflection-boundary verdict → dispatch (gauntlet #12,#13).
        if (state.phase === AgentPhase.REFLECTING) {
          const prevPhase = state.phase;
          const reflectionVerdict = ledger.verdict({
            ...this.clockBudgetVerdict(runClock, budget, state),
            taskCancelReason: runClock.taskToken.reason,
            modelProposedDone: true, // a reflection turn is the model proposing a completion decision
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
            decision: "CONTINUE", // the port maps the model's parsed decision; spine consumes state
            wasOverride: reflectionVerdict.decision === "continue",
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
          const results = await this.executeTools(setup, outcome.response);
          for (const tr of results) {
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
          // PAOR phase transition (the loop is the sole writer of AgentState).
          state = this.advanceAfterTools(state);
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
      if (isInteractive(mode)) break;
      if (!port.canAutoContinueBackgroundEpoch(epoch + 1)) {
        emit({ type: "run.ending", reason: "epoch-budget-exhausted" });
        break;
      }
      epoch++;
      await guardedSleep(bus, clock, 0, { type: "epoch.rolled", epoch });
    } // end epoch while

    // ─── TERMINAL ORDERING (load-bearing, exact sequence) ───────────────────────────────
    // persistTerminal kicked HERE (at run.ending, NOT before deliverFinal), runs CONCURRENTLY.
    const persistP = port.persistTerminal(state, setup); // fire-and-forget-with-barrier
    const final = port.synthesizeFinal(state, mode); // KEEP terminal-text assembly
    io.deliverFinal(final.text, state); // interactive renders / bg+worker no-op
    emit({ type: "run.ended", status: terminalStatus });
    await persistP; // JOINED here (durability before return)
    runClock.dispose(); // fans out abort to stragglers
    await bus.close(); // drain + close sinks (bounded)

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
  ): Promise<"continue" | "blocked"> {
    if (y.kind === "show_plan") {
      emit({ type: "show_plan", visibleText: y.visibleText });
      await guardedSleep(bus, clock, 0, { type: "heartbeat", source: "loop-yield" });
      return "continue";
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
      mode,
      interactiveSession: request.interactiveSession,
      assignedProvider: request.assignedProvider,
      assignedModel: request.assignedModel,
      taskRunId: request.taskRunId,
      parentMetricId: request.parentMetricId,
      onUsage: request.onUsage,
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
    const phaseMap: Record<string, RecordExecutionTraceParams["phase"]> = {
      [AgentPhase.PLANNING]: "planning",
      [AgentPhase.EXECUTING]: "executing",
      [AgentPhase.REFLECTING]: "reflecting",
      [AgentPhase.REPLANNING]: "replanning",
    };
    return {
      chatId: request.chatId,
      identityKey: setup.identityKey,
      assignment: prepared.currentAssignment,
      phase: phaseMap[state.phase] ?? "executing",
      task: prepared.executionStrategy.task,
      taskRunId: request.taskRunId,
    };
  }

  /**
   * max_tokens continuation: push the partial text back into the session so the next turn picks
   * up where the model was truncated. STUBBED minimally — the rich continuation (the v1
   * pushContinuationMessages helper + MAX_TOKENS_CONTINUATION_GATE) is a free helper wired in the
   * route-flip increment; here we keep the transcript advancing so the loop never stalls.
   * TODO(route-flip): replace with the imported pushContinuationMessages free helper.
   */
  private pushContinuation(setup: RunSetup, responseText: string): void {
    if (responseText) {
      setup.session.messages.push({ role: "assistant", content: responseText });
    }
    setup.session.messages.push({ role: "user", content: "Continue." });
  }

  /**
   * Tool execution. DELEGATES to the port's bound executeToolCalls via the free executeAndTrackTools
   * helper in the route-flip increment; the spine accumulates the trace as events fly. STUBBED here
   * to call the port's bound executor directly and normalize its result into the trace shape — the
   * full executeAndTrackTools wiring (consensus, recordStepResults, content-block append, memory
   * refresh) is the route-flip increment's job.
   * TODO(route-flip): route through executeAndTrackTools + runConsensusIfAvailable +
   *   recordStepResultsAndCheckReflection + buildToolResultContentBlocks + refreshMemoryIfNeeded.
   */
  private async executeTools(
    setup: RunSetup,
    response: ProviderResponse,
  ): Promise<
    {
      toolName: string;
      toolCallId: string;
      success: boolean;
      errorCategory?: string;
      touchedFiles?: readonly string[];
    }[]
  > {
    const port = this.deps.orchestratorPort;
    const raw = (await port.executeToolCalls(response.toolCalls, setup.session)) as
      | {
          toolName: string;
          toolCallId: string;
          success: boolean;
          errorCategory?: string;
          touchedFiles?: readonly string[];
        }[]
      | undefined;
    return raw ?? [];
  }

  /**
   * PAOR phase transition after a tool turn. The full transition logic
   * (recordStepResultsAndCheckReflection → transitionPhase) is the route-flip increment's job; here
   * the spine performs the canonical EXECUTING→REFLECTING move so the loop keeps progressing toward
   * a reflection boundary (the sole writer of AgentState is the loop).
   * TODO(route-flip): replace with recordStepResultsAndCheckReflection's returned state.
   */
  private advanceAfterTools(state: AgentState): AgentState {
    if (state.phase === AgentPhase.EXECUTING) {
      return { ...state, phase: AgentPhase.REFLECTING, iteration: state.iteration + 1 };
    }
    return state;
  }
}
