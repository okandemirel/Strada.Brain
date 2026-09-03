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

  it("names the failing tests from the red line itself", () => {
    const v = deriveTestVerdict([{
      content: "PlayMode verification FAILED: 2 of 179 tests failed (unfiltered — the whole PlayMode suite). " +
        "YourGame.PixelFlow.PlayModeTests.PixelFlowGameplayWinLossTests.LossLevel_ReachesLostState",
    }]);
    expect(v.testsGreen).toBe(false);
    expect(v.failedTests).toEqual([
      "YourGame.PixelFlow.PlayModeTests.PixelFlowGameplayWinLossTests.LossLevel_ReachesLostState",
    ]);
  });

  it("never names a test from a line that is not the red one", () => {
    // A runner that prints its whole suite after the summary must not have its
    // PASSING tests recorded as failures.
    const v = deriveTestVerdict([{
      content: [
        "PlayMode verification FAILED: 1 of 3 tests failed (unfiltered — the whole PlayMode suite). Game.Tests.BoardTests.Clears",
        "Game.Tests.BoardTests.Spawns ... PASSED",
        "Game.Tests.BoardTests.Scores ... PASSED",
      ].join("\n"),
    }]);
    expect(v.failedTests).toEqual(["Game.Tests.BoardTests.Clears"]);
  });

  it("bounds the list and counts the rest", () => {
    const names = Array.from({ length: 8 }, (_, i) => `Game.Tests.Fixture.Test${i}`).join(" ");
    const v = deriveTestVerdict([{ content: `PlayMode verification FAILED: 8 of 9 tests failed. ${names}` }]);
    expect(v.failedTests).toHaveLength(5);
    expect(v.failedTestsOmitted).toBe(3);
  });

  it("names nothing on a green run", () => {
    expect(deriveTestVerdict([{ content: "All 42 tests passed. Game.Tests.BoardTests.Clears" }]).failedTests)
      .toBeUndefined();
  });

  it("takes the scope from the LAST observation, not the body", () => {
    const v = deriveTestVerdict([
      { content: "PlayMode verification passed: 2 of 2 tests passed (filter: WinLoss)" },
      { content: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)" },
    ]);
    expect(v.unfiltered).toBe(true);
  });
});
