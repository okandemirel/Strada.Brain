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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "strada-vitest-"));
  process.env["TMPDIR"] = root;
  // Node's tmpdir() reads TEMP/TMP on Windows and TMPDIR elsewhere (Codex
  // review 2026-09-09): set all three so every platform's workers land here.
  process.env["TEMP"] = root;
  process.env["TMP"] = root;
  process.env["STRADA_VITEST_TMP_ROOT"] = root;

  // The config root (.env, .strada/locks, relative log files) goes in the run
  // root too. Run from a git checkout, the source-checkout probe made the
  // checkout itself the config root: every worker's config.ts import loaded
  // the developer's .env, the setup-wizard save tests aimed persistSetup at
  // it, and an AutoUpdater test took the live daemon's update lock (measured
  // 2026-10-11). Forced, not defaulted: a shell the launcher spawned carries
  // STRADA_SOURCE_CHECKOUT=true and its STRADA_INSTALL_ROOT. A test that needs
  // a source checkout sets both itself, on a temp directory. Each worker
  // narrows the home to its own subdirectory (vitest.worker-setup.ts).
  const home = join(root, "strada-home");
  mkdirSync(home);
  process.env["STRADA_HOME"] = home;
  process.env["STRADA_SOURCE_CHECKOUT"] = "false";
  // The rest of what the launcher and the daemon hand their children goes
  // too: under STRADA_DAEMON=1 an AutoUpdater a test builds without its own
  // isDaemonProcess thinks it runs under the daemon, and an auto-restart
  // update SIGTERMs the worker it runs in.
  for (const key of [
    "STRADA_INSTALL_ROOT",
    "STRADA_LAUNCHER_PATH",
    "STRADA_SOURCE_LAUNCHER",
    "STRADA_LAUNCH_CWD",
    "STRADA_NODE_PATH",
    "STRADA_DAEMON",
  ]) {
    delete process.env[key];
  }

  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
