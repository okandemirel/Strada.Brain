/**
 * SWE-Sharp-Bench execution-loop logic.
 *
 * The scoring half of this benchmark already existed (`swe-sharp-dataset.ts`,
 * `trx-report.ts`, `swe-sharp-resolution.ts`). What did not exist was the loop
 * that produces something to score: clone at `baseCommit`, apply `testPatch`,
 * run a candidate, apply its patch, `dotnet test`, feed the TRX to the scorer.
 * `scripts/bench/swe-sharp/run-tasks.mjs` is that loop; this module is every
 * decision inside it that can be made without touching a disk or a network, so
 * the decisions are unit-tested rather than discovered during a two-hour run.
 *
 * The decisions here all serve one rule: **a task that did not run is not a
 * failed task and not a pass.** A harness that folds "clone failed" into the
 * unresolved column reports a real number over a denominator it made up, and
 * the number looks like a measurement of the agent. So:
 *
 *   - `not-run` is a third status with a named reason, never a score.
 *   - a candidate that declined, or produced nothing, IS scored — that is the
 *     agent's answer, not a broken harness.
 *   - a resolved task whose FAIL_TO_PASS tests were never observed failing
 *     before the patch is NOT a proven fix; it is unmeasured, and the exit code
 *     says so.
 *
 * Nothing here re-implements scoring: `evaluateResolution` and `summarize` from
 * `swe-sharp-resolution.ts` do that, and this module feeds them.
 */

import path from "node:path";
import {
  evaluateResolution,
  summarize,
  type ResolutionResult,
  type TestReport,
} from "./swe-sharp-resolution.js";
import { type TestOutcome, type TrxParseResult, findOutcome } from "./trx-report.js";

/**
 * Exit contract, identical to the one `scripts/eval/learning-eval.mjs` uses.
 * The important one is 3: "not measured" must never share an exit code with
 * "measured and fine" (0) or with "measured and worse" (1), or CI cannot tell a
 * regression from a harness that quietly ran nothing.
 */
export const EXIT = Object.freeze({
  /** every requested task RAN and the run met its budget */
  RAN_AND_MET_BUDGET: 0,
  /** the run happened and came out worse than its floor */
  RAN_AND_REGRESSED: 1,
  /** bad invocation, unreadable task set, harness error */
  USAGE: 2,
  /** a requested task did NOT run, or a result could not be proven — never a pass */
  NOT_RUN: 3,
});

export const VERDICT = Object.freeze({
  MET_BUDGET: "ran-and-met-budget",
  REGRESSED: "ran-and-regressed",
  NOT_RUN: "not-run",
} as const);

export type Verdict = (typeof VERDICT)[keyof typeof VERDICT];

/**
 * Why a task produced no score. Every one of these is a fact about the harness
 * or the environment, not about the candidate's ability — which is exactly why
 * they are kept out of the resolved/unresolved columns.
 */
export type NotRunReason =
  | "no-network"
  | "clone-failed"
  | "test-patch-failed"
  | "no-solution"
  | "build-failed-before-candidate"
  | "baseline-timeout"
  | "candidate-unavailable"
  | "candidate-timeout"
  | "test-timeout"
  | "no-test-report"
  | "runtime-unavailable"
  | "fail-to-pass-already-passing"
  | "not-attempted"
  | "harness-error";

export type PatchSource = "patch-file" | "working-tree" | "gold" | "none";

export interface CandidateResult {
  /** `command` = a real candidate ran; `gold` = reference-patch control run. */
  readonly kind: "command" | "gold" | "unavailable";
  /** null means the candidate produced nothing. That is an answer, and it is scored. */
  readonly patch: string | null;
  readonly patchSource: PatchSource;
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  readonly durationMs?: number;
  /** Set when kind === "unavailable": why there was no candidate to run. */
  readonly unavailableReason?: string;
}

/**
 * The pre-patch run. FAIL_TO_PASS only means something if the tests were seen
 * failing first — otherwise a test that always passed is indistinguishable from
 * a fix, and the benchmark scores the agent for work it did not do.
 */
export interface BaselineCheck {
  readonly measured: boolean;
  /** Why the baseline was not measured, when it was not. */
  readonly reason?: string;
  readonly failingBefore?: readonly string[];
  /** FAIL_TO_PASS tests that already passed before any patch. Poison. */
  readonly alreadyPassing?: readonly string[];
}

export interface AttemptInput {
  readonly instanceId: string;
  readonly repo: string;
  readonly failToPass: readonly string[];
  readonly passToPass: readonly string[];
  /** Set when the loop could not get far enough to produce a score. */
  readonly notRun?: { readonly reason: NotRunReason; readonly detail: string };
  readonly baseline?: BaselineCheck;
  readonly candidate?: CandidateResult;
  /** Result of applying the candidate's patch. A patch that does not apply is the candidate's problem. */
  readonly patchApplied?: { readonly ok: boolean; readonly detail?: string };
  readonly postReport?: MergedReport;
  readonly durationMs?: number;
  /** Environment changes the harness had to make to run at all (e.g. relaxed global.json). */
  readonly deviations?: readonly string[];
}

