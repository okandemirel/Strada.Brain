/**
 * Runtime single-instance lock.
 *
 * Measured 2026-08-23: nothing prevented two supervisors/runtimes from running
 * against the SAME install's SQLite stores concurrently — WAL prevents
 * corruption but not double trigger-firing (a cron trigger executes twice,
 * budget entries double-write). The CLI's process-scan backstop is
 * Windows-unsupported and racy; this lock is the authoritative gate.
 *
 * Scope is the INSTALL ROOT (matches `strada status/kill/restart` semantics):
 * two separate installs may run side by side; one install gets one runtime.
 *
 * Takeover semantics: a lock whose PID is no longer alive is stale and is
 * claimed automatically, so a SIGKILLed previous instance never wedges the
 * next start. Known limitation: PID reuse within the staleness window can
 * false-positive as "alive"; the failure mode is a clear refusal message,
 * not silent corruption.
 */

import { mkdir, open, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "winston";

const LOCK_FILE_NAME = "runtime.lock";

interface LockPayload {
  pid: number;
  startedAtIso: string;
  channel: string;
}

export type AcquireResult =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; holder: LockPayload };

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    // Signal 0 = existence probe. EPERM means "exists, owned by someone else".
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(path: string): Promise<LockPayload | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid === "number") {
      return {
        pid: parsed.pid,
        startedAtIso: typeof parsed.startedAtIso === "string" ? parsed.startedAtIso : "",
        channel: typeof parsed.channel === "string" ? parsed.channel : "",
      };
    }
    return null;
  } catch {
    return null; // corrupt/truncated lock → treated as stale
  }
}

async function claim(path: string, payload: LockPayload): Promise<void> {
  // O_EXCL gives an atomic claim: two simultaneous starters cannot both win.
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0),
    0o644,
  );
  try {
    await handle.writeFile(JSON.stringify(payload), "utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * Try to become THE runtime for this install. Returns `{ acquired: false, holder }`
 * when a live instance already holds the lock. The returned `release()` removes the
 * lock only if this process still owns it (idempotent, safe on double-shutdown).
 */
export async function acquireRuntimeLock(opts: {
  installRoot: string;
  channelType: string;
  logger?: Logger;
}): Promise<AcquireResult> {
  const lockPath = join(opts.installRoot, ".strada", LOCK_FILE_NAME);
  const payload: LockPayload = {
    pid: process.pid,
    startedAtIso: new Date().toISOString(),
    channel: opts.channelType,
  };

  const existing = await readLock(lockPath);
  if (existing && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
    return { acquired: false, holder: existing };
  }
  if (existing) {
    opts.logger?.info("Removing stale runtime lock", {
      stalePid: existing.pid,
      startedAtIso: existing.startedAtIso,
    });
    try {
      await rm(lockPath, { force: true });
    } catch {
      // Unlink raced or failed — O_EXCL below arbitrates the real claim.
    }
  }

  await mkdirSafe(dirname(lockPath));
  let claimed = false;
  try {
    await claim(lockPath, payload);
    claimed = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }

  if (!claimed) {
    // Lost the O_EXCL race — either a fresh legitimate claim landed between our
    // stale-check and claim, or an UNPARSEABLE (corrupt) leftover survived the
    // stale branch above (readLock returned null so it was never removed).
    // Re-arbitrate exactly once: clear it only when it is still not a LIVE
    // holder's claim, then retry the atomic claim.
    const incumbent = await readLock(lockPath);
    if (!incumbent || !isProcessAlive(incumbent.pid)) {
      try {
        await rm(lockPath, { force: true });
        await claim(lockPath, payload);
        claimed = true;
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== "EEXIST") throw e2;
      }
    }
  }

  if (!claimed) {
    const winner = (await readLock(lockPath)) ?? { pid: -1, startedAtIso: "", channel: "" };
    return { acquired: false, holder: winner };
  }

  let released = false;
  return {
    acquired: true,
    release: async () => {
      if (released) return;
      released = true;
      const current = await readLock(lockPath);
      if (current?.pid !== process.pid) return; // a successor took over; do not clobber
      try {
        await rm(lockPath, { force: true });
      } catch {
        // Already gone — releasing twice is fine.
      }
    },
  };
}

async function mkdirSafe(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
