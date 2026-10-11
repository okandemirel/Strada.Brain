import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // English whatever the machine's UI language: what the model and the
    // build-error parser read was Turkish on this host.
    env: {
      ...buildShellEnv(process.env).env,
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_NOLOGO: "1",
      DOTNET_CLI_UI_LANGUAGE: "en",
    },
  });
}

/**
 * The `-c` value: a configuration NAME (Debug, Release, or a project's own
 * such as Staging). It was free text, so an option-shaped or garbage value
 * reached dotnet's argument list (review TLS-17).
 */
function configurationArg(input: Record<string, unknown>): string | undefined {
  const config = input["configuration"] ?? "Debug";
  return typeof config === "string" && /^[A-Za-z][\w.-]{0,63}$/.test(config) ? config : undefined;
}

const CONFIGURATION_ERROR = "Error: 'configuration' must be a build configuration name such as Debug or Release";

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

    const config = configurationArg(input);
    if (!config) return { content: CONFIGURATION_ERROR, isError: true };
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

interface FailedTest {
  name: string;
  errorMessage?: string;
}

type TestSummary = { total: number; passed: number; failed: number; skipped: number };

interface TrxReport {
  summary: TestSummary;
  failures: FailedTest[];
}

type TestVerdict = "PASSED" | "FAILED" | "NOT MEASURED";

/** TRX outcomes that are a failure; the rest passed or did not run. */
const FAILED_OUTCOMES: ReadonlySet<string> = new Set(["Failed", "Error", "Timeout", "Aborted"]);

const XML_ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/** One pass, so "&amp;lt;" decodes to "&lt;" and not on to "<". */
function xmlText(value: string): string {
  // A message's line breaks can arrive as character references (&#xD;, &#xA;).
  return value.replace(/&(?:(lt|gt|quot|apos|amp)|#x([0-9a-f]+)|#(\d+));/gi, (ref, name?: string, hex?: string, dec?: string) => {
    if (name !== undefined) return XML_ENTITIES[name] ?? ref;
    const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : ref;
  });
}

function xmlAttr(tag: string, name: string): string | undefined {
  const value = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  return value === undefined ? undefined : xmlText(value);
}

/**
 * One TRX report (`--logger trx`), or null when it holds no run summary: a
 * report cut short, or a shape this reader does not know. Null is "not
 * measured", never "nothing failed".
 *
 * The verdict used to be read off the console, which the SDK localizes — on
 * a Turkish macOS every line was "Başarılı"/"Toplam test sayısı" and no
 * pattern matched — and which at -v normal carries MSBuild's indented
 * "Failed to load prune package data …", read as a failed test. A passing
 * run reported FAILED with that phantom as its only failure, a failing run
 * hid its real one, and a run of zero tests reported PASSED (audited
 * 2026-10-11, measured with dotnet 10.0.400 here). The TRX is the test
 * platform's own record, in invariant element names.
 */
function parseTrxReport(xml: string): TrxReport | null {
  const counters = /<Counters\b([^>]*?)\/?>/.exec(xml)?.[1];
  if (counters === undefined) return null;
  const count = (name: string): number => {
    const value = Number(xmlAttr(counters, name) ?? "0");
    return Number.isFinite(value) ? value : 0;
  };
  const total = count("total");
  const passed = count("passed");
  const failed = count("failed") + count("error") + count("timeout") + count("aborted");
  // A skipped test is counted in `total` and nowhere else (xunit leaves
  // notExecuted at 0 for [Fact(Skip)]), so the skips are what is left over.
  const skipped = Math.max(0, total - passed - failed);

  const failures: FailedTest[] = [];
  for (const m of xml.matchAll(/<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
    const outcome = xmlAttr(m[1]!, "outcome");
    if (outcome === undefined || !FAILED_OUTCOMES.has(outcome)) continue;
    const message = /<Message>([\s\S]*?)<\/Message>/.exec(m[2] ?? "")?.[1];
    failures.push({
      name: xmlAttr(m[1]!, "testName") ?? "(unnamed test)",
      ...(message === undefined ? {} : { errorMessage: xmlText(message).trim() }),
    });
  }
  return { summary: { total, passed, failed, skipped }, failures };
}

/** Every report under `dir` — one per test project and target framework. */
async function readTrxReports(dir: string): Promise<{ reports: TrxReport[]; unreadable: number }> {
  let names: string[];
  try {
    names = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith(".trx"));
  } catch {
    // Never created: no test host ran.
    return { reports: [], unreadable: 0 };
  }
  const reports: TrxReport[] = [];
  let unreadable = 0;
  for (const name of names) {
    const report = parseTrxReport(await readFile(join(dir, name), "utf8").catch(() => ""));
    if (report) reports.push(report);
    else unreadable++;
  }
  return { reports, unreadable };
}

