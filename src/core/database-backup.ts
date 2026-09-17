/**
 * Database backup (14F3 / D72).
 *
 * `scripts/backup.sh` used to back up exactly one database — `learning.db` —
 * with `cp`, under a hardcoded `.strada-memory` path that ignored
 * `MEMORY_DB_PATH`. Both halves of that were wrong:
 *
 *   - The runtime keeps a dozen SQLite databases side by side under the memory
 *     root (memory.db, campaigns.db, goals.db, daemon.db, tasks.db, …). A
 *     "backup" that captured one of them and silently skipped the rest is a
 *     restore that loses the campaign, the goal DAG, the task queue and every
 *     identity.
 *   - `cp` of a live SQLite database in WAL mode copies the main file without
 *     the -wal that holds the most recent commits. The copy opens, and it is
 *     missing data that the application was told was durable. There is no
 *     error anywhere in that sequence.
 *
 *   - Not every runtime database is under the memory root (round 10 #22). A
 *     default installation keeps `hub-owners.db` — which chat belongs to which
 *     channel — and `trusted-skills.db` — which skills a project has approved —
 *     in the Strada home (`~/.strada`). Listing "hub-owners.db" under the
 *     MEMORY directory does not find the file that exists, so both were absent
 *     from a backup that reported success, and a restore came back with no
 *     bindings and no approvals.
 *
 * This module builds the list from the runtime path table — every ROOT the
 * runtime puts databases in (the memory root AND the Strada home), the known
 * files of each, plus whatever `*.db` those directories actually hold, so a
 * database added tomorrow is not silently skipped — and copies each with
 * SQLite's own online backup API — `better-sqlite3`'s `db.backup()` — which is
 * safe while writes are in flight and produces a consistent, checkpointed file.
 *
 * Each database is filed under its root in the destination and recorded in
 * `databases.manifest.json` with the absolute path it came from, so a restore
 * puts every file back where its owner reads it instead of flattening two roots
 * into one directory (where `identity.db` from either root would overwrite the
 * other). {@link restoreRuntimeDatabases} is that restore.
 *
 * Round 11 #2 and #19 are the two ways that was still not a backup:
 *
 *   - #2 (data loss): the restore DELETED the destination database and its
 *     WAL/SHM and only then opened the backup. A manifest naming a file that is
 *     missing, truncated or corrupt therefore destroyed a perfectly good live
 *     database and threw afterwards. Every source is now validated before
 *     anything is touched, each replacement is STAGED beside its destination
 *     (copied, integrity-checked, path-rebased) and only then swapped in, with
 *     the original kept aside until the swap is complete and rolled back if it
 *     is not. A failed restore leaves every live database and every committed
 *     row exactly as it was, and says why.
 *
 *   - #19: not every persistent byte is an installation-owned database. A
 *     PROJECT owns `<projectRoot>/.strada/delivery-packages.db` — every delivery
 *     revision a reviewer can still open — and the attachment store keeps files
 *     larger than its inline limit as retained blobs in a spool directory that
 *     its ROWS name by absolute path. Neither was in the backup: a restored
 *     installation lost every package revision and served 404s for attachment
 *     rows that still promised bytes. Both are inventoried now, the spool
 *     directory's name coming from the store itself, and a restore into a
 *     different root REBASES the rows that name the old one.
 *
 * It doubles as the CLI that `scripts/backup.sh` invokes:
 *   node dist/core/database-backup.js --source <memoryRoot> --dest <dir>
 *       [--strada-home <dir>] [--user-home <dir>] [--project-root <dir>]
 *       [--timestamp <ts>]
 */

import Database from "better-sqlite3";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStradaHome } from "../common/runtime-paths.js";
// The spool's directory name comes FROM the store that writes it: the store
// owns where a retained copy lives (`join(dirname(dbPath), RETAINED_ATTACHMENT_DIR)`)
// and a name retyped here would go stale the day it moves (#19).
import {
  PENDING_ATTACHMENT_DIR,
  RETAINED_ATTACHMENT_DIR,
} from "../channels/web/web-attachment-store.js";

/**
 * The databases the runtime creates under `memory.dbPath`.
 *
 * Kept as data rather than inlined in a shell script so the backup and the
 * runtime cannot disagree about what exists. Discovery below covers anything
 * this list has not caught up with yet.
 *
 * `hub-owners.db` used to be in here; it is not under the memory root, and a
 * name listed against the wrong directory never matched a file (#22).
 */
export const MEMORY_DATABASE_FILES: readonly string[] = [
  "campaigns.db",
  "canvas.db",
  "daemon.db",
  "dynamic-profiles.db",
  "framework-knowledge.db",
  "goals.db",
  "identity.db",
  "learning.db",
  "memory.db",
  "model-intelligence.db",
  "provider-preferences.db",
  "task-checkpoints.db",
  "tasks.db",
  "web-attachments.db",
  "web-identities.db",
];

