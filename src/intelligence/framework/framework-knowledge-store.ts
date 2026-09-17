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
  FrameworkProjectId,
  FrameworkSourceBinding,
  SourceLanguage,
  SourceOrigin,
} from "./framework-types.js";
import { FRAMEWORK_SCHEMA_VERSION, UNATTRIBUTED_PROJECT_ID } from "./framework-types.js";

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
  -- Identity is (package, SOURCE, time). Keyed by (package_id, extracted_at)
  -- alone, two sources whose extractions landed in the same millisecond
  -- silently replaced each other through INSERT OR REPLACE — a boot sync that
  -- reads one small package twice does exactly that — and the live pointer
  -- then resolved to a row that no longer existed (r9 finding 26).
  PRIMARY KEY (package_id, source_path, extracted_at)
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
--
-- LEGACY / PACKAGE-WIDE. One row per package cannot describe two projects, so
-- this pointer is only the best-effort answer for a reader with no project
-- identity (getLiveSnapshot / getLatestSnapshot with no source). Bound readers
-- use framework_project_source below. Last writer wins here, by construction.
CREATE TABLE IF NOT EXISTS framework_live_source (
  package_id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- WHERE A PROJECT GETS A PACKAGE FROM, AND WHETHER THAT IS AN INSTALLATION.
--
-- Origin used to live on the shared rows (every snapshot at a path, plus one
-- package-wide live pointer), and a reader bound only the path — so two
-- projects resolving the SAME physical directory with opposite installation
-- status overwrote each other: the project that explicitly installs the shared
-- framework-cache directory was told "not installed here" as soon as the
-- project that only falls back to it synced, and in the reverse order the
-- fallback project inherited "live" (r10 finding 11). The content is one
-- directory, so no fingerprint, version or git HEAD can carry the difference.
--
-- A real project has at most ONE row per package (it resolves one source path
-- at a time; recordProjectSource drops the others). The UNATTRIBUTED project
-- may hold several — one per source — because that is how a pre-upgrade
-- database's rows arrive.
CREATE TABLE IF NOT EXISTS framework_project_source (
  project_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_origin TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, package_id, source_path)
);

