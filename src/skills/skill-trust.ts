// ---------------------------------------------------------------------------
// Workspace-skill trust records (plan 1.15 / audit 13F3 / D65 / Codex #23;
// hardened per Codex round 6 #6-#8, round 7 #10-#12 and round 9 #7-#8,
// 2026-09-17).
//
// A workspace-tier skill (`<project>/skills/<name>/`) has its `index.ts|js`
// dynamically imported by `loadSkillTools` — in-process, full privileges. Until
// 2026-09-17 nothing stood between "open a project" and "execute whatever its
// checkout put in skills/*/index.js". This module is that approval step.
//
// The record lives OUTSIDE the project, in the SQLite database
// `~/.strada/trusted-skills.db`, so a checkout cannot approve itself. It is
// keyed by the canonical identity of the project (realpath of the project root)
// and the skill's directory, and holds a sha256 over the skill's content: EVERY
// regular file under the skill directory (path + bytes, sorted), excluding only
// `.git/` (round 6 #6 — an index.js that loads a .json/.wasm/.node file, or a
// package.json "main"/"exports" map, changes behaviour without touching any
// .js; round 7 #10 — `node_modules/` is INCLUDED: an `index.js` importing
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
// MUTUAL EXCLUSION (round 9 #7/#8). Rounds 6-8 serialised approve/revoke
// through a JSON document replaced under a pid+token lock file. Three rounds of
// review never closed that protocol:
//   #7 — a stale-lock takeover could still displace a LIVE lock (taker B, which
//        remembered a dead owner, renamed A's fresh lock away; C then created a
//        lock in that gap, B's link-back failed with EEXIST and B deleted A's
//        lock), leaving A and C both inside the protected read-modify-write,
//        one of them writing a whole document that erased the other's record.
//        No pre-write token check can make a later rename atomic with ownership.
//   #8 — a crashed owner's REUSED pid made every acquisition see a live
//        process, ignore the lock's age, and time out forever.
// Both are properties of holding an ownership claim in a file that outlives its
// owner. So the lock file is gone, and the record lives in SQLite: mutual
// exclusion is the exclusive writer transaction, and the claim cannot outlive
// the connection holding it. A crashed writer's transaction is rolled back by
// the next connection and blocks nothing; pids appear nowhere; two writers
// cannot both believe they hold the record. Each mutation touches exactly its
// own (project, skill) row — there is no whole-document snapshot to lose a
// concurrent update, so a revocation is never resurrected by a concurrent
// approval of another skill.
//
// An existing `~/.strada/trusted-skills.json` is imported ONCE (records +
// migration marker in one transaction), then renamed to
// `trusted-skills.json.imported` so it can never become a second authority; a
// leftover `trusted-skills.json.lock` is removed with it and is inert either
// way — nothing reads it any more. Nobody has to re-approve their skills.
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
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

