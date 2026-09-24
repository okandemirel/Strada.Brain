import { cpSync, rmSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
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

/**
 * File types a module loads at runtime from next to its compiled `.js`.
 *
 * `tsc` emits only `.js`/`.d.ts`, so any asset a module reads at runtime is
 * silently absent from the published package unless it is copied. That is not
 * hypothetical: the shipped tarball was missing `vault/schema.sql`
 * (SqliteVaultStore reads it via `join(__dirname, 'schema.sql')`), all seven
 * bundled `SKILL.md` files under `skills/bundled`, and
 * `agents/providers/provider-sources.json`. The dashboard templates are
 * `.html` and `.js`.
 */
export const RUNTIME_ASSET_EXTENSIONS = new Set([".md", ".json", ".sql", ".html", ".js"]);

/**
 * The files git tracks under `srcDir`, as absolute paths, or null when there is
 * no git checkout to ask (a Docker build context has no .git) — then the
 * extension allowlist alone decides.
 */
export function listTrackedFiles(srcDir, rootDir = ROOT_DIR) {
  const result = spawnSync("git", ["ls-files", "-z", "--", path.relative(rootDir, srcDir) || "."], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return null;
  return new Set(result.stdout.split("\0").filter(Boolean).map((rel) => path.resolve(rootDir, rel)));
}

/** Directories whose contents are test code or test fixtures, never shipped. */
const TEST_DIRECTORIES = new Set(["tests", "__tests__", "test-support"]);

/**
 * True when `file` belongs in the package as a runtime asset.
 *
 * Every non-`.ts` file used to qualify, tracked or not, so a stray `.env`,
 * `.sqlite` or scratch file in a maintainer's working copy was published
 * (OPS-10). Now: an allowlisted extension, never a dotfile, and — in a git
 * checkout — tracked by git. (The walker also skips test directories.)
 */
export function isRuntimeAsset(file, tracked) {
  const name = path.basename(file);
  if (name.startsWith(".")) return false;
  if (!RUNTIME_ASSET_EXTENSIONS.has(path.extname(name).toLowerCase())) return false;
  return tracked ? tracked.has(path.resolve(file)) : true;
}

/** Copy the runtime assets under `srcDir` into `outDir`, preserving layout. */
export function copyRuntimeAssets(srcDir, outDir, tracked = listTrackedFiles(srcDir)) {
  let copied = 0;
  for (const entry of readdirSync(srcDir)) {
    const from = path.join(srcDir, entry);
    const to = path.join(outDir, entry);
    if (statSync(from).isDirectory()) {
      if (entry.startsWith(".") || TEST_DIRECTORIES.has(entry)) continue;
      copied += copyRuntimeAssets(from, to, tracked);
      continue;
    }
    if (!isRuntimeAsset(from, tracked)) continue;
    mkdirSync(outDir, { recursive: true });
    copyFileSync(from, to);
    copied++;
  }
  return copied;
}

function main() {
  // `--portal-only` skips the backend tsc build — used by the launcher's
  // stale-portal rebuild, where the backend already runs from source (tsx) and
  // only the served web bundle needs refreshing.
  const portalOnly = process.argv.includes("--portal-only");

  if (!portalOnly) {
    // Start from an empty dist/: tsc never removes the output of a deleted or
    // renamed source, so stale modules — and a bundled skill deleted from
    // src/skills/bundled, which the loader still found and loaded — shipped.
    rmSync(DIST_DIR, { recursive: true, force: true });
    run(resolveCommandBinary("tsc"), []);
    const assetCount = copyRuntimeAssets(
      path.join(ROOT_DIR, "src"),
      DIST_DIR,
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
}

function isDirectExecution() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  main();
}
