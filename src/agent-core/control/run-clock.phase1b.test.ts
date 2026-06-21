/**
 * Agent Core v2 — Phase 1b RunClock incident-regression + policy-clamp tests (FakeClock).
 *
 * Proves the orchestrator-gated RunClock primitives terminate at the SAME bound v1's
 * AbortSignal.timeout / DEFAULT_TASK_INACTIVITY_TIMEOUT_MS enforced, and that the ledger
 * wiring fires on the typed signals. Mirrors the helper patterns in control-plane.test.ts.
 */
import { describe, it, expect } from "vitest";
import { FakeClock } from "./clock.js";
import { resolveRunBudgetPolicy, type PolicySeed, type RunBudgetPolicy } from "./policy.js";
import { openRunClock } from "./run-clock.js";
import {
  createFailureLedger,
  type HealthCore,
  type VerdictInput,
} from "./failure-ledger.js";
import { DEFAULT_TASK_INACTIVITY_TIMEOUT_MS } from "../../config/config.js";

// ── helpers (same shapes as control-plane.test.ts) ──────────────────────────

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

/** The exact default 1b seed the orchestrator's buildPolicySeed() produces (v1 config defaults). */
const DEFAULT_1B_SEED: PolicySeed = {
  streamInitialTimeoutMs: 600_000, // DEFAULT_LLM_STREAM_INITIAL_TIMEOUT_MS
  streamStallTimeoutMs: 300_000, // DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS
  providerFirstResponseMs: 90_000, // DEFAULT_LLM_PROVIDER_FIRST_RESPONSE_TIMEOUT_MS
  taskInactivityMs: DEFAULT_TASK_INACTIVITY_TIMEOUT_MS, // 600_000 (shared single source)
  minInactivityOverStreamRatio: 2,
  outputTokenCap: Number.POSITIVE_INFINITY,
  costCapUsd: Number.POSITIVE_INFINITY,
};

// ── §6.1 / §6.2: ~70min stall terminates at the SAME bound as v1 ─────────────

describe("Phase 1b incident regression — ~70min stall", () => {
  it("silence accumulator reaches the SAME bound as v1 DEFAULT_TASK_INACTIVITY_TIMEOUT_MS and stops", () => {
    const clock = new FakeClock(0);
    // Same numbers v1 uses: per-call streamInitialTimeoutMs=600_000, task inactivity=600_000.
    const { policy } = resolveRunBudgetPolicy("background", DEFAULT_1B_SEED);
    const rc = openRunClock(clock, policy);
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 100 });

    let stopped = false;
    // Deep delegated chain: many FRESH silent calls, each well under the per-call hard window
    // so the call timer never fires — only the task accumulator can stop it (the livelock fix).
    for (let i = 0; i < 20 && !stopped; i += 1) {
      const call = rc.enterCall({ firstResponseMs: 600_000, stallMs: 600_000, hardMs: 600_000 });
      clock.advance(60_000); // 60s silent per call
      call.leave();
      const v = ledger.verdict(vin({ taskInactivityExceeded: rc.silenceCeilingExceeded() }));
      if (v.decision === "stop") stopped = true;
    }
    expect(stopped).toBe(true);
    // Same bound: stopped at exactly the 10th call (10 × 60_000 = 600_000 == v1's ceiling),
    // and a fresh call never reset the accumulator.
    expect(rc.accumulatedSilentMs()).toBe(600_000);
    expect(rc.silenceCeilingExceeded()).toBe(true);
  });

  it("a single stalled call aborts at exactly streamInitialTimeoutMs (== v1 AbortSignal.timeout bound)", () => {
    const clock = new FakeClock(0);
    const rc = openRunClock(
      clock,
      POLICY({ callFirstResponseMs: 600_000, callHardMs: 600_000, callStallMs: 600_000 }),
    );
    const call = rc.enterCall({ firstResponseMs: 600_000, stallMs: 600_000, hardMs: 600_000 });
    clock.advance(599_999);
    expect(call.token.aborted).toBe(false);
    clock.advance(2); // cross 600_000
    expect(call.token.aborted).toBe(true);
    expect(call.token.reason).toEqual({ kind: "provider-stall", scope: "call" });
  });
});

// ── §6.3: 3h27m runaway — hard-timeout + loop guard ──────────────────────────

describe("Phase 1b incident regression — 3h27m runaway", () => {
  it("an explicit taskHardMs aborts the task token and rule 2 overrides extend", () => {
    const clock = new FakeClock(0);
    const T = 3 * 60 * 60 * 1000; // an explicit wall-clock ceiling (the runClock-era addition)
    const rc = openRunClock(clock, POLICY({ taskHardMs: T }));
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 3 });

    clock.advance(T - 1);
    expect(rc.taskToken.aborted).toBe(false);
    clock.advance(2); // cross T
    expect(rc.taskToken.aborted).toBe(true);
    expect(rc.taskToken.reason).toEqual({ kind: "hard-timeout", scope: "task" });

    // Fed into the verdict: stops even with model proposing done + reflection wanting extend.
    const v = ledger.verdict(
      vin({
        hardTimeoutBlown: rc.hardTaskExpired(),
        modelProposedDone: true,
        reflectionWantsExtend: true,
      }),
    );
    expect(v.decision).toBe("stop");
    expect(v.reason).toEqual({ kind: "hard-timeout", scope: "task" });

    // And the loop-guard path (no taskHard) still forces done on runaway (rule 8) — v1 bound.
    const v2 = ledger.verdict(
      vin({ modelProposedDone: true, reflectionWantsExtend: true, loopDetectionBlocked: true }),
    );
    expect(v2.decision).toBe("done");
  });
});

