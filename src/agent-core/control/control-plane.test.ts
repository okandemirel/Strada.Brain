/**
 * Agent Core v2 — Control Plane unit tests (prerequisite P-A).
 *
 * Tests the four owners in isolation under a deterministic FakeClock: CancelReason/Token,
 * Budget, policy clamp, RunClock (subtractive-min carve + silence accumulator), and the
 * FailureLedger verdict precedence — including the two named-incident regressions
 * (3h27m runaway, ~70min stall / delegation livelock).
 */

import { describe, it, expect, vi } from "vitest";
import {
  isBenign,
  describeCancelReason,
  type CancelReason,
} from "./cancel-reason.js";
import { FakeClock } from "./clock.js";
import { createCancelToken } from "./cancel-token.js";
import { createBudget } from "./budget.js";
import { resolveRunBudgetPolicy, type RunBudgetPolicy } from "./policy.js";
import { openRunClock } from "./run-clock.js";
import {
  createFailureLedger,
  type HealthCore,
  type VerdictInput,
  type RunVerdict,
} from "./failure-ledger.js";

// ── helpers ───────────────────────────────────────────────────────────────

function fakeHealth(overrides: Partial<HealthCore> = {}): HealthCore {
  return {
    recordSuccess: () => {},
    recordFailure: () => {},
    shouldAbort: () => false,
    shouldAskUser: () => false,
    backoffMs: () => 1000,
    statusLevel: "healthy",
    failureRate: 0,
    consecutive: 0,
    ...overrides,
  };
}

function vin(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    taskCancelReason: null,
    hardTimeoutBlown: false,
    hardTimeoutScope: "task",
    resourceExhausted: false,
    taskInactivityExceeded: false,
    callStalled: false,
    modelProposedDone: false,
    reflectionWantsExtend: false,
    loopDetectionBlocked: false,
    ...overrides,
  };
}

const POLICY = (overrides: Partial<RunBudgetPolicy> = {}): RunBudgetPolicy => ({
  mode: "background",
  taskHardMs: Number.POSITIVE_INFINITY,
  taskInactivityMs: 2000,
  callFirstResponseMs: 1000,
  callStallMs: 500,
  callHardMs: 5000,
  outputTokenCap: 100_000,
  costCapUsd: 10,
  pauseRetryBudget: 3,
  ...overrides,
});

// ── CancelReason ──────────────────────────────────────────────────────────

describe("CancelReason", () => {
  it("isBenign: control-plane kinds are benign, genuine kinds are not", () => {
    expect(isBenign({ kind: "user-cancel" })).toBe(true);
    expect(isBenign({ kind: "task-winddown" })).toBe(true);
    expect(isBenign({ kind: "first-success-satisfied" })).toBe(true);
    expect(isBenign({ kind: "provider-stall", scope: "call" })).toBe(false);
    expect(isBenign({ kind: "hard-timeout", scope: "task" })).toBe(false);
    expect(isBenign({ kind: "task-inactivity" })).toBe(false);
    expect(isBenign({ kind: "budget-exhausted", resource: "tokens" })).toBe(false);
    expect(isBenign({ kind: "verdict-stop", cause: "health" })).toBe(false);
  });

  it("isBenign: parent-cancelled inherits the root cause's benignity", () => {
    expect(isBenign({ kind: "parent-cancelled", rootCause: { kind: "user-cancel" } })).toBe(true);
    expect(
      isBenign({ kind: "parent-cancelled", rootCause: { kind: "hard-timeout", scope: "task" } }),
    ).toBe(false);
  });

  it("describeCancelReason produces a stable label", () => {
    expect(describeCancelReason({ kind: "provider-stall", scope: "call" })).toBe("provider-stall:call");
    expect(
      describeCancelReason({ kind: "parent-cancelled", rootCause: { kind: "user-cancel" } }),
    ).toBe("parent-cancelled(user-cancel)");
  });
});

// ── CancelToken ─────────────────────────────────────────────────────────────

