/**
 * SQLite Pragma Configuration
 *
 * Centralized pragma helper that enforces a locked memory budget across all
 * SQLite databases. Prevents pragma drift between storage classes.
 *
 * Budget: memory=16MB, learning=16MB, tasks=8MB, preferences=2MB (~42MB total)
 */

import type Database from "better-sqlite3";

export type SqliteProfile = "memory" | "learning" | "tasks" | "preferences" | "identity";

/** Cache sizes in KiB (negative = KiB convention for SQLite cache_size pragma) */
const CACHE_SIZES: Record<SqliteProfile, number> = {
  memory: -16000, // 16MB
  learning: -16000, // 16MB
  tasks: -8000, // 8MB
  preferences: -2000, // 2MB
  identity: -2000, // 2MB
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
