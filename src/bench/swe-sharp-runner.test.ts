/**
 * Tests for the SWE-Sharp-Bench execution loop's decisions.
 *
 * The loop itself does I/O — clone, spawn, dotnet test — and is exercised for
 * real by `scripts/bench/swe-sharp/run-tasks.mjs`. What is tested here is every
 * judgement it makes, because those are the ones that fail silently: a harness
 * that counts a failed clone as an unresolved task still prints a plausible
 * number, and nothing about the output says it is wrong.
 */

import { describe, expect, it } from "vitest";
import {
  COMPETITOR_BASELINES,
  EXIT,
  VERDICT,
  assertCacheDirIsSafe,
  baselineFromFailedTestPatchBuild,
  buildBuildCommand,
  buildRequiredTestFilter,
  buildRunReport,
  buildTestCommand,
  checkBaseline,
  chooseFramework,
  chooseSolution,
  chooseTestProjects,
  classifyAttempt,
  classifyPatchOutput,
  classifyTestRun,
  decideExitCode,
  isDiffLike,
  looksLikeTestProject,
  mergeTestReports,
  relaxGlobalJson,
  renderRunReport,
  type AttemptInput,
  type CandidateResult,
  type MergedReport,
  type TaskAttempt,
} from "./swe-sharp-runner.js";
import type { TestOutcome } from "./trx-report.js";

function report(entries: Record<string, TestOutcome>, extra: Partial<MergedReport> = {}): MergedReport {
  return { outcomes: new Map(Object.entries(entries)), ...extra };
}

const PATCH = ["diff --git a/x.cs b/x.cs", "--- a/x.cs", "+++ b/x.cs", "@@ -1 +1 @@", "-a", "+b"].join(
  "\n",
);

function candidate(overrides: Partial<CandidateResult> = {}): CandidateResult {
  return { kind: "command", patch: PATCH, patchSource: "working-tree", exitCode: 0, ...overrides };
}

function attempt(overrides: Partial<AttemptInput> = {}): AttemptInput {
  return {
    instanceId: "task-1",
    repo: "acme/thing",
    failToPass: ["Ns.T.Fix"],
    passToPass: ["Ns.T.Keep"],
    candidate: candidate(),
    baseline: { measured: true, failingBefore: ["Ns.T.Fix"], alreadyPassing: [] },
    postReport: report({ "Ns.T.Fix": "passed", "Ns.T.Keep": "passed" }),
    ...overrides,
  };
}

describe("classifyAttempt — a task that did not run is not a failed task", () => {
  it("keeps a clone failure out of the score", () => {
    const a = classifyAttempt(
      attempt({ notRun: { reason: "clone-failed", detail: "fatal: could not read from remote" } }),
    );
    expect(a.status).toBe("not-run");
    expect(a.scored).toBe(false);
    expect(a.notRunReason).toBe("clone-failed");
    expect(a.reason).toContain("could not read from remote");
  });

  it("does not score a task whose build failed before the candidate ran", () => {
    const a = classifyAttempt(
      attempt({ notRun: { reason: "build-failed-before-candidate", detail: "CS0246" } }),
    );
    expect(a.status).toBe("not-run");
    expect(a.scored).toBe(false);
  });

  it("reports a harness-killed candidate as not-run, not as a failed attempt", () => {
    const a = classifyAttempt(
      attempt({ candidate: candidate({ timedOut: true, patch: null, durationMs: 900_000 }) }),
    );
    expect(a.status).toBe("not-run");
    expect(a.notRunReason).toBe("candidate-timeout");
    expect(a.reason).toContain("900000ms");
  });

  it("reports a missing candidate hook as not-run with its reason", () => {
    const a = classifyAttempt(
      attempt({
        candidate: {
          kind: "unavailable",
          patch: null,
          patchSource: "none",
          unavailableReason: "a real Strada run needs a paid provider call",
        },
      }),
    );
    expect(a.status).toBe("not-run");
    expect(a.notRunReason).toBe("candidate-unavailable");
    expect(a.reason).toContain("paid provider call");
  });

  it("refuses to score a task whose FAIL_TO_PASS test already passed before the patch", () => {
    const a = classifyAttempt(
      attempt({
        baseline: { measured: true, failingBefore: [], alreadyPassing: ["Ns.T.Fix"] },
      }),
    );
    expect(a.status).toBe("not-run");
    expect(a.notRunReason).toBe("fail-to-pass-already-passing");
    expect(a.scored).toBe(false);
  });

  it("is not-run when the test run produced no report at all", () => {
    const a = classifyAttempt(attempt({ postReport: undefined }));
    expect(a.status).toBe("not-run");
    expect(a.notRunReason).toBe("no-test-report");
  });
});

