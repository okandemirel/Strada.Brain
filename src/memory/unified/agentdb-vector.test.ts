/**
 * Tests for AgentDB HNSW / Vector Helpers
 *
 * Covers: toVectorEntry, generateEmbedding (hash fallback + provider),
 * isHashBasedEmbedding, detectAndHandleDimensionMismatch, reEmbedHashEntries.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("../../rag/hnsw/hnsw-vector-store.js", () => ({
  createHNSWVectorStore: vi.fn(async () => ({
    upsert: vi.fn(async () => {}),
    getHNSWStats: vi.fn(() => ({ config: { dimensions: 128 }, elementCount: 0 })),
  })),
}));

vi.mock("./agentdb-sqlite.js", () => ({
  loadEntriesWithoutHnsw: vi.fn(async () => {}),
  persistEntry: vi.fn(),
  upsertEntryRow: vi.fn(),
}));

vi.mock("node:fs", () => ({
  rmSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  toVectorEntry,
  generateEmbedding,
  isHashBasedEmbedding,
  detectAndHandleDimensionMismatch,
  reEmbedHashEntries,
} from "./agentdb-vector.js";
import type { AgentDBVectorContext } from "./agentdb-vector.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type { UnifiedMemoryEntry, UnifiedMemoryConfig } from "./unified-memory.interface.js";
import type { NormalizedScore } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, overrides: Partial<Record<string, unknown>> = {}): UnifiedMemoryEntry {
  return {
    id: id as any,
    type: "note",
    content: `content for ${id}`,
    createdAt: Date.now() as any,
    lastAccessedAt: Date.now() as any,
    accessCount: 0,
    tags: [],
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

function makeConfig(overrides: Partial<UnifiedMemoryConfig> = {}): UnifiedMemoryConfig {
  return {
    dbPath: "/tmp/test",
    dimensions: 128,
    maxEntriesPerTier: {
      [MemoryTier.Working]: 100,
      [MemoryTier.Ephemeral]: 500,
      [MemoryTier.Persistent]: 1000,
    },
    hnswParams: { efConstruction: 50, M: 8, efSearch: 32 },
    quantizationType: "none",
    cacheSize: 100,
    enableAutoTiering: true,
    ...overrides,
  } as unknown as UnifiedMemoryConfig;
}

function makeVectorCtx(overrides: Partial<AgentDBVectorContext> = {}): AgentDBVectorContext {
  return {
    dbPath: "/tmp/test",
    sqliteDb: null,
    sqliteInitFailed: false,
    sqliteStatements: new Map(),
    entries: new Map(),
    config: makeConfig(),
    hnswStore: undefined,
    writeMutex: { withLock: async (fn: any) => fn() } as any,
    rebuildInProgress: false,
    tieringTimer: null,
    tieringParams: null,
    startAutoTiering: vi.fn(),
    stopAutoTiering: vi.fn(),
    ...overrides,
  } as unknown as AgentDBVectorContext;
}

// ---------------------------------------------------------------------------
// Tests: toVectorEntry
// ---------------------------------------------------------------------------

describe("toVectorEntry", () => {
  it("should convert a memory entry to VectorEntry format", () => {
    const result = toVectorEntry({
      id: "v1",
      content: "test content",
      chatId: "chat1",
      embedding: [0.1, 0.2, 0.3],
      createdAt: 1000,
      accessCount: 5,
    });

    expect(result.id).toBe("v1");
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.chunk.content).toBe("test content");
    expect(result.chunk.filePath).toBe("chat1");
    expect(result.accessCount).toBe(5);
  });

  it("should use 'memory' as filePath when chatId is not provided", () => {
    const result = toVectorEntry({
      id: "v2",
      content: "test",
      embedding: [0.1],
      createdAt: 1000,
      accessCount: 0,
    });

    expect(result.chunk.filePath).toBe("memory");
  });

  it("should set chunk kind to 'class' and language to 'typescript'", () => {
    const result = toVectorEntry({
      id: "v3",
      content: "test",
      embedding: [0.1],
      createdAt: 1000,
      accessCount: 0,
    });

    expect(result.chunk.kind).toBe("class");
    expect(result.chunk.language).toBe("typescript");
  });
});

// ---------------------------------------------------------------------------
// Tests: generateEmbedding
// ---------------------------------------------------------------------------

describe("generateEmbedding", () => {
  it("should use hash-based fallback when no provider is configured", async () => {
    const config = makeConfig({ dimensions: 8 });
    const embedding = await generateEmbedding(config, "hello world");

    expect(embedding).toHaveLength(8);
    // Hash-based embeddings are normalized, so magnitude should be close to 1
    const magnitude = Math.sqrt(embedding.reduce((a, b) => a + b * b, 0));
    expect(magnitude).toBeCloseTo(1.0, 2);
  });

  it("should use embedding provider when available", async () => {
    const mockProvider = vi.fn(async () => [0.1, 0.2, 0.3, 0.4]);
    const config = makeConfig({ dimensions: 4, embeddingProvider: mockProvider } as any);

    const embedding = await generateEmbedding(config, "hello");

    expect(mockProvider).toHaveBeenCalledWith("hello");
    expect(embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("should fall back to hash when provider fails", async () => {
    const mockProvider = vi.fn(async () => {
      throw new Error("API error");
    });
    const config = makeConfig({ dimensions: 4, embeddingProvider: mockProvider } as any);

    const embedding = await generateEmbedding(config, "hello");

    expect(embedding).toHaveLength(4);
    // Should still produce a valid embedding via hash fallback
    expect(embedding.every((v) => typeof v === "number")).toBe(true);
  });

  it("should produce all-positive components from hash fallback", async () => {
    const config = makeConfig({ dimensions: 16 });
    const embedding = await generateEmbedding(config, "test string with some length");

    // Hash-based embeddings accumulate charCode/255, so all positive
    expect(embedding.every((v) => v >= 0)).toBe(true);
  });

  it("should produce different embeddings for different texts", async () => {
    const config = makeConfig({ dimensions: 16 });
    const e1 = await generateEmbedding(config, "hello");
    const e2 = await generateEmbedding(config, "world");

    const same = e1.every((v, i) => v === e2[i]);
    expect(same).toBe(false);
  });

  it("should handle empty text", async () => {
    const config = makeConfig({ dimensions: 4 });
    const embedding = await generateEmbedding(config, "");

    expect(embedding).toHaveLength(4);
    // Empty text produces zero vector, magnitude is 0
    expect(embedding.every((v) => v === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: isHashBasedEmbedding
// ---------------------------------------------------------------------------

describe("isHashBasedEmbedding", () => {
  it("should return true for all-positive low-variance embeddings", () => {
    // Simulate a hash-based embedding (all positive, low variance)
    const embedding = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
    expect(isHashBasedEmbedding("test", embedding)).toBe(true);
  });

  it("should return false for embeddings with negative components", () => {
    // Real neural embeddings have negative components
    const embedding = [0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8];
    expect(isHashBasedEmbedding("test", embedding)).toBe(false);
  });

  it("should return false for all-positive high-variance embeddings", () => {
    // All positive but high variance suggests real embedding
    const embedding = [0.01, 0.5, 0.02, 0.8, 0.01, 0.9, 0.03, 0.7];
    expect(isHashBasedEmbedding("test", embedding)).toBe(false);
  });

  it("should return false for empty embeddings", () => {
    expect(isHashBasedEmbedding("test", [])).toBe(false);
  });

  it("should return false for null/undefined embeddings", () => {
    expect(isHashBasedEmbedding("test", null as any)).toBe(false);
    expect(isHashBasedEmbedding("test", undefined as any)).toBe(false);
  });

  it("should detect hash-based embeddings from generateEmbedding", async () => {
    const config = makeConfig({ dimensions: 64 });
    const text = "this is a test sentence for hash detection";
    const embedding = await generateEmbedding(config, text);

    expect(isHashBasedEmbedding(text, embedding as number[])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: detectAndHandleDimensionMismatch
// ---------------------------------------------------------------------------

describe("detectAndHandleDimensionMismatch", () => {
  it("should do nothing when hnswStore is not present", async () => {
    const ctx = makeVectorCtx({ hnswStore: undefined });
    await detectAndHandleDimensionMismatch(ctx);
    // No error
  });

  it("should do nothing when dimensions match", async () => {
    const ctx = makeVectorCtx({
      hnswStore: {
        getHNSWStats: vi.fn(() => ({
          config: { dimensions: 128 },
          elementCount: 10,
        })),
      } as any,
      config: makeConfig({ dimensions: 128 }),
    });

    await detectAndHandleDimensionMismatch(ctx);
    // Should not trigger rebuild
    expect(ctx.rebuildInProgress).toBe(false);
  });

  it("should do nothing when index is empty", async () => {
    const ctx = makeVectorCtx({
      hnswStore: {
        getHNSWStats: vi.fn(() => ({
          config: { dimensions: 256 },
          elementCount: 0,
        })),
      } as any,
      config: makeConfig({ dimensions: 128 }),
    });

    await detectAndHandleDimensionMismatch(ctx);
    expect(ctx.rebuildInProgress).toBe(false);
  });

  it("should skip rebuild when no embedding provider is available", async () => {
    const ctx = makeVectorCtx({
      hnswStore: {
        getHNSWStats: vi.fn(() => ({
          config: { dimensions: 256 },
          elementCount: 10,
        })),
      } as any,
      config: makeConfig({ dimensions: 128 }),
    });

    await detectAndHandleDimensionMismatch(ctx);
    // Should not have started rebuild without provider
    expect(ctx.rebuildInProgress).toBe(false);
  });

  it("should handle missing getHNSWStats method gracefully", async () => {
    const ctx = makeVectorCtx({
      hnswStore: {} as any, // no getHNSWStats method
    });

    await detectAndHandleDimensionMismatch(ctx);
    // No error
  });

  it("should handle errors gracefully", async () => {
    const ctx = makeVectorCtx({
      hnswStore: {
        getHNSWStats: vi.fn(() => {
          throw new Error("stats error");
        }),
      } as any,
    });

    // Should not throw
    await detectAndHandleDimensionMismatch(ctx);
  });
});

// ---------------------------------------------------------------------------
// Tests: reEmbedHashEntries
// ---------------------------------------------------------------------------

describe("reEmbedHashEntries", () => {
  it("should return early if migration marker already exists", async () => {
    const ctx = makeVectorCtx();
    const result = await reEmbedHashEntries(
      ctx,
      async () => true, // marker exists
      async () => {},
    );

    expect(result).toEqual({ migrated: 0, total: 0, skipped: 0 });
  });

  it("should return early if no embedding provider is configured", async () => {
    const ctx = makeVectorCtx({
      config: makeConfig(), // no embeddingProvider
    });

    const result = await reEmbedHashEntries(
      ctx,
      async () => false,
      async () => {},
    );

    expect(result).toEqual({ migrated: 0, total: 0, skipped: 0 });
  });

  it("should return early if sqliteDb is not available", async () => {
    const ctx = makeVectorCtx({
      sqliteDb: null,
      config: makeConfig({ embeddingProvider: vi.fn() } as any),
    });

    const result = await reEmbedHashEntries(
      ctx,
      async () => false,
      async () => {},
    );

    expect(result).toEqual({ migrated: 0, total: 0, skipped: 0 });
  });

  it("should skip entries that are not hash-based", async () => {
    const mockProvider = vi.fn(async () => [0.1, -0.2, 0.3]);
    const entries = new Map<string, UnifiedMemoryEntry>();
    // Real embedding (has negative values = not hash-based)
    entries.set("real1", makeEntry("real1", {
      embedding: [0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8],
    }));

    const mockStmt = { run: vi.fn() };
    const stmts = new Map<string, any>();
    stmts.set("upsertMemory", mockStmt);

    const ctx = makeVectorCtx({
      entries,
      config: makeConfig({ embeddingProvider: mockProvider } as any),
      sqliteDb: { transaction: vi.fn((fn: any) => () => fn()) } as any,
      sqliteStatements: stmts,
    });

    const setMarker = vi.fn(async () => {});
    const result = await reEmbedHashEntries(
      ctx,
      async () => false,
      setMarker,
    );

    expect(result.skipped).toBe(1);
    expect(result.migrated).toBe(0);
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it("should set migration marker when all entries are processed without persist failures", async () => {
    const entries = new Map<string, UnifiedMemoryEntry>();
    // No entries with embeddings
    entries.set("e1", makeEntry("e1", { embedding: [] }));

    const ctx = makeVectorCtx({
      entries,
      config: makeConfig({ embeddingProvider: vi.fn() } as any),
      sqliteDb: {} as any,
    });

    const setMarker = vi.fn(async () => {});
    await reEmbedHashEntries(
      ctx,
      async () => false,
      setMarker,
    );

    expect(setMarker).toHaveBeenCalledWith(
      "re_embed_complete_v1",
      expect.any(Object),
    );
  });
});
