/**
 * Self-Verification Framework
 *
 * Tracks file mutations and verification state to ensure code changes
 * are always validated before the agent declares a task complete.
 *
 * Performance:
 *   - All operations O(1) per call via Set membership checks
 *   - File extension check: O(1) via Set.has() on extracted suffix
 *   - No iteration over pending files unless building the prompt
 */

import type { ToolResult } from "../providers/provider.interface.js";
import { sanitizePromptInjection } from "../orchestrator-text-utils.js";
import { MUTATION_TOOLS, COMPILABLE_EXT, extractFilePath, isVerificationToolName } from "./constants.js";
import { expandExecutedToolCalls } from "./executed-tools.js";
import type { WorkerRunResult } from "../supervisor/supervisor-types.js";

const VERIFICATION_SHELL_COMMAND_RE = /\b(?:test|build|check|lint|typecheck|verify|compile|tsc|eslint|vitest|jest|pytest)\b/iu;

// ─── State ──────────────────────────────────────────────────────────────────────

export interface VerificationState {
  readonly pendingFiles: ReadonlySet<string>;
  readonly touchedFiles: ReadonlySet<string>;
  readonly hasCompilableChanges: boolean;
  readonly lastBuildOk: boolean | null;
  readonly lastVerificationAt: number | null;
  readonly unityConsoleErrors: readonly string[];
  readonly unityErrorResolutionAttempts: number;
}

// ─── Verifier ───────────────────────────────────────────────────────────────────

/**
 * Process-wide latest build/verification state, published by every
 * SelfVerification instance on each tracked verification tool. Lets the
 * OODA BuildStateObserver (daemon layer) see build health without holding a
 * reference to any per-run instance — the missing link that kept the
 * observer unwired ("needs a SelfVerification reference — skip for now").
 */
const globalBuildState = {
  pendingFiles: new Set<string>() as ReadonlySet<string>,
  hasCompilableChanges: false,
  lastBuildOk: null as boolean | null,
};

export function getLatestGlobalBuildState(): {
  pendingFiles: ReadonlySet<string>;
  hasCompilableChanges: boolean;
  lastBuildOk: boolean | null;
} {
  return globalBuildState;
}

export class SelfVerification {
  private pendingFiles = new Set<string>();
  private touchedFiles = new Set<string>();
  private hasCompilableChanges = false;
  private lastBuildOk: boolean | null = null;
  private lastVerificationAt: number | null = null;
  private unityConsoleErrors: string[] = [];
  private unityErrorResolutionAttempts = 0;
  private static readonly MAX_UNITY_ERROR_ATTEMPTS = 10;
  /** Test files changed since a tool last RAN tests, as opposed to compiling them. */
  private pendingTestFiles = new Set<string>();
  private testRunAttempts = 0;
  private static readonly MAX_TEST_RUN_ATTEMPTS = 3;
  /** A test run REPORTED failures and no later run has passed. */
  private failingTestRun = false;
  /**
   * How many times the compile gate has been raised without a clean pass since.
   * The unity-error and unrun-test gates already carry caps; this one had none,
   * so a run whose verification tooling could never succeed (bridge down, or
   * only a forbidden tool on PATH) looped on the same gate until the stuck
   * reaper killed it an hour later. Cleared by any successful verification.
   */
  private buildGateEmissions = 0;
  private static readonly MAX_BUILD_GATE_EMISSIONS = 10;

  /** Reset for new task. */
  reset(): void {
    this.pendingFiles = new Set();
    this.touchedFiles = new Set();
    this.hasCompilableChanges = false;
    this.lastBuildOk = null;
    this.lastVerificationAt = null;
    this.unityConsoleErrors = [];
    this.unityErrorResolutionAttempts = 0;
    this.pendingTestFiles = new Set();
    this.testRunAttempts = 0;
    this.buildGateEmissions = 0;
  }