describe("classifyAttempt — a candidate that produced nothing is a scored attempt", () => {
  it("scores 'no patch' as unresolved rather than erroring", () => {
    const a = classifyAttempt(attempt({ candidate: candidate({ patch: null, patchSource: "none" }) }));
    expect(a.status).toBe("unresolved");
    expect(a.scored).toBe(true);
    expect(a.candidateProducedNoPatch).toBe(true);
    expect(a.reason).toContain("no patch");
  });

  it("scores a patch that does not apply as unresolved, not as a harness failure", () => {
    const a = classifyAttempt(
      attempt({ patchApplied: { ok: false, detail: "error: corrupt patch at line 4" } }),
    );
    expect(a.status).toBe("unresolved");
    expect(a.scored).toBe(true);
    expect(a.reason).toContain("corrupt patch");
  });

  it("resolves when every required test passes and the baseline proved the transition", () => {
    const a = classifyAttempt(attempt());
    expect(a.status).toBe("resolved");
    expect(a.fixProven).toBe(true);
    expect(a.resolution?.resolved).toBe(true);
  });

  it("marks a pass unproven when no baseline run happened, and says why", () => {
    const a = classifyAttempt(
      attempt({ baseline: { measured: false, reason: "--no-baseline was passed" } }),
    );
    expect(a.status).toBe("resolved");
    expect(a.fixProven).toBe(false);
    expect(a.reason).toContain("fail→pass NOT proven");
    expect(a.reason).toContain("--no-baseline");
  });

  it("carries the TRX counters onto the attempt so the report can show real numbers", () => {
    const a = classifyAttempt(
      attempt({
        postReport: report(
          { "Ns.T.Fix": "passed", "Ns.T.Keep": "passed" },
          { counters: { total: 2, passed: 2, failed: 0 } },
        ),
      }),
    );
    expect(a.trxCounters).toEqual({ total: 2, passed: 2, failed: 0 });
  });
});

describe("checkBaseline", () => {
  it("treats a test absent before the patch as failing, so a real fix still counts", () => {
    // The FAIL_TO_PASS test usually does not exist until testPatch adds it.
    const check = checkBaseline(["Ns.T.Fix"], report({ "Ns.T.Other": "passed" }));
    expect(check.measured).toBe(true);
    expect(check.failingBefore).toEqual(["Ns.T.Fix"]);
    expect(check.alreadyPassing).toEqual([]);
  });

  it("names a FAIL_TO_PASS test that was already green", () => {
    const check = checkBaseline(["Ns.T.Fix"], report({ "Ns.T.Fix": "passed" }));
    expect(check.alreadyPassing).toEqual(["Ns.T.Fix"]);
  });

  it("is unmeasured when the pre-patch build failed", () => {
    const check = checkBaseline(["Ns.T.Fix"], report({}, { buildFailed: true }));
    expect(check.measured).toBe(false);
    expect(check.reason).toContain("build failed");
  });
});

describe("baselineFromFailedTestPatchBuild", () => {
  it("counts a test patch that cannot compile as a measured failing baseline", () => {
    // The normal SWE-bench state: the new test calls API the fix introduces.
    const b = baselineFromFailedTestPatchBuild(["Ns.T.Fix", "Ns.T.Fix2"]);
    expect(b.measured).toBe(true);
    expect(b.failingBefore).toEqual(["Ns.T.Fix", "Ns.T.Fix2"]);
    expect(b.alreadyPassing).toEqual([]);
    expect(b.reason).toContain("cannot compile cannot pass");
  });

  it("lets such a task be scored as a proven fix once the patch makes it build", () => {
    const a = classifyAttempt(
      attempt({ baseline: baselineFromFailedTestPatchBuild(["Ns.T.Fix"]) }),
    );
    expect(a.status).toBe("resolved");
    expect(a.fixProven).toBe(true);
  });
});