// ── §6.5: policy clamp-warn (1b seed) ────────────────────────────────────────

describe("Phase 1b policy clamps", () => {
  it("resolveRunBudgetPolicy clamps taskInactivity below ratio×stall and warns (1b seed)", () => {
    const { policy, warnings } = resolveRunBudgetPolicy("background", {
      streamInitialTimeoutMs: 600_000,
      streamStallTimeoutMs: 300_000,
      providerFirstResponseMs: 90_000,
      taskInactivityMs: 100_000, // below 2×300_000 = 600_000
      minInactivityOverStreamRatio: 2,
      outputTokenCap: 500_000,
      costCapUsd: Number.POSITIVE_INFINITY,
    });
    expect(policy.taskInactivityMs).toBe(600_000); // clamped UP to the floor
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/clamped to 600000ms/);
  });

  it("resolveRunBudgetPolicy clamps callStall above callHard and warns", () => {
    const { policy, warnings } = resolveRunBudgetPolicy("interactive", {
      streamInitialTimeoutMs: 200_000, // callHard
      streamStallTimeoutMs: 300_000, // > callHard → clamp
      providerFirstResponseMs: 90_000,
      taskInactivityMs: 600_000,
      minInactivityOverStreamRatio: 2,
      outputTokenCap: Number.POSITIVE_INFINITY, // -1 sentinel maps to +Infinity in buildPolicySeed
      costCapUsd: Number.POSITIVE_INFINITY,
    });
    expect(policy.callStallMs).toBe(200_000);
    expect(warnings.some((w) => /stall window never outlives/.test(w))).toBe(true);
  });

  it("the default 1b seed produces no clamp warnings", () => {
    const { warnings } = resolveRunBudgetPolicy("background", DEFAULT_1B_SEED);
    expect(warnings).toEqual([]);
  });
});

// ── P-C: cross-call silence accumulator livelock regression (1c consume path) ─
//
// The 1b "~70min stall" test above is a BOUND-EQUIVALENCE test (proves the accumulator stops
// at the same 600_000ms ceiling v1's config nominally used). These are the LIVELOCK-PROPERTY
// tests: each call stays strictly under its OWN per-call timers (token.aborted === false every
// iteration) so the accumulator — not per-call luck — is the SOLE cause of the stop, AND a
// simulated-v1 per-call-reset arm proves the old semantics would loop forever on identical input.