  /**
   * Track a tool execution. O(1).
   */
  track(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
  ): void {
    for (const executedTool of expandExecutedToolCalls(toolName, input, result)) {
      // Track mutations — O(1) set add + extension check
      if (MUTATION_TOOLS.has(executedTool.toolName)) {
        const file = extractFilePath(executedTool.input);
        if (file) {
          this.pendingFiles.add(file);
          this.touchedFiles.add(file);
          const dotIdx = file.lastIndexOf(".");
          if (dotIdx !== -1 && COMPILABLE_EXT.has(file.slice(dotIdx))) {
            this.hasCompilableChanges = true;
          }
          if (looksLikeTestFile(file)) {
            this.pendingTestFiles.add(file);
          }
        }
      }

      // Track build results — O(1)
      if (isVerificationTool(executedTool.toolName, executedTool.input)) {
        // (published below once ok is settled)
        // Defense against a success-shaped failure: pass/fail must not rest
        // solely on the tool's isError flag — a result body saying "N of M
        // tests failed" IS a failure whatever the flag says (the false-green
        // class measured across this pipeline).
        const bodyText = typeof result.content === "string" ? result.content : "";
        const bodyReportsFailure =
          runsTests(executedTool.toolName, executedTool.input) &&
          /\b\d+ of \d+ tests? failed|PlayMode verification FAILED/i.test(bodyText);
        const ok = !executedTool.isError && !bodyReportsFailure;
        this.lastBuildOk = ok;
        this.lastVerificationAt = Date.now();
        globalBuildState.lastBuildOk = ok;
        globalBuildState.hasCompilableChanges = this.hasCompilableChanges;
        globalBuildState.pendingFiles = new Set(this.pendingFiles);
        if (ok) {
          this.pendingFiles.clear();
          this.hasCompilableChanges = false;
          this.buildGateEmissions = 0;
        }
        // A compile is not a test run. unity_verify_change says so itself —
        // "Test assemblies are NOT built by this check" — and measured
        // 2026-08-21 an agent read that sentence nineteen times, wrote two
        // test files, and never ran one. Only a tool that RUNS tests settles
        // whether the tests a run wrote actually pass.
        if (runsTests(executedTool.toolName, executedTool.input)) {
          this.testRunAttempts++;
          if (ok) {
            this.pendingTestFiles.clear();
            this.failingTestRun = false;
          } else {
            // A failing test run must leave an OPEN gate. Before this flag, a
            // clean compile cleared hasCompilableChanges, a later red PlayMode
            // run set lastBuildOk=false — and needsVerification() saw nothing:
            // the run could declare DONE over a failing suite.
            this.failingTestRun = true;
          }
        }
      }

      // Parse Unity console errors from verification results
      if (
        executedTool.toolName === "unity_verify_change" ||
        executedTool.toolName === "unity_compile_status" ||
        executedTool.toolName === "unity_compile_wait" ||
        executedTool.toolName === "unity_console_read" ||
        executedTool.toolName === "unity_console_analyze"
      ) {
        const content = typeof result.content === "string" ? result.content : "";
        this.parseUnityConsoleErrors(content);
      }
    }
  }

  /**
   * Check if verification is needed before exit. O(1).
   */
  needsVerification(): boolean {
    return (this.hasCompilableChanges
        && this.lastBuildOk !== true
        && this.buildGateEmissions < SelfVerification.MAX_BUILD_GATE_EMISSIONS)
      || this.hasUnresolvedUnityErrors()
      || this.hasUnrunTests()
      || this.hasFailingTestRun();
  }

  /**
   * The last test run reported failures and nothing has passed since —
   * capped like the unrun-test gate so an honest failure report can still
   * end the run.
   */
  private hasFailingTestRun(): boolean {
    return this.failingTestRun
      && this.testRunAttempts < SelfVerification.MAX_TEST_RUN_ATTEMPTS;
  }

  /**
   * Tests were written and never run — unless the run has already tried and
   * failed enough times that asking again only costs turns. The cap matters:
   * a gate with no way out cannot be satisfied by an honest failure report.
   */
  private hasUnrunTests(): boolean {
    return this.pendingTestFiles.size > 0
      && this.testRunAttempts < SelfVerification.MAX_TEST_RUN_ATTEMPTS;
  }

