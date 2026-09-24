import { runProcess } from "../../utils/process-runner.js";
import { validatePath, normalizeToolPathInput } from "../../security/path-guard.js";
import { buildShellEnv } from "./shell-env-policy.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";

const BUILD_TIMEOUT_MS = 120_000; // 2 minutes
const TEST_TIMEOUT_MS = 300_000; // 5 minutes

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
) {
  return runProcess({
    command,
    args,
    cwd,
    timeoutMs,
    // Default-deny environment, as for shell_exec: build and test run the
    // project's own MSBuild targets and test code, which must not inherit
    // this process's provider keys and bot tokens. See shell-env-policy.ts.
    env: { ...buildShellEnv(process.env).env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
  });
}

// ─── dotnet_build ─────────────────────────────────────────────────────────────

interface BuildError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  severity: "error" | "warning";
}

function parseBuildOutput(output: string): { errors: BuildError[]; warnings: BuildError[] } {
  const errors: BuildError[] = [];
  const warnings: BuildError[] = [];

  // MSBuild format: path(line,col): error/warning CODE: message
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(\w+):\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    const entry: BuildError = {
      file: match[1]!,
      line: parseInt(match[2]!, 10),
      column: parseInt(match[3]!, 10),
      code: match[5]!,
      message: match[6]!,
      severity: match[4] as "error" | "warning",
    };
    if (entry.severity === "error") {
      errors.push(entry);
    } else {
      warnings.push(entry);
    }
  }

  return { errors, warnings };
}

export class DotnetBuildTool implements ITool {
  readonly name = "dotnet_build";
  readonly description =
    "Build a .NET/C# project or solution using 'dotnet build'. " +
    "Parses MSBuild output to extract errors and warnings with file locations. " +
    "Use this to verify code compiles after making changes.";

  readonly inputSchema = {
    type: "object",
    properties: {
      project: {
        type: "string",
        description:
          "Path to .csproj or .sln file relative to project root. " +
          "If omitted, builds from the project root (finds .sln/.csproj automatically).",
      },
      configuration: {
        type: "string",
        description: "Build configuration: 'Debug' (default) or 'Release'.",
      },
      restore: {
        type: "boolean",
        description: "Run NuGet restore before build. Default: true.",
      },
    },
    required: [],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return { content: "Error: dotnet build is disabled in read-only mode", isError: true };
    }

    const args = ["build"];

    if (input["project"]) {
      const normalized = normalizeToolPathInput(context.projectPath, String(input["project"]));
      if (!normalized.ok) {
        return { content: `Error: ${normalized.error}`, isError: true };
      }
      const pathCheck = await validatePath(context.projectPath, normalized.relativePath);
      if (!pathCheck.valid) {
        return { content: `Error: ${pathCheck.error}`, isError: true };
      }
      args.push(pathCheck.fullPath);
    }

    const config = String(input["configuration"] ?? "Debug");
    args.push("-c", config);

    if (input["restore"] === false) {
      args.push("--no-restore");
    }

    // Verbosity for parseable output
    args.push("-v", "minimal");

    const result = await run("dotnet", args, context.projectPath, BUILD_TIMEOUT_MS);

    const combined = result.stdout + "\n" + result.stderr;
    const parsed = parseBuildOutput(combined);

    const parts: string[] = [];
    parts.push(`dotnet build (${config})`);

    if (result.timedOut) {
      parts.push("⚠ Build timed out after 2 minutes");
    }

    parts.push(`Exit code: ${result.exitCode}`);

    if (parsed.errors.length > 0) {
      parts.push(`\n### Errors (${parsed.errors.length})`);
      for (const e of parsed.errors.slice(0, 20)) {
        parts.push(`  ${e.file}(${e.line},${e.column}): ${e.code} — ${e.message}`);
      }
      if (parsed.errors.length > 20) {
        parts.push(`  ... and ${parsed.errors.length - 20} more errors`);
      }
    }

    if (parsed.warnings.length > 0) {
      parts.push(`\n### Warnings (${parsed.warnings.length})`);
      for (const w of parsed.warnings.slice(0, 10)) {
        parts.push(`  ${w.file}(${w.line},${w.column}): ${w.code} — ${w.message}`);
      }
      if (parsed.warnings.length > 10) {
        parts.push(`  ... and ${parsed.warnings.length - 10} more warnings`);
      }
    }

