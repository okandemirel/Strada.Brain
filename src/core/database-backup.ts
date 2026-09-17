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
 * This module builds the list from the runtime path table (the known database
 * files, plus whatever `*.db` the memory root actually holds, so a database
 * added tomorrow is not silently skipped) and copies each with SQLite's own
 * online backup API — `better-sqlite3`'s `db.backup()` — which is safe while
 * writes are in flight and produces a consistent, checkpointed file.
 *
 * It doubles as the CLI that `scripts/backup.sh` invokes:
 *   node dist/core/database-backup.js --source <memoryRoot> --dest <dir>
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The databases the runtime creates under `memory.dbPath`.
 *
 * Kept as data rather than inlined in a shell script so the backup and the
 * runtime cannot disagree about what exists. Discovery below covers anything
 * this list has not caught up with yet.
 */
export const RUNTIME_DATABASE_FILES: readonly string[] = [
  "campaigns.db",
  "canvas.db",
  "daemon.db",
  "dynamic-profiles.db",
  "framework-knowledge.db",
  "goals.db",
  "hub-owners.db",
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

/** Sidecars that belong to a database, never backed up on their own. */
const SQLITE_SIDECAR = /\.db-(wal|shm|journal)$/;

/**
 * Every database file to back up, as absolute paths.
 *
 * The known table first (stable order), then any other `*.db` the memory root
 * holds. Missing files are skipped — a fresh install has few of them — and
 * -wal/-shm sidecars are never listed: `db.backup()` consumes them as part of
 * the database it is copying.
 */
export function listRuntimeDatabases(memoryRoot: string): string[] {
  if (!existsSync(memoryRoot)) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (seen.has(name)) return;
    const full = path.join(memoryRoot, name);
    if (!existsSync(full) || !statSync(full).isFile()) return;
    seen.add(name);
    found.push(full);
  };
  for (const name of RUNTIME_DATABASE_FILES) add(name);
  for (const entry of readdirSync(memoryRoot).sort()) {
    if (!entry.endsWith(".db") || SQLITE_SIDECAR.test(entry)) continue;
    add(entry);
  }
  return found;
}

export interface DatabaseBackupResult {
  source: string;
  destination: string;
  bytes: number;
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
): Promise<DatabaseBackupResult> {
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

export interface BackupRunOptions {
  memoryRoot: string;
  destDir: string;
  /** Suffix put before `.db` in the destination name; the backup's timestamp. */
  timestamp?: string;
}

/** Back up every runtime database found under `memoryRoot` into `destDir`. */
export async function backupRuntimeDatabases(
  opts: BackupRunOptions,
): Promise<DatabaseBackupResult[]> {
  const sources = listRuntimeDatabases(opts.memoryRoot);
  mkdirSync(opts.destDir, { recursive: true });
  const results: DatabaseBackupResult[] = [];
  for (const source of sources) {
    const base = path.basename(source, ".db");
    const name = opts.timestamp ? `${base}_${opts.timestamp}.db` : `${base}.db`;
    results.push(await backupSqliteDatabase(source, path.join(opts.destDir, name)));
  }
  return results;
}

export interface ParsedArgs {
  source: string;
  dest: string;
  timestamp?: string;
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
    throw new Error("usage: database-backup --source <memory-root> --dest <dir> [--timestamp <ts>]");
  }
  const timestamp = values.get("timestamp");
  return timestamp ? { source, dest, timestamp } : { source, dest };
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
    });
    for (const result of results) {
      process.stdout.write(`${result.destination}\n`);
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
