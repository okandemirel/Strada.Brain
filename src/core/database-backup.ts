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
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
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
  /**
   * Back up even when a committed row names bytes that are nowhere on disk
   * (round 12 #21), recording the gap in the manifest instead of failing.
   *
   * Default false: a backup that silently omits the bytes a row promises is the
   * defect. The escape hatch exists because an installation whose spool has
   * already lost a file must still be able to take a backup of everything else
   * — refusing forever would be a second data-loss route — but it says so in
   * the manifest rather than reporting a complete backup.
   */
  allowMissingBlobs?: boolean;
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

/**
 * Content a committed row promises that this backup does NOT hold (#21).
 *
 * Only ever written with `allowMissingBlobs`, and it is the difference between
 * "restore this and the attachment is back" and "restore this and the row 404s".
 */
export interface MissingBlobEntry {
  readonly root: string;
  /** The absolute path the row names. */
  readonly source: string;
  /** Which row: the attachment token. */
  readonly token: string;
  /** The database whose row names it, relative to its root. */
  readonly database: string;
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
  /** Bytes a row names that are not in this backup (#21). Absent when none. */
  readonly missingBlobs?: readonly MissingBlobEntry[];
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
  /** The copy each result was made from, for the required-blob pass (#21). */
  const copiedFrom = new Map<DatabaseBackupResult, RuntimeDatabaseFile>();
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
    const result: DatabaseBackupResult = {
      ...copy,
      root: entry.root,
      relative: entry.relative,
      restorePath: path.join(entry.rootPath, entry.relative),
    };
    results.push(result);
    copiedFrom.set(result, entry);
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
  const missingBlobs = captureRequiredBlobs({
    destDir: opts.destDir,
    databases: results,
    copiedFrom,
    blobs,
    allowMissing: opts.allowMissingBlobs === true,
  });
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
    ...(missingBlobs.length > 0 ? { missingBlobs } : {}),
  };
  writeFileSync(backupManifestPath(opts.destDir), `${JSON.stringify(manifest, null, 2)}\n`);
  return { databases: results, blobs, manifest };
}

/** Content a database ROW promises: the bytes that must travel with it (#21). */
interface RequiredBlob {
  /** The absolute path the row names. */
  readonly source: string;
  /** Which row. */
  readonly token: string;
  /** What the row says the bytes are, when it recorded them. */
  readonly bytes: number | null;
  readonly sha256: string | null;
}

/**
 * Databases whose rows REQUIRE bytes that are not inside them.
 *
 * Read from the COPY, not the live file: the copy is what this backup will
 * restore, so the copy's rows are the promises this backup has to keep.
 */
const REQUIRED_BLOB_READERS: Record<string, (file: string) => RequiredBlob[]> = {
  "web-attachments.db": requiredRetainedAttachments,
};

function requiredRetainedAttachments(file: string): RequiredBlob[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'web_attachments'")
      .get();
    if (table === undefined) return [];
    const columns = new Set(
      (db.pragma("table_info(web_attachments)") as Array<{ name: string }>).map((c) => c.name),
    );
    if (!columns.has("path") || !columns.has("retained") || !columns.has("token")) return [];
    const size = columns.has("byte_size") ? "byte_size" : "NULL AS byte_size";
    const sum = columns.has("checksum") ? "checksum" : "NULL AS checksum";
    return (
      db
        .prepare(
          `SELECT token, path, ${size}, ${sum} FROM web_attachments ` +
            `WHERE retained = 1 AND path IS NOT NULL`,
        )
        .all() as Array<{ token: string; path: string; byte_size: number | null; checksum: string | null }>
    ).map((row) => ({
      source: row.path,
      token: row.token,
      bytes: row.byte_size,
      sha256: row.checksum,
    }));
  } finally {
    db.close();
  }
}

/**
 * Make the backup hold every byte its copied rows promise (round 12 #21).
 *
 * `WebAttachmentStore.register()` commits the ROW and only then renames the
 * copy from `incoming/<token>` to the name the row carries — deliberately, so a
 * finished copy is never reachable at that name without a row defending it. A
 * backup taken inside that window snapshotted the row, skipped `incoming` (which
 * it must: those bytes may be a 2 GB recording halfway through being written),
 * and reported success. The restored installation then served 404s for a row
 * that still promised a gameplay recording, and nothing anywhere had said so.
 *
 * So the copied database is asked what it requires, and anything the blob pass
 * did not capture is retried:
 *
 *   1. at the name the row gives — the rename may have landed since;
 *   2. at `<spool>/incoming/<token>`, where `register()` had not moved it from
 *      yet, accepted only when the size AND SHA-256 the row itself recorded match
 *      the file. That is what distinguishes the promised bytes from a copy still
 *      being written — the row is the authority on what it promised.
 *
 * What is nowhere fails the backup, naming the row, unless the caller asked to
 * record the gap instead ({@link BackupRunOptions.allowMissingBlobs}).
 */