    if (parsed.errors.length === 0 && parsed.warnings.length === 0) {
      if (result.exitCode === 0) {
        parts.push("\nBuild succeeded with no errors or warnings.");
      } else {
        parts.push(`\nBuild failed.\n${combined.slice(-2000)}`);
      }
    }

    return {
      content: parts.join("\n"),
      isError: result.exitCode !== 0,
      metadata: {
        exitCode: result.exitCode,
        errorCount: parsed.errors.length,
        warningCount: parsed.warnings.length,
        timedOut: result.timedOut,
      },
    };
  }
}

// ─── dotnet_test ──────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  outcome: "passed" | "failed" | "skipped";
  duration?: string;
  errorMessage?: string;
}

type TestSummary = { total: number; passed: number; failed: number; skipped: number };

/** " [12 ms]" after a test name is its duration, not part of the name. */
const stripDuration = (name: string): string => name.replace(/\s+\[[^\]]*\]\s*$/u, "").trim();

/**
 * The run's own totals, in the shapes vstest's console logger writes (its
 * TestRunSummary* resources):
 *   minimal, one line per test assembly:
 *     "Failed!  - Failed:     2, Passed:     1, Skipped:     0, Total:     3, Duration: 20 ms - X.dll (net8.0)"
 *   normal (what `-v normal` gives), one block per run:
 *     "Total tests: 3" then "     Passed: 1", "     Failed: 2", "    Skipped: 1" (each only when non-zero)
 * Summed across assemblies and runs, since a solution runs several. The old
 * pattern expected a one-line "Total … Passed … Failed … Skipped" order no
 * SDK prints, so counts came from whichever per-test lines survived the
 * output's tail cut (audited 2026-09-24).
 */
function parseRunTotals(output: string): TestSummary | null {
  const perAssembly = [...output.matchAll(
    /^(?:Passed|Failed|Skipped)!\s+-\s+Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/gmu,
  )];
  if (perAssembly.length > 0) {
    const sum = (i: number): number => perAssembly.reduce((n, m) => n + parseInt(m[i]!, 10), 0);
    return { failed: sum(1), passed: sum(2), skipped: sum(3), total: sum(4) };
  }

  const lines = output.split(/\r?\n/u);
  let found = false;
  const totals: TestSummary = { total: 0, passed: 0, failed: 0, skipped: 0 };
  for (let i = 0; i < lines.length; i++) {
    const total = /^Total tests:\s*(\d+)\s*$/u.exec(lines[i]!);
    if (!total) continue;
    found = true;
    totals.total += parseInt(total[1]!, 10);
    for (let j = i + 1; j < lines.length; j++) {
      const count = /^\s+(Passed|Failed|Skipped):\s*(\d+)\s*$/u.exec(lines[j]!);
      if (!count) break;
      const key = count[1]!.toLowerCase() as "passed" | "failed" | "skipped";
      totals[key] += parseInt(count[2]!, 10);
    }
  }
  if (found) return totals;

  // A one-line "Total: X, Passed: Y, Failed: Z, Skipped: W".
  const oneLine = /Total:\s*(\d+).*?Passed:\s*(\d+).*?Failed:\s*(\d+).*?Skipped:\s*(\d+)/iu.exec(output);
  return oneLine
    ? {
        total: parseInt(oneLine[1]!, 10),
        passed: parseInt(oneLine[2]!, 10),
        failed: parseInt(oneLine[3]!, 10),
        skipped: parseInt(oneLine[4]!, 10),
      }
    : null;
}

function parseTestOutput(output: string): {
  tests: TestResult[];
  summary: TestSummary;
} {
  const tests: TestResult[] = [];

  // Parse individual test results
  // Format: "  Passed TestName [1 ms]" or "  Failed TestName [5 ms]"
  const testPattern = /^\s+(Passed|Failed|Skipped)\s+(.+?)(?:\s+\[([^\]]+)\])?\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = testPattern.exec(output)) !== null) {
    tests.push({
      name: match[2]!.trim(),
      outcome: match[1]!.toLowerCase() as "passed" | "failed" | "skipped",
      duration: match[3],
    });
  }

  // Parse error messages for failed tests. The header line carries the
  // duration ("Failed Name [3 ms]") and the stored name does not, so this
  // lookup used to miss every time.
  const failPattern = /Failed\s+(.+?)\n\s+Error Message:\s*\n\s+(.+?)(?:\n\s+Stack Trace:|\n\s*\n)/gs;
  while ((match = failPattern.exec(output)) !== null) {
    const name = stripDuration(match[1]!);
    const failedTest = tests.find((t) => t.outcome === "failed" && t.name === name);
    if (failedTest) {
      failedTest.errorMessage = match[2]!.trim();
    }
  }

  const summary = parseRunTotals(output) ?? {
    total: tests.length,
    passed: tests.filter((t) => t.outcome === "passed").length,
    failed: tests.filter((t) => t.outcome === "failed").length,
    skipped: tests.filter((t) => t.outcome === "skipped").length,
  };

  return { tests, summary };
}

