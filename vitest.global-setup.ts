/**
 * One temp root per test run, removed when the run exits normally (a
 * Ctrl-C'd run leaves its root; the next normal run does not touch it).
 *
 * Measured 2026-09-08 03:50: the machine's temp directory held 139 813
 * entries — "assets-gate-" ×6455, "module-create-structure-" ×4692,
 * "strada-rag-test-" ×4380 … — left by tests that mkdtemp and never rm.
 * Fixing 160 test files one by one is the wrong lever: every worker reads
 * TMPDIR when it calls os.tmpdir(), so a fresh root here contains all of it,
 * and the teardown deletes the whole run at once.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "strada-vitest-"));
  process.env["TMPDIR"] = root;
  process.env["STRADA_VITEST_TMP_ROOT"] = root;
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