function captureRequiredBlobs(args: {
  destDir: string;
  databases: readonly DatabaseBackupResult[];
  copiedFrom: Map<DatabaseBackupResult, RuntimeDatabaseFile>;
  blobs: BlobBackupResult[];
  allowMissing: boolean;
}): MissingBlobEntry[] {
  const captured = new Set(args.blobs.map((blob) => path.resolve(blob.source)));
  const missing: MissingBlobEntry[] = [];
  const unavailable: string[] = [];
  for (const result of args.databases) {
    const read = REQUIRED_BLOB_READERS[path.basename(result.relative)];
    const entry = args.copiedFrom.get(result);
    if (read === undefined || entry === undefined) continue;
    for (const required of read(result.destination)) {
      if (captured.has(path.resolve(required.source))) continue;
      // Only bytes inside the root being backed up are this backup's to carry;
      // a fallback REFERENCE to the caller's own file is not (the store keeps
      // those with `retained = 0`, so they are not in this list at all).
      const inside = path.relative(entry.rootPath, required.source);
      if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) continue;
      const recovered = recoverRequiredBlob(required);
      if (recovered === null) {
        missing.push({
          root: entry.root,
          source: required.source,
          token: required.token,
          database: entry.relative,
        });
        unavailable.push(`${required.token} (${required.source}, named by ${entry.relative})`);
        continue;
      }
      // Filed under the name the ROW gives, whichever file the bytes came from:
      // the row is what a restore has to satisfy.
      const destination = path.join(args.destDir, entry.root, inside);
      const copy = copyRuntimeBlob(recovered, destination);
      args.blobs.push({
        source: required.source,
        destination,
        bytes: copy.bytes,
        sha256: copy.sha256,
        root: entry.root,
        relative: inside,
        restorePath: required.source,
      });
      captured.add(path.resolve(required.source));
    }
  }
  if (unavailable.length > 0 && !args.allowMissing) {
    throw new Error(
      `${unavailable.length} committed row(s) promise bytes this backup cannot capture — ` +
        `${unavailable.join("; ")}. A backup that carries the row without its content restores ` +
        `an attachment that serves nothing; pass allowMissingBlobs to back the rest up anyway ` +
        `and record the gap in ${BACKUP_MANIFEST_FILE}.`,
    );
  }
  return missing;
}

/** The file holding a required blob's bytes, or null. Retried, then verified. */
function recoverRequiredBlob(required: RequiredBlob): string | null {
  const candidates = [
    required.source,
    // `<spool>/incoming/<token>` — where `snapshot()` wrote the copy and
    // `register()` renames it FROM, derived from the row rather than from a
    // spool layout retyped here.
    path.join(path.dirname(required.source), PENDING_ATTACHMENT_DIR, path.basename(required.source)),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    if (candidate === required.source) return candidate;
    // A staged file is only the promised bytes if it IS the promised bytes: the
    // row recorded the size and digest of the copy at registration.
    if (required.bytes !== null && statSync(candidate).size !== required.bytes) continue;
    if (required.sha256 !== null && fileSha256(candidate) !== required.sha256) continue;
    if (required.bytes === null && required.sha256 === null) continue;
    return candidate;
  }
  return null;
}

/** The databases of a backup run — {@link backupRuntimeData} does the whole job. */
export async function backupRuntimeDatabases(
  opts: BackupRunOptions,
): Promise<DatabaseBackupResult[]> {
  return (await backupRuntimeData(opts)).databases;
}

/**
 * The manifest is UNTRUSTED INPUT (round 12 #19).
 *
 * It is a plain JSON file in a directory anyone who can read the backup can
 * write, and the restore builds destination paths out of it. The old reader
 * checked `version` and that `databases` was an array and then handed whatever
 * the fields happened to hold to `path.join` — so `relative: "../../victim"`
 * produced a destination outside the root the operator selected, every member
 * checksum still passed (the FILES were untouched), and the restore replaced a
 * file it was never pointed at. A `relative` that is not even a string turned
 * into a TypeError from inside the swap loop.
 *
 * Every field is therefore validated for TYPE here and for CONTAINMENT at
 * {@link restoreRuntimeData}, where the root it is being joined to is known.
 */
function manifestString(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${where}: ${field} is not a string (${JSON.stringify(value)})`);
  }
  return value;
}

function manifestBytes(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${where}: bytes is not a byte count (${JSON.stringify(value)})`);
  }
  return value;
}

/** A relative path that stays inside its root — lexically. Canonical check follows. */
function manifestRelative(value: unknown, field: string, where: string, inside: string): string {
  const raw = manifestString(value, field, where);
  if (path.isAbsolute(raw) || /^[A-Za-z]:/u.test(raw)) {
    throw new Error(
      `${where}: ${field} is absolute (${raw}) — a manifest names paths inside ${inside}`,
    );
  }
  const normalised = path.normalize(raw);
  if (normalised === ".." || normalised.startsWith(`..${path.sep}`) || normalised.split(/[\\/]/u).includes("..")) {
    throw new Error(`${where}: ${field} (${raw}) climbs outside ${inside}`);
  }
  return raw;
}

