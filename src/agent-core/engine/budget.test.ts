import { describe, it, expect } from "vitest";
import {
  canAutoContinueBackgroundEpoch,
  canAutoContinueInteractiveEpoch,
  buildPolicySeed,
  resolveLiveCostCapUsd,
  type BudgetDeps,
} from "./budget.js";


describe("an interactive run that was asked to work to a finish line", () => {
  // Measured 2026-08-20: interactive was hard-capped at a single epoch, so a
  // run that spent its iteration budget stopped and asked for a follow-up —
  // where the identical background run rolled over and carried on. "Build the
  // game this document describes" arrives through the interactive path, and
  // stopping it half-built helps nobody.
  //
  // Off by default, because an ordinary chat turn that stops and asks is
  // right, and a provider stuck calling tools must not spin forever.
  function deps(interactiveAutoContinue: boolean, backgroundMaxEpochs = 0): never {
    return {
      taskConfig: { interactiveAutoContinue, backgroundAutoContinue: true, backgroundMaxEpochs },
    } as never;
  }

  it("does not continue unless it was switched on", () => {
    expect(canAutoContinueInteractiveEpoch(deps(false), 1)).toBe(false);
  });

  it("continues when it was", () => {
    expect(canAutoContinueInteractiveEpoch(deps(true), 1)).toBe(true);
  });

  it("still honours the epoch cap", () => {
    expect(canAutoContinueInteractiveEpoch(deps(true, 3), 2)).toBe(true);
    expect(canAutoContinueInteractiveEpoch(deps(true, 3), 3)).toBe(false);
  });

  it("treats a cap of zero as no cap", () => {
    expect(canAutoContinueInteractiveEpoch(deps(true, 0), 9999)).toBe(true);
  });

  it("is independent of the background switch", () => {
    const onlyBackground = { taskConfig: { interactiveAutoContinue: false, backgroundAutoContinue: true, backgroundMaxEpochs: 0 } } as never;

    expect(canAutoContinueInteractiveEpoch(onlyBackground, 1)).toBe(false);
    expect(canAutoContinueBackgroundEpoch(onlyBackground, 1)).toBe(true);
  });
});

describe("the run's USD cost cap, resolved from the unified budget manager", () => {
  // Measured 2026-08-23: buildPolicySeed hardcoded costCapUsd=Infinity, so a long
  // autonomous build ("develop this GDD end to end") could overshoot the user's
  // daily/monthly limits without bound — enforcement existed only post-hoc, at the
  // next daemon heartbeat. The seed now carries the REMAINING global headroom and
  // the control-plane verdict stops the run ("budget-exhausted") before further spend.
  function depsWithSnapshot(snapshot: object | undefined): BudgetDeps {
    return {
      unifiedBudgetManager: () => (snapshot === undefined ? null : { getSnapshot: () => snapshot }),
      taskConfig: {},
      streamInitialTimeoutMs: 0,
      streamStallTimeoutMs: 0,
    } as never;
  }

  const snap = (dailyUsed: number, dailyLimit: number, monthlyUsed: number, monthlyLimit: number) => ({
    global: {
      daily: { usedUsd: dailyUsed, limitUsd: dailyLimit },
      monthly: { usedUsd: monthlyUsed, limitUsd: monthlyLimit },
    },
  });

  it("is unbounded when no manager is wired (historical behavior)", () => {
    expect(resolveLiveCostCapUsd(depsWithSnapshot(undefined))).toBe(Number.POSITIVE_INFINITY);
  });

  it("is unbounded when no global limits are configured", () => {
    expect(resolveLiveCostCapUsd(depsWithSnapshot(snap(5, 0, 50, 0)))).toBe(Number.POSITIVE_INFINITY);
  });

  it("is the remaining headroom of the binding window", () => {
    expect(resolveLiveCostCapUsd(depsWithSnapshot(snap(3, 10, 40, 100)))).toBeCloseTo(7);
  });

  it("takes the tighter of daily and monthly", () => {
    expect(resolveLiveCostCapUsd(depsWithSnapshot(snap(3, 10, 98, 100)))).toBeCloseTo(2);
  });

  it("floors at zero once a limit is already exceeded — the next gate tick stops the run", () => {
    expect(resolveLiveCostCapUsd(depsWithSnapshot(snap(12, 10, 0, 0)))).toBe(0);
  });

  it("seeds the control plane so an exhausted budget stops the run before further spend", () => {
    const seed = buildPolicySeed({
      unifiedBudgetManager: () => ({ getSnapshot: () => snap(9, 10, 0, 0) }),
      taskConfig: { interactiveTokenBudget: -1 },
      streamInitialTimeoutMs: 0,
      streamStallTimeoutMs: 0,
    } as never);

    expect(seed.costCapUsd).toBeCloseTo(1);
  });
});
