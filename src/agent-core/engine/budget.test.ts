import { describe, it, expect } from "vitest";
import {
  canAutoContinueBackgroundEpoch,
  canAutoContinueInteractiveEpoch,
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
