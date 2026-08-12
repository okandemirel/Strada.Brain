/**
 * SWE-bench resolution scoring.
 *
 * A task counts as resolved only when every FAIL_TO_PASS test passes AND every
 * PASS_TO_PASS test still passes. Both halves matter and the second is the one
 * that is easy to drop: without it, deleting the failing assertion, or the test
 * file, scores as a fix.
 *
 * The subtle part is what a *missing* test result means. A test that does not
 * appear in the report did not pass — it was not run, or the build failed, or
 * the patch renamed it. Treating absent-as-passed is the single change that
 * would turn a broken run into a perfect score, so absence is failure here,
 * explicitly and by name.
 */

import { findOutcome, type TestOutcome } from "./trx-report.js";

export type { TestOutcome };

export interface TestReport {
  /** Outcome per fully-qualified test name. Tests that did not run are absent. */
  readonly outcomes: ReadonlyMap<string, TestOutcome>;
  /** True when the project did not build. Every test is then unrun, not passed. */
  readonly buildFailed?: boolean;
}

export interface ResolutionInput {
  readonly failToPass: readonly string[];
  readonly passToPass: readonly string[];
  readonly report: TestReport;
}

export interface ResolutionResult {
  readonly resolved: boolean;
  /** FAIL_TO_PASS tests that did not pass. */
  readonly failToPassMissing: string[];
  /** PASS_TO_PASS tests that regressed or vanished. */
  readonly passToPassBroken: string[];
  readonly reason: string;
}

/**
 * A skipped test is not a passing test.
 *
 * Skipping is how a suite reports "this did not actually verify anything", and
 * a patch that adds `[Skip]` to the failing test would otherwise be scored as
 * a fix — which is exactly the behaviour a model under evaluation can stumble
 * into without meaning to cheat.
 */
function passed(report: TestReport, name: string): boolean {
  // findOutcome, not a plain map lookup: the dataset lists fully-qualified
  // names while TRX may report a short name or one case per parameterised
  // input. An exact-only lookup scores a correct run as a failure.
  return findOutcome(report.outcomes, name) === "passed";
}

export function evaluateResolution(input: ResolutionInput): ResolutionResult {
  const { failToPass, passToPass, report } = input;

  if (report.buildFailed) {
    return {
      resolved: false,
      failToPassMissing: [...failToPass],
      passToPassBroken: [...passToPass],
      reason: "build failed",
    };
  }

  const failToPassMissing = failToPass.filter((t) => !passed(report, t));
  const passToPassBroken = passToPass.filter((t) => !passed(report, t));

  // A task with no FAIL_TO_PASS tests cannot demonstrate anything was fixed.
  // This is not hypothetical: the dataset's test lists arrive as Python repr
  // strings, and a decoder that fails soft to [] makes every task vacuously
  // resolved. Refuse rather than score it.
  if (failToPass.length === 0) {
    return {
      resolved: false,
      failToPassMissing: [],
      passToPassBroken,
      reason: "task has no FAIL_TO_PASS tests — it cannot be scored",
    };
  }

  const resolved = failToPassMissing.length === 0 && passToPassBroken.length === 0;
  return {
    resolved,
    failToPassMissing,
    passToPassBroken,
    reason: resolved
      ? "all FAIL_TO_PASS passed and no PASS_TO_PASS regressed"
      : [
          failToPassMissing.length > 0 ? `${failToPassMissing.length} FAIL_TO_PASS not passing` : null,
          passToPassBroken.length > 0 ? `${passToPassBroken.length} PASS_TO_PASS regressed` : null,
        ]
          .filter(Boolean)
          .join("; "),
  };
}

export interface RunSummary {
  readonly total: number;
  readonly resolved: number;
  /** The headline SWE-bench number. */
  readonly resolvedRate: number;
  readonly unresolvedIds: string[];
}

export function summarize(
  results: ReadonlyArray<{ instanceId: string; result: ResolutionResult }>,
): RunSummary {
  const resolved = results.filter((r) => r.result.resolved);
  return {
    total: results.length,
    resolved: resolved.length,
    // Rate over ATTEMPTED tasks. A harness that silently skipped tasks would
    // otherwise report a flattering rate over a shrunken denominator, so the
    // caller is responsible for passing every task it set out to run —
    // including the ones that errored.
    resolvedRate: results.length === 0 ? 0 : Number((resolved.length / results.length).toFixed(4)),
    unresolvedIds: results.filter((r) => !r.result.resolved).map((r) => r.instanceId),
  };
}
