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
 * - The user's home, as os.homedir() answers it in this process, is an empty
 *   directory per test file (see installDecoyHome).
 *
 * Set on every file, not defaulted: a file that changed one of them and did
 * not put it back must not hand that to the next file in the worker.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { newDecoyHome } from "./src/tests/helpers/decoy-home.js";

const runRoot = process.env["STRADA_VITEST_TMP_ROOT"];
if (runRoot) {
  const home = join(runRoot, "strada-home", `worker-${process.env["VITEST_POOL_ID"] ?? process.pid}`);
  mkdirSync(home, { recursive: true });
  process.env["STRADA_HOME"] = home;
  process.env["MEMORY_DB_PATH"] = join(home, ".strada-memory");
  process.env["MODEL_INTELLIGENCE_DB_PATH"] = join(home, ".strada-memory", "model-intelligence.db");
  installDecoyHome(runRoot);
}

interface HomedirPatch {
  readonly realHomedir: () => string;
  /** What os.homedir() answered before the patch: the developer's own home. */
  readonly realHome: string;
  decoy: string;
}

/**
 * A module that builds `homedir()/.strada` itself, instead of asking the app
 * home (resolveStradaHomeEntry), writes the developer's own ~/.strada while
 * every assertion stays green: test runs rewrote the real skills.json, Unity
 * link and assets-local markers that way (2026-08-28, 2026-09-17,
 * 2026-10-11). A run-level check on the real directory cannot tell a test from
 * the live daemon writing it at the same time, so the home is moved instead:
 * os.homedir() answers an empty directory, and a file that leaves `.strada…`
 * in it fails, naming what it wrote.
 *
 * Only while HOME is the real one: a test that points HOME at its own
 * directory still gets that directory. Child processes keep the real HOME
 * (git, npm and the toolchains read their config from it); they get
 * STRADA_HOME, which the runtime's own paths follow.
 */
function installDecoyHome(root: string): void {
  const state = globalThis as typeof globalThis & { __stradaHomedirPatch?: HomedirPatch };
  const patch = (state.__stradaHomedirPatch ??= { realHomedir: os.homedir, realHome: os.homedir(), decoy: "" });
  const decoy = newDecoyHome(root);
  patch.decoy = decoy;
  os.homedir = () => {
    const home = patch.realHomedir();
    return home === patch.realHome ? patch.decoy : home;
  };
  // `import { homedir } from "node:os"` binds the ESM export, not the property.
  syncBuiltinESMExports();

  afterAll(() => {
    const leaked = readdirSync(decoy).filter((name) => name.startsWith(".strada"));
    if (leaked.length > 0) {
      throw new Error(
        `This test file wrote ${leaked.join(", ")} under the user's home (${decoy}); outside a test run ` +
          "that is the developer's own ~/.strada. Resolve the path with resolveStradaHomeEntry().",
      );
    }
  });
}
