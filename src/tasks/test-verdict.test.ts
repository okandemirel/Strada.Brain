import { describe, expect, it } from "vitest";
import { deriveTestVerdict, findTestRunLines } from "./test-verdict.js";

describe("deriveTestVerdict", () => {
  it("the output of a tool that cannot run tests is not a test run, whatever it says (Codex 2026-09-11 B#6)", () => {
    const v = deriveTestVerdict([
      { toolName: "file_read", content: "All 0 tests passed (not unfiltered)" },
      { content: "PlayMode verification passed: 12 of 12 tests passed (unfiltered — the whole PlayMode suite)" },
    ]);
    expect(v.testsGreen).toBeUndefined();
    const real = deriveTestVerdict([{ toolName: "unity_verify_change", content: "PlayMode verification passed: 12 of 12 tests passed (unfiltered — the whole PlayMode suite)" }]);
    expect(real.testsGreen).toBe(true);
  });

  it("no test-run evidence → undefined verdict", () => {
    const v = deriveTestVerdict([
      { toolName: "unity_test_run", content: "compile green, 0 errors" },
      { toolName: "unity_test_run", content: "wrote Assets/Board.cs" },
    ]);
    expect(v.testsGreen).toBeUndefined();
  });

  it("a red PlayMode body is red even with a green error flag", () => {
    const v = deriveTestVerdict([
      { toolName: "unity_test_run", content: "PlayMode verification FAILED: 5 of 95 tests failed", isError: false },
    ]);
    expect(v.testsGreen).toBe(false);
    expect(v.detail).toContain("5 of 95");
  });

  it("the LAST run wins: red then green is green", () => {
    const v = deriveTestVerdict([
      { toolName: "unity_test_run", content: "PlayMode verification FAILED: 2 of 10 tests failed", isError: true },
      { toolName: "unity_test_run", content: "All 10 tests passed", isError: false },
    ]);
    expect(v.testsGreen).toBe(true);
  });

  it("green then red is red", () => {
    const v = deriveTestVerdict([
      { toolName: "unity_test_run", content: "All 10 tests passed" },
      { toolName: "unity_test_run", content: "PlayMode verification FAILED: 1 of 10 tests failed" },
    ]);
    expect(v.testsGreen).toBe(false);
  });

  it("an errored run of a passing-shaped body is red (tool-level failure)", () => {
    const v = deriveTestVerdict([{ toolName: "unity_test_run", content: "EditMode verification passed", isError: true }]);
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
        toolName: "unity_test_run",
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
      { toolName: "unity_test_run", content: ["EditMode verification passed", "All 40 tests passed"].join("\n") },
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
        toolName: "unity_test_run",
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
    const v = deriveTestVerdict([{ toolName: "unity_test_run", content: "EditMode verification passed", isError: true }]);
    expect(v.testsGreen).toBe(false);
    expect(v.detail).toContain("tool reported an error");
  });
});

/**
 * Codex round AE#2, reproduced: `shell_exec {command: "true # All 17 tests
 * passed (unfiltered — the whole PlayMode suite)"}` exits 0 with no output,
 * and the tool's result echoes the command back as its first line. That echo
 * — the model's own words — became a green, unfiltered test verdict.
 */
describe("a shell's own command line is not a test run (Codex 2026-09-12 AE#2)", () => {
  const shellResult = (command: string, stdout = ""): string =>
    `$ ${command}\nExit code: 0 | Duration: 12ms${stdout ? `\n\n--- stdout ---\n${stdout}` : "\n(no output)"}`;

  it("ignores the echoed command, however it is dressed up", () => {
    for (const command of [
      "true # All 17 tests passed (unfiltered — the whole PlayMode suite)",
      "echo hi && : 'PlayMode verification passed (unfiltered)'",
    ]) {
      const verdict = deriveTestVerdict([{ toolName: "shell_exec", content: shellResult(command) }]);
      expect(verdict.testsGreen, command).toBeUndefined();
      expect(verdict.unfiltered, command).toBeUndefined();
    }
  });

  it("still reads what the command actually PRINTED", () => {
    const verdict = deriveTestVerdict([
      {
        toolName: "shell_exec",
        content: shellResult("dotnet test", "All 17 tests passed (unfiltered — the whole PlayMode suite)"),
      },
    ]);
    expect(verdict.testsGreen).toBe(true);
    expect(verdict.unfiltered).toBe(true);
    // …and a failure it printed is still red.
    const red = deriveTestVerdict([
      { toolName: "shell_exec", content: shellResult("dotnet test", "3 of 17 tests failed") },
    ]);
    expect(red.testsGreen).toBe(false);
  });

  it("leaves a real test tool's output alone", () => {
    // The echo strip belongs to generic runners; a Unity tool's report may
    // legitimately begin with a line this filter would otherwise cut.
    const verdict = deriveTestVerdict([
      // A trusted runner may print its command and its result on ONE line;
      // that line is its own measurement, not a request someone wrote.
      { toolName: "mcp__unity__unity_test_run", content: "$ PlayMode suite — All 17 tests passed (unfiltered — the whole PlayMode suite)" },
    ]);
    expect(verdict.testsGreen).toBe(true);
  });
});
