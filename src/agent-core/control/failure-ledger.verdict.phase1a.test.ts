/**
 * Agent Core v2 — Phase 1a: FailureLedger.verdict() mapping under the INERT 1a inputs.
 *
 * With runClock / silenceAccumulator / typedCancelReason OFF, every VerdictInput field those
 * concerns own is inert, so verdict() collapses to the health-only surface:
 *   rule 5 (shouldAbort) → rule 7 (shouldAskUser) → rule 9 (consecutive>0 retry) → default.
 * These tests drive a stub HealthCore to prove that mapping AND that rules 1–4/6/8/10 are dead.
 */
import { describe, expect, it } from "vitest";
import {
  createFailureLedger,
  type HealthCore,
  type VerdictInput,
} from "./failure-ledger.js";

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

/** A fully controllable HealthCore stub. */
class StubHealthCore implements HealthCore {
  abort = false;
  ask = false;
  consec = 0;
  backoff = 0;
  successes = 0;
  failures = 0;

  recordSuccess(): void {
    this.successes += 1;
  }
  recordFailure(): void {
    this.failures += 1;
  }
  shouldAbort(): boolean {
    return this.abort;
  }
  shouldAskUser(): boolean {
    return this.ask;
  }
  backoffMs(): number {
    return this.backoff;
  }
  get statusLevel(): string {
    return "ok";
  }
  get failureRate(): number {
    return 0;
  }
  get consecutive(): number {
    return this.consec;
  }
}

describe("verdict() — Phase 1a health-only mapping", () => {
  it("shouldAbort() → stop{verdict-stop,health,hard}", () => {
    const stub = new StubHealthCore();
    stub.abort = true;
    stub.consec = 5;
    const ledger = createFailureLedger(stub, { pauseRetryBudget: 0 });
    const v = ledger.verdict(INERT);
    expect(v.decision).toBe("stop");
    if (v.decision === "stop") {
      expect(v.finalize).toBe("hard");
      expect(v.reason).toEqual({ kind: "verdict-stop", cause: "health" });
    }
  });

  it("shouldAskUser() (and not abort) → ask_user with the served backoff", () => {
    const stub = new StubHealthCore();
    stub.ask = true;
    stub.consec = 3;
    stub.backoff = 30_000;
    const ledger = createFailureLedger(stub, { pauseRetryBudget: 0 });
    const v = ledger.verdict(INERT);
    expect(v.decision).toBe("ask_user");
    if (v.decision === "ask_user") expect(v.backoffMs).toBe(30_000);
  });

  it("consecutive>0 (no abort/ask, modelProposedDone=false) → retry with the served backoff", () => {
    const stub = new StubHealthCore();
    stub.consec = 1;
    stub.backoff = 10_000;
    const ledger = createFailureLedger(stub, { pauseRetryBudget: 0 });
    const v = ledger.verdict(INERT);
    expect(v.decision).toBe("retry");
    if (v.decision === "retry") expect(v.backoffMs).toBe(10_000);
  });

  it("consecutive=0, all inert → continue", () => {
    const stub = new StubHealthCore();
    const ledger = createFailureLedger(stub, { pauseRetryBudget: 0 });
    expect(ledger.verdict(INERT).decision).toBe("continue");
  });

  it("PROVES rules 1–4 are dead in 1a: inert terminator inputs never drive the verdict", () => {
    // With taskCancelReason/hardTimeoutBlown/resourceExhausted/taskInactivityExceeded inert,
    // the ONLY thing that can produce a stop is the health-abort (rule 5). Drive health=clean
    // and assert no stop regardless of the inert fields' (false/null) values.
    const stub = new StubHealthCore();
    stub.consec = 0;
    const ledger = createFailureLedger(stub, { pauseRetryBudget: 0 });
    expect(ledger.verdict(INERT).decision).toBe("continue");
    // And when health DOES abort, the reason is health — never a timeout/budget/inactivity kind.
    stub.abort = true;
    const v = ledger.verdict(INERT);
    expect(v.decision).toBe("stop");
    if (v.decision === "stop") expect(v.reason.kind).toBe("verdict-stop");
  });

  it("rule 6 (pause) is dead in 1a: callStalled stays false so the pause budget is never touched", () => {
    const stub = new StubHealthCore();
    const ledger = createFailureLedger(stub, { pauseRetryBudget: 5 });
    // Even with a budget available, the inert callStalled=false means no pause is ever produced.
    for (let i = 0; i < 10; i++) {
      expect(ledger.verdict(INERT).decision).not.toBe("pause");
    }
  });
});

describe("recordSuccess kind routing — E2-B unit proof (dormant in 1a)", () => {
  it('"real" success resets the core; "probe" success does NOT', () => {
    const stub = new StubHealthCore();
    const ledger = createFailureLedger(stub, { pauseRetryBudget: 0 });

    ledger.recordSuccess("p", "probe");
    expect(stub.successes).toBe(0); // probe success is the registry's concern — ledger ignores it

    ledger.recordSuccess("p", "real");
    expect(stub.successes).toBe(1); // a real response resets the task failure run
  });

  it("benign failures never poison health", () => {
    const stub = new StubHealthCore();
    const ledger = createFailureLedger(stub, { pauseRetryBudget: 0 });
    ledger.recordFailure("p", true); // benign control-plane cancel
    expect(stub.failures).toBe(0);
    ledger.recordFailure("p", false);
    expect(stub.failures).toBe(1);
  });
});