/** Shape of the pre-round-9 `~/.strada/trusted-skills.json`, kept for the import. */
export interface LegacyTrustedSkillsJson {
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

// ---------------------------------------------------------------------------
// Record location — always under the user's home, never in the project.
// ---------------------------------------------------------------------------

/** `~/.strada/trusted-skills.db`. Resolved at call time so a test HOME applies. */
export function trustedSkillsDbPath(): string {
  return join(homedir(), ".strada", "trusted-skills.db");
}

/** `~/.strada/trusted-skills.json` — the pre-round-9 record, imported once. */
export function legacyTrustedSkillsJsonPath(): string {
  return join(homedir(), ".strada", "trusted-skills.json");
}

// ---------------------------------------------------------------------------
// Trust record store (round 9 #7/#8): SQLite is the mutual exclusion.
// ---------------------------------------------------------------------------

/** One (project, skill) approval. */
export interface SkillTrustEntry {
  readonly skillKey: string;
  readonly record: TrustedSkillRecord;
}

export interface SkillTrustStore {
  /** The database backing this store. */
  readonly path: string;
  get(projectId: string, skillKey: string): TrustedSkillRecord | undefined;
  /** Every approval recorded for one project (diagnostics and tests). */
  list(projectId: string): readonly SkillTrustEntry[];
  /** Upsert exactly (projectId, skillKey) inside one immediate transaction. */
  approve(projectId: string, skillKey: string, record: TrustedSkillRecord): void;
  /** Delete exactly (projectId, skillKey). Returns whether a row existed. */
  revoke(projectId: string, skillKey: string): boolean;
  close(): void;
}

export interface SkillTrustStoreOptions {
  /** Defaults to {@link trustedSkillsDbPath}. */
  readonly path?: string;
  /**
   * How long a competing writer waits for the exclusive writer. Tests pass 0
   * so a second connection fails at once instead of blocking the test thread
   * that has to let the first one commit.
   */
  readonly busyTimeoutMs?: number;
  /** Set false to open the database without importing a legacy JSON record. */
  readonly importLegacyJson?: boolean;
}

/** Marker row that makes the legacy JSON import happen exactly once. */
export const LEGACY_JSON_IMPORT_MARKER = "import-trusted-skills-json-v1";

/** Default wait for the exclusive writer. */
const TRUST_BUSY_TIMEOUT_MS = 5_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trusted_skills (
  project_id      TEXT NOT NULL,
  skill_key       TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  file_count      INTEGER CHECK (file_count IS NULL OR file_count >= 0),
  approved_at_iso TEXT NOT NULL,
  PRIMARY KEY (project_id, skill_key)
);
CREATE TABLE IF NOT EXISTS trust_migrations (
  name       TEXT PRIMARY KEY NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

interface TrustRow {
  readonly skill_key: string;
  readonly sha256: string;
  readonly file_count: number | null;
  readonly approved_at_iso: string;
}

function rowToRecord(row: TrustRow): TrustedSkillRecord {
  return {
    sha256: row.sha256,
    fileCount: row.file_count === null ? undefined : row.file_count,
    approvedAtIso: row.approved_at_iso,
  };
}

/**
 * Open (creating if needed) the trust database. Mutations run as short
 * immediate transactions: SQLite's exclusive writer is the mutual exclusion,
 * and nothing about the claim survives this connection, so a crashed writer
 * cannot block the next one and no pid is ever consulted.
 */
export function openSkillTrustStore(options: SkillTrustStoreOptions = {}): SkillTrustStore {
  const path = options.path ?? trustedSkillsDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  // Trust records are a security boundary: pay for durability, not speed.
  db.pragma("synchronous = FULL");
  db.pragma(`busy_timeout = ${Math.max(0, options.busyTimeoutMs ?? TRUST_BUSY_TIMEOUT_MS)}`);
  db.pragma("temp_store = memory");

  // Only create the schema when it is actually missing: a plain `CREATE TABLE
  // IF NOT EXISTS` takes the write lock, which would make merely OPENING the
  // database fail while another process is committing.
  const tables = db
    .prepare<[], string>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('trusted_skills', 'trust_migrations')")
    .pluck()
    .all();
  if (tables.length < 2) db.exec(SCHEMA_SQL);

  if (options.importLegacyJson !== false) importLegacyJsonOnce(db, legacyTrustedSkillsJsonPath());

  const selectOne = db.prepare<[string, string], TrustRow>(
    "SELECT skill_key, sha256, file_count, approved_at_iso FROM trusted_skills WHERE project_id = ? AND skill_key = ?",
  );
  const selectProject = db.prepare<[string], TrustRow>(
    "SELECT skill_key, sha256, file_count, approved_at_iso FROM trusted_skills WHERE project_id = ? ORDER BY skill_key",
  );
  const upsert = db.prepare<[string, string, string, number | null, string]>(
    `INSERT INTO trusted_skills (project_id, skill_key, sha256, file_count, approved_at_iso)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, skill_key) DO UPDATE SET
       sha256 = excluded.sha256,
       file_count = excluded.file_count,
       approved_at_iso = excluded.approved_at_iso`,
  );
  const deleteOne = db.prepare<[string, string]>("DELETE FROM trusted_skills WHERE project_id = ? AND skill_key = ?");

  const approveTx = db.transaction((projectId: string, skillKey: string, record: TrustedSkillRecord): void => {
    upsert.run(projectId, skillKey, record.sha256, record.fileCount ?? null, record.approvedAtIso);
  });
  const revokeTx = db.transaction(
    (projectId: string, skillKey: string): boolean => deleteOne.run(projectId, skillKey).changes > 0,
  );

  return {
    path,
    get: (projectId, skillKey) => {
      const row = selectOne.get(projectId, skillKey);
      return row ? rowToRecord(row) : undefined;
    },
    list: (projectId) => selectProject.all(projectId).map((row) => ({ skillKey: row.skill_key, record: rowToRecord(row) })),
    approve: (projectId, skillKey, record) => approveTx.immediate(projectId, skillKey, record),
    revoke: (projectId, skillKey) => revokeTx.immediate(projectId, skillKey),
    close: () => db.close(),
  };
}

/**
 * Import `~/.strada/trusted-skills.json` into the database once, so nobody has
 * to re-approve a skill they already approved. Records and the migration
 * marker commit together; a database row always wins over the JSON (the
 * database is the only authority after this point). Afterwards the JSON is
 * renamed to `<path>.imported` and the dead `<path>.lock` removed, so neither
 * can become a second authority. A JSON that cannot be parsed imports nothing
 * and is left in place unmarked (the pre-round-9 reader treated it as empty
 * too, so there is nothing to lose and nothing to destroy).
 */
function importLegacyJsonOnce(db: Database.Database, jsonPath: string): number {
  if (!existsSync(jsonPath)) return 0;
  const marker = db.prepare<[string], number>("SELECT 1 FROM trust_migrations WHERE name = ?").pluck();
  if (marker.get(LEGACY_JSON_IMPORT_MARKER)) return 0;

  let projects: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as { projects?: unknown };
    if (!parsed || typeof parsed !== "object" || !parsed.projects || typeof parsed.projects !== "object") return 0;
    projects = parsed.projects as Record<string, unknown>;
  } catch {
    return 0;
  }

  const insert = db.prepare<[string, string, string, number | null, string]>(
    `INSERT INTO trusted_skills (project_id, skill_key, sha256, file_count, approved_at_iso)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, skill_key) DO NOTHING`,
  );
  const mark = db.prepare<[string, number]>("INSERT OR IGNORE INTO trust_migrations (name, applied_at) VALUES (?, ?)");

  const imported = db.transaction((): number => {
    // Another process may have imported while we waited for the write lock.
    if (marker.get(LEGACY_JSON_IMPORT_MARKER)) return 0;
    let count = 0;
    for (const [projectId, skills] of Object.entries(projects)) {
      if (!skills || typeof skills !== "object") continue;
      for (const [skillKey, raw] of Object.entries(skills as Record<string, unknown>)) {
        const record = raw as Partial<TrustedSkillRecord> | null;
        if (!record || typeof record !== "object" || typeof record.sha256 !== "string" || record.sha256.length === 0) continue;
        const fileCount =
          typeof record.fileCount === "number" && Number.isInteger(record.fileCount) && record.fileCount >= 0
            ? record.fileCount
            : null;
        const approvedAtIso =
          typeof record.approvedAtIso === "string" && record.approvedAtIso.length > 0
            ? record.approvedAtIso
            : new Date(0).toISOString();
        count += insert.run(projectId, skillKey, record.sha256, fileCount, approvedAtIso).changes;
      }
    }
    mark.run(LEGACY_JSON_IMPORT_MARKER, Date.now());
    return count;
  }).immediate();

  // The marker already prevents a reimport; these two only stop a stale file
  // from looking like it still means something.
  try {
    renameSync(jsonPath, `${jsonPath}.imported`);
  } catch {
    /* read-only home, or someone moved it first */
  }
  try {
    unlinkSync(`${jsonPath}.lock`);
  } catch {
    /* no leftover lock, or not ours to remove — either way nothing reads it */
  }
  return imported;
}

function withTrustStore<T>(fn: (store: SkillTrustStore) => T): T {
  const store = openSkillTrustStore();
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/**
 * The record for (project, skill), or `undefined`. A read never brings the
 * database into being: a home with neither a database nor a legacy JSON has
 * nothing to say, and asking must not create a file.
 */
function readTrustedRecord(projectId: string, skillKey: string): TrustedSkillRecord | undefined {
  if (!existsSync(trustedSkillsDbPath()) && !existsSync(legacyTrustedSkillsJsonPath())) return undefined;
  return withTrustStore((store) => store.get(projectId, skillKey));
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
  const howTo = `run \`strada skill trust ${skillName}\` in ${projectId} to approve it (recorded in ${trustedSkillsDbPath()})`;

  if (scan.symlinks.length > 0) {
    return { trusted: false, sha256, reason: symlinkRefusal(scan.symlinks) };
  }
  const key = await skillKey(projectId, skillPath);
  const record = readTrustedRecord(projectId, key);

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
 * (round 6 #7). The scan and hash happen outside the transaction; only the
 * single-row upsert is inside it.
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
  withTrustStore((store) => {
    store.approve(projectId, key, { sha256, fileCount, approvedAtIso: new Date().toISOString() });
  });
  return { projectId, skillKey: key, sha256, fileCount, recordPath: trustedSkillsDbPath() };
}

/** Remove the record for (project, skill). Returns whether one existed. */
export async function revokeWorkspaceSkill(projectRoot: string, skillPath: string): Promise<boolean> {
  const projectId = await projectIdentity(projectRoot);
  const key = await skillKey(projectId, skillPath);
  return withTrustStore((store) => store.revoke(projectId, key));
}