/**
 * The databases the runtime creates in the Strada home (`~/.strada`).
 *
 * `hub-owners.db` is `HubOwnerStore.defaultPath()` — `<strada home>/` — and
 * `trusted-skills.db` is `trustedSkillsDbPath()` — `~/.strada/`. Losing them
 * loses every chat→channel binding and every skill approval a project made,
 * which is exactly what a restore from the old backup did.
 */
export const STRADA_HOME_DATABASE_FILES: readonly string[] = [
  "hub-owners.db",
  "trusted-skills.db",
];

/**
 * The databases a PROJECT owns, under `<projectRoot>/.strada`.
 *
 * `delivery-packages.db` is what `CampaignManager.packageStore()` opens —
 * `join(this.projectRoot, ".strada", "delivery-packages.db")` — and it is the
 * only copy of what a finished piece of work IS: every revision a reviewer can
 * open after the chat message has scrolled away. It is under neither the memory
 * root nor the Strada home, so an installation-only inventory carried none of
 * it and a restore came back with no delivery history at all (#19).
 */
export const PROJECT_DATABASE_FILES: readonly string[] = ["delivery-packages.db"];

/** The directory inside a project root that holds the project's own databases. */
export const PROJECT_DATA_DIR = ".strada";

/** Every known database name, whichever root it lives in. */
export const RUNTIME_DATABASE_FILES: readonly string[] = [
  ...MEMORY_DATABASE_FILES,
  ...STRADA_HOME_DATABASE_FILES,
  ...PROJECT_DATABASE_FILES,
].sort();

/** Root label for the memory directory (`memory.dbPath` / MEMORY_DB_PATH). */
export const MEMORY_ROOT_NAME = "memory";
/** Root label for the Strada home (`STRADA_HOME` / `~/.strada`). */
export const STRADA_HOME_ROOT_NAME = "strada-home";
/**
 * Root label for `~/.strada` when `STRADA_HOME` points somewhere else.
 *
 * `trustedSkillsDbPath()` is built from `homedir()`, not from
 * `resolveStradaHome()`, so with STRADA_HOME set the two diverge and the skill
 * approvals are under the home one. Both are inventoried; when they are the
 * same directory (the default) it is listed once.
 */
export const USER_HOME_ROOT_NAME = "user-home";
/** Root label for `<projectRoot>/.strada` — the databases a project owns (#19). */
export const PROJECT_ROOT_NAME = "project";

/**
 * Directories INSIDE a root whose files belong in the backup although they are
 * not databases.
 *
 * `web-attachment-blobs` is the attachment spool root — `attachmentSpoolRoot()`,
 * which is `join(dirname(dbPath), RETAINED_ATTACHMENT_DIR)` and is documented
 * as "the path to back up or prune: it covers all databases in that directory".
 * Inside it every store has its own subdirectory, so the whole TREE is copied
 * rather than a list of names this module would have to keep up with.
 *
 * `WebAttachmentStore` keeps a file larger than `maxInlineBytes` as an immutable
 * private copy in there and the ROW names that copy instead of holding the
 * bytes; backing up the database alone restores rows that promise a gameplay
 * recording and serve nothing (#19), so the bytes travel with the row.
 */
export const RUNTIME_BLOB_DIRECTORIES: readonly string[] = [RETAINED_ATTACHMENT_DIR];

/** The spool is private: 0700 directory, 0600 file. A copy keeps that. */
const BLOB_DIR_MODE = 0o700;
const BLOB_FILE_MODE = 0o600;

/** One directory the runtime keeps databases in. */
export interface DatabaseRoot {
  /** Stable label: the backup subdirectory and the restore key. */
  readonly name: string;
  /** Absolute directory — where a restore puts these databases back. */
  readonly path: string;
  /** Known filenames for this root. Discovery adds whatever else is there. */
  readonly known: readonly string[];
}

/** Where to look. Both homes default to what the runtime itself resolves. */
export interface RuntimeDatabaseOptions {
  /** `config.memory.dbPath` — what MEMORY_DB_PATH sets. */
  readonly memoryRoot: string;
  /** Defaults to `resolveStradaHome()`. */
  readonly stradaHome?: string;
  /** Defaults to `os.homedir()`; `<userHome>/.strada` is the third root. */
  readonly userHome?: string;
  /**
   * The project whose `.strada` directory holds project-owned databases —
   * `config.unityProjectPath`, which is what `CampaignManager` is given.
   *
   * No default: guessing a project root would back up some directory nobody
   * asked about, and an absent one means the delivery packages are not in this
   * backup rather than that they do not exist (`scripts/backup.sh` says so).
   */
  readonly projectRoot?: string;
}

/**
 * The roots to back up, deduplicated by directory.
 *
 * MEMORY_DB_PATH can legitimately point at the Strada home itself; backing the
 * same file up twice under two root labels would make a restore guess.
 */
