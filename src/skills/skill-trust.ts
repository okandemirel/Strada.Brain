// ---------------------------------------------------------------------------
// Workspace-skill trust records (plan 1.15 / audit 13F3 / D65 / Codex #23;
// hardened per Codex round 6 #6-#8 and round 7 #10-#12, 2026-09-17).
//
// A workspace-tier skill (`<project>/skills/<name>/`) has its `index.ts|js`
// dynamically imported by `loadSkillTools` — in-process, full privileges. Until
// 2026-09-17 nothing stood between "open a project" and "execute whatever its
// checkout put in skills/*/index.js". This module is that approval step.
//
// The record lives OUTSIDE the project, at `~/.strada/trusted-skills.json`,
// so a checkout cannot approve itself. It is keyed by the canonical identity
// of the project (realpath of the project root) and the skill's directory,
// and holds a sha256 over the skill's content: EVERY regular file under the
// skill directory (path + bytes, sorted), excluding only `.git/` (round 6 #6 —
// an index.js that loads a .json/.wasm/.node file, or a package.json
// "main"/"exports" map, changes behaviour without touching any .js; round 7
// #10 — `node_modules/` is INCLUDED: an `index.js` importing
// `./node_modules/dep/index.js` runs those bytes with the same privileges, so
// replacing the dependency must invalidate the approval). The record also
// stores the file count. A record whose hash no longer matches means the
// content changed since approval, and the skill is untrusted again until
// re-approved.
//
// Symlinks are never followed while hashing, and a skill whose directory
// holds any symlink (the entry point or anything else) cannot be approved at
// all (round 6 #7): the target can change without the hash changing.
//
// The scan is budgeted (round 7 #11): files are streamed into the hash
// through one reused 64 KiB buffer (a gigabyte asset never means a gigabyte
// allocation), and the walk FAILS CLOSED at `SKILL_SCAN_MAX_FILES`,
// `SKILL_SCAN_MAX_BYTES` and `SKILL_SCAN_MAX_DEPTH`: a skill over budget gets
// no hash and an "untrusted" verdict naming the limit, and cannot be approved
// until it is shrunk. The limits are injectable (`SkillScanLimits`) for tests.
//
// Approve/revoke serialise through a cross-process lock file next to the
// record and replace it atomically (temp file + rename), so two concurrent
// read-modify-write sequences cannot resurrect a revocation (round 6 #8). The
// lock carries an ownership token (pid + random) (round 7 #12): a held lock is
// only taken over when its owning pid is no longer alive; the acquisition
// deadline runs on a monotonic clock; the file's mtime is consulted only as a
// last resort when the owner cannot be read from the file; and release
// unlinks the lock only when it still carries our token.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrustedSkillRecord {
  /** sha256 over the skill's content (every regular file) at approval time. */
  readonly sha256: string;
  /** Number of regular files the hash covered. Absent on pre-round-6 records. */
  readonly fileCount?: number;
  readonly approvedAtIso: string;
}

export interface TrustedSkillsFile {
  readonly version: 1;
  /** projectId (realpath of the project root) → skillKey (dir relative to root) → record */
  readonly projects: Record<string, Record<string, TrustedSkillRecord>>;
}

export type SkillTrustVerdict =
  | { readonly trusted: true; readonly sha256: string | null }
  /** `sha256` is null when the scan stopped at a limit (round 7 #11) and produced no hash. */
  | { readonly trusted: false; readonly reason: string; readonly sha256: string | null };

/** Budget for one scan of a skill directory (round 7 #11). */
export interface SkillScanLimits {
  /** Maximum number of regular files hashed. */
  readonly maxFiles: number;
  /** Maximum total bytes streamed into the hash. */
  readonly maxBytes: number;
  /** Maximum nesting: a path with more than this many segments is out of budget. */
  readonly maxDepth: number;
}