/**
 * A merged test report, plus the TRX counters.
 *
 * Scoring does not need the counters — it asks about named tests — but a report
 * that only says "unresolved" leaves the reader no way to tell 40 tests ran and
 * one failed from 1 test ran and failed. The counters are what make the run
 * checkable by someone who was not there.
 */
export interface MergedReport extends TestReport {
  readonly counters?: { total: number; passed: number; failed: number };
}
export type AttemptStatus = "resolved" | "unresolved" | "not-run";

export interface TaskAttempt {
  readonly instanceId: string;
  readonly repo: string;
  readonly status: AttemptStatus;
  /** True when the task produced a score at all. not-run tasks never do. */
  readonly scored: boolean;
  readonly reason: string;
  readonly notRunReason?: NotRunReason;
  /** True only when a measured baseline showed every FAIL_TO_PASS test failing first. */
  readonly fixProven: boolean;
  readonly resolution?: ResolutionResult;
  readonly candidateProducedNoPatch: boolean;
  readonly durationMs?: number;
  readonly deviations: readonly string[];
  readonly trxCounters?: { total: number; passed: number; failed: number };
}

const NOT_RUN_DETAIL: Record<NotRunReason, string> = {
  "no-network": "the repository could not be reached",
  "clone-failed": "the repository could not be cloned at baseCommit",
  "test-patch-failed": "the task's testPatch did not apply",
  "no-solution": "no solution or project file to test",
  "build-failed-before-candidate": "the project did not build before the candidate ran",
  "baseline-timeout": "the pre-patch test run exceeded its budget",
  "candidate-unavailable": "there was no candidate to run",
  "candidate-timeout": "the candidate was killed by the harness budget",
  "test-timeout": "the post-patch test run exceeded its budget",
  "no-test-report": "the test run produced no report to score",
  "runtime-unavailable":
    "the target framework's runtime or SDK support is not installed, so the tests cannot execute here",
  "fail-to-pass-already-passing": "a FAIL_TO_PASS test already passed before the patch",
  "not-attempted": "the task was requested but never attempted",
  "harness-error": "the harness failed",
};

function notRun(
  input: AttemptInput,
  reason: NotRunReason,
  detail: string,
): TaskAttempt {
  return {
    instanceId: input.instanceId,
    repo: input.repo,
    status: "not-run",
    scored: false,
    reason: `NOT RUN (${reason}): ${detail || NOT_RUN_DETAIL[reason]}`,
    notRunReason: reason,
    fixProven: false,
    candidateProducedNoPatch: false,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    deviations: input.deviations ?? [],
  };
}

/**
 * Turns one task's raw loop output into a status.
 *
 * Order matters. Harness failures are checked before anything that looks like a
 * score, because the one mistake that cannot be recovered later is letting a
 * broken run land in the unresolved column: from then on the report is a real
 * number over a wrong denominator, and nobody reading it can tell.
 */
export function classifyAttempt(input: AttemptInput): TaskAttempt {
  if (input.notRun) {
    return notRun(input, input.notRun.reason, input.notRun.detail);
  }

  const candidate = input.candidate;
  if (!candidate) {
    return notRun(input, "harness-error", "no candidate result was recorded");
  }
  if (candidate.kind === "unavailable") {
    return notRun(
      input,
      "candidate-unavailable",
      candidate.unavailableReason ?? NOT_RUN_DETAIL["candidate-unavailable"],
    );
  }
  // A candidate the harness killed did not answer; a candidate that returned
  // empty-handed did. Only the first is unmeasured.
  if (candidate.timedOut) {
    return notRun(
      input,
      "candidate-timeout",
      `the candidate ran ${candidate.durationMs ?? 0}ms and was killed by the harness budget`,
    );
  }

  const baseline = input.baseline ?? { measured: false, reason: "baseline run not requested" };
  const alreadyPassing = baseline.alreadyPassing ?? [];
  if (baseline.measured && alreadyPassing.length > 0) {
    // Not the candidate's failure and not a fix either: the task cannot show a
    // fail→pass transition, so it measures nothing.
    return notRun(
      input,
      "fail-to-pass-already-passing",
      `${alreadyPassing.length} FAIL_TO_PASS test(s) passed before any patch: ${alreadyPassing.join(", ")}`,
    );
  }

  const fixProven =
    baseline.measured && alreadyPassing.length === 0 && (baseline.failingBefore?.length ?? 0) > 0;

  const base = {
    instanceId: input.instanceId,
    repo: input.repo,
    scored: true,
    fixProven,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    deviations: input.deviations ?? [],
  } as const;

  const unprovenNote = fixProven
    ? ""
    : ` [fail→pass NOT proven: ${baseline.reason ?? "no baseline run"}]`;

  if (candidate.patch === null) {
    // The agent declined, or crashed without editing anything. That is a
    // scored attempt — reporting it as a harness error would quietly shrink
    // the denominator every time a model gives up.
    return {
      ...base,
      status: "unresolved",
      candidateProducedNoPatch: true,
      reason: `candidate produced no patch (exit ${candidate.exitCode ?? "?"}) — scored attempt, not a harness error${unprovenNote}`,
    };
  }

  if (input.patchApplied && !input.patchApplied.ok) {
    return {
      ...base,
      status: "unresolved",
      candidateProducedNoPatch: false,
      reason: `candidate patch did not apply: ${input.patchApplied.detail ?? "git apply failed"}${unprovenNote}`,
    };
  }

  if (!input.postReport) {
    return notRun(input, "no-test-report", NOT_RUN_DETAIL["no-test-report"]);
  }

  const resolution = evaluateResolution({
    failToPass: input.failToPass,
    passToPass: input.passToPass,
    report: input.postReport,
  });

  return {
    ...base,
    status: resolution.resolved ? "resolved" : "unresolved",
    candidateProducedNoPatch: false,
    resolution,
    reason: `${resolution.reason}${unprovenNote}`,
    ...(input.postReport.counters ? { trxCounters: input.postReport.counters } : {}),
  };
}