export function runtimeDatabaseRoots(opts: RuntimeDatabaseOptions): DatabaseRoot[] {
  const candidates: DatabaseRoot[] = [
    { name: MEMORY_ROOT_NAME, path: path.resolve(opts.memoryRoot), known: MEMORY_DATABASE_FILES },
    {
      name: STRADA_HOME_ROOT_NAME,
      path: path.resolve(opts.stradaHome ?? resolveStradaHome()),
      known: STRADA_HOME_DATABASE_FILES,
    },
    {
      name: USER_HOME_ROOT_NAME,
      path: path.resolve(path.join(opts.userHome ?? os.homedir(), ".strada")),
      known: STRADA_HOME_DATABASE_FILES,
    },
    ...(opts.projectRoot === undefined
      ? []
      : [
          {
            name: PROJECT_ROOT_NAME,
            path: path.resolve(path.join(opts.projectRoot, PROJECT_DATA_DIR)),
            known: PROJECT_DATABASE_FILES,
          },
        ]),
  ];
  // Deduplicated by DIRECTORY, MERGING the known names: two labels for one
  // directory would make a restore guess, but dropping the loser's names with
  // it would lose them from the survivor's list — a project checked out at the
  // Strada home would then only find `delivery-packages.db` by discovery.
  const byPath = new Map<string, { name: string; path: string; known: string[] }>();
  const order: string[] = [];
  for (const candidate of candidates) {
    const existing = byPath.get(candidate.path);
    if (existing === undefined) {
      byPath.set(candidate.path, {
        name: candidate.name,
        path: candidate.path,
        known: [...candidate.known],
      });
      order.push(candidate.path);
      continue;
    }
    for (const name of candidate.known) {
      if (!existing.known.includes(name)) existing.known.push(name);
    }
  }
  return order.map((dir) => byPath.get(dir)!);
}

/** One database to back up, with everything a restore needs to place it. */
export interface RuntimeDatabaseFile {
  /** Absolute source path. */
  readonly source: string;
  /** Label of the root it was found in. */
  readonly root: string;
  /** The root's absolute directory. */
  readonly rootPath: string;
  /** Path within the root — the filename, and the restore's relative target. */
  readonly relative: string;
}

/**
 * Every runtime database across every root.
 *
 * Deduplicated by absolute path (the first root that holds a file owns it), so
 * overlapping roots cannot produce two copies of one database.
 */
export function inventoryRuntimeDatabases(opts: RuntimeDatabaseOptions): RuntimeDatabaseFile[] {
  const files: RuntimeDatabaseFile[] = [];
  const seen = new Set<string>();
  for (const root of runtimeDatabaseRoots(opts)) {
    for (const source of listRuntimeDatabases(root.path, root.known)) {
      if (seen.has(source)) continue;
      seen.add(source);
      files.push({
        source,
        root: root.name,
        rootPath: root.path,
        relative: path.relative(root.path, source),
      });
    }
  }
  return files;
}

/**
 * Every retained blob across every root: the bytes a database ROW points at.
 *
 * Same shape as a database entry — root, root path, path within the root — so a
 * restore places a blob exactly the way it places a database, and a restore
 * into a different root moves the blobs with it.
 */
export function inventoryRuntimeBlobs(opts: RuntimeDatabaseOptions): RuntimeDatabaseFile[] {
  const files: RuntimeDatabaseFile[] = [];
  const seen = new Set<string>();
  for (const root of runtimeDatabaseRoots(opts)) {
    for (const dir of RUNTIME_BLOB_DIRECTORIES) {
      for (const source of listSpoolFiles(path.join(root.path, dir))) {
        if (seen.has(source)) continue;
        seen.add(source);
        files.push({
          source,
          root: root.name,
          rootPath: root.path,
          relative: path.relative(root.path, source),
        });
      }
    }
  }
  return files;
}

/**
 * Every file under a spool, absolute, in a stable order.
 *
 * The whole tree, because each store owns a subdirectory of it — EXCEPT the
 * staging directory. A file in `incoming` has no row naming it (that is what
 * "pending" means), it is deleted by the store's own sweep, and it may be a 2 GB
 * recording halfway through being copied right now — which the digest check in
 * {@link copyRuntimeBlob} would read as a corrupt copy and fail the whole backup
 * over. Bytes nobody can ask for are not what a backup is protecting.
 */
function listSpoolFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === PENDING_ATTACHMENT_DIR) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSpoolFiles(full));
      continue;
    }
    if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Read in chunks: a retained blob is by definition too big to hold in memory. */
