/**
 * Migration Runner for Learning Database
 *
 * Reusable named-migration system for learning.db schema evolution.
 * Creates a migrations tracking table, auto-backs up before applying,
 * and supports idempotent re-runs.
 *
 * Design: Phases 17 and 19 can reuse this runner with their own migrations.
 */

import { copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import type Database from "better-sqlite3";

// =============================================================================
// TYPES
// =============================================================================

/** A named database migration */
export interface Migration {
  /** Unique migration name (e.g., '001-cross-session-provenance') */
  readonly name: string;
  /** Apply the migration (forward-only) */
  up(db: Database.Database): void;
}

/** Result of running migrations */
export interface MigrationResult {
  /** Names of newly applied migrations */
  readonly applied: string[];
  /** Names of already-applied migrations that were skipped */
  readonly skipped: string[];
}

// =============================================================================
// MIGRATION RUNNER
// =============================================================================

export class MigrationRunner {
  private readonly db: Database.Database;
  private readonly dbPath: string;

  constructor(db: Database.Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /**
   * Run all provided migrations, skipping already-applied ones.
   * Creates auto-backup before applying if file-based DB has unapplied migrations.
   */
  run(migrations: Migration[]): MigrationResult {
    // Ensure migrations tracking table
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    );

    // Query applied set
    const appliedRows = this.db.prepare("SELECT name FROM migrations").all() as Array<{ name: string }>;
    const appliedSet = new Set(appliedRows.map(r => r.name));

    // Partition into applied (skip) and unapplied
    const skipped: string[] = [];
    const unapplied: Migration[] = [];

    for (const m of migrations) {
      if (appliedSet.has(m.name)) {
        skipped.push(m.name);
      } else {
        unapplied.push(m);
      }
    }

    // Early return if nothing to do
    if (unapplied.length === 0) {
      return { applied: [], skipped };
    }

    // Auto-backup (file-based DBs only)
    this.backup();

    // Apply each unapplied migration in order
    const applied: string[] = [];
    const insertMigration = this.db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)");

    for (const m of unapplied) {
      m.up(this.db);
      insertMigration.run(m.name, new Date().toISOString());
      applied.push(m.name);
    }

    // Cleanup old backups
    this.cleanupBackups();

    return { applied, skipped };
  }

  /**
   * Create a backup of the database file before migration.
   * Skips for :memory: databases or non-existent files.
   */
  private backup(): void {
    if (this.dbPath === ":memory:" || !existsSync(this.dbPath)) {
      return;
    }

    const backupPath = this.dbPath + ".bak-" + Date.now();
    copyFileSync(this.dbPath, backupPath);
  }

  /**
   * Keep only the last 3 backups, delete older ones.
   */
  private cleanupBackups(): void {
    if (this.dbPath === ":memory:" || !existsSync(this.dbPath)) {
      return;
    }

    try {
      const dir = dirname(this.dbPath) || ".";
      const base = basename(this.dbPath);
      const pattern = base + ".bak-";

      const files = readdirSync(dir)
        .filter(f => f.startsWith(pattern))
        .sort((a, b) => {
          // Sort by timestamp suffix descending (newest first)
          const tsA = parseInt(a.split(".bak-")[1] ?? "0", 10);
          const tsB = parseInt(b.split(".bak-")[1] ?? "0", 10);
          return tsB - tsA;
        });

      // Delete all but the latest 3
      for (const file of files.slice(3)) {
        try {
          unlinkSync(join(dir, file));
        } catch {
          // Best-effort cleanup
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }
}