/**
 * Which FAIL_TO_PASS tests were observed failing before the patch.
 *
 * "Absent" counts as failing here — a test that did not run before the patch
 * was not passing, so a later pass is still a real transition. Absent counting
 * as *passing* would be the dangerous direction: it would mark the task poison
 * and hide a genuine fix as unmeasured.
 */
export function checkBaseline(
  failToPass: readonly string[],
  report: MergedReport,
): BaselineCheck {
  if (report.buildFailed) {
    return { measured: false, reason: "the pre-patch build failed, so nothing was observed" };
  }
  const alreadyPassing: string[] = [];
  const failingBefore: string[] = [];
  for (const name of failToPass) {
    const outcome: TestOutcome | undefined = findOutcome(report.outcomes, name);
    if (outcome === "passed") alreadyPassing.push(name);
    else failingBefore.push(name);
  }
  return { measured: true, failingBefore, alreadyPassing };
}

/**
 * The baseline when the test patch does not COMPILE before the fix.
 *
 * This is the normal state of a SWE-bench task, not an error: the added test
 * calls API the fix introduces, so the test project cannot build until the fix
 * lands. A harness that reads "no test results" as a broken environment reports
 * every such task as `not-run` and measures nothing — which is the failure mode
 * this function exists to prevent. A test that cannot compile cannot pass, so
 * every FAIL_TO_PASS test is failing, and that is an observation about the tree,
 * not an assumption about the agent.
 *
 * The caller must separately establish that the repo builds at `baseCommit`
 * WITHOUT the test patch; otherwise a genuinely broken checkout would land here
 * and be scored.
 */
export function baselineFromFailedTestPatchBuild(
  failToPass: readonly string[],
): BaselineCheck {
  return {
    measured: true,
    failingBefore: [...failToPass],
    alreadyPassing: [],
    reason:
      "the test patch does not compile before the fix — the expected failing state; " +
      "a test that cannot compile cannot pass",
  };
}

/**
 * Competitor comparison, which the improvement plan asks for by version.
 *
 * It is NOT MEASURED. Neither product is installed here and neither publishes a
 * SWE-Sharp-Bench score, so any number in this row would be invented. The state
 * is a literal type so a number cannot be dropped in later without changing the
 * type — the shape of the data refuses the fabrication, not just a convention.
 */
export interface CompetitorRow {
  readonly name: string;
  readonly version: string;
  readonly state: "NOT MEASURED";
  readonly reason: string;
}

export const COMPETITOR_BASELINES: readonly CompetitorRow[] = Object.freeze([
  Object.freeze({
    name: "Hermes",
    version: "v0.21.2",
    state: "NOT MEASURED" as const,
    reason: "not installed on this machine and it publishes no SWE-Sharp-Bench score to cite",
  }),
  Object.freeze({
    name: "Bezi",
    version: "1.36.0",
    state: "NOT MEASURED" as const,
    reason: "not installed on this machine and it publishes no SWE-Sharp-Bench score to cite",
  }),
]);

export interface RunReport {
  readonly requested: number;
  /** Tasks that produced a score. The rate's denominator. */
  readonly scored: number;
  readonly notRun: number;
  readonly resolved: number;
  readonly resolvedRate: number;
  readonly unresolvedIds: string[];
  readonly notRunTasks: { instanceId: string; reason: NotRunReason; detail: string }[];
  /** Resolved tasks whose FAIL_TO_PASS tests were seen failing first. */
  readonly provenResolved: number;
  readonly unprovenResolvedIds: string[];
  readonly noPatchIds: string[];
  readonly control: boolean;
  /**
   * Control-run tasks whose reference patch did NOT score as resolved. Empty for
   * a normal run. These are tasks this harness cannot measure — never evidence
   * about an agent.
   */
  readonly controlFailures: string[];
  readonly competitors: readonly CompetitorRow[];
}

/**
 * Aggregates attempts, with the not-run tasks kept OUT of the rate and named.
 *
 * The rate itself comes from `summarize` in the scoring module rather than being
 * recomputed here, so there is exactly one definition of the headline number.
 */