export function fileSha256(file: string): string {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Copy one retained blob, keeping the store's guarantees about it.
 *
 * The spool is 0700 and the copy 0600 — that is what makes "not another
 * process" true of the retained bytes — so a backup that widened them would
 * weaken the thing it is preserving. The copy is hashed and compared: a blob
 * whose bytes did not survive the copy is not a backup of it, and the digest is
 * what a restore verifies the file against before it places anything.
 */
export function copyRuntimeBlob(
  source: string,
  destination: string,
): { bytes: number; sha256: string } {
  const expected = fileSha256(source);
  const dir = path.dirname(destination);
  mkdirSync(dir, { recursive: true, mode: BLOB_DIR_MODE });
  chmodSync(dir, BLOB_DIR_MODE);
  copyFileSync(source, destination);
  chmodSync(destination, BLOB_FILE_MODE);
  const sha256 = fileSha256(destination);
  if (sha256 !== expected) {
    throw new Error(`Copy of ${source} does not hold its bytes (${expected} != ${sha256})`);
  }
  return { bytes: statSync(destination).size, sha256 };
}

/** Sidecars that belong to a database, never backed up on their own. */
const SQLITE_SIDECAR = /\.db-(wal|shm|journal)$/;

/**
 * Every database file in ONE directory, as absolute paths.
 *
 * The known table first (stable order), then any other `*.db` the directory
 * holds. Missing files are skipped — a fresh install has few of them — and
 * -wal/-shm sidecars are never listed: `db.backup()` consumes them as part of
 * the database it is copying.
 *
 * `known` defaults to every known name so an existing caller that only knows
 * about the memory root keeps its behaviour; {@link inventoryRuntimeDatabases}
 * passes each root's own list.
 */
export function listRuntimeDatabases(
  dir: string,
  known: readonly string[] = RUNTIME_DATABASE_FILES,
): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (seen.has(name)) return;
    const full = path.join(dir, name);
    if (!existsSync(full) || !statSync(full).isFile()) return;
    seen.add(name);
    found.push(full);
  };
  for (const name of known) add(name);
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".db") || SQLITE_SIDECAR.test(entry)) continue;
    add(entry);
  }
  return found;
}

/** One copied file: the primitive both backup and restore are built from. */
export interface SqliteCopyResult {
  source: string;
  destination: string;
  bytes: number;
}

/** A copy that knows which root it belongs to and where it is restored. */
export interface DatabaseBackupResult extends SqliteCopyResult {
  /** Root label — the subdirectory of the destination it was filed under. */
  root: string;
  /** Path within that root. */
  relative: string;
  /** Absolute path a restore puts this file back at. */
  restorePath: string;
}

/**
 * Copy one SQLite database with the online backup API.
 *
 * Opens read-only: a backup must never be the thing that migrates or writes to
 * a production database. `db.backup()` handles a concurrent writer — that is
 * the entire reason it exists — and the result is a single consistent file with
 * no -wal to remember.
 */
export async function backupSqliteDatabase(
  source: string,
  destination: string,
): Promise<SqliteCopyResult> {
  mkdirSync(path.dirname(destination), { recursive: true });
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  // A backup that cannot be opened is not a backup — and a backup that needs a
  // -wal sidecar to be complete is the defect this replaces, so the copy is
  // checkpointed into its main file and the sidecars are removed. What the
  // archive holds is then one self-contained file whose checksum covers it all.
  const check = new Database(destination, { fileMustExist: true });
  try {
    check.pragma("wal_checkpoint(TRUNCATE)");
    const result = check.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const verdict = result[0]?.integrity_check;
    if (verdict !== "ok") {
      throw new Error(`Backup of ${source} failed integrity_check: ${verdict ?? "no result"}`);
    }
  } finally {
    check.close();
  }
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(`${destination}${suffix}`, { force: true });
  }
  return { source, destination, bytes: statSync(destination).size };
}

/** A copied blob: a database row's bytes, with the digest that identifies them. */
export interface BlobBackupResult extends SqliteCopyResult {
  root: string;
  relative: string;
  restorePath: string;
  sha256: string;
}

export interface BackupRunOptions extends RuntimeDatabaseOptions {
  destDir: string;
  /** Suffix put before `.db` in the destination name; the backup's timestamp. */
  timestamp?: string;
}

/** The index a restore reads: what was copied, and where it came from. */
export const BACKUP_MANIFEST_FILE = "databases.manifest.json";

export interface BackupManifestEntry {
  /** Root label. */
  readonly root: string;
  /** Path within the root — where it is restored to, relative to the root. */
  readonly relative: string;
  /** The absolute path it was copied FROM. */
  readonly source: string;
  /** The copy, relative to the backup directory. */
  readonly backup: string;
  readonly bytes: number;
}

/** One retained blob in the backup: bytes a row names, and their digest. */
export interface BackupBlobEntry {
  /** Root label. */
  readonly root: string;
  /** Path within the root, spool directory included. */
  readonly relative: string;
  /** The absolute path it was copied FROM. */
  readonly source: string;
  /** The copy, relative to the backup directory. */
  readonly backup: string;
  readonly bytes: number;
  /** SHA-256 of the copy: what a restore checks before it places anything. */
  readonly sha256: string;
}

export interface BackupManifest {
  readonly version: 1;
  readonly createdAtIso: string;
  readonly timestamp?: string;
  /** Root label → the absolute directory it was read from. */
  readonly roots: Record<string, string>;
  readonly databases: readonly BackupManifestEntry[];
  /**
   * Retained blobs (#19). OPTIONAL on purpose: a manifest written before this
   * existed has none, and a restore from it must still put the databases back
   * rather than refuse the whole archive.
   */
  readonly blobs?: readonly BackupBlobEntry[];
}

/** Path of the manifest inside a backup directory. */
export function backupManifestPath(backupDir: string): string {
  return path.join(backupDir, BACKUP_MANIFEST_FILE);
}

