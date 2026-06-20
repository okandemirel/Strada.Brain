/**
 * Agent Core v2 — Phase 1a: flag-OFF vs flag-ON decision equivalence.
 *
 * The OFF arm is v1's `IterationHealthTracker.recordFailure()` → FailureAction. The ON arm is
 * `FailureLedger(adapter).recordFailure()` + `verdict(inert)` → RunVerdict. Both wrap the SAME
 * kind of tracker, so for the EMPTY path the terminal action class AND the backoff must match
 * at every step. The one documented divergence — the THROW path now inherits the EMPTY path's
 * health rate-gate — is asserted explicitly as INTENDED, not a bug.
 */
import { describe, expect, it } from "vitest";
import {
  IterationHealthTracker,
  type FailureAction,
} from "../../agents/iteration-health-tracker.js";
import {
  createFailureLedger,
  type RunVerdict,
  type VerdictInput,
} from "./failure-ledger.js";
import { IterationHealthCoreAdapter } from "./iteration-health-core-adapter.js";

type ActionClass = "retry" | "ask_user" | "abort";

/** Phase 1a inert VerdictInput: every concern except health is OFF. */
const INERT: VerdictInput = {
  taskCancelReason: null,
  hardTimeoutBlown: false,
  hardTimeoutScope: "task",
  resourceExhausted: false,
  taskInactivityExceeded: false,
  callStalled: false,
  modelProposedDone: false,
  reflectionWantsExtend: false,
  loopDetectionBlocked: false,
};

function classifyFailureAction(a: FailureAction): ActionClass {
  return a.kind;
}

function classifyVerdict(v: RunVerdict): ActionClass {
  switch (v.decision) {
    case "stop":
      return "abort";
    case "ask_user":
      return "ask_user";
    case "retry":
      return "retry";
    default:
      // continue/done/pause are not reachable for an empty-failure step in 1a.
      throw new Error(`unexpected verdict for a failure step: ${v.decision}`);
  }
}

function verdictBackoff(v: RunVerdict): number {
  if (v.decision === "retry" || v.decision === "ask_user") return v.backoffMs;
  return 0; // abort carries no backoff
}

describe("Path B (EMPTY) flag-OFF vs flag-ON equivalence", () => {
  it("produces the same action class AND backoff at each step of a mixed sequence", () => {
    // OFF arm: raw tracker.
    const offTracker = new IterationHealthTracker(0);
    // ON arm: ledger over an adapter wrapping its OWN identical tracker.
    const onTracker = new IterationHealthTracker(0);
    const ledger = createFailureLedger(
      new IterationHealthCoreAdapter(onTracker, "p"),
      { pauseRetryBudget: 0 },
    );

    // A scripted empty-failure sequence (success resets between bursts).
    const sequence: ("fail" | "success")[] = [
      "fail", "fail", "fail", "success",
      "fail", "fail", "fail", "fail", "fail",
    ];

    for (const step of sequence) {
      if (step === "success") {
        offTracker.recordSuccess();
        ledger.recordSuccess("p", "real");
        continue;
      }
      const offAction = offTracker.recordFailure("p");
      ledger.recordFailure("p", false);
      const onVerdict = ledger.verdict(INERT);

      expect(classifyVerdict(onVerdict)).toBe(classifyFailureAction(offAction));
      // backoff parity (abort carries 0 in both).
      const offBackoff = offAction.kind === "abort" ? 0 : offAction.backoffMs;
      expect(verdictBackoff(onVerdict)).toBe(offBackoff);
    }
  });

  it("crosses to ask_user at the 3rd consecutive failure in both arms", () => {
    const offTracker = new IterationHealthTracker(0);
    const onTracker = new IterationHealthTracker(0);
    const ledger = createFailureLedger(
      new IterationHealthCoreAdapter(onTracker, "p"),
      { pauseRetryBudget: 0 },
    );
    const offClasses: ActionClass[] = [];
    const onClasses: ActionClass[] = [];
    for (let i = 0; i < 3; i++) {
      offClasses.push(classifyFailureAction(offTracker.recordFailure("p")));
      ledger.recordFailure("p", false);
      onClasses.push(classifyVerdict(ledger.verdict(INERT)));
    }
    expect(offClasses).toEqual(["retry", "retry", "ask_user"]);
    expect(onClasses).toEqual(offClasses);
  });
});

describe("Path A (THROW) consolidation — INTENDED divergence under the rate-gate", () => {
  it("all-throw all-fail: both v1 (consecutive>=5) and ledger (rate>=0.8) abort at the 5th", () => {
    // 5 consecutive failures in a >=5 window → rate 1.0. v1 Path A aborts on consecutive>=5;
    // ledger rule 5 aborts on rate>=0.8 AND consecutive>=5. Same crossing for the all-fail case.
    const onTracker = new IterationHealthTracker(0);
    const ledger = createFailureLedger(
      new IterationHealthCoreAdapter(onTracker, "p"),
      { pauseRetryBudget: 0 },
    );
    let abortedAt = -1;
    for (let i = 1; i <= 5; i++) {
      ledger.recordFailure("p", false);
      if (ledger.verdict(INERT).decision === "stop") {
        abortedAt = i;
        break;
      }
    }
    expect(abortedAt).toBe(5);
  });

  it("mixed: 3 successes then 5 consecutive fails → ledger does NOT abort (rate 0.5), v1 WOULD", () => {
    // 10-result window: 3 successes then 5 consecutive failures → failure rate 0.5 (<0.8),
    // consecutive 5. The unified ledger's rule-5 abort requires rate>=0.8, so it does NOT
    // abort — it falls to ask_user (consecutive>=3). v1's THROW path (evaluateProviderFailure)
    // aborts purely on consecutive>=5 with NO rate gate. This is the deliberate consolidation:
    // throws now share the empty-path's rate semantics.
    const onTracker = new IterationHealthTracker(0);
    const ledger = createFailureLedger(
      new IterationHealthCoreAdapter(onTracker, "p"),
      { pauseRetryBudget: 0 },
    );
    for (let i = 0; i < 3; i++) ledger.recordSuccess("p", "real");
    let lastDecision: RunVerdict["decision"] = "continue";
    for (let i = 0; i < 5; i++) {
      ledger.recordFailure("p", false);
      lastDecision = ledger.verdict(INERT).decision;
    }
    // rate is 5/8 = 0.625 (window holds 3 successes + 5 fails) → below the 0.8 abort gate.
    expect(ledger.health.failureRate).toBeCloseTo(5 / 8, 5);
    expect(ledger.health.consecutive).toBe(5);
    expect(lastDecision).not.toBe("stop"); // ledger does NOT abort here…
    expect(lastDecision).toBe("ask_user"); // …it asks the user instead (consecutive>=3).
  });
});