export function buildRunReport(
  requestedIds: readonly string[],
  attempts: readonly TaskAttempt[],
  options: { readonly control?: boolean } = {},
): RunReport {
  const byId = new Map(attempts.map((a) => [a.instanceId, a]));
  const all: TaskAttempt[] = [];
  for (const id of requestedIds) {
    const attempt = byId.get(id);
    // A requested task with no attempt at all is the quietest failure available:
    // the loop crashed, the list got filtered, the process died. Name it.
    all.push(
      attempt ??
        notRun(
          { instanceId: id, repo: "?", failToPass: [], passToPass: [] },
          "not-attempted",
          NOT_RUN_DETAIL["not-attempted"],
        ),
    );
  }
  for (const attempt of attempts) if (!requestedIds.includes(attempt.instanceId)) all.push(attempt);

  const scored = all.filter((a) => a.scored);
  const summary = summarize(
    scored.map((a) => ({
      instanceId: a.instanceId,
      result:
        a.resolution ??
        ({
          resolved: a.status === "resolved",
          failToPassMissing: [],
          passToPassBroken: [],
          reason: a.reason,
        } satisfies ResolutionResult),
    })),
  );

  const resolvedAttempts = scored.filter((a) => a.status === "resolved");
  return {
    requested: requestedIds.length,
    scored: scored.length,
    notRun: all.length - scored.length,
    resolved: summary.resolved,
    resolvedRate: summary.resolvedRate,
    unresolvedIds: summary.unresolvedIds,
    notRunTasks: all
      .filter((a) => !a.scored)
      .map((a) => ({
        instanceId: a.instanceId,
        reason: a.notRunReason ?? "harness-error",
        detail: a.reason,
      })),
    provenResolved: resolvedAttempts.filter((a) => a.fixProven).length,
    unprovenResolvedIds: resolvedAttempts.filter((a) => !a.fixProven).map((a) => a.instanceId),
    noPatchIds: scored.filter((a) => a.candidateProducedNoPatch).map((a) => a.instanceId),
    control: options.control ?? false,
    // A control run exists to answer one question: can this harness recognise a
    // known-good fix? Every unresolved task in one is a NO, about the harness.
    controlFailures: options.control ? summary.unresolvedIds : [],
    competitors: COMPETITOR_BASELINES,
  };
}

export interface ExitDecision {
  readonly exitCode: number;
  readonly verdict: Verdict;
  readonly reasons: string[];
}

/**
 * The exit code.
 *
 * "Not run" outranks "regressed" deliberately: a run that only measured half
 * the tasks cannot tell you whether the other half regressed, so reporting 1
 * would claim more than was measured. And an unprovable pass is unmeasured, not
 * a pass — that is the whole reason for the baseline run.
 */
export function decideExitCode(
  report: RunReport,
  options: { readonly minResolvedRate?: number; readonly requireFixProven?: boolean } = {},
): ExitDecision {
  const requireFixProven = options.requireFixProven ?? true;
  const reasons: string[] = [];

  if (report.notRun > 0) {
    for (const t of report.notRunTasks) reasons.push(`${t.instanceId}: ${t.detail}`);
    return { exitCode: EXIT.NOT_RUN, verdict: VERDICT.NOT_RUN, reasons };
  }
  if (report.scored === 0) {
    return {
      exitCode: EXIT.NOT_RUN,
      verdict: VERDICT.NOT_RUN,
      reasons: ["no task produced a score"],
    };
  }
  if (report.controlFailures.length > 0) {
    // The reference patch is correct by construction, so an unresolved control
    // task means the harness or the environment cannot measure it. Reporting
    // that as a score would publish a number about agents from a broken rig.
    return {
      exitCode: EXIT.NOT_RUN,
      verdict: VERDICT.NOT_RUN,
      reasons: report.controlFailures.map(
        (id) =>
          `${id}: CONTROL FAILURE — the reference patch did not score as resolved, so this harness cannot measure this task`,
      ),
    };
  }
  if (requireFixProven && report.unprovenResolvedIds.length > 0) {
    return {
      exitCode: EXIT.NOT_RUN,
      verdict: VERDICT.NOT_RUN,
      reasons: report.unprovenResolvedIds.map(
        (id) => `${id}: scored resolved but fail→pass was never observed — not a measured fix`,
      ),
    };
  }
  if (options.minResolvedRate !== undefined && report.resolvedRate < options.minResolvedRate) {
    return {
      exitCode: EXIT.RAN_AND_REGRESSED,
      verdict: VERDICT.REGRESSED,
      reasons: [
        `resolved rate ${report.resolvedRate} is below the floor ${options.minResolvedRate}`,
      ],
    };
  }
  return {
    exitCode: EXIT.RAN_AND_MET_BUDGET,
    verdict: VERDICT.MET_BUDGET,
    reasons: [`${report.scored}/${report.requested} tasks ran; ${report.resolved} resolved`],
  };
}

