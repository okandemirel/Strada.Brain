import { existsSync, mkdirSync } from "node:fs";
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

export function resolveInstallRoot(moduleUrl: string = import.meta.url): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return path.resolve(moduleDir, "..", "..");
}

export function resolveStradaHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  cwd: string = process.cwd(),
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

export function resolveRuntimePaths(options: RuntimePathOptions = {}): RuntimePaths {
  const env = options.env ?? process.env;
  const installRoot = options.installRoot
    ?? env["STRADA_INSTALL_ROOT"]
    ?? resolveInstallRoot(options.moduleUrl);
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const sourceCheckout = options.sourceCheckout
    ?? (env["STRADA_SOURCE_CHECKOUT"] === "true"
      ? true
      : existsSync(path.join(installRoot, ".git")));
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

  if (!runtimePaths.sourceCheckout) {
    mkdirSync(runtimePaths.configRoot, { recursive: true });
    if (process.cwd() !== runtimePaths.configRoot) {
      process.chdir(runtimePaths.configRoot);
    }
  }

  return runtimePaths;
}
