import { describe, expect, it } from "vitest";
import { deriveTestVerdict } from "./test-verdict.js";

describe("deriveTestVerdict", () => {
  it("no test-run evidence → undefined verdict", () => {
    const v = deriveTestVerdict([
      { content: "compile green, 0 errors" },
      { content: "wrote Assets/Board.cs" },
    ]);
    expect(v.testsGreen).toBeUndefined();
  });

  it("a red PlayMode body is red even with a green error flag", () => {
    const v = deriveTestVerdict([
      { content: "PlayMode verification FAILED: 5 of 95 tests failed", isError: false },
    ]);
    expect(v.testsGreen).toBe(false);
    expect(v.detail).toContain("5 of 95");
  });

  it("the LAST run wins: red then green is green", () => {
    const v = deriveTestVerdict([
      { content: "PlayMode verification FAILED: 2 of 10 tests failed", isError: true },
      { content: "All 10 tests passed", isError: false },
    ]);
    expect(v.testsGreen).toBe(true);
  });

  it("green then red is red", () => {
    const v = deriveTestVerdict([
      { content: "All 10 tests passed" },
      { content: "PlayMode verification FAILED: 1 of 10 tests failed" },
    ]);
    expect(v.testsGreen).toBe(false);
  });

  it("an errored run of a passing-shaped body is red (tool-level failure)", () => {
    const v = deriveTestVerdict([{ content: "EditMode verification passed", isError: true }]);
    expect(v.testsGreen).toBe(false);
  });
});