  /** Check if there are unresolved Unity console errors. */
  hasUnresolvedUnityErrors(): boolean {
    return this.unityConsoleErrors.length > 0
      && this.unityErrorResolutionAttempts < SelfVerification.MAX_UNITY_ERROR_ATTEMPTS;
  }

  /** Get current Unity console errors for injection into prompts. */
  getUnityConsoleErrors(): readonly string[] {
    return this.unityConsoleErrors;
  }

  /** Get Unity error attempt count. */
  getUnityErrorAttempts(): number {
    return this.unityErrorResolutionAttempts;
  }

  /**
   * Parse Unity console output for errors.
   * Matches CS error codes, CompilerError, and positional error lines.
   */
  private parseUnityConsoleErrors(content: string): void {
    const errorSet = new Set<string>();
    const patterns = [
      /^.*error\s+CS\d+:.*$/gim,
      /^.*CompilerError:.*$/gim,
      /^.*\(\d+,\d+\):\s*error\b.*$/gim,
    ];

    for (const pattern of patterns) {
      const matches = content.match(pattern);
      if (matches) {
        for (const m of matches) {
          const line = m.trim();
          if (line) errorSet.add(sanitizePromptInjection(line));
        }
      }
    }

    if (errorSet.size > 0) {
      const newErrors = [...errorSet];
      // Only increment attempts when new errors differ from previous (avoid double-counting
      // when multiple verification tools report the same errors in the same pass)
      const changed = newErrors.length !== this.unityConsoleErrors.length ||
        newErrors.some((e, i) => e !== this.unityConsoleErrors[i]);
      if (changed) {
        this.unityErrorResolutionAttempts++;
      }
      this.unityConsoleErrors = newErrors;
    } else if (
      content.includes("0 errors") ||
      content.includes("Build succeeded") ||
      content.includes("Compilation successful") ||
      content.includes("Compile succeeded") ||
      content.includes("No errors")
    ) {
      // Explicit success signal — clear errors
      this.unityConsoleErrors = [];
      this.unityErrorResolutionAttempts = 0;
    } else if (this.unityConsoleErrors.length > 0 && content.length > 0) {
      // Ambiguous output (no errors found, no success signal) — increment attempt
      // to avoid freezing on stale errors from connection issues or format changes
      this.unityErrorResolutionAttempts++;
    }
  }

  hasTouchedFiles(): boolean {
    return this.touchedFiles.size > 0;
  }

  ingestWorkerResult(result: WorkerRunResult): void {
    for (const file of result.touchedFiles) {
      this.touchedFiles.add(file);
      const dotIdx = file.lastIndexOf(".");
      if (dotIdx !== -1 && COMPILABLE_EXT.has(file.slice(dotIdx))) {
        this.hasCompilableChanges = true;
      }
    }

    const hasVerificationIssues = result.verificationResults.some(
      (entry) => entry.status === "issues",
    );
    const hasReviewErrors = result.reviewFindings.some(
      (finding) => finding.severity === "error",
    );

    if (hasVerificationIssues || hasReviewErrors || result.status !== "completed") {
      for (const file of result.touchedFiles) {
        this.pendingFiles.add(file);
      }
      this.lastBuildOk = false;
      return;
    }

    if (result.touchedFiles.length > 0) {
      this.lastVerificationAt = Date.now();
    }
  }

