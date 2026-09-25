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
 * Location (COR-21): the lock lives under the writable CONFIG root, keyed by a
 * short hash of the install root, because the install root itself may be
 * read-only (a root-owned global npm install, a read_only container) and a
 * lock there stopped startup. Versions before this change look only at
 * `<installRoot>/.strada/runtime.lock`, so a live lock there still blocks, and
 * where that directory is writable the claim is mirrored there too.
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
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
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

/** A directory nobody may write to: the legacy mirror is skipped, never forced. */
const UNWRITABLE_CODES = new Set(["EACCES", "EPERM", "EROFS", "ENOTDIR"]);

/**
 * Where an install's `kind` lock lives: `<configRoot>/.strada/locks/`, named by
 * a short hash of the install root so several installs can share one config
 * root (COR-21). Windows paths are case-insensitive, so they hash lowercased.
 */
export function installLockPath(configRoot: string, installRoot: string, kind: "runtime" | "update"): string {
  const root = resolve(installRoot);
  const key = createHash("sha256")
    .update(process.platform === "win32" ? root.toLowerCase() : root)
    .digest("hex")
    .slice(0, 16);
  return join(configRoot, ".strada", "locks", `${key}.${kind}.lock`);
}

/** Where versions before COR-21 keep the runtime lock; they look nowhere else. */
export function legacyRuntimeLockPath(installRoot: string): string {
  return join(installRoot, ".strada", LOCK_FILE_NAME);
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

/** The holder of `lock` when it is a LIVE process other than this one. */
function liveForeignHolder(lock: LockPayload | null): LockPayload | null {
  return lock && lock.pid !== process.pid && isProcessAlive(lock.pid) ? lock : null;
}

/**
 * Try to become THE runtime for this install. Returns `{ acquired: false, holder }`
 * when a live instance already holds the lock. The returned `release()` removes the
 * lock only if this process still owns it (idempotent, safe on double-shutdown).
 */
export async function acquireRuntimeLock(opts: {
  installRoot: string;
  /** The writable config root the lock lives under (COR-21). */
  configRoot: string;
  channelType: string;
  logger?: Logger;
  pauses?: RuntimeLockPauses;
}): Promise<AcquireResult> {
  const payload: LockPayload & { token: string } = {
    pid: process.pid,
    startedAtIso: new Date().toISOString(),
    channel: opts.channelType,
    // Makes every claim's bytes unique, so "is it still ours" is exact.
    token: randomBytes(8).toString("hex"),
  };
  const body = JSON.stringify(payload);

  // A runtime from before COR-21 holds only the legacy lock. Reading it needs
  // nothing writable, so a read-only install root still gets this check.
  const legacyPath = legacyRuntimeLockPath(opts.installRoot);
  const legacyHolder = liveForeignHolder(await readLock(legacyPath));
  if (legacyHolder) return { acquired: false, holder: legacyHolder };

  const primary = await claimLock(installLockPath(opts.configRoot, opts.installRoot, "runtime"), body, opts);
  if (!primary.acquired) return primary;

  // Mirror the claim where older versions look, so they see this runtime too.
  // An unwritable install root skips the mirror; it never blocks the start.
  let mirror: AcquireResult | undefined;
  try {
    mirror = await claimLock(legacyPath, body, { logger: opts.logger });
  } catch (e) {
    if (!UNWRITABLE_CODES.has((e as NodeJS.ErrnoException).code ?? "")) {
      await primary.release();
      throw e;
    }
    opts.logger?.debug("Install root is not writable; runtime lock kept under the config root only", {
      legacyPath,
      code: (e as NodeJS.ErrnoException).code,
    });
  }
  if (mirror && !mirror.acquired) {
    // An older version claimed the legacy lock between our check and now.
    await primary.release();
    return mirror;
  }

  let released = false;
  return {
    acquired: true,
    release: async () => {
      if (released) return;
      released = true;
      await primary.release();
      if (mirror?.acquired) await mirror.release();
    },
  };
}

/** Claim `lockPath` with stale takeover (the single-path algorithm, COR-6). */
async function claimLock(
  lockPath: string,
  body: string,
  opts: { logger?: Logger; pauses?: RuntimeLockPauses },
): Promise<AcquireResult> {
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
