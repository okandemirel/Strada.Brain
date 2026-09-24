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
import { MUTATION_TOOLS, COMPILABLE_EXT, extractFilePaths, isVerificationToolName } from "./constants.js";
import { expandExecutedToolCalls } from "./executed-tools.js";
import { lexShell, type ShellOperator } from "../../security/shell-lexer.js";
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

/** A command that always succeeds (or always fails) whatever the tree is. */
const ALWAYS_TRUE_RE = /^(?:true|:)\s*$/u;
const ALWAYS_FALSE_RE = /^(?:false)\s*$/u;

const isPipe = (op: ShellOperator | undefined): boolean => op === "|" || op === "|&";

/**
 * Did this shell command RUN a verifier — and does the exit status speak for it?
 *
 * "ran": every verifier the shell reached decides the line's exit status: it
 *   ends its pipeline, is not entered through `||`, and only `&&` (or a pipe
 *   after a later `&&`) follows it — so exit 0 means it passed.
 * "maybe": a verifier ran, or may have, but the exit status is another
 *   command's: it is behind `||`, before `|`, `;`, `||` or `&`, or inside a
 *   group. The caller must see a success verdict AND no failure verdict in
 *   the output. `dotnet test | tail -5`, `dotnet test || true` and `dotnet
 *   test; echo done` all exit 0 over a failing suite (audited 2026-09-24).
 * "no": no verifier, or one the shell could not have reached (`true ||
 *   dotnet build` exits 0 having built nothing, and `false && dotnet build;
 *   true` never reaches the build either — both cleared the compile debt of
 *   every edited file: Codex 2026-09-12 AE#3, 2026-09-13 AF#3).
 *
 * Read with the shared shell lexer, so quotes, newlines and a lone `&` split
 * commands where the shell splits them.
 */
export function shellVerification(command: string): "ran" | "maybe" | "no" {
  const read = lexShell(command);
  // A line the shell cannot parse fails before anything in it runs.
  if (read.hazards.has("unterminated")) return "no";
  const commands = [...read.commands];
  const operators = [...read.operators];
  // A trailing `;` or newline ends the line; it adds no command.
  while (
    commands.length > 1
    && commands[commands.length - 1]?.length === 0
    && (operators[operators.length - 1] === ";" || operators[operators.length - 1] === "newline")
  ) {
    commands.pop();
    operators.pop();
  }
  const text = (i: number): string => (commands[i] ?? []).map((word) => word.value).join(" ");
  let verdict: "ran" | "maybe" | "no" = "no";
  for (let i = 0; i < commands.length; i += 1) {
    if (!VERIFICATION_COMMAND_HEAD_RE.test(text(i))) continue;
    // Whether this command runs is decided where its pipeline starts.
    let start = i;
    while (start > 0 && isPipe(operators[start - 1])) start -= 1;
    const before = start > 0 ? operators[start - 1] : undefined;
    const left = start > 0 ? text(start - 1) : "";
    if (before === "&&" && ALWAYS_FALSE_RE.test(left)) continue;
    if (before === "||" && ALWAYS_TRUE_RE.test(left)) continue;
    // A failure skips every later `&&` and resumes at the next `||`, `;` or
    // `&`, so only an all-`&&` tail keeps its non-zero status as the line's.
    const after = operators.slice(i);
    const decidesStatus = before !== "||"
      && !read.hazards.has("grouping")
      && !isPipe(after[0])
      && after.every((op) => op === "&&" || isPipe(op));
    if (!decidesStatus) return "maybe";
    verdict = "ran";
  }
  return verdict;
}

/**
 * Does this tool call's isError report a VERDICT rather than a broken tool?
 * The dedicated verifiers (unity_verify_change, dotnet_test, …) by name, and
 * a shell that ran one (`npm test`, `dotnet build`) by its command: three
 * failing `npm test` runs through shell_exec took the tool away for sixty
 * seconds while dotnet_test stayed exempt (Codex 2026-09-17 on 43c43f1e).
 */