  /**
   * Build a verification reminder message.
   * Only called when needsVerification() is true (rare path).
   */
  getPrompt(): string {
    if (this.hasCompilableChanges && this.lastBuildOk !== true) {
      this.buildGateEmissions++;
    }
    const files = [...this.pendingFiles];
    const shown = files.slice(0, 8);
    const rest = files.length - shown.length;
    const hasCsFiles = files.some(f => {
      const dotIdx = f.lastIndexOf(".");
      return dotIdx !== -1 && COMPILABLE_EXT.has(f.slice(dotIdx));
    });

    const lines: string[] = [
      `[VERIFICATION REQUIRED] You modified compilable files without verifying:`,
      ...shown.map(f => `  - ${f}`),
    ];
    if (rest > 0) lines.push(`  ... and ${rest} more`);

    if (this.hasUnrunTests()) {
      lines.push(
        ``,
        `[TESTS NOT RUN] You changed test files and no tool has run them:`,
        ...[...this.pendingTestFiles].slice(0, 5).map(f => `  - ${f}`),
        `A clean compile does not run tests — unity_verify_change says so itself.`,
        `Run unity_playmode_verify. A test that has never run is not evidence of anything.`,
      );
    }

    if (this.hasFailingTestRun()) {
      lines.push(
        ``,
        `[TESTS FAILING] The last test run reported failures and no later run has passed.`,
        `Fix the failing tests and re-run unity_playmode_verify until green — a failing suite is not DONE.`,
      );
    }

    if (this.unityConsoleErrors.length > 0) {
      lines.push(
        `\n[UNITY CONSOLE ERRORS - Attempt ${this.unityErrorResolutionAttempts}/${SelfVerification.MAX_UNITY_ERROR_ATTEMPTS}]`,
        `Unity console still has ${this.unityConsoleErrors.length} error(s):`,
        ...this.unityConsoleErrors.slice(0, 5).map(e => `  ✗ ${e}`),
      );
      if (this.unityConsoleErrors.length > 5) {
        lines.push(`  ... and ${this.unityConsoleErrors.length - 5} more`);
      }
      lines.push(`Fix these errors and run unity_verify_change again. Do NOT declare DONE until Unity console is clean.`);
    } else {
      lines.push(
        hasCsFiles
          ? `\nUse unity_verify_change to verify compilation and check the Unity console — it compiles headlessly and needs no bridge. Do not use dotnet_build: a Unity project has no .sln until the Editor has been opened once.`
          : `\nRun the most relevant verification tool or command before declaring the task complete.`,
      );
    }

    return lines.join("\n");
  }

  /** Read-only state snapshot for testing. */
  getState(): VerificationState {
    return {
      pendingFiles: new Set(this.pendingFiles),
      touchedFiles: new Set(this.touchedFiles),
      hasCompilableChanges: this.hasCompilableChanges,
      lastBuildOk: this.lastBuildOk,
      lastVerificationAt: this.lastVerificationAt,
      unityConsoleErrors: [...this.unityConsoleErrors],
      unityErrorResolutionAttempts: this.unityErrorResolutionAttempts,
    };
  }
}

function isVerificationTool(toolName: string, input: Record<string, unknown>): boolean {
  if (isVerificationToolName(toolName)) {
    return true;
  }
  if (toolName !== "shell_exec") {
    return false;
  }

  const command = typeof input["command"] === "string" ? input["command"].trim() : "";
  return command.length > 0 && VERIFICATION_SHELL_COMMAND_RE.test(command);
}

/** A path that holds tests rather than the code under test. */
export function looksLikeTestFile(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/");
  // A Tests/ directory is a Tests/ directory whatever its casing.
  if (/(?:^|\/)[Tt]ests?\//u.test(normalized)) {
    return true;
  }
  // Case matters in the filename: ScoringServiceTests.cs is a test file and
  // Latest.cs is not, and lowercasing first makes them the same string.
  return /Tests?\.(?:cs|ts|tsx|js)$/u.test(normalized)
    || /\.(?:test|spec)\.(?:ts|tsx|js)$/u.test(normalized);
}

/** Tools that RUN tests, as opposed to compiling the assemblies that hold them. */
const TEST_RUNNING_TOOLS: ReadonlySet<string> = new Set([
  "unity_playmode_verify", "unity_test_run", "unity_playmode_test",
  "unity_editmode_test", "dotnet_test",
]);

const TEST_RUNNING_SHELL_RE = /\b(?:vitest|jest|pytest|dotnet\s+test|npm\s+(?:run\s+)?test|yarn\s+test)\b/iu;

function runsTests(toolName: string, input: Record<string, unknown>): boolean {
  if (TEST_RUNNING_TOOLS.has(toolName)) {
    return true;
  }
  if (toolName !== "shell_exec") {
    return false;
  }
  const command = typeof input["command"] === "string" ? input["command"] : "";
  return TEST_RUNNING_SHELL_RE.test(command);
}
