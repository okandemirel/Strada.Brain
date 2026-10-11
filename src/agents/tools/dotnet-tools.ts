import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runProcess } from "../../utils/process-runner.js";
import { validatePath, normalizeToolPathInput } from "../../security/path-guard.js";
import { lexShell, type ShellLex } from "../../security/shell-lexer.js";
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

// ─── builds that failed ───────────────────────────────────────────────────────

/**
 * Per workspace, the builds that failed and have not since been followed by a
 * clean build of the same target and configuration.
 *
 * A failed compile leaves bin/ holding the last build that succeeded, and
 * `dotnet test --no-build` runs that DLL. Measured 2026-10-11 with dotnet
 * 10.0.400: an edit that broke the compile and added a failing test, then
 * dotnet_build exit 1, then dotnet_test {no_build} read "Result: PASSED,
 * Total: 1" (the old test alone), and the gate cleared the compile and test
 * debt of code that never compiled. Running the two calls in order closed a
 * race, not this.
 */
const failedBuilds = new Map<string, Map<string, string>>();
const MAX_TRACKED_WORKSPACES = 256;

/**
 * An MSBuild error line: compile (CS1002), analyzer (xUnit1001), restore
 * (NU1101), MSBuild (MSB3027), or one with no code (`error :`, an <Error>
 * task without Code). A `dotnet test` whose tests failed prints none, only
 * "Build FAILED.", so this tells its failed build from its failed tests
 * (measured, 10.0.400). The code was `[A-Z]{2,}\d+`, and xunit's own
 * `error xUnit1001:` failed a compile that was never recorded.
 */
const MSBUILD_ERROR_LINE = /^.*?:\s+error\s+(?:[A-Za-z]+\d+)?:.*$/m;

/** The real path, so a lexical and a resolved spelling of one root agree. */
async function workspaceKey(projectPath: string): Promise<string> {
  return realpath(projectPath).catch(() => resolve(projectPath));
}

type BuildTarget = { fullPath?: string; label: string };

function recordBuild(
  workspace: string,
  by: string,
  target: BuildTarget,
  config: string,
  result: { exitCode: number; timedOut: boolean; output: string },
  failed: boolean,
): void {
  const key = `${target.fullPath ?? ""}\0${config}`;
  let failures = failedBuilds.get(workspace);
  if (!failed) {
    failures?.delete(key);
    if (failures?.size === 0) failedBuilds.delete(workspace);
    return;
  }
  if (!failures) {
    failures = new Map();
    failedBuilds.set(workspace, failures);
    if (failedBuilds.size > MAX_TRACKED_WORKSPACES) failedBuilds.delete(failedBuilds.keys().next().value!);
  }
  const firstError = MSBUILD_ERROR_LINE.exec(result.output)?.[0].trim().slice(0, 300);
  const outcome = result.timedOut ? "timed out" : result.exitCode !== 0 ? `exit code ${result.exitCode}` : "failed";
  failures.set(key, `${by} of ${target.label} (${config}): ${outcome}` + (firstError ? ` — ${firstError}` : ""));
}

function outstandingFailures(workspace: string): string[] {
  return [...(failedBuilds.get(workspace)?.values() ?? [])];
}

// ─── dotnet through shell_exec ────────────────────────────────────────────────

/** Options of `dotnet build|test` that take the next word as their value. */
const DOTNET_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-c", "--configuration", "-f", "--framework", "-o", "--output", "-r", "--runtime", "-v", "--verbosity",
  "-a", "--arch", "--os", "-s", "--source", "--settings", "--filter", "-l", "--logger", "--results-directory",
  "--collect", "-e", "--environment", "-d", "--diag", "--test-adapter-path", "--blame-crash-dump-type",
  "--blame-hang-dump-type", "--blame-hang-timeout", "--version-suffix", "--artifacts-path", "-p", "--property",
]);

interface ShellDotnetCommand {
  verb: string;
  /** Compiles first: `dotnet build`, and `dotnet test` without --no-build. */
  builds: boolean;
  /** Runs test DLLs as bin/ holds them: `dotnet test --no-build`, `dotnet test X.dll`, `dotnet vstest`. */
  runsBuiltTests: boolean;
  target: BuildTarget;
  config: string;
}