export class DotnetTestTool implements ITool {
  readonly name = "dotnet_test";
  readonly description =
    "Run .NET tests using 'dotnet test'. " +
    "Parses test results to show passed, failed, and skipped tests with error messages. " +
    "Use this to verify code changes don't break existing functionality.";

  readonly inputSchema = {
    type: "object",
    properties: {
      project: {
        type: "string",
        description:
          "Path to test .csproj or .sln relative to project root. " +
          "If omitted, runs all tests from project root.",
      },
      filter: {
        type: "string",
        description:
          "Test filter expression (e.g., 'FullyQualifiedName~MyTest', 'Category=Unit').",
      },
      configuration: {
        type: "string",
        description: "Build configuration: 'Debug' (default) or 'Release'.",
      },
      no_build: {
        type: "boolean",
        description: "Skip build before testing. Use after a successful build.",
      },
    },
    required: [],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return { content: "Error: dotnet test is disabled in read-only mode", isError: true };
    }

    const args = ["test"];

    if (input["project"]) {
      const normalized = normalizeToolPathInput(context.projectPath, String(input["project"]));
      if (!normalized.ok) {
        return { content: `Error: ${normalized.error}`, isError: true };
      }
      const pathCheck = await validatePath(context.projectPath, normalized.relativePath);
      if (!pathCheck.valid) {
        return { content: `Error: ${pathCheck.error}`, isError: true };
      }
      args.push(pathCheck.fullPath);
    }

    const config = String(input["configuration"] ?? "Debug");
    args.push("-c", config);

    if (input["filter"]) {
      args.push("--filter", String(input["filter"]));
    }

    if (input["no_build"]) {
      args.push("--no-build");
    }

    args.push("-v", "normal");

    const result = await run("dotnet", args, context.projectPath, TEST_TIMEOUT_MS);
    const combined = result.stdout + "\n" + result.stderr;
    const parsed = parseTestOutput(combined);

    const parts: string[] = [];
    parts.push(`dotnet test (${config})`);

    if (result.timedOut) {
      parts.push("⚠ Tests timed out after 5 minutes");
    }

    // Summary
    const s = parsed.summary;
    // The exit code has the last word: counts read from a tail-cut log can
    // say "Failed: 0" for a run that failed.
    const statusIcon = s.failed > 0 || result.exitCode !== 0 || result.timedOut ? "FAILED" : "PASSED";
    parts.push(`\nResult: ${statusIcon}`);
    parts.push(`Total: ${s.total} | Passed: ${s.passed} | Failed: ${s.failed} | Skipped: ${s.skipped}`);

    // Show failed tests with details
    const failed = parsed.tests.filter((t) => t.outcome === "failed");
    if (failed.length > 0) {
      parts.push(`\n### Failed Tests (${failed.length})`);
      for (const t of failed.slice(0, 20)) {
        parts.push(`  ✗ ${t.name}`);
        if (t.errorMessage) {
          parts.push(`    ${t.errorMessage}`);
        }
      }
      if (failed.length > 20) {
        parts.push(`  ... and ${failed.length - 20} more failures`);
      }
    }

    // If no tests were parsed but the command had output, show raw output
    if (parsed.tests.length === 0 && combined.trim()) {
      parts.push(`\n--- Raw Output ---\n${combined.slice(-3000)}`);
    }

    return {
      content: parts.join("\n"),
      isError: result.exitCode !== 0,
      metadata: {
        exitCode: result.exitCode,
        ...parsed.summary,
        timedOut: result.timedOut,
      },
    };
  }
}

// Re-export parsers for testing
export { parseBuildOutput, parseTestOutput };