CREATE INDEX IF NOT EXISTS idx_project_source_by_source
  ON framework_project_source(package_id, source_path);

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
    this.migrateSnapshotPrimaryKey();
    this.backfillSourceKeying();
    this.backfillProjectSources();
  }

  /**
   * A database created before r9 finding 26 keys framework_snapshots by
   * (package_id, extracted_at), so SQLite itself would drop one of two sources
   * that share an extraction millisecond. SQLite cannot ALTER a primary key:
   * the table is rebuilt with the wider key and the existing rows copied over.
   * INSERT OR IGNORE, not OR REPLACE — a legacy row can never collide under
   * the WIDER key, so an ignore here is a no-op that documents the intent.
   */
  private migrateSnapshotPrimaryKey(): void {
    const cols = this.db.prepare("PRAGMA table_info(framework_snapshots)").all() as Array<{ name: string; pk: number }>;
    if (cols.length === 0) return;
    const keyed = cols.filter((c) => c.pk > 0).map((c) => c.name);
    if (keyed.includes("source_path")) return;
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE framework_snapshots_migrated (
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
          PRIMARY KEY (package_id, source_path, extracted_at)
        );
        INSERT OR IGNORE INTO framework_snapshots_migrated
          (package_id, package_name, version, git_hash, snapshot_json, extracted_at,
           source_path, source_origin, source_language, file_count, schema_version)
          SELECT package_id, package_name, version, git_hash, snapshot_json, extracted_at,
                 source_path, source_origin, source_language, file_count, schema_version
          FROM framework_snapshots;
        DROP TABLE framework_snapshots;
        ALTER TABLE framework_snapshots_migrated RENAME TO framework_snapshots;
      `);
      // The old table's indexes went with it; SCHEMA_SQL recreates them.
      this.db.exec(SCHEMA_SQL);
    })();
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

  /**
   * A database written before origin became project-relative records it on the
   * shared rows only: framework_source_metadata.source_origin per (package,
   * source), and one package-wide live pointer. Those rows belong to no
   * project, so they are attributed to UNATTRIBUTED_PROJECT_ID, which ANY
   * binding may claim: a bound reader that has no row of its own falls back to
   * the unattributed row (so an upgrade changes nothing about what a project
   * already saw), and the first sync that resolves that (package, source)
   * claims it — its own row is written and the unattributed one removed.
   *
   * Consequence for an upgrade: nothing is re-extracted and no project has to
   * re-sync to keep its labels. A project that never syncs again keeps reading
   * the inherited label; the first boot sync of each project replaces it with
   * that project's own observation.
   */
  private backfillProjectSources(): void {
    const already = this.db.prepare("SELECT COUNT(*) AS n FROM framework_project_source").get() as { n: number };
    if (already.n > 0) return;
    const rows = this.db.prepare(
      "SELECT package_id, source_path, source_origin FROM framework_source_metadata",
    ).all() as Array<{ package_id: string; source_path: string; source_origin: string }>;
    if (rows.length === 0) return;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO framework_project_source
        (project_id, package_id, source_path, source_origin, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    this.db.transaction(() => {
      for (const row of rows) {
        insert.run(UNATTRIBUTED_PROJECT_ID, row.package_id, row.source_path, row.source_origin, now);
      }
    })();
  }

  /**
   * Store a new snapshot.
   *
   * `projectId` is the project that OBSERVED this source. It records that
   * project's binding (source path + origin), which is what bound readers use
   * to decide "installed here"; omitted, only the shared rows are written, as
   * an ad-hoc writer with no project identity can say nothing about any
   * project's installation.
   */
  storeSnapshot(snapshot: FrameworkAPISnapshot, projectId?: FrameworkProjectId): void {
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
      if (projectId !== undefined) {
        this.recordProjectSource(projectId, snapshot.packageId, snapshot.sourcePath, snapshot.sourceOrigin, now);
      }
    })();
  }

  // ─── Per-project source bindings (r10 finding 11) ─────────────────────────

  /**
   * Record what ONE project resolved for a package: the source path and
   * whether that path is its installation. A project resolves one source per
   * package at a time, so any other row it held for the package is dropped —
   * a moved tree must not leave a second "installed here" claim behind.
   */
  private recordProjectSource(
    projectId: FrameworkProjectId,
    packageId: FrameworkPackageId,
    sourcePath: string,
    origin: SourceOrigin,
    now: number = Date.now(),
  ): void {
    this.prepare(`
      INSERT INTO framework_project_source (project_id, package_id, source_path, source_origin, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, package_id, source_path) DO UPDATE SET
        source_origin = excluded.source_origin,
        updated_at = excluded.updated_at
    `).run(projectId, packageId, sourcePath, origin, now);
    this.prepare(
      "DELETE FROM framework_project_source WHERE project_id = ? AND package_id = ? AND source_path != ?",
    ).run(projectId, packageId, sourcePath);
    // The legacy row for this (package, source) has now been attributed.
    if (projectId !== UNATTRIBUTED_PROJECT_ID) {
      this.prepare(
        "DELETE FROM framework_project_source WHERE project_id = ? AND package_id = ? AND source_path = ?",
      ).run(UNATTRIBUTED_PROJECT_ID, packageId, sourcePath);
    }
  }

  /**
   * What THIS project believes about a (package, source): the origin it
   * observed, or — when it has never recorded one — the unattributed row an
   * upgrade left for any binding to claim. Undefined when nothing is recorded.
   */
  getProjectSourceOrigin(
    projectId: FrameworkProjectId,
    packageId: FrameworkPackageId,
    sourcePath: string,
  ): SourceOrigin | undefined {
    const stmt = this.prepare(
      "SELECT source_origin FROM framework_project_source WHERE project_id = ? AND package_id = ? AND source_path = ?",
    );
    const own = stmt.get(projectId, packageId, sourcePath) as { source_origin: string } | undefined;
    if (own) return own.source_origin as SourceOrigin;
    if (projectId === UNATTRIBUTED_PROJECT_ID) return undefined;
    const inherited = stmt.get(UNATTRIBUTED_PROJECT_ID, packageId, sourcePath) as { source_origin: string } | undefined;
    return inherited ? (inherited.source_origin as SourceOrigin) : undefined;
  }

  /**
   * The source THIS project has the package INSTALLED from, or undefined when
   * it has none — the per-project answer the package-wide live pointer cannot
   * give. Derived from the project's own binding, so it can never disagree
   * with the origin a reader is shown.
   */
  getProjectLiveSourcePath(
    projectId: FrameworkProjectId,
    packageId: FrameworkPackageId,
  ): string | undefined {
    const stmt = this.prepare(`
      SELECT source_path FROM framework_project_source
      WHERE project_id = ? AND package_id = ? AND source_origin = 'local'
      ORDER BY updated_at DESC LIMIT 1
    `);
    const own = stmt.get(projectId, packageId) as { source_path: string } | undefined;
    if (own) return own.source_path;
    if (projectId === UNATTRIBUTED_PROJECT_ID) return undefined;
    const hasOwnOpinion = this.prepare(
      "SELECT 1 AS present FROM framework_project_source WHERE project_id = ? AND package_id = ? LIMIT 1",
    ).get(projectId, packageId) as { present: number } | undefined;
    if (hasOwnOpinion) return undefined;
    const inherited = stmt.get(UNATTRIBUTED_PROJECT_ID, packageId) as { source_path: string } | undefined;
    return inherited?.source_path;
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

  /**
   * The snapshot a reader in a PARTICULAR project must see, labelled with the
   * origin THAT project observed.
   *
   * The binding names the project and its resolved source for the package. When
   * the project has no source (resolve → null), a snapshot stored by a LOCAL
   * sync belongs to some other project's tree and must never answer here;
   * knowledge extracted from a clone or a cache still does, carrying its origin
   * so the reader can say "not installed here" (r9 finding 29).
   *
   * Snapshot CONTENT is shared — two projects reading one directory really do
   * get the same API — but `sourceOrigin` is not: it is re-labelled from this
   * project's own binding, because the stored column records whichever project
   * happened to write the row (r10 finding 11).
   */
  getProjectSnapshot(packageId: FrameworkPackageId, binding: FrameworkSourceBinding): FrameworkAPISnapshot | null {
    const sourcePath = binding.resolve(packageId);
    if (sourcePath !== null) {
      const snapshot = this.getSnapshotByOffset(packageId, 0, sourcePath);
      if (!snapshot) return null;
      // NO ROW, NO CLAIM (round 11 #13): the stored column records whichever
      // project wrote the snapshot, so falling back to it told an unsynced or
      // renamed project that another project's installation was its own.
      const origin = this.getProjectSourceOrigin(binding.projectId, packageId, sourcePath) ?? "unattributed";
      return origin === snapshot.sourceOrigin ? snapshot : { ...snapshot, sourceOrigin: origin };
    }
    const row = this.prepare(`
      SELECT * FROM framework_snapshots
      WHERE package_id = ? AND source_origin != 'local'
      ORDER BY extracted_at DESC LIMIT 1
    `).get(packageId) as {
      package_id: string;
      snapshot_json: string;
      source_path: string;
      source_origin: string;
      source_language: string;
      file_count: number;
      extracted_at: number;
    } | undefined;
    return row ? deserializeSnapshot(row.snapshot_json, row) : null;
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

  /**
   * Prune old snapshots, keeping the N most recent PER (package, source).
   *
   * Was: per package. One machine holds a project's installed tree and a
   * shallow clone of the same package, and the clone re-syncs on its own
   * cadence: five clone extractions evicted the installed source's only
   * snapshot, after which getLatestSnapshot and getLiveSnapshot both returned
   * null for a package that is still installed (r9 finding 27). Retention now
   * belongs to the source that produced the history.
   */
  pruneHistory(keepCount: number = 5): void {
    const sources = this.db.prepare(
      "SELECT DISTINCT package_id, source_path FROM framework_snapshots",
    ).all() as Array<{ package_id: string; source_path: string }>;

    const deleteOld = this.prepare(`
      DELETE FROM framework_snapshots
      WHERE package_id = ? AND source_path = ? AND extracted_at NOT IN (
        SELECT extracted_at FROM framework_snapshots
        WHERE package_id = ? AND source_path = ?
        ORDER BY extracted_at DESC
        LIMIT ?
      )
    `);

    this.db.transaction(() => {
      for (const { package_id, source_path } of sources) {
        deleteOld.run(package_id, source_path, package_id, source_path, keepCount);
      }
    })();
  }

  /**
   * Drop ONE source of a package: its snapshots, its per-source bookkeeping,
   * and its claim on the live pointer.
   *
   * Was deletePackage alone, which removed every source's snapshots when a
   * single tree disappeared and left framework_source_metadata and
   * framework_live_source pointing at it — so a fallback clone stored
   * afterwards was invisible: default reads followed the live pointer to a
   * source with no rows and returned null (r9 finding 28). Returns the number
   * of snapshots removed.
   */
  deleteSource(packageId: FrameworkPackageId, sourcePath: string): number {
    const snapshots = this.prepare("DELETE FROM framework_snapshots WHERE package_id = ? AND source_path = ?");
    const sourceMeta = this.prepare("DELETE FROM framework_source_metadata WHERE package_id = ? AND source_path = ?");
    const projectSources = this.prepare("DELETE FROM framework_project_source WHERE package_id = ? AND source_path = ?");
    let removed = 0;
    this.db.transaction(() => {
      removed = Number(snapshots.run(packageId, sourcePath).changes);
      sourceMeta.run(packageId, sourcePath);
      // The directory is gone: no project binds it any more, whatever each of
      // them believed about it.
      projectSources.run(packageId, sourcePath);
      this.rebindLiveSource(packageId, sourcePath);
      this.refreshPackageMetadata(packageId);
    })();
    return removed;
  }

  /**
   * Drop every source of a package. Kept for callers that mean "forget this
   * package entirely"; per-source bookkeeping and the live pointer go too, so
   * nothing survives to point at rows that no longer exist.
   */
  deletePackage(packageId: FrameworkPackageId): number {
    const snapshots = this.prepare("DELETE FROM framework_snapshots WHERE package_id = ?");
    const metadata = this.prepare("DELETE FROM framework_metadata WHERE package_id = ?");
    const sourceMeta = this.prepare("DELETE FROM framework_source_metadata WHERE package_id = ?");
    const live = this.prepare("DELETE FROM framework_live_source WHERE package_id = ?");
    const projectSources = this.prepare("DELETE FROM framework_project_source WHERE package_id = ?");
    let removed = 0;
    this.db.transaction(() => {
      removed = Number(snapshots.run(packageId).changes);
      metadata.run(packageId);
      sourceMeta.run(packageId);
      live.run(packageId);
      projectSources.run(packageId);
    })();
    return removed;
  }

  /**
   * Reconcile ONE PROJECT's binding for a package — where it gets the package
   * from, and whether that is its installation — with what the caller just
   * observed on disk, without consulting any API fingerprint.
   *
   * The sync pipeline skips extraction when version, git HEAD and content
   * fingerprint all match, and the origin of a source is none of those three:
   * a cached clone that became the project's installed tree stayed "cached and
   * not installed here" forever, and a legacy row wrongly stamped "local" (the
   * upgrade backfill trusts that stamp) went on claiming to be the live
   * installation (r9 finding 30).
   *
   * It writes the PROJECT's row, never the snapshot rows. Re-stamping every
   * snapshot at a path was the r10 finding 11 defect: two projects sharing one
   * physical directory with opposite installation status overwrote each other's
   * answer, and the content — one directory — could never reveal it. The
   * package-wide live pointer is still maintained for readers with no project
   * identity, and is explicitly last-writer-wins.
   *
   * Returns true when an EXISTING claim was corrected. Recording a binding for
   * the first time is not a correction — nothing was wrong, the store simply
   * did not know yet — but inheriting a wrong label from an unattributed
   * (pre-upgrade) row is.
   */
  reconcileSourceOrigin(
    projectId: FrameworkProjectId,
    packageId: FrameworkPackageId,
    sourcePath: string,
    origin: SourceOrigin,
  ): boolean {
    const setLive = this.prepare(`
      INSERT INTO framework_live_source (package_id, source_path, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(package_id) DO UPDATE SET
        source_path = excluded.source_path,
        updated_at = excluded.updated_at
    `);
    let changed = false;
    this.db.transaction(() => {
      // What this project claimed until now: its own row, or the unattributed
      // row it would have been reading.
      const previousOrigin = this.getProjectSourceOrigin(projectId, packageId, sourcePath);
      const previousPath = this.getProjectSourcePath(projectId, packageId);
      changed =
        (previousOrigin !== undefined && previousOrigin !== origin) ||
        (previousPath !== undefined && previousPath !== sourcePath);
      this.recordProjectSource(projectId, packageId, sourcePath, origin);

      const live = this.getLiveSourcePath(packageId);
      if (origin === "local") {
        // This source IS the installation. Only claim the package-wide pointer
        // once something of it is stored — storeSnapshot sets it for a first
        // sync.
        if (live !== sourcePath && this.hasSnapshots(packageId, sourcePath)) {
          setLive.run(packageId, sourcePath, Date.now());
        }
      } else if (live === sourcePath && !this.anyProjectInstalls(packageId, sourcePath)) {
        // A clone or a cache is knowledge about the package, never evidence
        // that THIS project has it installed — but another project may really
        // install this very directory, and its claim on the package-wide
        // pointer is not ours to release (r10 finding 11).
        this.rebindLiveSource(packageId, sourcePath);
      }
    })();
    return changed;
  }

  /** The one source path this project currently binds for a package. */
  private getProjectSourcePath(
    projectId: FrameworkProjectId,
    packageId: FrameworkPackageId,
  ): string | undefined {
    const row = this.prepare(
      "SELECT source_path FROM framework_project_source WHERE project_id = ? AND package_id = ? ORDER BY updated_at DESC LIMIT 1",
    ).get(projectId, packageId) as { source_path: string } | undefined;
    return row?.source_path;
  }

  /** Does any project have this package INSTALLED from this exact source? */
  private anyProjectInstalls(packageId: FrameworkPackageId, sourcePath: string): boolean {
    const row = this.prepare(`
      SELECT 1 AS present FROM framework_project_source
      WHERE package_id = ? AND source_path = ? AND source_origin = 'local' LIMIT 1
    `).get(packageId, sourcePath) as { present: number } | undefined;
    return row !== undefined;
  }

  private hasSnapshots(packageId: FrameworkPackageId, sourcePath: string): boolean {
    const row = this.prepare(
      "SELECT 1 AS present FROM framework_snapshots WHERE package_id = ? AND source_path = ? LIMIT 1",
    ).get(packageId, sourcePath) as { present: number } | undefined;
    return row !== undefined;
  }

  /**
   * Release a live pointer that names `sourcePath`, handing it to another
   * installed source of the same package when one is stored, and clearing it
   * otherwise. Only that one binding moves: another package's installation is
   * none of this call's business.
   */
  private rebindLiveSource(packageId: FrameworkPackageId, sourcePath: string): void {
    if (this.getLiveSourcePath(packageId) !== sourcePath) return;
    const replacement = this.prepare(`
      SELECT source_path, MAX(extracted_at) AS extracted_at
      FROM framework_snapshots
      WHERE package_id = ? AND source_origin = 'local' AND source_path != ?
    `).get(packageId, sourcePath) as { source_path: string | null; extracted_at: number | null } | undefined;
    if (replacement?.source_path) {
      this.prepare(`
        INSERT INTO framework_live_source (package_id, source_path, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(package_id) DO UPDATE SET
          source_path = excluded.source_path,
          updated_at = excluded.updated_at
      `).run(packageId, replacement.source_path, replacement.extracted_at ?? Date.now());
      return;
    }
    this.prepare("DELETE FROM framework_live_source WHERE package_id = ?").run(packageId);
  }

  /**
   * Keep the package-wide row describing a source that still exists (or drop
   * it when none does). A row left describing a deleted source is a
   * fingerprint `needsSync` would compare a live tree against.
   */
  private refreshPackageMetadata(packageId: FrameworkPackageId): void {
    const newest = this.prepare(`
      SELECT source_path FROM framework_snapshots
      WHERE package_id = ? ORDER BY extracted_at DESC LIMIT 1
    `).get(packageId) as { source_path: string } | undefined;
    if (!newest) {
      this.prepare("DELETE FROM framework_metadata WHERE package_id = ?").run(packageId);
      return;
    }
    this.prepare(`
      UPDATE framework_metadata SET
        last_sync_at = (SELECT last_sync_at FROM framework_source_metadata WHERE package_id = ? AND source_path = ?),
        last_version = (SELECT last_version FROM framework_source_metadata WHERE package_id = ? AND source_path = ?),
        last_git_hash = (SELECT last_git_hash FROM framework_source_metadata WHERE package_id = ? AND source_path = ?),
        last_content_hash = (SELECT last_content_hash FROM framework_source_metadata WHERE package_id = ? AND source_path = ?)
      WHERE package_id = ?
        AND EXISTS (SELECT 1 FROM framework_source_metadata WHERE package_id = ? AND source_path = ?)
    `).run(
      packageId, newest.source_path, packageId, newest.source_path,
      packageId, newest.source_path, packageId, newest.source_path,
      packageId, packageId, newest.source_path,
    );
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