/** Everything one backup produced, and the manifest that places it back. */
export interface BackupRunResult {
  readonly databases: DatabaseBackupResult[];
  readonly blobs: BlobBackupResult[];
  readonly manifest: BackupManifest;
}

/**
 * Back up every runtime database AND every retained blob of an installation.
 *
 * Files are filed under their root (`<destDir>/memory/…`,
 * `<destDir>/strada-home/…`, `<destDir>/project/…`): two roots can hold the same
 * NAME, and a flat destination silently let one overwrite the other. The
 * manifest beside them records each source path, which is what makes
 * {@link restoreRuntimeData} able to put things back rather than guess.
 *
 * Blobs keep their own names (a token is already unique) in the spool
 * subdirectory of their root, because it is the manifest — not the filename —
 * that says where a file goes back.
 */
export async function backupRuntimeData(opts: BackupRunOptions): Promise<BackupRunResult> {
  const roots = runtimeDatabaseRoots(opts);
  const inventory = inventoryRuntimeDatabases(opts);
  mkdirSync(opts.destDir, { recursive: true });
  const results: DatabaseBackupResult[] = [];
  for (const entry of inventory) {
    const base = path.basename(entry.relative, ".db");
    const name = opts.timestamp ? `${base}_${opts.timestamp}.db` : `${base}.db`;
    const destination = path.join(
      opts.destDir,
      entry.root,
      path.dirname(entry.relative),
      name,
    );
    const copy = await backupSqliteDatabase(entry.source, destination);
    results.push({
      ...copy,
      root: entry.root,
      relative: entry.relative,
      restorePath: path.join(entry.rootPath, entry.relative),
    });
  }
  const blobs: BlobBackupResult[] = [];
  for (const entry of inventoryRuntimeBlobs(opts)) {
    const destination = path.join(opts.destDir, entry.root, entry.relative);
    const copy = copyRuntimeBlob(entry.source, destination);
    blobs.push({
      source: entry.source,
      destination,
      bytes: copy.bytes,
      sha256: copy.sha256,
      root: entry.root,
      relative: entry.relative,
      restorePath: path.join(entry.rootPath, entry.relative),
    });
  }
  const manifest: BackupManifest = {
    version: 1,
    createdAtIso: new Date().toISOString(),
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    roots: Object.fromEntries(roots.map((root) => [root.name, root.path])),
    databases: results.map((result) => ({
      root: result.root,
      relative: result.relative,
      source: result.source,
      backup: path.relative(opts.destDir, result.destination),
      bytes: result.bytes,
    })),
    blobs: blobs.map((blob) => ({
      root: blob.root,
      relative: blob.relative,
      source: blob.source,
      backup: path.relative(opts.destDir, blob.destination),
      bytes: blob.bytes,
      sha256: blob.sha256,
    })),
  };
  writeFileSync(backupManifestPath(opts.destDir), `${JSON.stringify(manifest, null, 2)}\n`);
  return { databases: results, blobs, manifest };
}

/** The databases of a backup run — {@link backupRuntimeData} does the whole job. */
export async function backupRuntimeDatabases(
  opts: BackupRunOptions,
): Promise<DatabaseBackupResult[]> {
  return (await backupRuntimeData(opts)).databases;
}

/** Read a backup's manifest. Throws when it is missing or unparseable. */
export function readBackupManifest(backupDir: string): BackupManifest {
  const file = backupManifestPath(backupDir);
  if (!existsSync(file)) {
    throw new Error(`No ${BACKUP_MANIFEST_FILE} in ${backupDir} — not a database backup`);
  }
  const manifest = JSON.parse(readFileSync(file, "utf8")) as BackupManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.databases)) {
    throw new Error(`Unsupported ${BACKUP_MANIFEST_FILE} in ${backupDir}`);
  }
  if (manifest.blobs !== undefined && !Array.isArray(manifest.blobs)) {
    throw new Error(`Unsupported ${BACKUP_MANIFEST_FILE} in ${backupDir}: blobs is not a list`);
  }
  return manifest;
}

export interface RestoreRunOptions {
  /** The directory `backupRuntimeData` wrote. */
  backupDir: string;
  /**
   * Root label → directory to restore into. Anything not overridden goes back
   * to the absolute path the manifest recorded, which is the point of it.
   */
  roots?: Record<string, string>;
  /**
   * Invoked once every source is staged and verified and BEFORE the first
   * destination is replaced.
   *
   * A test seam, and the only one: the window between "the replacements are
   * ready" and "they are in place" is the one a caller cannot provoke a failure
   * in from outside, and the rollback below is what a failure there must
   * produce. Nothing in the runtime passes it.
   */
  onStaged?: () => void | Promise<void>;
}

/** Everything a restore put back. */
export interface RestoreRunResult {
  readonly databases: DatabaseBackupResult[];
  readonly blobs: BlobBackupResult[];
}

