/**
 * Strada Framework Dependency Validation
 *
 * Checks Unity project Packages/ directory for strada.core (required)
 * and strada.modules (optional). Never throws — returns status for
 * the Orchestrator to decide how to handle.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ok, err } from "../types/index.js";
import type { Result } from "../types/index.js";
import {
  DEFAULT_STRADA_CORE_REPO_URL,
  DEFAULT_STRADA_MCP_REPO_URL,
  DEFAULT_STRADA_MODULES_REPO_URL,
  type StradaDependencyConfig,
} from "./config.js";

export interface StradaDepsStatus {
  readonly coreInstalled: boolean;
  readonly corePath: string | null;
  readonly coreVersion?: string | null;
  readonly coreSource?: StradaDepInstallSource | null;
  readonly modulesInstalled: boolean;
  readonly modulesPath: string | null;
  readonly modulesVersion?: string | null;
  readonly modulesSource?: StradaDepInstallSource | null;
  readonly mcpInstalled: boolean;
  readonly mcpPath: string | null;
  readonly mcpVersion: string | null;
  readonly mcpSource?: StradaDepInstallSource | null;
  readonly warnings: string[];
}

export type StradaDepInstallSource =
  | "package-directory"
  | "manifest"
  | "project-local"
  | "configured-path"
  | "sibling-checkout"
  | "global-install";

export interface McpRecommendation {
  readonly recommended: boolean;
  readonly reason: string;
  readonly featureList: string[];
  readonly discoveryHint?: string;
  readonly installHint?: string;
}

export type McpInstallTarget = "assets" | "packages";

export interface StradaMcpInstallPlan {
  readonly target: McpInstallTarget;
  readonly submodulePath: string;
  readonly unityPackagePath: string;
  readonly manifestPath: string;
  readonly manifestDependency: string;
  readonly npmInstallRan: boolean;
}

export interface StradaMcpInstall {
  readonly installed: boolean;
  readonly path: string | null;
  readonly version: string | null;
  readonly source?: StradaDepInstallSource | null;
}

const CORE_NAMES = ["strada.core", "com.strada.core", "Strada.Core"] as const;
const MODULES_NAMES = ["strada.modules", "com.strada.modules", "Strada.Modules"] as const;
const STRADA_MCP_PACKAGE_NAME = "strada-mcp";
const DEFAULT_STRADA_DEPENDENCY_CONFIG: StradaDependencyConfig = {
  coreRepoUrl: DEFAULT_STRADA_CORE_REPO_URL,
  modulesRepoUrl: DEFAULT_STRADA_MODULES_REPO_URL,
  mcpRepoUrl: DEFAULT_STRADA_MCP_REPO_URL,
  unityBridgePort: 7691,
  unityBridgeAutoConnect: true,
  unityBridgeTimeout: 5000,
  scriptExecuteEnabled: false,
  reflectionInvokeEnabled: false,
};

const TARGET_PATHS = {
  core: "Packages/strada.core",
  modules: "Packages/strada.modules",
} as const;
const MCP_SUBMODULE_TARGETS: Record<McpInstallTarget, string> = {
  packages: "Packages/Submodules/Strada.MCP",
  assets: "Assets/Strada.MCP",
};
const MCP_MANIFEST_REFERENCES: Record<McpInstallTarget, string> = {
  packages: "file:Submodules/Strada.MCP/unity-package/com.strada.mcp",
  assets: "file:../Assets/Strada.MCP/unity-package/com.strada.mcp",
};
const MCP_PROJECT_LOCAL_CANDIDATES = [
  MCP_SUBMODULE_TARGETS.packages,
  MCP_SUBMODULE_TARGETS.assets,
  "Packages/Strada.MCP",
  "Assets/Strada.MCP",
] as const;
const MCP_FEATURE_LIST = [
  "Live Unity console reading and error analysis",
  "Unity editor command execution and menu actions",
  "Scene, prefab, GameObject, and component operations",
  "Project, player, quality, build settings, and editor preferences control",
  "Unity Package Manager operations across registry, git, local, and supported asset imports",
  "Multi-platform Unity builds for Android, iOS, WebGL, and standalone targets",
] as const;

function resolveStradaDependencyConfig(
  config?: Partial<StradaDependencyConfig>,
): StradaDependencyConfig {
  const mcpPath = config?.mcpPath?.trim();
  return {
    coreRepoUrl: config?.coreRepoUrl ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.coreRepoUrl,
    modulesRepoUrl: config?.modulesRepoUrl ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.modulesRepoUrl,
    unityBridgePort: config?.unityBridgePort ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.unityBridgePort,
    unityBridgeAutoConnect: config?.unityBridgeAutoConnect ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.unityBridgeAutoConnect,
    unityBridgeTimeout: config?.unityBridgeTimeout ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.unityBridgeTimeout,
    unityEditorPath: config?.unityEditorPath,
    scriptExecuteEnabled: config?.scriptExecuteEnabled ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.scriptExecuteEnabled,
    reflectionInvokeEnabled: config?.reflectionInvokeEnabled ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.reflectionInvokeEnabled,
    mcpRepoUrl: config?.mcpRepoUrl ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.mcpRepoUrl,
    ...(mcpPath ? { mcpPath } : {}),
  };
}

/**
 * Check if Strada dependencies are installed in the Unity project.
 * Never throws — returns a status object.
 */
