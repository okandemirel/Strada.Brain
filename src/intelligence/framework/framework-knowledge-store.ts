/**
 * Framework Knowledge Store
 *
 * SQLite-backed versioned storage for framework API snapshots.
 * Stores extraction results from Strada.Core, Strada.Modules, and Strada.MCP.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { configureSqlitePragmas } from "../../memory/unified/sqlite-pragmas.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  FrameworkAPISnapshot,
  FrameworkPackageId,
  FrameworkPackageMetadata,
  SourceLanguage,
  SourceOrigin,
} from "./framework-types.js";
import { FRAMEWORK_SCHEMA_VERSION } from "./framework-types.js";

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS framework_snapshots (
  package_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  version TEXT,
  git_hash TEXT,
  snapshot_json TEXT NOT NULL,
  extracted_at INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  source_origin TEXT NOT NULL,
  source_language TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (package_id, extracted_at)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_package_latest
  ON framework_snapshots(package_id, extracted_at DESC);

CREATE TABLE IF NOT EXISTS framework_metadata (
  package_id TEXT PRIMARY KEY,
  last_sync_at INTEGER,
  last_version TEXT,
  last_git_hash TEXT,
  last_content_hash TEXT,
  sync_count INTEGER DEFAULT 0
);
`;

/**
 * Additive migrations for databases created before a column existed.
 * Each entry is applied only when PRAGMA table_info lacks the column.
 */
const COLUMN_MIGRATIONS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  // audited 2026-09-02: needsSync gained a content fingerprint.
  { table: "framework_metadata", column: "last_content_hash", ddl: "ALTER TABLE framework_metadata ADD COLUMN last_content_hash TEXT" },
];

/**
 * Stable fingerprint of a snapshot's extracted API content. Excludes
 * extraction time and source path (those change without the API changing) so
 * two extractions of the same code fingerprint identically. This is the
 * signal `needsSync` was missing: version and git HEAD both stay put during an
 * in-place edit, so they could never say "changed". Audited 2026-09-02.
 */
