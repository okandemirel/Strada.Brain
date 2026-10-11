/**
 * Runs in every worker before each test file; vitest.global-setup.ts gives
 * the whole run one temp root, and this narrows the runtime roots to the
 * worker inside it.
 *
 * - One STRADA_HOME per worker. A single home for the run meant parallel test
 *   files met in its archives, hub-owners.db, locks and the setup wizard's
 *   .env (review of 084f0903, 2026-10-11).
 * - The memory and model-intelligence databases default to RELATIVE paths
 *   (`.strada-memory`, `.strada-memory/model-intelligence.db`). The runtime
 *   chdirs to its config root before it opens them; a worker stands in the
 *   checkout, so a test that built a stage from the defaults opened
 *   <repo>/.strada-memory/*.db (measured 2026-10-11). Point them where the
 *   runtime would have put them: inside this worker's home. ProviderManager
 *   and the model catalog fall back to MEMORY_DB_PATH too.
 *
 * Set on every file, not defaulted: a file that changed one of them and did
 * not put it back must not hand that to the next file in the worker.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const runRoot = process.env["STRADA_VITEST_TMP_ROOT"];
if (runRoot) {
  const home = join(runRoot, "strada-home", `worker-${process.env["VITEST_POOL_ID"] ?? process.pid}`);
  mkdirSync(home, { recursive: true });
  process.env["STRADA_HOME"] = home;
  process.env["MEMORY_DB_PATH"] = join(home, ".strada-memory");
  process.env["MODEL_INTELLIGENCE_DB_PATH"] = join(home, ".strada-memory", "model-intelligence.db");
}
