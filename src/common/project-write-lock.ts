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
 * by hand. A lock whose HOLDER IS GONE is broken at once; a lock whose holder
 * is alive is left alone however long it has been held, because the holder
 * heartbeats the owner file. Age alone used to decide both, so a live writer's
 * lock was broken after ten minutes and a dead writer's lock stopped every
 * other writer for ten (measured live 2026-09-11 21:16:24: the daemon had
 * restarted five minutes earlier, the dead process's lock was not yet "stale",
 * and the salvage commit wrote into the project UNLOCKED — Codex N#2).
 *
 * On acquisition timeout the caller PROCEEDS WITHOUT the lock with a loud
 * warning — availability over strictness: a stuck lock must never deadlock all
 * delivery.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { getLoggerSafe } from "../utils/logger.js";

const LOCK_DIR_NAME = "project-write.lock";
const DEFAULT_TIMEOUT_MS = 60_000;
/** A lock older than this is presumed abandoned by a dead process. */
const DEFAULT_STALE_MS = 10 * 60_000;
const POLL_MS = 250;
/** How often the holder proves it is still alive by touching the owner file. */
const HEARTBEAT_MS = 30_000;

interface LockOwner {
  pid: number;
  host: string;
  token: string;
  at: string;
}

function readOwner(path: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(path, "owner"), "utf8"));
    if (parsed && typeof parsed === "object" && typeof (parsed as LockOwner).token === "string") {
      return parsed as LockOwner;
    }
  } catch {
    /* unreadable or from an older version: age decides */
  }
  return null;
}

/** Is the process that took this lock still running on this machine? */
export function holderIsAlive(owner: LockOwner | null): boolean | undefined {
  if (!owner || owner.host !== hostname() || !Number.isInteger(owner.pid)) return undefined;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    // EPERM means a process with that id exists and is not ours.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ProjectWriteLockHandle {
  /** True when the lock was actually held (false = timed out, proceeded unlocked). */
  readonly acquired: boolean;
  release(): void;
}

function lockPath(projectRoot: string): string {
  return join(resolve(projectRoot), ".strada", "locks", LOCK_DIR_NAME);
}

function tryTakeLock(path: string, token: string): boolean {
  try {
    mkdirSync(path, { recursive: false });
  } catch {
    return false;
  }
  try {
    writeOwner(path, token);
  } catch {
    // Metadata is best-effort; the directory IS the lock. Without it the
    // holder cannot be identified, so age decides staleness as it used to.
  }
  return true;
}

function writeOwner(path: string, token: string): void {
  const owner: LockOwner = { pid: process.pid, host: hostname(), token, at: new Date().toISOString() };
  writeFileSync(join(path, "owner"), JSON.stringify(owner), "utf8");
}

/**
 * Take a lock away from whoever holds it, atomically.
 *
 * A token check followed by an independent delete is two steps: between them
 * another reclaimer can break the same lock and a new writer can take it, and
 * the first reclaimer's delete then removes the NEW holder's lock (Codex
 * 2026-09-11 O#16). A rename is one step: only one caller can win it, and the
 * owner file inside the renamed directory says whether it was the one judged
 * dead.
 */
function reclaim(path: string, expected: LockOwner | null, why: string): void {
  const grave = `${path}.reclaimed-${randomUUID().slice(0, 8)}`;
  try {
    renameSync(path, grave);
  } catch {
    return; // someone else got there first — nothing of ours to remove
  }
  const inside = readOwner(grave);
  if (expected !== null && inside !== null && inside.token !== expected.token) {
    // We took a lock that had already changed hands. Put it back if the slot
    // is still free; otherwise the newcomer will simply take it again.
    try {
      renameSync(grave, path);
      return;
    } catch {
      /* the slot is taken; drop what we hold */
    }
  }
  getLoggerSafe().warn(why, { path, pid: inside?.pid });
  rmSync(grave, { recursive: true, force: true });
}

function breakIfStale(path: string, staleMs: number): void {
  try {
    const owner = readOwner(path);
    const alive = holderIsAlive(owner);
    if (alive === false) {
      // THE HOLDER IS GONE. Waiting out the stale window for a process that
      // no longer exists is what wrote into the project unlocked.
      reclaim(path, owner, "Breaking project write lock — its holder is gone");
      return;
    }
    if (alive === true) return; // a live holder keeps its lock, however long the work takes
    const age = Date.now() - statSync(join(path, "owner")).mtimeMs;
    if (age > staleMs) {
      reclaim(path, owner, "Breaking stale project write lock");
    }
  } catch {
    // No owner file (an older holder, or a failed write): fall back to the
    // directory's own age.
    try {
      const age = Date.now() - statSync(path).mtimeMs;
      if (age > staleMs) {
        reclaim(path, null, "Breaking stale project write lock (no owner file)");
      }
    } catch {
      // Vanished between the failed take and the stat — that's a release.
    }
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
  const token = randomUUID();
  for (;;) {
    if (tryTakeLock(path, token)) {
      let released = false;
      // The holder proves it is alive while it works, so a long write-back is
      // never mistaken for an abandoned lock.
      const beat = setInterval(() => {
        try {
          if (readOwner(path)?.token === token) writeOwner(path, token);
        } catch {
          /* the lock is gone or unwritable; release handles it */
        }
      }, HEARTBEAT_MS);
      beat.unref?.();
      return {
        acquired: true,
        release: () => {
          if (released) return;
          released = true;
          clearInterval(beat);
          // ONLY OUR OWN LOCK. An unconditional remove deleted the lock a
          // different process had taken after ours was broken, and a third
          // writer then acquired it beside that one (Codex 2026-09-11 N#2).
          // The same atomic take-then-verify: reading the owner and deleting
          // afterwards could remove a lock that changed hands in between.
          reclaim(path, { pid: process.pid, host: hostname(), token, at: "" }, "Project write lock released");
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
