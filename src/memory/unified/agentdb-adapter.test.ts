import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentDBMemory } from "./agentdb-memory.js";
import type { MemoryEntry, ConversationMemoryEntry, RetrievalResult } from "../memory.interface.js";
import type { UnifiedMemoryStats, HnswHealth } from "./unified-memory.interface.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type { MemoryId, ChatId, NormalizedScore, DurationMs, TimestampMs } from "../../types/index.js";
import type { StradaProjectAnalysis } from "../../intelligence/strada-analyzer.js";

// Mock the logger to suppress output during tests
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// We'll dynamically import after setting up mocks
let AgentDBAdapter: typeof import("./agentdb-adapter.js").AgentDBAdapter;

beforeEach(async () => {
  const mod = await import("./agentdb-adapter.js");
  AgentDBAdapter = mod.AgentDBAdapter;
});

function createMockAgentDB(): {
  [K in keyof AgentDBMemory]: AgentDBMemory[K] extends (...args: infer _A) => infer _R
    ? ReturnType<typeof vi.fn>
    : AgentDBMemory[K];
} {
  return {
    cachedAnalysis: null,
    initialize: vi.fn(),
    shutdown: vi.fn(),
    retrieve: vi.fn(),
    retrieveSemantic: vi.fn(),
    retrieveByEmbedding: vi.fn(),
    retrieveHybrid: vi.fn(),
    getCachedAnalysis: vi.fn(),
    cacheAnalysis: vi.fn(),
    storeConversation: vi.fn(),
    storeNote: vi.fn(),
    storeEntry: vi.fn(),
    storeEntries: vi.fn(),
    getChatHistory: vi.fn(),
    getByTier: vi.fn(),
    getById: vi.fn(),
    promoteEntry: vi.fn(),
    demoteEntry: vi.fn(),
    updateImportance: vi.fn(),
    touch: vi.fn(),
    cleanupExpired: vi.fn(),
    compact: vi.fn(),
    delete: vi.fn(),
    getStats: vi.fn(),
    getMigrationStatus: vi.fn(),
    rebuildIndex: vi.fn(),
    getIndexHealth: vi.fn(),
    optimizeIndex: vi.fn(),
    persistEntry: vi.fn(),
  } as unknown as ReturnType<typeof createMockAgentDB>;
}

function mockStats(): UnifiedMemoryStats {
  return {
    totalEntries: 50,
    entriesByType: {
      conversation: 20,
      analysis: 5,
      note: 10,
      command: 5,
      error: 5,
      insight: 3,
      task: 2,
    },
    entriesByImportance: {
      low: 10,
      medium: 20,
      high: 15,
      critical: 5,
    },
    conversationCount: 20,
    noteCount: 10,
    errorCount: 5,
    archivedCount: 2,
    hasAnalysisCache: true,
    storageSizeBytes: 1024000,
    averageQueryTimeMs: 5,
    entriesByTier: {
      [MemoryTier.Working]: 10,
      [MemoryTier.Ephemeral]: 30,
      [MemoryTier.Persistent]: 10,
    },
    hnswStats: {
      indexedVectors: 50,
      dimensions: 1536,
      efConstruction: 200,
      M: 16,
      efSearch: 128,
      maxElements: 11100,
      currentCount: 50,
      memoryUsedBytes: 512000,
    },
    quantizationStats: {
      type: "scalar",
      originalSizeBytes: 1024000,
      compressedSizeBytes: 512000,
      compressionRatio: 0.5,
      bitsPerDimension: 8,
    },
    performance: {
      avgSearchTimeMs: 5,
      lastSearchTimeMs: 3,
      totalSearches: 100,
      cacheHitRate: 0.8 as NormalizedScore,
      indexBuildTimeMs: 200,
      memoryUsageBytes: 512000,
    },
    cacheStats: {
      hits: 80,
      misses: 20,
      evictions: 5,
      currentSize: 50,
      maxSize: 1000,
      hitRate: 0.8 as NormalizedScore,
    },
    tierStats: {
      [MemoryTier.Working]: {
        tier: MemoryTier.Working,
        entryCount: 10,
        maxEntries: 100,
        averageImportance: 0.7 as NormalizedScore,
      },
      [MemoryTier.Ephemeral]: {
        tier: MemoryTier.Ephemeral,
        entryCount: 30,
        maxEntries: 1000,
        averageImportance: 0.5 as NormalizedScore,
      },
      [MemoryTier.Persistent]: {
        tier: MemoryTier.Persistent,
        entryCount: 10,
        maxEntries: 10000,
        averageImportance: 0.9 as NormalizedScore,
      },
    },
  };
}