/**
 * PASSED needs a clean exit AND readable reports in which tests ran and none
 * failed. A non-zero exit, a timeout, or a recorded failure is FAILED.
 * Everything else is NOT MEASURED: `dotnet test` exits 0 for a filter that
 * matches nothing and for a solution with no test project.
 */
function judgeTestRun(
  exitCode: number,
  timedOut: boolean,
  summary: TestSummary,
  reports: number,
  unreadable: number,
): { verdict: TestVerdict; reason?: string } {
  if (timedOut || exitCode !== 0) {
    if (summary.failed > 0) return { verdict: "FAILED" };
    return {
      verdict: "FAILED",
      reason: timedOut
        ? "dotnet test was stopped at its time limit before it recorded a failed test — see the output below."
        : `dotnet test exited with code ${exitCode} and recorded no failed test — see the output below.`,
    };
  }
  if (summary.failed > 0) return { verdict: "FAILED" };
  if (unreadable > 0) {
    return { verdict: "NOT MEASURED", reason: `${unreadable} test report(s) could not be read, so this run's outcome is unknown.` };
  }
  if (reports === 0) {
    return { verdict: "NOT MEASURED", reason: "No test ran: dotnet test wrote no test report (no test project was found, or no test host started)." };
  }
  if (summary.passed === 0) {
    return {
      verdict: "NOT MEASURED",
      reason: summary.skipped > 0
        ? `No test ran: all ${summary.skipped} were skipped.`
        : "No test ran: 0 tests were executed (a filter that matched nothing, or no test was discovered).",
    };
  }
  return { verdict: "PASSED" };
}

export class DotnetTestTool implements ITool {
  readonly name = "dotnet_test";
  readonly description =
    "Run .NET tests using 'dotnet test'. " +
    "Reads the run's TRX report to show passed, failed, and skipped tests with error messages; " +
    "a run in which no test executed is reported as NOT MEASURED, not as a pass. " +
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

    const config = configurationArg(input);
    if (!config) return { content: CONFIGURATION_ERROR, isError: true };
    args.push("-c", config);

    if (input["filter"]) {
      args.push("--filter", String(input["filter"]));
    }

    if (input["no_build"]) {
      args.push("--no-build");
    }

    args.push("-v", "normal");

    // The outcome is read from the TRX reports, written to a directory of
    // this call's own so no earlier run's report can stand in for this one.
    const resultsDir = await mkdtemp(join(tmpdir(), "strada-dotnet-test-"));
    args.push("--logger", "trx", "--results-directory", resultsDir);

    try {
      const result = await run("dotnet", args, context.projectPath, TEST_TIMEOUT_MS);
      const combined = result.stdout + "\n" + result.stderr;
      const { reports, unreadable } = await readTrxReports(resultsDir);
      const summary: TestSummary = { total: 0, passed: 0, failed: 0, skipped: 0 };
      for (const report of reports) {
        summary.total += report.summary.total;
        summary.passed += report.summary.passed;
        summary.failed += report.summary.failed;
        summary.skipped += report.summary.skipped;
      }
      const failures = reports.flatMap((report) => report.failures);
      const { verdict, reason } = judgeTestRun(result.exitCode, result.timedOut, summary, reports.length, unreadable);

      const parts: string[] = [];
      parts.push(`dotnet test (${config})`);

      if (result.timedOut) {
        parts.push("⚠ Tests timed out after 5 minutes");
      }

      parts.push(`\nResult: ${verdict}`);
      if (reports.length > 0) {
        parts.push(`Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed} | Skipped: ${summary.skipped}`);
      }
      if (reason) parts.push(reason);

      if (failures.length > 0) {
        parts.push(`\n### Failed Tests (${failures.length})`);
        for (const t of failures.slice(0, 20)) {
          parts.push(`  ✗ ${t.name}`);
          if (t.errorMessage) {
            parts.push(t.errorMessage.slice(0, 600).split(/\r?\n/u).map((line) => `    ${line}`).join("\n"));
          }
        }
        if (failures.length > 20) {
          parts.push(`  ... and ${failures.length - 20} more failures`);
        }
      }

      // What the reports do not explain — a build error, a crashed test host,
      // a filter that matched nothing — the output still can.
      if (verdict !== "PASSED" && failures.length === 0 && combined.trim()) {
        parts.push(`\n--- Raw Output ---\n${combined.slice(-3000)}`);
      }

      return {
        content: parts.join("\n"),
        isError: verdict === "FAILED",
        metadata: {
          exitCode: result.exitCode,
          verdict,
          ...(reports.length > 0 ? summary : {}),
          timedOut: result.timedOut,
        },
      };
    } finally {
      await rm(resultsDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// Re-export parsers for testing
export { parseBuildOutput, parseTrxReport };
