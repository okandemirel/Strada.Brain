/**
 * Agent Core v2 — Phase 1a: the pure RunVerdict → loop-action mapping.
 *
 * Rule (c) of the Phase-1a plan keeps ALL decision logic out of orchestrator.ts. The
 * orchestrator's failure loops only need to know, for a given {@link RunVerdict}: do I
 * `continue`, leave the loop (`break`/`return`), and which user-facing notice + backoff to
 * apply. This module computes exactly that, leaving the side-effect *execution* (pushing
 * guidance into the session, emitting progress, calling `finish`) to thin orchestrator
 * helpers — those statements are v1's own and stay in v1's file unchanged.
 *
 * In Phase 1a the four failure insertion points pass INERT VerdictInput for the three
 * not-yet-shipped concerns (runClock / silenceAccumulator / typedCancelReason), so the only
 * reachable decisions are: retry (rule 9), ask_user (rule 7), stop/verdict-stop (rule 5),
 * continue (default), and done (rule 10, unreachable from a failure site because
 * modelProposedDone is always false there). This mapper is total over RunVerdict anyway so it
 * survives 1b–1d unchanged.
 *
 * INTENDED behavior change on flag-ON (PLAN.md 1a: "audit the delta, not assumed-equivalent").
 * v1 had TWO divergent failure mechanisms: the EMPTY-response gate (IterationHealthTracker —
 * backoff + ask_user + abort) and the THROW gate (a separate consecutive counter + an
 * evaluateProviderFailure guidanceMessage, with NO per-failure backoff/ask_user). Routing BOTH
 * through the one FailureLedger (the v2 "one owner per concern" goal) consolidates the THROW
 * gate into the health model: flag-ON therefore ADDS health-driven backoff/ask_user to throws
 * and emits resilience-message notices instead of v1's guidanceMessage. The 3-consecutive-ask /
 * 5-consecutive-abort thresholds ARE preserved; only the per-failure backoff/notice surface is
 * unified. This is NOT v1-identical at the THROW sites — it is gated default-OFF and is
 * equivalence-verified per route before any flag flip (Phases 2+), never silently shipped live.
 */
import type { RunVerdict } from "./failure-ledger.js";

/**
 * How a failure-decision site terminates after a verdict. `terminal` distinguishes the two
 * loop shapes:
 *  - background EMPTY abort = hard stop via `finish(...)` → the orchestrator does `return`.
 *  - interactive abort, and background THROW abort = leave the loop → the orchestrator does `break`.
 * The site supplies which terminal style applies; the mapper just reports `stop`.
 */
export type LoopActionControl = "continue" | "break" | "return";

/** Which user-facing notice the site should emit before acting (maps to v1's resilience keys). */
export type LoopActionNotice =
  | "none"
  /** Health-context + provider_slow/provider_failing by statusLevel, then retry. */
  | "retry"
  /** provider_ask_user — informational only in 1a (no real pause), then retry. */
  | "ask_user"
  /** provider_abort — terminal. */
  | "abort";

export interface LoopAction {
  readonly control: LoopActionControl;
  readonly notice: LoopActionNotice;
  /** Delay to await before retrying (0 = none). Only meaningful for `continue` actions. */
  readonly backoffMs: number;
}

/**
 * Map a {@link RunVerdict} to the loop action a failure site should take.
 *
 * @param verdict             the ledger's decision.
 * @param abortControl        how this site leaves the loop on a terminal stop:
 *                            `"return"` (background EMPTY) or `"break"` (interactive / bg THROW).
 *
 * Faithfulness notes (Phase 1a):
 *  - `ask_user` is INFORMATIONAL: emit the notice, optionally back off, then `continue`. v1's
 *    ask_user never actually paused for the user (it only emitted a status message), so a real
 *    pause here would be a behavior change — deliberately deferred.
 *  - `pause` cannot occur in 1a (callStalled is always false → rule 6 dead). Mapped defensively
 *    to a back-off + `continue` so the function stays total; it is unreachable at the 1a sites.
 *  - `done` cannot occur from a failure site in 1a (modelProposedDone always false). Mapped to a
 *    plain `continue` for completeness; the model-done/reflection path is untouched by 1a.
 */
export function mapVerdictToLoopAction(
  verdict: RunVerdict,
  abortControl: Extract<LoopActionControl, "break" | "return">,
): LoopAction {
  switch (verdict.decision) {
    case "stop":
      return { control: abortControl, notice: "abort", backoffMs: 0 };
    case "ask_user":
      return { control: "continue", notice: "ask_user", backoffMs: verdict.backoffMs };
    case "retry":
      return { control: "continue", notice: "retry", backoffMs: verdict.backoffMs };
    case "pause":
      // Unreachable in 1a (no run-clock); treat a recoverable pause as a retry-continue.
      return { control: "continue", notice: "retry", backoffMs: 0 };
    case "done":
    case "continue":
      return { control: "continue", notice: "none", backoffMs: 0 };
  }
}
