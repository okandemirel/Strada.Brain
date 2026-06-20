/**
 * Agent Core v2 — Phase 1a: adapts the kept v1 IterationHealthTracker to the HealthCore
 * interface that FailureLedger consumes (observation 31154 — the Phase-1 adapter).
 *
 * Four gaps bridged (see ARCHITECTURE §2.4 / the E2 delta):
 *  (a) method→getter: getStatusLevel/getFailureRate/getConsecutiveFailures → statusLevel/failureRate/consecutive
 *  (b) rename: getBackoffMs → backoffMs
 *  (c) recordFailure arity/return: tracker needs a provider + returns FailureAction;
 *      HealthCore.recordFailure() takes no arg, returns void.
 *  (d) shouldAskUser(): does NOT exist on the tracker — reconstructed here from the
 *      predicate v1 only computed INLINE inside recordFailure.
 *
 * E2-A (backoff off-by-one): v1's applied per-failure backoff is the value recordFailure
 * RETURNS (read at the PRE-increment index). The tracker's only public query, getBackoffMs(),
 * reads the POST-increment index → one schedule rung too high. This adapter captures the
 * returned FailureAction.backoffMs and replays THAT through backoffMs(), so the ledger path
 * applies the identical delay v1 did. getBackoffMs() is intentionally never called.
 */
import {
  ASK_USER_CONSECUTIVE,
  IterationHealthTracker,
  SLIDING_WINDOW_SIZE,
  type FailureAction,
} from "../../agents/iteration-health-tracker.js";
import type { HealthCore } from "./failure-ledger.js";

// Mirror of the tracker's MODULE-PRIVATE constants (iteration-health-tracker.ts:20,27).
// Kept in lockstep with that file; a drift test asserts equivalence (the equivalence suite
// re-derives the same crossings from the live tracker, so a value drift fails loudly).
const ASK_USER_FAILURE_RATE = 0.4;
const MIN_WINDOW_FOR_RATE = 5;

/**
 * Wraps an {@link IterationHealthTracker} behind {@link HealthCore}.
 *
 * The provider name is only stored on the (never-reset) tracker `results[]` entries for the
 * legacy health-context message; the ledger path builds its own user-facing text, so any
 * stable label is fine. The orchestrator passes the live provider name so legacy result
 * entries stay accurate; if the provider changes mid-loop, {@link setProvider} updates it.
 */
export class IterationHealthCoreAdapter implements HealthCore {
  /** The PRE-increment backoff from the most recent recordFailure(); v1's applied delay. */
  private lastBackoffMs = 0;

  constructor(
    private readonly tracker: IterationHealthTracker,
    private provider: string,
  ) {}

  /** Update the provider label used for legacy tracker `results[]` entries (no behavior change). */
  setProvider(provider: string): void {
    this.provider = provider;
  }

  recordSuccess(): void {
    this.tracker.recordSuccess();
    this.lastBackoffMs = 0; // mirror tracker: success resets backoffIndex → next backoff is 0ms
  }

  recordFailure(): void {
    // Capture the verdict-bearing FailureAction; the ledger reads only via backoffMs()/
    // shouldAbort()/shouldAskUser(), so the FailureAction.kind is discarded — but its
    // backoffMs is the PRE-increment value we must preserve (E2-A).
    const action: FailureAction = this.tracker.recordFailure(this.provider);
    this.lastBackoffMs = action.kind === "abort" ? 0 : action.backoffMs;
  }

  shouldAbort(): boolean {
    return this.tracker.shouldAbort();
  }

  shouldAskUser(): boolean {
    // Exact reconstruction of v1's inline predicate (iteration-health-tracker.ts:83-87).
    if (this.tracker.getConsecutiveFailures() >= ASK_USER_CONSECUTIVE) return true;
    // Sliding-window rate gate; the window is the last SLIDING_WINDOW_SIZE results, and the
    // rate is only meaningful once >= MIN_WINDOW_FOR_RATE results exist. v1's rateTriggered
    // reads `this.results.length >= MIN_WINDOW_FOR_RATE`; getTotalResults() exposes that count.
    const windowFilled =
      Math.min(this.tracker.getTotalResults(), SLIDING_WINDOW_SIZE) >= MIN_WINDOW_FOR_RATE;
    return windowFilled && this.tracker.getFailureRate() >= ASK_USER_FAILURE_RATE;
  }

  backoffMs(): number {
    // E2-A: return the PRE-increment value v1 applied, NOT tracker.getBackoffMs() (post-increment).
    return this.lastBackoffMs;
  }

  get statusLevel(): string {
    return this.tracker.getStatusLevel();
  }

  get failureRate(): number {
    return this.tracker.getFailureRate();
  }

  get consecutive(): number {
    return this.tracker.getConsecutiveFailures();
  }
}