/** Read a backup's manifest. Throws when it is missing, unparseable or not one. */
export function readBackupManifest(backupDir: string): BackupManifest {
  const file = backupManifestPath(backupDir);
  if (!existsSync(file)) {
    throw new Error(`No ${BACKUP_MANIFEST_FILE} in ${backupDir} — not a database backup`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${BACKUP_MANIFEST_FILE} in ${backupDir} is not JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Unsupported ${BACKUP_MANIFEST_FILE} in ${backupDir}: not an object`);
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.version !== 1 || !Array.isArray(manifest.databases)) {
    throw new Error(`Unsupported ${BACKUP_MANIFEST_FILE} in ${backupDir}`);
  }
  if (manifest.blobs !== undefined && !Array.isArray(manifest.blobs)) {
    throw new Error(`Unsupported ${BACKUP_MANIFEST_FILE} in ${backupDir}: blobs is not a list`);
  }
  if (typeof manifest.roots !== "object" || manifest.roots === null || Array.isArray(manifest.roots)) {
    throw new Error(`Unsupported ${BACKUP_MANIFEST_FILE} in ${backupDir}: roots is not a table`);
  }
  for (const [name, dir] of Object.entries(manifest.roots as Record<string, unknown>)) {
    manifestString(dir, `roots["${name}"]`, `${BACKUP_MANIFEST_FILE} in ${backupDir}`);
  }
  const validated: BackupManifestEntry[] = (manifest.databases as unknown[]).map((raw, i) => {
    const where = `${BACKUP_MANIFEST_FILE} in ${backupDir}, databases[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`${where}: not an object`);
    }
    const entry = raw as Record<string, unknown>;
    return {
      root: manifestString(entry.root, "root", where),
      relative: manifestRelative(entry.relative, "relative", where, "the root it belongs to"),
      source: manifestString(entry.source, "source", where),
      backup: manifestRelative(entry.backup, "backup", where, "the backup directory"),
      bytes: manifestBytes(entry.bytes, where),
    };
  });
  const blobs: BackupBlobEntry[] | undefined =
    manifest.blobs === undefined
      ? undefined
      : (manifest.blobs as unknown[]).map((raw, i) => {
          const where = `${BACKUP_MANIFEST_FILE} in ${backupDir}, blobs[${i}]`;
          if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            throw new Error(`${where}: not an object`);
          }
          const entry = raw as Record<string, unknown>;
          const sha256 = manifestString(entry.sha256, "sha256", where);
          if (!/^[0-9a-f]{64}$/u.test(sha256)) {
            throw new Error(`${where}: sha256 is not a SHA-256 digest (${sha256})`);
          }
          return {
            root: manifestString(entry.root, "root", where),
            relative: manifestRelative(entry.relative, "relative", where, "the root it belongs to"),
            source: manifestString(entry.source, "source", where),
            backup: manifestRelative(entry.backup, "backup", where, "the backup directory"),
            bytes: manifestBytes(entry.bytes, where),
            sha256,
          };
        });
  return {
    version: 1,
    createdAtIso: typeof manifest.createdAtIso === "string" ? manifest.createdAtIso : "",
    ...(typeof manifest.timestamp === "string" ? { timestamp: manifest.timestamp } : {}),
    roots: manifest.roots as Record<string, string>,
    databases: validated,
    ...(blobs === undefined ? {} : { blobs }),
    ...(Array.isArray(manifest.missingBlobs)
      ? { missingBlobs: manifest.missingBlobs as readonly MissingBlobEntry[] }
      : {}),
  };
}

/**
 * The real path of `target`, resolved as far as it exists.
 *
 * A restore's destination usually does not exist yet (that is the point), so
 * `realpathSync` on it throws; what matters for containment is the deepest
 * ancestor that DOES exist, because that is where the symlinks are. Both sides
 * of a containment test go through this, which is also what makes `/var` and
 * `/private/var` compare equal instead of judging a lease "outside the project".
 */
