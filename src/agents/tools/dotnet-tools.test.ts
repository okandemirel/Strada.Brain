import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DotnetBuildTool, DotnetTestTool, parseBuildOutput, parseTrxReport } from "./dotnet-tools.js";
import type { ToolContext } from "./tool.interface.js";
import { checkReadOnlyBlock, getReadOnlySystemPrompt } from "../../security/read-only-guard.js";
import { runProcess } from "../../utils/process-runner.js";
import { SelfVerification } from "../autonomy/self-verification.js";

// The "handles dotnet not installed gracefully" tests previously ran the REAL `dotnet` binary:
// on a runner WITH dotnet installed (GitHub ubuntu-latest) that meant an actual `dotnet build`
// whose cold start (NuGet init / workload resolution) could exceed the 30s test timeout — a CI
// flake, and the test wasn't testing what its name claims. Mock the process runner to the
// spawn-failure shape runProcess resolves with when the binary is missing, so the tests are
// hermetic and actually exercise the not-installed path.
vi.mock("../../utils/process-runner.js", () => ({
  runProcess: vi.fn().mockResolvedValue({
    stdout: "",
    stderr: "spawn dotnet ENOENT: command not found",
    exitCode: -1,
    timedOut: false,
    durationMs: 1,
  }),
}));

const ctx: ToolContext = {
  projectPath: "/tmp/test-project",
  workingDirectory: "/tmp/test-project",
  readOnly: false,
};

describe("parseBuildOutput", () => {
  it("parses MSBuild errors", () => {
    const output = `
Build started...
Assets/Scripts/Player.cs(15,10): error CS0246: The type or namespace name 'Foo' could not be found
Assets/Scripts/Enemy.cs(30,5): error CS1002: ; expected
Build FAILED.
`;
    const { errors, warnings } = parseBuildOutput(output);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.file).toBe("Assets/Scripts/Player.cs");
    expect(errors[0]!.line).toBe(15);
    expect(errors[0]!.column).toBe(10);
    expect(errors[0]!.code).toBe("CS0246");
    expect(errors[0]!.severity).toBe("error");
    expect(errors[1]!.code).toBe("CS1002");
  });

  it("parses MSBuild warnings", () => {
    const output = `
Assets/Scripts/Util.cs(5,1): warning CS0168: The variable 'x' is declared but never used
Build succeeded.
`;
    const { errors, warnings } = parseBuildOutput(output);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("CS0168");
    expect(warnings[0]!.severity).toBe("warning");
  });

  it("handles clean build output", () => {
    const output = `
Build started...
  Restoring packages...
  MyProject -> /output/MyProject.dll

Build succeeded.
    0 Warning(s)
    0 Error(s)
`;
    const { errors, warnings } = parseBuildOutput(output);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("parses mixed errors and warnings", () => {
    const output = `
Foo.cs(1,1): error CS0001: err1
Foo.cs(2,2): warning CS0002: warn1
Bar.cs(3,3): error CS0003: err2
`;
    const { errors, warnings } = parseBuildOutput(output);
    expect(errors).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });
});

/**
 * The console parser these replaced read the verdict from text the SDK
 * localizes; its fixtures were English and synthesized ("No SDK was
 * available to capture a live run"). The TRX shapes below follow a report
 * captured from a live run (see FAILING_TRX).
 */
describe("parseTrxReport", () => {
  it("counts error, timeout and aborted results as failures and decodes the message", () => {
    const report = parseTrxReport(
      [
        `<TestRun><Results>`,
        `<UnitTestResult testName="Ns.T.Equal(a: &quot;x&quot;)" outcome="Failed"><Output><ErrorInfo><Message>Assert.Equal() Failure&#xA;Expected: 4 &amp; Actual: 3 &lt;none&gt; &amp;lt;b&amp;gt;</Message></ErrorInfo></Output></UnitTestResult>`,
        `<UnitTestResult testName="Ns.T.Hangs" outcome="Timeout" />`,
        `<UnitTestResult testName="Ns.T.Fine" outcome="Passed" />`,
        `</Results><ResultSummary outcome="Failed">`,
        `<Counters total="4" executed="4" passed="1" failed="1" error="1" timeout="1" aborted="0" notExecuted="0" />`,
        `</ResultSummary></TestRun>`,
      ].join("\n"),
    );
    expect(report).not.toBeNull();
    expect(report!.summary).toEqual({ total: 4, passed: 1, failed: 3, skipped: 0 });
    expect(report!.failures.map((f) => f.name)).toEqual(['Ns.T.Equal(a: "x")', "Ns.T.Hangs"]);
    // Decoded once: text that held a literal "&lt;b&gt;" keeps it.
    expect(report!.failures[0]!.errorMessage).toBe("Assert.Equal() Failure\nExpected: 4 & Actual: 3 <none> &lt;b&gt;");
  });

  it("reads a skipped test as neither passed nor failed", () => {
    expect(parseTrxReport(FAILING_TRX)!.summary).toEqual({ total: 5, passed: 3, failed: 1, skipped: 1 });
  });

  it("returns null, not an empty run, for a report with no summary", () => {
    expect(parseTrxReport(`<TestRun id="x"><Results>`)).toBeNull();
    expect(parseTrxReport("")).toBeNull();
  });
});

describe("dotnet_test's verdict line follows the exit code (TLS-9)", () => {
  it("a run that exited non-zero is not reported as PASSED", async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      stdout: "  Game.Tests -> /work/bin/Game.Tests.dll\nTest run for /work/bin/Game.Tests.dll (.NETCoreApp,Version=v8.0)\n",
      stderr: "The active test run was aborted. Reason: Test host process crashed",
      exitCode: 1,
      timedOut: false,
      durationMs: 5,
    });
    const result = await new DotnetTestTool().execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Result: FAILED");
    expect(result.content).not.toContain("Result: PASSED");
  });
});