/** Human-readable report. Every not-run task and every unproven pass is named. */
export function renderRunReport(report: RunReport, attempts: readonly TaskAttempt[]): string {
  const lines: string[] = [];
  lines.push("SWE-Sharp-Bench run");
  if (report.control) {
    lines.push(
      "  CONTROL RUN (gold patch candidate): this measures the harness, not an agent.",
    );
  }
  lines.push(`  requested ${report.requested}  ran ${report.scored}  NOT RUN ${report.notRun}`);
  lines.push(
    `  resolved ${report.resolved}/${report.scored} (rate ${report.resolvedRate}) — denominator is tasks that RAN`,
  );
  lines.push(
    `  proven fail→pass ${report.provenResolved}/${report.resolved}` +
      (report.unprovenResolvedIds.length > 0
        ? `  UNPROVEN: ${report.unprovenResolvedIds.join(", ")}`
        : ""),
  );
  if (report.controlFailures.length > 0) {
    lines.push(
      `  CONTROL FAILURES — the reference patch did not resolve these, so they cannot be scored here: ${report.controlFailures.join(", ")}`,
    );
  }
  if (report.noPatchIds.length > 0) {
    lines.push(`  candidate produced no patch (scored, not an error): ${report.noPatchIds.join(", ")}`);
  }
  lines.push("");
  for (const a of attempts) {
    const status = a.status === "not-run" ? "NOT RUN " : a.status === "resolved" ? "RESOLVED" : "unresolved";
    const counters = a.trxCounters
      ? ` [trx total=${a.trxCounters.total} passed=${a.trxCounters.passed} failed=${a.trxCounters.failed}]`
      : "";
    const secs = a.durationMs === undefined ? "" : ` ${(a.durationMs / 1000).toFixed(1)}s`;
    lines.push(`  ${status}  ${a.instanceId}${secs}${counters}`);
    lines.push(`            ${a.reason}`);
    for (const d of a.deviations) lines.push(`            environment deviation: ${d}`);
  }
  if (report.notRunTasks.length > 0) {
    lines.push("");
    lines.push("NOT RUN — these are not failures and not passes:");
    for (const t of report.notRunTasks) lines.push(`  ${t.instanceId}  ${t.reason}`);
  }
  lines.push("");
  lines.push("Competitor comparison:");
  for (const c of report.competitors) {
    lines.push(`  ${c.name} ${c.version}: ${c.state} — ${c.reason}`);
  }
  lines.push("");
  lines.push(
    `exit contract: ${EXIT.RAN_AND_MET_BUDGET}=ran and met budget  ${EXIT.RAN_AND_REGRESSED}=ran and regressed  ` +
      `${EXIT.USAGE}=bad invocation  ${EXIT.NOT_RUN}=a requested task did NOT run`,
  );
  return lines.join("\n");
}

// ─── the parts of the loop that are decisions, not I/O ──────────────────────

/**
 * Merges the TRX reports of every test project into one report.
 *
 * `hasResults: false` everywhere means the run produced nothing, which is a
 * build failure — not a suite in which nothing passed. Scoring already treats
 * `buildFailed` as "every test unrun"; this is where that flag is set, and
 * getting it wrong in the lenient direction turns a broken build into a clean
 * sheet of failures that looks like a measured result.
 */
export function mergeTestReports(reports: readonly TrxParseResult[]): MergedReport {
  const outcomes = new Map<string, TestOutcome>();
  let any = false;
  let total = 0;
  let passed = 0;
  let failed = 0;
  let sawCounters = false;
  for (const r of reports) {
    if (r.hasResults) any = true;
    for (const [name, outcome] of r.outcomes) {
      const existing = outcomes.get(name);
      outcomes.set(name, existing === undefined ? outcome : worst(existing, outcome));
    }
    if (r.counters) {
      sawCounters = true;
      total += r.counters.total;
      passed += r.counters.passed;
      failed += r.counters.failed;
    }
  }
  return {
    outcomes,
    buildFailed: !any,
    ...(sawCounters ? { counters: { total, passed, failed } } : {}),
  };
}

function worst(a: TestOutcome, b: TestOutcome): TestOutcome {
  if (a === "failed" || b === "failed") return "failed";
  if (a === "skipped" || b === "skipped") return "skipped";
  return "passed";
}

/**
 * Picks the solution to test.
 *
 * Repos ship several: the product solution, plus ones for docs, samples and
 * analyzer sandboxes. Testing `docs/Docs.sln` builds nothing the task is about
 * and reports zero required tests, which scores as a clean failure — so the
 * choice is filtered and deterministic rather than "first match wins".
 */
export function chooseSolution(paths: readonly string[]): string | undefined {
  const EXCLUDE = /(^|\/)(docs|doc|samples|sample|examples|example|benchmarks?|tools)\//i;
  const usable = paths
    .map((p) => p.replace(/^\.\//, ""))
    .filter((p) => /\.slnx?$/i.test(p))
    .filter((p) => !EXCLUDE.test(p));
  if (usable.length === 0) return undefined;
  return usable.sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    if (depth !== 0) return depth;
    return a.localeCompare(b);
  })[0];
}

