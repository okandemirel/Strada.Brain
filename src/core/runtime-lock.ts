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
 * Owner identity: a pid is an identity only on its own host and in its own pid
 * namespace. Two containers on one volume both run node at the same small pid,
 * and `kill(pid, 0)` answers for this namespace alone, so a lock written in
 * another container looked either like this process or like a dead one and
 * was taken over while its owner ran. The lock therefore records the host and
 * (on Linux) the pid namespace. An owner this process can probe is judged by
 * its pid; one it cannot — another host, another container — is alive while it
 * keeps refreshing the lock's mtime, and stale once it has missed several
 * refreshes. So a container restarted after a crash waits that long before it
 * takes its predecessor's lock. A lock with this process's own pid in its own
 * namespace is ours only when this process wrote it; otherwise an earlier
 * process with that pid is gone. Locks from versions before this change carry
 * no host and are judged by pid alone, as they were.
 *
 * Takeover semantics: a lock whose owner is gone is stale and is claimed
 * automatically, so a SIGKILLed previous instance never wedges the next start.
 * Known limitation: PID reuse within the staleness window can false-positive
 * as "alive"; the failure mode is a clear refusal message, not silent
 * corruption.
 *
 * Atomicity (COR-6): a claim is a complete file hard-linked into place, so no
 * reader ever sees an empty lock and mistakes a starter mid-write for a stale
 * leftover. Removing a stale lock is a rename followed by a byte check, and
 * that is not mutual exclusion: A renames away the lock B just claimed, C takes
 * the vacant pathname, A's link-back fails, and B and C both run. Every
 * takeover is therefore serialized through a `.recovery` file beside the lock,
 * itself an exclusive claim, and the lock is re-judged inside it before
 * anything moves. A `.recovery` file is never removed by anyone but its
 * creator: with no OS-held lock that is the only sound rule, so a starter that
 * dies inside its takeover leaves starts refused, naming the file, until a
 * person removes it.
 */