/**
 * Captured 2026-10-11 from dotnet 10.0.400 (Homebrew) on this machine —
 * LANG=C.UTF-8, macOS UI language tr-TR — running a scratch xunit project
 * with `dotnet test -c Debug -v normal --logger trx`. The console is the
 * SDK's own text, trimmed; the TRX keeps every element and attribute the
 * verdict depends on.
 */
const PRUNE_LINE =
  "         Failed to load prune package data from PrunePackageData folder, loading from targeting packs instead";
const TURKISH_PASSING_CONSOLE = [
  "     1>AddPrunePackageReferences:",
  "         Loading prune package data from PrunePackageData folder",
  PRUNE_LINE,
  "         Game.Tests -> /work/Game.Tests/bin/Debug/net10.0/Game.Tests.dll",
  "/work/Game.Tests/bin/Debug/net10.0/Game.Tests.dll (.NETCoreApp,Version=v10.0) için test çalıştırması",
  "Toplam 1 test dosyası belirtilen desenle eşleşti.",
  "  Başarılı Game.Tests.BoardTests.ClearsRow [4 ms]",
  "  Başarılı Game.Tests.BoardTests.Cases(n: 1) [< 1 ms]",
  "",
  "Test Çalıştırması Başarılı.",
  "Toplam test sayısı: 2",
  "     Geçti: 2",
  " Toplam süre: 0,4120 Saniye",
].join("\n");
const TURKISH_FAILING_CONSOLE = [
  "     1>AddPrunePackageReferences:",
  "         Loading prune package data from PrunePackageData folder",
  PRUNE_LINE,
  "  Başarılı Game.Tests.BoardTests.ClearsRow [4 ms]",
  "  Atlandı Game.Tests.BoardTests.Later [1 ms]",
  "  Başarılı Game.Tests.BoardTests.Cases(n: 1) [< 1 ms]",
  "  Başarılı Game.Tests.BoardTests.Cases(n: 2) [< 1 ms]",
  "  Başarısız Game.Tests.BoardTests.BoardSwapFails [< 1 ms]",
  "  Hata İletisi:",
  "   swap broke",
  "  Yığın İzleme:",
  "     at Game.Tests.BoardTests.BoardSwapFails() in /work/Game.Tests/UnitTest1.cs:line 9",
  "",
  "Test Çalıştırması Başarısız.",
  "Toplam test sayısı: 5",
  "     Geçti: 3",
  "     Başarısız: 1",
  "    Atlandı: 1",
  " Toplam süre: 0,5091 Saniye",
].join("\n");