/**
 * Picks the test projects that can contain the required tests.
 *
 * Testing the whole solution is correct and ruinously slow: these repos build a
 * dozen projects across three target frameworks to run one test. A project whose
 * assembly name is the root of a required test's fully-qualified name is the one
 * that holds it, and that mapping holds because .NET's default root namespace is
 * the assembly name.
 *
 * The match is the LONGEST project name that roots the test, per required test.
 * `Autofac` roots `Autofac.Test.Core.…` just as `Autofac.Test` does, and the
 * shorter one is the product library: `dotnet test` on a project with no test
 * adapter fails, so a greedy union would turn a runnable task into a broken one.
 *
 * Returns [] when nothing matches, and the caller then falls back to the whole
 * solution rather than guessing. Guessing wrong here produces a TRX with none of
 * the required tests in it, which scores as a clean failure — a wrong number
 * that looks exactly like a real one.
 */
export function chooseTestProjects(
  projectPaths: readonly string[],
  requiredNames: readonly string[],
): string[] {
  const matched = new Set<string>();
  for (const name of requiredNames) {
    let best: { path: string; length: number } | undefined;
    for (const projectPath of projectPaths) {
      const base = path.basename(projectPath).replace(/\.csproj$/i, "");
      if (base === "") continue;
      if (name !== base && !name.startsWith(`${base}.`)) continue;
      if (!best || base.length > best.length) {
        best = { path: projectPath.replace(/^\.\//, ""), length: base.length };
      }
    }
    if (best) matched.add(best.path);
  }
  return [...matched].sort();
}

/**
 * Is this a project that can run tests?
 *
 * A project whose assembly name roots a test's fully-qualified name is not
 * necessarily the project that HOLDS the test: `Terminal.Gui.ViewTests.…` is
 * rooted by the library `Terminal.Gui`, while the tests live in `UnitTests`.
 * `dotnet test` on the library produces no report, which scoring reads as "every
 * required test absent" — a clean, wrong, unresolved score. Requiring a test SDK
 * reference is what keeps that guess from turning into a number.
 */
export function looksLikeTestProject(csprojXml: string): boolean {
  if (/<IsTestProject>\s*false\s*<\/IsTestProject>/i.test(csprojXml)) return false;
  if (/<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(csprojXml)) return true;
  return /Microsoft\.NET\.Test\.Sdk|xunit\.runner|NUnit3TestAdapter|MSTest\.TestAdapter|<TestProject>/i.test(
    csprojXml,
  );
}

/** What a `dotnet test` invocation actually produced. */
export type TestRunOutcome = "results" | "build-failure" | "no-test-report" | "runtime-unavailable";

/** The SDK/runtime is missing for this target framework — nothing about the patch. */
const RUNTIME_UNAVAILABLE =
  /Could not find '[^']*' host|You must install \.NET|The framework '[^']+', version [^\n]*was not found|error NETSDK1045|is not supported by (?:the )?\.NET SDK|no runtime pack/i;

/** A real compilation failure: the code (or the added test) does not compile. */
const COMPILE_ERROR = /error CS\d+|error FS\d+|error VBC\d+|error MSB\d+/i;

/**
 * Classifies a test run that produced no results — the case where every honest
 * distinction lives.
 *
 * Four different things look identical from the outside, and three of them must
 * never be scored:
 *
 *   - `results`             the run reported outcomes; score it.
 *   - `build-failure`       something genuinely did not compile. In the pre-patch
 *                           phase that is the added test needing the fix; in the
 *                           post-patch phase it is the candidate's patch, and it
 *                           IS the candidate's failure, so it is scored.
 *   - `no-test-report`      no TRX at all and nothing failed to compile: no test
 *                           host ever ran. Usually the wrong project was tested.
 *                           There is no evidence here, so there is no score.
 *   - `runtime-unavailable` the target framework cannot execute on this machine
 *                           (netcoreapp3.1 on arm64, say). Not measurable here.
 *
 * Collapsing the last two into `build-failure` is how a harness reports an
 * environment gap as an agent's failure — a real number about nothing.
 */
export function classifyTestRun(input: {
  readonly anyResults: boolean;
  readonly trxFilesFound: number;
  readonly logText: string;
}): TestRunOutcome {
  if (input.anyResults) return "results";
  if (RUNTIME_UNAVAILABLE.test(input.logText)) return "runtime-unavailable";
  if (COMPILE_ERROR.test(input.logText)) return "build-failure";
  if (input.trxFilesFound === 0) return "no-test-report";
  return "build-failure";
}

/**
 * Picks which target framework to test.
 *
 * `TargetFrameworks` on these tasks routinely includes `net472` and
 * `netstandard2.0`: the first cannot run on macOS or Linux and the second is not
 * runnable at all, so letting `dotnet test` take the whole list turns a passing
 * suite into a failing one for a reason that has nothing to do with the patch.
 * Newest .NET Core-family framework wins, and roll-forward covers the gap
 * between the pinned framework and the installed runtime.
 */
export function chooseFramework(targetFrameworksRaw: string | undefined): string | undefined {
  if (!targetFrameworksRaw) return undefined;
  const candidates: { tfm: string; version: number }[] = [];
  for (const raw of targetFrameworksRaw.split(";")) {
    const tfm = raw.trim();
    const net = /^net(\d+)\.(\d+)$/.exec(tfm);
    if (net) {
      candidates.push({ tfm, version: Number(net[1]) * 1000 + Number(net[2]) });
      continue;
    }
    const core = /^netcoreapp(\d+)\.(\d+)$/.exec(tfm);
    if (core) candidates.push({ tfm, version: Number(core[1]) * 1000 + Number(core[2]) });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.version - a.version);
  return candidates[0]!.tfm;
}

export interface TestCommand {
  readonly args: string[];
  readonly env: Record<string, string>;
}

/**
 * Builds the `dotnet test` invocation.
 *
 * Two non-obvious pieces. The TRX logger is the entire bridge to scoring, so
 * the file name and results directory are explicit rather than left to dotnet's
 * default (a timestamped name under the project's TestResults, which the
 * scorer would have to guess at). And `DOTNET_ROLL_FORWARD=LatestMajor` is what
 * lets a task pinned to net6.0/net7.0 run on a machine that only has the .NET
 * 10 runtime; without it every one of these tasks is `not-run`, which is
 * honest but measures nothing.
 */
export function buildTestCommand(options: {
  readonly target: string;
  readonly trxName: string;
  readonly resultsDir: string;
  readonly framework?: string;
  readonly filter?: string;
  readonly configuration?: string;
}): TestCommand {
  const args = [
    "test",
    options.target,
    "--logger",
    `trx;LogFileName=${options.trxName}`,
    "--results-directory",
    options.resultsDir,
    "--nologo",
    "--verbosity",
    "minimal",
  ];
  if (options.configuration) args.push("--configuration", options.configuration);
  if (options.framework) args.push("--framework", options.framework);
  if (options.filter) args.push("--filter", options.filter);
  return {
    args,
    env: {
      DOTNET_ROLL_FORWARD: "LatestMajor",
      // Without this the SDK speaks the machine's language, and a run log
      // nobody on the team can read is a run log nobody checks.
      DOTNET_CLI_UI_LANGUAGE: "en",
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_NOLOGO: "1",
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
      // Deterministic culture, so an assertion on a formatted number does not
      // depend on the machine's locale.
      DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "0",
      LANG: "en_US.UTF-8",
    },
  };
}

/**
 * Builds the `dotnet build` invocation used to check the checkout at
 * `baseCommit` before the test patch is applied.
 *
 * This is the only way to tell "this repository does not build here" (a
 * `not-run`) from "the added test does not compile until the fix lands" (the
 * expected failing baseline). Without it those two look identical, and the
 * harness has to guess — in one direction it hides broken environments, in the
 * other it reports every real task as unmeasurable.
 */
export function buildBuildCommand(options: {
  readonly target: string;
  readonly framework?: string;
  readonly configuration?: string;
}): TestCommand {
  const args = ["build", options.target, "--nologo", "--verbosity", "minimal"];
  if (options.configuration) args.push("--configuration", options.configuration);
  if (options.framework) args.push("--framework", options.framework);
  return {
    args,
    env: buildTestCommand({ target: options.target, trxName: "x.trx", resultsDir: "." }).env,
  };
}

/**
 * Builds a `--filter` expression covering exactly the required tests.
 *
 * Only the required tests are scored, so running the rest is spent time. The
 * match is `~` (contains) because the dataset's fully-qualified name and TRX's
 * reported name differ for parameterised cases — the same mismatch
 * `findOutcome` exists to absorb. Returns undefined above the size cap: an
 * over-long filter is silently truncated by the shell/MSBuild on some
 * platforms, and a truncated filter drops required tests, which scores as
 * failure. Running everything is slower and correct.
 */
export function buildRequiredTestFilter(
  names: readonly string[],
  options: { readonly maxLength?: number; readonly maxNames?: number } = {},
): string | undefined {
  const maxLength = options.maxLength ?? 6000;
  const maxNames = options.maxNames ?? 60;
  const unique = [...new Set(names.filter((n) => n.trim() !== ""))];
  if (unique.length === 0 || unique.length > maxNames) return undefined;
  // A filter value cannot contain the operator characters; a test name with one
  // would produce an expression that means something else entirely.
  if (unique.some((n) => /[|&!()]/.test(n))) return undefined;
  const expr = unique.map((n) => `FullyQualifiedName~${n}`).join("|");
  return expr.length > maxLength ? undefined : expr;
}

/**
 * Chooses what the candidate actually produced.
 *
 * Two shapes are accepted because agents differ: writing a diff to
 * `$STRADA_BENCH_PATCH_OUT`, or just editing the working tree. Whitespace-only
 * output and a diff with no hunks both mean "nothing" — a patch file containing
 * a friendly "I could not fix this" message must not be applied as a patch, nor
 * mistaken for one.
 */
export function classifyPatchOutput(input: {
  readonly patchFile?: string | null;
  readonly workingTreeDiff?: string | null;
}): { patch: string | null; source: PatchSource } {
  const file = input.patchFile ?? "";
  if (isDiffLike(file)) return { patch: file, source: "patch-file" };
  const tree = input.workingTreeDiff ?? "";
  if (isDiffLike(tree)) return { patch: tree, source: "working-tree" };
  return { patch: null, source: "none" };
}

/** Minimal git surface the patch capture needs, so it can be tested. */
export type RunGit = (args: string[]) => { ok: boolean; stdout: string };

/**
 * Captures everything the candidate changed, however it chose to leave the tree.
 *
 * `git diff` answers "what is unstaged" — which is not the question. A candidate
 * that fixes the bug and then runs `git add`, or commits, or works on a branch it
 * created, leaves `git diff` empty, and the harness would score it as having
 * produced NO PATCH: a false zero that looks exactly like a measurement of an
 * agent that gave up. Diffing the final tree against the revision recorded
 * BEFORE the candidate ran covers all of those: staged, committed, on another
 * branch, or merely edited in place.
 *
 * `--intent-to-add` on untracked files is what makes an added file part of the
 * diff. Ignored files stay ignored, so build output never lands in the patch.
 */
export function captureCandidatePatch(input: {
  readonly runGit: RunGit;
  readonly baseRev: string;
  readonly patchFile?: string | null;
}): { patch: string | null; source: PatchSource } {
  const untracked = input.runGit(["ls-files", "--others", "--exclude-standard"]);
  const files = untracked.ok
    ? untracked.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  for (let i = 0; i < files.length; i += 100) {
    input.runGit(["add", "--intent-to-add", "--", ...files.slice(i, i + 100)]);
  }
  // `git diff <rev>` is rev→working-tree, so it includes staged and committed
  // work. A plain `git diff` would not.
  const diff = input.runGit(["diff", input.baseRev]);
  return classifyPatchOutput({
    patchFile: input.patchFile ?? "",
    workingTreeDiff: diff.ok ? diff.stdout : "",
  });
}

/**
 * The files a patch touches.
 *
 * Used to restore the task's test files from the base revision before the test
 * patch is re-applied. A candidate that edits or deletes the benchmark's tests
 * would otherwise either break the test patch — escaping the score entirely,
 * which is a cheap way for a weak agent to never be measured — or smuggle its
 * "fix" into the assertions. The tests are not the candidate's to write.
 */
export function testPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const both = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (both) {
      paths.add(both[1]!);
      paths.add(both[2]!);
      continue;
    }
    const minus = /^--- a\/(.+)$/.exec(line);
    if (minus) paths.add(minus[1]!);
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus) paths.add(plus[1]!);
  }
  paths.delete("/dev/null");
  return [...paths].sort();
}