/** Which limit a scan hit, and where. */
export interface SkillScanLimitBreach {
  readonly limit: "files" | "bytes" | "depth";
  readonly max: number;
  /** Relative path (from the skill directory) at which the budget ran out. */
  readonly at: string;
}

interface SkillContentScanBase {
  /** Number of regular files hashed (or seen, when the scan stopped early). */
  readonly fileCount: number;
  /** Bytes streamed into the hash (or counted before the scan stopped). */
  readonly byteCount: number;
  /** Relative paths of every symlink met (never followed). Non-empty → not approvable. */
  readonly symlinks: readonly string[];
  /** The executable entry point present at the top level (`index.ts`/`index.js`), if any. */
  readonly entryPoint: string | null;
}

/** What a walk of the skill directory found. */
export type SkillContentScan =
  | (SkillContentScanBase & {
      /** sha256 over every hashed file (`<relpath>\0<bytes>\0`, sorted by relpath). */
      readonly sha256: string;
      readonly exceeded: null;
    })
  | (SkillContentScanBase & {
      /** No hash: the scan stopped at `exceeded` (round 7 #11). */
      readonly sha256: null;
      readonly exceeded: SkillScanLimitBreach;
    });

const ENTRY_POINTS = ["index.ts", "index.js"];
/** Directory names excluded from the hash (see the module comment). `node_modules` is NOT here (round 7 #10). */
const EXCLUDED_DIRS = new Set([".git"]);

/** Scan budget (round 7 #11). Exceeding any of these fails closed. */
export const SKILL_SCAN_MAX_FILES = 5_000;
export const SKILL_SCAN_MAX_BYTES = 200 * 1024 * 1024;
export const SKILL_SCAN_MAX_DEPTH = 12;
export const DEFAULT_SKILL_SCAN_LIMITS: SkillScanLimits = Object.freeze({
  maxFiles: SKILL_SCAN_MAX_FILES,
  maxBytes: SKILL_SCAN_MAX_BYTES,
  maxDepth: SKILL_SCAN_MAX_DEPTH,
});
/** Size of the single reused read buffer files are streamed through. */
const SCAN_CHUNK_BYTES = 64 * 1024;

/** Lock parameters (round 6 #8, round 7 #12). */
const LOCK_TIMEOUT_MS = 5_000;
/** Last-resort staleness by mtime — used only when the lock file names no readable owner pid. */
const LOCK_STALE_MS = 30_000;
const LOCK_BACKOFF_MIN_MS = 5;
const LOCK_BACKOFF_MAX_MS = 100;

// ---------------------------------------------------------------------------
// Record file location — always under the user's home, never in the project.
// ---------------------------------------------------------------------------

/** `~/.strada/trusted-skills.json`. Resolved at call time so a test HOME applies. */
export function trustedSkillsPath(): string {
  return join(homedir(), ".strada", "trusted-skills.json");
}

/** `~/.strada/trusted-skills.json.lock` — the cross-process lock around read-modify-write. */
export function trustedSkillsLockPath(): string {
  return trustedSkillsPath() + ".lock";
}

function parseTrustFile(raw: string): TrustedSkillsFile {
  const parsed = JSON.parse(raw) as Partial<TrustedSkillsFile>;
  if (!parsed || typeof parsed !== "object" || !parsed.projects || typeof parsed.projects !== "object") {
    return { version: 1, projects: {} };
  }
  return { version: 1, projects: parsed.projects };
}

async function readTrustFile(): Promise<TrustedSkillsFile> {
  try {
    return parseTrustFile(await readFile(trustedSkillsPath(), "utf-8"));
  } catch {
    return { version: 1, projects: {} };
  }
}

/**
 * Atomic replace: the new content goes to a temp file in the same directory
 * and is renamed over the record, so a reader never sees a half-written file
 * and a crash mid-write leaves the previous record intact.
 */