describe("CancelToken", () => {
  it("fans out cancel to children, in-flight ops, and listeners; sets reason", () => {
    const root = createCancelToken();
    const child = root.child();
    const inflight = vi.fn();
    const listener = vi.fn();
    root.registerInFlight("fetch", inflight);
    child.onAbort(listener);

    root.cancel({ kind: "user-cancel" });

    expect(root.aborted).toBe(true);
    expect(root.reason).toEqual({ kind: "user-cancel" });
    expect(inflight).toHaveBeenCalledWith({ kind: "user-cancel" });
    expect(child.aborted).toBe(true);
    expect(child.reason).toEqual({ kind: "parent-cancelled", rootCause: { kind: "user-cancel" } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is first-writer-wins on reason", () => {
    const t = createCancelToken();
    t.cancel({ kind: "provider-stall", scope: "call" });
    t.cancel({ kind: "user-cancel" });
    expect(t.reason).toEqual({ kind: "provider-stall", scope: "call" });
  });

  it("a child created after the parent is cancelled is born cancelled", () => {
    const root = createCancelToken();
    root.cancel({ kind: "task-winddown" });
    const child = root.child();
    expect(child.aborted).toBe(true);
    expect(child.isBenign()).toBe(true);
  });

  it("registerInFlight aborts immediately if already cancelled; dispose unregisters", () => {
    const t = createCancelToken();
    t.cancel({ kind: "user-cancel" });
    const late = vi.fn();
    t.registerInFlight("late", late);
    expect(late).toHaveBeenCalledWith({ kind: "user-cancel" });

    const t2 = createCancelToken();
    const op = vi.fn();
    const reg = t2.registerInFlight("op", op);
    reg.dispose();
    t2.cancel({ kind: "user-cancel" });
    expect(op).not.toHaveBeenCalled();
  });

  it("signal.aborted integrates with AbortSignal", () => {
    const t = createCancelToken();
    expect(t.signal.aborted).toBe(false);
    t.cancel({ kind: "user-cancel" });
    expect(t.signal.aborted).toBe(true);
  });
});

// ── FakeClock ───────────────────────────────────────────────────────────────

describe("FakeClock", () => {
  it("fires timers in chronological order on advance", () => {
    const c = new FakeClock(0);
    const order: string[] = [];
    c.setTimer(300, () => order.push("b"));
    c.setTimer(100, () => order.push("a"));
    c.advance(500);
    expect(order).toEqual(["a", "b"]);
    expect(c.now()).toBe(500);
  });

  it("clearTimer cancels a pending timer", () => {
    const c = new FakeClock(0);
    const cb = vi.fn();
    const h = c.setTimer(100, cb);
    c.clearTimer(h);
    c.advance(200);
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires timers scheduled by a callback within the same window", () => {
    const c = new FakeClock(0);
    const hits: number[] = [];
    c.setTimer(100, () => {
      hits.push(c.now());
      c.setTimer(50, () => hits.push(c.now()));
    });
    c.advance(200);
    expect(hits).toEqual([100, 150]);
  });
});

// ── Budget ──────────────────────────────────────────────────────────────────

describe("Budget", () => {
  it("debits output + cost; input is tracked but never gates", () => {
    const b = createBudget(1000, 5);
    b.debit({ inputTokens: 10_000, outputTokens: 200, costUsd: 1 });
    expect(b.remainingOutputTokens()).toBe(800);
    expect(b.remainingCostUsd()).toBe(4);
    expect(b.inputTokensSeen()).toBe(10_000);
  });

  it("carveChild returns a deterministic fractional slice", () => {
    const b = createBudget(1000, 10);
    expect(b.carveChild(1, 4)).toEqual({ outputTokens: 250, costUsd: 2.5 });
    expect(b.carveChild(0, 0)).toEqual({ outputTokens: 0, costUsd: 0 });
  });

  it("raiseOutputCap adds only the delta to the live remaining (mid-task /token raise)", () => {
    const b = createBudget(1000, 5);
    b.debit({ inputTokens: 0, outputTokens: 800, costUsd: 0 }); // 200 left of a 1000 cap
    expect(b.raiseOutputCap(3000)).toBe(true); // cap 1000 → 3000: +2000 headroom
    expect(b.remainingOutputTokens()).toBe(2200); // 200 already-spent-adjusted + 2000
    // A second raise stacks on the NEW cap, not the original.
    expect(b.raiseOutputCap(4000)).toBe(true);
    expect(b.remainingOutputTokens()).toBe(3200);
  });

  it("raiseOutputCap is raise-only — a lower/equal cap is ignored (no mid-run strand)", () => {
    const b = createBudget(1000, 5);
    b.debit({ inputTokens: 0, outputTokens: 900, costUsd: 0 }); // 100 left
    expect(b.raiseOutputCap(1000)).toBe(false); // equal → no-op
    expect(b.raiseOutputCap(500)).toBe(false); // lower → no-op (never strands below spent)
    expect(b.remainingOutputTokens()).toBe(100);
    // Raising to unbounded (∞, the -1 config sentinel) lifts the gate entirely.
    expect(b.raiseOutputCap(Number.POSITIVE_INFINITY)).toBe(true);
    expect(b.remainingOutputTokens()).toBe(Number.POSITIVE_INFINITY);
  });
});

// ── policy ──────────────────────────────────────────────────────────────────

describe("resolveRunBudgetPolicy", () => {
  const seed = {
    streamInitialTimeoutMs: 600_000,
    streamStallTimeoutMs: 300_000,
    providerFirstResponseMs: 90_000,
    taskInactivityMs: 600_000,
    minInactivityOverStreamRatio: 2,
    outputTokenCap: 100_000,
    costCapUsd: 10,
  };

  it("maps seed → policy with no warning when ordering holds", () => {
    const { policy, warnings } = resolveRunBudgetPolicy("interactive", seed);
    expect(policy.callStallMs).toBe(300_000);
    expect(policy.callFirstResponseMs).toBe(90_000);
    expect(policy.taskInactivityMs).toBe(600_000);
    expect(policy.pauseRetryBudget).toBe(5);
    expect(warnings).toHaveLength(0);
  });

  it("clamps taskInactivity below 2×callStall and warns (the one surviving ratio, one place)", () => {
    const { policy, warnings } = resolveRunBudgetPolicy("background", {
      ...seed,
      taskInactivityMs: 100_000, // < 2×300_000
    });
    expect(policy.taskInactivityMs).toBe(600_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("clamped");
  });
});

// ── RunClock ────────────────────────────────────────────────────────────────

describe("RunClock", () => {
  it("carves call hard limit subtractively from task remaining (min)", () => {
    const clock = new FakeClock(0);
    const rc = openRunClock(clock, POLICY({ taskHardMs: 3000 }));
    // requested call hardMs 5000 but only 3000 task remaining → call aborts at 3000, not 5000.
    rc.enterCall({ firstResponseMs: 10_000, stallMs: 10_000, hardMs: 5000 });
    clock.advance(2999);
    expect(rc.taskToken.aborted).toBe(false);
    clock.advance(2); // cross 3000
    expect(rc.taskToken.aborted).toBe(true);
    expect(rc.taskToken.reason).toEqual({ kind: "hard-timeout", scope: "task" });
  });

  it("call first-response timer fires provider-stall when no token arrives", () => {
    const clock = new FakeClock(0);
    const rc = openRunClock(clock, POLICY());
    const call = rc.enterCall({ firstResponseMs: 1000, stallMs: 500, hardMs: 5000 });
    clock.advance(1001);
    expect(call.token.aborted).toBe(true);
    expect(call.token.reason).toEqual({ kind: "provider-stall", scope: "call" });
  });

  it("firstTokenSeen flips to the shorter stall window; touch re-arms it", () => {
    const clock = new FakeClock(0);
    const rc = openRunClock(clock, POLICY());
    const call = rc.enterCall({ firstResponseMs: 1000, stallMs: 500, hardMs: 5000 });
    clock.advance(200);
    call.firstTokenSeen(); // now on the 500ms stall window
    clock.advance(400);
    call.touch(); // re-arm
    clock.advance(400);
    expect(call.token.aborted).toBe(false); // 400 < 500 since last touch
    clock.advance(200); // 600 > 500 → stall fires
    expect(call.token.aborted).toBe(true);
    expect(call.token.reason).toEqual({ kind: "provider-stall", scope: "call" });
  });

  it("silence accumulator sums silent ms across FRESH calls (the livelock fix)", () => {
    const clock = new FakeClock(0);
    // callFirstResponse high so the per-call timer never fires during these short waits.
    const rc = openRunClock(clock, POLICY({ taskInactivityMs: 2000, callFirstResponseMs: 100_000, callHardMs: 100_000 }));
    for (let i = 0; i < 2; i += 1) {
      const call = rc.enterCall({ firstResponseMs: 100_000, stallMs: 100_000, hardMs: 100_000 });
      clock.advance(800); // silent: no token
      call.leave();
    }
    expect(rc.accumulatedSilentMs()).toBe(1600);
    expect(rc.silenceCeilingExceeded()).toBe(false);
    const call = rc.enterCall({ firstResponseMs: 100_000, stallMs: 100_000, hardMs: 100_000 });
    clock.advance(800);
    call.leave();
    expect(rc.accumulatedSilentMs()).toBe(2400);
    expect(rc.silenceCeilingExceeded()).toBe(true); // a fresh call did NOT reset the ceiling
  });

  /* audited 2026-09-02: a left call scope must not stay linked to the task token */
  it("a left call scope is unlinked from the task token (no per-call token accumulates for the run's life)", () => {
    const clock = new FakeClock(0);
    const rc = openRunClock(clock, POLICY({ callFirstResponseMs: 100_000, callStallMs: 100_000, callHardMs: 100_000 }));
    const children = (rc.taskToken as unknown as { children: Set<unknown> }).children;
    const scopes: ReturnType<typeof rc.enterCall>[] = [];
    for (let i = 0; i < 50; i += 1) {
      const call = rc.enterCall({ firstResponseMs: 100_000, stallMs: 100_000, hardMs: 100_000 });
      clock.advance(10);
      call.leave();
      scopes.push(call);
    }
    expect(children.size).toBe(0);
    // A stalled scope's carried reason survives the detach (failedCallReason semantics untouched).
    const stalled = rc.enterCall({ firstResponseMs: 100, stallMs: 100, hardMs: 100_000 });
    clock.advance(101);
    expect(stalled.token.reason).toEqual({ kind: "provider-stall", scope: "call" });
    stalled.leave();
    expect(stalled.token.reason).toEqual({ kind: "provider-stall", scope: "call" });
    // A late task cancel fans out to nothing that has already left.
    rc.taskToken.cancel({ kind: "user-cancel" });
    for (const s of scopes) expect(s.token.reason).toBeNull();
  });

  it("a productive call (steady touches) contributes ~0 silent ms", () => {
    const clock = new FakeClock(0);
    const rc = openRunClock(clock, POLICY({ callFirstResponseMs: 100_000, callStallMs: 100_000, callHardMs: 100_000 }));
    const call = rc.enterCall({ firstResponseMs: 100_000, stallMs: 100_000, hardMs: 100_000 });
    call.firstTokenSeen();
    for (let i = 0; i < 10; i += 1) {
      clock.advance(100);
      call.touch();
    }
    call.leave();
    expect(rc.accumulatedSilentMs()).toBe(0);
  });

  it("task hard timer aborts the task token; dispose winds down cleanly", () => {
    const clock = new FakeClock(0);
    const rc = openRunClock(clock, POLICY({ taskHardMs: 5000 }));
    clock.advance(5001);
    expect(rc.taskToken.aborted).toBe(true);
    expect(rc.taskToken.reason).toEqual({ kind: "hard-timeout", scope: "task" });

    const rc2 = openRunClock(new FakeClock(0), POLICY());
    rc2.dispose();
    expect(rc2.taskToken.aborted).toBe(true);
    expect(rc2.taskToken.isBenign()).toBe(true); // task-winddown
  });
});

// ── FailureLedger verdict precedence ─────────────────────────────────────────

describe("FailureLedger verdict precedence", () => {
  const ledger = (health?: Partial<HealthCore>, pauseRetryBudget = 3): ReturnType<typeof createFailureLedger> =>
    createFailureLedger(fakeHealth(health), { pauseRetryBudget });

  it("1. benign cancel → stop graceful", () => {
    const v = ledger().verdict(vin({ taskCancelReason: { kind: "user-cancel" } }));
    expect(v).toEqual({ decision: "stop", reason: { kind: "user-cancel" }, finalize: "graceful" });
  });

  it("2. hard timeout → stop graceful, and OVERRIDES a model-proposed-done extend", () => {
    const v = ledger().verdict(
      vin({ hardTimeoutBlown: true, hardTimeoutScope: "task", modelProposedDone: true, reflectionWantsExtend: true }),
    );
    expect(v).toEqual({ decision: "stop", reason: { kind: "hard-timeout", scope: "task" }, finalize: "graceful" });
  });

  it("3. resource exhausted → stop graceful", () => {
    const v = ledger().verdict(vin({ resourceExhausted: "tokens" }));
    expect(v).toEqual({ decision: "stop", reason: { kind: "budget-exhausted", resource: "tokens" }, finalize: "graceful" });
  });

  it("4. task-inactivity ceiling → stop graceful", () => {
    const v = ledger().verdict(vin({ taskInactivityExceeded: true }));
    expect(v).toEqual({ decision: "stop", reason: { kind: "task-inactivity" }, finalize: "graceful" });
  });

  it("5. health abort → stop hard", () => {
    const v = ledger({ shouldAbort: () => true }).verdict(vin());
    expect(v).toEqual({ decision: "stop", reason: { kind: "verdict-stop", cause: "health" }, finalize: "hard" });
  });

  it("6. call stall → pause until the per-task retry budget is exhausted, then stop", () => {
    const l = ledger({}, 2);
    expect(l.verdict(vin({ callStalled: true })).decision).toBe("pause");
    expect(l.verdict(vin({ callStalled: true })).decision).toBe("pause");
    const third = l.verdict(vin({ callStalled: true }));
    expect(third).toEqual({ decision: "stop", reason: { kind: "provider-stall", scope: "task" }, finalize: "graceful" });
  });

  it("7. health ask_user / retry", () => {
    expect(ledger({ shouldAskUser: () => true }).verdict(vin()).decision).toBe("ask_user");
    const retry = ledger({ consecutive: 2 }).verdict(vin());
    expect(retry.decision).toBe("retry");
  });

  it("8. reflection arbitration: loopDetectionBlocked honors DONE (no extend) — runaway guard", () => {
    const v = ledger().verdict(vin({ modelProposedDone: true, reflectionWantsExtend: true, loopDetectionBlocked: true }));
    expect(v).toEqual({ decision: "done", finalize: "graceful" });
  });

  it("8. reflection arbitration: override may extend a healthy in-budget run", () => {
    expect(
      ledger().verdict(vin({ modelProposedDone: true, reflectionWantsExtend: true })).decision,
    ).toBe("continue");
    expect(
      ledger().verdict(vin({ modelProposedDone: true, reflectionWantsExtend: false })),
    ).toEqual({ decision: "done", finalize: "graceful" });
  });

  it("9. default → continue", () => {
    expect(ledger().verdict(vin()).decision).toBe("continue");
  });

  it("benign recordFailure never poisons health; probe success does not reset task failures", () => {
    const core = fakeHealth();
    const recordFailure = vi.spyOn(core, "recordFailure");
    const recordSuccess = vi.spyOn(core, "recordSuccess");
    const l = createFailureLedger(core, { pauseRetryBudget: 3 });
    l.recordFailure("opencode", true); // benign
    expect(recordFailure).not.toHaveBeenCalled();
    l.recordFailure("opencode", false);
    expect(recordFailure).toHaveBeenCalledTimes(1);
    l.recordSuccess("opencode", "probe");
    expect(recordSuccess).not.toHaveBeenCalled();
    l.recordSuccess("opencode", "real");
    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });
});

// ── Named-incident regressions (the headline guarantees) ─────────────────────

describe("incident regressions", () => {
  it("3h27m runaway cannot recur: hard-timeout (rule 2) + loopDetectionBlocked (rule 8)", () => {
    const l = createFailureLedger(fakeHealth(), { pauseRetryBudget: 3 });
    // Even if the model keeps proposing done+extend, a blown hard timeout stops it.
    const v1: RunVerdict = l.verdict(vin({ hardTimeoutBlown: true, modelProposedDone: true, reflectionWantsExtend: true }));
    expect(v1.decision).toBe("stop");
    // And the runaway-bug guard suppresses the extend override.
    const v2: RunVerdict = l.verdict(vin({ modelProposedDone: true, reflectionWantsExtend: true, loopDetectionBlocked: true }));
    expect(v2.decision).toBe("done");
  });

  it("~70min stall / delegation livelock cannot recur: accumulator across fresh calls → stop", () => {
    const clock = new FakeClock(0);
    const rc = openRunClock(clock, POLICY({ taskInactivityMs: 2000, callFirstResponseMs: 100_000, callHardMs: 100_000 }));
    const l = createFailureLedger(fakeHealth(), { pauseRetryBudget: 100 });
    // A flaky provider across a deep chain: many fresh silent calls. The accumulator does
    // NOT reset on a fresh call, so the ledger eventually stops the task.
    let stopped = false;
    for (let i = 0; i < 5 && !stopped; i += 1) {
      const call = rc.enterCall({ firstResponseMs: 100_000, stallMs: 100_000, hardMs: 100_000 });
      clock.advance(700); // silent
      call.leave();
      const v = l.verdict(vin({ taskInactivityExceeded: rc.silenceCeilingExceeded() }));
      if (v.decision === "stop") stopped = true;
    }
    expect(stopped).toBe(true);
    expect(rc.accumulatedSilentMs()).toBeGreaterThanOrEqual(2000);
  });
});

describe("review hardening (P-A)", () => {
  it("HIGH-1: a non-benign task-token abort is authoritative even if the mirror boolean lags", () => {
    const l = createFailureLedger(fakeHealth(), { pauseRetryBudget: 3 });
    // The hard-timeout timer aborted the task token, but the loop's derived hardTimeoutBlown
    // is still false (stale snapshot). The verdict must STILL stop — never fall to continue.
    const v = l.verdict(vin({ taskCancelReason: { kind: "hard-timeout", scope: "task" }, hardTimeoutBlown: false }));
    expect(v).toEqual({ decision: "stop", reason: { kind: "hard-timeout", scope: "task" }, finalize: "graceful" });
  });

  it("MEDIUM: a stale single failure does not preempt a model-proposed DONE", () => {
    const honored = createFailureLedger(fakeHealth({ consecutive: 1 }), { pauseRetryBudget: 3 }).verdict(
      vin({ modelProposedDone: true, reflectionWantsExtend: false }),
    );
    expect(honored).toEqual({ decision: "done", finalize: "graceful" });
    // Without a done proposal, the same stale failure still retries.
    expect(
      createFailureLedger(fakeHealth({ consecutive: 1 }), { pauseRetryBudget: 3 }).verdict(vin()).decision,
    ).toBe("retry");
  });

  it("LOW: policy clamps callStallMs above callHardMs and warns", () => {
    const { policy, warnings } = resolveRunBudgetPolicy("background", {
      streamInitialTimeoutMs: 100_000, // callHardMs
      streamStallTimeoutMs: 300_000, // > callHardMs
      providerFirstResponseMs: 90_000,
      taskInactivityMs: 10_000_000,
      minInactivityOverStreamRatio: 2,
      outputTokenCap: 1000,
      costCapUsd: 1,
    });
    expect(policy.callStallMs).toBe(100_000);
    expect(warnings.some((w) => w.includes("clamped"))).toBe(true);
  });

  it("F1: a non-finite call window arms no timer (no bogus stall under a real clock)", () => {
    const clock = new FakeClock(0);
    const rc = openRunClock(clock, POLICY({ taskHardMs: Number.POSITIVE_INFINITY }));
    rc.enterCall({
      firstResponseMs: Number.POSITIVE_INFINITY,
      stallMs: Number.POSITIVE_INFINITY,
      hardMs: Number.POSITIVE_INFINITY,
    });
    expect(clock.pendingTimers()).toBe(0);
    clock.advance(10_000_000);
    expect(rc.taskToken.aborted).toBe(false);
  });

  it("F2: entering a fresh call flushes an abandoned prior call's silent contribution", () => {
    const clock = new FakeClock(0);
    const rc = openRunClock(
      clock,
      POLICY({ callFirstResponseMs: 100_000, callHardMs: 100_000, taskHardMs: Number.POSITIVE_INFINITY }),
    );
    rc.enterCall({ firstResponseMs: 100_000, stallMs: 100_000, hardMs: 100_000 }); // abandoned, no leave()
    clock.advance(500);
    rc.enterCall({ firstResponseMs: 100_000, stallMs: 100_000, hardMs: 100_000 }); // must flush the prior
    expect(rc.accumulatedSilentMs()).toBe(500);
  });
});
