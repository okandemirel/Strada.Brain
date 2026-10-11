/**
 * The suite never takes the checkout it runs from as its config root.
 *
 * Measured 2026-10-11: a full run left <repo>/.strada/locks behind (an
 * AutoUpdater test took the live daemon's update lock there), and every
 * worker's config.ts import loaded the developer's own <repo>/.env, which the
 * setup-wizard save tests would rewrite the moment a validation guard let one
 * through. Inside a git checkout the source-checkout probe made the
 * repository the config root; the global setup now points it at the run's
 * temp root instead. These are the paths a test reaches through the
 * resolvers when it passes nothing of its own.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolveDotenvPath,
  resolveRuntimePaths,
  resolveStradaHome,
} from "../common/runtime-paths.js";
import { installLockPath } from "../core/runtime-lock.js";
import { loadConfig } from "../config/config.js";
import { resolveProviderModelCatalogPath } from "../agents/providers/provider-model-catalog-store.js";
import { setSkillEnabled } from "../skills/skill-config.js";
import { takeSupervisorDeathMarker } from "../core/boot-report.js";

// What the source launcher and the daemon put in their children's environment.
// A shell they spawned passes them on to the suite.
const LAUNCHER_ENV = [
  "STRADA_INSTALL_ROOT",
  "STRADA_LAUNCHER_PATH",
  "STRADA_SOURCE_LAUNCHER",
  "STRADA_LAUNCH_CWD",
  "STRADA_NODE_PATH",
  "STRADA_DAEMON",
];

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
// The modules that load and write the .env pass their own URL.
const configModule = pathToFileURL(join(repoRoot, "src", "config", "config.ts")).href;
const setupWizardModule = pathToFileURL(join(repoRoot, "src", "core", "setup-wizard.ts")).href;

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Run `fn` with the user's home pointed at an empty decoy, and return the
 * decoy. The resolvers above cannot see a module that skips them and builds
 * `homedir()/.strada` itself — that module writes the developer's own home
 * while every assertion here stays green. Whatever lands in the decoy would
 * have landed there. os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
 */
async function inDecoyHome(runRoot: string, fn: () => unknown): Promise<string> {
  const decoy = mkdtempSync(join(runRoot, "decoy-home-"));
  const saved = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };
  process.env["HOME"] = decoy;
  process.env["USERPROFILE"] = decoy;
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return decoy;
}

describe("the suite's runtime roots", () => {
  const runRoot = process.env["STRADA_VITEST_TMP_ROOT"];

  it("has a per-run temp root to resolve into", () => {
    expect(runRoot, "global setup did not run").toBeTruthy();
  });

  it("does not treat the checkout as a source-checkout config root", () => {
    const paths = resolveRuntimePaths({ moduleUrl: configModule });
    expect(paths.sourceCheckout).toBe(false);
    expect(isInside(runRoot!, paths.configRoot), `config root ${paths.configRoot}`).toBe(true);
    expect(isInside(repoRoot, paths.configRoot), `config root ${paths.configRoot}`).toBe(false);
  });

  it("reads and writes the .env inside the run's temp root, not the developer's", () => {
    for (const moduleUrl of [configModule, setupWizardModule]) {
      const envPath = resolveDotenvPath({ moduleUrl });
      expect(isInside(runRoot!, envPath), `${moduleUrl} -> ${envPath}`).toBe(true);
    }
  });

  it("takes install locks and keeps the app home inside the run's temp root", () => {
    const paths = resolveRuntimePaths({ moduleUrl: configModule });
    const updateLock = installLockPath(paths.configRoot, paths.installRoot, "update");
    const runtimeLock = installLockPath(paths.configRoot, paths.installRoot, "runtime");
    expect(isInside(runRoot!, updateLock), updateLock).toBe(true);
    expect(isInside(runRoot!, runtimeLock), runtimeLock).toBe(true);
    expect(isInside(runRoot!, resolveStradaHome()), resolveStradaHome()).toBe(true);
  });

  it("gives each worker its own home, so parallel test files share nothing through it", () => {
    const home = resolveStradaHome();
    expect(isInside(join(runRoot!, "strada-home"), home), home).toBe(true);
    expect(basename(home)).toBe(`worker-${process.env["VITEST_POOL_ID"]}`);
  });

  it("opens the default memory and model-intelligence databases inside the worker's home, not the checkout", () => {
    // Both default to RELATIVE paths. The runtime chdirs to its config root
    // before it opens them; a worker stands in the checkout, so any test that
    // built a stage from the defaults opened <repo>/.strada-memory/*.db.
    const home = resolveStradaHome();
    const config = loadConfig({ ...process.env, UNITY_PROJECT_PATH: runRoot!, ANTHROPIC_API_KEY: "sk-test-key-123" });
    for (const dbPath of [
      config.memory.dbPath,
      config.modelIntelligence.dbPath,
      // ProviderManager's and the model catalog's fallback when given no path.
      resolveProviderModelCatalogPath(),
    ]) {
      expect(isInside(home, resolve(dbPath)), `${dbPath} resolves outside ${home}`).toBe(true);
    }
  });

  it("toggles a skill in the app home, never in the user's own ~/.strada", async () => {
    // The dashboard's POST /api/skills/:id/enable|disable end here. Measured
    // 2026-10-11: every run rewrote the developer's real ~/.strada/skills.json.
    const decoy = await inDecoyHome(runRoot!, () => setSkillEnabled("hermetic-roots-probe", false));
    expect(readdirSync(decoy), `skills.json written under the user's home ${decoy}`).toEqual([]);
    const written = join(resolveStradaHome(), "skills.json");
    expect(JSON.parse(readFileSync(written, "utf8")).entries["hermetic-roots-probe"]).toEqual({ enabled: false });
  });

  it("takes the supervisor-death marker from the run's config root, never the checkout's", () => {
    // The default was process.cwd(); a worker stands in the checkout, so the
    // boot-report tests read and DELETED the live daemon's marker there.
    const marker = join(resolveRuntimePaths().configRoot, ".strada", "supervisor-dead.json");
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ at: "2026-10-11T00:00:00.000Z", restarts: 0, maxRestarts: 0, lastExit: { code: 1, signal: null } }));
    const warning = takeSupervisorDeathMarker();
    expect(warning, `no marker found at ${marker}`).not.toBeNull();
    expect(warning).toContain("The supervisor gave up before this boot");
    expect(existsSync(marker), marker).toBe(false);
  });

  it("does not inherit a launcher's or daemon's process markers", () => {
    // STRADA_DAEMON=1 alone flips AutoUpdater.isDaemonProcess for every
    // updater a test builds without its own answer; STRADA_LAUNCH_CWD moves
    // the cwd a relative STRADA_HOME resolves against.
    for (const key of LAUNCHER_ENV) {
      expect(process.env[key], key).toBeUndefined();
    }
  });
});
