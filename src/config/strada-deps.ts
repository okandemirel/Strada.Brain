/**
 * Strada Framework Dependency Validation
 *
 * Checks Unity project Packages/ directory for strada.core (required)
 * and strada.modules (optional). Never throws — returns status for
 * the Orchestrator to decide how to handle.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { ok, err } from "../types/index.js";
import type { Result } from "../types/index.js";

export interface StradaDepsStatus {
  readonly coreInstalled: boolean;
  readonly corePath: string | null;
  readonly modulesInstalled: boolean;
  readonly modulesPath: string | null;
  readonly warnings: string[];
}

const CORE_NAMES = ["strada.core", "com.strada.core", "Strada.Core"] as const;
const MODULES_NAMES = ["strada.modules", "com.strada.modules", "Strada.Modules"] as const;

const REPO_URLS = {
  core: process.env["STRADA_CORE_REPO_URL"] || "https://github.com/okandemirel/Strada.Core.git",
  modules:
    process.env["STRADA_MODULES_REPO_URL"] || "https://github.com/okandemirel/Strada.Modules.git",
} as const;

const TARGET_PATHS = {
  core: "Packages/strada.core",
  modules: "Packages/strada.modules",
} as const;

/**
 * Check if Strada dependencies are installed in the Unity project.
 * Never throws — returns a status object.
 */
export function checkStradaDeps(unityProjectPath: string): StradaDepsStatus {
  const warnings: string[] = [];
  const packagesDir = join(unityProjectPath, "Packages");

  if (!existsSync(packagesDir) || !statSync(packagesDir).isDirectory()) {
    warnings.push("Packages/ directory not found in Unity project");
    return {
      coreInstalled: false,
      corePath: null,
      modulesInstalled: false,
      modulesPath: null,
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

  return {
    coreInstalled: corePath !== null || coreInManifest,
    corePath: corePath,
    modulesInstalled: modulesPath !== null || modulesInManifest,
    modulesPath: modulesPath,
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
): Promise<Result<string, string>> {
  if (!isGitRepo(unityProjectPath)) {
    return err("Project is not a git repository. Cannot add submodule.");
  }

  const repoUrl = REPO_URLS[pkg];
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

function findPackage(packagesDir: string, names: readonly string[]): string | null {
  for (const name of names) {
    const candidate = join(packagesDir, name);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
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
