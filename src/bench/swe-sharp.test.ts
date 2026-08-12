/**
 * SWE-Sharp-Bench dataset decoding and resolution scoring.
 *
 * These are the two places the benchmark can be silently wrong rather than
 * loudly broken, so they are pure functions with their own tests instead of
 * logic buried in a script that only runs when .NET is installed.
 */

import { describe, it, expect } from "vitest";
import { parsePythonStringList, decodeTestList, selectSubset } from "./swe-sharp-dataset.js";
import {
  evaluateResolution,
  summarize,
  type TestOutcome,
  type TestReport,
} from "./swe-sharp-resolution.js";

function report(outcomes: Record<string, TestOutcome>, buildFailed = false): TestReport {
  return { outcomes: new Map(Object.entries(outcomes)), buildFailed };
}

describe("parsePythonStringList", () => {
  it("parses the single-quoted Python repr the dataset actually ships", () => {
    // This is the real shape from the HTTP rows API. JSON.parse throws on it,
    // which is how an earlier version silently produced empty test lists.
    expect(
      parsePythonStringList(
        "['Clean.Architecture.FunctionalTests.ControllerApis.ProjectCreate.CreateProject']",
      ),
    ).toEqual(["Clean.Architecture.FunctionalTests.ControllerApis.ProjectCreate.CreateProject"]);
  });

  it("parses multiple entries", () => {
    expect(parsePythonStringList("['A.B', 'C.D', 'E.F']")).toEqual(["A.B", "C.D", "E.F"]);
  });

  it("handles an empty list", () => {
    expect(parsePythonStringList("[]")).toEqual([]);
  });

  it("handles escaped quotes and double-quoted entries", () => {
    expect(parsePythonStringList(`['it\\'s', "other"]`)).toEqual(["it's", "other"]);
  });

  it("keeps commas that are inside a test name", () => {
    // Parameterised .NET test names carry their arguments, commas included.
    expect(parsePythonStringList("['Ns.Test(a: 1, b: 2)', 'Ns.Other']")).toEqual([
      "Ns.Test(a: 1, b: 2)",
      "Ns.Other",
    ]);
  });

  it("throws rather than returning an empty list it cannot justify", () => {
    // Failing soft here is what makes a task vacuously resolvable, so every
    // unparseable input must be loud.
    expect(() => parsePythonStringList("not a list")).toThrow();
    expect(() => parsePythonStringList("['unterminated")).toThrow();
    expect(() => parsePythonStringList("[unquoted]")).toThrow();
  });
});

describe("decodeTestList", () => {
  it("accepts an already-decoded array", () => {
    expect(decodeTestList(["A", "B"])).toEqual(["A", "B"]);
  });

  it("accepts the repr string", () => {
    expect(decodeTestList("['A']")).toEqual(["A"]);
  });

  it("rejects anything else instead of guessing", () => {
    expect(() => decodeTestList(null)).toThrow();
    expect(() => decodeTestList(42)).toThrow();
  });
});

describe("selectSubset", () => {
  const tasks = [
    ...Array.from({ length: 40 }, (_, i) => ({ instanceId: `a-${String(i).padStart(3, "0")}`, repo: "repoA" })),
    ...Array.from({ length: 40 }, (_, i) => ({ instanceId: `b-${String(i).padStart(3, "0")}`, repo: "repoB" })),
    ...Array.from({ length: 40 }, (_, i) => ({ instanceId: `c-${String(i).padStart(3, "0")}`, repo: "repoC" })),
    { instanceId: "d-000", repo: "repoD" },
  ];

  it("spreads across repositories instead of clustering", () => {
    // Sorting by id and slicing is deterministic but takes 50 tasks from ~2
    // repos, so the subset measures two codebases and generalises to nothing.
    const picked = selectSubset(tasks, 12);
    expect(new Set(picked.map((t) => t.repo)).size).toBe(4);
  });

  it("is deterministic regardless of input order", () => {
    const shuffled = [...tasks].reverse();
    expect(selectSubset(shuffled, 20)).toEqual(selectSubset(tasks, 20));
  });

  it("returns everything when asked for more than exists", () => {
    expect(selectSubset(tasks, 1000)).toHaveLength(tasks.length);
  });

  it("keeps drawing from the remaining repos once one is exhausted", () => {
    // repoD has a single task; the other repos must fill the rest rather than
    // the loop stopping early.
    expect(selectSubset(tasks, 30)).toHaveLength(30);
  });
});

