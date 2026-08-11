import { cpSync, rmSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const WEB_STATIC_DIR = path.join(ROOT_DIR, "dist", "channels", "web", "static");
const PORTAL_DIST_DIR = path.join(ROOT_DIR, "web-portal", "dist");
const isWindows = process.platform === "win32";

function resolveCommandBinary(command) {
  return isWindows ? `${command}.cmd` : command;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    shell: isWindows,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// `--portal-only` skips the backend tsc build — used by the launcher's
// stale-portal rebuild, where the backend already runs from source (tsx) and
// only the served web bundle needs refreshing.
const portalOnly = process.argv.includes("--portal-only");
/**
 * Copy every non-TypeScript file from `src/` into `dist/`, preserving layout.
 *
 * `tsc` emits only `.js`/`.d.ts`, so any asset a module loads at runtime is
 * silently absent from the published package. That is not hypothetical: the
 * shipped tarball was missing `vault/schema.sql` (SqliteVaultStore reads it via
 * `join(__dirname, 'schema.sql')`, so the whole Codebase Memory Vault failed to
 * initialize), all seven bundled `SKILL.md` files under `skills/bundled`, and
 * `agents/providers/provider-sources.json`.
 *
 * The rule is deliberately broad — every non-`.ts` file is treated as a runtime
 * asset — so a future asset cannot go missing by being forgotten here.
 */
function copyRuntimeAssets(srcDir, outDir) {
  let copied = 0;
  for (const entry of readdirSync(srcDir)) {
    const from = path.join(srcDir, entry);
    const to = path.join(outDir, entry);
    if (statSync(from).isDirectory()) {
      copied += copyRuntimeAssets(from, to);
      continue;
    }
    // Skip TypeScript sources (tsc emits those) and test fixtures.
    if (/\.(ts|tsx)$/.test(entry)) continue;
    mkdirSync(outDir, { recursive: true });
    copyFileSync(from, to);
    copied++;
  }
  return copied;
}

if (!portalOnly) {
  run(resolveCommandBinary("tsc"), []);
  const assetCount = copyRuntimeAssets(
    path.join(ROOT_DIR, "src"),
    path.join(ROOT_DIR, "dist"),
  );
  console.log(`[strada] Copied ${assetCount} runtime asset(s) from src/ to dist/.`);
}

const portalBuild = spawnSync(resolveCommandBinary("npm"), ["run", "build:portal"], {
  cwd: ROOT_DIR,
  stdio: "inherit",
  shell: isWindows,
});

if (portalBuild.status === 0) {
  try {
    rmSync(WEB_STATIC_DIR, { recursive: true, force: true });
    cpSync(PORTAL_DIST_DIR, WEB_STATIC_DIR, { recursive: true });
  } catch {
    console.log("[strada] Portal build skipped — web UI will use fallback page.");
  }
} else if (portalOnly) {
  // The launcher's stale-portal rebuild relies on this exit code — a portal
  // build failure must surface, not be silently swallowed into a stale UI.
  process.exit(portalBuild.status ?? 1);
} else if (process.env["STRADA_ALLOW_PORTAL_BUILD_FAILURE"] === "1") {
  // Explicit opt-out for backend-only builds (e.g. a CI job that never serves
  // the portal). Deliberate, and it says so in the log.
  console.log(
    "[strada] Portal build FAILED — continuing anyway because " +
      "STRADA_ALLOW_PORTAL_BUILD_FAILURE=1. The web UI will use the fallback page.",
  );
} else {
  // A failed portal build previously exited 0 here, so `npm run build` — and
  // therefore `prepack`, and therefore the published tarball and every Docker
  // image — silently shipped without a UI. Fail loudly instead; set
  // STRADA_ALLOW_PORTAL_BUILD_FAILURE=1 to opt out deliberately.
  console.error(
    "[strada] Portal build FAILED. Refusing to produce a package with a " +
      "missing web UI. Fix the portal build, or set " +
      "STRADA_ALLOW_PORTAL_BUILD_FAILURE=1 to build the backend only.",
  );
  process.exit(portalBuild.status ?? 1);
}
