/**
 * Cross-process advisory write lock for a project tree.
 *
 * Several writers can mutate the same real project: a lease write-back
 * (workspace commit), the campaign envelope's milestone commit, and — from a
 * second Strada process — the same again. They are conversation-scoped, not
 * project-scoped, so nothing stopped two of them interleaving half-written
 * trees into each other. This lock serializes the BULK writers; per-file agent
 * tool writes stay unlocked by design (they are fine-grained and short).
 *
 * mkdir-based: atomic on every platform, no O_EXCL races, survives inspection
 * by hand. Stale locks (holder crashed) are broken by age. On acquisition
 * timeout the caller PROCEEDS WITHOUT the lock with a loud warning —
 * availability over strictness: a stuck lock must never deadlock all delivery.
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLoggerSafe } from "../utils/logger.js";

const LOCK_DIR_NAME = "project-write.lock";
const DEFAULT_TIMEOUT_MS = 60_000;
/** A lock older than this is presumed abandoned by a dead process. */
const DEFAULT_STALE_MS = 10 * 60_000;
const POLL_MS = 250;

export interface ProjectWriteLockHandle {
  /** True when the lock was actually held (false = timed out, proceeded unlocked). */
  readonly acquired: boolean;
  release(): void;
}

function lockPath(projectRoot: string): string {
  return join(resolve(projectRoot), ".strada", "locks", LOCK_DIR_NAME);
}

function tryTakeLock(path: string): boolean {
  try {
    mkdirSync(path, { recursive: false });
    try {
      writeFileSync(join(path, "owner"), `${process.pid} ${new Date().toISOString()}\n`, "utf8");
    } catch {
      // Metadata is best-effort; the directory IS the lock.
    }
    return true;
  } catch {
    return false;
  }
}

function breakIfStale(path: string, staleMs: number): void {
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age > staleMs) {
      getLoggerSafe().warn("Breaking stale project write lock", { path, ageMs: Math.round(age) });
      rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // Vanished between the failed take and the stat — that's a release.
  }
}

/**
 * Acquire the project write lock, waiting up to `timeoutMs`. Always returns a
 * handle; check `acquired` when the distinction matters. `release()` is
 * idempotent and safe to call from a finally block.
 */
export async function acquireProjectWriteLock(
  projectRoot: string,
  opts?: { timeoutMs?: number; staleMs?: number },
): Promise<ProjectWriteLockHandle> {
  const path = lockPath(projectRoot);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  try {
    mkdirSync(join(resolve(projectRoot), ".strada", "locks"), { recursive: true });
  } catch {
    // An unwritable project cannot be locked; the writer will surface its own error.
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryTakeLock(path)) {
      let released = false;
      return {
        acquired: true,
        release: () => {
          if (released) return;
          released = true;
          rmSync(path, { recursive: true, force: true });
        },
      };
    }
    breakIfStale(path, staleMs);
    if (Date.now() >= deadline) {
      getLoggerSafe().warn(
        "Project write lock not acquired within timeout — proceeding UNLOCKED",
        { path, timeoutMs },
      );
      return { acquired: false, release: () => undefined };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