export function checkStradaDeps(
  unityProjectPath: string,
  config?: Partial<StradaDependencyConfig>,
): StradaDepsStatus {
  const resolvedConfig = resolveStradaDependencyConfig(config);
  const warnings: string[] = [];
  const packagesDir = join(unityProjectPath, "Packages");
  const configuredMcpPath = resolvedConfig.mcpPath;

  let packagesExists = false;
  try { packagesExists = existsSync(packagesDir) && statSync(packagesDir).isDirectory(); } catch { /* TOCTOU safe */ }
  if (!packagesExists) {
    warnings.push("Packages/ directory not found in Unity project");
    if (configuredMcpPath && !readStradaMcpInstall(configuredMcpPath)) {
      warnings.push("Configured STRADA_MCP_PATH is not a valid Strada.MCP package root");
    }
    const mcp = detectStradaMcp(resolvedConfig, unityProjectPath);
    return {
      coreInstalled: false,
      corePath: null,
      coreVersion: null,
      coreSource: null,
      modulesInstalled: false,
      modulesPath: null,
      modulesVersion: null,
      modulesSource: null,
      mcpInstalled: mcp.installed,
      mcpPath: mcp.path,
      mcpVersion: mcp.version,
      mcpSource: mcp.source ?? null,
      warnings,
    };
  }

  const corePath = findPackage(packagesDir, CORE_NAMES);
  const modulesPath = findPackage(packagesDir, MODULES_NAMES);
  const coreVersion = corePath ? readPackageVersion(corePath) : null;
  const modulesVersion = modulesPath ? readPackageVersion(modulesPath) : null;

  // Fallback: check manifest.json
  const coreInManifest = !corePath && checkManifest(packagesDir, CORE_NAMES);
  const modulesInManifest = !modulesPath && checkManifest(packagesDir, MODULES_NAMES);

  if (!corePath && !coreInManifest) {
    warnings.push(
      `Strada.Core not found. Searched: ${CORE_NAMES.join(", ")} in Packages/ and manifest.json`,
    );
  }

  if (!modulesPath && !modulesInManifest) {
    warnings.push(
      "Strada.Modules not installed (optional). Module-specific APIs will not be available.",
    );
  }

  // Detect Strada.MCP (Node.js tool, not a Unity package)
  if (configuredMcpPath && !readStradaMcpInstall(configuredMcpPath)) {
    warnings.push("Configured STRADA_MCP_PATH is not a valid Strada.MCP package root");
  }
  const mcp = detectStradaMcp(resolvedConfig, unityProjectPath);

  return {
    coreInstalled: corePath !== null || coreInManifest,
    corePath,
    coreVersion,
    coreSource: corePath ? "package-directory" : coreInManifest ? "manifest" : null,
    modulesInstalled: modulesPath !== null || modulesInManifest,
    modulesPath,
    modulesVersion,
    modulesSource: modulesPath ? "package-directory" : modulesInManifest ? "manifest" : null,
    mcpInstalled: mcp.installed,
    mcpPath: mcp.path,
    mcpVersion: mcp.version,
    mcpSource: mcp.source ?? null,
    warnings,
  };
}

/**
 * Install a Strada package as a git submodule.
 * Requires the Unity project to be a git repository.
 */