function trxResult(name: string, outcome: string, message?: string): string {
  const head =
    `    <UnitTestResult executionId="e-${name}" testId="t-${name}" testName="${name}" computerName="host" ` +
    `duration="00:00:00.0003766" testType="13cdc9d9-ddb5-4fa4-a97d-d965ccfc6d4b" outcome="${outcome}" ` +
    `testListId="8c84fa94-04c1-424b-9868-57a2d4851a1d"`;
  return message === undefined
    ? `${head} />`
    : `${head}>\n      <Output>\n        <ErrorInfo>\n          <Message>${message}</Message>\n` +
        `          <StackTrace>   at ${name}() in /work/Game.Tests/UnitTest1.cs:line 9</StackTrace>\n` +
        `        </ErrorInfo>\n      </Output>\n    </UnitTestResult>`;
}

function trx(counters: { total: number; executed: number; passed: number; failed: number }, results: string[] = []): string {
  return [
    `﻿<?xml version="1.0" encoding="utf-8"?>`,
    `<TestRun id="d2eff84b" name="@host 2026-10-11 14:09:00" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">`,
    ...(results.length > 0 ? ["  <Results>", ...results, "  </Results>"] : []),
    `  <ResultSummary outcome="${counters.failed > 0 ? "Failed" : "Completed"}">`,
    `    <Counters total="${counters.total}" executed="${counters.executed}" passed="${counters.passed}" ` +
      `failed="${counters.failed}" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" ` +
      `notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" />`,
    `  </ResultSummary>`,
    `</TestRun>`,
  ].join("\n");
}

const FAILING_TRX = trx({ total: 5, executed: 4, passed: 3, failed: 1 }, [
  trxResult("Game.Tests.BoardTests.ClearsRow", "Passed"),
  trxResult("Game.Tests.BoardTests.Cases(n: 2)", "Passed"),
  trxResult("Game.Tests.BoardTests.Cases(n: 1)", "Passed"),
  trxResult("Game.Tests.BoardTests.Later", "NotExecuted", "not yet"),
  trxResult("Game.Tests.BoardTests.BoardSwapFails", "Failed", "swap broke"),
]);
const PASSING_TRX = trx({ total: 2, executed: 2, passed: 2, failed: 0 }, [
  trxResult("Game.Tests.BoardTests.ClearsRow", "Passed"),
  trxResult("Game.Tests.BoardTests.Cases(n: 1)", "Passed"),
]);
/** What a filter that matches nothing leaves behind: a report of zero tests. */
const ZERO_TEST_TRX = trx({ total: 0, executed: 0, passed: 0, failed: 0 });

/**
 * One `dotnet test` run: the console it printed, its exit code, and the TRX
 * reports it left in the directory it was told to write them to.
 */
function dotnetTestRun(run: { stdout: string; exitCode: number; trx?: string[]; timedOut?: boolean }): { resultsDir: () => string | undefined } {
  let dir: string | undefined;
  vi.mocked(runProcess).mockImplementationOnce(async (call) => {
    const at = call.args.indexOf("--results-directory");
    dir = at >= 0 ? call.args[at + 1] : undefined;
    if (dir !== undefined && run.trx) {
      mkdirSync(dir, { recursive: true });
      run.trx.forEach((xml, i) => writeFileSync(join(dir!, `host_2026-10-11_14_09_0${i}_net10.0.trx`), xml));
    }
    return { stdout: run.stdout, stderr: "", exitCode: run.exitCode, timedOut: run.timedOut === true, durationMs: 5 };
  });
  return { resultsDir: () => dir };
}