/** One thing to put back, resolved and checked before anything is touched. */
interface RestorePlanItem {
  readonly kind: "database" | "blob";
  readonly root: string;
  readonly relative: string;
  /** The copy inside the backup directory. */
  readonly backupFile: string;
  /** Where it goes. */
  readonly target: string;
  /** The root it is being restored INTO. */
  readonly rootPath: string;
  /** The root it was backed up FROM; a different one means rows must be rebased. */
  readonly sourceRootPath: string;
  /** For a blob: the digest the manifest recorded. */
  readonly sha256?: string;
}

/**
 * Is this backup file usable AS a database, before anything depends on it?
 *
 * Returns the reason it is not, or undefined. Three failures, all of which used
 * to be discovered only after the destination had been deleted (#2): the file is
 * not there, the file is not the file the manifest recorded (a truncated or
 * swapped archive member), and the file is not a working SQLite database. An
 * EMPTY file matters: SQLite opens a zero-byte file as a valid empty database
 * and `integrity_check` says ok, so a truncated backup would otherwise restore
 * a database with no rows and report success.
 */
function unusableDatabaseSource(file: string, expectedBytes: number): string | undefined {
  if (!existsSync(file)) return "is missing from the backup";
  const stat = statSync(file);
  if (!stat.isFile()) return "is not a file";
  if (stat.size !== expectedBytes) {
    return `is ${stat.size} bytes where the manifest recorded ${expectedBytes} — the backup file changed`;
  }
  if (stat.size === 0) return "is empty";
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (err) {
    return `cannot be opened (${(err as Error).message})`;
  }
  try {
    const result = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const verdict = result[0]?.integrity_check;
    if (verdict !== "ok") return `failed integrity_check (${verdict ?? "no result"})`;
  } catch (err) {
    return `is not a usable SQLite database (${(err as Error).message})`;
  } finally {
    db.close();
  }
  return undefined;
}

/** Is this backup blob the exact bytes the manifest recorded? */
function unusableBlobSource(file: string, entry: BackupBlobEntry): string | undefined {
  if (!existsSync(file)) return "is missing from the backup";
  const stat = statSync(file);
  if (!stat.isFile()) return "is not a file";
  if (stat.size !== entry.bytes) {
    return `is ${stat.size} bytes where the manifest recorded ${entry.bytes} — the backup file changed`;
  }
  const sha256 = fileSha256(file);
  if (sha256 !== entry.sha256) {
    return `hashes ${sha256} where the manifest recorded ${entry.sha256} — the backup file changed`;
  }
  return undefined;
}

/**
 * Databases whose ROWS name absolute paths inside their own root.
 *
 * `web-attachments.db` is the one: a retained row's `path` is
 * `<root>/web-attachment-blobs/<token>`, an absolute path measured on the
 * machine the backup was taken on. Restored onto a machine whose root is
 * elsewhere the bytes ARE there — the spool travels with the backup — and every
 * row still points at the old directory, so every large attachment 404s while
 * its row promises it. That is the second half of #19, and no amount of
 * integrity checking would notice it.
 *
 * Applied to the STAGED copy, before anything is replaced: a rebase that throws
 * must not leave a half-rewritten live database.
 */
const ROOT_PATH_REBASERS: Record<string, (file: string, from: string, to: string) => number> = {
  "web-attachments.db": rebaseRetainedAttachmentPaths,
};

function rebaseRetainedAttachmentPaths(file: string, fromRoot: string, toRoot: string): number {
  const fromDir = path.join(fromRoot, RETAINED_ATTACHMENT_DIR);
  const toDir = path.join(toRoot, RETAINED_ATTACHMENT_DIR);
  if (fromDir === toDir) return 0;
  const db = new Database(file, { fileMustExist: true });
  let rewritten = 0;
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'web_attachments'")
      .get();
    if (table === undefined) return 0;
    const columns = new Set(
      (db.pragma("table_info(web_attachments)") as Array<{ name: string }>).map((c) => c.name),
    );
    // A database written before the store retained anything has no such column
    // and therefore no row that names a spool file.
    if (!columns.has("path") || !columns.has("retained") || !columns.has("token")) return 0;
    const rows = db
      .prepare("SELECT token, path FROM web_attachments WHERE retained = 1 AND path IS NOT NULL")
      .all() as Array<{ token: string; path: string }>;
    const update = db.prepare("UPDATE web_attachments SET path = ? WHERE token = ?");
    for (const row of rows) {
      const inside = path.relative(fromDir, row.path);
      // Only a path that really is inside the old spool is ours to rewrite; a
      // fallback REFERENCE to the caller's own file is not, and inventing a new
      // location for it would point the row at bytes nobody copied.
      if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) continue;
      update.run(path.join(toDir, inside), row.token);
      rewritten += 1;
    }
    // The staged file must stay the self-contained, sidecar-free thing the swap
    // renames into place; the UPDATE above opened a -wal.
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
  return rewritten;
}

/** One destination's swap: what was moved aside, and whether the copy landed. */
interface SwapRecord {
  readonly item: RestorePlanItem;
  readonly stagedPath: string;
  readonly asides: Array<{ from: string; to: string }>;
  placed: boolean;
}