describe("AgentDBAdapter", () => {
  let mockDb: ReturnType<typeof createMockAgentDB>;
  let adapter: InstanceType<typeof AgentDBAdapter>;

  beforeEach(() => {
    mockDb = createMockAgentDB();
    adapter = new AgentDBAdapter(mockDb as unknown as AgentDBMemory);
  });

  // =========================================================================
  // Core method: initialize
  // =========================================================================

  describe("initialize()", () => {
    it("delegates to agentdb.initialize() and returns its Result", async () => {
      (mockDb.initialize as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ok", value: undefined });
      const result = await adapter.initialize();
      expect(result).toEqual({ kind: "ok", value: undefined });
      expect(mockDb.initialize).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // Core method: shutdown
  // =========================================================================

  describe("shutdown()", () => {
    it("delegates to agentdb.shutdown() and returns its Result", async () => {
      (mockDb.shutdown as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ok", value: undefined });
      const result = await adapter.shutdown();
      expect(result).toEqual({ kind: "ok", value: undefined });
      expect(mockDb.shutdown).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // Core method: retrieve
  // =========================================================================

  describe("retrieve()", () => {
    // -----------------------------------------------------------------------
    // Semantic routing tests (text queries go through HNSW vector search)
    // -----------------------------------------------------------------------

    it("routes text-mode query to agentdb.retrieveSemantic() instead of agentdb.retrieve()", async () => {
      const mockResults: RetrievalResult[] = [
        {
          entry: { id: "mem_1" as MemoryId, type: "conversation", content: "hello" } as unknown as MemoryEntry,
          score: 0.95 as NormalizedScore,
        },
      ];
      (mockDb.retrieveSemantic as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

      const options = { mode: "text" as const, query: "hello", limit: 5, minScore: 0.1 as NormalizedScore };
      const result = await adapter.retrieve(options);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].entry).toEqual(expect.objectContaining({
          id: "mem_1",
          type: "conversation",
          content: "hello",
          userMessage: "hello",
        }));
      }
      expect(mockDb.retrieveSemantic).toHaveBeenCalledWith("hello", { limit: 10, embedding: undefined });
      expect(mockDb.retrieve).not.toHaveBeenCalled();
    });

    it("routes semantic-mode query to agentdb.retrieveSemantic()", async () => {
      const mockResults: RetrievalResult[] = [
        {
          entry: { id: "mem_2" as MemoryId, type: "note", content: "relevant" } as unknown as MemoryEntry,
          score: 0.88 as NormalizedScore,
        },
      ];
      (mockDb.retrieveSemantic as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

      const options = { mode: "semantic" as const, query: "relevant topic", limit: 10 };
      const result = await adapter.retrieve(options);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value[0].entry).toEqual(expect.objectContaining({
          id: "mem_2",
          type: "note",
          content: "relevant",
          source: "user",
        }));
      }
      expect(mockDb.retrieveSemantic).toHaveBeenCalledWith("relevant topic", { limit: 20, embedding: undefined });
      expect(mockDb.retrieve).not.toHaveBeenCalled();
    });

    it("routes hybrid-mode query to agentdb.retrieveHybrid()", async () => {
      const mockResults: RetrievalResult[] = [
        {
          entry: { id: "mem_hybrid" as MemoryId, type: "note", content: "hybrid result" } as unknown as MemoryEntry,
          score: 0.82 as NormalizedScore,
        },
      ];
      (mockDb.retrieveHybrid as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

      const options = {
        mode: "hybrid" as const,
        query: "hybrid query",
        limit: 4,
        semanticWeight: 0.6 as NormalizedScore,
      };
      const result = await adapter.retrieve(options);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value[0].entry).toEqual(expect.objectContaining({
          id: "mem_hybrid",
          type: "note",
          content: "hybrid result",
          source: "user",
        }));
      }
      expect(mockDb.retrieveHybrid).toHaveBeenCalledWith("hybrid query", {
        limit: 8,
        semanticWeight: 0.6,
      });
      expect(mockDb.retrieveSemantic).not.toHaveBeenCalled();
    });

    it("falls back to agentdb.retrieve() when query is empty", async () => {
      (mockDb.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const options = { mode: "text" as const, query: "" };
      const result = await adapter.retrieve(options);

      expect(result).toEqual({ kind: "ok", value: [] });
      expect(mockDb.retrieve).toHaveBeenCalledWith("", options);
      expect(mockDb.retrieveSemantic).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Chat/type modes keep existing TF-IDF behavior
    // -----------------------------------------------------------------------

    it("returns recent chat entries for chat mode without a query", async () => {
      (mockDb.getByTier as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const options = { mode: "chat" as const, chatId: "chat_1" as ChatId };
      const result = await adapter.retrieve(options);

      expect(result).toEqual({ kind: "ok", value: [] });
      expect(mockDb.retrieve).not.toHaveBeenCalled();
      expect(mockDb.retrieveSemantic).not.toHaveBeenCalled();
    });

    it("keeps existing TF-IDF behavior for type mode", async () => {
      (mockDb.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const options = { mode: "type" as const, types: ["conversation" as const], query: "test" };
      const result = await adapter.retrieve(options);

      expect(result).toEqual({ kind: "ok", value: [] });
      expect(mockDb.retrieve).toHaveBeenCalledWith("test", options);
      expect(mockDb.retrieveSemantic).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Error handling
    // -----------------------------------------------------------------------

    it("returns err() when agentdb.retrieveSemantic throws", async () => {
      (mockDb.retrieveSemantic as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("semantic failed"));

      const options = { mode: "text" as const, query: "hello" };
      const result = await adapter.retrieve(options);

      expect(result.kind).toBe("err");
      if (result.kind === "err") {
        expect(result.error.message).toBe("semantic failed");
      }
    });

    it("returns err() when chat-mode history lookup fails", async () => {
      (mockDb.getByTier as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("retrieval failed"));

      const options = { mode: "chat" as const, chatId: "chat_1" as ChatId };
      const result = await adapter.retrieve(options);

      expect(result.kind).toBe("err");
      if (result.kind === "err") {
        expect(result.error.message).toBe("retrieval failed");
      }
    });
  });

  // =========================================================================
  // Core method: retrieveSemantic
  // =========================================================================

  describe("retrieveSemantic()", () => {
    it("delegates to agentdb.retrieveSemantic() and returns results wrapped in ok()", async () => {
      const mockResults: RetrievalResult[] = [
        {
          entry: { id: "mem_3" as MemoryId, type: "note", content: "semantic result" } as unknown as MemoryEntry,
          score: 0.92 as NormalizedScore,
        },
      ];
      (mockDb.retrieveSemantic as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

      const result = await adapter.retrieveSemantic("semantic query", { limit: 3 });

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value[0].entry).toEqual(expect.objectContaining({
          id: "mem_3",
          type: "note",
          content: "semantic result",
          source: "user",
        }));
      }
      expect(mockDb.retrieveSemantic).toHaveBeenCalledWith("semantic query", { limit: 6 });
    });

    it("returns err() when agentdb.retrieveSemantic() throws", async () => {
      (mockDb.retrieveSemantic as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("search broke"));

      const result = await adapter.retrieveSemantic("query");

      expect(result.kind).toBe("err");
      if (result.kind === "err") {
        expect(result.error.message).toBe("search broke");
      }
    });
  });

  // =========================================================================
  // Core method: getCachedAnalysis
  // =========================================================================

  describe("getCachedAnalysis()", () => {
    const mockAnalysis = {
      projectName: "test",
      analyzedAt: new Date(),
    } as unknown as StradaProjectAnalysis;

    it("returns ok(some(analysis)) when agentdb returns analysis", async () => {
      (mockDb.getCachedAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue(mockAnalysis);

      const result = await adapter.getCachedAnalysis("/test/path");

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value.kind).toBe("some");
        if (result.value.kind === "some") {
          expect(result.value.value).toBe(mockAnalysis);
        }
      }
      expect(mockDb.getCachedAnalysis).toHaveBeenCalledWith("/test/path", undefined);
    });

    it("returns ok(none()) when agentdb returns null", async () => {
      (mockDb.getCachedAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await adapter.getCachedAnalysis("/test/path");

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value.kind).toBe("none");
      }
    });

    it("passes maxAgeMs to agentdb", async () => {
      (mockDb.getCachedAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const maxAge = 60000 as DurationMs;

      await adapter.getCachedAnalysis("/test/path", maxAge);

      expect(mockDb.getCachedAnalysis).toHaveBeenCalledWith("/test/path", maxAge);
    });
  });

  // =========================================================================
  // Core method: storeConversation
  // =========================================================================

  describe("storeConversation()", () => {
    it("stores conversation metadata through agentdb.storeEntry() and wraps entry.id in ok()", async () => {
      const mockEntry = {
        id: "mem_123" as MemoryId,
        type: "conversation",
        content: "test summary",
      } as unknown as MemoryEntry;
      (mockDb.storeEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ok", value: mockEntry });

      const chatId = "chat_1" as ChatId;
      const result = await adapter.storeConversation(chatId, "test summary", {
        tags: ["a", "b"],
        importance: "high",
        turnNumber: 7,
        userMessage: "user says hi",
        assistantMessage: "assistant says hi",
      });

      expect(result).toEqual({ kind: "ok", value: "mem_123" });
      expect(mockDb.storeEntry).toHaveBeenCalledWith(expect.objectContaining({
        type: "conversation",
        content: "test summary",
        chatId,
        tier: MemoryTier.Working,
        importance: "high",
        tags: ["a", "b", "conversation"],
        metadata: {
          userMessage: "user says hi",
          assistantMessage: "assistant says hi",
          turnNumber: 7,
        },
      }));
    });

    it("handles missing options", async () => {
      const mockEntry = { id: "mem_456" as MemoryId } as unknown as MemoryEntry;
      (mockDb.storeEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ok", value: mockEntry });

      const result = await adapter.storeConversation("chat_2" as ChatId, "summary");

      expect(result).toEqual({ kind: "ok", value: "mem_456" });
      expect(mockDb.storeEntry).toHaveBeenCalledWith(expect.objectContaining({
        type: "conversation",
        content: "summary",
        chatId: "chat_2",
        importance: "medium",
      }));
    });

    it("returns err() when storeEntry throws", async () => {
      (mockDb.storeEntry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("store failed"));

      const result = await adapter.storeConversation("chat_1" as ChatId, "summary");

      expect(result.kind).toBe("err");
    });
  });

  // =========================================================================
  // Core method: cacheAnalysis
  // =========================================================================

  describe("cacheAnalysis()", () => {
    it("delegates to agentdb.cacheAnalysis and wraps in ok()", async () => {
      (mockDb.cacheAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ok", value: undefined });

      const analysis = { projectName: "test" } as unknown as StradaProjectAnalysis;
      const result = await adapter.cacheAnalysis(analysis, "/test/path");

      expect(result).toEqual({ kind: "ok", value: undefined });
      expect(mockDb.cacheAnalysis).toHaveBeenCalledWith(analysis, "/test/path");
    });

    it("ignores options.ttl parameter", async () => {
      (mockDb.cacheAnalysis as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ok", value: undefined });

      const analysis = { projectName: "test" } as unknown as StradaProjectAnalysis;
      const result = await adapter.cacheAnalysis(analysis, "/test/path", { ttl: 60000 as DurationMs });

      expect(result).toEqual({ kind: "ok", value: undefined });
      // Should still only pass analysis and path, not ttl
      expect(mockDb.cacheAnalysis).toHaveBeenCalledWith(analysis, "/test/path");
    });
  });

  // =========================================================================
  // Core method: getStats
  // =========================================================================

  describe("getStats()", () => {
    it("returns agentdb.getStats() directly (UnifiedMemoryStats extends MemoryStats)", () => {
      const stats = mockStats();
      (mockDb.getStats as ReturnType<typeof vi.fn>).mockReturnValue(stats);

      const result = adapter.getStats();

      expect(result.totalEntries).toBe(50);
      expect(result.conversationCount).toBe(20);
      expect(mockDb.getStats).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // Core method: getHealth
  // =========================================================================

  describe("getHealth()", () => {
    it("synthesizes MemoryHealth from agentdb.getStats() and agentdb.getIndexHealth()", () => {
      const stats = mockStats();
      const indexHealth: HnswHealth = {
        isHealthy: true,
        issues: [],
        fillRatio: 0.05 as NormalizedScore,
        averageConnections: 12,
        fragmentationRatio: 0.01 as NormalizedScore,
      };
      (mockDb.getStats as ReturnType<typeof vi.fn>).mockReturnValue(stats);
      (mockDb.getIndexHealth as ReturnType<typeof vi.fn>).mockReturnValue(indexHealth);

      const health = adapter.getHealth();

      expect(health.healthy).toBe(true);
      expect(health.issues).toEqual([]);
      expect(health.indexHealth).toBe("healthy");
      expect(typeof health.storageUsagePercent).toBe("number");
    });

    it("reports unhealthy when index has issues", () => {
      const stats = mockStats();
      const indexHealth: HnswHealth = {
        isHealthy: false,
        issues: ["Index fragmented", "Too many deletions"],
        fillRatio: 0.95 as NormalizedScore,
        averageConnections: 4,
        fragmentationRatio: 0.5 as NormalizedScore,
      };
      (mockDb.getStats as ReturnType<typeof vi.fn>).mockReturnValue(stats);
      (mockDb.getIndexHealth as ReturnType<typeof vi.fn>).mockReturnValue(indexHealth);

      const health = adapter.getHealth();

      expect(health.healthy).toBe(false);
      expect(health.issues.length).toBeGreaterThan(0);
      expect(health.indexHealth).not.toBe("healthy");
    });

    it("reports capacity warning when near limits", () => {
      const stats = mockStats();
      // Override totalEntries to be near max capacity
      const nearCapacityStats = {
        ...stats,
        totalEntries: 10000,
        entriesByTier: {
          [MemoryTier.Working]: 95,
          [MemoryTier.Ephemeral]: 950,
          [MemoryTier.Persistent]: 8955,
        },
      };
      const indexHealth: HnswHealth = {
        isHealthy: true,
        issues: [],
        fillRatio: 0.9 as NormalizedScore,
        averageConnections: 12,
        fragmentationRatio: 0.01 as NormalizedScore,
      };
      (mockDb.getStats as ReturnType<typeof vi.fn>).mockReturnValue(nearCapacityStats);
      (mockDb.getIndexHealth as ReturnType<typeof vi.fn>).mockReturnValue(indexHealth);

      const health = adapter.getHealth();

      expect(health.issues).toContain("Memory near capacity");
    });
  });

  // =========================================================================
  // Core method: getChatHistory
  // =========================================================================

  describe("getChatHistory()", () => {
    it("collects conversation entries across tiers and maps them to ConversationMemoryEntry", async () => {
      const chatId = "chat_42" as ChatId;
      const mockEntries: MemoryEntry[] = [
        {
          id: "mem_100" as MemoryId,
          type: "conversation",
          content: "User asked about deployment",
          createdAt: 1700000000000 as TimestampMs,
          accessCount: 2,
          tags: ["conversation"],
          importance: "medium",
          archived: false,
          metadata: { userMessage: "How do I deploy?" },
          chatId,
          turnNumber: 1,
        } as unknown as MemoryEntry,
        {
          id: "mem_101" as MemoryId,
          type: "conversation",
          content: "Follow-up question",
          createdAt: 1700000001000 as TimestampMs,
          accessCount: 1,
          tags: ["conversation"],
          importance: "low",
          archived: false,
          metadata: {},
          chatId,
        } as unknown as MemoryEntry,
      ];
      (mockDb.getByTier as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockEntries)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await adapter.getChatHistory(chatId, { limit: 10 });

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value).toHaveLength(2);
        expect(result.value[0].type).toBe("conversation");
        expect(result.value[0].chatId).toBe(chatId);
        expect(result.value[0].userMessage).toBe("Follow-up question");
        expect(result.value[1].userMessage).toBe("How do I deploy?");
      }
      expect(mockDb.getByTier).toHaveBeenCalledTimes(3);
    });

    it("filters out non-conversation entries", async () => {
      const chatId = "chat_43" as ChatId;
      const mockEntries: MemoryEntry[] = [
        {
          id: "mem_200" as MemoryId,
          type: "conversation",
          content: "A conversation entry",
          createdAt: 1700000000000 as TimestampMs,
          accessCount: 0,
          tags: [],
          importance: "medium",
          archived: false,
          metadata: {},
          chatId,
        } as unknown as MemoryEntry,
        {
          id: "mem_201" as MemoryId,
          type: "note",
          content: "A note entry",
          createdAt: 1700000001000 as TimestampMs,
          accessCount: 0,
          tags: [],
          importance: "low",
          archived: false,
          metadata: {},
        } as unknown as MemoryEntry,
      ];
      (mockDb.getByTier as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockEntries)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await adapter.getChatHistory(chatId);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].id).toBe("mem_200");
      }
    });

    it("returns empty array when no entries exist", async () => {
      (mockDb.getByTier as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await adapter.getChatHistory("chat_empty" as ChatId);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value).toEqual([]);
      }
    });

    it("returns err() when tier retrieval throws", async () => {
      (mockDb.getByTier as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db error"));

      const result = await adapter.getChatHistory("chat_1" as ChatId);

      expect(result.kind).toBe("err");
      if (result.kind === "err") {
        expect(result.error.message).toBe("db error");
      }
    });
  });

  // =========================================================================
  // Core method: storeNote
  // =========================================================================

  describe("storeNote()", () => {
    it("stores note metadata through agentdb.storeEntry() and returns entry.id wrapped in ok()", async () => {
      const mockEntry = {
        id: "mem_note_1" as MemoryId,
        type: "note",
        content: "important note",
      } as unknown as MemoryEntry;
      (mockDb.storeEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ok", value: mockEntry });

      const result = await adapter.storeNote("important note", {
        tags: ["deploy", "config"],
        title: "Deploy note",
        source: "user",
        metadata: { area: "deploy" },
      });

      expect(result).toEqual({ kind: "ok", value: "mem_note_1" });
      expect(mockDb.storeEntry).toHaveBeenCalledWith(expect.objectContaining({
        type: "note",
        content: "important note",
        tags: ["deploy", "config", "note"],
        tier: MemoryTier.Persistent,
        metadata: {
          area: "deploy",
          title: "Deploy note",
          source: "user",
        },
      }));
    });

    it("passes undefined tags when options is omitted", async () => {
      const mockEntry = {
        id: "mem_note_2" as MemoryId,
        type: "note",
        content: "bare note",
      } as unknown as MemoryEntry;
      (mockDb.storeEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ok", value: mockEntry });

      const result = await adapter.storeNote("bare note");

      expect(result).toEqual({ kind: "ok", value: "mem_note_2" });
      expect(mockDb.storeEntry).toHaveBeenCalledWith(expect.objectContaining({
        type: "note",
        content: "bare note",
        tags: ["note"],
      }));
    });

    it("returns err() when storeEntry throws", async () => {
      (mockDb.storeEntry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("storage failed"));

      const result = await adapter.storeNote("note content");

      expect(result.kind).toBe("err");
      if (result.kind === "err") {
        expect(result.error.message).toBe("storage failed");
      }
    });

    it("wraps non-Error throws in Error", async () => {
      (mockDb.storeEntry as ReturnType<typeof vi.fn>).mockRejectedValue("string error");

      const result = await adapter.storeNote("note content");

      expect(result.kind).toBe("err");
      if (result.kind === "err") {
        expect(result.error.message).toBe("string error");
      }
    });
  });

  // =========================================================================
  // Core method: retrieveFromChat
  // =========================================================================

  describe("retrieveFromChat()", () => {
    it("delegates to agentdb.retrieve() with chat mode and filters conversation entries", async () => {
      const chatId = "chat_50" as ChatId;
      const mockResults: RetrievalResult[] = [
        {
          entry: {
            id: "mem_300" as MemoryId,
            type: "conversation",
            content: "matching conversation",
            chatId,
            userMessage: "test",
          } as unknown as MemoryEntry,
          score: 0.85 as NormalizedScore,
        },
        {
          entry: {
            id: "mem_301" as MemoryId,
            type: "note",
            content: "matching note",
          } as unknown as MemoryEntry,
          score: 0.75 as NormalizedScore,
        },
      ];
      (mockDb.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

      const result = await adapter.retrieveFromChat(chatId, { query: "test query", limit: 5 });

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        // Only conversation entries should be returned
        expect(result.value).toHaveLength(1);
        expect(result.value[0].entry.type).toBe("conversation");
        expect(result.value[0].entry.id).toBe("mem_300");
      }
      expect(mockDb.retrieve).toHaveBeenCalledWith("test query", {
        mode: "chat",
        chatId,
        limit: 10,
        query: "test query",
      });
    });

    it("returns most recent chat entries when no query option is provided", async () => {
      const chatId = "chat_51" as ChatId;
      (mockDb.getByTier as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          {
            id: "mem_recent" as MemoryId,
            type: "conversation",
            content: "latest message",
            createdAt: 1700000002000 as TimestampMs,
            accessCount: 0,
            tags: [],
            importance: "medium",
            archived: false,
            metadata: {},
            chatId,
          } as unknown as MemoryEntry,
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await adapter.retrieveFromChat(chatId);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].entry.id).toBe("mem_recent");
        expect(result.value[0].score).toBe(1);
      }
      expect(mockDb.retrieve).not.toHaveBeenCalled();
    });

    it("returns err() when retrieve throws", async () => {
      (mockDb.retrieve as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("retrieve failed"));

      const result = await adapter.retrieveFromChat("chat_1" as ChatId, { query: "test" });

      expect(result.kind).toBe("err");
      if (result.kind === "err") {
        expect(result.error.message).toBe("retrieve failed");
      }
    });
  });

  // =========================================================================
  // Operational adapter methods
  // =========================================================================

  describe("operational adapter methods", () => {
    it("storeError persists structured error metadata via storeEntry", async () => {
      (mockDb.storeEntry as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "ok",
        value: { id: "mem_err" as MemoryId, type: "error", content: "boom" } as unknown as MemoryEntry,
      });

      const result = await adapter.storeError(new Error("boom"), {
        category: "runtime",
        location: "worker.ts:10",
        chatId: "chat_err" as ChatId,
      }, {
        tags: ["agent"],
        metadata: { severity: "high" },
      });

      expect(result).toEqual({ kind: "ok", value: "mem_err" });
      expect(mockDb.storeEntry).toHaveBeenCalledWith(expect.objectContaining({
        type: "error",
        content: "boom",
        tier: MemoryTier.Persistent,
        chatId: "chat_err",
        tags: ["agent", "error", "runtime"],
        metadata: expect.objectContaining({
          severity: "high",
          errorCategory: "runtime",
          errorCode: "Error",
          location: "worker.ts:10",
          resolved: false,
        }),
      }));
    });

    it("resolveError marks persisted error entries as resolved", async () => {
      const errorEntry = {
        id: "mem_err_2" as MemoryId,
        type: "error",
        content: "failure",
        createdAt: 1700000000000 as TimestampMs,
        accessCount: 0,
        tags: [],
        importance: "high",
        archived: false,
        metadata: { resolved: false },
      } as unknown as MemoryEntry;
      (mockDb.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "ok",
        value: { kind: "some", value: errorEntry },
      });

      const result = await adapter.resolveError("mem_err_2" as MemoryId, "patched");

      expect(result).toEqual({ kind: "ok", value: undefined });
      expect(mockDb.persistEntry).toHaveBeenCalledWith(expect.objectContaining({
        id: "mem_err_2",
        metadata: expect.objectContaining({
          resolved: true,
          resolution: "patched",
        }),
        resolution: "patched",
        resolved: true,
      }));
    });

    it("retrievePaginated slices processed retrieval results", async () => {
      (mockDb.retrieveSemantic as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          entry: { id: "mem_1" as MemoryId, type: "note", content: "one" } as unknown as MemoryEntry,
          score: 0.9 as NormalizedScore,
        },
        {
          entry: { id: "mem_2" as MemoryId, type: "note", content: "two" } as unknown as MemoryEntry,
          score: 0.8 as NormalizedScore,
        },
        {
          entry: { id: "mem_3" as MemoryId, type: "note", content: "three" } as unknown as MemoryEntry,
          score: 0.7 as NormalizedScore,
        },
      ]);

      const result = await adapter.retrievePaginated(
        { mode: "text", query: "note", limit: 10 },
        { page: 2, pageSize: 1 },
      );

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.value.results).toHaveLength(1);
        expect(result.value.results[0].entry.id).toBe("mem_2");
        expect(result.value.totalCount).toBe(3);
        expect(result.value.hasMore).toBe(true);
        expect(result.value.nextCursor).toBe("3");
      }
    });

    it("archives old entries and persists the archive flag", async () => {
      const oldEntry = {
        id: "mem_old" as MemoryId,
        type: "note",
        content: "old",
        createdAt: 1000 as TimestampMs,
        accessCount: 0,
        tags: [],
        importance: "low",
        archived: false,
        metadata: {},
      } as unknown as MemoryEntry;
      const freshEntry = {
        id: "mem_new" as MemoryId,
        type: "note",
        content: "new",
        createdAt: 5000 as TimestampMs,
        accessCount: 0,
        tags: [],
        importance: "low",
        archived: false,
        metadata: {},
      } as unknown as MemoryEntry;
      (mockDb.getByTier as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([oldEntry, freshEntry])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await adapter.archiveOldEntries(3000 as TimestampMs);

      expect(result).toEqual({ kind: "ok", value: 1 });
      expect(mockDb.persistEntry).toHaveBeenCalledWith(expect.objectContaining({
        id: "mem_old",
        archived: true,
      }));
    });

    it("deleteEntry delegates to agentdb.delete()", async () => {
      (mockDb.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ok", value: true });

      const result = await adapter.deleteEntry("mem_1" as MemoryId);

      expect(result).toEqual({ kind: "ok", value: true });
      expect(mockDb.delete).toHaveBeenCalledWith("mem_1");
    });

    it("invalidateAnalysis clears matching cached analysis state", async () => {
      mockDb.cachedAnalysis = {
        projectPath: "/path",
        analysis: { projectName: "demo", analyzedAt: new Date() } as unknown as StradaProjectAnalysis,
      };

      const result = await adapter.invalidateAnalysis("/path");

      expect(result).toEqual({ kind: "ok", value: undefined });
      expect(mockDb.cachedAnalysis).toBeNull();
    });

    it("compact delegates to agentdb.compact()", async () => {
      (mockDb.compact as ReturnType<typeof vi.fn>).mockResolvedValue({ freedBytes: 512 });

      const result = await adapter.compact();

      expect(result).toEqual({ kind: "ok", value: { freedBytes: 512 } });
      expect(mockDb.compact).toHaveBeenCalledOnce();
    });
  });
});
