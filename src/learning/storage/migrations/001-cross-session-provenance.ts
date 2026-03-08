/**
 * Migration 001: Cross-Session Provenance
 *
 * Adds provenance tracking columns to instincts table and creates
 * instinct_scopes table for project-scope filtering.
 *
 * Changes:
 * - instincts: +origin_session_id, +origin_boot_count, +cross_session_hit_count, +migrated_at
 * - instinct_scopes: new table (instinct_id, project_path, created_at)
 * - Covering index on instinct_scopes(project_path, instinct_id)
 * - Backfills existing instincts as universal (project_path='*')
 */

import type { Migration } from "./index.js";
import type Database from "better-sqlite3";

export const migration001CrossSessionProvenance: Migration = {
  name: "001-cross-session-provenance",

  up(db: Database.Database): void {
    // Add provenance columns with try/catch for idempotency (duplicate column name)
    const addColumn = (col: string): void => {
      try {
        db.prepare("ALTER TABLE instincts ADD COLUMN " + col).run();
      } catch {
        // Column already exists -- expected for idempotent re-runs
      }
    };

    addColumn("origin_session_id TEXT");
    addColumn("origin_boot_count INTEGER");
    addColumn("cross_session_hit_count INTEGER DEFAULT 0");
    addColumn("migrated_at INTEGER");

    // Create instinct_scopes table for project-scope filtering
    db.prepare(`CREATE TABLE IF NOT EXISTS instinct_scopes (
      instinct_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (instinct_id, project_path),
      FOREIGN KEY (instinct_id) REFERENCES instincts(id) ON DELETE CASCADE
    ) WITHOUT ROWID`).run();

    // Covering index for scope filter queries
    db.prepare("CREATE INDEX IF NOT EXISTS idx_instinct_scopes_path ON instinct_scopes(project_path, instinct_id)").run();

    // Backfill existing instincts as universal (project_path='*')
    db.prepare("INSERT OR IGNORE INTO instinct_scopes (instinct_id, project_path, created_at) SELECT id, '*', created_at FROM instincts").run();

    // Mark migrated timestamp on instincts that don't have one yet
    const now = Date.now();
    db.prepare("UPDATE instincts SET migrated_at = ? WHERE migrated_at IS NULL").run(now);
  },
};