describe("dotnet_test's verdict comes from the TRX report and the exit code (tools#1)", () => {
  const tool = new DotnetTestTool();

  it("reads an all-passing run as PASSED, whatever language the console spoke", async () => {
    dotnetTestRun({ stdout: TURKISH_PASSING_CONSOLE, exitCode: 0, trx: [PASSING_TRX] });
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("Result: PASSED");
    expect(result.content).toContain("Total: 2 | Passed: 2 | Failed: 0 | Skipped: 0");
    // The MSBuild message is not a test, and error recovery keys on "FAILED".
    expect(result.content).not.toContain("FAILED");
    expect(result.content).not.toContain("prune package data");
    expect(result.isError).toBe(false);
  });

  it("names the test that failed and its message, not a log line that starts with 'Failed'", async () => {
    dotnetTestRun({ stdout: TURKISH_FAILING_CONSOLE, exitCode: 1, trx: [FAILING_TRX] });
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("Result: FAILED");
    expect(result.content).toContain("Total: 5 | Passed: 3 | Failed: 1 | Skipped: 1");
    expect(result.content).toContain("✗ Game.Tests.BoardTests.BoardSwapFails");
    expect(result.content).toContain("swap broke");
    expect(result.content).not.toContain("✗ to load prune package data");
    expect(result.isError).toBe(true);
  });

  it("says NOT MEASURED, never PASSED, when a filter matched no test", async () => {
    dotnetTestRun({
      stdout: "No test matches the given testcase filter `FullyQualifiedName~Nope` in /work/Game.Tests/bin/Debug/net10.0/Game.Tests.dll",
      exitCode: 0,
      trx: [ZERO_TEST_TRX],
    });
    const result = await tool.execute({ filter: "FullyQualifiedName~Nope", no_build: true }, ctx);
    expect(result.content).toContain("Result: NOT MEASURED");
    expect(result.content).not.toContain("PASSED");
    // The reason dotnet gave is shown, so the model can fix its filter.
    expect(result.content).toContain("No test matches the given testcase filter");
  });

  it("says NOT MEASURED when the run wrote no report at all (nothing to test was found)", async () => {
    dotnetTestRun({ stdout: "  Game.Core -> /work/Game.Core/bin/Debug/net10.0/Game.Core.dll\n\nBuild succeeded.\n    0 Warning(s)\n    0 Error(s)", exitCode: 0 });
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("Result: NOT MEASURED");
    expect(result.content).not.toContain("PASSED");
  });

  it("is never green on a report it cannot read, whatever the console claims", async () => {
    dotnetTestRun({
      stdout: "Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 8 ms - Game.Tests.dll (net8.0)",
      exitCode: 0,
      trx: [`<?xml version="1.0" encoding="utf-8"?>\n<TestRun id="x" name="cut short">\n  <Results>\n`],
    });
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("Result: NOT MEASURED");
    expect(result.content).not.toContain("PASSED");
  });

  it("says NOT MEASURED when every test was skipped", async () => {
    dotnetTestRun({
      stdout: "",
      exitCode: 0,
      trx: [trx({ total: 1, executed: 0, passed: 0, failed: 0 }, [trxResult("Game.Tests.BoardTests.Later", "NotExecuted", "not yet")])],
    });
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("Result: NOT MEASURED");
    expect(result.content).toContain("Skipped: 1");
  });

  it("is FAILED when the report records a failure, even if dotnet exited 0", async () => {
    dotnetTestRun({ stdout: "", exitCode: 0, trx: [FAILING_TRX] });
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("Result: FAILED");
    expect(result.isError).toBe(true);
  });

  it("sums the reports of every test project in a solution", async () => {
    dotnetTestRun({ stdout: "", exitCode: 1, trx: [FAILING_TRX, PASSING_TRX] });
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("Total: 7 | Passed: 5 | Failed: 1 | Skipped: 1");
  });

  it("shows the output when the run failed before any test did (a build error)", async () => {
    dotnetTestRun({
      stdout: "/work/Game/Board.cs(12,5): error CS1002: ; expected [/work/Game/Game.csproj]\n\nBuild FAILED.",
      exitCode: 1,
    });
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("Result: FAILED");
    expect(result.content).toContain("error CS1002");
  });

  it("is FAILED, and says it was stopped, when a run hung past its time limit", async () => {
    dotnetTestRun({ stdout: "  Passed Game.Tests.BoardTests.ClearsRow [4 ms]", exitCode: 124, timedOut: true });
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("Result: FAILED");
    expect(result.content).toContain("stopped at its time limit");
    expect(result.isError).toBe(true);
  });

  it("removes the report directory it made", async () => {
    const run = dotnetTestRun({ stdout: "", exitCode: 0, trx: [PASSING_TRX] });
    await tool.execute({}, ctx);
    expect(run.resultsDir()).toBeDefined();
    expect(existsSync(run.resultsDir()!)).toBe(false);
  });
});

/**
 * `--no-build` runs whatever the last successful compile left in bin/. After
 * a build that failed, that is the code from BEFORE the edit. Measured
 * 2026-10-11 with dotnet 10.0.400 on a scratch xunit project: an edit that
 * broke the compile and added a failing test, dotnet_build exit 1 (CS1002),
 * then dotnet_test {no_build} read "Result: PASSED, Total: 1" and the gate
 * cleared the compile and test debt of code that never compiled.
 */