export function toolReportsVerdict(
  toolName: string,
  input: Record<string, unknown> | undefined,
  /**
   * The result, when the call has run. A verifier that could not START is a
   * broken tool, not a verdict: `PATH=/nonexistent npm test` exits 127 and
   * bypassed — and reset — the breaker forever (Codex 2026-09-17 #3).
   */
  result?: { isError?: boolean; content?: unknown; metadata?: Record<string, unknown> },
): boolean {
  if (result !== undefined && infrastructureFailure(result)) return false;
  if (isVerificationToolName(toolName)) return true;
  if (toolName !== "shell_exec") return false;
  const command = input?.["command"];
  return typeof command === "string" && shellVerification(command) !== "no";
}

/**
 * STRUCTURED signals only: a timeout, exit 126/127 (not executable / not
 * found), or the tool's own "failed to execute command" line for a spawn
 * error. Scanning the output for phrases made a test suite whose output
 * mentioned "No such file or directory" an infrastructure failure, and
 * repeated red runs could then disable the shell (Codex 2026-09-17 #3).
 */
/**
 * Did a shell verifier exit non-zero — or fail to say? The tool's metadata
 * carries the raw code for a direct call; a batch child keeps only the
 * tool's own footer, `Exit code: N | Duration: Nms`, which the formatter
 * writes BEFORE stdout — so the first such line is the tool's, and a
 * program that prints "Exit code: 1" of its own comes after it (Codex
 * 2026-09-17 on 7cb9d8a3 #1). No code at all is not a zero: a result that
 * cannot say how it ended has not passed.
 */
function shellExitedNonZero(output: string | undefined, result: { content?: unknown; metadata?: Record<string, unknown> }, command?: string): boolean {
  const meta = result.metadata?.["exitCode"];
  if (typeof meta === "number") return meta !== 0;
  if (typeof meta === "string" && /^\d+$/u.test(meta.trim())) return Number(meta.trim()) !== 0;
  let body = output !== undefined && output !== "" ? output : typeof result.content === "string" ? result.content : "";
  // THE ECHO IS NOT THE FOOTER. The formatter prints `$ <command>` first, so
  // a command carrying a forged footer AND a forged stdout marker on lines
  // of its own put both ahead of the real footer (Codex 2026-09-17 round 4
  // #3). The exact echo of the command is removed before anything is read.
  if (command !== undefined && body.startsWith(`$ ${command}\n`)) body = body.slice(command.length + 3);
  // THE LAST FOOTER BEFORE STDOUT. The formatter echoes the command first,
  // so a command carrying "Exit code: 0 | Duration: 1ms" on a line of its
  // own put a forged zero ahead of the real footer (Codex 2026-09-17 round
  // 3 #1); what the program printed only comes after the stdout marker.
  const head = body.split(/\n--- (?:stdout|stderr) ---/u)[0] ?? "";
  const footers = [...head.matchAll(/(?:^|\n)Exit code: (\d+)(?: \| Duration: \d+ms)?[ \t]*(?=\n|$)/gu)];
  const last = footers[footers.length - 1];
  return last === undefined || Number(last[1]) !== 0;
}

function infrastructureFailure(result: { isError?: boolean; content?: unknown; metadata?: Record<string, unknown> }): boolean {
  if (result.isError !== true) return false;
  const meta = result.metadata ?? {};
  if (meta["timedOut"] === true) return true;
  const code = meta["exitCode"];
  if (code === 126 || code === 127) return true;
  return /^Error: failed to execute command/u.test(String(result.content ?? ""));
}

