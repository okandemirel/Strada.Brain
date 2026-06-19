/**
 * SQLite persistence for the Tier 2 dynamic behavioral profiles.
 *
 * Implements the {@link ProfilePersist} boundary that
 * {@link DynamicBehavioralProfileStore} uses, so the learned per-model scores
 * survive restarts (the "continuous" requirement). Flat schema: one row per
 * (key, dimension) accumulator. Each flush is a full-state replace inside one
 * transaction — the store always hands over its complete row set, and the table
 * is tiny (providers + active models × a handful of observed dimensions).
 *
 * Follows the same pragma / prepared-statement pattern as TaskCheckpointStore.
 * Constructing or using it never throws into the boot path: callers wrap it in
 * try/catch and degrade to in-memory-only accumulation on failure.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { configureSqlitePragmas } from "../../memory/unified/sqlite-pragmas.js";
import type { ProfileAccumulatorRow, ProfilePersist } from "./dynamic-behavioral-profiles.js";

interface AccumulatorDbRow {
  key: string;
  dimension: string;
  ema: number;
  samples: number;
  updated_at: number;
}

export class SqliteDynamicProfilePersistence implements ProfilePersist {
  private readonly db: Database.Database;

  constructor(dbFilePath: string) {
    mkdirSync(dirname(dbFilePath), { recursive: true });
    this.db = new Database(dbFilePath);
    configureSqlitePragmas(this.db, "balanced");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dynamic_behavioral_profiles (
        key TEXT NOT NULL,
        dimension TEXT NOT NULL,
        ema REAL NOT NULL,
        samples REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (key, dimension)
      );
    `);
  }

  load(): ProfileAccumulatorRow[] {
    const rows = this.db
      .prepare("SELECT key, dimension, ema, samples, updated_at FROM dynamic_behavioral_profiles")
      .all() as AccumulatorDbRow[];
    return rows.map((r) => ({
      key: r.key,
      dimension: r.dimension,
      ema: r.ema,
      samples: r.samples,
      updatedAt: r.updated_at,
    }));
  }

  save(rows: ProfileAccumulatorRow[]): void {
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO dynamic_behavioral_profiles (key, dimension, ema, samples, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    const replaceAll = this.db.transaction((next: ProfileAccumulatorRow[]) => {
      this.db.exec("DELETE FROM dynamic_behavioral_profiles");
      for (const row of next) {
        insert.run(row.key, row.dimension, row.ema, row.samples, row.updatedAt);
      }
    });
    replaceAll(rows);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed / never opened — ignore
    }
  }
}
