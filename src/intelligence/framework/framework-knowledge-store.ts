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

-- One machine, several sources (plan 2.13 / U2+M3 / D51): a project's own
-- Strada.Core and a shallow GitHub clone of the same package are DIFFERENT
-- knowledge, and keying only by package let whichever synced last answer for
-- both — including drift compared across two unrelated trees.
CREATE INDEX IF NOT EXISTS idx_snapshots_package_source
  ON framework_snapshots(package_id, source_path, extracted_at DESC);

-- Sync bookkeeping per (package, source). The old framework_metadata is keyed
-- by package alone, so two sources overwrote each other's "last synced".
CREATE TABLE IF NOT EXISTS framework_source_metadata (
  package_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_origin TEXT NOT NULL DEFAULT 'local',
  last_sync_at INTEGER,
  last_version TEXT,
  last_git_hash TEXT,
  last_content_hash TEXT,
  sync_count INTEGER DEFAULT 0,
  PRIMARY KEY (package_id, source_path)
);

-- The source a package is actually INSTALLED from: set only by a local sync,
-- so a git clone can be stored and read, but never presents itself as the
-- project's live framework.
CREATE TABLE IF NOT EXISTS framework_live_source (
  package_id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

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
    this.backfillSourceKeying();
  }

  /**
   * A database written before per-source keying knows only "this package was
   * synced". Its rows are attributed to the source the latest snapshot names,
   * so the first sync after an upgrade compares against something real instead
   * of re-extracting everything as unknown (plan 2.13).
   */
  private backfillSourceKeying(): void {
    const already = this.db.prepare("SELECT COUNT(*) AS n FROM framework_source_metadata").get() as { n: number };
    if (already.n > 0) return;
    const rows = this.db.prepare(`
      SELECT m.package_id AS package_id, m.last_sync_at, m.last_version, m.last_git_hash, m.last_content_hash, m.sync_count,
             s.source_path AS source_path, s.source_origin AS source_origin
      FROM framework_metadata m
      JOIN framework_snapshots s ON s.package_id = m.package_id
      WHERE s.extracted_at = (SELECT MAX(extracted_at) FROM framework_snapshots WHERE package_id = m.package_id)
    `).all() as Array<{
      package_id: string; last_sync_at: number | null; last_version: string | null;
      last_git_hash: string | null; last_content_hash: string | null; sync_count: number | null;
      source_path: string; source_origin: string;
    }>;
    if (rows.length === 0) return;
    const insertMeta = this.db.prepare(`
      INSERT OR IGNORE INTO framework_source_metadata
        (package_id, source_path, source_origin, last_sync_at, last_version, last_git_hash, last_content_hash, sync_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLive = this.db.prepare(`
      INSERT OR IGNORE INTO framework_live_source (package_id, source_path, updated_at) VALUES (?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const row of rows) {
        insertMeta.run(
          row.package_id, row.source_path, row.source_origin, row.last_sync_at,
          row.last_version, row.last_git_hash, row.last_content_hash, row.sync_count ?? 0,
        );
        if (row.source_origin === "local") {
          insertLive.run(row.package_id, row.source_path, row.last_sync_at ?? Date.now());
        }
      }
    })();
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

    const upsertSourceMeta = this.prepare(`
      INSERT INTO framework_source_metadata
        (package_id, source_path, source_origin, last_sync_at, last_version, last_git_hash, last_content_hash, sync_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(package_id, source_path) DO UPDATE SET
        source_origin = excluded.source_origin,
        last_sync_at = excluded.last_sync_at,
        last_version = excluded.last_version,
        last_git_hash = excluded.last_git_hash,
        last_content_hash = excluded.last_content_hash,
        sync_count = sync_count + 1
    `);

    const setLive = this.prepare(`
      INSERT INTO framework_live_source (package_id, source_path, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(package_id) DO UPDATE SET
        source_path = excluded.source_path,
        updated_at = excluded.updated_at
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
      const fingerprint = computeSnapshotFingerprint(snapshot);
      upsertMeta.run(snapshot.packageId, now, snapshot.version, snapshot.gitHash, fingerprint);
      upsertSourceMeta.run(
        snapshot.packageId,
        snapshot.sourcePath,
        snapshot.sourceOrigin,
        now,
        snapshot.version,
        snapshot.gitHash,
        fingerprint,
      );
      // LIVE MEANS LOCAL. A clone or a cache is knowledge about the package,
      // never evidence that this project has it installed.
      if (snapshot.sourceOrigin === "local") {
        setLive.run(snapshot.packageId, snapshot.sourcePath, now);
      }
    })();
  }

  /**
   * The latest snapshot for a package.
   *
   * With no source named, the package's LIVE source answers when there is one
   * (the project's own installed tree); otherwise the newest snapshot from any
   * source does, carrying its real `sourceOrigin` so a reader can tell a
   * clone from an installation.
   */
  getLatestSnapshot(packageId: FrameworkPackageId, sourcePath?: string): FrameworkAPISnapshot | null {
    const path = sourcePath ?? this.getLiveSourcePath(packageId);
    return this.getSnapshotByOffset(packageId, 0, path);
  }

  /** Get the previous snapshot for drift comparison, from the same source. */
  getPreviousSnapshot(packageId: FrameworkPackageId, sourcePath?: string): FrameworkAPISnapshot | null {
    const path = sourcePath ?? this.getLiveSourcePath(packageId);
    return this.getSnapshotByOffset(packageId, 1, path);
  }

  /**
   * The snapshot of the package as INSTALLED here, or null when nothing local
   * has been synced — a git clone never answers this.
   */
  getLiveSnapshot(packageId: FrameworkPackageId): FrameworkAPISnapshot | null {
    const path = this.getLiveSourcePath(packageId);
    if (!path) return null;
    const snapshot = this.getSnapshotByOffset(packageId, 0, path);
    return snapshot && snapshot.sourceOrigin === "local" ? snapshot : null;
  }

  /** The source path a local sync last claimed for this package. */
  getLiveSourcePath(packageId: FrameworkPackageId): string | undefined {
    const row = this.prepare("SELECT source_path FROM framework_live_source WHERE package_id = ?")
      .get(packageId) as { source_path: string } | undefined;
    return row?.source_path;
  }

  private getSnapshotByOffset(packageId: FrameworkPackageId, offset: number, sourcePath?: string): FrameworkAPISnapshot | null {
    const stmt = this.prepare(
      sourcePath === undefined
        ? `SELECT * FROM framework_snapshots WHERE package_id = ? ORDER BY extracted_at DESC LIMIT 1 OFFSET ?`
        : `SELECT * FROM framework_snapshots WHERE package_id = ? AND source_path = ? ORDER BY extracted_at DESC LIMIT 1 OFFSET ?`,
    );
    const row = (sourcePath === undefined ? stmt.get(packageId, offset) : stmt.get(packageId, sourcePath, offset)) as {
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

  /** Sync bookkeeping for one (package, source) pair. */
  getSourceMetadata(packageId: FrameworkPackageId, sourcePath: string): FrameworkPackageMetadata | null {
    const row = this.prepare(
      "SELECT * FROM framework_source_metadata WHERE package_id = ? AND source_path = ?",
    ).get(packageId, sourcePath) as {
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
    sourcePath?: string,
  ): boolean {
    // Per SOURCE: one machine can hold a project's own tree and a clone of the
    // same package, and "last synced" for one said nothing about the other
    // (plan 2.13). Without a source named, the package-wide row answers, as
    // before.
    const meta = sourcePath === undefined ? this.getMetadata(packageId) : this.getSourceMetadata(packageId, sourcePath);
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

  /**
   * Drop every snapshot and the sync metadata of a package whose source is
   * gone. Metadata goes too: a package that comes back must be re-extracted
   * and stored, never skipped as "identical" to a fingerprint it no longer
   * has a snapshot for. Returns the number of snapshots removed.
   */
  deletePackage(packageId: FrameworkPackageId): number {
    const snapshots = this.prepare("DELETE FROM framework_snapshots WHERE package_id = ?");
    const metadata = this.prepare("DELETE FROM framework_metadata WHERE package_id = ?");
    let removed = 0;
    this.db.transaction(() => {
      removed = Number(snapshots.run(packageId).changes);
      metadata.run(packageId);
    })();
    return removed;
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
