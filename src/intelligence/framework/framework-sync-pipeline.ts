/**
 * Framework Sync Pipeline
 *
 * Orchestrates boot-time full sync, file watcher for incremental updates,
 * and git fallback for packages not installed locally.
 */

import { existsSync, statSync, mkdirSync, rmSync } from "node:fs";
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
  SourceOrigin,
} from "./framework-types.js";
import { FrameworkKnowledgeStore, computeSnapshotFingerprint } from "./framework-knowledge-store.js";
import { FRAMEWORK_PACKAGE_CONFIGS } from "./framework-package-configs.js";
import { createExtractor } from "./framework-extractor-factory.js";
import {
  validateFrameworkDrift,
  formatFrameworkDriftReport,
} from "./framework-drift.js";
import { getLoggerSafe } from "../../utils/logger.js";
import { getFrameworkSchemaProvider } from "./framework-schema-provider.js";

export type SnapshotStoredListener = (packageId: FrameworkPackageId) => void;

/**
 * Directories the framework watcher must never descend into.
 *
 * Was: `ignored: ["**\/node_modules/**", "**\/.git/**", ...]`. chokidar 5
 * matches a string `ignored` entry by exact equality (`matcher === path`),
 * not as a glob, so none of those patterns ever matched a real path: every
 * npm install under Strada.MCP/node_modules and every lock-file churn under
 * Strada.Core/.git reached the handler and re-extracted the package. A
 * function matcher is what chokidar 5 actually consults. Whole path segments
 * only — `Runtime/Binding/` and `bin.cs` are not the `bin/` output dir.
 * Audited 2026-09-02.
 */
const WATCH_IGNORED_SEGMENT = /(^|[\\/])(node_modules|\.git|bin|obj)([\\/]|$)/;
export function isFrameworkWatchIgnored(path: string): boolean {
  return WATCH_IGNORED_SEGMENT.test(path);
}

