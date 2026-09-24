/**
 * Agent Core v2 — Phase 1a: incident-regression backstop.
 *
 * Guards the 3h27m runaway (obs 18719) and the 3/5 threshold reductions (obs 18106): the
 * unified ledger MUST cross to ask_user at the 3rd consecutive failure and hard-abort at the
 * 5th, with a BOUNDED exponential backoff escalation ([0,10,30,60,120]s). A FakeClock models
 * "a loop awaiting each backoff" so the bounded-time property is asserted deterministically
 * without real sleeps. Also pins the verdict→loop-action control mapping the two orchestrator
 * helpers rely on (bg EMPTY abort = return; interactive / bg THROW abort = break).
 */
import { describe, expect, it } from "vitest";
import {
  ABORT_CONSECUTIVE,
  ASK_USER_CONSECUTIVE,
  BACKOFF_SCHEDULE_MS,
  IterationHealthTracker,
} from "../../agents/iteration-health-tracker.js";
import { FakeClock } from "./clock.js";
import {
  createFailureLedger,
  type VerdictInput,
} from "./failure-ledger.js";
import { IterationHealthCoreAdapter } from "./iteration-health-core-adapter.js";
import { mapVerdictToLoopAction } from "./verdict-loop-action.js";

const INERT: VerdictInput = {
  taskCancelReason: null,
  hardTimeoutBlown: false,
  hardTimeoutScope: "task",
  resourceExhausted: false,
  taskInactivityExceeded: false,
  callStalled: false,
  lastStepFailed: true, // these suites drive the failure-site verdict; a gate tick passes false
  modelProposedDone: false,
  reflectionWantsExtend: false,
  loopDetectionBlocked: false,
};

describe("incident regression — consecutive-failure thresholds + bounded backoff", () => {
  it("crosses to ask_user at the 3rd and hard-aborts at the 5th consecutive empty failure", () => {
    const tracker = new IterationHealthTracker(0);
    const ledger = createFailureLedger(
      new IterationHealthCoreAdapter(tracker, "p"),
      { pauseRetryBudget: 0 },
    );

    const decisions: string[] = [];
    for (let i = 1; i <= ABORT_CONSECUTIVE; i++) {
      ledger.recordFailure("p", false);
      decisions.push(ledger.verdict(INERT).decision);
    }

    // failures 1,2 = retry; 3,4 = ask_user (consecutive>=3); 5 = stop (rate 1.0, consecutive>=5).
    expect(decisions[ASK_USER_CONSECUTIVE - 1]).toBe("ask_user"); // index 2 → 3rd
    expect(decisions[ABORT_CONSECUTIVE - 1]).toBe("stop"); // index 4 → 5th
    expect(decisions).toEqual(["retry", "retry", "ask_user", "ask_user", "stop"]);
  });

  it("applies the bounded exponential backoff schedule and a loop awaiting it stays time-bounded", () => {
    const clock = new FakeClock(0);
    const tracker = new IterationHealthTracker(0);
    const adapter = new IterationHealthCoreAdapter(tracker, "p");
    const ledger = createFailureLedger(adapter, { pauseRetryBudget: 0 });

    // Drive the 4 PRE-abort failures (1-4): all retry/ask_user, all carry a real backoff rung.
    // The 5th failure aborts (covered by the threshold test) and carries no backoff, so it is
    // intentionally excluded here.
    const backoffs: number[] = [];
    for (let i = 0; i < ABORT_CONSECUTIVE - 1; i++) {
      ledger.recordFailure("p", false);
      const v = ledger.verdict(INERT);
      expect(v.decision).not.toBe("stop"); // pre-abort: never terminal
      const action = mapVerdictToLoopAction(v, "return");
      // Model what the loop does: await action.backoffMs before the next attempt.
      if (action.backoffMs > 0) {
        let fired = false;
        clock.setTimer(action.backoffMs, () => {
          fired = true;
        });
        clock.advance(action.backoffMs);
        expect(fired).toBe(true);
      }
      backoffs.push(action.backoffMs);
    }

    // The applied per-failure delays are exactly v1's pre-increment schedule (E2-A neutralized).
    expect(backoffs).toEqual(BACKOFF_SCHEDULE_MS.slice(0, ABORT_CONSECUTIVE - 1)); // [0,10_000,30_000,60_000]
    // Bounded escalation: total awaited time is the sum of those rungs — never unbounded.
    const totalMs = BACKOFF_SCHEDULE_MS.reduce((a, b) => a + b, 0);
    expect(clock.now()).toBeLessThanOrEqual(totalMs);
    expect(clock.now()).toBe(0 + 10_000 + 30_000 + 60_000);
  });
});

