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
  taskInactivityMs: 600_000, // PHASE1B_TASK_INACTIVITY_MS
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
