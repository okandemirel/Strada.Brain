/**
 * Agent Core v2 — V2AgentRunner: contract + skeleton (ARCHITECTURE §4.1, §5–§7).
 *
 * ⚠️ NEXT INCREMENT — CONTRACT + SKELETON ONLY. `run()` is intentionally NOT implemented here;
 * it throws so no caller can route to a half-built loop. The full unified `AgentLoop` spine
 * lands in the next increment. This file exists so the next implementer inherits the exact
 * contract, the dependency shape, and the load-bearing step order as compile-checked TODOs.
 *
 * There is no new `V2AgentRunner` *interface* — the symbol is the CLASS
 * `V2AgentRunner implements AgentRunner` (the already-frozen façade in agent-runner.ts) whose
 * `run()` executes the unified spine. `WorkerRunResult` stays a pure projection of the existing
 * `AgentRunResult`.
 *
 * PURELY ADDITIVE: nothing in v1 imports this yet.
 *
 * ── How the single loop is parameterized (exactly two axes, never a forked control flow) ──
 *  1. io: IOStrategy (the shipped interface) — io.mode selects the policy; io.onEvent is the
 *     heartbeat sink (a bus LiveSink adapter); io.visibleSink is the optional token sink
 *     (Phase 5); io.deliverFinal is the terminal-render divergence; io.externalSignal IS the
 *     task token.
 *  2. The control-plane policy derived from io.mode — resolveRunBudgetPolicy(mapMode(io.mode),
 *     seed) → openRunClock(clock, policy).
 *
 * The outer epoch `while` exists ONLY when io.mode !== "interactive" (interactive is the
 * degenerate single-epoch case). Epoch rollover, backoff sleeps, and ask_user all flow through
 * handleYield, which emits before AND after it sleeps/rolls (via guardedSleep) — no silent spin.
 * ask_user in background → the loop YIELDS (AgentRunResult.status = "blocked"); it does not
 * block, and the bus does not "auto-handle" it.
 *
 * ── Control-plane objects consumed (NEXT increment) ──
 * The spine reads as the digest via a thin `ControlPlane` assembler (control/control-plane.ts,
 * added next) that bundles the SHIPPED surface (openRunClock + FailureLedger + Budget +
 * resolveRunBudgetPolicy) plus openBus(io):
 *   interface ControlPlane {
 *     openRun(mode, parentClockView?): { clock: RunClock; ledger: FailureLedger; budget: Budget };
 *     openBus(runId, io, parentRunId?): AgentRunEventBus; // adds io's sinks + ring buffer
 *   }
 *  - ledger.verdict(VerdictInput) → RunVerdict is the GATE before any step AND the reflection-
 *    boundary check; the reflection DONE→CONTINUE override stays gated behind the terminators
 *    (verdict precedence, §2.5 rule 8 — already in failure-ledger.ts).
 *  - clock.enterCall(deriveCallLimits()) → CallScope (subtractive-min carve); call.leave() after.
 *  - budget.debit(outcome.usage) — sampled accounting.
 *  - The loop is the SOLE writer of AgentState; it reads health/capability state, never writes it.
 *
 * ── The gauntlet step order it reproduces ONCE (the two v1 loops run the same ordered
 *    gauntlet; V2 reproduces it once, background's outer epoch being the non-interactive
 *    wrapper). Per-iteration order (the Step body), mapped to the spine: ──
 *   1.  Epoch/iteration setup (non-interactive only).
 *   2.  Live budget re-read → verdict GATE input.
 *   3.  prepareIteration → inside assembleStepContext.
 *   4.  Context-window trim (non-interactive) → inside assembleStepContext.
 *   5.  Session compaction — maybeCompactSession → inside assembleStepContext.
 *   6.  Task-aware provider build (FallbackChain owns selection) → provider → gateway.
 *   7.  The provider call → ModelGateway.call(...) (the collapse point; silentStream frozen).
 *   8.  Provider-failure THROW → caught INSIDE TurnStep → StepOutcome variant; verdict GATE
 *       arbitrates (applyInteractiveVerdict/applyBackgroundVerdict → one handleYield).
 *   9.  Success accounting + execution trace → budget.debit + model.call.finished.
 *   10. Token-budget enforcement → a stop verdict reason owned by Budget.
 *   11. Empty-response resilience → gateway computes `empty` once; verdict GATE decides.
 *   12. max_tokens continuation — pushContinuationMessages → a continue StepOutcome.
 *   13. REFLECTING handling — processReflectionPreamble (validateReflectionDecision +
 *       MAX_REFLECTION_OVERRIDES) + checkPendingBlocks → reflection-boundary second verdict (8).
 *   14. Goal detection in PLANNING (interactive) → PLANNING StepOutcome yielding to Planner.
 *   15. Plan-review / autonomous plan — handlePlanPhaseTransition → show_plan/ask_user
 *       (background ask_user → yield "blocked").
 *   16. end_turn / no-tool terminal — handleInteractiveEndTurn/handleBgEndTurn → outcome "ended".
 *   17. PAOR phase transitions — transitionPhase (loop is sole writer) inside applyOutcome.
 *   18. Tool execution — executeAndTrackTools → tool.started/tool.finished (learning-bridge pt).
 *   19. Consensus — runConsensusIfAvailable.
 *   20. Record step results + reflection check — recordStepResultsAndCheckReflection → applyOutcome.
 *   21. Append tool results — buildToolResultContentBlocks.
 *   22. Memory refresh — refreshMemoryIfNeeded.
 *
 * ── Post-loop terminal ordering (load-bearing) ──
 *   synthesizeFinal → io.deliverFinal → emit(run.ended) → await persistTerminal (joined HERE;
 *   fire-and-forget-with-barrier kicked at run.ending, NOT before deliverFinal) → clock.dispose()
 *   → return buildAgentRunResult(...) by value (kills __workerCollector).
 *
 * ── KEEP helpers consumed (called, not rewritten) ──
 *   orchestrator-loop-utils.ts: buildPhasePromptSection, processReflectionPreamble,
 *     handlePlanPhaseTransition, recordStepResultsAndCheckReflection, buildToolResultContentBlocks.
 *   orchestrator-loop-shared.ts: executeAndTrackTools, refreshMemoryIfNeeded,
 *     runConsensusIfAvailable, checkPendingBlocks, pushContinuationMessages,
 *     MAX_TOKENS_CONTINUATION_GATE.
 *   session-compaction.ts (via maybeCompactSession). agent-state: transitionPhase,
 *     VALID_TRANSITIONS, validateReflectionDecision, MAX_REFLECTION_OVERRIDES. Resilience:
 *     IterationHealthTracker, isEmptyProviderResponse, FailureLedger.verdict. On
 *     this/orchestrator: prepareIteration, silentStream (frozen, via gateway),
 *     buildTaskAwareProvider, recordProviderUsage, reflection/end-turn handlers, goal
 *     decomposition, saveBudgetExceededCheckpoint.
 */