function shellCommandVerifies(command: string): boolean {
  return shellVerification(command) !== "no";
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

/** Console-error rounds after which the unity-console gate stops asking. */
export const MAX_UNITY_ERROR_ATTEMPTS = 10;

export class SelfVerification {
  private pendingFiles = new Set<string>();
  private touchedFiles = new Set<string>();
  private hasCompilableChanges = false;
  private lastBuildOk: boolean | null = null;
  private lastVerificationAt: number | null = null;
  private unityConsoleErrors: string[] = [];
  private unityErrorResolutionAttempts = 0;
  private static readonly MAX_UNITY_ERROR_ATTEMPTS = MAX_UNITY_ERROR_ATTEMPTS;
  /** Test files changed since a tool last RAN tests, as opposed to compiling them. */
  private pendingTestFiles = new Set<string>();
  private testRunAttempts = 0;
  private static readonly MAX_TEST_RUN_ATTEMPTS = 3;
  /** A test run REPORTED failures and no later run has passed. */
  private failingTestRun = false;
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
    // Reset with the attempt count it is capped by: left set, the next task
    // inherited an open failing-test gate (audited 2026-09-24).
    this.failingTestRun = false;
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
        for (const file of mutatedFiles(executedTool.toolName, executedTool.input)) {
          this.pendingFiles.add(file);
          this.touchedFiles.add(file);
          if (affectsCompilation(executedTool.toolName, file)) {
            this.hasCompilableChanges = true;
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

      // Parse Unity console errors first. The verification block below ends
      // with `continue` for an inspection or an inconclusive result, and this
      // sat after it — so the errors unity_console_read and
      // unity_console_analyze returned were never recorded (audited
      // 2026-09-24).
      if (CONSOLE_REPORTING_TOOLS.has(executedTool.toolName)) {
        this.parseUnityConsoleErrors(
          executedTool.output !== undefined && executedTool.output !== ""
            ? executedTool.output
            : (typeof result.content === "string" ? result.content : ""),
        );
      }

      // Track build results — O(1)
      if (isVerificationTool(executedTool.toolName, executedTool.input)) {
        // (published below once ok is settled)
        // Defense against a success-shaped failure: pass/fail must not rest
        // solely on the tool's isError flag — a result body saying "N of M
        // tests failed" IS a failure whatever the flag says (the false-green
        // class measured across this pipeline).
        // THE CHILD'S OWN OUTPUT. A batch envelope's outer content was read
        // for every child in it, so a successful batch holding a
        // `unity_compile_status` child whose body was `"{}"` cleared the debt
        // (Codex 2026-09-13 AF#3).
        const bodyText = executedTool.output !== undefined && executedTool.output !== ""
          ? executedTool.output
          : (typeof result.content === "string" ? result.content : "");
        const bodyReportsFailure =
          (runsTests(executedTool.toolName, executedTool.input) && reportsTestFailure(bodyText))
          // A BODY THAT SAYS IT FAILED IS A FAILURE, whatever the flag says:
          // `{"success":false,"compileIssueCount":3}` cleared the debt of
          // every edited file (Codex 2026-09-13 AF#3).
          || /"?success"?\s*[:=]\s*false/i.test(bodyText)
          || /"?compileIssueCount"?\s*[:=]\s*[1-9]/i.test(bodyText)
          || /\bbuild failed\b|\bcompilation failed\b|\b[1-9]\d* Error\(s\)/i.test(bodyText)
          // A UNITY RUN THAT DIED IS NOT A RUN THAT PASSED. unity_playmode_verify
          // judged the results file alone and wrote "ran clean … unityExit=1"
          // with isError: false; the editor that exited 1 or was killed at its
          // allowance after writing the file counted as green (Codex
          // 2026-09-17 on 7cb9d8a3 #2, reproduced against the vendored tool).
          // …and only from a Unity tool's own summary: fixture text saying
          // "unityExit=1" in a passing dotnet or npm run is not a Unity exit
          // (Codex 2026-09-17 round 4 #11).
          || (executedTool.toolName.startsWith("unity_") && /\bunityExit=(-?\d+)\b/.test(bodyText) && /\bunityExit=(-?\d+)\b/.exec(bodyText)![1] !== "0");
        // AN INSPECTION IS NOT A VERIFICATION. A symbol search that returned
        // "No matches" and a console read cleared the compile debt of every
        // edited file, because "did not fail" was read as "compiled" (Codex
        // 2026-09-12 AE#3). They answer questions; they do not build.
        if (INSPECTION_ONLY_TOOLS.has(executedTool.toolName)) continue;
        // …AND A RESULT THAT SAYS NOTHING SETTLES NOTHING. `{}` with no error,
        // `{"isCompiling":true}`, a `--help` usage dump and a shell command
        // that skipped its build (`true || dotnet build`, which exits 0 with
        // no output) all produced lastBuildOk: true and emptied the pending
        // list (AE#3). An inconclusive answer leaves the debt where it was.
        const shell = executedTool.toolName === "shell_exec";
        const needsVerdict = shell
          && shellVerification(typeof executedTool.input["command"] === "string" ? executedTool.input["command"] : "") === "maybe";
        // A masked exit status that printed a failure verdict has failed.
        const conclusive = (needsVerdict && bodyReportsFailure)
          || verificationIsConclusive(bodyText, { shell, needsVerdict });
        if (!executedTool.isError && !conclusive) {
          this.lastVerificationAt = Date.now();
          this.lastBuildOk = null;
          continue;
        }
        // ACCEPTANCE IS NOT PROOF. `ok_exit_codes: [0, 2]` makes a compiler's
        // exit 2 an accepted result (isError: false) so a predicate does not
        // trip the breaker — but `error TS2322` under an accepted exit 2
        // cleared the verification debt and published lastBuildOk: true
        // (Codex 2026-09-17 wave 0-A review #1). A verifier that exited
        // non-zero has not passed, whatever the caller agreed to accept.
        // …and STRUCTURED exit metadata fails any verifier, dedicated ones
        // included; only the "no footer is not a zero" rule is the shell's.
        const metaExit = result.metadata?.["exitCode"];
        const exitedNonZero = typeof metaExit === "number"
          ? metaExit !== 0
          : shell && shellExitedNonZero(executedTool.output, result, typeof executedTool.input["command"] === "string" ? executedTool.input["command"] : undefined);
        const ok = !executedTool.isError && !bodyReportsFailure && !exitedNonZero;
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

  // isRedundantVerification() and its dirtySinceLastVerify flag were deleted
  // (audited 2026-09-02): the method claimed "Consumers surface this as
  // guidance" and had no consumer outside its own test, so the measured
  // 11-compiles-in-2h waste read as mitigated while nothing mitigated it.
  // Wiring it would have been a hazard — only .cs/.csproj/.sln/.props/.targets
  // mutations set the flag, so an .asmdef, .shader or .prefab edit would have
  // read as "a recompile is guaranteed identical". The BATCH IT guidance in
  // getPrompt() is the mitigation that actually shipped.

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
      // "0 errors" as a count of its own: "10 errors" contains it.
      /(?<!\d)0 errors\b/u.test(content) ||
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

const hasCompilableExt = (file: string): boolean => {
  const dotIdx = file.lastIndexOf(".");
  return dotIdx !== -1 && COMPILABLE_EXT.has(file.slice(dotIdx));
};

/** Programs that write the files named on their command line. */
const SHELL_WRITERS = new Set(["mv", "cp", "rm", "touch", "tee", "sed", "perl", "truncate", "install", "ln"]);

/**
 * The files a mutation touched. For shell_exec, the compilable files a
 * writing command names (`sed -i … Player.cs`, `mv A.cs B.cs`, `> X.cs`):
 * the command has no path field, so a shell edit of a script left the build
 * gate unarmed (audited 2026-09-24). A read (`cat X.cs`) names none.
 */
function mutatedFiles(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName !== "shell_exec") return extractFilePaths(input);
  const command = typeof input["command"] === "string" ? input["command"] : "";
  const read = lexShell(command);
  const named = new Set(read.redirectTargets.filter(hasCompilableExt));
  for (const words of read.commands) {
    let at = 0;
    while (at < words.length && /^[A-Za-z_]\w*=/u.test(words[at]!.value)) at += 1;
    const program = (words[at]?.value ?? "").split(/[/\\]/u).pop() ?? "";
    if (!SHELL_WRITERS.has(program)) continue;
    const args = words.slice(at + 1).map((word) => word.value);
    // sed and perl only write in place.
    if ((program === "sed" || program === "perl") && !args.some((a) => /^-[A-Za-z]*i|^--in-place/u.test(a))) continue;
    for (const arg of args) if (hasCompilableExt(arg)) named.add(arg);
  }
  return [...named];
}

/**
 * Does this change reach the compiler? A deleted directory under Assets/ or
 * Packages/ took its scripts with it, extension or not.
 */
function affectsCompilation(toolName: string, file: string): boolean {
  if (hasCompilableExt(file)) return true;
  return toolName === "file_delete_directory" && /(^|[/\\])(?:Assets|Packages)(?:[/\\]|$)/u.test(file);
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

/** Tools whose output carries the Unity console's errors. */
const CONSOLE_REPORTING_TOOLS: ReadonlySet<string> = new Set([
  "unity_verify_change", "unity_compile_status", "unity_compile_wait",
  "unity_console_read", "unity_console_analyze",
]);

/**
 * Tools that answer a QUESTION about the tree rather than building it. Their
 * success says the question was answered, never that the code compiles.
 */
const INSPECTION_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "csharp_symbol_search", "unity_console_read", "unity_console_analyze",
]);

/**
 * Does this verifier's own output settle anything?
 *
 * A body that is empty, still in progress, or a usage dump is not a verdict.
 * Every one of those cleared the compile debt of every edited file because
 * the tool did not set isError (Codex 2026-09-12 AE#3).
 */
export function verificationIsConclusive(body: string, opts: { shell?: boolean; needsVerdict?: boolean } = {}): boolean {
  const text = body.trim();
  // A SILENT SHELL VERIFIER IS A PASS: `tsc --noEmit` and `dotnet build -v q`
  // print nothing when they succeed, and the exit code is what the tool's
  // error flag already carries. An MCP tool that answers `{}` has told us
  // nothing at all.
  if (text === "" || text === "{}" || text === "[]") return opts.shell === true && opts.needsVerdict !== true;
  // A TOOL THAT SAYS IT COULD NOT ANSWER has not answered (Codex 2026-09-13
  // AF#3): "unavailable", "unknown", "pending" and "error" are states, not
  // verdicts.
  if (/"?status"?\s*[:=]\s*"?(?:unavailable|unknown|pending|queued|running|error)"?/i.test(text)) return false;
  // A verifier BEHIND `||` must show its own verdict before it is believed.
  if (opts.needsVerdict === true && !/\b(?:succeeded|success|passed|0 errors?|no errors?|build succeeded|compil\w+ succeeded)\b/i.test(text)) {
    return false;
  }
  // Still running: a compile in flight has no result yet.
  if (/"?is(?:Compiling|Reloading)"?\s*[:=]\s*true|\bcompilation in progress\b|\bcompiling\b\s*\.{3}/i.test(text)) return false;
  // A help screen is the tool explaining itself, not a build.
  if (/^\s*(?:usage|description):/im.test(text) && !/\berror\b|\bpassed\b|\bsucceeded\b/i.test(text)) return false;
  return true;
}

/** Tools that RUN tests, as opposed to compiling the assemblies that hold them. */
const TEST_RUNNING_TOOLS: ReadonlySet<string> = new Set([
  "unity_playmode_verify", "unity_playthrough", "unity_test_run", "unity_playmode_test",
  "unity_editmode_test", "dotnet_test",
]);

const TEST_RUNNING_SHELL_RE = /\b(?:vitest|jest|pytest|dotnet\s+test|npm\s+(?:run\s+)?test|yarn\s+test)\b/iu;

/**
 * A test runner's own summary saying tests failed. Only Unity's wording used
 * to count, so `dotnet test | tail -5` over "Failed!  - Failed: 1" read as a
 * pass once the pipe masked the exit status (audited 2026-09-24). Anchored
 * to each runner's summary line so a passing test's NAME does not match.
 */
const TEST_FAILURE_VERDICTS: readonly RegExp[] = [
  /\b\d+ of \d+ tests? failed|PlayMode verification FAILED/i, // Unity
  /\bFailed!\s+-\s+Failed:\s*[1-9]/, // dotnet test, minimal verbosity
  /^\s*Test Run Failed\./m, // dotnet test, normal verbosity
  /^\s*(?:Test Files|Tests)\s+[1-9]\d* failed\b/m, // vitest
  /^\s*(?:Test Suites|Tests):\s+[1-9]\d* failed\b/m, // jest
  /^[=\s]*(?:\d+ \w+, )*[1-9]\d* (?:failed|errors?)\b[^\n]*\bin [\d.]+s\b/m, // pytest
];

function reportsTestFailure(text: string): boolean {
  return TEST_FAILURE_VERDICTS.some((re) => re.test(text));
}

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
