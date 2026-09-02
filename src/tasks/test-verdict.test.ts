import { describe, expect, it } from "vitest";
import { deriveTestVerdict, findTestRunLines } from "./test-verdict.js";

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

describe("findTestRunLines", () => {
  it("returns EVERY test-run line, not only the first", () => {
    // Audited 2026-09-02: the verdict read only the FIRST matching line, so a
    // combined Unity report whose head passed and whose tail failed was
    // reported with a green-sounding detail beside a red verdict.
    const lines = findTestRunLines(
      [
        "EditMode verification passed",
        "  (12 assemblies compiled)",
        "PlayMode verification FAILED — 3 of 40 tests failed",
      ].join("\n"),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("EditMode verification passed");
    expect(lines[1]).toContain("3 of 40 tests failed");
  });

  it("returns [] for text holding no test-run observation", () => {
    expect(findTestRunLines("compile green, 0 errors")).toEqual([]);
  });
});

describe("deriveTestVerdict within one tool result", () => {
  it("a head that passed and a tail that FAILED is red, and the detail is the RED line", () => {
    // The rejected scenario. testsGreen was already false (RED_RE scans the
    // whole body), but `detail` named the FIRST matching line — "EditMode
    // verification passed" — so the campaign's own rejection message read
    // "Tests were RED at completion: EditMode verification passed".
    const v = deriveTestVerdict([
      {
        content: [
          "EditMode verification passed",
          "Running PlayMode suite…",
          "PlayMode verification FAILED — 3 of 40 tests failed",
        ].join("\n"),
      },
    ]);
    expect(v.testsGreen).toBe(false);
    expect(v.detail).toContain("3 of 40 tests failed");
    expect(v.detail).not.toContain("EditMode verification passed");
  });

  it("an all-green body names the LAST green observation", () => {
    const v = deriveTestVerdict([
      { content: ["EditMode verification passed", "All 40 tests passed"].join("\n") },
    ]);
    expect(v.testsGreen).toBe(true);
    expect(v.detail).toBe("All 40 tests passed");
  });

  it("a red line anywhere in ONE result stays red even when a green section follows it", () => {
    // One tool result is ONE observation, not a chronology: a combined report
    // that prints its PlayMode failure before its EditMode pass is still a red
    // run. Chronology lives ACROSS results, where last-observation-wins.
    const v = deriveTestVerdict([
      {
        content: [
          "PlayMode verification FAILED — 3 of 40 tests failed",
          "EditMode verification passed",
        ].join("\n"),
      },
    ]);
    expect(v.testsGreen).toBe(false);
    expect(v.detail).toContain("3 of 40 tests failed");
  });

  it("a tool-level error on a green-shaped body says so in the detail", () => {
    const v = deriveTestVerdict([{ content: "EditMode verification passed", isError: true }]);
    expect(v.testsGreen).toBe(false);
    expect(v.detail).toContain("tool reported an error");
  });
});