import { link, mkdir, open, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { constants as fsConstants, readFileSync, readlinkSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "winston";
import { removeLockIfUnchanged } from "./setup-env-persistence.js";

const LOCK_FILE_NAME = "runtime.lock";

/** How often a holder refreshes its lock's mtime. */
const HEARTBEAT_MS = 15_000;
/** An owner nobody here can probe is stale after this long without a refresh. */
export const STALE_AFTER_MS = 60_000;
/** How long a starter waits for another starter's takeover to finish. */
const RECOVERY_WAIT_MS = 1_000;
const RECOVERY_POLL_MS = 25;
/** Judge-and-claim rounds before giving up to whoever holds the lock. */
const MAX_CLAIM_ATTEMPTS = 4;

export interface LockPayload {
  pid: number;
  startedAtIso: string;
  channel: string;
  /** The writer's hostname; absent in locks from versions before it was recorded. */
  host?: string;
  /** The writer's pid namespace (Linux), so containers sharing a hostname are told apart. */
  pidNamespace?: string;
  token?: string;
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
  return join(installStateDir(configRoot), `${installRootKey(installRoot)}.${kind}.lock`);
}

/** `<configRoot>/.strada/locks/`: where per-install runtime state files live. */
export function installStateDir(configRoot: string): string {
  return join(configRoot, ".strada", "locks");
}

/** The short hash of an install root that names its files in {@link installStateDir}. */
export function installRootKey(installRoot: string): string {
  const root = resolve(installRoot);
  return createHash("sha256")
    .update(process.platform === "win32" ? root.toLowerCase() : root)
    .digest("hex")
    .slice(0, 16);
}

/** Where versions before COR-21 keep the runtime lock; they look nowhere else. */
export function legacyRuntimeLockPath(installRoot: string): string {
  return join(installRoot, ".strada", LOCK_FILE_NAME);
}

export type AcquireResult =
  | { acquired: true; release: () => Promise<void> }
  | {
    acquired: false;
    holder: LockPayload;
    /** False when the holder runs on another host or in another container: it cannot be signalled from here. */
    local: boolean;
    /** Set when another starter's takeover of a stale lock is in progress or was left unfinished. */
    recoveryFile?: string;
  };

/**
 * Per-process state on globalThis, so a second copy of this module (a test
 * reset, a duplicated bundle) agrees with the first on which locks this
 * process wrote.
 */
const HELD_TOKENS_KEY = Symbol.for("strada.runtimeLock.heldTokens");
function heldTokens(): Set<string> {
  const registry = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  return (registry[HELD_TOKENS_KEY] ??= new Set());
}

let selfIdentity: { host: string; pidNamespace?: string } | undefined;
function ownIdentity(): { host: string; pidNamespace?: string } {
  selfIdentity ??= { host: hostname(), pidNamespace: readPidNamespace() };
  return selfIdentity;
}

/**
 * This process's pid namespace, qualified by the boot it belongs to (namespace
 * inode numbers are per kernel). Undefined off Linux, where there is none.
 */
function readPidNamespace(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return `${bootId}/${readlinkSync("/proc/self/ns/pid")}`;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 = existence probe. EPERM means "exists, owned by someone else".
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether `lock`'s pid names a process in this process's own pid namespace. */
function isLocalOwner(lock: LockPayload): boolean {
  const self = ownIdentity();
  return lock.host === undefined || (lock.host === self.host && lock.pidNamespace === self.pidNamespace);
}

interface LockState {
  raw: string;
  payload: LockPayload | null;
  mtimeMs: number;
}

/** Is the owner of the lock read as `state` still running? */
function holderIsLive(state: LockState): boolean {
  const lock = state.payload;
  if (!lock) return false; // corrupt/truncated lock → treated as stale
  if (lock.host === undefined) {
    // Written before owners recorded their host: judged by pid alone, as then.
    return lock.pid !== process.pid && isPidAlive(lock.pid);
  }
  if (isLocalOwner(lock)) {
    return lock.pid === process.pid
      ? lock.token !== undefined && heldTokens().has(lock.token)
      : isPidAlive(lock.pid);
  }
  // Another host or container: only its heartbeat can say it is alive.
  return Date.now() - state.mtimeMs < STALE_AFTER_MS;
}

async function readLockRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function readLockState(path: string): Promise<LockState | null> {
  const raw = await readLockRaw(path);
  if (raw === null) return null;
  try {
    return { raw, payload: parseLock(raw), mtimeMs: (await stat(path)).mtimeMs };
  } catch {
    return null; // removed between the read and the stat
  }
}

function parseLock(raw: string): LockPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid === "number") {
      return {
        pid: parsed.pid,
        startedAtIso: typeof parsed.startedAtIso === "string" ? parsed.startedAtIso : "",
        channel: typeof parsed.channel === "string" ? parsed.channel : "",
        ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
        ...(typeof parsed.pidNamespace === "string" ? { pidNamespace: parsed.pidNamespace } : {}),
        ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
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

/** {@link claim}, reporting a lost race as false. */
async function tryClaim(path: string, body: string, pauses?: RuntimeLockPauses): Promise<boolean> {
  try {
    await claim(path, body, pauses);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  }
}

/** Keep `path`'s mtime fresh while it still holds our claim. */
async function refreshIfOurs(path: string, body: string): Promise<void> {
  try {
    if ((await readFile(path, "utf-8")) !== body) return;
    const now = new Date();
    await utimes(path, now, now);
  } catch {
    // Gone or unreadable: there is nothing of ours to keep fresh.
  }
}

function refusal(state: LockState | null, recoveryFile?: string): AcquireResult {
  const holder = state?.payload ?? { pid: -1, startedAtIso: "", channel: "" };
  return {
    acquired: false,
    holder,
    local: holder.pid === -1 || isLocalOwner(holder),
    ...(recoveryFile ? { recoveryFile } : {}),
  };
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
    ...ownIdentity(),
    // Makes every claim's bytes unique, so "is it still ours" is exact.
    token: randomBytes(8).toString("hex"),
  };
  const body = JSON.stringify(payload);
  heldTokens().add(payload.token);
  const refuse = (result: AcquireResult): AcquireResult => {
    heldTokens().delete(payload.token);
    return result;
  };

  try {
    // A runtime from before COR-21 holds only the legacy lock. Reading it needs
    // nothing writable, so a read-only install root still gets this check.
    const legacyPath = legacyRuntimeLockPath(opts.installRoot);
    const legacy = await readLockState(legacyPath);
    if (legacy && holderIsLive(legacy)) return refuse(refusal(legacy));

    const primaryPath = installLockPath(opts.configRoot, opts.installRoot, "runtime");
    const primary = await claimLock(primaryPath, body, opts);
    if (!primary.acquired) return refuse(primary);

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
      return refuse(mirror);
    }

    const owned = mirror?.acquired ? [primaryPath, legacyPath] : [primaryPath];
    const heartbeat = setInterval(() => {
      for (const path of owned) void refreshIfOurs(path, body);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    let released = false;
    return {
      acquired: true,
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        await primary.release();
        if (mirror?.acquired) await mirror.release();
        heldTokens().delete(payload.token);
      },
    };
  } catch (e) {
    heldTokens().delete(payload.token);
    throw e;
  }
}

/** Claim `lockPath`, taking over a stale lock only through the serialized recovery. */
async function claimLock(
  lockPath: string,
  body: string,
  opts: { logger?: Logger; pauses?: RuntimeLockPauses },
): Promise<AcquireResult> {
  for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
    // The pauses are seams for the first judgement only.
    const pauses = attempt === 1 ? opts.pauses : undefined;
    const existing = await readLockState(lockPath);
    if (existing && holderIsLive(existing)) return refusal(existing);
    await pauses?.afterJudging?.();
    await mkdirSafe(dirname(lockPath));

    if (existing === null) {
      if (await tryClaim(lockPath, body, pauses)) return ownedLock(lockPath, body);
      continue; // a claim landed meanwhile: judge it
    }

    opts.logger?.info("Taking over stale runtime lock", {
      stalePid: existing.payload?.pid,
      staleHost: existing.payload?.host,
      startedAtIso: existing.payload?.startedAtIso,
    });
    const outcome = await takeOverStale(lockPath, existing.raw, body);
    if (outcome === "acquired") return ownedLock(lockPath, body);
    if (outcome === "busy" && !(await waitForRecovery(recoveryPath(lockPath)))) {
      return refusal(await readLockState(recoveryPath(lockPath)), recoveryPath(lockPath));
    }
  }
  return refusal(await readLockState(lockPath));
}

function recoveryPath(lockPath: string): string {
  return `${lockPath}.recovery`;
}

/**
 * Remove the stale lock read as `judgedRaw` and claim the pathname, inside the
 * recovery mutex. "busy": another starter is taking over; "retry": the lock
 * changed, came back to life, or someone else claimed the vacant pathname.
 */
async function takeOverStale(lockPath: string, judgedRaw: string, body: string): Promise<"acquired" | "retry" | "busy"> {
  const breaker = recoveryPath(lockPath);
  // The recovery file names its creator the way a lock does, for the refusal.
  if (!(await tryClaim(breaker, body))) return "busy";
  try {
    // Re-judged inside the mutex: a handover since the caller looked, or a
    // heartbeat that resumed, is seen before anything moves.
    const now = await readLockState(lockPath);
    if (!now || now.raw !== judgedRaw || holderIsLive(now)) return "retry";
    // Only recoverers remove another process's lock, and they are serialized,
    // so the rename moves exactly the lock judged here. A third starter may
    // still claim the pathname before we do; it then holds it alone.
    if (!(await removeLockIfUnchanged(lockPath, judgedRaw))) return "retry";
    return (await tryClaim(lockPath, body)) ? "acquired" : "retry";
  } finally {
    await unlink(breaker).catch(() => undefined);
  }
}

/** Wait for another starter's takeover to finish; false if its recovery file outlived the wait. */
async function waitForRecovery(breaker: string): Promise<boolean> {
  const deadline = Date.now() + RECOVERY_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(RECOVERY_POLL_MS);
    if ((await readLockRaw(breaker)) === null) return true;
  }
  return false;
}

function ownedLock(lockPath: string, body: string): AcquireResult {
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