/**
 * Put a backup back where its owners read it — WITHOUT destroying what is there
 * until the replacement exists (#2).
 *
 * Three phases, in this order, because the order IS the fix:
 *
 *   1. validate every source. A missing, truncated or corrupt backup file
 *      aborts the whole restore while every live database is still untouched,
 *      and the error names each file and what is wrong with it.
 *   2. stage every replacement next to its destination — copied with the online
 *      backup API (which integrity-checks the copy), rebased if it is being
 *      restored into a different root, and for a blob hashed against the
 *      manifest. A failure here removes the staging files and nothing else.
 *   3. swap. The original is RENAMED aside (with its -wal/-shm, which would
 *      otherwise be replayed over the new file), the staged copy is renamed
 *      into place, and only once every destination is in place are the
 *      originals deleted. A failure mid-swap puts every original back.
 */
export async function restoreRuntimeData(opts: RestoreRunOptions): Promise<RestoreRunResult> {
  const manifest = readBackupManifest(opts.backupDir);
  const items: RestorePlanItem[] = [];
  const problems: string[] = [];
  const rootPathFor = (root: string): string | undefined =>
    opts.roots?.[root] ?? manifest.roots[root];

  for (const entry of manifest.databases) {
    const rootPath = rootPathFor(entry.root);
    if (rootPath === undefined) {
      problems.push(`${BACKUP_MANIFEST_FILE} names no directory for root "${entry.root}"`);
      continue;
    }
    const backupFile = path.join(opts.backupDir, entry.backup);
    const problem = unusableDatabaseSource(backupFile, entry.bytes);
    if (problem !== undefined) {
      problems.push(`${entry.backup} (for ${path.join(rootPath, entry.relative)}) ${problem}`);
      continue;
    }
    items.push({
      kind: "database",
      root: entry.root,
      relative: entry.relative,
      backupFile,
      target: path.join(rootPath, entry.relative),
      rootPath,
      sourceRootPath: manifest.roots[entry.root] ?? rootPath,
    });
  }
  for (const entry of manifest.blobs ?? []) {
    const rootPath = rootPathFor(entry.root);
    if (rootPath === undefined) {
      problems.push(`${BACKUP_MANIFEST_FILE} names no directory for root "${entry.root}"`);
      continue;
    }
    const backupFile = path.join(opts.backupDir, entry.backup);
    const problem = unusableBlobSource(backupFile, entry);
    if (problem !== undefined) {
      problems.push(`${entry.backup} (for ${path.join(rootPath, entry.relative)}) ${problem}`);
      continue;
    }
    items.push({
      kind: "blob",
      root: entry.root,
      relative: entry.relative,
      backupFile,
      target: path.join(rootPath, entry.relative),
      rootPath,
      sourceRootPath: manifest.roots[entry.root] ?? rootPath,
      sha256: entry.sha256,
    });
  }

  if (problems.length > 0) {
    throw new Error(
      `Restore from ${opts.backupDir} refused: ${problems.length} unusable source(s) — ` +
        `${problems.join("; ")}. Nothing was replaced; every live database still holds ` +
        `what it held before.`,
    );
  }

  // Unique per run, and the same for every file of it, so a crash leaves
  // residue that is obviously one restore's and not another's.
  const stamp = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const staged: Array<{ item: RestorePlanItem; path: string; bytes: number; sha256?: string }> = [];
  const discardStaged = (): void => {
    for (const entry of staged) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(`${entry.path}${suffix}`, { force: true });
        } catch {
          // A staging file we cannot remove is residue, not data loss.
        }
      }
    }
  };

  try {
    for (const item of items) {
      const stagedPath = `${item.target}.restore-${stamp}.tmp`;
      if (item.kind === "database") {
        await backupSqliteDatabase(item.backupFile, stagedPath);
        const rebase = ROOT_PATH_REBASERS[path.basename(item.relative)];
        if (rebase !== undefined) rebase(stagedPath, item.sourceRootPath, item.rootPath);
        staged.push({ item, path: stagedPath, bytes: statSync(stagedPath).size });
      } else {
        const copy = copyRuntimeBlob(item.backupFile, stagedPath);
        if (item.sha256 !== undefined && copy.sha256 !== item.sha256) {
          throw new Error(`staged ${stagedPath} hashes ${copy.sha256}, not ${item.sha256}`);
        }
        staged.push({ item, path: stagedPath, bytes: copy.bytes, sha256: copy.sha256 });
      }
    }
    await opts.onStaged?.();
  } catch (err) {
    discardStaged();
    throw new Error(
      `Restore from ${opts.backupDir} failed while staging the replacements: ` +
        `${(err as Error).message}. Nothing was replaced; every live database still holds ` +
        `what it held before.`,
    );
  }

  const swaps: SwapRecord[] = [];
  try {
    for (const entry of staged) {
      const record: SwapRecord = { item: entry.item, stagedPath: entry.path, asides: [], placed: false };
      swaps.push(record);
      // Moved ASIDE, not deleted: until the replacement is in place this file
      // is the only copy of the live data. Its -wal/-shm travel with it — left
      // behind, a stale -wal is replayed over the restored file.
      for (const suffix of ["", "-wal", "-shm"]) {
        const from = `${entry.item.target}${suffix}`;
        if (!existsSync(from)) continue;
        const to = `${from}.pre-restore-${stamp}`;
        renameSync(from, to);
        record.asides.push({ from, to });
      }
      renameSync(entry.path, entry.item.target);
      record.placed = true;
    }
  } catch (err) {
    const unrecovered: string[] = [];
    for (const record of [...swaps].reverse()) {
      if (record.placed) {
        try {
          rmSync(record.item.target, { force: true });
        } catch (e) {
          unrecovered.push(`${record.item.target} (${(e as Error).message})`);
        }
      }
      for (const aside of [...record.asides].reverse()) {
        try {
          renameSync(aside.to, aside.from);
        } catch (e) {
          unrecovered.push(`${aside.to} could not be moved back to ${aside.from} (${(e as Error).message})`);
        }
      }
    }
    discardStaged();
    throw new Error(
      `Restore from ${opts.backupDir} failed while replacing the destinations: ` +
        `${(err as Error).message}. Every destination was rolled back to what it held before` +
        (unrecovered.length > 0 ? `, EXCEPT: ${unrecovered.join("; ")}` : "") +
        `.`,
    );
  }

  // In place. The originals are no longer the only copy of anything — and one
  // we cannot delete is residue beside a restored database, never a reason to
  // report a completed restore as failed.
  for (const record of swaps) {
    for (const aside of record.asides) {
      try {
        rmSync(aside.to, { force: true });
      } catch {
        // Left behind next to the file it used to be; the restore stands.
      }
    }
  }

  const databases: DatabaseBackupResult[] = [];
  const blobs: BlobBackupResult[] = [];
  for (const entry of staged) {
    const common = {
      source: entry.item.backupFile,
      destination: entry.item.target,
      bytes: entry.bytes,
      root: entry.item.root,
      relative: entry.item.relative,
      restorePath: entry.item.target,
    };
    if (entry.item.kind === "database") databases.push(common);
    else blobs.push({ ...common, sha256: entry.sha256 ?? "" });
  }
  return { databases, blobs };
}

