/**
 * Strada API Sync Command
 *
 * CLI command that extracts API snapshots from Strada packages,
 * validates them against Brain's knowledge, and reports drift.
 *
 * Supports single-package Core sync (legacy) and multi-package sync
 * via --package, --all, and --git-fallback flags.
 */

import { resolve, basename, join } from "node:path";
import { stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createLogger } from "../utils/logger.js";
import { StradaCoreExtractor } from "./strada-core-extractor.js";
import { validateDrift, formatDriftReport } from "./strada-drift-validator.js";
import { createExtractor } from "./framework/framework-extractor.js";
import { FRAMEWORK_PACKAGE_CONFIGS } from "./framework/framework-package-configs.js";
import { validateFrameworkDrift, formatFrameworkDriftReport } from "./framework/framework-drift.js";
import type { FrameworkPackageId } from "./framework/framework-types.js";

interface SyncOptions {
  corePath: string;
  dryRun: boolean;
  apply: boolean;
  json?: boolean;
  maxDriftScore?: number;
  failOnWarnings?: boolean;
  packageFilter?: "core" | "modules" | "mcp";
  syncAll?: boolean;
  gitFallback?: boolean;
}

/** Map of env vars / default sibling paths for each package */
const PACKAGE_PATH_ENV: Record<FrameworkPackageId, string> = {
  core: "STRADA_CORE_PATH",
  modules: "STRADA_MODULES_PATH",
  mcp: "STRADA_MCP_PATH",
};

const GIT_CACHE_DIR = join(
  process.env["HOME"] ?? "/tmp",
  ".strada",
  "framework-cache",
);

/**
 * Run the sync command.
 * Delegates to multi-package sync when --package or --all is provided,
 * otherwise falls back to the legacy single-package Core sync.
 */
export async function runSyncCommand(opts: SyncOptions): Promise<void> {
  // Initialize logger for standalone CLI usage
  createLogger(process.env["LOG_LEVEL"] ?? "info", "strada-brain-sync.log");

  // Multi-package mode
  if (opts.packageFilter || opts.syncAll) {
    await runMultiPackageSync(opts);
    return;
  }

  // Legacy single-package Core sync
  const corePath = resolve(opts.corePath);

  // Validate core path exists
  try {
    const stats = await stat(corePath);
    if (!stats.isDirectory()) {
      console.error(`Error: ${corePath} is not a directory`);
      process.exitCode = 1;
      return;
    }
  } catch {
    console.error(`Error: ${corePath} does not exist`);
    process.exitCode = 1;
    return;
  }

  console.log(`Extracting API from: ${basename(corePath)}`);
  console.log("");

  const extractor = new StradaCoreExtractor(corePath);
  const snapshot = await extractor.extract();

  console.log(`Extracted: ${snapshot.fileCount} files, ${snapshot.classes.length} classes, ${snapshot.interfaces.length} interfaces`);
  console.log(`Namespaces: ${snapshot.namespaces.length}`);
  console.log("");

  // Validate
  const report = validateDrift(snapshot);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDriftReport(report));
  }

  if (opts.apply && !opts.dryRun) {
    console.log("");
    console.log("Auto-apply is not yet implemented.");
    console.log("Review the drift report above and manually update strada-api-reference.ts.");
  }

  // Exit with error code if critical drift found
  if (
    report.errors.length > 0 ||
    (typeof opts.maxDriftScore === "number" && report.driftScore > opts.maxDriftScore) ||
    (opts.failOnWarnings === true && report.warnings.length > 0)
  ) {
    process.exitCode = 1;
  }
}

// ─── Multi-Package Sync ──────────────────────────────────────────────────────

/**
 * Sync one or more Strada packages using the framework extractor pipeline.
 *
 * - `--package core|modules|mcp` syncs a single package
 * - `--all` syncs every package that has a valid local path (or git fallback)
 * - `--git-fallback` clones missing packages via HTTPS shallow clone
 */