export async function installStradaDep(
  unityProjectPath: string,
  pkg: "core" | "modules",
  config?: Partial<StradaDependencyConfig>,
): Promise<Result<string, string>> {
  if (!isGitRepo(unityProjectPath)) {
    return err("Project is not a git repository. Cannot add submodule.");
  }

  const resolvedConfig = resolveStradaDependencyConfig(config);
  const repoUrl = pkg === "core" ? resolvedConfig.coreRepoUrl : resolvedConfig.modulesRepoUrl;
  const targetPath = TARGET_PATHS[pkg];
  const fullTargetPath = join(unityProjectPath, targetPath);

  return new Promise((resolve) => {
    execFile(
      "git",
      ["submodule", "add", repoUrl, targetPath],
      { cwd: unityProjectPath },
      (error, _stdout, stderr) => {
        if (error) {
          resolve(err(stderr || error.message));
        } else {
          resolve(ok(fullTargetPath));
        }
      },
    );
  });
}

export async function installStradaMcpSubmodule(
  unityProjectPath: string,
  target: McpInstallTarget,
  config?: Partial<StradaDependencyConfig>,
): Promise<Result<StradaMcpInstallPlan, string>> {
  if (!isGitRepo(unityProjectPath)) {
    return err("Project is not a git repository. Cannot add Strada.MCP as a submodule.");
  }

  const resolvedConfig = resolveStradaDependencyConfig(config);
  const submodulePath = MCP_SUBMODULE_TARGETS[target];
  const manifestDependency = MCP_MANIFEST_REFERENCES[target];
  const fullSubmodulePath = join(unityProjectPath, submodulePath);
  const fullManifestPath = join(unityProjectPath, "Packages", "manifest.json");
  const unityPackagePath = join(fullSubmodulePath, "unity-package", "com.strada.mcp");

  if (existsSync(fullSubmodulePath)) {
    return err(`Target path already exists: ${fullSubmodulePath}`);
  }
  if (!existsSync(fullManifestPath)) {
    return err("Packages/manifest.json not found in Unity project.");
  }

  try {
    await runExecFile("git", ["submodule", "add", resolvedConfig.mcpRepoUrl, submodulePath], unityProjectPath);
  } catch (error) {
    return err(`Failed to add Strada.MCP submodule: ${formatExecError(error)}`);
  }

  try {
    updateUnityManifestDependency(fullManifestPath, "com.strada.mcp", manifestDependency);
  } catch (error) {
    return err(`Strada.MCP submodule was added, but Packages/manifest.json could not be updated: ${formatExecError(error)}`);
  }

  try {
    await runExecFile("npm", ["install", "--no-fund", "--no-audit"], fullSubmodulePath);
  } catch (error) {
    return err(`Strada.MCP submodule was added and manifest updated, but npm install failed: ${formatExecError(error)}`);
  }

  return ok({
    target,
    submodulePath: fullSubmodulePath,
    unityPackagePath,
    manifestPath: fullManifestPath,
    manifestDependency,
    npmInstallRan: true,
  });
}

/**
 * Detect Strada.MCP installation.
 * Checks: 1) configured STRADA_MCP_PATH
 *         2) sibling directory ../Strada.MCP relative to project root
 *         3) global npm install via `which strada-mcp`
 */
export function detectStradaMcp(
  config?: Partial<StradaDependencyConfig>,
  unityProjectPath?: string,
): StradaMcpInstall {
  const resolvedConfig = resolveStradaDependencyConfig(config);
  if (resolvedConfig.mcpPath) {
    const configuredInstall = readStradaMcpInstall(resolvedConfig.mcpPath, "configured-path");
    if (configuredInstall) {
      return configuredInstall;
    }
  }

  if (unityProjectPath) {
    const projectInstall = readProjectLocalStradaMcpInstall(unityProjectPath);
    if (projectInstall) {
      return projectInstall;
    }
  }

  // 1. Check sibling directory relative to Strada.Brain project root
  const brainRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const siblingPath = join(brainRoot, "..", "Strada.MCP");
  const siblingInstall = readStradaMcpInstall(siblingPath, "sibling-checkout");
  if (siblingInstall) {
    return siblingInstall;
  }

  // 2. Check global npm install
  try {
    const which = execFileSync("which", ["strada-mcp"], {
      encoding: "utf-8",
      timeout: 3000,
    }).trim().replace(/[\r\n]/g, "");
    if (which) {
      const binDir = dirname(which);
      const globalPkgPath = join(binDir, "..", "lib", "node_modules", "strada-mcp");
      const globalInstall = readStradaMcpInstall(globalPkgPath, "global-install");
      if (globalInstall) {
        return globalInstall;
      }
    }
  } catch {
    // `which` failed — strada-mcp not on PATH
  }

  return { installed: false, path: null, version: null, source: null };
}

