/**
 * Agent Core v2 — Phase 1d: typed `taskCancelReason` adoption.
 *
 * 1d's whole mechanism is a single flag-gated field: `buildPhase1bVerdictInput` stops
 * hardcoding `taskCancelReason: null` and feeds the RunClock-owned task-token reason
 * through to the verdict ONLY when `agentCoreFlagSet.typedCancelReason === true`. That
 * field is exactly what makes FailureLedger verdict rules 1 (benign cancel → stop/graceful,
 * no health failure) and 1b (any other task-token abort → AUTHORITATIVE stop) reachable.
 *
 * This suite proves, at the two layers 1d touches:
 *   (A) the ledger verdict itself — rules 1/1b fire for a fed reason, and stay DEAD when the
 *       field is null (the flag-OFF surface, byte-identical to 1b/1c); benign cancels never
 *       poison health; rule 1b short-circuits ahead of the re-derived booleans (rules 2–4).
 *   (B) the orchestrator's flag gate — modeled exactly as the 1c gate is modeled in
 *       run-clock.phase1b.test.ts: an aborted RunClock task token feeds its typed reason
 *       only when the flag is ON; OFF feeds null and the verdict stays inert.
 */
import { describe, expect, it } from "vitest";
import { FakeClock } from "./clock.js";
import { openRunClock } from "./run-clock.js";
import { resolveRunBudgetPolicy, type PolicySeed } from "./policy.js";
import {
  createFailureLedger,
  type HealthCore,
  type VerdictInput,
} from "./failure-ledger.js";
import type { CancelReason } from "./cancel-reason.js";
import { isBenign } from "./cancel-reason.js";
import { DEFAULT_TASK_INACTIVITY_TIMEOUT_MS } from "../../config/config.js";

// ── helpers (same shapes as the sibling phase suites) ────────────────────────

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

/**
 * The exact field expression at orchestrator.ts buildPhase1bVerdictInput:
 *   `this.agentCoreFlagSet?.typedCancelReason === true ? (taskReason ?? null) : null`
 * Modeled here as a pure fn so the gate's truth table is pinned without booting the loop.
 */
function gatedTaskCancelReason(
  typedCancelReasonFlag: boolean,
  taskReason: CancelReason | null,
): CancelReason | null {
  return typedCancelReasonFlag ? (taskReason ?? null) : null;
}

const DEFAULT_1B_SEED: PolicySeed = {
  streamInitialTimeoutMs: 600_000,
  streamStallTimeoutMs: 300_000,
  providerFirstResponseMs: 90_000,
  taskInactivityMs: DEFAULT_TASK_INACTIVITY_TIMEOUT_MS,
  minInactivityOverStreamRatio: 2,
  outputTokenCap: Number.POSITIVE_INFINITY,
  costCapUsd: Number.POSITIVE_INFINITY,
};

// ── (A) ledger verdict — rules 1 / 1b that 1d makes reachable ────────────────