describe("buildBuildCommand", () => {
  it("builds the checkout without running tests, so a broken repo is not a score", () => {
    const cmd = buildBuildCommand({ target: "t/T.csproj", framework: "net7.0" });
    expect(cmd.args[0]).toBe("build");
    expect(cmd.args.join(" ")).toContain("--framework net7.0");
    expect(cmd.args.join(" ")).not.toContain("--logger");
    expect(cmd.env.DOTNET_ROLL_FORWARD).toBe("LatestMajor");
  });
});

describe("buildRunReport / decideExitCode — the exit contract", () => {
  const resolvedProven: TaskAttempt = {
    instanceId: "ok-1",
    repo: "r",
    status: "resolved",
    scored: true,
    reason: "all good",
    fixProven: true,
    candidateProducedNoPatch: false,
    deviations: [],
  };
  const unresolved: TaskAttempt = { ...resolvedProven, instanceId: "bad-1", status: "unresolved" };
  const notRunAttempt: TaskAttempt = {
    ...resolvedProven,
    instanceId: "skip-1",
    status: "not-run",
    scored: false,
    fixProven: false,
    notRunReason: "no-network",
    reason: "NOT RUN (no-network): unreachable",
  };

  it("keeps not-run tasks out of the rate's denominator", () => {
    const r = buildRunReport(["ok-1", "bad-1", "skip-1"], [resolvedProven, unresolved, notRunAttempt]);
    expect(r.scored).toBe(2);
    expect(r.notRun).toBe(1);
    expect(r.resolved).toBe(1);
    expect(r.resolvedRate).toBe(0.5);
    expect(r.notRunTasks.map((t) => t.instanceId)).toEqual(["skip-1"]);
  });

  it("invents a not-run record for a requested task that was never attempted", () => {
    const r = buildRunReport(["ok-1", "ghost"], [resolvedProven]);
    expect(r.notRun).toBe(1);
    expect(r.notRunTasks[0]).toMatchObject({ instanceId: "ghost", reason: "not-attempted" });
  });

  it("exits 3 when any requested task did not run, even if everything else resolved", () => {
    const r = buildRunReport(["ok-1", "skip-1"], [resolvedProven, notRunAttempt]);
    const d = decideExitCode(r);
    expect(d.exitCode).toBe(EXIT.NOT_RUN);
    expect(d.verdict).toBe(VERDICT.NOT_RUN);
    expect(d.reasons.join(" ")).toContain("skip-1");
  });

  it("exits 3 for a pass whose fail→pass transition was never observed", () => {
    const unproven: TaskAttempt = { ...resolvedProven, instanceId: "unproven-1", fixProven: false };
    const d = decideExitCode(buildRunReport(["unproven-1"], [unproven]));
    expect(d.exitCode).toBe(EXIT.NOT_RUN);
    expect(d.reasons.join(" ")).toContain("never observed");
  });

  it("exits 1 when everything ran and the rate is below the floor", () => {
    const r = buildRunReport(["ok-1", "bad-1"], [resolvedProven, unresolved]);
    const d = decideExitCode(r, { minResolvedRate: 0.8 });
    expect(d.exitCode).toBe(EXIT.RAN_AND_REGRESSED);
    expect(d.verdict).toBe(VERDICT.REGRESSED);
  });

  it("exits 0 when every requested task ran and the floor was met", () => {
    const r = buildRunReport(["ok-1"], [resolvedProven]);
    expect(decideExitCode(r, { minResolvedRate: 1 }).exitCode).toBe(EXIT.RAN_AND_MET_BUDGET);
  });

  it("exits 3, not 0, when nothing was scored at all", () => {
    const r = buildRunReport([], []);
    expect(decideExitCode(r).exitCode).toBe(EXIT.NOT_RUN);
  });
});