import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
  IOStrategy,
  RunnerMode,
} from "./agent-runner.js";
import type { RunMode } from "../control/policy.js";
import type { ModelGateway } from "../model/model-gateway.js";

/**
 * Dependencies threaded into the V2 runner. The thin `ControlPlane` assembler + the bound KEEP
 * orchestrator methods land with the spine in the next increment; typed loosely here so the
 * skeleton compiles without fabricating modules that do not yet exist.
 */
export interface V2RunnerDeps {
  /** The thin ControlPlane assembler (control/control-plane.ts, added next increment). */
  readonly controlPlane: unknown;
  readonly gateway: ModelGateway;
  /** The bound KEEP methods (prepareIteration, handlers, provider build, helpers, persist, …). */
  readonly orchestratorPort: unknown;
}

/**
 * RunnerMode → RunMode. `"worker"` ≡ `"delegate"` (the structured-result background variant);
 * the other three names map 1:1.
 */
export function mapMode(m: RunnerMode): RunMode {
  return m === "worker" ? "delegate" : m;
}

export class V2AgentRunner implements AgentRunner {
  constructor(private readonly deps: V2RunnerDeps) {
    // deps are retained for the next-increment spine; referenced here to satisfy strict TS.
    void this.deps;
  }

  /**
   * NOT IMPLEMENTED — see the file header for the full contract, the two parameterization
   * axes, the 22-step gauntlet order, the post-loop terminal ordering, and the KEEP-helper
   * inventory. The spine lands in the next increment. Throwing here is deliberate: nothing in
   * v1 routes to V2 yet, and a half-built loop must never run.
   */
  run(_request: AgentRunRequest, _io: IOStrategy): Promise<AgentRunResult> {
    throw new Error(
      "V2AgentRunner.run is not implemented yet — Phase 2 foundations only " +
        "(EventBus + ModelGateway). The unified AgentLoop spine lands in the next increment; " +
        "see this file's header for the full contract and step order.",
    );
  }
}
