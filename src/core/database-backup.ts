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
 * It doubles as the CLI that `scripts/backup.sh` invokes:
 *   node dist/core/database-backup.js --source <memoryRoot> --dest <dir>
 *       [--strada-home <dir>] [--user-home <dir>] [--timestamp <ts>]
 */

import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStradaHome } from "../common/runtime-paths.js";

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

/** Every known database name, whichever root it lives in. */
export const RUNTIME_DATABASE_FILES: readonly string[] = [
  ...MEMORY_DATABASE_FILES,
  ...STRADA_HOME_DATABASE_FILES,
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
  ];
  const seen = new Set<string>();
  return candidates.filter((root) => {
    if (seen.has(root.path)) return false;
    seen.add(root.path);
    return true;
  });
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

export interface BackupManifest {
  readonly version: 1;
  readonly createdAtIso: string;
  readonly timestamp?: string;
  /** Root label → the absolute directory it was read from. */
  readonly roots: Record<string, string>;
  readonly databases: readonly BackupManifestEntry[];
}

/** Path of the manifest inside a backup directory. */
export function backupManifestPath(backupDir: string): string {
  return path.join(backupDir, BACKUP_MANIFEST_FILE);
}

/**
 * Back up every runtime database of an installation into `destDir`.
 *
 * Files are filed under their root (`<destDir>/memory/…`,
 * `<destDir>/strada-home/…`): two roots can hold the same NAME, and a flat
 * destination silently let one overwrite the other. The manifest beside them
 * records each source path, which is what makes {@link restoreRuntimeDatabases}
 * able to put things back rather than guess.
 */
export async function backupRuntimeDatabases(
  opts: BackupRunOptions,
): Promise<DatabaseBackupResult[]> {
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
  };
  writeFileSync(backupManifestPath(opts.destDir), `${JSON.stringify(manifest, null, 2)}\n`);
  return results;
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
  return manifest;
}

export interface RestoreRunOptions {
  /** The directory `backupRuntimeDatabases` wrote. */
  backupDir: string;
  /**
   * Root label → directory to restore into. Anything not overridden goes back
   * to the absolute path the manifest recorded, which is the point of it.
   */
  roots?: Record<string, string>;
}

/**
 * Put every database in a backup back where its owner reads it.
 *
 * Copied with the online backup API again rather than `cp`: the destination may
 * exist, and this leaves one consistent, checkpointed file with no sidecars.
 */
export async function restoreRuntimeDatabases(
  opts: RestoreRunOptions,
): Promise<DatabaseBackupResult[]> {
  const manifest = readBackupManifest(opts.backupDir);
  const results: DatabaseBackupResult[] = [];
  for (const entry of manifest.databases) {
    const rootPath = opts.roots?.[entry.root] ?? manifest.roots[entry.root];
    if (!rootPath) {
      throw new Error(`${BACKUP_MANIFEST_FILE} names no directory for root "${entry.root}"`);
    }
    const target = path.join(rootPath, entry.relative);
    const backupFile = path.join(opts.backupDir, entry.backup);
    // A stale -wal beside the target would be replayed over the restored file.
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${target}${suffix}`, { force: true });
    }
    const copy = await backupSqliteDatabase(backupFile, target);
    results.push({
      ...copy,
      root: entry.root,
      relative: entry.relative,
      restorePath: target,
    });
  }
  return results;
}

export interface ParsedArgs {
  source: string;
  dest: string;
  timestamp?: string;
  /** `--strada-home`; omitted means "whatever the runtime resolves". */
  stradaHome?: string;
  /** `--user-home`; omitted means `os.homedir()`. */
  userHome?: string;
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
        "[--strada-home <dir>] [--user-home <dir>] [--timestamp <ts>]",
    );
  }
  const timestamp = values.get("timestamp");
  const stradaHome = values.get("strada-home");
  const userHome = values.get("user-home");
  return {
    source,
    dest,
    ...(timestamp ? { timestamp } : {}),
    ...(stradaHome ? { stradaHome } : {}),
    ...(userHome ? { userHome } : {}),
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
    const results = await backupRuntimeDatabases({
      memoryRoot: parsed.source,
      destDir: parsed.dest,
      ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {}),
      ...(parsed.stradaHome ? { stradaHome: parsed.stradaHome } : {}),
      ...(parsed.userHome ? { userHome: parsed.userHome } : {}),
    });
    for (const result of results) {
      process.stdout.write(`${result.destination}\n`);
    }
    // The manifest is part of the backup — it is what a restore reads — so the
    // caller checksums it like everything else.
    if (results.length > 0) {
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
