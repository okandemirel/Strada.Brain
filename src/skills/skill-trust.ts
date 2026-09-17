// ---------------------------------------------------------------------------
// Workspace-skill trust records (plan 1.15 / audit 13F3 / D65 / Codex #23;
// hardened per Codex round 6 #6-#8, 2026-09-17).
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
// skill directory (path + bytes, sorted), excluding only `node_modules/` and
// `.git/` (round 6 #6 — an index.js that loads a .json/.wasm/.node file, or a
// package.json "main"/"exports" map, changes behaviour without touching any
// .js). The record also stores the file count. A record whose hash no longer
// matches means the content changed since approval, and the skill is
// untrusted again until re-approved.
//
// Symlinks are never followed while hashing, and a skill whose directory
// holds any symlink (the entry point or anything else) cannot be approved at
// all (round 6 #7): the target can change without the hash changing.
//
// Approve/revoke serialise through a cross-process lock file next to the
// record and replace it atomically (temp file + rename), so two concurrent
// read-modify-write sequences cannot resurrect a revocation (round 6 #8).
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

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
  | { readonly trusted: false; readonly reason: string; readonly sha256: string };

/** What a walk of the skill directory found. */
export interface SkillContentScan {
  /** sha256 over every hashed file (`<relpath>\0<bytes>\0`, sorted by relpath). */
  readonly sha256: string;
  /** Number of regular files hashed. */
  readonly fileCount: number;
  /** Relative paths of every symlink met (never followed). Non-empty → not approvable. */
  readonly symlinks: readonly string[];
  /** The executable entry point present at the top level (`index.ts`/`index.js`), if any. */
  readonly entryPoint: string | null;
}

const ENTRY_POINTS = ["index.ts", "index.js"];
/** Directory names excluded from the hash (see the module comment). */
const EXCLUDED_DIRS = new Set(["node_modules", ".git"]);

/** Lock parameters (round 6 #8). */
const LOCK_TIMEOUT_MS = 5_000;
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
// Cross-process lock (round 6 #8)
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquire `trusted-skills.json.lock` by creating it exclusively (`wx`). On
 * EEXIST, retry with backoff for up to ~5 s; a lock older than 30 s is
 * considered abandoned by a dead process and is removed. Returns the release
 * function.
 */
async function acquireTrustFileLock(): Promise<() => Promise<void>> {
  const lockPath = trustedSkillsLockPath();
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let backoff = LOCK_BACKOFF_MIN_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf-8");
      } finally {
        await handle.close();
      }
      return async () => {
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    // Held by someone. Stale?
    try {
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
    } catch {
      // Released between our open() and stat(); retry immediately.
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${LOCK_TIMEOUT_MS} ms waiting for ${lockPath} (held by another strada process?)`);
    }
    await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())));
    backoff = Math.min(backoff * 2, LOCK_BACKOFF_MAX_MS);
  }
}

/**
 * Locked read-modify-write of the record file. The mutator receives the
 * current file and returns the file to write (or `null` to leave it as is).
 * Exported for the concurrency test; approve/revoke go through it.
 */
export async function updateTrustFile<T>(
  mutate: (file: TrustedSkillsFile) => Promise<{ next: TrustedSkillsFile | null; result: T }> | { next: TrustedSkillsFile | null; result: T },
): Promise<T> {
  const release = await acquireTrustFileLock();
  try {
    const current = await readTrustFile();
    const { next, result } = await mutate(current);
    if (next) await writeTrustFileAtomically(next);
    return result;
  } finally {
    await release();
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
 * `node_modules/` and `.git/` directories. Symlinks — files or directories —
 * are never followed; they are reported in `symlinks`. Returns `null` when
 * the directory holds no regular file at all (or cannot be read).
 */
export async function scanSkillContent(skillPath: string): Promise<SkillContentScan | null> {
  const files: string[] = [];
  const symlinks: string[] = [];
  let entryPoint: string | null = null;
  const toRel = (full: string): string => relative(skillPath, full).split(sep).join("/");

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (depth === 0 && ENTRY_POINTS.includes(entry.name) && entryPoint === null) {
        entryPoint = entry.name;
      }
      if (entry.isSymbolicLink()) {
        symlinks.push(toRel(full));
        continue;
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  await walk(skillPath, 0);
  if (files.length === 0 && symlinks.length === 0) return null;

  const rels = files
    .map((f) => ({ full: f, rel: toRel(f) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  for (const { full, rel } of rels) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(full));
    hash.update("\0");
  }
  symlinks.sort();
  return { sha256: hash.digest("hex"), fileCount: rels.length, symlinks, entryPoint };
}

/** The sha256 of `scanSkillContent`, or `null` when there is nothing to hash. */
export async function hashSkillContent(skillPath: string): Promise<string | null> {
  return (await scanSkillContent(skillPath))?.sha256 ?? null;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * Decide whether a workspace-tier skill's code may be imported for this
 * project. A skill with no entry point imports nothing (`loadSkillTools`
 * returns before any `import()`), so there is nothing to approve and it is
 * trusted trivially. A skill whose directory holds a symlink is never
 * trusted. Otherwise a record for (project, skill) must exist AND its hash
 * must equal the current hash of the skill's content.
 */
export async function assessWorkspaceSkillTrust(
  projectRoot: string,
  skillPath: string,
  skillName: string,
): Promise<SkillTrustVerdict> {
  const scan = await scanSkillContent(skillPath);
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
 * when the directory has no entry point (nothing is executed, nothing to
 * approve) or holds a symlink (round 6 #7).
 */
export async function approveWorkspaceSkill(projectRoot: string, skillPath: string): Promise<ApprovalResult> {
  const scan = await scanSkillContent(skillPath);
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
