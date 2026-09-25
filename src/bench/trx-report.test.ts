/**
 * TRX report parsing.
 *
 * This is the bridge between running a SWE-Sharp-Bench task with
 * `dotnet test --logger trx` and scoring it. Both directions of error are
 * dangerous: a parser that loses results makes a good run look broken, and one
 * that treats an unknown status as a pass makes a broken run look good.
 */

import { describe, it, expect } from "vitest";
import { parseTrx, findOutcome } from "./trx-report.js";

/** Shaped like the real thing, trimmed to the elements that are read. */
function trx(results: string, counters?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<TestRun id="x" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
${results}
  </Results>
  <ResultSummary outcome="Completed">
    ${counters ?? '<Counters total="3" executed="3" passed="2" failed="1" />'}
  </ResultSummary>
</TestRun>`;
}

describe("parseTrx", () => {
  it("reads outcomes for each test", () => {
    const { outcomes, hasResults } = parseTrx(
      trx(`
    <UnitTestResult testId="1" testName="Ns.A.Passes" outcome="Passed" duration="00:00:00.1" />
    <UnitTestResult testId="2" testName="Ns.A.Fails" outcome="Failed" duration="00:00:00.1" />
    <UnitTestResult testId="3" testName="Ns.A.Skipped" outcome="NotExecuted" />`),
    );
    expect(hasResults).toBe(true);
    expect(outcomes.get("Ns.A.Passes")).toBe("passed");
    expect(outcomes.get("Ns.A.Fails")).toBe("failed");
    expect(outcomes.get("Ns.A.Skipped")).toBe("skipped");
  });

  it("maps every failure-ish TRX status to failed", () => {
    const { outcomes } = parseTrx(
      trx(`
    <UnitTestResult testName="T.Error" outcome="Error" />
    <UnitTestResult testName="T.Timeout" outcome="Timeout" />
    <UnitTestResult testName="T.Aborted" outcome="Aborted" />`),
    );
    expect([...outcomes.values()]).toEqual(["failed", "failed", "failed"]);
  });

  it("treats an unrecognised outcome as failed, never as a pass", () => {
    // A new TRX status should make a run look worse and get investigated,
    // rather than silently counting as green.
    const { outcomes } = parseTrx(trx(`    <UnitTestResult testName="T.Weird" outcome="Brandnew" />`));
    expect(outcomes.get("T.Weird")).toBe("failed");
  });

  it("collapses data-driven cases to the worst outcome", () => {
    // One row per case under a shared name: the test as a whole passed only if
    // every case did.
    const { outcomes } = parseTrx(
      trx(`
    <UnitTestResult testName="T.Cases" outcome="Passed" />
    <UnitTestResult testName="T.Cases" outcome="Failed" />
    <UnitTestResult testName="T.Cases" outcome="Passed" />`),
    );
    expect(outcomes.get("T.Cases")).toBe("failed");
  });

  it("unescapes XML entities in test names", () => {
    const { outcomes } = parseTrx(
      trx(`    <UnitTestResult testName="T.Compare(a: 1 &amp; b: &lt;2&gt;)" outcome="Passed" />`),
    );
    expect([...outcomes.keys()]).toEqual(["T.Compare(a: 1 & b: <2>)"]);
  });

  it("reports hasResults false when the run produced none", () => {
    // The distinction matters: no results usually means the build failed, and
    // scoring must not read it as a clean run in which nothing passed.
    const { outcomes, hasResults } = parseTrx(
      `<?xml version="1.0"?><TestRun><ResultSummary outcome="Failed" /></TestRun>`,
    );
    expect(hasResults).toBe(false);
    expect(outcomes.size).toBe(0);
  });

  it("reads the summary counters when present", () => {
    const { counters } = parseTrx(trx(`    <UnitTestResult testName="T.A" outcome="Passed" />`));
    expect(counters).toEqual({ total: 3, passed: 2, failed: 1 });
  });
});

describe("findOutcome", () => {
  const outcomes = new Map<string, "passed" | "failed" | "skipped">([
    ["Ns.Class.Method", "passed"],
    ["OtherMethod", "failed"],
    ["Ns.Data.Case(a: 1)", "passed"],
    ["Ns.Data.Case(a: 2)", "failed"],
  ]);

  it("matches an exact fully-qualified name", () => {
    expect(findOutcome(outcomes, "Ns.Class.Method")).toBe("passed");
  });

  it("matches when TRX reported only the short name", () => {
    // The dataset lists fully-qualified names; some loggers report less.
    // Exact-only matching would score a correct run as a failure.
    expect(findOutcome(outcomes, "Ns.Other.OtherMethod")).toBe("failed");
  });

  it("collapses parameterised cases under the required name", () => {
    // One case passed and one failed, so the required test did not pass.
    expect(findOutcome(outcomes, "Ns.Data.Case")).toBe("failed");
  });

  it("returns undefined for a test that never ran", () => {
    // Scoring turns this into a failure; it must not silently resolve to a pass.
    expect(findOutcome(outcomes, "Ns.Absent.Test")).toBeUndefined();
  });
});

describe("same-named tests in different classes", () => {
  /** A TRX whose results carry only the method name, as MSTest and NUnit write it. */
  function shortNameTrx(rows: string, definitions: string): string {
    return `<TestRun><Results>${rows}</Results><TestDefinitions>${definitions}</TestDefinitions></TestRun>`;
  }
  function definition(id: string, className: string, name: string): string {
    return (
      `<UnitTest name="${name}" storage="t.dll" id="${id}"><Execution id="e-${id}" />` +
      `<TestMethod codeBase="t.dll" adapterTypeName="executor://nunit" className="${className}" name="${name}" /></UnitTest>`
    );
  }

  it("qualifies a short testName with its class from the test definitions", () => {
    const { outcomes } = parseTrx(
      shortNameTrx(
        `<UnitTestResult testId="L" testName="Parse_ReturnsNull" outcome="Passed" />`,
        definition("L", "Ns.LexerTests, Tests, Version=1.0.0.0", "Parse_ReturnsNull"),
      ),
    );
    expect([...outcomes.keys()]).toEqual(["Ns.LexerTests.Parse_ReturnsNull"]);
  });

  it("does not let another class's test stand in for an absent required test", () => {
    // ParserTests.Parse_ReturnsNull never ran (no row); LexerTests has a
    // passing method of the same name. The required test did not pass.
    const report = parseTrx(
      shortNameTrx(
        `<UnitTestResult testId="L" testName="Parse_ReturnsNull" outcome="Passed" />`,
        definition("L", "Ns.LexerTests", "Parse_ReturnsNull"),
      ),
    );
    expect(findOutcome(report.outcomes, "Ns.ParserTests.Parse_ReturnsNull")).toBeUndefined();
    expect(findOutcome(report.outcomes, "Ns.LexerTests.Parse_ReturnsNull")).toBe("passed");
  });

  it("without class information, refuses a short name two required tests share", () => {
    const shortOnly = new Map<string, "passed" | "failed" | "skipped">([["Parse_ReturnsNull", "passed"]]);
    const requiredNames = ["Ns.ParserTests.Parse_ReturnsNull", "Ns.LexerTests.Parse_ReturnsNull"];
    expect(findOutcome(shortOnly, "Ns.ParserTests.Parse_ReturnsNull", { requiredNames })).toBeUndefined();
    // Unique among the required names, the short name still counts.
    expect(
      findOutcome(shortOnly, "Ns.ParserTests.Parse_ReturnsNull", { requiredNames: [requiredNames[0]!] }),
    ).toBe("passed");
  });

  it("without class information, refuses a short name two distinct tests reported", () => {
    const report = parseTrx(
      `<TestRun><Results>
        <UnitTestResult testId="A" testName="Parse_ReturnsNull" outcome="Passed" />
        <UnitTestResult testId="B" testName="Parse_ReturnsNull" outcome="Passed" />
        <UnitTestResult testId="C" testName="Case" outcome="Passed" />
        <UnitTestResult testId="C" testName="Case" outcome="Passed" />
      </Results></TestRun>`,
    );
    const { ambiguousNames } = report;
    expect([...(ambiguousNames ?? [])]).toEqual(["Parse_ReturnsNull"]);
    expect(findOutcome(report.outcomes, "Ns.ParserTests.Parse_ReturnsNull", { ambiguousNames })).toBeUndefined();
    // Rows of one data-driven test share a testId, so they are not ambiguous.
    expect(findOutcome(report.outcomes, "Ns.Data.Case", { ambiguousNames })).toBe("passed");
  });
});
