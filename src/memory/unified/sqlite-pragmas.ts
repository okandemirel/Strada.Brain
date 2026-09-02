/**
 * SQLite Pragma Configuration
 *
 * Centralized pragma helper that enforces a locked memory budget across all
 * SQLite databases. Prevents pragma drift between storage classes.
 *
 * Budget: memory=16MB, learning=16MB, tasks=8MB, preferences=2MB (~42MB total)
 */

import type Database from "better-sqlite3";
import { getLogger } from "../../utils/logger.js";

function getLoggerSafe() {
  try { return getLogger(); } catch { return console; }
}

export type SqliteProfile = "memory" | "learning" | "tasks" | "preferences" | "identity" | "daemon" | "balanced";

/** Cache sizes in KiB (negative = KiB convention for SQLite cache_size pragma) */
const CACHE_SIZES: Record<SqliteProfile, number> = {
  memory: -16000, // 16MB
  learning: -16000, // 16MB
  tasks: -8000, // 8MB
  preferences: -2000, // 2MB
  identity: -2000, // 2MB
  daemon: -4000, // 4MB
  balanced: -8000, // 8MB
};

/**
 * Apply standardized SQLite pragmas for the given profile.
 *
 * Sets: WAL journal mode, NORMAL synchronous, profile-specific cache_size,
 * temp_store = memory, busy_timeout = 5000ms, foreign_keys = ON.
 */
export function configureSqlitePragmas(
  db: Database.Database,
  profile: SqliteProfile,
): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma(`cache_size = ${CACHE_SIZES[profile]}`);
  db.pragma("temp_store = memory");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
}

/**
 * Validate database integrity and attempt auto-repair on corruption.
 *
 * Steps: WAL checkpoint, integrity_check, REINDEX if needed.
 * Returns true if healthy (or successfully repaired), false if unrecoverable.
 * Callers MUST consume the verdict — it is the only corruption signal the
 * memory layer has (audited 2026-09-02).
 */
export function validateAndRepairSqlite(
  db: Database.Database,
  profile: SqliteProfile,
): boolean {
  try {
    // Checkpoint WAL to ensure all writes are committed
    db.pragma("wal_checkpoint(RESTART)");
  } catch {
    // Non-fatal: WAL might not exist yet on first run
  }

  const integrityCheck = (): Array<{ integrity_check: string }> =>
    db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  const isOk = (rows: Array<{ integrity_check: string }>): boolean =>
    rows.length === 1 && rows[0]?.integrity_check === "ok";

  try {
    const result = integrityCheck();
    if (isOk(result)) return true;

    // Attempt repair via REINDEX. This must be issued as a statement:
    // `db.pragma("REINDEX")` sends `PRAGMA REINDEX`, an unknown pragma that
    // SQLite silently ignores, so the "repair" never ran and the recheck
    // re-read the same damage — the function could not return true for a
    // corrupt-index database (audited 2026-09-02).
    try {
      db.exec("REINDEX");
      const recheck = integrityCheck();
      const repaired = isOk(recheck);
      if (!repaired) {
        getLoggerSafe().warn(
          `[sqlite:${profile}] integrity_check still failing after REINDEX: ${recheck.slice(0, 3).map((r) => r.integrity_check).join(" | ")}`,
        );
      }
      return repaired;
    } catch (repairError) {
      getLoggerSafe().warn(
        `[sqlite:${profile}] integrity_check failed (${result.slice(0, 3).map((r) => r.integrity_check).join(" | ")}) and REINDEX threw: ${String(repairError)}`,
      );
      return false;
    }
  } catch (checkError) {
    // integrity_check itself throws on heavier damage (SQLITE_CORRUPT).
    getLoggerSafe().warn(`[sqlite:${profile}] integrity_check could not run: ${String(checkError)}`);
    return false;
  }
}