describe("verdict→loop-action control mapping (the two helper terminal styles)", () => {
  it("a health-abort stop maps to RETURN for the background EMPTY site", () => {
    const tracker = new IterationHealthTracker(0);
    const ledger = createFailureLedger(
      new IterationHealthCoreAdapter(tracker, "p"),
      { pauseRetryBudget: 0 },
    );
    for (let i = 0; i < ABORT_CONSECUTIVE; i++) ledger.recordFailure("p", false);
    const v = ledger.verdict(INERT);
    expect(v.decision).toBe("stop");
    expect(mapVerdictToLoopAction(v, "return")).toMatchObject({ control: "return", notice: "abort" });
  });

  it("a health-abort stop maps to BREAK for interactive / bg THROW sites", () => {
    const tracker = new IterationHealthTracker(0);
    const ledger = createFailureLedger(
      new IterationHealthCoreAdapter(tracker, "p"),
      { pauseRetryBudget: 0 },
    );
    for (let i = 0; i < ABORT_CONSECUTIVE; i++) ledger.recordFailure("p", false);
    const v = ledger.verdict(INERT);
    expect(mapVerdictToLoopAction(v, "break")).toMatchObject({ control: "break", notice: "abort" });
  });

  it("retry/ask_user always map to CONTINUE (informational, no real pause in 1a)", () => {
    const tracker = new IterationHealthTracker(0);
    const ledger = createFailureLedger(
      new IterationHealthCoreAdapter(tracker, "p"),
      { pauseRetryBudget: 0 },
    );
    ledger.recordFailure("p", false); // retry
    expect(mapVerdictToLoopAction(ledger.verdict(INERT), "return").control).toBe("continue");
    ledger.recordFailure("p", false);
    ledger.recordFailure("p", false); // 3rd → ask_user
    const ask = mapVerdictToLoopAction(ledger.verdict(INERT), "return");
    expect(ask.control).toBe("continue");
    expect(ask.notice).toBe("ask_user");
  });
});

describe("health ask_user is a reaction to a failure, never to a success", () => {
  // The real tracker's sliding-window rate stays >= 40% for several results after a recovery.
  // v1 evaluated the ask-user predicate only inside recordFailure; the v2 gate re-derived it on
  // every tick, so a success could be answered with ask_user (and a background run blocked).
  function ledgerAfter(sequence: readonly ("F" | "S")[]) {
    const tracker = new IterationHealthTracker(0);
    const adapter = new IterationHealthCoreAdapter(tracker, "p");
    const ledger = createFailureLedger(adapter, { pauseRetryBudget: 0 });
    for (const r of sequence) {
      if (r === "F") ledger.recordFailure("p", false);
      else ledger.recordSuccess("p", "real");
    }
    return { adapter, ledger };
  }

  it("the gate tick after F,F,S,F,S continues (the window rate alone must not ask)", () => {
    const { adapter, ledger } = ledgerAfter(["F", "F", "S", "F", "S"]);
    expect(adapter.shouldAskUser(), "premise: the window rate is still >= 40%").toBe(true);
    expect(ledger.verdict({ ...INERT, lastStepFailed: false }).decision).toBe("continue");
  });

  it("a gate tick after three failures and a recovery neither asks nor replays the stale backoff", () => {
    const { adapter, ledger } = ledgerAfter(["F", "F", "F", "S"]);
    expect(adapter.backoffMs()).toBe(0);
    expect(ledger.verdict({ ...INERT, lastStepFailed: false })).toEqual({ decision: "continue" });
  });

  it("the gate tick right after a failure-site retry does not retry (and back off) again", () => {
    const { ledger } = ledgerAfter(["F", "F"]);
    const failSite = ledger.verdict({ ...INERT, lastStepFailed: true });
    expect(failSite).toMatchObject({ decision: "retry", backoffMs: 10_000 });
    // Nothing is recorded between the failure site's yield and the next gate tick.
    expect(ledger.verdict({ ...INERT, lastStepFailed: false })).toEqual({ decision: "continue" });
  });

  it("the failure-site verdict still asks on the window rate (v1 parity)", () => {
    const { ledger } = ledgerAfter(["F", "F", "S", "F", "S", "F"]);
    expect(ledger.verdict({ ...INERT, lastStepFailed: true }).decision).toBe("ask_user");
  });
});
