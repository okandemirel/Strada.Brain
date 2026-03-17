/**
 * Strada Framework Dependency Validation
 *
 * Checks Unity project Packages/ directory for strada.core (required)
 * and strada.modules (optional). Never throws — returns status for
 * the Orchestrator to decide how to handle.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ok, err } from "../types/index.js";
import type { Result } from "../types/index.js";
import {
  DEFAULT_STRADA_CORE_REPO_URL,
  DEFAULT_STRADA_MODULES_REPO_URL,
  type StradaDependencyConfig,
} from "./config.js";

export interface StradaDepsStatus {
  readonly coreInstalled: boolean;
  readonly corePath: string | null;
  readonly modulesInstalled: boolean;
  readonly modulesPath: string | null;
  readonly mcpInstalled: boolean;
  readonly mcpPath: string | null;
  readonly mcpVersion: string | null;
  readonly warnings: string[];
}

export interface StradaMcpInstall {
  readonly installed: boolean;
  readonly path: string | null;
  readonly version: string | null;
}

const CORE_NAMES = ["strada.core", "com.strada.core", "Strada.Core"] as const;
const MODULES_NAMES = ["strada.modules", "com.strada.modules", "Strada.Modules"] as const;
const STRADA_MCP_PACKAGE_NAME = "strada-mcp";
const DEFAULT_STRADA_DEPENDENCY_CONFIG: StradaDependencyConfig = {
  coreRepoUrl: DEFAULT_STRADA_CORE_REPO_URL,
  modulesRepoUrl: DEFAULT_STRADA_MODULES_REPO_URL,
};

const TARGET_PATHS = {
  core: "Packages/strada.core",
  modules: "Packages/strada.modules",
} as const;

function resolveStradaDependencyConfig(
  config?: Partial<StradaDependencyConfig>,
): StradaDependencyConfig {
  const mcpPath = config?.mcpPath?.trim();
  return {
    coreRepoUrl: config?.coreRepoUrl ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.coreRepoUrl,
    modulesRepoUrl: config?.modulesRepoUrl ?? DEFAULT_STRADA_DEPENDENCY_CONFIG.modulesRepoUrl,
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
    const mcp = detectStradaMcp(resolvedConfig);
    return {
      coreInstalled: false,
      corePath: null,
      modulesInstalled: false,
      modulesPath: null,
      mcpInstalled: mcp.installed,
      mcpPath: mcp.path,
      mcpVersion: mcp.version,
      warnings,
    };
  }

  const corePath = findPackage(packagesDir, CORE_NAMES);
  const modulesPath = findPackage(packagesDir, MODULES_NAMES);

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
  const mcp = detectStradaMcp(resolvedConfig);

  return {
    coreInstalled: corePath !== null || coreInManifest,
    corePath,
    modulesInstalled: modulesPath !== null || modulesInManifest,
    modulesPath,
    mcpInstalled: mcp.installed,
    mcpPath: mcp.path,
    mcpVersion: mcp.version,
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

/**
 * Detect Strada.MCP installation.
 * Checks: 1) configured STRADA_MCP_PATH
 *         2) sibling directory ../Strada.MCP relative to project root
 *         3) global npm install via `which strada-mcp`
 */
export function detectStradaMcp(config?: Partial<StradaDependencyConfig>): StradaMcpInstall {
  const resolvedConfig = resolveStradaDependencyConfig(config);
  if (resolvedConfig.mcpPath) {
    const configuredInstall = readStradaMcpInstall(resolvedConfig.mcpPath);
    if (configuredInstall) {
      return configuredInstall;
    }
  }

  // 1. Check sibling directory relative to Strada.Brain project root
  const brainRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const siblingPath = join(brainRoot, "..", "Strada.MCP");
  const siblingInstall = readStradaMcpInstall(siblingPath);
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
      const globalInstall = readStradaMcpInstall(globalPkgPath);
      if (globalInstall) {
        return globalInstall;
      }
    }
  } catch {
    // `which` failed — strada-mcp not on PATH
  }

  return { installed: false, path: null, version: null };
}

function readStradaMcpInstall(candidatePath: string): StradaMcpInstall | null {
  const packageJsonPath = join(candidatePath, "package.json");
  const metadata = readPackageMetadata(packageJsonPath);
  if (!metadata || metadata.name !== STRADA_MCP_PACKAGE_NAME) {
    return null;
  }

  return {
    installed: true,
    path: candidatePath,
    version: metadata.version ?? null,
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
  return existsSync(join(dir, ".git"));
}