async function writeTrustFileAtomically(file: TrustedSkillsFile): Promise<void> {
  const path = trustedSkillsPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", "utf-8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cross-process lock (round 6 #8, round 7 #12)
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface LockOwner {
  readonly pid: number;
  readonly token: string;
}

/** Lock file line: `<pid> <token> <iso>`. */
function formatLockOwner(owner: LockOwner): string {
  return `${owner.pid} ${owner.token} ${new Date().toISOString()}\n`;
}

/**
 * Read the owner recorded in the lock file. `null` when the file cannot be
 * read (gone) — the caller distinguishes that from an unparseable file by
 * `readable`.
 */
async function readLockOwner(lockPath: string): Promise<{ readable: boolean; owner: LockOwner | null; raw: string }> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf-8");
  } catch {
    return { readable: false, owner: null, raw: "" };
  }
  const [pidText, token] = raw.trim().split(/\s+/);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0 || !token) return { readable: true, owner: null, raw };
  return { readable: true, owner: { pid, token }, raw };
}

/** Whether a process with this pid exists (EPERM means it does, just not ours). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Remove the lock we judged abandoned — THAT lock, not whatever happens to sit
 * at the path now.
 *
 * Renaming first is atomic, but rename alone still stole a live lock (Codex
 * 2026-09-17 round 8 #16): two takers read the same dead owner, the first
 * renamed it away and created its own fresh lock, and the second — delayed
 * between its read and its rename — renamed THE FIRST TAKER'S lock into its
 * grave and acquired the file too. Both then believed they held it.
 *
 * So the bytes are verified after the rename: they must be the bytes we
 * judged. Anything else belongs to a live owner and is LINKED BACK
 * immediately; `link` fails when a third lock already exists, which is the
 * fail-closed answer — we never hold a lock we did not create. The return
 * value says whether the abandoned lock was actually removed.
 */
export async function takeOverStaleLock(lockPath: string, expected: string): Promise<boolean> {
  const grave = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    await rename(lockPath, grave);
  } catch {
    return false;
  }
  let graveRaw: string | null = null;
  try {
    graveRaw = await readFile(grave, "utf-8");
  } catch {
    graveRaw = null;
  }
  if (graveRaw !== expected) {
    // Someone else's lock: put it back where its owner expects it. A newer
    // lock at the path makes `link` fail with EEXIST; that owner holds it and
    // we simply do not steal.
    await link(grave, lockPath).catch(() => undefined);
    await rm(grave, { force: true }).catch(() => undefined);
    return false;
  }
  await rm(grave, { force: true }).catch(() => undefined);
  return true;
}

/**
 * Acquire `trusted-skills.json.lock` by creating it exclusively (`wx`) with
 * our ownership token (pid + random). On EEXIST, the holder is inspected: a
 * lock whose owning pid is no longer alive is taken over; a lock held by a
 * live pid is waited for, however old the file is (a clock jump cannot let a
 * second writer in). Only when the file names no readable owner does the
 * mtime-based ceiling (`LOCK_STALE_MS`) apply, as a last resort. The wait is
 * bounded by `LOCK_TIMEOUT_MS` on a monotonic clock. Returns the lock: a
 * `release` that unlinks the file only while it still carries our token, and
 * an `isHeld` check used before the record is replaced.
 */