/**
 * The `dotnet build|test|vstest` commands of a shell line run in `cwd`, keyed
 * as dotnet_build keys the same target, so either one clears the other's
 * failure. `cd` moves the directory the later commands run in.
 */
async function dotnetCommandsIn(read: ShellLex, cwd: string, workspace: string): Promise<ShellDotnetCommand[]> {
  const found: ShellDotnetCommand[] = [];
  let dir = cwd;
  for (const words of read.commands) {
    const values = words.map((word) => word.value);
    let at = 0;
    while (at < values.length && /^[A-Za-z_]\w*=/.test(values[at]!)) at += 1;
    const name = (values[at]?.split(/[/\\]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
    if (name === "cd") {
      const to = values.slice(at + 1).find((value) => !value.startsWith("-") && value.toLowerCase() !== "/d");
      if (to) dir = resolve(dir, to);
      continue;
    }
    const verb = values[at + 1];
    if (name !== "dotnet" || (verb !== "build" && verb !== "test" && verb !== "vstest")) continue;
    let config = "Debug";
    let targetWord: string | undefined;
    let noBuild = false;
    const rest = values.slice(at + 2);
    for (let i = 0; i < rest.length; i += 1) {
      const word = rest[i]!;
      if (!word.startsWith("-")) {
        targetWord ??= word;
        continue;
      }
      if (word === "--no-build") noBuild = true;
      const attached = /^(-{1,2}[^:=]+)[:=](.*)$/.exec(word);
      const option = attached?.[1] ?? word;
      const value = attached ? attached[2] : DOTNET_VALUE_OPTIONS.has(word) ? rest[++i] : undefined;
      if ((option === "-c" || option === "--configuration") && value) config = value;
    }
    const runsDll = targetWord !== undefined && /\.(?:dll|exe)$/i.test(targetWord);
    const target: BuildTarget = { label: "the project root" };
    const named = targetWord === undefined ? dir : resolve(dir, targetWord);
    const real = await realpath(named).catch(() => named);
    if (targetWord !== undefined || real !== workspace) {
      target.fullPath = real;
      target.label = targetWord ?? relative(workspace, real);
    }
    found.push({
      verb,
      builds: verb === "build" || (verb === "test" && !noBuild && !runsDll),
      runsBuiltTests: verb === "vstest" || (verb === "test" && (noBuild || runsDll)),
      target,
      config,
    });
  }
  return found;
}

function staleBinNotice(head: string, failures: readonly string[]): string {
  return [
    "Result: NOT MEASURED",
    `${head} the DLLs the last successful build left in bin/, and a build that failed after it means they are not the code on disk:`,
    ...failures.map((failure) => `  ${failure}`),
    "Fix the build and build again, or run dotnet test without --no-build so it compiles what it tests.",
  ].join("\n");
}

export interface ShellDotnet {
  /** Why the line must not run at all: it would only test a stale bin/. */
  readonly refusal: string | undefined;
  /** Records the line's builds; returns the NOT MEASURED notice when it tested a stale bin/. */
  settle(result: { exitCode: number; timedOut: boolean; stdout: string; stderr: string }): Promise<string | undefined>;
}

/**
 * `dotnet build` and `dotnet test --no-build` through shell_exec, judged
 * against the same record as dotnet_build and dotnet_test. Without it a
 * failed dotnet_build followed by shell `dotnet test --no-build`, or a failed
 * shell build followed by dotnet_test {no_build}, read the stale DLL as
 * PASSED (review of d02df154). Undefined for a line with neither.
 */
export async function shellDotnet(command: string, cwd: string, projectPath: string): Promise<ShellDotnet | undefined> {
  if (!/\bdotnet/i.test(command)) return undefined;
  const workspace = await workspaceKey(projectPath);
  const read = lexShell(command);
  const commands = await dotnetCommandsIn(read, cwd, workspace);
  if (commands.length === 0) return undefined;
  const firstRunner = commands.findIndex((c) => c.runsBuiltTests);
  const firstBuild = commands.findIndex((c) => c.builds);
  const before = outstandingFailures(workspace);
  // A build earlier in the line may clear the record, so that line runs and
  // is judged after.
  const refusal = firstRunner >= 0 && before.length > 0 && (firstBuild < 0 || firstBuild > firstRunner)
    ? `$ ${command}\n\n${staleBinNotice("Not run: this command tests", before)}`
    : undefined;
  return {
    refusal,
    async settle(result) {
      const output = `${result.stdout}\n${result.stderr}`;
      // One exit status and one output for the whole line, so every build in
      // it shares the verdict. An error line or a timeout fails them all,
      // whatever the status says (`dotnet build; true`); only an all-`&&`
      // line that exited 0 proves each of them compiled. A redirection moves
      // the output, not the status.
      const failed = result.timedOut || MSBUILD_ERROR_LINE.test(output);
      const clean = !failed
        && result.exitCode === 0
        && read.operators.every((op) => op === "&&")
        && [...read.hazards].every((hazard) => hazard === "redirection")
        && read.commands.every((words) => words.length > 0);
      if (failed || clean) {
        for (const c of commands) {
          if (c.builds) recordBuild(workspace, `shell_exec dotnet ${c.verb}`, c.target, c.config, { ...result, output }, failed);
        }
      }
      const after = firstRunner >= 0 ? outstandingFailures(workspace) : [];
      return after.length > 0 ? staleBinNotice("Not measured: the tests this command ran read", after) : undefined;
    },
  };
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

    const target: { fullPath?: string; label: string } = { label: "the project root" };
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
      target.fullPath = pathCheck.fullPath;
      target.label = normalized.relativePath;
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
    recordBuild(
      await workspaceKey(context.projectPath), "dotnet_build", target, config,
      { ...result, output: combined }, result.exitCode !== 0 || result.timedOut,
    );

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
        description:
          "Skip build before testing. Use after a successful build; while a build in this " +
          "workspace has failed since, the run is refused as NOT MEASURED (bin/ holds older code).",
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

    const target: { fullPath?: string; label: string } = { label: "the project root" };
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
      target.fullPath = pathCheck.fullPath;
      target.label = normalized.relativePath;
    }

    const config = configurationArg(input);
    if (!config) return { content: CONFIGURATION_ERROR, isError: true };
    args.push("-c", config);

    if (input["filter"]) {
      args.push("--filter", String(input["filter"]));
    }

    const workspace = await workspaceKey(context.projectPath);
    const noBuild = Boolean(input["no_build"]);
    if (noBuild) {
      // Any failed build in the workspace, not only this target's: a test
      // project's bin/ holds a copy of every library it references.
      const stale = outstandingFailures(workspace);
      if (stale.length > 0) {
        return {
          content: [
            `dotnet test (${config})`,
            "\nResult: NOT MEASURED",
            "Not run: with no_build, dotnet test runs the DLLs the last successful build left in bin/, " +
              "and a build that failed after it means they are not the code on disk:",
            ...stale.map((failure) => `  ${failure}`),
            "Fix the build and run dotnet_build again, or run dotnet_test without no_build so it compiles what it tests.",
          ].join("\n"),
          isError: false,
          metadata: { verdict: "NOT MEASURED" },
        };
      }
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
      // A run that built is a build: a clean exit leaves bin/ current, and a
      // compile error leaves it as stale as a failed dotnet_build. A test host
      // writes a report, so a failed run that left none never got past its
      // build (or was stopped in it), whatever its error lines look like. One
      // that left a report failed its tests, which say nothing about the
      // build, unless an error line says another project in it did not compile.
      if (!noBuild) {
        const clean = result.exitCode === 0 && !result.timedOut;
        const tested = reports.length + unreadable > 0;
        if (clean || !tested || MSBUILD_ERROR_LINE.test(combined)) {
          recordBuild(workspace, "dotnet_test", target, config, { ...result, output: combined }, !clean);
        }
      }
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