export function buildMcpRecommendation(
  status: StradaDepsStatus,
  config?: Partial<StradaDependencyConfig>,
): McpRecommendation {
  const discoveryHint = config?.mcpPath
    ? (status.mcpInstalled
        ? `STRADA_MCP_PATH is set and resolves to ${status.mcpPath}.`
        : `STRADA_MCP_PATH is set to ${config.mcpPath}, but that location is not a valid Strada.MCP package root. Brain also auto-detects a sibling ../Strada.MCP checkout when present.`)
    : (status.mcpInstalled
        ? (status.mcpPath?.includes("/Strada.MCP")
            ? `Strada.MCP was auto-detected at ${status.mcpPath}.`
            : `Strada.MCP was detected at ${status.mcpPath}.`)
        : "Brain will auto-detect a sibling ../Strada.MCP checkout or honor STRADA_MCP_PATH when provided.");

  if (status.mcpInstalled) {
    return {
      recommended: false,
      reason: `Strada.MCP is installed${status.mcpVersion ? ` (v${status.mcpVersion})` : ""}.`,
      featureList: [...MCP_FEATURE_LIST],
      discoveryHint,
    };
  }

  return {
    recommended: true,
    reason: "Strada.MCP is not installed. Installing it unlocks the live Unity runtime surface inside Strada.Brain.",
    featureList: [...MCP_FEATURE_LIST],
    discoveryHint,
    installHint: "Install Strada.MCP as a git submodule, wire com.strada.mcp into Packages/manifest.json, and bootstrap the checkout with npm install so Brain can load the runtime.",
  };
}

function readProjectLocalStradaMcpInstall(unityProjectPath: string): StradaMcpInstall | null {
  for (const relativePath of MCP_PROJECT_LOCAL_CANDIDATES) {
    const candidate = join(unityProjectPath, relativePath);
    const install = readStradaMcpInstall(candidate, "project-local");
    if (install) {
      return install;
    }
  }

  return null;
}

function readStradaMcpInstall(
  candidatePath: string,
  source?: StradaDepInstallSource,
): StradaMcpInstall | null {
  const packageJsonPath = join(candidatePath, "package.json");
  const metadata = readPackageMetadata(packageJsonPath);
  if (!metadata || metadata.name !== STRADA_MCP_PACKAGE_NAME) {
    return null;
  }

  return {
    installed: true,
    path: candidatePath,
    version: metadata.version ?? null,
    source: source ?? null,
  };
}

function readPackageMetadata(packageJsonPath: string): { name?: string; version?: string } | null {
  try {
    const content = readFileSync(packageJsonPath, "utf-8");
    return JSON.parse(content) as { name?: string; version?: string };
  } catch {
    return null;
  }
}

function readPackageVersion(packagePath: string): string | null {
  return readPackageMetadata(join(packagePath, "package.json"))?.version ?? null;
}

function findPackage(packagesDir: string, names: readonly string[]): string | null {
  for (const name of names) {
    const candidate = join(packagesDir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch { /* TOCTOU: directory removed between existsSync and statSync */ }
  }
  return null;
}

function checkManifest(packagesDir: string, names: readonly string[]): boolean {
  const manifestPath = join(packagesDir, "manifest.json");
  if (!existsSync(manifestPath)) return false;

  try {
    const content = readFileSync(manifestPath, "utf-8");
    const lowerContent = content.toLowerCase();
    return names.some((name) => lowerContent.includes(name.toLowerCase()));
  } catch {
    return false;
  }
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function updateUnityManifestDependency(
  manifestPath: string,
  dependencyName: string,
  dependencyValue: string,
): void {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    dependencies?: Record<string, string>;
    [key: string]: unknown;
  };
  const dependencies = { ...(parsed.dependencies ?? {}) };
  dependencies[dependencyName] = dependencyValue;
  const next = {
    ...parsed,
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
}

function runExecFile(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve();
    });
  });
}

function formatExecError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
