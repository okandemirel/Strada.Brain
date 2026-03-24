/**
 * Version Tagger
 *
 * Discovers installed Strada packages and extracts version metadata
 * for tagging documentation embeddings.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StradaDepsStatus } from "../../config/strada-deps.js";
import type { PackageRoot } from "./doc-rag.interface.js";

/**
 * Discover installed framework packages and their versions.
 */
export function discoverPackageRoots(stradaDeps: StradaDepsStatus): PackageRoot[] {
  const roots: PackageRoot[] = [];

  if (stradaDeps.coreInstalled && stradaDeps.corePath) {
    roots.push({
      name: "strada.core",
      path: stradaDeps.corePath,
      version: readPackageVersion(stradaDeps.corePath) ?? "0.0.0",
    });
  }

  if (stradaDeps.modulesInstalled && stradaDeps.modulesPath) {
    roots.push({
      name: "strada.modules",
      path: stradaDeps.modulesPath,
      version: readPackageVersion(stradaDeps.modulesPath) ?? "0.0.0",
    });
  }

  if (stradaDeps.mcpInstalled && stradaDeps.mcpPath) {
    roots.push({
      name: "strada.mcp",
      path: stradaDeps.mcpPath,
      version: stradaDeps.mcpVersion ?? readPackageVersion(stradaDeps.mcpPath) ?? "0.0.0",
    });
  }

  return roots;
}

/**
 * Read package version from package.json at root.
 * Works for both npm packages and Unity Package Manager packages.
 */
export function readPackageVersion(packagePath: string): string | null {
  const packageJsonPath = join(packagePath, "package.json");
  if (!existsSync(packageJsonPath)) return null;

  try {
    const content = readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if a package version has changed compared to a stored version.
 */
export function hasVersionChanged(
  current: PackageRoot,
  storedVersion: string | null,
): boolean {
  if (!storedVersion) return true;
  return current.version !== storedVersion;
}
