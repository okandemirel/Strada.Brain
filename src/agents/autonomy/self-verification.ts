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

/**
 * A shell command is a verification when the PROGRAM it invokes is a
 * verifier — not when any word in the line happens to be "test" or "build".
 *
 * Audited 2026-09-02: the previous pattern was an unanchored word search over
 * the whole line, so `cp Assets/Scripts/Test.cs …`, `mkdir -p build` and
 * `cat GAME_DESIGN.md | grep test` each cleared the compile gate and published
 * lastBuildOk=true — a file copy recorded as a clean build. This matches the
 * head of a command segment, after any env assignments and launchers.
 */
const VERIFICATION_COMMAND_HEAD_RE = new RegExp(
  "^(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*" +
    "(?:(?:npx|bunx|pnpm\\s+(?:exec|dlx)|yarn\\s+dlx)\\s+)?" +
    "(?:" +
    "(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:test|build|check|lint|typecheck|verify|compile)[\\w:.-]*" +
    "|(?:tsc|eslint|vitest|jest|pytest|mocha)" +
    "|python3?\\s+-m\\s+pytest" +
    "|dotnet\\s+(?:build|test|vstest)" +
    "|(?:make|cargo|go|gradle|\\.\\/gradlew|mvn|msbuild|xcodebuild)\\s+(?:test|build|check|lint|verify|compile)" +
    ")(?:\\s|$)",
  "iu",
);