describe("verdict() — Phase 1d typed taskCancelReason (rules 1 / 1b)", () => {
  it("rule 1: a BENIGN task abort (task-winddown) → stop/graceful and NEVER a health failure", () => {
    const stub = fakeHealth();
    const ledger = createFailureLedger(stub, { pauseRetryBudget: 3 });
    const reason: CancelReason = { kind: "task-winddown" };
    expect(isBenign(reason)).toBe(true); // precondition: classifier agrees it is benign

    const v = ledger.verdict(vin({ taskCancelReason: reason }));
    expect(v.decision).toBe("stop");
    if (v.decision === "stop") {
      expect(v.finalize).toBe("graceful");
      expect(v.reason).toEqual(reason); // carries the typed reason through, not a string
    }
  });

  it("rule 1: user-cancel and first-success-satisfied are also benign stop/graceful", () => {
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 3 });
    for (const reason of [
      { kind: "user-cancel" },
      { kind: "first-success-satisfied" },
    ] as const) {
      const v = ledger.verdict(vin({ taskCancelReason: reason }));
      expect(v.decision).toBe("stop");
      if (v.decision === "stop") {
        expect(v.finalize).toBe("graceful");
        expect(v.reason).toEqual(reason);
      }
    }
  });

  it("rule 1b: a non-benign task abort (hard-timeout/task) → AUTHORITATIVE stop/graceful", () => {
    const reason: CancelReason = { kind: "hard-timeout", scope: "task" };
    expect(isBenign(reason)).toBe(false);
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 3 });
    const v = ledger.verdict(vin({ taskCancelReason: reason }));
    expect(v.decision).toBe("stop");
    if (v.decision === "stop") {
      expect(v.finalize).toBe("graceful");
      expect(v.reason).toEqual(reason);
    }
  });

  it("rule 1b short-circuits AHEAD of the re-derived booleans (rules 2–4 not yet caught up)", () => {
    // The self-defending property: the token is aborted but the loop's derived booleans
    // (hardTimeoutBlown / taskInactivityExceeded / callStalled) are all still false — a
    // between-tick fire. Rule 1b must stop on the carried reason regardless.
    const reason: CancelReason = { kind: "hard-timeout", scope: "task" };
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 3 });
    const v = ledger.verdict(
      vin({
        taskCancelReason: reason,
        hardTimeoutBlown: false,
        taskInactivityExceeded: false,
        callStalled: false,
      }),
    );
    expect(v.decision).toBe("stop");
    if (v.decision === "stop") expect(v.reason).toEqual(reason);
  });

  it("rule 1b: a budget-exhausted task reason stops authoritatively too", () => {
    const reason: CancelReason = { kind: "budget-exhausted", resource: "tokens" };
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 3 });
    const v = ledger.verdict(vin({ taskCancelReason: reason }));
    expect(v.decision).toBe("stop");
    if (v.decision === "stop") expect(v.reason).toEqual(reason);
  });

  it("rule 1 wins over the health terminators: a benign cancel + health-abort still stops GRACEFULLY", () => {
    // Precedence proof: rule 1 sits ABOVE rule 5 (shouldAbort → hard). A benign cancel that
    // coincides with a poisoned health window must NOT be reclassified as a hard health stop.
    const stub = fakeHealth({ shouldAbort: () => true, consecutive: 5 });
    const ledger = createFailureLedger(stub, { pauseRetryBudget: 3 });
    const reason: CancelReason = { kind: "user-cancel" };
    const v = ledger.verdict(vin({ taskCancelReason: reason }));
    expect(v.decision).toBe("stop");
    if (v.decision === "stop") {
      expect(v.finalize).toBe("graceful"); // rule 1, not rule 5's "hard"
      expect(v.reason).toEqual(reason);
    }
  });
});

// ── (A') flag-OFF surface — rules 1/1b DEAD when the field is null ───────────

describe("verdict() — Phase 1d flag-OFF: taskCancelReason null keeps rules 1/1b dead", () => {
  it("null taskCancelReason → verdict collapses to the 1c surface (continue when healthy)", () => {
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 3 });
    // Exactly the inert field 1b/1c feed: rules 1/1b cannot match on null.
    expect(ledger.verdict(vin({ taskCancelReason: null })).decision).toBe("continue");
  });

  it("with the field null, a benign-looking concurrent state is governed by the OTHER rules only", () => {
    // Even if a hard timeout HAS blown, with taskCancelReason null the stop comes from rule 2
    // (hard-timeout) — proving rule 1b is not what fired (it is dead while the field is null).
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 3 });
    const v = ledger.verdict(vin({ taskCancelReason: null, hardTimeoutBlown: true }));
    expect(v.decision).toBe("stop");
    if (v.decision === "stop") {
      // rule 2 synthesizes the reason from hardTimeoutScope; it is NOT carried from a token.
      expect(v.reason).toEqual({ kind: "hard-timeout", scope: "task" });
    }
  });
});

// ── (B) the orchestrator flag gate — the 1d field expression truth table ─────

