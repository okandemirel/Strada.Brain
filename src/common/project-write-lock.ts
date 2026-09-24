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
  /** The writing process's random id, unique per process lifetime. */
  incarnation?: string;
  /** Where the OS offers it, when that process started (see osStartMark). */
  started?: string;
}

/**
 * Per-process state on globalThis, so a second copy of this module (a test
 * reset, a duplicated bundle) agrees with the first on who this process is
 * and which locks it holds.
 */
interface ProcessLockState {
  incarnation: string;
  held: Set<string>;
  started?: string | undefined;
}
const PROCESS_STATE_KEY = Symbol.for("strada.projectWriteLock.process");
function processState(): ProcessLockState {
  const registry = globalThis as unknown as Record<symbol, ProcessLockState | undefined>;
  let state = registry[PROCESS_STATE_KEY];
  if (!state) {
    state = { incarnation: randomUUID(), held: new Set(), started: osStartMark(process.pid) };
    registry[PROCESS_STATE_KEY] = state;
  }
  return state;
}

/**
 * When the process now running as `pid` started, where the OS says so
 * cheaply: the boot id plus the start time in clock ticks (Linux /proc).
 * Undefined elsewhere, and then a foreign pid is judged by the pid alone.
 */
function osStartMark(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields resume after the parenthesised command name (which may contain
    // spaces) at field 3; starttime is field 22.
    const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return bootId && startTicks ? `${bootId}:${startTicks}` : undefined;
  } catch {
    return undefined;
  }
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

/**
 * Is the process that took this lock still running on this machine?
 *
 * A running PID is not proof: a crashed holder's PID gets reused, and in a
 * container node gets the SAME pid on every restart. Judged by pid alone that
 * dead holder's lock was alive forever (as this very process), and every bulk
 * write waited out its timeout and then ran unlocked. The owner file records
 * which incarnation wrote it; an owner without one (an older version) is
 * still judged by the pid.
 */
export function holderIsAlive(owner: LockOwner | null): boolean | undefined {
  if (!owner || owner.host !== hostname() || !Number.isInteger(owner.pid)) return undefined;
  if (owner.pid === process.pid && typeof owner.incarnation === "string") {
    const self = processState();
    // Ours: alive exactly while we still hold it. Otherwise an earlier
    // process with this pid wrote it, and that process is gone.
    return owner.incarnation === self.incarnation && self.held.has(owner.token);
  }
  try {
    process.kill(owner.pid, 0);
  } catch (err) {
    // EPERM means a process with that id exists and is not ours.
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  // The pid is running; is it still the process that took the lock?
  if (owner.pid !== process.pid && typeof owner.started === "string") {
    const now = osStartMark(owner.pid);
    if (now !== undefined && now !== owner.started) return false;
  }
  return true;
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
  const self = processState();
  const owner: LockOwner = { pid: process.pid, host: hostname(), token, at: new Date().toISOString(), incarnation: self.incarnation };
  if (self.started !== undefined) owner.started = self.started;
  writeFileSync(join(path, "owner"), JSON.stringify(owner), "utf8");
}

/** How long a reclaim decision may take before another reclaimer overrides it. */
const RECLAIM_MARKER_STALE_MS = 30_000;
/** How a contended release waits out the reclaimer that holds the decision. */
const RELEASE_RETRY_MS = 500;
const RELEASE_RETRIES = Math.ceil((RECLAIM_MARKER_STALE_MS * 2) / RELEASE_RETRY_MS);

/**
 * Serialize the DECISION to break or release a lock.
 *
 * Reclaimers do not compete with acquirers for this — acquirers only ever take
 * a path this function has already vacated, and that is a rightful handover.
 * What it prevents is two reclaimers acting on the same observation.
 */
function takeReclaimMarker(path: string): boolean {
  const marker = `${path}.reclaiming`;
  try {
    mkdirSync(marker, { recursive: false });
    return true;
  } catch {
    /* another reclaimer holds the decision — unless it died holding it */
  }
  try {
    if (Date.now() - statSync(marker).mtimeMs > RECLAIM_MARKER_STALE_MS) {
      rmSync(marker, { recursive: true, force: true });
      mkdirSync(marker, { recursive: false });
      return true;
    }
  } catch {
    /* vanished under us, or unwritable: leave the lock alone */
  }
  return false;
}

function dropReclaimMarker(path: string): void {
  try {
    rmSync(`${path}.reclaiming`, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

/**
 * What a reclaim attempt did: took the lock away, found it was not ours to
 * take, or could not decide because another reclaimer held the marker.
 */
type ReclaimOutcome = "settled" | "not-ours" | "contended";

/**
 * Take a lock away from whoever holds it, atomically.
 *
 * A token check followed by an independent delete is two steps: between them
 * another reclaimer can break the same lock and a new writer can take it, and
 * the first reclaimer's delete then removes the NEW holder's lock (Codex
 * 2026-09-11 O#16). Renaming first and restoring on a token mismatch was not
 * enough either: while the canonical path stands empty a third writer takes
 * it, the restore then fails, and the live holder's lock is deleted anyway
 * (Codex 2026-09-12 P#20).
 *
 * So the decision comes FIRST and is serialized: under the reclaim marker the
 * owner is read AGAIN and must still be the one this reclaim was justified
 * against. A lock can only change hands through a reclaim, every reclaim holds
 * the marker, and the path is never vacated on a stale observation — so there
 * is no window in which a new holder's lock can be removed.
 */
function reclaim(path: string, expected: LockOwner | null, why: string, routine = false): ReclaimOutcome {
  // CONTENDED IS NOT DONE. A release that reported success while another
  // reclaimer held the marker stopped its heartbeat and left the lock
  // standing with a live owner: nothing could ever take it, and every later
  // writer proceeded unlocked (Codex 2026-09-12 Q#3).
  if (!takeReclaimMarker(path)) return "contended";
  try {
    const current = readOwner(path);
    if (expected !== null) {
      // The observation that justified this reclaim may be old. If the lock
      // has changed hands since, it belongs to its new holder.
      if (current === null || current.token !== expected.token) return "not-ours";
    } else if (current !== null && holderIsAlive(current) !== false) {
      // We judged an ownerless directory stale; it has an owner now.
      return "not-ours";
    }
    try {
      // A grave left by a reclaimer that died mid-flight would block the
      // rename; it holds nothing but a settled lock's metadata.
      rmSync(`${path}.reclaimed`, { recursive: true, force: true });
      renameSync(path, `${path}.reclaimed`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "settled"; // released under us — nothing of ours to remove
      // ANYTHING ELSE LEAVES THE LOCK STANDING. On Windows an antivirus or
      // indexer handle makes this EPERM/EBUSY routinely; calling that settled
      // stopped the holder's heartbeat with the directory still in place, and
      // every later writer waited out its timeout and wrote unlocked. Report it
      // as contended so a release retries.
      getLoggerSafe().debug("Project write lock could not be moved aside yet", { path, code });
      return "contended";
    }
    // A release is routine; only TAKING a lock from someone is a warning.
    if (routine) getLoggerSafe().debug(why, { path });
    else getLoggerSafe().warn(why, { path, pid: current?.pid });
    try {
      rmSync(`${path}.reclaimed`, { recursive: true, force: true });
    } catch {
      // The lock is already off the canonical path; the next reclaim clears this grave.
    }
    return "settled";
  } finally {
    dropReclaimMarker(path);
  }
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
      processState().held.add(token);
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
          // ONLY OUR OWN LOCK. An unconditional remove deleted the lock a
          // different process had taken after ours was broken, and a third
          // writer then acquired it beside that one (Codex 2026-09-11 N#2).
          // The same atomic take-then-verify: reading the owner and deleting
          // afterwards could remove a lock that changed hands in between.
          const mine: LockOwner = { pid: process.pid, host: hostname(), token, at: "" };
          const settle = (attempt: number): void => {
            if (released) return;
            const outcome = reclaim(path, mine, "Project write lock released", true);
            if (outcome === "contended" && attempt < RELEASE_RETRIES) {
              // ANOTHER RECLAIMER IS DECIDING. Our lock is still ours and
              // still held: keep the heartbeat alive and come back, or the
              // lock stands forever with a live owner and every later writer
              // proceeds unlocked (Codex 2026-09-12 Q#3). A reclaimer that
              // died holding the marker is overridden after its stale window,
              // so these retries always terminate.
              const again = setTimeout(() => settle(attempt + 1), RELEASE_RETRY_MS);
              again.unref?.();
              return;
            }
            if (outcome === "contended") {
              getLoggerSafe().warn("Project write lock could not be released — another reclaimer holds the decision, or the lock directory stayed busy", { path });
            }
            released = true;
            clearInterval(beat);
            // Whatever is left on disk is no longer held by anyone alive.
            processState().held.delete(token);
          };
          settle(0);
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