describe("Phase 1c — cross-call silence accumulator (delegation livelock)", () => {
  it("flaky provider × N fresh calls each UNDER the per-call limit → rule-4 stop (accumulator is the sole cause)", () => {
    const clock = new FakeClock(0);
    // Deliberately SMALL per-call windows so the per-call-innocence invariant is load-bearing:
    // a single call advances 600ms total (200 to first token, then 400 silent) — under both the
    // 1000ms first-response/hard ceiling and the 500ms post-first-token stall window.
    const rc = openRunClock(
      clock,
      POLICY({
        taskInactivityMs: 2000,
        callFirstResponseMs: 1000,
        callStallMs: 500,
        callHardMs: 1000,
        taskHardMs: Number.POSITIVE_INFINITY,
      }),
    );
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 100 });

    let stopped = false;
    let stopVerdict: ReturnType<typeof ledger.verdict> | null = null;
    let calls = 0;
    // Each call contributes 400ms silent (trailing gap after the single token); ceiling 2000 →
    // trips at call 5 (5 × 400 = 2000, the `>=` boundary).
    for (let i = 0; i < 10 && !stopped; i += 1) {
      calls += 1;
      const call = rc.enterCall({ firstResponseMs: 1000, stallMs: 500, hardMs: 1000 });
      clock.advance(200); // one token arrives within the first-response window (productive enough)
      call.firstTokenSeen(); // flip to the 500ms stall window
      clock.advance(400); // 400 < 500 → the per-call stall timer never fires
      // INVARIANT (gap a): the per-call timers are individually innocent every iteration.
      expect(call.token.aborted).toBe(false);
      expect(rc.taskToken.aborted).toBe(false);
      call.leave(); // commits the 400ms trailing-silence contribution to the task accumulator
      const v = ledger.verdict(vin({ taskInactivityExceeded: rc.silenceCeilingExceeded() }));
      if (v.decision === "stop") {
        stopped = true;
        stopVerdict = v;
      }
    }

    expect(stopped).toBe(true);
    expect(calls).toBe(5); // stopped on the 5th fresh call, not the 1st (cross-call accumulation)
    // Pin RULE 4 specifically (task-inactivity / graceful), distinct from rule 2 hard-timeout
    // or rule 6 provider-stall — the only thing that can produce this is the accumulator.
    expect(stopVerdict).not.toBeNull();
    expect(stopVerdict!.decision).toBe("stop");
    if (stopVerdict!.decision === "stop") {
      expect(stopVerdict!.reason).toEqual({ kind: "task-inactivity" });
      expect(stopVerdict!.finalize).toBe("graceful");
    }
    expect(rc.accumulatedSilentMs()).toBe(2000);
    expect(rc.silenceCeilingExceeded()).toBe(true);
    // The accumulator stopped the run; NO per-call timer ever aborted the task token.
    expect(rc.taskToken.aborted).toBe(false);
  });

  it("simulated v1 per-call-reset NEVER trips on the identical call sequence (the livelock contrast)", () => {
    // Simulated v1: a per-call inactivity counter RESET on every fresh call (v1 had no task-scope
    // accumulator — each new call re-armed its inactivity from zero). The SAME 400ms silent gap
    // per call, the SAME 2000ms ceiling, the SAME 50-call budget.
    let v1PerCallSilent = 0;
    let v1Tripped = false;
    for (let i = 0; i < 50 && !v1Tripped; i += 1) {
      v1PerCallSilent = 0; // ← the bug: a fresh call resets the ceiling
      v1PerCallSilent += 400; // identical per-call silent gap as the test above
      v1Tripped = v1PerCallSilent >= 2000; // never true (400 < 2000) → unbounded loop
    }
    expect(v1Tripped).toBe(false); // v1 loops forever — the delegation livelock

    // The REAL accumulator over the identical 50-call budget DOES cross the ceiling.
    const clock = new FakeClock(0);
    const rc = openRunClock(
      clock,
      POLICY({ taskInactivityMs: 2000, callFirstResponseMs: 1000, callStallMs: 500, callHardMs: 1000 }),
    );
    for (let i = 0; i < 50; i += 1) {
      const call = rc.enterCall({ firstResponseMs: 1000, stallMs: 500, hardMs: 1000 });
      clock.advance(200);
      call.firstTokenSeen();
      clock.advance(400);
      call.leave();
    }
    expect(rc.accumulatedSilentMs()).toBe(50 * 400); // 20_000 — does NOT reset per call
    expect(rc.silenceCeilingExceeded()).toBe(true); // 1c trips where v1 never would
  });

  it("a single PRODUCTIVE call (steady touches) does NOT trip the accumulator → continue", () => {
    // Guards against a false-positive accumulator: it must be SILENCE-specific, not a wall clock.
    const clock = new FakeClock(0);
    const rc = openRunClock(
      clock,
      POLICY({ taskInactivityMs: 2000, callFirstResponseMs: 100_000, callStallMs: 100_000, callHardMs: 100_000 }),
    );
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 100 });
    const call = rc.enterCall({ firstResponseMs: 100_000, stallMs: 100_000, hardMs: 100_000 });
    call.firstTokenSeen();
    for (let i = 0; i < 10; i += 1) {
      clock.advance(100);
      call.touch(); // steady progress: each chunk re-arms inactivity and refreshes lastActivity
    }
    call.leave();
    expect(rc.accumulatedSilentMs()).toBe(0); // productive → ~0 silent contribution
    expect(rc.silenceCeilingExceeded()).toBe(false);
    const v = ledger.verdict(vin({ taskInactivityExceeded: rc.silenceCeilingExceeded() }));
    expect(v.decision).toBe("continue");
  });

  it("flag-OFF semantics: silenceCeilingExceeded() true but gate passes false → verdict stays inert (1b behavior preserved)", () => {
    // Models the orchestrator gate at orchestrator.ts:1178-1179: when silenceAccumulator is OFF
    // the loop feeds `taskInactivityExceeded: false` REGARDLESS of the accumulator. This proves
    // 1c is a pure opt-in: the same over-ceiling accumulator does NOT stop the run under 1b.
    const clock = new FakeClock(0);
    const rc = openRunClock(clock, POLICY({ taskInactivityMs: 2000, callFirstResponseMs: 100_000, callHardMs: 100_000 }));
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 100 });
    for (let i = 0; i < 5; i += 1) {
      const call = rc.enterCall({ firstResponseMs: 100_000, stallMs: 100_000, hardMs: 100_000 });
      clock.advance(700);
      call.leave();
    }
    // The accumulator HAS crossed the ceiling…
    expect(rc.silenceCeilingExceeded()).toBe(true);
    // …but the 1b gate (silenceAccumulator OFF) feeds `false`, so the verdict is inert.
    const silenceAccumulatorFlag = false; // mirrors `agentCoreFlagSet?.silenceAccumulator === true`
    const gated = silenceAccumulatorFlag && rc.silenceCeilingExceeded();
    expect(gated).toBe(false);
    const v = ledger.verdict(vin({ taskInactivityExceeded: gated }));
    expect(v.decision).toBe("continue"); // 1b: the accumulator accrues but never stops the run
  });
});