export function computeSnapshotFingerprint(snapshot: FrameworkAPISnapshot): string {
  const content = {
    packageId: snapshot.packageId,
    packageName: snapshot.packageName,
    version: snapshot.version,
    gitHash: snapshot.gitHash,
    namespaces: snapshot.namespaces,
    baseClasses: Object.fromEntries(snapshot.baseClasses),
    attributes: Object.fromEntries(snapshot.attributes),
    interfaces: snapshot.interfaces,
    enums: snapshot.enums,
    classes: snapshot.classes,
    structs: snapshot.structs,
    exportedFunctions: snapshot.exportedFunctions,
    tools: snapshot.tools,
    resources: snapshot.resources,
    prompts: snapshot.prompts,
    fileCount: snapshot.fileCount,
  };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

// ─── Serialization Helpers ──────────────────────────────────────────────────

function serializeSnapshot(snapshot: FrameworkAPISnapshot): string {
  // Convert Maps to plain objects for JSON
  const obj = {
    ...snapshot,
    baseClasses: Object.fromEntries(snapshot.baseClasses),
    attributes: Object.fromEntries(snapshot.attributes),
    extractedAt: snapshot.extractedAt.getTime(),
  };
  return JSON.stringify(obj);
}

function deserializeSnapshot(json: string, row: {
  package_id: string;
  source_path: string;
  source_origin: string;
  source_language: string;
  file_count: number;
  extracted_at: number;
}): FrameworkAPISnapshot {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return {
    packageId: row.package_id as FrameworkPackageId,
    packageName: (parsed.packageName as string) ?? "",
    version: (parsed.version as string) ?? null,
    gitHash: (parsed.gitHash as string) ?? null,
    namespaces: (parsed.namespaces as string[]) ?? [],
    baseClasses: new Map(Object.entries((parsed.baseClasses as Record<string, string[]>) ?? {})),
    attributes: new Map(Object.entries((parsed.attributes as Record<string, string[]>) ?? {})),
    interfaces: (parsed.interfaces as FrameworkAPISnapshot["interfaces"]) ?? [],
    enums: (parsed.enums as FrameworkAPISnapshot["enums"]) ?? [],
    classes: (parsed.classes as FrameworkAPISnapshot["classes"]) ?? [],
    structs: (parsed.structs as FrameworkAPISnapshot["structs"]) ?? [],
    exportedFunctions: (parsed.exportedFunctions as FrameworkAPISnapshot["exportedFunctions"]) ?? [],
    tools: (parsed.tools as FrameworkAPISnapshot["tools"]) ?? [],
    resources: (parsed.resources as FrameworkAPISnapshot["resources"]) ?? [],
    prompts: (parsed.prompts as FrameworkAPISnapshot["prompts"]) ?? [],
    extractedAt: new Date(row.extracted_at),
    sourcePath: row.source_path,
    sourceOrigin: row.source_origin as SourceOrigin,
    sourceLanguage: row.source_language as SourceLanguage,
    fileCount: row.file_count,
  };
}

// ─── Store ──────────────────────────────────────────────────────────────────

export class FrameworkKnowledgeStore {
  private db: Database.Database;
  private readonly stmtCache = new Map<string, Database.Statement>();

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    configureSqlitePragmas(this.db, "balanced");
  }

  /** Create tables and indexes */
  initialize(): void {
    this.db.exec(SCHEMA_SQL);
    for (const m of COLUMN_MIGRATIONS) {
      const cols = this.db.prepare(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === m.column)) {
        this.db.exec(m.ddl);
      }
    }
  }

  /** Store a new snapshot */
  storeSnapshot(snapshot: FrameworkAPISnapshot): void {
    const insert = this.prepare(`
      INSERT OR REPLACE INTO framework_snapshots
        (package_id, package_name, version, git_hash, snapshot_json,
         extracted_at, source_path, source_origin, source_language,
         file_count, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const upsertMeta = this.prepare(`
      INSERT INTO framework_metadata (package_id, last_sync_at, last_version, last_git_hash, last_content_hash, sync_count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(package_id) DO UPDATE SET
        last_sync_at = excluded.last_sync_at,
        last_version = excluded.last_version,
        last_git_hash = excluded.last_git_hash,
        last_content_hash = excluded.last_content_hash,
        sync_count = sync_count + 1
    `);

    const now = snapshot.extractedAt.getTime();

    this.db.transaction(() => {
      insert.run(
        snapshot.packageId,
        snapshot.packageName,
        snapshot.version,
        snapshot.gitHash,
        serializeSnapshot(snapshot),
        now,
        snapshot.sourcePath,
        snapshot.sourceOrigin,
        snapshot.sourceLanguage,
        snapshot.fileCount,
        FRAMEWORK_SCHEMA_VERSION,
      );
      upsertMeta.run(
        snapshot.packageId,
        now,
        snapshot.version,
        snapshot.gitHash,
        computeSnapshotFingerprint(snapshot),
      );
    })();
  }

  /** Get the latest snapshot for a package */
  getLatestSnapshot(packageId: FrameworkPackageId): FrameworkAPISnapshot | null {
    return this.getSnapshotByOffset(packageId, 0);
  }

  /** Get the previous snapshot for drift comparison */
  getPreviousSnapshot(packageId: FrameworkPackageId): FrameworkAPISnapshot | null {
    return this.getSnapshotByOffset(packageId, 1);
  }

  private getSnapshotByOffset(packageId: FrameworkPackageId, offset: number): FrameworkAPISnapshot | null {
    const stmt = this.prepare(`
      SELECT * FROM framework_snapshots
      WHERE package_id = ?
      ORDER BY extracted_at DESC
      LIMIT 1 OFFSET ?
    `);
    const row = stmt.get(packageId, offset) as {
      package_id: string;
      snapshot_json: string;
      source_path: string;
      source_origin: string;
      source_language: string;
      file_count: number;
      extracted_at: number;
    } | undefined;
    if (!row) return null;
    return deserializeSnapshot(row.snapshot_json, row);
  }

  /** Get metadata for a package */
  getMetadata(packageId: FrameworkPackageId): FrameworkPackageMetadata | null {
    const stmt = this.prepare(
      "SELECT * FROM framework_metadata WHERE package_id = ?",
    );
    const row = stmt.get(packageId) as {
      package_id: string;
      last_sync_at: number;
      last_version: string | null;
      last_git_hash: string | null;
      last_content_hash: string | null;
      sync_count: number;
    } | undefined;
    if (!row) return null;
    return {
      packageId: row.package_id as FrameworkPackageId,
      lastSyncAt: row.last_sync_at,
      lastVersion: row.last_version,
      lastGitHash: row.last_git_hash,
      lastContentHash: row.last_content_hash ?? null,
      syncCount: row.sync_count,
    };
  }

  /**
   * Check if a sync is needed.
   *
   * Compares git hash, version and — when the caller offers one — the content
   * fingerprint of the freshly extracted snapshot. Returns true whenever a
   * compared signal differs, AND whenever nothing could be compared: a
   * verdict of "unchanged" with no measurement behind it was the defect here
   * (version and HEAD never move for an in-place edit). Audited 2026-09-02.
   */
  needsSync(
    packageId: FrameworkPackageId,
    currentVersion: string | null,
    currentGitHash: string | null,
    currentContentHash?: string | null,
  ): boolean {
    const meta = this.getMetadata(packageId);
    if (!meta) return true;
    if (!meta.lastSyncAt) return true;

    let compared = 0;
    if (currentGitHash && meta.lastGitHash) {
      compared++;
      if (currentGitHash !== meta.lastGitHash) return true;
    }
    if (currentVersion && meta.lastVersion) {
      compared++;
      if (currentVersion !== meta.lastVersion) return true;
    }
    if (currentContentHash) {
      // A fingerprint was offered: it is the only signal that sees an
      // in-place edit. No stored fingerprint (row predates the column) means
      // nothing to compare against, so the answer is "sync".
      if (!meta.lastContentHash) return true;
      compared++;
      if (currentContentHash !== meta.lastContentHash) return true;
    }

    // Nothing was compared: do not claim "unchanged".
    return compared === 0;
  }

  /** Prune old snapshots keeping only the N most recent per package */
  pruneHistory(keepCount: number = 5): void {
    const packages = this.db.prepare(
      "SELECT DISTINCT package_id FROM framework_snapshots",
    ).all() as Array<{ package_id: string }>;

    const deleteOld = this.prepare(`
      DELETE FROM framework_snapshots
      WHERE package_id = ? AND extracted_at NOT IN (
        SELECT extracted_at FROM framework_snapshots
        WHERE package_id = ?
        ORDER BY extracted_at DESC
        LIMIT ?
      )
    `);

    this.db.transaction(() => {
      for (const { package_id } of packages) {
        deleteOld.run(package_id, package_id, keepCount);
      }
    })();
  }

  /** Get all package IDs that have snapshots */
  getStoredPackageIds(): FrameworkPackageId[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT package_id FROM framework_snapshots",
    ).all() as Array<{ package_id: string }>;
    return rows.map((r) => r.package_id as FrameworkPackageId);
  }

  /** Close the database connection */
  close(): void {
    this.stmtCache.clear();
    this.db.close();
  }

  private prepare(sql: string): Database.Statement {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }
}