async function runMultiPackageSync(opts: SyncOptions): Promise<void> {
  const packageIds: FrameworkPackageId[] = opts.syncAll
    ? [...FRAMEWORK_PACKAGE_CONFIGS.keys()]
    : [opts.packageFilter!];

  let hasFailure = false;

  for (const pkgId of packageIds) {
    const pkgConfig = FRAMEWORK_PACKAGE_CONFIGS.get(pkgId);
    if (!pkgConfig) {
      console.error(`Unknown package: ${pkgId}`);
      hasFailure = true;
      continue;
    }

    let sourcePath = resolvePackagePath(pkgId, opts.corePath);

    // Git fallback: clone if local path is missing and flag is set
    if (!sourcePath && opts.gitFallback) {
      console.log(`Local path not found for ${pkgConfig.displayName}, trying git fallback...`);
      sourcePath = await gitFallbackClone(pkgId, pkgConfig.repoUrl, pkgConfig.displayName);
    }

    if (!sourcePath) {
      console.log(`Skipping ${pkgConfig.displayName}: no local path available`);
      if (!opts.syncAll) {
        // Explicit single-package request with no path is an error
        console.error(`Error: could not resolve path for ${pkgConfig.displayName}`);
        hasFailure = true;
      }
      continue;
    }

    console.log(`Syncing ${pkgConfig.displayName} from: ${basename(sourcePath)}`);

    try {
      const extractor = await createExtractor(sourcePath, pkgConfig);
      const snapshot = await extractor.extract();

      console.log(
        `  Extracted: ${snapshot.fileCount} files, ${snapshot.classes.length} classes, ${snapshot.interfaces.length} interfaces`,
      );
      console.log(`  Namespaces: ${snapshot.namespaces.length}`);

      // Drift detection: for core, build a baseline from STRADA_API; for others, first sync
      let previousSnapshot: import("./framework/framework-types.js").FrameworkAPISnapshot | null = null;
      if (pkgId === "core") {
        // Use the legacy validator's baseline-building logic for Core drift
        const { buildBrainBaselineSnapshot } = await import("./strada-drift-validator.js");
        previousSnapshot = buildBrainBaselineSnapshot();
      }
      const driftReport = validateFrameworkDrift(pkgId, snapshot, previousSnapshot);

      if (opts.json) {
        console.log(JSON.stringify(driftReport, null, 2));
      } else {
        console.log(formatFrameworkDriftReport(driftReport));
      }
      console.log("");

      // Check drift thresholds
      if (
        driftReport.errors.length > 0 ||
        (typeof opts.maxDriftScore === "number" && driftReport.driftScore > opts.maxDriftScore) ||
        (opts.failOnWarnings === true && driftReport.warnings.length > 0)
      ) {
        hasFailure = true;
      }
    } catch (err) {
      console.error(`Error syncing ${pkgConfig.displayName}: ${(err as Error).message}`);
      hasFailure = true;
    }
  }

  if (hasFailure) {
    process.exitCode = 1;
  }
}

// ─── Path Resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the local filesystem path for a given package.
 *
 * Priority:
 *   1. Environment variable (STRADA_CORE_PATH, etc.)
 *   2. For "core": the explicit `corePath` CLI option (backward compat)
 *   3. Sibling directory detection (../Strada.Core, ../Strada.Modules, ../Strada.MCP)
 */
function resolvePackagePath(
  pkgId: FrameworkPackageId,
  corePathOpt: string,
): string | null {
  // 1. Environment variable
  const envVar = PACKAGE_PATH_ENV[pkgId];
  const envValue = process.env[envVar];
  if (envValue) {
    const resolved = resolve(envValue);
    if (existsSync(resolved)) return resolved;
  }

  // 2. Explicit corePath for "core" (backward compat)
  if (pkgId === "core" && corePathOpt) {
    const resolved = resolve(corePathOpt);
    if (existsSync(resolved)) return resolved;
  }

  // 3. Sibling directory detection
  const pkgConfig = FRAMEWORK_PACKAGE_CONFIGS.get(pkgId);
  if (pkgConfig) {
    const siblingPath = resolve(process.cwd(), "..", pkgConfig.displayName);
    if (existsSync(siblingPath)) return siblingPath;
  }

  return null;
}

// ─── Git Fallback ────────────────────────────────────────────────────────────

/**
 * Shallow clone a package repo to the local cache directory.
 * Uses HTTPS-only protocol restriction (same pattern as skill-installer.ts).
 */
async function gitFallbackClone(
  pkgId: FrameworkPackageId,
  repoUrl: string,
  displayName: string,
): Promise<string | null> {
  const cacheDir = join(GIT_CACHE_DIR, pkgId);

  // Use existing cache if present
  if (existsSync(cacheDir)) {
    console.log(`  Using cached clone: ${cacheDir}`);
    return cacheDir;
  }

  try {
    await mkdir(GIT_CACHE_DIR, { recursive: true });

    console.log(`  Cloning ${displayName} (shallow)...`);
    execFileSync(
      "git",
      ["clone", "--depth", "1", "--", repoUrl, cacheDir],
      {
        timeout: 60_000,
        env: { ...process.env, GIT_ALLOW_PROTOCOL: "https" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    console.log(`  Cloned to: ${cacheDir}`);
    return cacheDir;
  } catch (err) {
    console.error(`  Git fallback failed for ${displayName}: ${(err as Error).message}`);
    return null;
  }
}