export function isDiffLike(text: string): boolean {
  if (text.trim() === "") return false;
  // A diff needs a hunk to change anything. "diff --git" alone appears in
  // chat-shaped output that quotes a diff header without a body.
  return /^@@ /m.test(text) && (/^(diff --git |--- |\+\+\+ )/m.test(text) || /^index /m.test(text));
}

/**
 * Relaxes a repo's `global.json` so an SDK newer than the pinned one is allowed.
 *
 * This is an environment deviation and the caller records it as one: the task
 * was authored against .NET 7 and is being built with .NET 10. Pretending
 * otherwise would hide a real reason a result might differ from the upstream
 * dataset's own numbers. Without it, every pinned-SDK repo is `not-run`.
 */
export function relaxGlobalJson(contents: string): { text: string; changed: boolean } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contents) as Record<string, unknown>;
  } catch {
    return { text: contents, changed: false };
  }
  const sdk = parsed.sdk;
  if (!sdk || typeof sdk !== "object") return { text: contents, changed: false };
  const current = (sdk as Record<string, unknown>).rollForward;
  if (current === "latestMajor") return { text: contents, changed: false };
  const next = {
    ...parsed,
    sdk: { ...(sdk as Record<string, unknown>), rollForward: "latestMajor" },
  };
  return { text: `${JSON.stringify(next, null, 2)}\n`, changed: true };
}

/**
 * Refuses a cache directory inside the repo or under the user's `~/.strada`.
 *
 * Multi-gigabyte clones and NuGet caches inside a working tree get committed,
 * or get wiped by a `git clean`, and `~/.strada` is live state this harness has
 * no business writing. Both are quiet mistakes, which is why this is a checked
 * precondition rather than a comment.
 */
export function assertCacheDirIsSafe(cacheDir: string, repoRoot: string, homeDir: string): void {
  const cache = path.resolve(cacheDir);
  const inside = (parent: string): boolean => {
    const rel = path.relative(path.resolve(parent), cache);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (inside(repoRoot)) {
    throw new Error(`cache dir ${cache} is inside the repository — clones must live outside it`);
  }
  if (inside(path.join(homeDir, ".strada"))) {
    throw new Error(`cache dir ${cache} is inside ~/.strada — the harness must not write there`);
  }
}
