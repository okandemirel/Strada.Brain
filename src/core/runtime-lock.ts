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
 *
 * Atomicity (COR-6): a claim is a complete file hard-linked into place, so no
 * reader ever sees an empty lock and mistakes a starter mid-write for a stale
 * leftover; a stale lock is removed only if it still holds the exact bytes
 * that were judged, so a delayed removal cannot delete a fresh claim.
 */

import { link, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { Logger } from "winston";
import { removeLockIfUnchanged } from "./setup-env-persistence.js";

const LOCK_FILE_NAME = "runtime.lock";

interface LockPayload {
  pid: number;
  startedAtIso: string;
  channel: string;
}

/** Test seams: the defects live between a judgement and the action on it. Production passes nothing. */
export interface RuntimeLockPauses {
  /** After the existing lock was read and judged, before anything is removed. */
  afterJudging?: () => Promise<void>;
  /** After our claim is written to its private file, before it is published. */
  beforePublish?: () => Promise<void>;
}

/** Hard links are the atomic publish; these codes mean the filesystem has none. */
const NO_HARD_LINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK"]);

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

async function readLockRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function parseLock(raw: string | null): LockPayload | null {
  if (raw === null) return null;
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

async function readLock(path: string): Promise<LockPayload | null> {
  return parseLock(await readLockRaw(path));
}

/** O_EXCL create-and-write: exclusive, but briefly shows an empty file. */
async function claimExclusive(path: string, body: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0),
    0o644,
  );
  try {
    await handle.writeFile(body, "utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * Publish `body` at `path` only if nothing is there (EEXIST otherwise). The
 * body is written to a private file first and hard-linked into place, so the
 * lock appears complete or not at all. A filesystem without hard links falls
 * back to the O_EXCL write.
 */
async function claim(path: string, body: string, pauses?: RuntimeLockPauses): Promise<void> {
  const staged = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(staged, body, { encoding: "utf-8", mode: 0o644, flag: "wx" });
  try {
    await pauses?.beforePublish?.();
    await link(staged, path);
  } catch (e) {
    if (!NO_HARD_LINK_CODES.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
    await claimExclusive(path, body);
  } finally {
    await unlink(staged).catch(() => undefined);
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
  pauses?: RuntimeLockPauses;
}): Promise<AcquireResult> {
  const lockPath = join(opts.installRoot, ".strada", LOCK_FILE_NAME);
  const payload: LockPayload & { token: string } = {
    pid: process.pid,
    startedAtIso: new Date().toISOString(),
    channel: opts.channelType,
    // Makes every claim's bytes unique, so "is it still ours" is exact.
    token: randomBytes(8).toString("hex"),
  };
  const body = JSON.stringify(payload);

  const existingRaw = await readLockRaw(lockPath);
  const existing = parseLock(existingRaw);
  if (existing && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
    return { acquired: false, holder: existing };
  }
  await opts.pauses?.afterJudging?.();
  if (existingRaw !== null) {
    opts.logger?.info("Removing stale runtime lock", {
      stalePid: existing?.pid,
      startedAtIso: existing?.startedAtIso,
    });
    // Only the lock that was judged: a fresh claim that replaced it meanwhile
    // survives, and the claim below then loses to it.
    await removeLockIfUnchanged(lockPath, existingRaw);
  }

  await mkdirSafe(dirname(lockPath));
  let claimed = false;
  try {
    await claim(lockPath, body, opts.pauses);
    claimed = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }

  if (!claimed) {
    // Lost the claim — either a fresh legitimate claim landed between our
    // stale-check and claim, or an UNPARSEABLE (corrupt) leftover from an
    // older version survived. Re-arbitrate exactly once: clear it only when it
    // is still not a LIVE holder's claim, then retry the atomic claim.
    const incumbentRaw = await readLockRaw(lockPath);
    const incumbent = parseLock(incumbentRaw);
    if (!incumbent || !isProcessAlive(incumbent.pid)) {
      try {
        if (incumbentRaw !== null) await removeLockIfUnchanged(lockPath, incumbentRaw);
        await claim(lockPath, body);
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
      // A successor's claim has other bytes and is left alone.
      await removeLockIfUnchanged(lockPath, body);
    },
  };
}

async function mkdirSafe(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