describe("competitor comparison is NOT MEASURED", () => {
  it("names both pinned competitors and gives a reason instead of a number", () => {
    expect(COMPETITOR_BASELINES.map((c) => `${c.name} ${c.version}`)).toEqual([
      "Hermes v0.21.2",
      "Bezi 1.36.0",
    ]);
    for (const c of COMPETITOR_BASELINES) {
      expect(c.state).toBe("NOT MEASURED");
      expect(c.reason.length).toBeGreaterThan(10);
    }
  });

  it("prints the competitor rows as NOT MEASURED with no score", () => {
    const a: TaskAttempt = {
      instanceId: "ok-1",
      repo: "r",
      status: "resolved",
      scored: true,
      reason: "all good",
      fixProven: true,
      candidateProducedNoPatch: false,
      deviations: [],
    };
    const text = renderRunReport(buildRunReport(["ok-1"], [a]), [a]);
    for (const line of text.split("\n")) {
      if (!/Hermes|Bezi/.test(line)) continue;
      expect(line).toContain("NOT MEASURED");
      // A score would arrive as a percentage or a rate; neither belongs here.
      expect(line).not.toMatch(/\d+(\.\d+)?\s*%/);
    }
  });

  it("labels a gold-patch run as a control, not as an agent score", () => {
    const a: TaskAttempt = {
      instanceId: "ok-1",
      repo: "r",
      status: "resolved",
      scored: true,
      reason: "all good",
      fixProven: true,
      candidateProducedNoPatch: false,
      deviations: [],
    };
    const text = renderRunReport(buildRunReport(["ok-1"], [a], { control: true }), [a]);
    expect(text).toContain("CONTROL RUN");
    expect(text).toContain("measures the harness, not an agent");
  });

  it("treats an unresolved CONTROL task as a harness failure, not an agent score", () => {
    // The reference patch is correct by construction. If it does not score as
    // resolved, the rig cannot measure this task — publishing that as a score
    // would be a number about agents produced by a broken harness.
    const unresolved: TaskAttempt = {
      instanceId: "ctl-1",
      repo: "r",
      status: "unresolved",
      scored: true,
      reason: "build failed",
      fixProven: false,
      candidateProducedNoPatch: false,
      deviations: [],
    };
    const r = buildRunReport(["ctl-1"], [unresolved], { control: true });
    expect(r.controlFailures).toEqual(["ctl-1"]);
    const d = decideExitCode(r);
    expect(d.exitCode).toBe(EXIT.NOT_RUN);
    expect(d.reasons.join(" ")).toContain("CONTROL FAILURE");
    expect(renderRunReport(r, [unresolved])).toContain("CONTROL FAILURES");
  });

  it("does not flag control failures on a normal agent run", () => {
    const unresolved: TaskAttempt = {
      instanceId: "bad-1",
      repo: "r",
      status: "unresolved",
      scored: true,
      reason: "1 FAIL_TO_PASS not passing",
      fixProven: true,
      candidateProducedNoPatch: false,
      deviations: [],
    };
    const r = buildRunReport(["bad-1"], [unresolved]);
    expect(r.controlFailures).toEqual([]);
    expect(decideExitCode(r).exitCode).toBe(EXIT.RAN_AND_MET_BUDGET);
  });

  it("names every not-run task in the rendered report", () => {
    const notRunAttempt: TaskAttempt = {
      instanceId: "skip-1",
      repo: "r",
      status: "not-run",
      scored: false,
      reason: "NOT RUN (no-network): unreachable",
      notRunReason: "no-network",
      fixProven: false,
      candidateProducedNoPatch: false,
      deviations: [],
    };
    const text = renderRunReport(buildRunReport(["skip-1"], [notRunAttempt]), [notRunAttempt]);
    expect(text).toContain("NOT RUN");
    expect(text).toContain("skip-1");
    expect(text).toContain("no-network");
  });
});

