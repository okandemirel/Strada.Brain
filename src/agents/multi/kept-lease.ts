/**
 * A lease kept for salvage keeps the work, not the engine's caches.
 *
 * A lease whose publication failed is NOT released: its unpublished files
 * exist nowhere else, and the boot salvage pass commits them later. Only the
 * work needs keeping, though. Seen 2026-11-18: a live run's kept leases each
 * still held a full Unity Library/ import cache, which together filled tens
 * of GB of disk, and nothing reads it.
 *
 * What is dropped is exactly what a lease never publishes: the copy-exclude
 * list (WORKSPACE_COPY_EXCLUDES, else DEFAULT_WORKSPACE_COPY_EXCLUDES). The
 * commit walk and the lease seed both skip those names (shouldCommitEntry), so
 * dropping them changes nothing a later commit or salvage delivers or reports.
 */
import { existsSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isStrictlyInside } from "../../common/path-containment.js";
import { workspaceCopyExcludes } from "./lease-copy-excludes.js";
import { getLoggerSafe } from "../../utils/logger.js";

export interface KeptLease {
  readonly path: string;
  readonly leaseRoot: string;
}

export interface ShedResult {
  readonly removed: string[];
  /** Why nothing was removed, when nothing was. */
  readonly skipped?: string;
}

/**
 * Remove the named engine directories from a kept lease. Never follows a
 * symlink, never touches a name that is not a single path segment, and skips
 * the lease entirely while a Unity editor may still hold it open.
 */
export function shedKeptLease(lease: KeptLease, names: readonly string[] = workspaceCopyExcludes()): ShedResult {
  if (!isStrictlyInside(lease.leaseRoot, lease.path)) {
    return { removed: [], skipped: `the lease ${lease.path} is not under its lease root` };
  }
  // A running editor keeps Temp/UnityLockfile. A stale one after a crash also
  // skips the lease: that only costs disk, never work.
  if (existsSync(join(lease.path, "Temp", "UnityLockfile"))) {
    return { removed: [], skipped: "a Unity editor may still have the lease open (Temp/UnityLockfile)" };
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) continue;
    const target = join(lease.path, name);
    try {
      const stat = lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    } catch {
      continue; // not there
    }
    rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }
  return { removed };
}

/** Log a lease kept for salvage, then drop its engine caches. */
export function keepLeaseForSalvage(lease: KeptLease, message: string, fields: Record<string, unknown>): void {
  let shed: ShedResult;
  try {
    shed = shedKeptLease(lease);
  } catch (err) {
    shed = { removed: [], skipped: err instanceof Error ? err.message : String(err) };
  }
  // Safe: both callers run this in a finally, where a throw would skip cleanup.
  getLoggerSafe().error(message, { ...fields, cachesDropped: shed.removed, ...(shed.skipped ? { cachesKept: shed.skipped } : {}) });
}
