import { resolve } from "node:path";
import { runProcess } from "../../utils/process-runner.js";
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
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
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
    const args = ["build"];

    if (input["project"]) {
      args.push(resolve(context.projectPath, String(input["project"])));
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

function parseTestOutput(output: string): {
  tests: TestResult[];
  summary: { total: number; passed: number; failed: number; skipped: number };
} {
  const tests: TestResult[] = [];

  // Parse individual test results
  // Format: "  Passed TestName [1ms]" or "  Failed TestName [5ms]"
  const testPattern = /^\s+(Passed|Failed|Skipped)\s+(.+?)(?:\s+\[([^\]]+)\])?\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = testPattern.exec(output)) !== null) {
    tests.push({
      name: match[2]!.trim(),
      outcome: match[1]!.toLowerCase() as "passed" | "failed" | "skipped",
      duration: match[3],
    });
  }

  // Parse error messages for failed tests
  const failPattern = /Failed\s+(.+?)\n\s+Error Message:\s*\n\s+(.+?)(?:\n\s+Stack Trace:|\n\s*\n)/gs;
  while ((match = failPattern.exec(output)) !== null) {
    const failedTest = tests.find((t) => t.name === match![1]!.trim());
    if (failedTest) {
      failedTest.errorMessage = match[2]!.trim();
    }
  }

  // Parse summary line: "Total: X, Passed: Y, Failed: Z, Skipped: W"
  const summaryMatch = output.match(
    /Total:\s*(\d+).*?Passed:\s*(\d+).*?Failed:\s*(\d+).*?Skipped:\s*(\d+)/i,
  );

  const summary = summaryMatch
    ? {
        total: parseInt(summaryMatch[1]!, 10),
        passed: parseInt(summaryMatch[2]!, 10),
        failed: parseInt(summaryMatch[3]!, 10),
        skipped: parseInt(summaryMatch[4]!, 10),
      }
    : {
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
    const args = ["test"];

    if (input["project"]) {
      args.push(resolve(context.projectPath, String(input["project"])));
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
    const statusIcon = s.failed > 0 ? "FAILED" : "PASSED";
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
