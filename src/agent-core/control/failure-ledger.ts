/**
 * Agent Core v2 — Control Plane: FailureLedger + the verdict algorithm (ARCHITECTURE §2.4–§2.5).
 *
 * The single owner of "continue / retry / ask / pause / stop / done, and why." Subsumes v1's
 * triplicated state: the loop's `consecutiveProviderFailures` (deleted), the kept
 * `IterationHealthTracker` (the implementation core, injected here as {@link HealthCore}), and
 * coordinates with the kept `ProviderHealthRegistry` (subordinate — per-provider recovery vs
 * per-task termination) via the typed signals so they cannot disagree. One instance per run.
 *
 * The verdict precedence IS the explicit arbiter v1 lacked: the DONE→CONTINUE reflection
 * override is consulted ONLY after the terminators (hard timeout / resource / inactivity /
 * health-abort) have run, so it can only extend an otherwise-healthy, in-budget run.
 */

import type { CancelReason, ScopeLevel } from "./cancel-reason.js";
import { isBenign } from "./cancel-reason.js";

/**
 * What the kept v1 `IterationHealthTracker` provides. Injected (not imported) so this module
 * is testable in isolation; Phase 1 wires the real tracker behind this interface.
 */
export interface HealthCore {
  recordSuccess(): void;
  recordFailure(): void;
  /** ≥80% failure rate AND ≥5 consecutive failures. */
  shouldAbort(): boolean;
  /** 3 consecutive failures OR ≥40% failure rate. */
  shouldAskUser(): boolean;
  backoffMs(): number;
  readonly statusLevel: string;
  readonly failureRate: number;
  readonly consecutive: number;
}

/**
 * Everything the verdict needs, assembled by the loop each gate tick by querying the
 * RunClock / Budget and the last step's outcome. Keeping verdict() pure of clock/budget
 * refs makes the precedence trivially testable.
 */
export interface VerdictInput {
  /** The TASK token's reason if it is aborted; else null. (Call-level aborts arrive via `callStalled`.) */
  readonly taskCancelReason: CancelReason | null;
  readonly hardTimeoutBlown: boolean; // call OR task wall-clock ceiling reached
  readonly hardTimeoutScope: ScopeLevel;
  readonly resourceExhausted: false | "tokens" | "cost";
  readonly taskInactivityExceeded: boolean; // the §2.3 silence accumulator ceiling
  readonly callStalled: boolean; // the last call ended on a provider-stall
  readonly modelProposedDone: boolean; // the last step's model output declared completion
  readonly reflectionWantsExtend: boolean; // from the KEPT validateReflectionDecision
  readonly loopDetectionBlocked: boolean; // the KEPT v1 runaway-bug guard
}

export type RunVerdict =
  | { decision: "continue" }
  | { decision: "retry"; backoffMs: number; guidance?: string }
  | { decision: "ask_user"; backoffMs: number; reason: string }
  | { decision: "pause"; reason: CancelReason } // recoverable: drop this call, retry under a fresh scope
  | { decision: "stop"; reason: CancelReason; finalize: "graceful" | "hard" }
  // Clean, model-declared completion that the arbiter HONORED. Distinct from `stop`
  // (which carries a CancelReason) because a completion is not a cancellation.
  | { decision: "done"; finalize: "graceful" };

export interface FailureLedger {
  recordSuccess(provider: string, kind: "real" | "probe"): void;
  recordFailure(provider: string, benign: boolean): void;
  verdict(input: VerdictInput): RunVerdict;
  readonly health: { statusLevel: string; failureRate: number; consecutive: number };
}

class FailureLedgerImpl implements FailureLedger {
  private pauseRetryUsed = 0;

  constructor(
    private readonly core: HealthCore,
    private readonly pauseRetryBudget: number,
  ) {}

  recordSuccess(_provider: string, kind: "real" | "probe"): void {
    // A REAL response resets the task failure run; a mere health PROBE success is the
    // ProviderHealthRegistry's concern and must NOT reset task-level failure accounting.
    if (kind === "real") this.core.recordSuccess();
  }

  recordFailure(_provider: string, benign: boolean): void {
    if (benign) return; // benign (control-plane) cancels never poison health
    this.core.recordFailure();
  }

