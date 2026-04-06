/**
 * Tests for AgentDB SQLite Persistence Helpers
 *
 * Covers: embedding serialization, SQLite init (with fallback), prepared statements,
 * entry persistence, bulk load/save, close, error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("./sqlite-pragmas.js", () => ({
  configureSqlitePragmas: vi.fn(),
  validateAndRepairSqlite: vi.fn(),
}));

// We mock better-sqlite3 for the initSqlite tests that need controlled behavior,
// but also test the real serialization helpers without the DB.

const mockPrepare = vi.fn();
const mockExec = vi.fn();
const mockClose = vi.fn();
const mockTransaction = vi.fn((fn: any) => {
  const wrapper = () => fn();
  return wrapper;
});

vi.mock("better-sqlite3", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      prepare: mockPrepare,
      exec: mockExec,
      close: mockClose,
      transaction: mockTransaction,
    })),
  };
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  embeddingToBuffer,
  bufferToEmbedding,
  initSqlite,
  closeSqlite,
  prepareSqliteStatements,
  persistEntry,
  persistDecayedEntries,
  removePersistedEntry,
  loadEntriesWithoutHnsw,
  saveAllEntries,
  upsertEntryRow,
  MEMORY_SCHEMA_SQL,
} from "./agentdb-sqlite.js";
import type { AgentDBSqliteContext } from "./agentdb-sqlite.js";
import type { UnifiedMemoryEntry } from "./unified-memory.interface.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type { NormalizedScore } from "../../types/index.js";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<AgentDBSqliteContext> = {}): AgentDBSqliteContext {
  return {
    dbPath: "/tmp/test-db",
    sqliteDb: null,
    sqliteInitFailed: false,
    sqliteStatements: new Map(),
    entries: new Map(),
    ...overrides,
  };
}

function makeEntry(id: string, overrides: Partial<Record<string, unknown>> = {}): UnifiedMemoryEntry {
  return {
    id: id as any,
    type: "note",
    content: `content for ${id}`,
    createdAt: Date.now() as any,
    lastAccessedAt: Date.now() as any,
    accessCount: 0,
    tags: ["test"],
    importance: "medium",
    archived: false,
    metadata: {},
    chatId: "default" as any,
    embedding: null,
    tier: MemoryTier.Ephemeral,
    importanceScore: 0.5 as NormalizedScore,
    version: 1,
    hnswIndex: 0,
    ...overrides,
  } as unknown as UnifiedMemoryEntry;
}

// ---------------------------------------------------------------------------
// Tests: Embedding Serialization
// ---------------------------------------------------------------------------

describe("embeddingToBuffer / bufferToEmbedding", () => {
  it("should round-trip a float32 vector through buffer serialization", () => {
    const original = [0.1, 0.2, 0.3, 0.4, 0.5];
    const buf = embeddingToBuffer(original);

    expect(buf).toBeInstanceOf(Buffer);
    // Float32 = 4 bytes per element
    expect(buf.byteLength).toBe(original.length * 4);

    const restored = bufferToEmbedding(buf);
    expect(restored).toHaveLength(original.length);

    // Float32 has limited precision, check approximate equality
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 5);
    }
  });

  it("should handle empty vectors", () => {
    const buf = embeddingToBuffer([]);
    expect(buf.byteLength).toBe(0);
    const restored = bufferToEmbedding(buf);
    expect(restored).toHaveLength(0);
  });

  it("should handle negative values", () => {
    const original = [-1.0, -0.5, 0, 0.5, 1.0];
    const buf = embeddingToBuffer(original);
    const restored = bufferToEmbedding(buf);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 5);
    }
  });

  it("should preserve high-dimensional vectors", () => {
    const dims = 1536;
    const original = Array.from({ length: dims }, (_, i) => Math.sin(i));
    const buf = embeddingToBuffer(original);
    const restored = bufferToEmbedding(buf);
    expect(restored).toHaveLength(dims);
    for (let i = 0; i < dims; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 4);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: initSqlite
// ---------------------------------------------------------------------------

describe("initSqlite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock: prepare returns a statement-like object
    mockPrepare.mockReturnValue({
      all: vi.fn(() => []),
      run: vi.fn(),
      get: vi.fn(),
    });
  });

  it("should set sqliteDb on context after successful init", () => {
    const ctx = makeContext();
    initSqlite(ctx);

    expect(ctx.sqliteDb).not.toBeNull();
    expect(ctx.sqliteInitFailed).toBe(false);
  });

  it("should execute the schema SQL", () => {
    const ctx = makeContext();
    initSqlite(ctx);

    expect(mockExec).toHaveBeenCalledWith(MEMORY_SCHEMA_SQL);
  });

  it("should prepare all expected statements", () => {
    const ctx = makeContext();
    initSqlite(ctx);

    const expectedStatements = [
      "upsertMemory",
      "getAllMemories",
      "deleteMemory",
      "upsertPattern",
      "getPatternsByKey",
      "getMigrationMarker",
      "setMigrationMarker",
    ];
    for (const name of expectedStatements) {
      expect(ctx.sqliteStatements.has(name)).toBe(true);
    }
  });

  it("should fall back to in-memory DB when file-based fails", () => {
    const MockedDb = vi.mocked(Database);
    // First call (file-based) throws, second call (in-memory) succeeds
    let callCount = 0;
    MockedDb.mockImplementation((() => {
      callCount++;
      if (callCount === 1) throw new Error("disk full");
      return {
        prepare: mockPrepare,
        exec: mockExec,
        close: mockClose,
        transaction: mockTransaction,
      };
    }) as any);

    const ctx = makeContext();
    initSqlite(ctx);

    expect(ctx.sqliteDb).not.toBeNull();
    expect(ctx.sqliteInitFailed).toBe(false);
  });

  it("should set sqliteInitFailed when both file and memory fail", () => {
    const MockedDb = vi.mocked(Database);
    MockedDb.mockImplementation((() => {
      throw new Error("catastrophic failure");
    }) as any);

    const ctx = makeContext();
    initSqlite(ctx);

    expect(ctx.sqliteDb).toBeNull();
    expect(ctx.sqliteInitFailed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: closeSqlite
// ---------------------------------------------------------------------------

describe("closeSqlite", () => {
  it("should close the database and clear statements", () => {
    const db = { close: vi.fn() } as any;
    const ctx = makeContext({ sqliteDb: db });
    ctx.sqliteStatements.set("test", {} as any);

    closeSqlite(ctx);

    expect(db.close).toHaveBeenCalledTimes(1);
    expect(ctx.sqliteDb).toBeNull();
    expect(ctx.sqliteStatements.size).toBe(0);
  });

  it("should handle close errors gracefully", () => {
    const db = {
      close: vi.fn(() => {
        throw new Error("close error");
      }),
    } as any;
    const ctx = makeContext({ sqliteDb: db });

    // Should not throw
    expect(() => closeSqlite(ctx)).not.toThrow();
    expect(ctx.sqliteDb).toBeNull();
  });

  it("should be safe to call when sqliteDb is null", () => {
    const ctx = makeContext({ sqliteDb: null });
    expect(() => closeSqlite(ctx)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: persistEntry
// ---------------------------------------------------------------------------

describe("persistEntry", () => {
  it("should do nothing when sqliteDb is null", () => {
    const ctx = makeContext({ sqliteDb: null });
    const entry = makeEntry("e1");
    // Should not throw
    expect(() => persistEntry(ctx, entry)).not.toThrow();
  });

  it("should do nothing when upsertMemory statement is missing", () => {
    const ctx = makeContext({ sqliteDb: {} as any });
    const entry = makeEntry("e1");
    expect(() => persistEntry(ctx, entry)).not.toThrow();
  });

  it("should call the upsertMemory statement with entry data", () => {
    const runFn = vi.fn();
    const stmt = { run: runFn } as any;
    const ctx = makeContext({ sqliteDb: {} as any });
    ctx.sqliteStatements.set("upsertMemory", stmt);

    const entry = makeEntry("e1");
    persistEntry(ctx, entry);

    expect(runFn).toHaveBeenCalledTimes(1);
    // First arg is the id
    expect(runFn.mock.calls[0]![0]).toBe("e1");
  });

  it("should serialize embedding to buffer when present", () => {
    const runFn = vi.fn();
    const stmt = { run: runFn } as any;
    const ctx = makeContext({ sqliteDb: {} as any });
    ctx.sqliteStatements.set("upsertMemory", stmt);

    const entry = makeEntry("e1", { embedding: [0.1, 0.2, 0.3] });
    persistEntry(ctx, entry);

    // The 5th argument (index 4) is the embedding buffer
    const embeddingArg = runFn.mock.calls[0]![4];
    expect(embeddingArg).toBeInstanceOf(Buffer);
  });

  it("should pass null for embedding when not present", () => {
    const runFn = vi.fn();
    const stmt = { run: runFn } as any;
    const ctx = makeContext({ sqliteDb: {} as any });
    ctx.sqliteStatements.set("upsertMemory", stmt);

    const entry = makeEntry("e1", { embedding: null });
    persistEntry(ctx, entry);

    const embeddingArg = runFn.mock.calls[0]![4];
    expect(embeddingArg).toBeNull();
  });

  it("should not throw when statement.run throws", () => {
    const stmt = { run: vi.fn(() => { throw new Error("SQL error"); }) } as any;
    const ctx = makeContext({ sqliteDb: {} as any });
    ctx.sqliteStatements.set("upsertMemory", stmt);

    const entry = makeEntry("e1");
    expect(() => persistEntry(ctx, entry)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: persistDecayedEntries
// ---------------------------------------------------------------------------

describe("persistDecayedEntries", () => {
  it("should do nothing when sqliteDb is null", () => {
    const ctx = makeContext({ sqliteDb: null });
    expect(() => persistDecayedEntries(ctx, ["e1"])).not.toThrow();
  });

  it("should only persist entries whose IDs are in the provided set", () => {
    const runFn = vi.fn();
    const stmt = { run: runFn } as any;
    const entries = new Map<string, UnifiedMemoryEntry>();
    entries.set("e1", makeEntry("e1"));
    entries.set("e2", makeEntry("e2"));
    entries.set("e3", makeEntry("e3"));

    const mockDb = {
      transaction: vi.fn((fn: any) => () => fn()),
    } as any;

    const ctx = makeContext({ sqliteDb: mockDb, entries });
    ctx.sqliteStatements.set("upsertMemory", stmt);

    persistDecayedEntries(ctx, ["e1", "e3"]);

    // Should have been called for e1 and e3 but not e2
    expect(runFn).toHaveBeenCalledTimes(2);
  });

  it("should not throw when transaction fails", () => {
    const stmt = { run: vi.fn() } as any;
    const mockDb = {
      transaction: vi.fn(() => () => { throw new Error("transaction error"); }),
    } as any;

    const ctx = makeContext({ sqliteDb: mockDb });
    ctx.sqliteStatements.set("upsertMemory", stmt);

    expect(() => persistDecayedEntries(ctx, ["e1"])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: removePersistedEntry
// ---------------------------------------------------------------------------

describe("removePersistedEntry", () => {
  it("should do nothing when sqliteDb is null", () => {
    const ctx = makeContext({ sqliteDb: null });
    expect(() => removePersistedEntry(ctx, "e1")).not.toThrow();
  });

  it("should call deleteMemory statement with the entry id", () => {
    const runFn = vi.fn();
    const stmt = { run: runFn } as any;
    const ctx = makeContext({ sqliteDb: {} as any });
    ctx.sqliteStatements.set("deleteMemory", stmt);

    removePersistedEntry(ctx, "e1");

    expect(runFn).toHaveBeenCalledWith("e1");
  });

  it("should not throw when deletion fails", () => {
    const stmt = { run: vi.fn(() => { throw new Error("delete error"); }) } as any;
    const ctx = makeContext({ sqliteDb: {} as any });
    ctx.sqliteStatements.set("deleteMemory", stmt);

    expect(() => removePersistedEntry(ctx, "e1")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: saveAllEntries
// ---------------------------------------------------------------------------

describe("saveAllEntries", () => {
  it("should do nothing when sqliteDb is null", () => {
    const ctx = makeContext({ sqliteDb: null });
    expect(() => saveAllEntries(ctx)).not.toThrow();
  });

  it("should persist all entries in a single transaction", () => {
    const runFn = vi.fn();
    const stmt = { run: runFn } as any;
    const entries = new Map<string, UnifiedMemoryEntry>();
    entries.set("e1", makeEntry("e1"));
    entries.set("e2", makeEntry("e2"));
    entries.set("e3", makeEntry("e3"));

    const transactionFn = vi.fn((fn: any) => {
      const wrapper = () => fn();
      return wrapper;
    });
    const mockDb = { transaction: transactionFn } as any;

    const ctx = makeContext({ sqliteDb: mockDb, entries });
    ctx.sqliteStatements.set("upsertMemory", stmt);

    saveAllEntries(ctx);

    expect(transactionFn).toHaveBeenCalledTimes(1);
    expect(runFn).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadEntriesWithoutHnsw
// ---------------------------------------------------------------------------

describe("loadEntriesWithoutHnsw", () => {
  it("should do nothing when sqliteDb is null", async () => {
    const ctx = makeContext({ sqliteDb: null });
    await loadEntriesWithoutHnsw(ctx);
    expect(ctx.entries.size).toBe(0);
  });

  it("should load rows from SQLite into entries map", async () => {
    const rows = [
      {
        id: "row1",
        key: "note",
        value: JSON.stringify({
          type: "note",
          content: "hello world",
          tags: ["tag1"],
          importance: "high",
          archived: false,
          tier: "ephemeral",
          accessCount: 5,
          lastAccessedAt: Date.now(),
          hnswIndex: 0,
          version: 1,
          importanceScore: 0.7,
          domain: undefined,
          chatId: "chat1",
        }),
        metadata: JSON.stringify({ source: "test" }),
        embedding: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ];

    const stmt = { all: vi.fn(() => rows) } as any;
    const ctx = makeContext({ sqliteDb: {} as any });
    ctx.sqliteStatements.set("getAllMemories", stmt);

    await loadEntriesWithoutHnsw(ctx);

    expect(ctx.entries.size).toBe(1);
    expect(ctx.entries.has("row1")).toBe(true);
    const entry = ctx.entries.get("row1")!;
    expect(entry.content).toBe("hello world");
  });

  it("should skip corrupted rows silently", async () => {
    const rows = [
      {
        id: "good",
        key: "note",
        value: JSON.stringify({ type: "note", content: "ok" }),
        metadata: "{}",
        embedding: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      {
        id: "bad",
        key: "note",
        value: "NOT VALID JSON{{{",
        metadata: "{}",
        embedding: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ];

    const stmt = { all: vi.fn(() => rows) } as any;
    const ctx = makeContext({ sqliteDb: {} as any });
    ctx.sqliteStatements.set("getAllMemories", stmt);

    await loadEntriesWithoutHnsw(ctx);

    // Only the good row should be loaded
    expect(ctx.entries.size).toBe(1);
    expect(ctx.entries.has("good")).toBe(true);
    expect(ctx.entries.has("bad")).toBe(false);
  });

  it("should deserialize embedding from buffer", async () => {
    const embedding = [0.1, 0.2, 0.3];
    const embBuf = Buffer.from(new Float32Array(embedding).buffer);
    const rows = [
      {
        id: "emb1",
        key: "note",
        value: JSON.stringify({ type: "note", content: "with embedding" }),
        metadata: "{}",
        embedding: embBuf,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ];

    const stmt = { all: vi.fn(() => rows) } as any;
    const ctx = makeContext({ sqliteDb: {} as any });
    ctx.sqliteStatements.set("getAllMemories", stmt);

    await loadEntriesWithoutHnsw(ctx);

    const entry = ctx.entries.get("emb1")!;
    expect(entry.embedding).not.toBeNull();
    expect((entry.embedding as number[]).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: upsertEntryRow
// ---------------------------------------------------------------------------

describe("upsertEntryRow", () => {
  it("should serialize entry fields into statement.run arguments", () => {
    const runFn = vi.fn();
    const stmt = { run: runFn } as any;
    const entry = makeEntry("u1", { content: "test content", type: "note" });

    upsertEntryRow(stmt, entry);

    expect(runFn).toHaveBeenCalledTimes(1);
    const args = runFn.mock.calls[0]!;
    // id
    expect(args[0]).toBe("u1");
    // key (type)
    expect(args[1]).toBe("note");
    // value (JSON string containing content)
    expect(JSON.parse(args[2] as string).content).toBe("test content");
    // metadata (JSON string)
    expect(typeof args[3]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Tests: MEMORY_SCHEMA_SQL
// ---------------------------------------------------------------------------

describe("MEMORY_SCHEMA_SQL", () => {
  it("should contain CREATE TABLE for memories", () => {
    expect(MEMORY_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS memories");
  });

  it("should contain CREATE TABLE for patterns", () => {
    expect(MEMORY_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS patterns");
  });

  it("should contain CREATE TABLE for migration_markers", () => {
    expect(MEMORY_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS migration_markers");
  });

  it("should contain indexes", () => {
    expect(MEMORY_SCHEMA_SQL).toContain("CREATE INDEX IF NOT EXISTS idx_memories_key");
    expect(MEMORY_SCHEMA_SQL).toContain("CREATE INDEX IF NOT EXISTS idx_patterns_key");
  });
});