describe("mergeTestReports", () => {
  it("merges several projects' reports and sums the counters", () => {
    const merged = mergeTestReports([
      {
        outcomes: new Map<string, TestOutcome>([["A", "passed"]]),
        hasResults: true,
        counters: { total: 1, passed: 1, failed: 0 },
      },
      {
        outcomes: new Map<string, TestOutcome>([["B", "failed"]]),
        hasResults: true,
        counters: { total: 1, passed: 0, failed: 1 },
      },
    ]);
    expect(merged.buildFailed).toBe(false);
    expect(merged.counters).toEqual({ total: 2, passed: 1, failed: 1 });
    expect(merged.outcomes.get("B")).toBe("failed");
  });

  it("takes the worst outcome when two projects report the same test name", () => {
    const merged = mergeTestReports([
      { outcomes: new Map<string, TestOutcome>([["A", "passed"]]), hasResults: true },
      { outcomes: new Map<string, TestOutcome>([["A", "failed"]]), hasResults: true },
    ]);
    expect(merged.outcomes.get("A")).toBe("failed");
  });

  it("flags a build failure when no report had results — not 'nothing failed'", () => {
    expect(mergeTestReports([]).buildFailed).toBe(true);
    expect(mergeTestReports([{ outcomes: new Map(), hasResults: false }]).buildFailed).toBe(true);
  });
});

describe("chooseSolution", () => {
  it("prefers the root solution over docs and samples solutions", () => {
    expect(
      chooseSolution(["docs/Docs.sln", "examples/Examples.sln", "src/Spectre.Console.sln"]),
    ).toBe("src/Spectre.Console.sln");
  });

  it("picks the shallowest, then alphabetical, for determinism", () => {
    expect(chooseSolution(["src/B.sln", "Z.sln", "src/A.sln"])).toBe("Z.sln");
    expect(chooseSolution(["src/B.sln", "src/A.sln"])).toBe("src/A.sln");
  });

  it("returns undefined when there is nothing to test", () => {
    expect(chooseSolution(["README.md", "docs/Docs.sln"])).toBeUndefined();
  });
});

describe("chooseTestProjects", () => {
  it("matches the project whose assembly name roots the required test name", () => {
    expect(
      chooseTestProjects(
        ["src/Autofac/Autofac.csproj", "test/Autofac.Test/Autofac.Test.csproj", "bench/B.csproj"],
        ["Autofac.Test.Core.Activators.Reflection.DefaultConstructorFinderTests.Supports"],
      ),
    ).toEqual(["test/Autofac.Test/Autofac.Test.csproj"]);
  });

  it("prefers the test project over the product library that also roots the name", () => {
    // `dotnet test src/Autofac/Autofac.csproj` fails: no test adapter.
    expect(
      chooseTestProjects(
        ["src/Autofac/Autofac.csproj", "test/Autofac.Test/Autofac.Test.csproj"],
        ["Autofac.Test.Core.DefaultConstructorFinderTests.Supports"],
      ),
    ).toEqual(["test/Autofac.Test/Autofac.Test.csproj"]);
  });

  it("does not match on a partial name segment", () => {
    expect(chooseTestProjects(["test/Autofac.Tests/Autofac.Tests.csproj"], ["Autofac.TestsX.A"])).toEqual(
      [],
    );
  });

  it("returns nothing when no project matches, so the caller falls back", () => {
    expect(chooseTestProjects(["src/A/A.csproj"], ["Zzz.T.Method"])).toEqual([]);
  });
});

describe("looksLikeTestProject", () => {
  it("accepts a project that references a test SDK or adapter", () => {
    expect(looksLikeTestProject('<PackageReference Include="Microsoft.NET.Test.Sdk" />')).toBe(true);
    expect(looksLikeTestProject('<PackageReference Include="xunit.runner.visualstudio" />')).toBe(true);
    expect(looksLikeTestProject("<IsTestProject>true</IsTestProject>")).toBe(true);
  });

  it("rejects the library whose name merely roots the test's namespace", () => {
    // Terminal.Gui roots Terminal.Gui.ViewTests.…, but the tests live elsewhere.
    expect(looksLikeTestProject("<TargetFrameworks>net472;net7.0</TargetFrameworks>")).toBe(false);
    expect(looksLikeTestProject("<IsTestProject>false</IsTestProject><PackageReference Include=\"xunit.runner\" />")).toBe(
      false,
    );
  });
});

