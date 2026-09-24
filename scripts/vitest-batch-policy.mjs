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
 * Run each batch through `run` (resolves to the batch's exit code) and return
 * the exit code for the whole run: 0 when every batch passed, otherwise the
 * first failing batch's code.
 *
 * @param {string[][]} batches
 * @param {(batch: string[]) => Promise<number>} run
 * @param {Pick<Console, "log" | "error">} [log]
 * @returns {Promise<number>}
 */
export async function runAllBatches(batches, run, log = console) {
  const failed = [];
  for (const [index, batch] of batches.entries()) {
    log.log(`\n[vitest-batch] ${index + 1}/${batches.length} (${batch.length} files)`);
    let exitCode;
    let reason = "";
    try {
      exitCode = await run(batch);
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
  log.error("[vitest-batch] each failing test file is marked FAIL in its batch's output above.");
  return failed[0].exitCode;
}
