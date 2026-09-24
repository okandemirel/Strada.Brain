import { describe, it, expect, vi } from "vitest";
import { DotnetBuildTool, DotnetTestTool, parseBuildOutput, parseTestOutput } from "./dotnet-tools.js";
import type { ToolContext } from "./tool.interface.js";
import { checkReadOnlyBlock, getReadOnlySystemPrompt } from "../../security/read-only-guard.js";
import { runProcess } from "../../utils/process-runner.js";

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

describe("parseTestOutput", () => {
  it("parses passed tests", () => {
    const output = `
  Passed MyNamespace.MyTests.TestAdd [5ms]
  Passed MyNamespace.MyTests.TestSub [2ms]

Total:     2
Passed:    2
Failed:    0
Skipped:   0
`;
    const { tests, summary } = parseTestOutput(output);
    expect(tests).toHaveLength(2);
    expect(tests[0]!.outcome).toBe("passed");
    expect(tests[0]!.name).toBe("MyNamespace.MyTests.TestAdd");
    expect(tests[0]!.duration).toBe("5ms");
  });

  it("parses failed tests", () => {
    const output = `
  Passed MyTests.Good [1ms]
  Failed MyTests.Bad [10ms]

Total:     2
Passed:    1
Failed:    1
Skipped:   0
`;
    const { tests, summary } = parseTestOutput(output);
    expect(tests).toHaveLength(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.total).toBe(2);
  });

  it("parses skipped tests", () => {
    const output = `
  Passed A [1ms]
  Skipped B
  Skipped C

Total:     3
Passed:    1
Failed:    0
Skipped:   2
`;
    const { tests, summary } = parseTestOutput(output);
    expect(tests).toHaveLength(3);
    expect(summary.skipped).toBe(2);
  });

  it("handles summary line format", () => {
    const output = `Total:  10, Passed:  8, Failed:  1, Skipped:  1`;
    const { summary } = parseTestOutput(output);
    expect(summary.total).toBe(10);
    expect(summary.passed).toBe(8);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it("handles empty output", () => {
    const { tests, summary } = parseTestOutput("");
    expect(tests).toHaveLength(0);
    expect(summary.total).toBe(0);
  });
});

/**
 * TLS-9 (audited 2026-09-24): the fixtures above were written to fit the
 * parser. These follow what `dotnet test` prints: vstest's console logger
 * (src/vstest.console/Internal/ConsoleLogger.cs and its Resources.resx —
 * TestRunSummary, TestRunSummaryTotalTests/PassedTests/FailedTests,
 * "  Failed <name> [<duration>]", "  Error Message:", "  Stack Trace:").
 * No SDK was available to capture a live run, so each line reproduces those
 * format strings exactly, padding included.
 */
describe("parseTestOutput on the SDK's own output", () => {
  const NORMAL_FAILING = [
    "  Determining projects to restore...",
    "  All projects are up-to-date for restore.",
    "  Game.Tests -> /work/Game.Tests/bin/Debug/net8.0/Game.Tests.dll",
    "Test run for /work/Game.Tests/bin/Debug/net8.0/Game.Tests.dll (.NETCoreApp,Version=v8.0)",
    "Microsoft (R) Test Execution Command Line Tool Version 17.8.0 (x64)",
    "Copyright (c) Microsoft Corporation.  All rights reserved.",
    "",
    "Starting test execution, please wait...",
    "A total of 1 test files matched the specified pattern.",
    "  Passed Game.Tests.BoardTests.ClearsRow [3 ms]",
    "  Failed Game.Tests.BoardTests.DropsPiece [12 ms]",
    "  Error Message:",
    "   Expected: 4",
    "  But was:  3",
    "  Stack Trace:",
    "     at Game.Tests.BoardTests.DropsPiece() in /work/Game.Tests/BoardTests.cs:line 27",
    "",
    "  Failed Game.Tests.BoardTests.ScoresCombo [< 1 ms]",
    "  Error Message:",
    "   System.NullReferenceException : Object reference not set to an instance of an object.",
    "  Stack Trace:",
    "     at Game.Tests.BoardTests.ScoresCombo() in /work/Game.Tests/BoardTests.cs:line 41",
    "",
    "Test Run Failed.",
    "Total tests: 3",
    "     Passed: 1",
    "     Failed: 2",
    " Total time: 0.8421 Seconds",
  ].join("\n");

  it("attaches each failure's message to its test (the header carries a duration)", () => {
    const { tests } = parseTestOutput(NORMAL_FAILING);
    const failed = tests.filter((t) => t.outcome === "failed");
    expect(failed.map((t) => t.name)).toEqual(["Game.Tests.BoardTests.DropsPiece", "Game.Tests.BoardTests.ScoresCombo"]);
    expect(failed[0]!.errorMessage).toContain("Expected: 4");
    expect(failed[1]!.errorMessage).toContain("NullReferenceException");
  });

  it("reads the run's totals, not the per-test lines that survived a tail cut", () => {
    // process-runner keeps the TAIL: the first failed test fell off the front.
    const tail = NORMAL_FAILING.slice(NORMAL_FAILING.indexOf("  Failed Game.Tests.BoardTests.ScoresCombo"));
    expect(parseTestOutput(tail).summary).toEqual({ total: 3, passed: 1, failed: 2, skipped: 0 });
  });

  it("sums the minimal-verbosity line of every test assembly", () => {
    const minimal = [
      "Failed!  - Failed:     2, Passed:     1, Skipped:     0, Total:     3, Duration: 20 ms - Game.Tests.dll (net8.0)",
      "Passed!  - Failed:     0, Passed:     5, Skipped:     1, Total:     6, Duration: 8 ms - Game.Editor.Tests.dll (net8.0)",
    ].join("\n");
    expect(parseTestOutput(minimal).summary).toEqual({ total: 9, passed: 6, failed: 2, skipped: 1 });
  });

  it("sums the normal-verbosity blocks of several test projects", () => {
    const twoRuns = [
      "Test Run Failed.", "Total tests: 3", "     Passed: 1", "     Failed: 2", " Total time: 0.8 Seconds",
      "Test Run Successful.", "Total tests: 4", "     Passed: 3", "    Skipped: 1", " Total time: 0.2 Seconds",
    ].join("\n");
    expect(parseTestOutput(twoRuns).summary).toEqual({ total: 7, passed: 4, failed: 2, skipped: 1 });
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
    } finally {
      delete process.env["STRADA_TEST_PROVIDER_API_KEY"];
    }
  });
});