/** True when any segment of a shell chain (`cd x && npm test`) invokes a verifier. */
function shellCommandVerifies(command: string): boolean {
  return command
    .split(/\s*(?:&&|\|\||[;|\n])\s*/u)
    .map((segment) => segment.replace(/^[\s(]+/u, ""))
    .some((segment) => VERIFICATION_COMMAND_HEAD_RE.test(segment));
}

// ─── State ──────────────────────────────────────────────────────────────────────

export interface VerificationState {
  readonly pendingFiles: ReadonlySet<string>;
  readonly touchedFiles: ReadonlySet<string>;
  readonly hasCompilableChanges: boolean;
  readonly lastBuildOk: boolean | null;
  readonly lastVerificationAt: number | null;
  readonly unityConsoleErrors: readonly string[];
  readonly unityErrorResolutionAttempts: number;
  /**
   * The compile gate stopped asking (its cap is spent) while compilable
   * changes are still unverified. The ask budget is spent; the debt is not
   * (audited 2026-09-02).
   */
  readonly buildGateExhausted?: boolean;
}

// ─── Verifier ───────────────────────────────────────────────────────────────────

/**
 * Process-wide latest build/verification state, published by every
 * SelfVerification instance on each tracked verification tool. Lets the
 * OODA BuildStateObserver (daemon layer) see build health without holding a
 * reference to any per-run instance — the missing link that kept the
 * observer unwired ("needs a SelfVerification reference — skip for now").
 */
interface PublishedBuildState {
  pendingFiles: ReadonlySet<string>;
  hasCompilableChanges: boolean;
  lastBuildOk: boolean | null;
  at: number;
}

/**
 * Keyed per verifier instance: a single shared object was last-writer-wins
 * across concurrent workers, so the OODA observer could report a FAILING
 * build while listing a DIFFERENT (healthy) worker's files and drive
 * replanning against a workspace that compiled fine (audited 2026-09-01).
 */
const publishedBuildStates = new Map<string, PublishedBuildState>();
let publishSeq = 0;

/**
 * How long a failing publication counts as "currently failing".
 *
 * Audited 2026-09-02: the failing preference had no recency bound and nothing
 * unpublished a verifier when its run ended, so one dead worker's red compile
 * — with its long-gone files — outlived hours of green compiles from every
 * later worker, and the change-gated observer could never report a recovery
 * or a NEW failure. A worker still fixing a red build republishes on every
 * verify, so a failure nobody has re-asserted in this long belongs to a run
 * that is over.
 */
const FAILING_STATE_STALE_MS = 10 * 60_000;

/** Any currently-failing build wins; otherwise the most recent one. */
export function getLatestGlobalBuildState(nowMs = Date.now()): {
  pendingFiles: ReadonlySet<string>;
  hasCompilableChanges: boolean;
  lastBuildOk: boolean | null;
} {
  let failing: PublishedBuildState | undefined;
  let newest: PublishedBuildState | undefined;
  for (const state of publishedBuildStates.values()) {
    const stillCurrent = nowMs - state.at <= FAILING_STATE_STALE_MS;
    if (state.lastBuildOk === false && stillCurrent && (!failing || state.at > failing.at)) failing = state;
    if (!newest || state.at > newest.at) newest = state;
  }
  const chosen = failing ?? newest;
  return chosen
    ? {
        pendingFiles: chosen.pendingFiles,
        hasCompilableChanges: chosen.hasCompilableChanges,
        lastBuildOk: chosen.lastBuildOk,
      }
    : { pendingFiles: new Set<string>(), hasCompilableChanges: false, lastBuildOk: null };
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
  /** True once a compilable file changed after the last successful verification. */
  private dirtySinceLastVerify = false;
  /** Identity of this verifier in the process-wide build-state publication. */
  private readonly publishKey = `sv-${++publishSeq}`;
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
    // The published state described the task that just ended, not the next.
    this.dispose();
  }

  /**
   * Retire this verifier's process-wide publication. A run that is over has
   * no current build state; leaving its last verdict in the map let a dead
   * failure outrank every live worker (audited 2026-09-02).
   */
  dispose(): void {
    publishedBuildStates.delete(this.publishKey);
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
            this.dirtySinceLastVerify = true;
            // A clean compile describes the tree it compiled, not this one.
            // Audited 2026-09-02: lastBuildOk stayed `true` across later edits,
            // so needsVerification() read false and never-compiled files were
            // approved under a "clean" build check.
            this.lastBuildOk = null;
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
        publishedBuildStates.set(this.publishKey, {
          lastBuildOk: ok,
          hasCompilableChanges: this.hasCompilableChanges,
          pendingFiles: new Set(this.pendingFiles),
          at: Date.now(),
        });
        // Bound the map: a long-lived daemon runs thousands of verifiers.
        if (publishedBuildStates.size > 64) {
          const oldest = [...publishedBuildStates.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) publishedBuildStates.delete(oldest[0]);
        }
        if (ok) {
          this.pendingFiles.clear();
          this.hasCompilableChanges = false;
          this.buildGateEmissions = 0;
          this.dirtySinceLastVerify = false;
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
   * The compile gate has spent its asks and the debt is still there.
   *
   * Audited 2026-09-02: once the cap dropped the gate, the build check read
   * "clean — no outstanding verification debt" over files nobody compiled.
   * The cap governs how often the agent is ASKED; this keeps what may be
   * CLAIMED visible after the asking stops.
   */
  buildGateExhausted(): boolean {
    return this.hasCompilableChanges
      && this.lastBuildOk !== true
      && this.buildGateEmissions >= SelfVerification.MAX_BUILD_GATE_EMISSIONS;
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

  /**
   * True when a verification would re-compile a tree nothing has touched
   * since the last clean compile — minutes of headless Unity for a
   * guaranteed-identical answer (measured 2026-09-01: 11 compiles in 2h on
   * an edit→compile→edit rhythm). Consumers surface this as guidance.
   */
  isRedundantVerification(): boolean {
    return this.lastBuildOk === true && !this.dirtySinceLastVerify;
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
        this.dirtySinceLastVerify = true;
        // This run never saw the worker's compile, so the parent's last clean
        // verdict does not cover these files: they are pending, by name, and
        // the build state is unknown again (audited 2026-09-02 — the success
        // branch used to leave lastBuildOk=true and pendingFiles empty, so
        // twelve delegated .cs files were approved under a "clean" check).
        this.pendingFiles.add(file);
        this.lastBuildOk = null;
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
    // The headline names a measurement — compilable files with no clean pass
    // since — so it is emitted only when that is what the state says. Audited
    // 2026-09-02: it was unconditional, and after a clean compile it stood over
    // zero bullets above the real [TESTS NOT RUN] section, contradicting
    // lastBuildOk=true and steering the run to recompile what had just passed.
    const buildGateOpen = this.hasCompilableChanges && this.lastBuildOk !== true;
    if (buildGateOpen) {
      this.buildGateEmissions++;
    }
    const files = [...this.pendingFiles];
    const shown = files.slice(0, 8);
    const rest = files.length - shown.length;
    const hasCsFiles = files.some(f => {
      const dotIdx = f.lastIndexOf(".");
      return dotIdx !== -1 && COMPILABLE_EXT.has(f.slice(dotIdx));
    });

    const lines: string[] = [];
    if (buildGateOpen) {
      lines.push(
        `[VERIFICATION REQUIRED] You modified compilable files without verifying:`,
        ...shown.map(f => `  - ${f}`),
      );
      if (rest > 0) lines.push(`  ... and ${rest} more`);
      // The sibling gates say when they are asking for the last time; this one
      // went silent with the tenth text byte-identical to the first (audited
      // 2026-09-02), and the silence was then read as a clean build.
      if (this.buildGateEmissions >= SelfVerification.MAX_BUILD_GATE_EMISSIONS) {
        lines.push(
          `This is the last time this is asked (${this.buildGateEmissions}/${SelfVerification.MAX_BUILD_GATE_EMISSIONS}). ` +
            "If these files still cannot be verified when you finish, report them as unverified — " +
            "say which files and why verification was impossible — rather than reporting the work as done.",
        );
      }
    }

    if (this.hasUnrunTests()) {
      lines.push(
        ...(lines.length > 0 ? [``] : []),
        `[TESTS NOT RUN] You changed test files and no tool has run them:`,
        ...[...this.pendingTestFiles].slice(0, 5).map(f => `  - ${f}`),
        `A clean compile does not run tests — unity_verify_change says so itself.`,
        `Run unity_playmode_verify. A test that has never run is not evidence of anything.`,
      );
    }

    if (this.hasFailingTestRun()) {
      lines.push(
        ...(lines.length > 0 ? [``] : []),
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
    } else if (buildGateOpen) {
      lines.push(
        hasCsFiles
          ? `\nUse unity_verify_change to verify compilation and check the Unity console — it compiles headlessly and needs no bridge. Do not use dotnet_build: a Unity project has no .sln until the Editor has been opened once.\nBATCH IT: a headless compile costs minutes, so finish the whole logical unit (all files of the change) BEFORE verifying — do not compile after each individual edit. Measured 2026-09-01: an edit→compile→edit→compile rhythm produced ~11 compiles in two hours and ~15 tool operations an hour.`
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
      buildGateExhausted: this.buildGateExhausted(),
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
  return command.length > 0 && shellCommandVerifies(command);
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