describe("dotnet_test {no_build} after a build that failed (stale bin/)", () => {
  const COMPILE_ERROR =
    "  Determining projects to restore...\n  All projects are up-to-date for restore.\n" +
    "/work/Game.Tests/UnitTest1.cs(8,11): error CS1002: ; expected [/work/Game.Tests/Game.Tests.csproj]\n\nBuild FAILED.\n\n" +
    "/work/Game.Tests/UnitTest1.cs(8,11): error CS1002: ; expected [/work/Game.Tests/Game.Tests.csproj]\n    0 Warning(s)\n    1 Error(s)";
  let defaultImpl: typeof runProcess | undefined;
  const roots: string[] = [];
  beforeEach(() => {
    defaultImpl = vi.mocked(runProcess).getMockImplementation();
  });
  afterEach(() => {
    vi.mocked(runProcess).mockImplementation(defaultImpl!);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /**
   * dotnet over one project: a build (or a building test) compiles the source
   * as it is now; `--no-build` runs the last DLL that compiled, whose one
   * test passes.
   */
  function dotnetOnDisk(source: { compiles: boolean; testsFail?: boolean }): { calls: () => string[][] } {
    const calls: string[][] = [];
    vi.mocked(runProcess).mockImplementation(async (call) => {
      calls.push(call.args);
      const done = { stderr: "", timedOut: false, durationMs: 5 };
      if (!call.args.includes("--no-build") && !source.compiles) return { ...done, stdout: COMPILE_ERROR, exitCode: 1 };
      if (call.args[0] === "build") return { ...done, stdout: "  Game.Tests -> /work/bin/Game.Tests.dll\n\nBuild succeeded.", exitCode: 0 };
      const at = call.args.indexOf("--results-directory");
      mkdirSync(call.args[at + 1]!, { recursive: true });
      writeFileSync(join(call.args[at + 1]!, "host_net10.0.trx"), source.testsFail ? FAILING_TRX : PASSING_TRX);
      // What 10.0.400 printed for a run whose tests failed: "Build FAILED.",
      // and no MSBuild error line.
      return source.testsFail
        ? { ...done, stdout: "  Failed Game.Tests.BoardTests.BoardSwapFails [1 ms]\n\nBuild FAILED.\n    0 Warning(s)\n    0 Error(s)", exitCode: 1 }
        : { ...done, stdout: "", exitCode: 0 };
    });
    return { calls: () => calls };
  }

  const workspace = (): ToolContext => {
    const root = mkdtempSync(join(tmpdir(), "strada-stale-dll-"));
    roots.push(root);
    for (const name of ["Game.Core", "Game.Tests"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, `${name}.csproj`), `<Project Sdk="Microsoft.NET.Sdk" />`);
    }
    return { projectPath: root, workingDirectory: root, readOnly: false };
  };
  const testsProject = "Game.Tests/Game.Tests.csproj";

  it("does not run the last good DLL after the build failed, and names the failure", async () => {
    const at = workspace();
    const dotnet = dotnetOnDisk({ compiles: false });
    const verifier = new SelfVerification();
    verifier.track("file_write", { path: "Game.Tests/UnitTest1.cs" }, { toolCallId: "w", content: "written", isError: false });

    const build = await new DotnetBuildTool().execute({ project: testsProject }, at);
    expect(build.isError).toBe(true);
    verifier.track("dotnet_build", { project: testsProject }, { toolCallId: "b", content: build.content, isError: build.isError, metadata: build.metadata });

    const result = await new DotnetTestTool().execute({ project: testsProject, no_build: true }, at);
    expect(result.content).toContain("Result: NOT MEASURED");
    expect(result.content).not.toContain("PASSED");
    expect(result.content).toContain("CS1002");
    expect(result.content).toContain(testsProject);
    expect(result.isError).toBe(false);
    // Nothing ran: the DLL in bin/ is not the code on disk.
    expect(dotnet.calls().filter((args) => args[0] === "test")).toEqual([]);

    verifier.track("dotnet_test", { project: testsProject, no_build: true }, { toolCallId: "t", content: result.content, isError: result.isError, metadata: result.metadata });
    expect(verifier.needsVerification()).toBe(true);
  });

  it("runs again once a build of the same target has succeeded", async () => {
    const at = workspace();
    const source = { compiles: false };
    dotnetOnDisk(source);
    await new DotnetBuildTool().execute({ project: testsProject }, at);
    source.compiles = true;
    expect((await new DotnetBuildTool().execute({ project: testsProject }, at)).isError).toBe(false);

    const result = await new DotnetTestTool().execute({ project: testsProject, no_build: true }, at);
    expect(result.content).toContain("Result: PASSED");
  });

  it("is refused after a failed build of another project in the workspace (a referenced library is stale too)", async () => {
    const at = workspace();
    const source = { compiles: false };
    dotnetOnDisk(source);
    await new DotnetBuildTool().execute({ project: "Game.Core/Game.Core.csproj" }, at);
    source.compiles = true;
    await new DotnetBuildTool().execute({ project: testsProject }, at);

    const result = await new DotnetTestTool().execute({ project: testsProject, no_build: true }, at);
    expect(result.content).toContain("Result: NOT MEASURED");
    expect(result.content).toContain("Game.Core/Game.Core.csproj");
  });

  it("treats a building dotnet_test that failed to compile as a failed build, and one that exited 0 as a clean one", async () => {
    const at = workspace();
    const source = { compiles: false };
    dotnetOnDisk(source);
    expect((await new DotnetTestTool().execute({ project: testsProject }, at)).content).toContain("Result: FAILED");
    expect((await new DotnetTestTool().execute({ project: testsProject, no_build: true }, at)).content).toContain("Result: NOT MEASURED");

    source.compiles = true;
    expect((await new DotnetTestTool().execute({ project: testsProject }, at)).content).toContain("Result: PASSED");
    expect((await new DotnetTestTool().execute({ project: testsProject, no_build: true }, at)).content).toContain("Result: PASSED");
  });

  it("does not read a building run whose TESTS failed as a failed build", async () => {
    const at = workspace();
    dotnetOnDisk({ compiles: true, testsFail: true });
    expect((await new DotnetTestTool().execute({ project: testsProject }, at)).content).toContain("Result: FAILED");
    const result = await new DotnetTestTool().execute({ project: testsProject, no_build: true }, at);
    expect(result.content).toContain("Result: FAILED");
    expect(result.content).toContain("✗ Game.Tests.BoardTests.BoardSwapFails");
  });

  it("does not hold one workspace's failed build against another", async () => {
    dotnetOnDisk({ compiles: false });
    await new DotnetBuildTool().execute({ project: testsProject }, workspace());
    const result = await new DotnetTestTool().execute({ project: testsProject, no_build: true }, workspace());
    expect(result.content).toContain("Result: PASSED");
  });
});

/**
 * The verdict line is what the self-verification gate reads. A zero-test run
 * exits 0, and that exit emptied the unrun-test debt (tools#1 claim 3).
 */
describe("a dotnet_test run that measured nothing does not settle the test gate", () => {
  async function gateAfter(run: { stdout: string; exitCode: number; trx?: string[] }): Promise<SelfVerification> {
    const verifier = new SelfVerification();
    verifier.track("file_write", { path: "Game.Tests/BoardTests.cs" }, { toolCallId: "w", content: "written", isError: false });
    dotnetTestRun(run);
    const result = await new DotnetTestTool().execute({}, ctx);
    verifier.track("dotnet_test", {}, { toolCallId: "t", content: result.content, isError: result.isError, metadata: result.metadata });
    return verifier;
  }

  it("keeps the written tests owed after a run of zero tests", async () => {
    const verifier = await gateAfter({ stdout: "", exitCode: 0, trx: [ZERO_TEST_TRX] });
    expect(verifier.needsVerification()).toBe(true);
    expect(verifier.getPrompt()).toContain("[TESTS NOT RUN]");
  });

  it("still clears them after a run that passed", async () => {
    const verifier = await gateAfter({ stdout: TURKISH_PASSING_CONSOLE, exitCode: 0, trx: [PASSING_TRX] });
    expect(verifier.needsVerification()).toBe(false);
  });
});

describe("DotnetBuildTool", () => {
  const tool = new DotnetBuildTool();

  it("has correct metadata", () => {
    expect(tool.name).toBe("dotnet_build");
    expect(tool.inputSchema.properties).toHaveProperty("project");
    expect(tool.inputSchema.properties).toHaveProperty("configuration");
  });

  it("blocks in read-only mode", async () => {
    const result = await tool.execute({}, { ...ctx, readOnly: true });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("handles dotnet not installed gracefully", async () => {
    // This test verifies the tool doesn't crash when dotnet isn't available
    const result = await tool.execute({}, ctx);
    // Should return an error but not throw
    expect(result.content).toBeDefined();
    expect(typeof result.content).toBe("string");
  });

  it("takes a configuration NAME only, for build and test alike (TLS-17)", async () => {
    for (const configuration of ["-p:Foo=bar", "Release; x", "", 7]) {
      for (const t of [tool, new DotnetTestTool()]) {
        vi.mocked(runProcess).mockClear();
        const result = await t.execute({ configuration }, ctx);
        expect(result.content, String(configuration)).toContain("'configuration' must be a build configuration name");
        expect(runProcess).not.toHaveBeenCalled();
      }
    }
    await tool.execute({ configuration: "Staging" }, ctx);
    expect(vi.mocked(runProcess).mock.calls.at(-1)![0].args).toEqual(expect.arrayContaining(["-c", "Staging"]));
  });
});

describe("DotnetTestTool", () => {
  const tool = new DotnetTestTool();

  it("has correct metadata", () => {
    expect(tool.name).toBe("dotnet_test");
    expect(tool.inputSchema.properties).toHaveProperty("filter");
    expect(tool.inputSchema.properties).toHaveProperty("no_build");
  });

  it("blocks in read-only mode", async () => {
    const result = await tool.execute({}, { ...ctx, readOnly: true });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read-only");
  });

  it("handles dotnet not installed gracefully", async () => {
    const result = await tool.execute({}, ctx);
    expect(result.content).toBeDefined();
    expect(typeof result.content).toBe("string");
  });
});

/**
 * Audited 2026-09-02: the read-only prompt promised "Running builds and tests
 * (read-only verification)" and the guard let dotnet_build/dotnet_test through,
 * while both tools refused with "disabled in read-only mode". A capability the
 * platform advertises must not be one the tool refuses.
 */
describe("read-only contract for dotnet_build and dotnet_test", () => {
  it("is refused by the guard before the tool has to refuse it", () => {
    for (const name of ["dotnet_build", "dotnet_test"]) {
      const verdict = checkReadOnlyBlock(name, true);
      expect(verdict.allowed).toBe(false);
      expect(verdict.suggestion).toMatch(/bin\/ and obj\//);
    }
  });

  it("is not promised by the read-only system prompt", () => {
    const prompt = getReadOnlySystemPrompt();
    expect(prompt).not.toMatch(/Running builds and tests \(read-only verification\)/);
    expect(prompt).toMatch(/Blocked Operations[\s\S]*Running builds and tests/);
  });

  it("still refuses at the tool when called directly in read-only mode", async () => {
    for (const tool of [new DotnetBuildTool(), new DotnetTestTool()]) {
      const result = await tool.execute({}, { ...ctx, readOnly: true });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("read-only");
    }
  });
});

/**
 * `dotnet build` / `dotnet test` run the project's own MSBuild targets and
 * test code. They used to inherit the full process.env — every provider key
 * and bot token — instead of shell_exec's default-deny environment.
 */
describe("dotnet tools spawn with the default-deny environment", () => {
  it.each([
    ["dotnet_build", () => new DotnetBuildTool()],
    ["dotnet_test", () => new DotnetTestTool()],
  ] as const)("%s withholds secrets and keeps what dotnet needs", async (_name, make) => {
    process.env["STRADA_TEST_PROVIDER_API_KEY"] = "sk-must-not-leak";
    try {
      await make().execute({}, ctx);
      const call = vi.mocked(runProcess).mock.calls.at(-1)![0];
      expect(call.env).toBeDefined();
      expect(Object.values(call.env!)).not.toContain("sk-must-not-leak");
      expect(call.env!["PATH"]).toBe(process.env["PATH"]);
      expect(call.env!["DOTNET_NOLOGO"]).toBe("1");
      expect(call.env!["DOTNET_CLI_TELEMETRY_OPTOUT"]).toBe("1");
      // The machine's UI language reached the output (Turkish on this host).
      expect(call.env!["DOTNET_CLI_UI_LANGUAGE"]).toBe("en");
    } finally {
      delete process.env["STRADA_TEST_PROVIDER_API_KEY"];
    }
  });
});