describe("evaluateResolution", () => {
  it("resolves when every FAIL_TO_PASS passes and no PASS_TO_PASS regresses", () => {
    const result = evaluateResolution({
      failToPass: ["F1"],
      passToPass: ["P1", "P2"],
      report: report({ F1: "passed", P1: "passed", P2: "passed" }),
    });
    expect(result.resolved).toBe(true);
  });

  it("does not resolve when a PASS_TO_PASS test regresses", () => {
    // Without this half, deleting the failing assertion scores as a fix.
    const result = evaluateResolution({
      failToPass: ["F1"],
      passToPass: ["P1"],
      report: report({ F1: "passed", P1: "failed" }),
    });
    expect(result.resolved).toBe(false);
    expect(result.passToPassBroken).toEqual(["P1"]);
  });

  it("treats a test that did not run as not passing", () => {
    // Absent-as-passed is the single change that turns a broken run into a
    // perfect score: a patch that stops the suite from discovering a test
    // would otherwise resolve it.
    const result = evaluateResolution({
      failToPass: ["F1"],
      passToPass: ["P1"],
      report: report({ F1: "passed" }),
    });
    expect(result.resolved).toBe(false);
    expect(result.passToPassBroken).toEqual(["P1"]);
  });

  it("treats a skipped test as not passing", () => {
    // Adding [Skip] to the failing test is a plausible accident, and it must
    // not read as a fix.
    const result = evaluateResolution({
      failToPass: ["F1"],
      passToPass: [],
      report: report({ F1: "skipped" }),
    });
    expect(result.resolved).toBe(false);
    expect(result.failToPassMissing).toEqual(["F1"]);
  });

  it("fails everything when the build failed", () => {
    const result = evaluateResolution({
      failToPass: ["F1"],
      passToPass: ["P1"],
      report: report({}, true),
    });
    expect(result.resolved).toBe(false);
    expect(result.reason).toBe("build failed");
  });

  it("refuses to score a task with no FAIL_TO_PASS tests", () => {
    // This is what a fail-soft dataset decoder produces, and it would make
    // every task vacuously resolved.
    const result = evaluateResolution({ failToPass: [], passToPass: [], report: report({}) });
    expect(result.resolved).toBe(false);
    expect(result.reason).toMatch(/cannot be scored/);
  });
});

describe("TRX to resolution, end to end", () => {
  it("scores a real-shaped report against a real task's test lists", async () => {
    const { parseTrx } = await import("./trx-report.js");
    const { tasks } = (await import("../../benchmarks/swe-sharp/tasks.json", {
      with: { type: "json" },
    })).default as { tasks: Array<{ failToPass: string[]; passToPass: string[] }> };

    // Use the pinned dataset rather than invented names: this is the only
    // place the two halves meet, and the names in the dataset are exactly the
    // shape the matcher has to cope with.
    const task = tasks.find((t) => t.failToPass.length > 0 && t.passToPass.length > 0)!;
    const rows = [
      ...task.failToPass.map((n) => `<UnitTestResult testName="${n}" outcome="Passed" />`),
      ...task.passToPass.map((n) => `<UnitTestResult testName="${n}" outcome="Passed" />`),
    ].join("\n");
    const report = parseTrx(`<TestRun><Results>${rows}</Results></TestRun>`);

    expect(
      evaluateResolution({
        failToPass: task.failToPass,
        passToPass: task.passToPass,
        report: { outcomes: report.outcomes },
      }).resolved,
    ).toBe(true);

    // Flip one required test and the same task must stop resolving.
    const brokenRows = rows.replace('outcome="Passed"', 'outcome="Failed"');
    const broken = parseTrx(`<TestRun><Results>${brokenRows}</Results></TestRun>`);
    expect(
      evaluateResolution({
        failToPass: task.failToPass,
        passToPass: task.passToPass,
        report: { outcomes: broken.outcomes },
      }).resolved,
    ).toBe(false);
  });
});

describe("summarize", () => {
  it("reports the resolved rate over attempted tasks", () => {
    const results = [
      { instanceId: "a", result: evaluateResolution({ failToPass: ["F"], passToPass: [], report: report({ F: "passed" }) }) },
      { instanceId: "b", result: evaluateResolution({ failToPass: ["F"], passToPass: [], report: report({ F: "failed" }) }) },
      { instanceId: "c", result: evaluateResolution({ failToPass: ["F"], passToPass: [], report: report({}, true) }) },
    ];
    const summary = summarize(results);
    expect(summary).toMatchObject({ total: 3, resolved: 1, resolvedRate: 0.3333 });
    expect(summary.unresolvedIds).toEqual(["b", "c"]);
  });

  it("reports zero rather than dividing by zero on an empty run", () => {
    expect(summarize([]).resolvedRate).toBe(0);
  });
});