/** The databases a restore put back — {@link restoreRuntimeData} does the whole job. */
export async function restoreRuntimeDatabases(
  opts: RestoreRunOptions,
): Promise<DatabaseBackupResult[]> {
  return (await restoreRuntimeData(opts)).databases;
}

export interface ParsedArgs {
  source: string;
  dest: string;
  timestamp?: string;
  /** `--strada-home`; omitted means "whatever the runtime resolves". */
  stradaHome?: string;
  /** `--user-home`; omitted means `os.homedir()`. */
  userHome?: string;
  /** `--project-root`; omitted means no project-owned databases are in scope. */
  projectRoot?: string;
}

/** Parse the CLI arguments. Throws with usage on anything missing. */
export function parseBackupArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    values.set(arg.slice(2), next);
    i += 1;
  }
  const source = values.get("source");
  const dest = values.get("dest");
  if (!source || !dest) {
    throw new Error(
      "usage: database-backup --source <memory-root> --dest <dir> " +
        "[--strada-home <dir>] [--user-home <dir>] [--project-root <dir>] [--timestamp <ts>]",
    );
  }
  const timestamp = values.get("timestamp");
  const stradaHome = values.get("strada-home");
  const userHome = values.get("user-home");
  const projectRoot = values.get("project-root");
  return {
    source,
    dest,
    ...(timestamp ? { timestamp } : {}),
    ...(stradaHome ? { stradaHome } : {}),
    ...(userHome ? { userHome } : {}),
    ...(projectRoot ? { projectRoot } : {}),
  };
}

/** CLI entry: prints one produced path per line for the caller to checksum. */
export async function runBackupCli(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseBackupArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  try {
    const run = await backupRuntimeData({
      memoryRoot: parsed.source,
      destDir: parsed.dest,
      ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {}),
      ...(parsed.stradaHome ? { stradaHome: parsed.stradaHome } : {}),
      ...(parsed.userHome ? { userHome: parsed.userHome } : {}),
      ...(parsed.projectRoot ? { projectRoot: parsed.projectRoot } : {}),
    });
    // Blobs are produced files like any other: the caller checksums them, and a
    // backup that silently carried none of them is the defect (#19).
    for (const result of [...run.databases, ...run.blobs]) {
      process.stdout.write(`${result.destination}\n`);
    }
    // The manifest is part of the backup — it is what a restore reads — so the
    // caller checksums it like everything else.
    if (run.databases.length > 0 || run.blobs.length > 0) {
      process.stdout.write(`${backupManifestPath(parsed.dest)}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`database backup failed: ${(err as Error).message}\n`);
    return 1;
  }
}

/* c8 ignore start — CLI wiring, exercised by scripts/backup.sh */
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = await runBackupCli(process.argv.slice(2));
}
/* c8 ignore stop */
