/**
 * How `npm test` treats a failing batch (used by run-vitest-batches.mjs).
 *
 * Every batch runs, then the run reports. The runner used to stop at the first
 * failing batch, which hid the result of every batch after it: CI reported one
 * red file while the batches behind it (a quarter of the suite) never ran, so a
 * second regression looked exactly like the first.
 *
 * Kept apart from the runner so the policy can be tested without the runner's
 * top-level side effects (collecting files, spawning vitest).
 */

/**
 * Run each batch through `run` and return the exit code for the whole run: 0
 * when every batch passed, otherwise the first failing batch's code.
 *
 * `run` resolves to the batch's exit code, or to `{ exitCode, failures }` when
 * it can say which tests failed. Those are listed together at the end, so a
 * CI log that keeps only its tail still names every failing test of every
 * batch, not just the last few batches' (the per-batch output scrolls away).
 *
 * @param {string[][]} batches
 * @param {(batch: string[]) => Promise<number | BatchOutcome>} run
 * @param {Pick<Console, "log" | "error">} [log]
 * @returns {Promise<number>}
 */
export async function runAllBatches(batches, run, log = console) {
  const failed = [];
  /** @type {BatchFailure[]} */
  const failures = [];
  for (const [index, batch] of batches.entries()) {
    log.log(`\n[vitest-batch] ${index + 1}/${batches.length} (${batch.length} files)`);
    let exitCode;
    let reason = "";
    try {
      const outcome = await run(batch);
      if (typeof outcome === "number") {
        exitCode = outcome;
      } else {
        exitCode = outcome.exitCode;
        failures.push(...(outcome.failures ?? []));
      }
    } catch (error) {
      // A batch killed by a signal (an OOM kill, say) is a failed batch, not a
      // reason to leave the rest of the suite unrun.
      exitCode = 1;
      reason = ` (${error instanceof Error ? error.message : String(error)})`;
    }
    if (exitCode !== 0) failed.push({ number: index + 1, files: batch.length, exitCode, reason });
  }

  if (failed.length === 0) {
    log.log(`\n[vitest-batch] all ${batches.length} batches passed`);
    return 0;
  }
  log.error(`\n[vitest-batch] ${failed.length} of ${batches.length} batches FAILED:`);
  for (const batch of failed) {
    log.error(
      `  batch ${batch.number}/${batches.length} (${batch.files} files) exited ${batch.exitCode}${batch.reason}`,
    );
  }
  if (failures.length === 0) {
    log.error("[vitest-batch] each failing test file is marked FAIL in its batch's output above.");
  } else {
    for (const line of formatFailures(failures)) log.error(line);
  }
  return failed[0].exitCode;
}

/**
 * @typedef {{ file: string, test?: string, message: string }} BatchFailure
 *   `test` is absent when the file itself failed (a load or suite error).
 * @typedef {{ exitCode: number, failures?: BatchFailure[] }} BatchOutcome
 */

/** Most failures listed in the summary; the per-batch output has the rest. */
export const MAX_LISTED_FAILURES = 400;
const MAX_MESSAGE_CHARS = 240;

/**
 * The end-of-run list of failing tests, grouped by file: each test with the
 * first line of its failure message.
 *
 * @param {BatchFailure[]} failures
 * @returns {string[]}
 */
export function formatFailures(failures) {
  const byFile = new Map();
  for (const failure of failures) {
    const list = byFile.get(failure.file) ?? [];
    list.push(failure);
    byFile.set(failure.file, list);
  }
  const lines = [`[vitest-batch] ${failures.length} failing test(s) in ${byFile.size} file(s):`];
  let listed = 0;
  for (const [file, list] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (listed >= MAX_LISTED_FAILURES) break;
    lines.push(`  ${file}`);
    for (const failure of list) {
      if (listed >= MAX_LISTED_FAILURES) break;
      listed += 1;
      const firstLine = String(failure.message ?? "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
      const message = firstLine.trim().slice(0, MAX_MESSAGE_CHARS);
      lines.push(`    - ${failure.test ?? "(file failed to run)"}: ${message}`);
    }
  }
  if (listed < failures.length) {
    lines.push(`  ... and ${failures.length - listed} more; see each batch's output above.`);
  }
  return lines;
}

/**
 * The failures in a vitest JSON report (`--reporter=json`), with file paths
 * relative to `root` and forward slashes, so the list reads the same on every
 * platform.
 *
 * @param {unknown} report
 * @param {(absolutePath: string) => string} relativeTo
 * @returns {BatchFailure[]}
 */
export function failuresFromJsonReport(report, relativeTo) {
  /** @type {BatchFailure[]} */
  const out = [];
  const results = report && typeof report === "object" && Array.isArray(report.testResults) ? report.testResults : [];
  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    const file = relativeTo(String(result.name ?? "")).replace(/\\/g, "/");
    const failedTests = Array.isArray(result.assertionResults)
      ? result.assertionResults.filter((a) => a && a.status === "failed")
      : [];
    for (const test of failedTests) {
      const messages = Array.isArray(test.failureMessages) ? test.failureMessages : [];
      out.push({ file, test: String(test.fullName ?? test.title ?? ""), message: String(messages[0] ?? "") });
    }
    if (failedTests.length === 0 && result.status === "failed") {
      out.push({ file, message: String(result.message ?? "") });
    }
  }
  return out;
}
