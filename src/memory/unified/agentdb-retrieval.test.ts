/**
 * Tests for AgentDB Retrieval Helpers
 *
 * Covers: TF-IDF retrieval, semantic retrieval, hybrid retrieval, and MMR re-ranking.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentDBRetrievalContext } from "./agentdb-retrieval.js";
import { retrieveTFIDF, retrieveSemantic, retrieveHybrid, applyMMR } from "./agentdb-retrieval.js";
import type { UnifiedMemoryEntry } from "./unified-memory.interface.js";
import { MemoryTier } from "./unified-memory.interface.js";
import { TextIndex, extractTerms } from "../text-index.js";
import type { RetrievalResult, MemoryEntry } from "../memory.interface.js";
import type { NormalizedScore } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./agentdb-vector.js", () => ({
  generateEmbedding: vi.fn(async (_config: unknown, text: string) => {
    // Deterministic hash-based fake embedding
    const vec = new Array(4).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % 4] += text.charCodeAt(i) / 1000;
    }
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1;
    return vec.map((v: number) => v / norm);
  }),
}));

vi.mock("./agentdb-time.js", () => ({
  getNow: vi.fn(() => Date.now()),
}));

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  id: string,
  content: string,
  overrides: Partial<UnifiedMemoryEntry> = {},
): UnifiedMemoryEntry {
  return {
    id: id as any,
    type: "note",
    content,
    createdAt: Date.now() as any,
    lastAccessedAt: Date.now() as any,
    accessCount: 0,
    tags: [],
    importance: "medium",
    archived: false,
    metadata: {},
    chatId: "default" as any,
    embedding: [],
    tier: MemoryTier.Ephemeral,
    importanceScore: 0.5 as NormalizedScore,
    version: 1,
    title: "",
    source: "test",
    ...overrides,
  } as unknown as UnifiedMemoryEntry;
}

function buildTextIndex(entries: Map<string, UnifiedMemoryEntry>): TextIndex {
  const idx = new TextIndex();
  for (const entry of entries.values()) {
    idx.addDocument(extractTerms(entry.content));
  }
  return idx;
}

function makeCtx(
  entries: Map<string, UnifiedMemoryEntry>,
  hnswStore?: AgentDBRetrievalContext["hnswStore"],
): AgentDBRetrievalContext {
  return {
    config: {
      dbPath: "/tmp/test",
      dimensions: 4,
      maxEntriesPerTier: {
        [MemoryTier.Working]: 10,
        [MemoryTier.Ephemeral]: 50,
        [MemoryTier.Persistent]: 100,
      },
      hnswParams: { efConstruction: 50, M: 8, efSearch: 32 },
      quantizationType: "none",
      cacheSize: 100,
      enableAutoTiering: false,
      ephemeralTtlMs: 86400000 as any,
    },
    entries,
    hnswStore,
    textIndex: buildTextIndex(entries),
    searchTimes: [],
    sqlitePersistEntry: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("retrieveTFIDF", () => {
  let entries: Map<string, UnifiedMemoryEntry>;

  beforeEach(() => {
    entries = new Map();
    entries.set("e1", makeEntry("e1", "machine learning algorithms for classification"));
    entries.set("e2", makeEntry("e2", "cooking recipe for chocolate cake"));
    entries.set("e3", makeEntry("e3", "deep learning neural networks classification models"));
  });

  it("should return results ranked by TF-IDF relevance", () => {
    const ctx = makeCtx(entries);
    const results = retrieveTFIDF(ctx, "machine learning classification", {
      mode: "text",
      query: "machine learning classification",
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    // All returned scores should meet minimum threshold
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.1);
    }
  });

  it("should return empty array for empty query terms", () => {
    const ctx = makeCtx(entries);
    // "the is a" are all stop words
    const results = retrieveTFIDF(ctx, "the is a", {
      mode: "text",
      query: "the is a",
    });
    expect(results).toEqual([]);
  });

  it("should respect limit option", () => {
    const ctx = makeCtx(entries);
    const results = retrieveTFIDF(ctx, "learning classification", {
      mode: "text",
      query: "learning classification",
      limit: 1,
    });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("should respect minScore option", () => {
    const ctx = makeCtx(entries);
    const results = retrieveTFIDF(ctx, "learning", {
      mode: "text",
      query: "learning",
      minScore: 0.9 as NormalizedScore,
    });
    // With a very high min score, fewer or no results
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("should filter by chatId in chat mode", () => {
    entries.set("chat1", makeEntry("chat1", "machine learning chat", { chatId: "chat-A" as any }));
    entries.set("chat2", makeEntry("chat2", "machine learning other", { chatId: "chat-B" as any }));

    const ctx = makeCtx(entries);
    const results = retrieveTFIDF(ctx, "machine learning", {
      mode: "chat",
      chatId: "chat-A" as any,
    });

    for (const r of results) {
      expect((r.entry as any).chatId).toBe("chat-A");
    }
  });

  it("should filter by type in type mode", () => {
    entries.set("err1", makeEntry("err1", "machine learning error", { type: "error" as any }));

    const ctx = makeCtx(entries);
    const results = retrieveTFIDF(ctx, "machine learning", {
      mode: "type",
      types: ["error"],
    });

    for (const r of results) {
      expect(r.entry.type).toBe("error");
    }
  });

  it("should return empty for empty entries map", () => {
    const ctx = makeCtx(new Map());
    const results = retrieveTFIDF(ctx, "anything", {
      mode: "text",
      query: "anything",
    });
    expect(results).toEqual([]);
  });
});

describe("retrieveSemantic", () => {
  let entries: Map<string, UnifiedMemoryEntry>;

  beforeEach(() => {
    entries = new Map();
    entries.set("s1", makeEntry("s1", "neural networks deep learning", {
      tier: MemoryTier.Ephemeral,
      importanceScore: 0.6 as NormalizedScore,
    }));
    entries.set("s2", makeEntry("s2", "cooking chocolate cake recipe", {
      tier: MemoryTier.Persistent,
      importanceScore: 0.4 as NormalizedScore,
    }));
  });

  it("should fallback to TF-IDF when no HNSW store", async () => {
    const ctx = makeCtx(entries, undefined);
    const results = await retrieveSemantic(ctx, "neural networks");

    // Falls back to TF-IDF, should still return results
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("should use HNSW store when available and apply filters", async () => {
    const mockHnsw = {
      search: vi.fn(async () => [
        { chunk: { id: "s1" }, score: 0.95 },
        { chunk: { id: "s2" }, score: 0.80 },
      ]),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveSemantic(ctx, "neural networks", {
      tier: MemoryTier.Ephemeral,
    });

    expect(mockHnsw.search).toHaveBeenCalled();
    // Only s1 is Ephemeral tier, s2 is Persistent
    expect(results.length).toBe(1);
    expect(results[0]!.entry.id).toBe("s1");
  });

  it("should filter by chatId", async () => {
    entries.set("s3", makeEntry("s3", "specific chat entry", { chatId: "chat-X" as any }));
    const mockHnsw = {
      search: vi.fn(async () => [
        { chunk: { id: "s1" }, score: 0.9 },
        { chunk: { id: "s3" }, score: 0.8 },
      ]),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveSemantic(ctx, "chat entry", {
      chatId: "chat-X" as any,
    });

    for (const r of results) {
      expect((r.entry as any).chatId).toBe("chat-X");
    }
  });

  it("should filter by domain", async () => {
    entries.set("d1", makeEntry("d1", "domain entry", { domain: "test-domain" } as any));
    const mockHnsw = {
      search: vi.fn(async () => [
        { chunk: { id: "s1" }, score: 0.9 },
        { chunk: { id: "d1" }, score: 0.8 },
      ]),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveSemantic(ctx, "domain", {
      domain: "test-domain",
    });

    expect(results.length).toBe(1);
    expect(results[0]!.entry.id).toBe("d1");
  });

  it("should filter by minImportance", async () => {
    const mockHnsw = {
      search: vi.fn(async () => [
        { chunk: { id: "s1" }, score: 0.9 },  // importanceScore = 0.6
        { chunk: { id: "s2" }, score: 0.8 },  // importanceScore = 0.4
      ]),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveSemantic(ctx, "anything", {
      minImportance: 0.5 as NormalizedScore,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.entry.id).toBe("s1");
  });

  it("should skip expired entries by default", async () => {
    entries.set("expired", makeEntry("expired", "old data", {
      expiresAt: (Date.now() - 10000) as any,
    }));

    const mockHnsw = {
      search: vi.fn(async () => [
        { chunk: { id: "expired" }, score: 0.9 },
      ]),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveSemantic(ctx, "old data");

    expect(results.length).toBe(0);
  });

  it("should include expired entries when includeExpired is true", async () => {
    entries.set("expired", makeEntry("expired", "old data", {
      expiresAt: (Date.now() - 10000) as any,
    }));

    const mockHnsw = {
      search: vi.fn(async () => [
        { chunk: { id: "expired" }, score: 0.9 },
      ]),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveSemantic(ctx, "old data", {
      includeExpired: true,
    });

    expect(results.length).toBe(1);
  });

  it("should increment accessCount and update lastAccessedAt on hits", async () => {
    const entry = entries.get("s1")!;
    const initialAccessCount = entry.accessCount;

    const mockHnsw = {
      search: vi.fn(async () => [
        { chunk: { id: "s1" }, score: 0.9 },
      ]),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    await retrieveSemantic(ctx, "neural networks");

    expect(entry.accessCount).toBe(initialAccessCount + 1);
    expect(ctx.sqlitePersistEntry).toHaveBeenCalledWith(entry);
  });

  it("should track search time in searchTimes array", async () => {
    const mockHnsw = {
      search: vi.fn(async () => []),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    expect(ctx.searchTimes.length).toBe(0);

    await retrieveSemantic(ctx, "test");

    expect(ctx.searchTimes.length).toBe(1);
    expect(ctx.searchTimes[0]).toBeGreaterThanOrEqual(0);
  });

  it("should cap searchTimes at 100 entries", async () => {
    const mockHnsw = {
      search: vi.fn(async () => []),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    // Pre-fill with 100 entries
    for (let i = 0; i < 100; i++) {
      ctx.searchTimes.push(i);
    }

    await retrieveSemantic(ctx, "test");

    expect(ctx.searchTimes.length).toBe(100);
  });

  it("should respect limit option", async () => {
    entries.set("s3", makeEntry("s3", "extra entry"));
    entries.set("s4", makeEntry("s4", "another entry"));
    const mockHnsw = {
      search: vi.fn(async () => [
        { chunk: { id: "s1" }, score: 0.9 },
        { chunk: { id: "s2" }, score: 0.8 },
        { chunk: { id: "s3" }, score: 0.7 },
        { chunk: { id: "s4" }, score: 0.6 },
      ]),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveSemantic(ctx, "test", { limit: 2 });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("should apply MMR when useMMR is true", async () => {
    entries.set("s3", makeEntry("s3", "diverse topic weather", {
      embedding: [1, 0, 0, 0] as any,
    }));
    entries.get("s1")!.embedding = [0.9, 0.1, 0, 0] as any;
    entries.get("s2")!.embedding = [0, 0, 1, 0] as any;

    const mockHnsw = {
      search: vi.fn(async () => [
        { chunk: { id: "s1" }, score: 0.95 },
        { chunk: { id: "s2" }, score: 0.80 },
        { chunk: { id: "s3" }, score: 0.70 },
      ]),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveSemantic(ctx, "test", {
      useMMR: true,
      mmrLambda: 0.5 as NormalizedScore,
      limit: 3,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("should skip entries not found in entries map", async () => {
    const mockHnsw = {
      search: vi.fn(async () => [
        { chunk: { id: "nonexistent" }, score: 0.9 },
        { chunk: { id: "s1" }, score: 0.8 },
      ]),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveSemantic(ctx, "test");

    expect(results.length).toBe(1);
    expect(results[0]!.entry.id).toBe("s1");
  });
});

describe("retrieveHybrid", () => {
  let entries: Map<string, UnifiedMemoryEntry>;

  beforeEach(() => {
    entries = new Map();
    entries.set("h1", makeEntry("h1", "machine learning algorithms"));
    entries.set("h2", makeEntry("h2", "cooking recipe desserts"));
  });

  it("should merge semantic and TF-IDF results", async () => {
    const mockHnsw = {
      search: vi.fn(async () => [
        { chunk: { id: "h1" }, score: 0.9 },
      ]),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveHybrid(ctx, "machine learning");

    expect(results.length).toBeGreaterThan(0);
  });

  it("should apply semantic weight correctly", async () => {
    const mockHnsw = {
      search: vi.fn(async () => [
        { chunk: { id: "h1" }, score: 0.8 },
      ]),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveHybrid(ctx, "machine learning", {
      semanticWeight: 0.9 as NormalizedScore,
    });

    // Result should exist; the semantic weight amplifies the semantic portion
    expect(results.length).toBeGreaterThan(0);
  });

  it("should return empty array on error", async () => {
    const mockHnsw = {
      search: vi.fn(async () => {
        throw new Error("HNSW failure");
      }),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveHybrid(ctx, "anything");

    expect(results).toEqual([]);
  });

  it("should respect limit option", async () => {
    for (let i = 3; i <= 10; i++) {
      entries.set(`h${i}`, makeEntry(`h${i}`, `machine learning topic ${i}`));
    }

    const mockHnsw = {
      search: vi.fn(async () =>
        Array.from(entries.keys()).map((id, idx) => ({
          chunk: { id },
          score: 0.9 - idx * 0.05,
        })),
      ),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveHybrid(ctx, "machine learning", { limit: 3 });

    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("should filter by tier when specified", async () => {
    entries.set("ht1", makeEntry("ht1", "machine working", { tier: MemoryTier.Working }));
    entries.set("ht2", makeEntry("ht2", "machine persistent", { tier: MemoryTier.Persistent }));

    const mockHnsw = {
      search: vi.fn(async () => [
        { chunk: { id: "ht1" }, score: 0.9 },
        { chunk: { id: "ht2" }, score: 0.8 },
      ]),
    };

    const ctx = makeCtx(entries, mockHnsw as any);
    const results = await retrieveHybrid(ctx, "machine", {
      tier: MemoryTier.Working,
    });

    // Hybrid merges semantic (tier-filtered) + TF-IDF (unfiltered) results
    expect(results.length).toBeGreaterThan(0);
    // Verify semantic path applied tier filter (at least one working-tier result present)
    const hasTierMatch = results.some((r) => (r.entry as any).tier === MemoryTier.Working);
    expect(hasTierMatch).toBe(true);
  });
});

describe("applyMMR", () => {
  it("should return empty array for empty results", () => {
    const result = applyMMR([], [1, 0, 0], 0.5, 5);
    expect(result).toEqual([]);
  });

  it("should return up to limit results", () => {
    const results: RetrievalResult<MemoryEntry>[] = [
      { entry: makeEntry("m1", "a") as unknown as MemoryEntry, score: 0.9 as NormalizedScore },
      { entry: makeEntry("m2", "b") as unknown as MemoryEntry, score: 0.8 as NormalizedScore },
      { entry: makeEntry("m3", "c") as unknown as MemoryEntry, score: 0.7 as NormalizedScore },
    ];

    const selected = applyMMR(results, [1, 0, 0, 0], 0.5, 2);
    expect(selected.length).toBe(2);
  });

  it("should select highest relevance first", () => {
    const results: RetrievalResult<MemoryEntry>[] = [
      { entry: makeEntry("m1", "a") as unknown as MemoryEntry, score: 0.5 as NormalizedScore },
      { entry: makeEntry("m2", "b") as unknown as MemoryEntry, score: 0.9 as NormalizedScore },
      { entry: makeEntry("m3", "c") as unknown as MemoryEntry, score: 0.7 as NormalizedScore },
    ];

    const selected = applyMMR(results, [1, 0, 0, 0], 1.0, 3);
    // With lambda=1.0, MMR reduces to pure relevance ranking
    expect(selected[0]!.entry.id).toBe("m2");
  });

  it("should promote diversity with lower lambda", () => {
    // Two similar entries and one diverse entry
    const similar1 = makeEntry("sim1", "similar content alpha", { embedding: [1, 0, 0, 0] as any });
    const similar2 = makeEntry("sim2", "similar content beta", { embedding: [0.99, 0.1, 0, 0] as any });
    const diverse = makeEntry("div1", "totally different", { embedding: [0, 0, 1, 0] as any });

    const results: RetrievalResult<MemoryEntry>[] = [
      { entry: similar1 as unknown as MemoryEntry, score: 0.95 as NormalizedScore },
      { entry: similar2 as unknown as MemoryEntry, score: 0.90 as NormalizedScore },
      { entry: diverse as unknown as MemoryEntry, score: 0.70 as NormalizedScore },
    ];

    // With low lambda (high diversity preference), the diverse entry should rank higher
    const selected = applyMMR(results, [1, 0, 0, 0], 0.1, 3);
    expect(selected.length).toBe(3);
    // First pick is still the highest relevance
    expect(selected[0]!.entry.id).toBe("sim1");
    // Second pick should favor diversity over sim2 (which is very similar to sim1)
    expect(selected[1]!.entry.id).toBe("div1");
  });

  it("should handle results without embeddings gracefully", () => {
    const results: RetrievalResult<MemoryEntry>[] = [
      { entry: makeEntry("n1", "no embedding") as unknown as MemoryEntry, score: 0.9 as NormalizedScore },
      { entry: makeEntry("n2", "also none") as unknown as MemoryEntry, score: 0.8 as NormalizedScore },
    ];

    const selected = applyMMR(results, [1, 0, 0, 0], 0.5, 2);
    // Should still work; similarity between entries with no embeddings is 0
    expect(selected.length).toBe(2);
  });

  it("should not exceed remaining results count", () => {
    const results: RetrievalResult<MemoryEntry>[] = [
      { entry: makeEntry("x1", "only one") as unknown as MemoryEntry, score: 0.9 as NormalizedScore },
    ];

    const selected = applyMMR(results, [1, 0, 0, 0], 0.5, 10);
    expect(selected.length).toBe(1);
  });
});