describe("classifyTestRun — the four ways a run can produce no results", () => {
  it("returns results when the report has any", () => {
    expect(classifyTestRun({ anyResults: true, trxFilesFound: 1, logText: "" })).toBe("results");
  });

  it("calls a missing runtime unmeasurable, not a failure", () => {
    expect(
      classifyTestRun({
        anyResults: false,
        trxFilesFound: 1,
        logText: "Could not find 'dotnet' host for the 'X64' architecture.\nTest Run Aborted.",
      }),
    ).toBe("runtime-unavailable");
    expect(
      classifyTestRun({
        anyResults: false,
        trxFilesFound: 1,
        logText: "The framework 'Microsoft.NETCore.App', version '3.1.0' (x64) was not found.",
      }),
    ).toBe("runtime-unavailable");
    expect(
      classifyTestRun({
        anyResults: false,
        trxFilesFound: 0,
        logText: "error NETSDK1045: The current .NET SDK does not support targeting netcoreapp3.1.",
      }),
    ).toBe("runtime-unavailable");
  });

  it("calls a real compile error a build failure, which IS scored", () => {
    expect(
      classifyTestRun({
        anyResults: false,
        trxFilesFound: 0,
        logText: "Foo.cs(12,5): error CS0246: The type or namespace name 'Bar' could not be found",
      }),
    ).toBe("build-failure");
  });

  it("calls a run with no TRX and no compile error 'no test report' — no evidence, no score", () => {
    expect(
      classifyTestRun({ anyResults: false, trxFilesFound: 0, logText: "All projects are up-to-date for restore." }),
    ).toBe("no-test-report");
  });

  it("keeps an empty-but-present TRX as a build failure, so a broken patch still scores", () => {
    expect(classifyTestRun({ anyResults: false, trxFilesFound: 1, logText: "something else" })).toBe(
      "build-failure",
    );
  });
});

describe("chooseFramework", () => {
  it("picks the newest runnable framework and ignores net472/netstandard", () => {
    expect(chooseFramework("net7.0;net6.0;netcoreapp3.1;")).toBe("net7.0");
    expect(chooseFramework("net472;netstandard2.1;net7.0")).toBe("net7.0");
    expect(chooseFramework("netstandard2.0")).toBeUndefined();
    expect(chooseFramework(undefined)).toBeUndefined();
  });

  it("orders by version numerically, not lexically", () => {
    // "net10.0" sorts before "net7.0" as a string; it must not.
    expect(chooseFramework("net7.0;net10.0")).toBe("net10.0");
  });
});

describe("buildTestCommand", () => {
  it("names the TRX file and its directory instead of letting dotnet choose", () => {
    const cmd = buildTestCommand({
      target: "A.sln",
      trxName: "post.trx",
      resultsDir: "/tmp/r",
      framework: "net7.0",
      filter: "FullyQualifiedName~A",
    });
    expect(cmd.args).toContain("--logger");
    expect(cmd.args).toContain("trx;LogFileName=post.trx");
    expect(cmd.args.join(" ")).toContain("--results-directory /tmp/r");
    expect(cmd.args.join(" ")).toContain("--framework net7.0");
    expect(cmd.args.join(" ")).toContain("--filter FullyQualifiedName~A");
  });

  it("rolls forward so a net6/net7 task runs on a newer installed runtime", () => {
    const cmd = buildTestCommand({ target: "A.sln", trxName: "t.trx", resultsDir: "/tmp/r" });
    expect(cmd.env.DOTNET_ROLL_FORWARD).toBe("LatestMajor");
    expect(cmd.env.DOTNET_CLI_UI_LANGUAGE).toBe("en");
  });
});