async function acquireTrustFileLock(): Promise<{ release: () => Promise<void>; isHeld: () => Promise<boolean> }> {
  const lockPath = trustedSkillsLockPath();
  await mkdir(dirname(lockPath), { recursive: true });
  const mine: LockOwner = { pid: process.pid, token: `${process.pid}-${randomBytes(12).toString("hex")}` };
  const startedAt = performance.now();
  const remaining = (): number => LOCK_TIMEOUT_MS - (performance.now() - startedAt);
  let backoff = LOCK_BACKOFF_MIN_MS;
  // A crashed owner is taken over at most ONCE per acquisition; afterwards
  // this acquisition waits for the holder instead of stealing again.
  let triedTakeover = false;

  const isHeld = async (): Promise<boolean> => (await readLockOwner(lockPath)).owner?.token === mine.token;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(formatLockOwner(mine), "utf-8");
      } finally {
        await handle.close();
      }
      return {
        isHeld,
        release: async () => {
          // Verify the token before unlinking: a lock that was taken over and
          // re-created by someone else is theirs to remove, not ours.
          if (!(await isHeld())) return;
          await rm(lockPath, { force: true }).catch(() => undefined);
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // Held by someone. Abandoned?
    const { readable, owner, raw } = await readLockOwner(lockPath);
    if (!readable) {
      // Released between our open() and read(); retry immediately.
      continue;
    }
    if (owner) {
      if (!pidAlive(owner.pid) && !triedTakeover) {
        // ONE takeover attempt per acquisition, and only of the bytes we
        // judged: a second steal is refused and we wait for the holder
        // instead (round 8 #16 — fail closed rather than steal).
        triedTakeover = true;
        await takeOverStaleLock(lockPath, raw);
        continue;
      }
    } else {
      // No owner recorded (foreign or truncated file): mtime is the last resort.
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS && !triedTakeover) {
          triedTakeover = true;
          await takeOverStaleLock(lockPath, raw);
          continue;
        }
      } catch {
        continue;
      }
    }

    if (remaining() <= 0) {
      const holder = owner ? `pid ${owner.pid}` : "an unknown process";
      throw new Error(`Timed out after ${LOCK_TIMEOUT_MS} ms waiting for ${lockPath} (held by ${holder})`);
    }
    await sleep(Math.min(backoff, Math.max(0, remaining())));
    backoff = Math.min(backoff * 2, LOCK_BACKOFF_MAX_MS);
  }
}

/**
 * Locked read-modify-write of the record file. The mutator receives the
 * current file and returns the file to write (or `null` to leave it as is).
 * The record is replaced only while the lock still carries our token; if it
 * was taken over meanwhile, the write is refused rather than clobbering a
 * newer record. Exported for the concurrency test; approve/revoke go through it.
 */
export async function updateTrustFile<T>(
  mutate: (file: TrustedSkillsFile) => Promise<{ next: TrustedSkillsFile | null; result: T }> | { next: TrustedSkillsFile | null; result: T },
): Promise<T> {
  const lock = await acquireTrustFileLock();
  try {
    const current = await readTrustFile();
    const { next, result } = await mutate(current);
    if (next) {
      if (!(await lock.isHeld())) {
        throw new Error(`Lost ${trustedSkillsLockPath()} while updating ${trustedSkillsPath()}; the record was not written — retry`);
      }
      await writeTrustFileAtomically(next);
    }
    return result;
  } finally {
    await lock.release();
  }
}

// ---------------------------------------------------------------------------
// Identity + hashing
// ---------------------------------------------------------------------------

/** Canonical project identity: the realpath of the project root. */
export async function projectIdentity(projectRoot: string): Promise<string> {
  try {
    return await realpath(projectRoot);
  } catch {
    return projectRoot;
  }
}

/**
 * The key a skill directory gets inside its project's record: its path
 * relative to the canonical project root (e.g. `skills/deploy`), or just the
 * directory name when it does not sit under the root.
 */
export async function skillKey(projectId: string, skillPath: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(skillPath);
  } catch {
    real = skillPath;
  }
  const rel = relative(projectId, real);
  if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) return basename(real);
  return rel.split(sep).join("/");
}

/**
 * Walk the skill directory and hash EVERY regular file under it (sorted by
 * relative path; each contributes `<relpath>\0<bytes>\0`), skipping only
 * `.git/` directories — `node_modules/` is hashed like any other code (round
 * 7 #10). Symlinks — files or directories — are never followed; they are
 * reported in `symlinks`. Files are streamed into the hash through one
 * reused buffer, and the scan stops (with `exceeded` set and no hash) as
 * soon as `limits` is crossed (round 7 #11). Returns `null` when the
 * directory holds no regular file at all (or cannot be read).
 */