function realPathAsFarAsItExists(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(current) : path.join(realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `relative` inside `rootPath`, or say why it does not belong to it.
 *
 * Canonical, not lexical: `relative` of "sub/memory.db" is inside the root by
 * string comparison and outside it on disk when `sub` is a symlink, and the
 * rename that places the file would then land wherever the link points. The
 * DIRECTORY is what is canonicalised — the swap renames into it — so a
 * destination file that is itself a symlink is replaced rather than followed,
 * which is what a restore means.
 */
function resolveInsideRoot(
  rootPath: string,
  relative: string,
): { target: string; canonical: string } | { problem: string } {
  const lexical = path.resolve(rootPath, relative);
  const lexicalRel = path.relative(path.resolve(rootPath), lexical);
  if (lexicalRel === "" || lexicalRel.startsWith("..") || path.isAbsolute(lexicalRel)) {
    return { problem: `resolves to ${lexical}, outside the root ${rootPath}` };
  }
  const realRoot = realPathAsFarAsItExists(rootPath);
  const realDir = realPathAsFarAsItExists(path.dirname(lexical));
  const dirRel = path.relative(realRoot, realDir);
  if (dirRel.startsWith("..") || path.isAbsolute(dirRel)) {
    return {
      problem:
        `resolves to ${path.join(realDir, path.basename(lexical))}, outside the root ` +
        `${realRoot} (reached through a symlink)`,
    };
  }
  // The TARGET stays lexical: it is the path the operator named and the one a
  // result reports. Only the judgement — and the duplicate-destination key —
  // uses the canonical form, because `/var` and `/private/var` are the same
  // directory and two manifest entries reaching one file through different
  // spellings must still be caught.
  return { target: lexical, canonical: path.join(realDir, path.basename(lexical)) };
}

/**
 * The installation-wide maintenance exclusion (round 12 #22).
 *
 * A restore renames every database, every -wal and every -shm out from under
 * whatever has them open. SQLite's WAL protects concurrent WRITERS of one file;
 * it has nothing to say about the file being replaced underneath a live
 * connection, which keeps reading and writing the inode that is now sitting in
 * `*.pre-restore-*` and is deleted when the restore finishes. The restore then
 * exited 0 while the daemon's rows went to a file nobody will ever read again —
 * the restore "succeeded" and the daemon was not using restored state.
 *
 * So a restore claims this file for the installation first, and refuses to swap
 * anything while a database still has a user attached.
 */
export const MAINTENANCE_LOCK_FILE = "maintenance.lock";

interface MaintenanceLockPayload {
  readonly pid: number;
  readonly startedAtIso: string;
  readonly purpose: string;
}

/** Exclusions this process holds: a second restore HERE is still a second restore. */
const heldExclusions = new Set<string>();

function processIsAlive(pid: number): boolean {
  try {
    // Signal 0 is an existence probe; EPERM means "alive, someone else's".
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** An acquired exclusion. `release()` is idempotent and only ever removes ours. */
export interface MaintenanceExclusion {
  readonly path: string;
  release: () => void;
}

/** The holder a lock file names, or undefined when it names nobody readable. */
function maintenanceLockHolder(file: string): MaintenanceLockPayload | undefined {
  let holder: unknown;
  try {
    holder = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined; // empty (a claim being written right now), or corrupt
  }
  if (typeof holder !== "object" || holder === null) return undefined;
  const payload = holder as Partial<MaintenanceLockPayload>;
  return typeof payload.pid === "number" ? (payload as MaintenanceLockPayload) : undefined;
}

/**
 * Why an existing lock file blocks a claim, always naming the file.
 *
 * ROUND 13 #19 — THERE IS NO AUTOMATIC STALE RECOVERY ANY MORE, and that is the
 * fix rather than a limitation. The reclaim path was
 * "read the holder, see it is dead, `rmSync`, create ours", and two processes
 * running it against one dead holder end with A holding a live lock that B then
 * DELETES before creating its own: both believe they hold the exclusion and both
 * swap the same files. There is no ordering of read/unlink/create that closes
 * that without an OS-held mutex, and Node has no portable flock. So a lock that
 * exists is a refusal — naming the file, the pid and whether that pid is still
 * running, so an operator whose machine lost power mid-restore removes one named
 * file instead of guessing. A deterministic refusal beats a racy rescue.
 */
function maintenanceLockRefusal(file: string): string {
  const holder = maintenanceLockHolder(file);
  if (holder !== undefined && processIsAlive(holder.pid)) {
    return (
      `the maintenance exclusion ${file} is held by pid ${holder.pid} ` +
      `(${holder.purpose || "unknown"}, since ${holder.startedAtIso || "an unknown time"}) — ` +
      `nothing was replaced`
    );
  }
  const whose =
    holder === undefined
      ? "and it does not name a holder (it may be a claim another process is writing right now)"
      : `whose holder (pid ${holder.pid}, ${holder.purpose || "unknown"}, since ` +
        `${holder.startedAtIso || "an unknown time"}) is not running`;
  return (
    `the maintenance exclusion ${file} already exists ${whose}. It is NOT reclaimed ` +
    `automatically — two processes reclaiming one stale lock both end up holding it — so ` +
    `confirm no restore is in progress ("strada kill") and then remove ${file} by hand`
  );
}

/**
 * Claim the installation's maintenance exclusion, or throw naming the holder.
 *
 * The claim is materialised in full and then LINKED into place, so the lock file
 * never exists empty or half-written: a concurrent acquirer reading it either
 * sees a complete holder or sees no file at all (#19 — an empty lock used to be
 * read as corrupt, and therefore as free). `link` fails with EEXIST when the
 * name is taken, which is the atomic test-and-set the exclusion needs, and a
 * holder inside THIS process is never stale, because that is the concurrent
 * restore the exclusion exists to stop.
 */
export function acquireMaintenanceExclusion(
  dir: string,
  purpose = "restore",
): MaintenanceExclusion {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, MAINTENANCE_LOCK_FILE);
  const key = path.resolve(file);
  if (heldExclusions.has(key)) {
    throw new Error(
      `another restore in this process already holds the maintenance exclusion ${file}`,
    );
  }
  const payload: MaintenanceLockPayload = {
    pid: process.pid,
    startedAtIso: new Date().toISOString(),
    purpose,
  };
  const claim = `${file}.claim-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(
    claim,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0),
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(payload)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    // Atomic: it is our complete claim that appears under the lock name, or
    // nothing does. Never an unlink of somebody else's file.
    linkSync(claim, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    throw new Error(maintenanceLockRefusal(file));
  } finally {
    rmSync(claim, { force: true });
  }
  heldExclusions.add(key);
  let released = false;
  return {
    path: file,
    release: (): void => {
      if (released) return;
      released = true;
      heldExclusions.delete(key);
      try {
        const holder = JSON.parse(readFileSync(file, "utf8")) as MaintenanceLockPayload;
        if (holder.pid !== process.pid) return; // not ours any more; leave it alone
      } catch {
        // Unreadable or gone: removing it below is still the right end state.
      }
      rmSync(file, { force: true });
    },
  };
}

/**
 * THE OTHER HALF OF THE EXCLUSION (round 13 #18): an opener that honours it.
 *
 * The restore's "is anything attached" probe can only ever describe the instant
 * it ran. A store that opens a runtime database while a restore holds the
 * exclusion is the case the probe cannot see, and it ends with the store writing
 * to an inode the swap is about to rename away and delete — the restore reports
 * success and the installation is not using restored state. So an opener asks
 * this first, and the exclusion becomes a protocol both sides take part in
 * rather than a lock only one side reads.
 *
 * Only a LIVE holder blocks: a lock left behind by a dead process is a restore's
 * problem to refuse (see {@link maintenanceLockRefusal}), and must never wedge
 * the daemon out of its own databases.
 */
export function assertNoMaintenanceExclusion(dir: string, what: string): void {
  const file = path.join(dir, MAINTENANCE_LOCK_FILE);
  if (!existsSync(file)) return;
  const holder = maintenanceLockHolder(file);
  if (holder === undefined || !processIsAlive(holder.pid)) return;
  throw new Error(
    `refusing to ${what}: a maintenance operation (${holder.purpose || "unknown"}) holds ` +
      `${file} as pid ${holder.pid} since ${holder.startedAtIso || "an unknown time"}. ` +
      `Opening a database it is replacing would write to a file that is about to be deleted; ` +
      `retry once the operation finishes.`,
  );
}

/**
 * Does another connection still have this database open?
 *
 * `locking_mode = EXCLUSIVE` in WAL mode has to take the exclusive DMS lock on
 * the -shm, which every open connection holds shared for as long as it is open —
 * not merely for the length of a transaction. So SQLITE_BUSY here means "a
 * process has this database open right now", while WAL residue left by a crash
 * (a -wal with nobody attached) succeeds and is correctly NOT reported as a
 * user. Measured both ways before it was relied on.
 *
 * Returns the reason, or undefined when nothing is attached. A file that cannot
 * be opened at all is not reported as in use: that is the staging check's job,
 * and guessing here would turn a permission problem into a wrong diagnosis.
 *
 * Known limit: a database in rollback-journal mode with an IDLE connection holds
 * no lock and cannot be detected. The runtime's databases are WAL.
 */
export function attachedDatabaseUser(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  let db: Database.Database;
  try {
    db = new Database(file, { fileMustExist: true });
  } catch {
    return undefined;
  }
  try {
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("COMMIT");
    return undefined;
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (code.startsWith("SQLITE_BUSY") || code === "SQLITE_LOCKED" || code === "SQLITE_PROTOCOL") {
      return `is still in use by another connection (${code})`;
    }
    return undefined;
  } finally {
    db.close();
  }
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
  /**
   * Where the installation-wide maintenance exclusion is taken (#22).
   *
   * Defaults to the directory the `strada-home` root is being restored into —
   * the one directory every installation has — falling back to the user home,
   * the memory root, then the first root in the plan.
   */
  maintenanceDir?: string;
  /**
   * Swap the files even though a database still has a connection attached (#22).
   *
   * Default false. The refusal is what makes exit 0 mean "the installation is
   * using restored state"; this exists for the operator who knows the attached
   * process is a reader they are willing to break, and it is reported.
   */
  allowAttachedUsers?: boolean;
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
  /** The same place with every symlink resolved: the duplicate-destination key. */
  readonly canonical: string;
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

/**
 * Is this directory case-insensitive? MEASURED, with a probe file, never assumed
 * from the platform: a Mac can hold a case-sensitive volume and a Linux box a
 * case-insensitive one. Cached per directory for the length of the process.
 *
 * A directory that cannot be probed (unwritable, gone) answers `true`: the
 * consequence of a wrong `true` is a refusal that names two destinations as one
 * file, and the consequence of a wrong `false` is the data loss #21 describes.
 */
const caseInsensitiveDirs = new Map<string, boolean>();
function directoryIsCaseInsensitive(dir: string): boolean {
  const existing = realPathAsFarAsItExists(dir);
  const cached = caseInsensitiveDirs.get(existing);
  if (cached !== undefined) return cached;
  // The flipped name is built from the SAME token, never by rewriting the whole
  // path: a directory whose own name contains the probe word would be rewritten
  // instead, and the probe would answer about a file it never created.
  const token = `strada-case-probe-${randomBytes(6).toString("hex")}`;
  const probe = path.join(existing, `.${token}`);
  let answer = true;
  try {
    writeFileSync(probe, "", { mode: 0o600 });
    answer = existsSync(path.join(existing, `.${token.toUpperCase()}`));
  } catch {
    answer = true;
  } finally {
    rmSync(probe, { force: true });
  }
  caseInsensitiveDirs.set(existing, answer);
  return answer;
}

/**
 * Every key a destination must be unique under (round 13 #21).
 *
 * The canonical path alone was the duplicate check, and it compares STRINGS: on
 * a case-insensitive filesystem `Token` and `token` are two keys and one file, so
 * a manifest naming both passed the check, shared one staging file and one aside
 * name, and ended with the second swap failing on a staged file the first had
 * consumed — the rollback then deleted the destination and could not find the
 * aside the second swap had overwritten. Neither the original nor the restored
 * file was left on disk.
 *
 * Two keys close that: the inode of a destination that already exists (which
 * also catches a hard link and two spellings of one path), and the case-folded
 * path wherever the filesystem folds case.
 */
function destinationKeys(target: string): string[] {
  const keys = [target];
  try {
    // bigint: a Windows file id loses precision as a double, and two files
    // must not share a key.
    const stat = statSync(target, { bigint: true });
    keys.push(`inode:${stat.dev}:${stat.ino}`);
  } catch {
    // Not there yet: a fresh destination has no inode to collide on.
  }
  if (directoryIsCaseInsensitive(path.dirname(target))) keys.push(`folded:${target.toLowerCase()}`);
  return keys;
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

  /**
   * The member inside the backup directory, or the reason it is not one (#19).
   *
   * `backup` is a manifest field like any other: pointed at `../../elsewhere` it
   * made the restore read a file from outside the archive — one that passes every
   * member check, because the manifest recorded ITS size — and install those
   * bytes over a live database.
   */
  const memberInside = (member: string): { file: string } | { problem: string } => {
    const resolved = resolveInsideRoot(opts.backupDir, member);
    if ("problem" in resolved) {
      return { problem: `${member} ${resolved.problem.replace("the root", "the backup directory")}` };
    }
    // ROUND 13 #20 — the LEAF is part of the containment check. Only the parent
    // was canonicalized, so a member that was itself a symbolic link to a
    // database outside the archive passed every check (the manifest records the
    // link target's size, so even the byte count matched) and its bytes were
    // validated, copied and installed over a live database. A backup member is a
    // regular file inside the backup directory or it is not a member.
    const leaf = lstatSync(resolved.target, { throwIfNoEntry: false });
    if (leaf?.isSymbolicLink() === true) {
      return {
        problem:
          `${member} is a symbolic link (to ${realPathAsFarAsItExists(resolved.target)}); a backup ` +
          `member must be a regular file inside the backup directory`,
      };
    }
    if (leaf !== undefined && !leaf.isFile()) {
      return { problem: `${member} is not a regular file inside the backup directory` };
    }
    const real = realPathAsFarAsItExists(resolved.target);
    const realRel = path.relative(realPathAsFarAsItExists(opts.backupDir), real);
    if (realRel === "" || realRel.startsWith("..") || path.isAbsolute(realRel)) {
      return { problem: `${member} resolves to ${real}, outside the backup directory` };
    }
    return { file: resolved.target };
  };

  for (const entry of manifest.databases) {
    const rootPath = rootPathFor(entry.root);
    if (rootPath === undefined) {
      problems.push(`${BACKUP_MANIFEST_FILE} names no directory for root "${entry.root}"`);
      continue;
    }
    const member = memberInside(entry.backup);
    if ("problem" in member) {
      problems.push(member.problem);
      continue;
    }
    const placed = resolveInsideRoot(rootPath, entry.relative);
    if ("problem" in placed) {
      problems.push(`${entry.backup} (for ${entry.relative} in root "${entry.root}") ${placed.problem}`);
      continue;
    }
    const problem = unusableDatabaseSource(member.file, entry.bytes);
    if (problem !== undefined) {
      problems.push(`${entry.backup} (for ${placed.target}) ${problem}`);
      continue;
    }
    items.push({
      kind: "database",
      root: entry.root,
      relative: entry.relative,
      backupFile: member.file,
      target: placed.target,
      canonical: placed.canonical,
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
    const member = memberInside(entry.backup);
    if ("problem" in member) {
      problems.push(member.problem);
      continue;
    }
    const placed = resolveInsideRoot(rootPath, entry.relative);
    if ("problem" in placed) {
      problems.push(`${entry.backup} (for ${entry.relative} in root "${entry.root}") ${placed.problem}`);
      continue;
    }
    const problem = unusableBlobSource(member.file, entry);
    if (problem !== undefined) {
      problems.push(`${entry.backup} (for ${placed.target}) ${problem}`);
      continue;
    }
    items.push({
      kind: "blob",
      root: entry.root,
      relative: entry.relative,
      backupFile: member.file,
      target: placed.target,
      canonical: placed.canonical,
      rootPath,
      sourceRootPath: manifest.roots[entry.root] ?? rootPath,
      sha256: entry.sha256,
    });
  }

  /**
   * Two entries for one destination destroyed BOTH copies (round 12 #20).
   *
   * They share a staging name and an aside name: the first swap moved the
   * original to `<target>.pre-restore-<stamp>` and put the replacement in place,
   * the second moved THAT to the same aside name — overwriting the only copy of
   * the live data — and then failed on a staged file the first swap had already
   * consumed. The rollback deleted the destination and could not find the aside,
   * so the probe ended with neither the original nor the restored file on disk.
   *
   * Checked on the canonical path, before anything is staged.
   */
  const byDestination = new Map<string, RestorePlanItem>();
  for (const item of items) {
    let first: RestorePlanItem | undefined;
    const keys = destinationKeys(item.canonical);
    for (const key of keys) {
      const seen = byDestination.get(key);
      if (seen !== undefined) {
        first = seen;
        break;
      }
    }
    if (first !== undefined) {
      problems.push(
        `${item.target} is named twice by ${BACKUP_MANIFEST_FILE} ` +
          `(as ${first.root}/${first.relative} and ${item.root}/${item.relative}, which are the ` +
          `same file on this filesystem) — one destination, one source`,
      );
      continue;
    }
    for (const key of keys) byDestination.set(key, item);
  }

  if (problems.length > 0) {
    throw new Error(
      `Restore from ${opts.backupDir} refused: ${problems.length} unusable source(s) — ` +
        `${problems.join("; ")}. Nothing was replaced; every live database still holds ` +
        `what it held before.`,
    );
  }

  /**
   * The exclusion, then the proof that nothing is attached (round 12 #22).
   *
   * In this order: claiming the exclusion first is what stops a second restore
   * from starting between the check and the swap, and the check is what makes
   * exit 0 mean the installation is using restored state rather than "the files
   * on disk changed while a daemon carried on writing to the inode they used to
   * name".
   */
  const maintenanceDir =
    opts.maintenanceDir ??
    rootPathFor(STRADA_HOME_ROOT_NAME) ??
    rootPathFor(USER_HOME_ROOT_NAME) ??
    rootPathFor(MEMORY_ROOT_NAME) ??
    items[0]?.rootPath;
  if (maintenanceDir === undefined) {
    // Nothing to restore and nowhere to take an exclusion: there is no
    // installation here, which is a refusal, not a silent success.
    throw new Error(
      `Restore from ${opts.backupDir} refused: ${BACKUP_MANIFEST_FILE} names nothing to restore`,
    );
  }
  let exclusion: MaintenanceExclusion;
  try {
    exclusion = acquireMaintenanceExclusion(maintenanceDir, "restore");
  } catch (err) {
    throw new Error(
      `Restore from ${opts.backupDir} refused: ${(err as Error).message}. Nothing was replaced; ` +
        `every live database still holds what it held before.`,
    );
  }
  try {
    assertNothingAttached(items, opts);
    return await replaceDestinations(items, opts);
  } finally {
    exclusion.release();
  }
}

/**
 * Refuse while any destination still has a database user attached.
 *
 * ROUND 13 #18 — CHECKED ONCE, THIS EXPIRED BEFORE IT WAS USED. The probe ran
 * before staging, and staging is arbitrarily long (a copy per database, an
 * integrity check on each, a row rebase); a runtime that started inside that
 * window held the inode the swap then renamed away and deleted, so the restore
 * exited 0 while the daemon's rows went to a file nobody would ever read again —
 * exactly the failure the check was added for. It is therefore asked again after
 * staging, and once more immediately before each individual rename, and the
 * asides are checked after the swap ({@link replaceDestinations}).
 */
function assertNothingAttached(
  items: readonly RestorePlanItem[],
  opts: RestoreRunOptions,
): void {
  if (opts.allowAttachedUsers === true) return;
  const attached: string[] = [];
  for (const item of items) {
    if (item.kind !== "database") continue;
    const reason = attachedDatabaseUser(item.target);
    if (reason !== undefined) attached.push(`${item.target} ${reason}`);
  }
  if (attached.length === 0) return;
  throw new Error(
    `Restore from ${opts.backupDir} refused: ${attached.length} database(s) still have a ` +
      `user attached — ${attached.join("; ")}. Stop the runtime ("strada kill") and retry; ` +
      `nothing was replaced, every live database still holds what it held before.`,
  );
}

/**
 * Phases 2 and 3 of a restore: stage every replacement, then swap them in.
 *
 * Split out from {@link restoreRuntimeData} so the maintenance exclusion wraps
 * the whole of it in a `finally` — an exclusion that outlives a failed restore
 * would wedge the next attempt.
 */
async function replaceDestinations(
  items: readonly RestorePlanItem[],
  opts: RestoreRunOptions,
): Promise<RestoreRunResult> {
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
    for (const [index, item] of items.entries()) {
      // The INDEX is in the name (#21): two destinations that are one file on
      // this filesystem — `Token` and `token` — shared a single staging file, so
      // the second swap renamed a file the first had already consumed. The
      // equivalence check above refuses such a pair; this makes the staging
      // names distinct whether or not anything caught them.
      const stagedPath = `${item.target}.restore-${stamp}-${index}.tmp`;
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

  // #18: the probe that ran before staging describes an instant that has passed.
  // Everything is staged and NOTHING has been replaced yet, so a user that
  // appeared in between still costs only this refusal.
  try {
    assertNothingAttached(items, opts);
  } catch (err) {
    discardStaged();
    throw err;
  }

  const swaps: SwapRecord[] = [];
  /** Undo every swap made so far. Returns what could not be put back. */
  const rollback = (): string[] => {
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
    return unrecovered;
  };
  try {
    for (const entry of staged) {
      // #18, last chance before this file's own inode moves: a user that
      // attached during the swap of an EARLIER destination is caught here, and
      // the rollback below puts back everything already swapped.
      if (opts.allowAttachedUsers !== true && entry.item.kind === "database") {
        const reason = attachedDatabaseUser(entry.item.target);
        if (reason !== undefined) {
          throw new Error(
            `${entry.item.target} ${reason} — it was opened after the restore checked, so ` +
              `replacing it would leave that connection writing to a deleted file`,
          );
        }
      }
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
    // #18, the last window the checks above cannot cover: a connection that
    // opened a database between its own check and its own rename now holds the
    // inode sitting in the aside. It is still ATTACHED to it, which is a fact
    // this can read — and the honest answer is to put every original back, so
    // whatever that connection has written since is still there, rather than to
    // report a restore the installation is not using.
    const usingReplaced: string[] = [];
    if (opts.allowAttachedUsers !== true) {
      for (const record of swaps) {
        if (record.item.kind !== "database") continue;
        const aside = record.asides.find((a) => a.from === record.item.target)?.to;
        if (aside === undefined) continue;
        const reason = attachedDatabaseUser(aside);
        if (reason !== undefined) {
          usingReplaced.push(
            `${record.item.target} ${reason} through the file it was replaced from (${aside})`,
          );
        }
      }
    }
    if (usingReplaced.length > 0) {
      throw new Error(
        `${usingReplaced.length} database(s) were opened during the swap — ${usingReplaced.join("; ")}`,
      );
    }
  } catch (err) {
    const unrecovered = rollback();
    throw new Error(
      `Restore from ${opts.backupDir} failed while replacing the destinations: ` +
        `${(err as Error).message}. Every destination was rolled back to what it held before` +
        (unrecovered.length > 0 ? `, EXCEPT: ${unrecovered.join("; ")}` : "") +
        `.`,
    );
  }

  // In place. The originals are no longer the only copy of anything — and one
  // we cannot delete is residue beside a restored database, never a reason to
  // report a completed restore as failed. The aside's own sidecars go with it:
  // the attachment probe above opens each aside, and a -wal it created must not
  // outlive the file it belongs to.
  for (const record of swaps) {
    for (const aside of record.asides) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(`${aside.to}${suffix}`, { force: true });
        } catch {
          // Left behind next to the file it used to be; the restore stands.
        }
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
  /** `--allow-missing-blobs`; record a row whose bytes are gone instead of failing (#21). */
  allowMissingBlobs?: boolean;
}

/** Parse the CLI arguments. Throws with usage on anything missing. */
export function parseBackupArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    // A switch takes no value, so the argument after it is not consumed.
    if (arg === "--allow-missing-blobs") {
      switches.add("allow-missing-blobs");
      continue;
    }
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
        "[--strada-home <dir>] [--user-home <dir>] [--project-root <dir>] [--timestamp <ts>] " +
        "[--allow-missing-blobs]",
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
    ...(switches.has("allow-missing-blobs") ? { allowMissingBlobs: true } : {}),
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
      ...(parsed.allowMissingBlobs ? { allowMissingBlobs: true } : {}),
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