  get health(): { statusLevel: string; failureRate: number; consecutive: number } {
    return {
      statusLevel: this.core.statusLevel,
      failureRate: this.core.failureRate,
      consecutive: this.core.consecutive,
    };
  }

  verdict(input: VerdictInput): RunVerdict {
    // Deterministic precedence (§2.5), top-down, first match wins.

    // 1. Benign cancel — never counted as a failure.
    if (input.taskCancelReason !== null && isBenign(input.taskCancelReason)) {
      return { decision: "stop", reason: input.taskCancelReason, finalize: "graceful" };
    }
    // 1b. Any OTHER task-token abort is AUTHORITATIVE: the token is already aborted, so the
    //     run must stop regardless of whether the loop's derived booleans (rules 2–4) have
    //     caught up to the timer that aborted it. Self-defending, not contract-dependent —
    //     a between-tick hard-timeout fire can never be lost to a stale `remainingTaskMs`.
    if (input.taskCancelReason !== null) {
      return { decision: "stop", reason: input.taskCancelReason, finalize: "graceful" };
    }
    // 2. Hard wall-clock blown — OVERRIDES the reflection override (rule 8). Kills the 3h27m runaway.
    if (input.hardTimeoutBlown) {
      return {
        decision: "stop",
        reason: { kind: "hard-timeout", scope: input.hardTimeoutScope },
        finalize: "graceful",
      };
    }
    // 3. Resource exhausted (output tokens or cost).
    if (input.resourceExhausted !== false) {
      return {
        decision: "stop",
        reason: { kind: "budget-exhausted", resource: input.resourceExhausted },
        finalize: "graceful",
      };
    }
    // 4. Task-inactivity accumulator ceiling — kills the ~70min stall + the delegation livelock.
    if (input.taskInactivityExceeded) {
      return { decision: "stop", reason: { kind: "task-inactivity" }, finalize: "graceful" };
    }
    // 5. Health abort (≥80% rate AND ≥5 consecutive). Subsumes v1's #8 breaker.
    if (this.core.shouldAbort()) {
      return { decision: "stop", reason: { kind: "verdict-stop", cause: "health" }, finalize: "hard" };
    }
    // 6. Per-task pause→retry budget for call-level stalls (bounded; the livelock backstop).
    if (input.callStalled) {
      if (this.pauseRetryUsed < this.pauseRetryBudget) {
        this.pauseRetryUsed += 1;
        return { decision: "pause", reason: { kind: "provider-stall", scope: "call" } };
      }
      return {
        decision: "stop",
        reason: { kind: "provider-stall", scope: "task" },
        finalize: "graceful",
      };
    }
    // 7. Health ask_user / retry. (Phase 1 routes the reason/guidance text through v1's
    //    centralized, i18n-aware message formatter; the literals here are placeholders.)
    if (this.core.shouldAskUser()) {
      return {
        decision: "ask_user",
        backoffMs: this.core.backoffMs(),
        reason: "Repeated provider failures — manual guidance requested.",
      };
    }
    // A stale single failure must not force a retry when the model has signaled completion —
    // defer to rule 8 (the success about to be recorded would clear `consecutive` anyway).
    if (this.core.consecutive > 0 && !input.modelProposedDone) {
      return {
        decision: "retry",
        backoffMs: this.core.backoffMs(),
        guidance: "Previous step failed; retrying with backoff.",
      };
    }
    // 8. Reflection arbitration — the #7-vs-terminators tie-break, gated BEHIND rules 2–5.
    if (input.modelProposedDone) {
      // The runaway-bug guard is set: suppress the extend-override and honor DONE.
      if (input.loopDetectionBlocked) {
        return { decision: "done", finalize: "graceful" };
      }
      // Otherwise the override may extend an otherwise-healthy, in-budget run.
      if (input.reflectionWantsExtend) {
        return { decision: "continue" };
      }
      return { decision: "done", finalize: "graceful" };
    }
    // 9. Default.
    return { decision: "continue" };
  }
}

export function createFailureLedger(
  core: HealthCore,
  opts: { pauseRetryBudget: number },
): FailureLedger {
  return new FailureLedgerImpl(core, opts.pauseRetryBudget);
}