describe("Phase 1d orchestrator gate — buildPhase1bVerdictInput taskCancelReason field", () => {
  it("flag ON + aborted task token → feeds the token's typed reason; rule 1b stop", () => {
    const clock = new FakeClock(0);
    const { policy } = resolveRunBudgetPolicy("background", {
      ...DEFAULT_1B_SEED,
      // Give the task an explicit wall-clock ceiling so the RunClock writes a real reason.
    });
    const rc = openRunClock(clock, { ...policy, taskHardMs: 1000 });
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 3 });

    clock.advance(1001); // cross the task hard ceiling → token aborts, reason written
    expect(rc.taskToken.aborted).toBe(true);
    expect(rc.taskToken.reason).toEqual({ kind: "hard-timeout", scope: "task" });

    // Flag ON: the gate feeds the live token reason.
    const fed = gatedTaskCancelReason(true, rc.taskToken.reason);
    expect(fed).toEqual({ kind: "hard-timeout", scope: "task" });
    const v = ledger.verdict(vin({ taskCancelReason: fed }));
    expect(v.decision).toBe("stop"); // rule 1b
    if (v.decision === "stop") expect(v.reason).toEqual({ kind: "hard-timeout", scope: "task" });
  });

  it("flag ON + benign winddown token (dispose) → rule 1 stop/graceful", () => {
    const clock = new FakeClock(0);
    const { policy } = resolveRunBudgetPolicy("background", DEFAULT_1B_SEED);
    const rc = openRunClock(clock, policy);
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 3 });

    rc.dispose(); // clean teardown aborts the task token as `task-winddown` (benign)
    expect(rc.taskToken.aborted).toBe(true);
    expect(rc.taskToken.reason).toEqual({ kind: "task-winddown" });

    const fed = gatedTaskCancelReason(true, rc.taskToken.reason);
    const v = ledger.verdict(vin({ taskCancelReason: fed }));
    expect(v.decision).toBe("stop");
    if (v.decision === "stop") {
      expect(v.finalize).toBe("graceful");
      expect(v.reason).toEqual({ kind: "task-winddown" });
    }
  });

  it("flag OFF + SAME aborted task token → feeds null; verdict stays inert (1b/1c preserved)", () => {
    const clock = new FakeClock(0);
    const { policy } = resolveRunBudgetPolicy("background", DEFAULT_1B_SEED);
    const rc = openRunClock(clock, { ...policy, taskHardMs: 1000 });
    const ledger = createFailureLedger(fakeHealth(), { pauseRetryBudget: 3 });

    clock.advance(1001);
    // The token IS aborted with a real reason…
    expect(rc.taskToken.aborted).toBe(true);
    expect(rc.taskToken.reason).toEqual({ kind: "hard-timeout", scope: "task" });

    // …but flag OFF feeds null REGARDLESS of the token (mirrors the orchestrator gate).
    const fed = gatedTaskCancelReason(false, rc.taskToken.reason);
    expect(fed).toBeNull();
    // With taskCancelReason null, rule 1b is dead. Here taskHardMs blew, so the stop (if any)
    // would come from rule 2 via hardTaskExpired — NOT from the typed-cancel rule. Feeding the
    // verdict with hardTimeoutBlown:false (the gate-only view) → continue, proving 1d-OFF adds
    // nothing: the run only stops through the 1b derived-boolean path, exactly as before 1d.
    const v = ledger.verdict(vin({ taskCancelReason: fed, hardTimeoutBlown: false }));
    expect(v.decision).toBe("continue");
  });

  it("the gate truth table is total: ON↔reason passthrough, OFF↔null, null token↔null", () => {
    const reason: CancelReason = { kind: "verdict-stop", cause: "loop-detected" };
    expect(gatedTaskCancelReason(true, reason)).toEqual(reason);
    expect(gatedTaskCancelReason(true, null)).toBeNull();
    expect(gatedTaskCancelReason(false, reason)).toBeNull();
    expect(gatedTaskCancelReason(false, null)).toBeNull();
  });
});