export class FrameworkSyncPipeline {
  private watcher: FSWatcher | null = null;
  private readonly store: FrameworkKnowledgeStore;
  private readonly config: FrameworkSyncConfig;
  private readonly stradaDeps: StradaDepsStatus;
  private readonly snapshotListeners = new Set<SnapshotStoredListener>();
  // Incremental-sync scheduling state. Audited 2026-09-02: this lived in
  // startWatcher's closure, where the pending set was cleared only after the
  // awaits — an edit that landed while a flush was in flight was wiped before
  // the next flush could see it.
  private readonly pendingPackages = new Set<FrameworkPackageId>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();

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
   * Register a listener for "a snapshot was just stored". Readers that memoise
   * a snapshot (FrameworkPromptGenerator) drop their memo here. Returns an
   * unsubscribe function.
   */
  onSnapshotStored(listener: SnapshotStoredListener): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  /**
   * Store a snapshot and tell every memoising reader about it.
   *
   * Was: `store.storeSnapshot` alone. FrameworkSchemaProvider and
   * FrameworkPromptGenerator memoise on first read and their invalidateCache()
   * had no production caller, so a snapshot stored after boot (watcher or
   * on-demand sync) was never served for the life of the process.
   * Audited 2026-09-02.
   */
  private storeAndNotify(snapshot: Parameters<FrameworkKnowledgeStore["storeSnapshot"]>[0]): void {
    this.store.storeSnapshot(snapshot);
    getFrameworkSchemaProvider()?.invalidateCache();
    for (const listener of this.snapshotListeners) {
      try {
        listener(snapshot.packageId);
      } catch (err) {
        getLoggerSafe().warn(
          `Framework snapshot listener failed for ${snapshot.packageId}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Boot-time full sync. For each package: extract, store, drift check.
   */
  async bootSync(): Promise<FrameworkSyncResult> {
    const logger = getLoggerSafe();
    const reports: FrameworkDriftReport[] = [];

    for (const [pkgId, pkgConfig] of FRAMEWORK_PACKAGE_CONFIGS) {
      let sourcePath = this.resolveSourcePath(pkgId);
      // WHERE THE SOURCE CAME FROM IS RECORDED, NOT ASSUMED (plan 2.13): the
      // project's own tree is "local"; a shallow clone is "git-clone", and a
      // reused clone is "cached". Every snapshot used to claim "local".
      let sourceOrigin: SourceOrigin = "local";

      if (!sourcePath && this.config.gitFallbackEnabled) {
        const fallback = this.gitFallbackClone(pkgId, pkgConfig);
        sourcePath = fallback?.path ?? null;
        sourceOrigin = fallback?.origin ?? "local";
      }

      if (!sourcePath) {
        logger.debug(`Framework sync: skipping ${pkgConfig.displayName} (not available)`);
        continue;
      }

      try {
        const extractor = await createExtractor(sourcePath, pkgConfig, sourceOrigin);
        const snapshot = await extractor.extract();

        // Drift and "did this change" are asked of THIS source, never of
        // whichever source happened to sync last on this machine.
        const previous = this.store.getLatestSnapshot(pkgId, sourcePath);
        // The extraction above already ran; compare its content too. Version
        // and git HEAD both stay put during an in-place edit, so keying on
        // them alone discarded a correct fresh snapshot as "unchanged" and
        // froze every consumer at the first indexed API. Audited 2026-09-02.
        const fingerprint = computeSnapshotFingerprint(snapshot);
        if (
          previous &&
          !this.store.needsSync(pkgId, snapshot.version, snapshot.gitHash, fingerprint, sourcePath)
        ) {
          logger.debug(
            `Framework sync: ${pkgConfig.displayName} skipped — version ${snapshot.version ?? "(none)"}, ` +
              `git HEAD ${snapshot.gitHash ? snapshot.gitHash.slice(0, 12) : "(none)"} and extracted API content ` +
              `(${snapshot.fileCount} files, fingerprint ${fingerprint.slice(0, 12)}) all match the stored snapshot`,
          );
          continue;
        }

        this.storeAndNotify(snapshot);

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
      // Function matcher: chokidar 5 never glob-matches a string entry.
      // Audited 2026-09-02.
      ignored: (path: string) => isFrameworkWatchIgnored(path),
      persistent: true,
      ignoreInitial: true,
    });

    // change AND add AND unlink: a new Runtime .cs or a deleted one changes
    // the framework API exactly as an edit does. Until 2026-09-17 only
    // `change` was subscribed, so an added base class never reached the
    // snapshot until some other file was edited (audit U3 / 0-A.23).
    const onEvent = (filePath: string): void => {
      this.handleWatchEvent(filePath);
    };
    for (const event of ["change", "add", "unlink"] as const) {
      this.watcher.on(event, onEvent);
    }

    logger.debug(
      `Framework watcher started for ${watchPaths.length} path(s)`,
    );
  }

  /**
   * Mark the owning package pending and (re)arm the debounce.
   * Exposed so the scheduling can be driven without a real watcher.
   * Audited 2026-09-02.
   */
  handleWatchEvent(filePath: string): void {
    const pkgId = this.identifyPackage(filePath);
    if (!pkgId) return;
    this.pendingPackages.add(pkgId);

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // Serialize: a debounce that fires while a flush is still awaiting
      // queues behind it instead of racing it over the same package.
      this.flushChain = this.flushChain.then(
        () => this.flushPendingSync(),
        () => this.flushPendingSync(),
      );
    }, this.config.watchDebounceMs);
  }

  /**
   * Sync every package marked pending, once each.
   *
   * Was: the debounce callback iterated the live pending set and cleared it
   * AFTER the awaits, so an edit that landed while a sync was in flight was
   * swallowed by that trailing clear (re-adding an id already in the set is a
   * no-op) and the next debounce found nothing to do. The batch is now
   * drained before the first await, so anything that lands mid-flush stays
   * pending for the next flush. Audited 2026-09-02.
   */
  async flushPendingSync(): Promise<void> {
    const logger = getLoggerSafe();
    const batch = [...this.pendingPackages];
    this.pendingPackages.clear();

    for (const pkg of batch) {
      try {
        await this.syncPackage(pkg);
      } catch (err) {
        logger.warn(
          `Incremental sync failed for ${pkg}: ${(err as Error).message}`,
        );
      }
    }
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

    // The package directory itself is gone (an unlink of the whole tree).
    // Extraction used to throw on the missing path, flushPendingSync caught
    // it, and the OLD snapshot stayed served as if nothing had happened
    // (Codex 2026-09-17). Drop it and say so instead.
    if (!existsSync(sourcePath)) {
      this.dropPackage(packageId, sourcePath);
      return null;
    }

    // The watcher only ever sees the project's own trees.
    const extractor = await createExtractor(sourcePath, pkgConfig, "local");
    const snapshot = await extractor.extract();
    const previous = this.store.getLatestSnapshot(packageId, sourcePath);

    this.storeAndNotify(snapshot);
    return validateFrameworkDrift(packageId, snapshot, previous);
  }

  /** Forget a package whose source no longer exists, and tell every reader. */
  private dropPackage(packageId: FrameworkPackageId, sourcePath: string): void {
    const logger = getLoggerSafe();
    const removed = this.store.deletePackage(packageId);
    getFrameworkSchemaProvider()?.invalidateCache();
    for (const listener of this.snapshotListeners) {
      try {
        listener(packageId);
      } catch (err) {
        logger.warn(`Framework snapshot listener failed for ${packageId}: ${(err as Error).message}`);
      }
    }
    const line = `Framework package ${packageId} is gone from ${sourcePath}: ${removed} stored snapshot(s) dropped and readers invalidated — its previous API is no longer served`;
    if (removed > 0) logger.warn(line);
    else logger.debug(line);
  }

  /** Stop watcher and clean up */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    // Let an in-flight flush finish so the store is not closed under it.
    // Audited 2026-09-02.
    await this.flushChain.catch(() => undefined);
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
      default:
        return null;
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
  ): { path: string; origin: SourceOrigin } | null {
    const logger = getLoggerSafe();
    const cacheDir = join(this.config.gitCacheDir, pkgId);

    // Check if cache exists and is fresh enough
    if (existsSync(cacheDir)) {
      try {
        const stats = statSync(cacheDir);
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs < this.config.gitCacheMaxAgeMs) {
          return { path: cacheDir, origin: "cached" };
        }
      } catch {
        /* fall through to re-clone */
      }
    }

    try {
      mkdirSync(this.config.gitCacheDir, { recursive: true });

      // Remove stale cache if exists
      if (existsSync(cacheDir)) {
        rmSync(cacheDir, { recursive: true, force: true });
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
      return { path: cacheDir, origin: "git-clone" };
    } catch (err) {
      logger.warn(
        `Git fallback clone failed for ${config.displayName}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
