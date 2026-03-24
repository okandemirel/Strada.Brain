/**
 * Framework Package Configurations
 *
 * Static configuration for each Strada ecosystem package.
 * Repo URLs are sourced from the existing StradaDependencyConfig defaults.
 */

import {
  DEFAULT_STRADA_CORE_REPO_URL,
  DEFAULT_STRADA_MODULES_REPO_URL,
  DEFAULT_STRADA_MCP_REPO_URL,
} from "../../config/config.js";
import type { FrameworkPackageConfig, FrameworkPackageId } from "./framework-types.js";

export const CORE_PACKAGE_CONFIG: FrameworkPackageConfig = {
  packageId: "core",
  displayName: "Strada.Core",
  sourceLanguage: "csharp",
  fileGlob: "**/*.cs",
  ignoreGlobs: ["**/Tests/**", "**/bin/**", "**/obj/**"],
  repoUrl: DEFAULT_STRADA_CORE_REPO_URL,
  versionDetection: "package.json",
};

export const MODULES_PACKAGE_CONFIG: FrameworkPackageConfig = {
  packageId: "modules",
  displayName: "Strada.Modules",
  sourceLanguage: "csharp",
  fileGlob: "**/*.cs",
  ignoreGlobs: ["**/Tests/**", "**/bin/**", "**/obj/**", "**/Samples/**"],
  repoUrl: DEFAULT_STRADA_MODULES_REPO_URL,
  versionDetection: "package.json",
};

export const MCP_PACKAGE_CONFIG: FrameworkPackageConfig = {
  packageId: "mcp",
  displayName: "Strada.MCP",
  sourceLanguage: "typescript",
  fileGlob: "src/**/*.ts",
  ignoreGlobs: ["**/node_modules/**", "**/dist/**", "**/*.test.ts", "**/*.spec.ts"],
  repoUrl: DEFAULT_STRADA_MCP_REPO_URL,
  versionDetection: "package.json",
};

/** All package configs indexed by package ID */
export const FRAMEWORK_PACKAGE_CONFIGS: ReadonlyMap<FrameworkPackageId, FrameworkPackageConfig> = new Map([
  ["core", CORE_PACKAGE_CONFIG],
  ["modules", MODULES_PACKAGE_CONFIG],
  ["mcp", MCP_PACKAGE_CONFIG],
]);