describe("buildRequiredTestFilter", () => {
  it("builds a contains-filter over the required tests", () => {
    expect(buildRequiredTestFilter(["A.B.C", "A.B.D"])).toBe(
      "FullyQualifiedName~A.B.C|FullyQualifiedName~A.B.D",
    );
  });

  it("drops duplicates and blanks", () => {
    expect(buildRequiredTestFilter(["A.B", "A.B", "  "])).toBe("FullyQualifiedName~A.B");
  });

  it("gives up rather than truncate a filter that would drop required tests", () => {
    const many = Array.from({ length: 200 }, (_, i) => `Ns.T.Method${i}`);
    expect(buildRequiredTestFilter(many)).toBeUndefined();
    expect(buildRequiredTestFilter(["A.B"], { maxLength: 5 })).toBeUndefined();
  });

  it("refuses a name carrying filter operators, which would change the expression", () => {
    expect(buildRequiredTestFilter(["Ns.T.Method(a|b)"])).toBeUndefined();
  });

  it("returns undefined for an empty list instead of an empty filter", () => {
    // An empty --filter matches nothing, so every required test would be absent.
    expect(buildRequiredTestFilter([])).toBeUndefined();
  });
});

describe("classifyPatchOutput / isDiffLike", () => {
  it("prefers the patch file the candidate was asked to write", () => {
    const out = classifyPatchOutput({ patchFile: PATCH, workingTreeDiff: "@@ -9 +9 @@\n-x\n+y\n--- a/z" });
    expect(out.source).toBe("patch-file");
    expect(out.patch).toBe(PATCH);
  });

  it("falls back to the working tree for a candidate that edits in place", () => {
    const out = classifyPatchOutput({ patchFile: "", workingTreeDiff: PATCH });
    expect(out.source).toBe("working-tree");
  });

  it("treats prose and empty output as no patch at all", () => {
    expect(classifyPatchOutput({ patchFile: "I could not fix this.\n" }).patch).toBeNull();
    expect(classifyPatchOutput({}).source).toBe("none");
    expect(isDiffLike("diff --git a/x b/x\n")).toBe(false); // header, no hunk
    expect(isDiffLike(PATCH)).toBe(true);
  });
});

describe("relaxGlobalJson", () => {
  it("allows a newer SDK while keeping the rest of the file", () => {
    const { text, changed } = relaxGlobalJson(
      JSON.stringify({ sdk: { version: "7.0.100", rollForward: "latestFeature" }, msbuild: 1 }),
    );
    expect(changed).toBe(true);
    const parsed = JSON.parse(text) as { sdk: Record<string, unknown>; msbuild: number };
    expect(parsed.sdk.rollForward).toBe("latestMajor");
    expect(parsed.sdk.version).toBe("7.0.100");
    expect(parsed.msbuild).toBe(1);
  });

  it("reports no change when there is nothing to relax", () => {
    expect(relaxGlobalJson('{"sdk":{"rollForward":"latestMajor"}}').changed).toBe(false);
    expect(relaxGlobalJson("not json").changed).toBe(false);
    expect(relaxGlobalJson('{"msbuild":1}').changed).toBe(false);
  });
});

describe("assertCacheDirIsSafe", () => {
  it("refuses a cache directory inside the repository", () => {
    expect(() => assertCacheDirIsSafe("/repo/benchmarks/cache", "/repo", "/home/u")).toThrow(
      /inside the repository/,
    );
    expect(() => assertCacheDirIsSafe("/repo", "/repo", "/home/u")).toThrow(/inside the repository/);
  });

  it("refuses the user's ~/.strada", () => {
    expect(() => assertCacheDirIsSafe("/home/u/.strada/bench", "/repo", "/home/u")).toThrow(
      /\.strada/,
    );
  });

  it("accepts a temp directory outside both", () => {
    expect(() => assertCacheDirIsSafe("/tmp/strada-swe-sharp", "/repo", "/home/u")).not.toThrow();
    // A sibling whose name merely starts with the repo path is not inside it.
    expect(() => assertCacheDirIsSafe("/repo-cache", "/repo", "/home/u")).not.toThrow();
  });
});