export async function scanSkillContent(
  skillPath: string,
  limits: SkillScanLimits = DEFAULT_SKILL_SCAN_LIMITS,
): Promise<SkillContentScan | null> {
  const files: string[] = [];
  const symlinks: string[] = [];
  let entryPoint: string | null = null;
  let exceeded: SkillScanLimitBreach | null = null;
  const toRel = (full: string): string => relative(skillPath, full).split(sep).join("/");

  // `depth` = number of path segments of the entries listed in `dir`.
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth === 1) {
      // Decide the entry point from the complete top-level listing, before any
      // recursion can stop the scan.
      entryPoint = ENTRY_POINTS.find((name) => entries.some((e) => e.name === name && !e.isDirectory())) ?? null;
    }
    for (const entry of entries) {
      if (exceeded) return;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(toRel(full));
        continue;
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (depth + 1 > limits.maxDepth) {
          exceeded = { limit: "depth", max: limits.maxDepth, at: toRel(full) };
          return;
        }
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (files.length + 1 > limits.maxFiles) {
          exceeded = { limit: "files", max: limits.maxFiles, at: toRel(full) };
          return;
        }
        files.push(full);
      }
    }
  };
  await walk(skillPath, 1);
  if (files.length === 0 && symlinks.length === 0 && !exceeded) return null;
  symlinks.sort();

  const rels = files
    .map((f) => ({ full: f, rel: toRel(f) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  let byteCount = 0;
  for (const { full, rel } of rels) {
    if (exceeded) break;
    hash.update(rel);
    hash.update("\0");
    const handle = await open(full, "r");
    try {
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, SCAN_CHUNK_BYTES, null);
        if (bytesRead === 0) break;
        byteCount += bytesRead;
        if (byteCount > limits.maxBytes) {
          exceeded = { limit: "bytes", max: limits.maxBytes, at: rel };
          break;
        }
        hash.update(chunk.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    hash.update("\0");
  }
  const base = { fileCount: rels.length, byteCount, symlinks, entryPoint };
  if (exceeded) return { ...base, sha256: null, exceeded };
  return { ...base, sha256: hash.digest("hex"), exceeded: null };
}

/** The sha256 of `scanSkillContent`, or `null` when there is nothing to hash (or the scan stopped at a limit). */
export async function hashSkillContent(skillPath: string, limits?: SkillScanLimits): Promise<string | null> {
  return (await scanSkillContent(skillPath, limits))?.sha256 ?? null;
}

function limitRefusal(breach: SkillScanLimitBreach): string {
  const what =
    breach.limit === "files" ? `more than ${breach.max} files`
    : breach.limit === "bytes" ? `more than ${breach.max} bytes`
    : `nesting deeper than ${breach.max} levels`;
  return `Workspace skill exceeds the scan limit (${breach.limit}: ${what}, reached at ${breach.at}), so its content cannot be hashed; shrink the skill directory to approve it`;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * Decide whether a workspace-tier skill's code may be imported for this
 * project. A skill over the scan budget is never trusted (fail closed). A
 * skill with no entry point imports nothing (`loadSkillTools` returns before
 * any `import()`), so there is nothing to approve and it is trusted
 * trivially. A skill whose directory holds a symlink is never trusted.
 * Otherwise a record for (project, skill) must exist AND its hash must equal
 * the current hash of the skill's content.
 */
export async function assessWorkspaceSkillTrust(
  projectRoot: string,
  skillPath: string,
  skillName: string,
  limits?: SkillScanLimits,
): Promise<SkillTrustVerdict> {
  const scan = await scanSkillContent(skillPath, limits);
  if (scan?.exceeded) {
    return { trusted: false, sha256: null, reason: limitRefusal(scan.exceeded) };
  }
  if (!scan || scan.entryPoint === null) {
    return { trusted: true, sha256: null };
  }
  const { sha256 } = scan;
  const projectId = await projectIdentity(projectRoot);
  const howTo = `run \`strada skill trust ${skillName}\` in ${projectId} to approve it (recorded in ${trustedSkillsPath()})`;

  if (scan.symlinks.length > 0) {
    return { trusted: false, sha256, reason: symlinkRefusal(scan.symlinks) };
  }
  const key = await skillKey(projectId, skillPath);
  const record = (await readTrustFile()).projects[projectId]?.[key];

  if (!record) {
    return {
      trusted: false,
      sha256,
      reason: `Workspace skill code is not approved for this project — ${howTo}`,
    };
  }
  if (record.sha256 !== sha256 || (record.fileCount !== undefined && record.fileCount !== scan.fileCount)) {
    const files = record.fileCount !== undefined ? `, ${record.fileCount} -> ${scan.fileCount} file(s)` : "";
    return {
      trusted: false,
      sha256,
      reason:
        `Workspace skill content changed since approval (sha256 ${record.sha256.slice(0, 12)} -> ${sha256.slice(0, 12)}${files}) — ` +
        howTo,
    };
  }
  return { trusted: true, sha256 };
}

function symlinkRefusal(symlinks: readonly string[]): string {
  return `Workspace skill holds symlinked code, which cannot be approved (its target can change without the hash changing): ${symlinks.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Approve / revoke
// ---------------------------------------------------------------------------

export interface ApprovalResult {
  readonly projectId: string;
  readonly skillKey: string;
  readonly sha256: string;
  readonly fileCount: number;
  readonly recordPath: string;
}

/**
 * Record the skill's CURRENT content as approved for this project. Throws
 * when the scan exceeds its budget (round 7 #11), when the directory has no
 * entry point (nothing is executed, nothing to approve) or holds a symlink
 * (round 6 #7).
 */
export async function approveWorkspaceSkill(
  projectRoot: string,
  skillPath: string,
  limits?: SkillScanLimits,
): Promise<ApprovalResult> {
  const scan = await scanSkillContent(skillPath, limits);
  if (scan?.exceeded) {
    throw new Error(`Cannot approve ${skillPath}: ${limitRefusal(scan.exceeded)}`);
  }
  if (!scan || scan.entryPoint === null) {
    throw new Error(`Nothing to approve: ${skillPath} has no entry point (${ENTRY_POINTS.join("/")}), so no code of it is executed`);
  }
  if (scan.symlinks.length > 0) {
    throw new Error(`Cannot approve ${skillPath}: ${symlinkRefusal(scan.symlinks)}`);
  }
  const { sha256, fileCount } = scan;
  const projectId = await projectIdentity(projectRoot);
  const key = await skillKey(projectId, skillPath);
  await updateTrustFile((file) => {
    const projects: Record<string, Record<string, TrustedSkillRecord>> = { ...file.projects };
    projects[projectId] = {
      ...(projects[projectId] ?? {}),
      [key]: { sha256, fileCount, approvedAtIso: new Date().toISOString() },
    };
    return { next: { version: 1, projects }, result: undefined };
  });
  return { projectId, skillKey: key, sha256, fileCount, recordPath: trustedSkillsPath() };
}

/** Remove the record for (project, skill). Returns whether one existed. */
export async function revokeWorkspaceSkill(projectRoot: string, skillPath: string): Promise<boolean> {
  const projectId = await projectIdentity(projectRoot);
  const key = await skillKey(projectId, skillPath);
  return updateTrustFile((file) => {
    const project = file.projects[projectId];
    if (!project || !(key in project)) return { next: null, result: false };
    const rest: Record<string, TrustedSkillRecord> = { ...project };
    delete rest[key];
    const projects: Record<string, Record<string, TrustedSkillRecord>> = { ...file.projects };
    if (Object.keys(rest).length === 0) {
      delete projects[projectId];
    } else {
      projects[projectId] = rest;
    }
    return { next: { version: 1, projects }, result: true };
  });
}
