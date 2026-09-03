import { describe, expect, it } from "vitest";
import { deriveTestVerdict } from "./test-verdict.js";

/**
 * Audited 2026-09-03: the delivered PixelFlow campaign's filtered runs were
 * green while its one unfiltered run reported 6 of 173 failing, including
 * WinLevel_ReachesWonState ("LevelWon event did not fire"). Delivery must be
 * able to tell a chosen subset from the whole suite.
 */
describe("test verdict run scope", () => {
  it("reads unfiltered off the winning line", () => {
    const v = deriveTestVerdict([
      { content: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)" },
    ]);
    expect(v.testsGreen).toBe(true);
    expect(v.unfiltered).toBe(true);
  });

  it("marks a filtered green as filtered", () => {
    const v = deriveTestVerdict([
      { content: "PlayMode verification passed: 2 of 2 tests passed (filter: PixelFlowGameplayWinLossTests)" },
    ]);
    expect(v.testsGreen).toBe(true);
    expect(v.unfiltered).toBe(false);
  });

  it("leaves the scope undefined when the line says neither", () => {
    expect(deriveTestVerdict([{ content: "All 42 tests passed" }]).unfiltered).toBeUndefined();
  });

  it("takes the scope from the LAST observation, not the body", () => {
    const v = deriveTestVerdict([
      { content: "PlayMode verification passed: 2 of 2 tests passed (filter: WinLoss)" },
      { content: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)" },
    ]);
    expect(v.unfiltered).toBe(true);
  });
});
