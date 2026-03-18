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
): string {
  const configured = env["STRADA_HOME"]?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);
  }
  return path.join(homeDir, ".strada");
}

export function resolveRuntimePaths(options: RuntimePathOptions = {}): RuntimePaths {
  const installRoot = options.installRoot ?? resolveInstallRoot(options.moduleUrl);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const sourceCheckout = options.sourceCheckout ?? existsSync(path.join(installRoot, ".git"));
  const configRoot = sourceCheckout ? cwd : resolveStradaHome(env, homeDir, cwd);

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
