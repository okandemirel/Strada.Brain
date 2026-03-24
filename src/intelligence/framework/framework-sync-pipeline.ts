/**
 * Framework Sync Pipeline
 *
 * Orchestrates boot-time full sync, file watcher for incremental updates,
 * and git fallback for packages not installed locally.
 */

import { existsSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { FSWatcher } from "chokidar";
import type { StradaDepsStatus } from "../../config/strada-deps.js";
import type {
  FrameworkSyncConfig,
  FrameworkSyncResult,
  FrameworkDriftReport,
  FrameworkPackageId,
  FrameworkPackageConfig,
} from "./framework-types.js";
import { FrameworkKnowledgeStore } from "./framework-knowledge-store.js";
import { FRAMEWORK_PACKAGE_CONFIGS } from "./framework-package-configs.js";
import { createExtractor } from "./framework-extractor.js";
import {
  validateFrameworkDrift,
  formatFrameworkDriftReport,
} from "./framework-drift.js";
import { getLoggerSafe } from "../../utils/logger.js";

export class FrameworkSyncPipeline {
  private watcher: FSWatcher | null = null;
  private readonly store: FrameworkKnowledgeStore;
  private readonly config: FrameworkSyncConfig;
  private readonly stradaDeps: StradaDepsStatus;

  constructor(
    store: FrameworkKnowledgeStore,
    config: FrameworkSyncConfig,
    stradaDeps: StradaDepsStatus,
  ) {
    this.store = store;
    this.config = config;
    this.stradaDeps = stradaDeps;
  }

  /**
   * Boot-time full sync. For each package: extract, store, drift check.
   */
  async bootSync(): Promise<FrameworkSyncResult> {
    const logger = getLoggerSafe();
    const reports: FrameworkDriftReport[] = [];

    for (const [pkgId, pkgConfig] of FRAMEWORK_PACKAGE_CONFIGS) {
      let sourcePath = this.resolveSourcePath(pkgId);

      if (!sourcePath && this.config.gitFallbackEnabled) {
        sourcePath = this.gitFallbackClone(pkgId, pkgConfig);
      }

      if (!sourcePath) {
        logger.debug(`Framework sync: skipping ${pkgConfig.displayName} (not available)`);
        continue;
      }

      try {
        const extractor = await createExtractor(sourcePath, pkgConfig);
        const snapshot = await extractor.extract();

        const previous = this.store.getLatestSnapshot(pkgId);
        if (
          previous &&
          !this.store.needsSync(pkgId, snapshot.version, snapshot.gitHash)
        ) {
          logger.debug(
            `Framework sync: ${pkgConfig.displayName} unchanged, skipping`,
          );
          continue;
        }

        this.store.storeSnapshot(snapshot);

        const driftReport = validateFrameworkDrift(pkgId, snapshot, previous);
        reports.push(driftReport);

        if (driftReport.driftScore > 0 && previous) {
          logger.info(
            `Framework drift detected for ${pkgConfig.displayName}:\n${formatFrameworkDriftReport(driftReport)}`,
          );
        } else {
          logger.debug(
            `Framework sync: ${pkgConfig.displayName} v${snapshot.version ?? "unknown"} stored (${snapshot.fileCount} files)`,
          );
        }
      } catch (err) {
        logger.warn(
          `Framework sync failed for ${pkgConfig.displayName}: ${(err as Error).message}`,
        );
      }
    }

    this.store.pruneHistory(5);
    return { reports, syncedAt: new Date() };
  }

  /**
   * Start file watcher for incremental updates.
   * Uses chokidar with debounced per-package re-extraction.
   */
  async startWatcher(): Promise<void> {
    if (!this.config.watchEnabled) return;

    const watchPaths: string[] = [];
    for (const [pkgId] of FRAMEWORK_PACKAGE_CONFIGS) {
      const sourcePath = this.resolveSourcePath(pkgId);
      if (sourcePath) watchPaths.push(sourcePath);
    }

    if (watchPaths.length === 0) return;

    const logger = getLoggerSafe();
    const { watch } = await import("chokidar");

    this.watcher = watch(watchPaths, {
      ignored: [
        "**/node_modules/**",
        "**/.git/**",
        "**/bin/**",
        "**/obj/**",
      ],
      persistent: true,
      ignoreInitial: true,
    });

    const pendingPackages = new Set<FrameworkPackageId>();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    this.watcher.on("change", (filePath: string) => {
      const pkgId = this.identifyPackage(filePath);
      if (pkgId) pendingPackages.add(pkgId);

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        for (const pkg of pendingPackages) {
          try {
            await this.syncPackage(pkg);
          } catch (err) {
            logger.warn(
              `Incremental sync failed for ${pkg}: ${(err as Error).message}`,
            );
          }
        }
        pendingPackages.clear();
      }, this.config.watchDebounceMs);
    });

    logger.debug(
      `Framework watcher started for ${watchPaths.length} path(s)`,
    );
  }

  /**
   * Sync a single package on demand.
   * Returns the drift report, or null if the package is unavailable.
   */
  async syncPackage(
    packageId: FrameworkPackageId,
  ): Promise<FrameworkDriftReport | null> {
    const pkgConfig = FRAMEWORK_PACKAGE_CONFIGS.get(packageId);
    if (!pkgConfig) return null;

    const sourcePath = this.resolveSourcePath(packageId);
    if (!sourcePath) return null;

    const extractor = await createExtractor(sourcePath, pkgConfig);
    const snapshot = await extractor.extract();
    const previous = this.store.getLatestSnapshot(packageId);

    this.store.storeSnapshot(snapshot);
    return validateFrameworkDrift(packageId, snapshot, previous);
  }

  /** Stop watcher and clean up */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private resolveSourcePath(pkgId: FrameworkPackageId): string | null {
    switch (pkgId) {
      case "core":
        return this.stradaDeps.corePath;
      case "modules":
        return this.stradaDeps.modulesPath;
      case "mcp":
        return this.stradaDeps.mcpPath;
    }
  }

  private identifyPackage(filePath: string): FrameworkPackageId | null {
    if (
      this.stradaDeps.corePath &&
      filePath.startsWith(this.stradaDeps.corePath)
    )
      return "core";
    if (
      this.stradaDeps.modulesPath &&
      filePath.startsWith(this.stradaDeps.modulesPath)
    )
      return "modules";
    if (
      this.stradaDeps.mcpPath &&
      filePath.startsWith(this.stradaDeps.mcpPath)
    )
      return "mcp";
    return null;
  }

  /**
   * Git fallback: shallow clone to cache directory.
   * Uses HTTPS-only protocol restriction (same pattern as skill-installer.ts).
   */
  private gitFallbackClone(
    pkgId: FrameworkPackageId,
    config: FrameworkPackageConfig,
  ): string | null {
    const logger = getLoggerSafe();
    const cacheDir = join(this.config.gitCacheDir, pkgId);

    // Check if cache exists and is fresh enough
    if (existsSync(cacheDir)) {
      try {
        const stats = statSync(cacheDir);
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs < this.config.gitCacheMaxAgeMs) {
          return cacheDir;
        }
      } catch {
        /* fall through to re-clone */
      }
    }

    try {
      mkdirSync(this.config.gitCacheDir, { recursive: true });

      // Remove stale cache if exists
      if (existsSync(cacheDir)) {
        execFileSync("rm", ["-rf", cacheDir], { timeout: 10_000 });
      }

      // Shallow clone with HTTPS-only protocol (security)
      execFileSync(
        "git",
        ["clone", "--depth", "1", "--", config.repoUrl, cacheDir],
        {
          timeout: 60_000,
          env: { ...process.env, GIT_ALLOW_PROTOCOL: "https" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      logger.debug(
        `Git fallback: cloned ${config.displayName} to ${cacheDir}`,
      );
      return cacheDir;
    } catch (err) {
      logger.warn(
        `Git fallback clone failed for ${config.displayName}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
