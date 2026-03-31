/**
 * AgentDB SQLite Persistence Helpers
 *
 * Extracted from AgentDBMemory — standalone functions that accept
 * an AgentDBSqliteContext for SQLite operations.
 */

import { join } from "node:path";
import Database from "better-sqlite3";
import { configureSqlitePragmas, validateAndRepairSqlite } from "./sqlite-pragmas.js";
import type { UnifiedMemoryEntry } from "./unified-memory.interface.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type {
  NormalizedScore,
  Vector,
} from "../../types/index.js";
import { createBrand } from "../../types/index.js";
import { getLogger } from "../../utils/logger.js";

function getLoggerSafe() {
  try { return getLogger(); } catch { return console; }
}

// ---------------------------------------------------------------------------
// SQLite Schema & Row Types
// ---------------------------------------------------------------------------

export const MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  key TEXT,
  value TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  embedding BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,
  pattern_key TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_markers (
  key TEXT PRIMARY KEY,
  completed_at INTEGER NOT NULL,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_key ON patterns(pattern_key);
CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON patterns(confidence DESC);
`;

export interface MemoryRow {
  id: string;
  key: string | null;
  value: string;
  metadata: string;
  embedding: Buffer | null;
  created_at: number;
  updated_at: number;
}

export interface PatternRow {
  id: string;
  pattern_key: string;
  data: string;
  confidence: number;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Context required by SQLite helpers
// ---------------------------------------------------------------------------

export interface AgentDBSqliteContext {
  readonly dbPath: string;
  sqliteDb: Database.Database | null;
  sqliteInitFailed: boolean;
  readonly sqliteStatements: Map<string, Database.Statement>;
  readonly entries: Map<string, UnifiedMemoryEntry>;
}

// ---------------------------------------------------------------------------
// Embedding serialization
// ---------------------------------------------------------------------------

/** Serialize an embedding vector to a Buffer for SQLite BLOB storage. */
export function embeddingToBuffer(embedding: number[] | Vector<number>): Buffer {
  const float32 = new Float32Array(embedding as number[]);
  return Buffer.from(float32.buffer);
}

/** Deserialize a Buffer from SQLite BLOB back to a number array. */
export function bufferToEmbedding(buf: Buffer): Vector<number> {
  const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(float32) as Vector<number>;
}

// ---------------------------------------------------------------------------
// Init / Close
// ---------------------------------------------------------------------------

/**
 * Migrate existing databases: deduplicate patterns by pattern_key and ensure the
 * UNIQUE constraint exists. Idempotent — safe to call on every startup.
 */
function migratePatternDedup(db: Database.Database): void {
  try {
    // Check if the unique index already exists
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='patterns' AND name='idx_patterns_key_unique'"
    ).all() as Array<{ name: string }>;
    if (indexes.length > 0) return; // Already migrated

    // Deduplicate: keep only the row with highest confidence per pattern_key
    db.prepare(`
      DELETE FROM patterns WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM patterns GROUP BY pattern_key
      )
    `).run();

    // Create unique index (enforces UNIQUE at DB level for existing tables)
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_patterns_key_unique ON patterns(pattern_key)").run();
  } catch (error) {
    getLoggerSafe().warn("[AgentDBMemory] Pattern dedup migration skipped", { error: String(error) });
  }
}

/**
 * Initialize the SQLite database, run schema creation, and prepare statements.
 * On failure, attempts an in-memory fallback.
 */
export function initSqlite(ctx: AgentDBSqliteContext): void {
  try {
    const sqlitePath = join(ctx.dbPath, "memory.db");
    ctx.sqliteDb = new Database(sqlitePath);

    // Validate and auto-repair on corruption
    validateAndRepairSqlite(ctx.sqliteDb, "memory");

    // Standardized pragma configuration (16MB cache, 5s busy_timeout)
    configureSqlitePragmas(ctx.sqliteDb, "memory");

    // Create schema using exec (safe - no user input, static SQL only)
    ctx.sqliteDb.exec(MEMORY_SCHEMA_SQL);

    // Migration: deduplicate patterns table and add UNIQUE index for existing databases
    migratePatternDedup(ctx.sqliteDb);

    prepareSqliteStatements(ctx);

    getLoggerSafe().info("[AgentDBMemory] SQLite persistence initialized", { path: sqlitePath });
  } catch (error) {
    getLoggerSafe().warn(
      "[AgentDBMemory] File-based SQLite failed, attempting in-memory fallback",
      { error: String(error) },
    );
    // Attempt in-memory fallback so UserProfileStore and persistence still work
    try {
      ctx.sqliteDb = new Database(":memory:");
      configureSqlitePragmas(ctx.sqliteDb, "memory");
      ctx.sqliteDb.exec(MEMORY_SCHEMA_SQL);
      migratePatternDedup(ctx.sqliteDb);
      prepareSqliteStatements(ctx);
      getLoggerSafe().warn("[AgentDBMemory] Running with in-memory SQLite fallback — data will not survive restarts");
    } catch (fallbackError) {
      getLoggerSafe().error(
        "[AgentDBMemory] In-memory SQLite fallback also failed",
        { error: String(fallbackError) },
      );
      ctx.sqliteDb = null;
      ctx.sqliteInitFailed = true;
    }
  }
}

/** Prepare commonly-used SQLite statements. Requires ctx.sqliteDb to be non-null. */
export function prepareSqliteStatements(ctx: AgentDBSqliteContext): void {
  ctx.sqliteStatements.set(
    "upsertMemory",
    ctx.sqliteDb!.prepare(`
        INSERT INTO memories (id, key, value, metadata, embedding, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          value = excluded.value,
          metadata = excluded.metadata,
          embedding = excluded.embedding,
          updated_at = excluded.updated_at
      `),
  );

  ctx.sqliteStatements.set(
    "getAllMemories",
    ctx.sqliteDb!.prepare("SELECT * FROM memories ORDER BY created_at DESC"),
  );

  ctx.sqliteStatements.set(
    "deleteMemory",
    ctx.sqliteDb!.prepare("DELETE FROM memories WHERE id = ?"),
  );

  ctx.sqliteStatements.set(
    "upsertPattern",
    ctx.sqliteDb!.prepare(`
        INSERT INTO patterns (id, pattern_key, data, confidence, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(pattern_key) DO UPDATE SET
          data = excluded.data,
          confidence = excluded.confidence
      `),
  );

  ctx.sqliteStatements.set(
    "getPatternsByKey",
    ctx.sqliteDb!.prepare(
      "SELECT * FROM patterns WHERE pattern_key = ? ORDER BY confidence DESC",
    ),
  );

  ctx.sqliteStatements.set(
    "getMigrationMarker",
    ctx.sqliteDb!.prepare("SELECT key FROM migration_markers WHERE key = ?"),
  );

  ctx.sqliteStatements.set(
    "setMigrationMarker",
    ctx.sqliteDb!.prepare(
      "INSERT OR REPLACE INTO migration_markers (key, completed_at, metadata) VALUES (?, ?, ?)",
    ),
  );
}

/** Close the SQLite database and clear prepared statements. */
export function closeSqlite(ctx: AgentDBSqliteContext): void {
  // Dereference all cached statements before closing — better-sqlite3
  // auto-finalizes them when the database closes.
  ctx.sqliteStatements.clear();
  if (ctx.sqliteDb) {
    try {
      ctx.sqliteDb.close();
    } catch (error) {
      getLoggerSafe().error("[AgentDBMemory] SQLite close error", { error: String(error) });
    }
    ctx.sqliteDb = null;
  }
}

// ---------------------------------------------------------------------------
// Entry persistence
// ---------------------------------------------------------------------------

/**
 * Serialize an entry and run the upsert prepared statement.
 * Shared by persistEntry and persistDecayedEntries to avoid duplication.
 */
export function upsertEntryRow(stmt: Database.Statement, entry: UnifiedMemoryEntry): void {
  const value = JSON.stringify({
    type: entry.type,
    content: entry.content,
    tags: entry.tags,
    importance: entry.importance,
    archived: entry.archived,
    tier: entry.tier,
    accessCount: entry.accessCount,
    lastAccessedAt: entry.lastAccessedAt,
    expiresAt: entry.expiresAt,
    hnswIndex: entry.hnswIndex,
    version: "version" in entry ? entry.version : 1,
    importanceScore: entry.importanceScore,
    domain: entry.domain,
    chatId: entry.chatId,
  });
  const metadata = JSON.stringify(entry.metadata ?? {});
  const embeddingBuf = entry.embedding ? embeddingToBuffer(entry.embedding) : null;

  stmt.run(
    entry.id as string,
    entry.type,
    value,
    metadata,
    embeddingBuf,
    entry.createdAt as number,
    Date.now(),
  );
}

/** Persist a single entry to SQLite. */
export function persistEntry(ctx: AgentDBSqliteContext, entry: UnifiedMemoryEntry): void {
  if (!ctx.sqliteDb) return;

  try {
    const stmt = ctx.sqliteStatements.get("upsertMemory");
    if (!stmt) return;
    upsertEntryRow(stmt, entry);
  } catch (error) {
    getLoggerSafe().error("[AgentDBMemory] Failed to persist entry", {
      id: entry.id as string,
      error: String(error),
    });
  }
}

/**
 * Batch-persist decayed entries to SQLite inside a single transaction.
 * Only writes entries whose IDs are in the provided set.
 */
export function persistDecayedEntries(ctx: AgentDBSqliteContext, entryIds: string[]): void {
  if (!ctx.sqliteDb) return;

  try {
    const stmt = ctx.sqliteStatements.get("upsertMemory");
    if (!stmt) return;
    const idSet = new Set(entryIds);

    ctx.sqliteDb.transaction(() => {
      for (const entry of ctx.entries.values()) {
        if (!idSet.has(entry.id as string)) continue;
        upsertEntryRow(stmt, entry);
      }
    })();
  } catch (error) {
    getLoggerSafe().error("[AgentDBMemory] Failed to persist decayed entries", {
      error: String(error),
    });
  }
}

/** Remove a single entry from SQLite. */
export function removePersistedEntry(ctx: AgentDBSqliteContext, id: string): void {
  if (!ctx.sqliteDb) return;

  try {
    const stmt = ctx.sqliteStatements.get("deleteMemory");
    stmt?.run(id);
  } catch (error) {
    getLoggerSafe().error("[AgentDBMemory] Failed to remove persisted entry", {
      id,
      error: String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Bulk load / save
// ---------------------------------------------------------------------------

/**
 * Load entries from SQLite into the provided entries map WITHOUT indexing into HNSW.
 * Used during rebuild to populate entries before re-embedding.
 */
export async function loadEntriesWithoutHnsw(ctx: AgentDBSqliteContext): Promise<void> {
  if (!ctx.sqliteDb) return;

  try {
    const stmt = ctx.sqliteStatements.get("getAllMemories");
    if (!stmt) return;

    const rows = stmt.all() as MemoryRow[];

    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as Record<string, unknown>;
        const embedding = row.embedding ? bufferToEmbedding(row.embedding as Buffer) : null;

        const baseEntry = {
          id: createBrand(row.id, "MemoryId" as const),
          type: parsed.type as string,
          content: parsed.content as string,
          createdAt: createBrand(row.created_at, "TimestampMs" as const),
          tags: (parsed.tags as string[]) ?? [],
          importance: (parsed.importance as string) ?? "medium",
          archived: (parsed.archived as boolean) ?? false,
          metadata: JSON.parse(row.metadata) as Record<string, unknown>,
          embedding,
          tier: (parsed.tier as MemoryTier) ?? MemoryTier.Ephemeral,
          accessCount: (parsed.accessCount as number) ?? 0,
          lastAccessedAt: createBrand(
            (parsed.lastAccessedAt as number) ?? row.created_at,
            "TimestampMs" as const,
          ),
          expiresAt: parsed.expiresAt
            ? createBrand(parsed.expiresAt as number, "TimestampMs" as const)
            : undefined,
          hnswIndex: (parsed.hnswIndex as number) ?? 0,
          version: (parsed.version as number) ?? 1,
          importanceScore:
            (parsed.importanceScore as NormalizedScore) ?? (0.5 as NormalizedScore),
          domain: parsed.domain as string | undefined,
          chatId: createBrand((parsed.chatId as string) ?? "default", "ChatId" as const),
        };

        const unifiedEntry = baseEntry as unknown as UnifiedMemoryEntry;
        ctx.entries.set(row.id, unifiedEntry);
      } catch {
        // Skip corrupted rows silently during rebuild
      }
    }
  } catch (error) {
    getLoggerSafe().error("[AgentDBMemory] Failed to load entries for rebuild", {
      error: String(error),
    });
  }
}

/** Save all in-memory entries to SQLite in a single transaction. */
export function saveAllEntries(ctx: AgentDBSqliteContext): void {
  if (!ctx.sqliteDb) return;

  try {
    const stmt = ctx.sqliteStatements.get("upsertMemory");
    if (!stmt) return;
    const db = ctx.sqliteDb;
    const saveAll = db.transaction(() => {
      for (const entry of ctx.entries.values()) {
        upsertEntryRow(stmt, entry);
      }
    });

    saveAll();

    getLoggerSafe().info("[AgentDBMemory] Saved all entries to SQLite", {
      count: ctx.entries.size,
    });
  } catch (error) {
    getLoggerSafe().error("[AgentDBMemory] Failed to save entries to SQLite", {
      error: String(error),
    });
  }
}
