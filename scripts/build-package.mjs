import { cpSync, rmSync } from "node:fs";
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
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(resolveCommandBinary("tsc"), []);

const portalBuild = spawnSync(resolveCommandBinary("npm"), ["run", "build:portal"], {
  cwd: ROOT_DIR,
  stdio: "inherit",
});

if (portalBuild.status === 0) {
  try {
    rmSync(WEB_STATIC_DIR, { recursive: true, force: true });
    cpSync(PORTAL_DIST_DIR, WEB_STATIC_DIR, { recursive: true });
  } catch {
    console.log("[strada] Portal build skipped — web UI will use fallback page.");
  }
} else {
  console.log("[strada] Portal build skipped — web UI will use fallback page.");
}
