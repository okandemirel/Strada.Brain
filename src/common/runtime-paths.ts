import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimePaths {
  installRoot: string;
  configRoot: string;
  sourceCheckout: boolean;
}

export interface RuntimePathOptions {
  moduleUrl?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  installRoot?: string;
  sourceCheckout?: boolean;
}

export function getSafeCurrentWorkingDirectory(fallback: string): string {
  try {
    return process.cwd();
  } catch {
    return fallback;
  }
}

export function resolveLaunchCwd(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const configured = env["STRADA_LAUNCH_CWD"]?.trim();
  if (configured) {
    return configured;
  }
  return getSafeCurrentWorkingDirectory(homeDir);
}

const PACKAGE_NAME = "strada-brain";
const installRootCache = new Map<string, string>();

function isStradaPackageRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown };
    return pkg.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * The package root that contains `moduleUrl`: the nearest ancestor whose
 * package.json names this package. It used to be "two directories up",
 * which is right only for a module exactly two levels deep: src/index.ts
 * resolved to the repository's PARENT and bootstrap-stages to `src/`, so
 * index.ts, config.ts and the daemon disagreed on where `.env` and the
 * runtime root live whenever the launcher's STRADA_INSTALL_ROOT was absent.
 * The old answer stays as the fallback for a layout with no package.json.
 */
export function resolveInstallRoot(moduleUrl: string = import.meta.url): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const cached = installRootCache.get(moduleDir);
  if (cached !== undefined) return cached;
  let root = path.resolve(moduleDir, "..", "..");
  for (let dir = moduleDir; ; dir = path.dirname(dir)) {
    if (isStradaPackageRoot(dir)) {
      root = dir;
      break;
    }
    if (path.dirname(dir) === dir) break;
  }
  installRootCache.set(moduleDir, root);
  return root;
}

export function resolveStradaHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  cwd: string = resolveLaunchCwd(env, homeDir),
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env["STRADA_HOME"]?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);
  }
  if (platform === "win32") {
    return path.join(env["LOCALAPPDATA"] || path.join(homeDir, "AppData", "Local"), "Strada");
  }
  return path.join(homeDir, ".strada");
}

/** What STRADA_SOURCE_CHECKOUT says, or undefined when it says nothing. */
function explicitSourceCheckout(env: NodeJS.ProcessEnv): boolean | undefined {
  const raw = env["STRADA_SOURCE_CHECKOUT"]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  // A value nobody can read is not an instruction: probe, as before.
  return undefined;
}

export function resolveRuntimePaths(options: RuntimePathOptions = {}): RuntimePaths {
  const env = options.env ?? process.env;
  const installRoot = options.installRoot
    ?? env["STRADA_INSTALL_ROOT"]
    ?? resolveInstallRoot(options.moduleUrl);
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? resolveLaunchCwd(env, homeDir);
  // STRADA_SOURCE_CHECKOUT IS THREE-STATE. It used to mean "true forces on,
  // anything else probes for .git" — so `false` silently did nothing and a
  // process running inside this repository ALWAYS took the repository as its
  // config root. A test or a first-run rehearsal could therefore redirect HOME
  // and still read — and write — the developer's own `.env`.
  const sourceCheckout = options.sourceCheckout ?? explicitSourceCheckout(env) ?? existsSync(path.join(installRoot, ".git"));
  const configRoot = sourceCheckout ? installRoot : resolveStradaHome(env, homeDir, cwd, platform);

  return {
    installRoot,
    configRoot,
    sourceCheckout,
  };
}

export function resolveDotenvPath(options: RuntimePathOptions = {}): string {
  return path.join(resolveRuntimePaths(options).configRoot, ".env");
}

export function initializeRuntimeEnvironment(options: RuntimePathOptions = {}): RuntimePaths {
  const runtimePaths = resolveRuntimePaths(options);
  const launchCwd = getSafeCurrentWorkingDirectory(runtimePaths.configRoot);

  if (runtimePaths.sourceCheckout && !existsSync(runtimePaths.configRoot)) {
    throw new Error(`Source checkout runtime root does not exist: ${runtimePaths.configRoot}`);
  }

  if (!runtimePaths.sourceCheckout) {
    mkdirSync(runtimePaths.configRoot, { recursive: true });
  }

  if (launchCwd !== runtimePaths.configRoot) {
    process.chdir(runtimePaths.configRoot);
  }

  return runtimePaths;
}
