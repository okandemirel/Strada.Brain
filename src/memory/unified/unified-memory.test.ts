import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createLogger } from "../../utils/logger.js";
import { AgentDBMemory } from "./agentdb-memory.js";
import { MemoryTier } from "./unified-memory.interface.js";

// Initialize logger for tests
beforeAll(() => {
  createLogger("error", "test.log");
});

describe("AgentDBMemory", () => {
  let tempDir: string;
  let memory: AgentDBMemory;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "agentdb-test-"));
    memory = new AgentDBMemory({
      dbPath: tempDir,
      dimensions: 128, // Smaller for testing
      maxEntriesPerTier: {
        [MemoryTier.Working]: 10,
        [MemoryTier.Ephemeral]: 50,
        [MemoryTier.Persistent]: 100,
      },
      hnswParams: {
        efConstruction: 50,
        M: 8,
        efSearch: 32,
      },
      quantizationType: "none",
      cacheSize: 100,
      enableAutoTiering: true,
      ephemeralTtlMs: 1000, // 1 second for testing
    });
    await memory.initialize();
  });

  afterEach(async () => {
    await memory.shutdown();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("basic operations", () => {
    it("should store and retrieve a conversation", async () => {
      await memory.storeConversation("chat-1", "Test conversation summary", ["test"]);
      
      const history = await memory.getChatHistory("chat-1");
      expect(history).toHaveLength(1);
      expect(history[0]!.content).toBe("Test conversation summary");
      expect(history[0]!.tier).toBe("ephemeral");
    });

    it("should store and retrieve a note", async () => {
      await memory.storeNote("Important note content", ["important"]);
      
      const results = await memory.retrieve("note", { type: "note" });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.entry.content).toBe("Important note content");
    });

    it("should support all memory tiers", async () => {
      await memory.storeConversation("chat-1", "Working memory", [], MemoryTier.Working);
      await memory.storeConversation("chat-1", "Ephemeral memory", [], MemoryTier.Ephemeral);
      await memory.storeNote("Persistent memory", [], MemoryTier.Persistent);

      const working = await memory.getByTier(MemoryTier.Working);
      const ephemeral = await memory.getByTier(MemoryTier.Ephemeral);
      const persistent = await memory.getByTier(MemoryTier.Persistent);

      expect(working).toHaveLength(1);
      expect(ephemeral).toHaveLength(1);
      expect(persistent).toHaveLength(1);
    });
  });

  describe("semantic search", () => {
    it("should perform semantic search", async () => {
      await memory.storeNote("The quick brown fox jumps over the lazy dog", ["animals"]);
      await memory.storeNote("Machine learning is a subset of artificial intelligence", ["ai"]);
      await memory.storeNote("The weather is sunny today", ["weather"]);

      const results = await memory.retrieveSemantic("artificial intelligence", { limit: 2 });
      
      // With mock embeddings, we just verify results are returned
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.score).toBeGreaterThan(0);
    });

    it("should filter by tier in semantic search", async () => {
      await memory.storeNote("Working note", [], MemoryTier.Working);
      await memory.storeNote("Persistent note", [], MemoryTier.Persistent);

      const workingResults = await memory.retrieveSemantic("note", { tier: MemoryTier.Working });
      expect(workingResults).toHaveLength(1);
      expect(workingResults[0]!.entry.tier).toBe(MemoryTier.Working);
    });
  });

  describe("tier management", () => {
    it("should promote entries between tiers", async () => {
      const entry = await memory.storeNote("Test note", [], MemoryTier.Ephemeral);
      expect(entry.tier).toBe(MemoryTier.Ephemeral);

      await memory.promoteEntry(entry.id, MemoryTier.Persistent);
      
      const persistent = await memory.getByTier(MemoryTier.Persistent);
      expect(persistent.some(e => e.id === entry.id)).toBe(true);
    });

    it("should demote entries between tiers", async () => {
      const entry = await memory.storeNote("Test note", [], MemoryTier.Persistent);
      
      await memory.demoteEntry(entry.id, MemoryTier.Ephemeral);
      
      const ephemeral = await memory.getByTier(MemoryTier.Ephemeral);
      expect(ephemeral.some(e => e.id === entry.id)).toBe(true);
    });

    it("should enforce tier limits", async () => {
      // Fill up working tier beyond limit
      for (let i = 0; i < 15; i++) {
        await memory.storeNote(`Note ${i}`, [], MemoryTier.Working);
      }

      const working = await memory.getByTier(MemoryTier.Working);
      expect(working.length).toBeLessThanOrEqual(10); // maxEntriesPerTier limit
    });
  });

  describe("cleanup and maintenance", () => {
    it("should clean up expired ephemeral entries", async () => {
      await memory.storeConversation("chat-1", "Will expire", [], MemoryTier.Ephemeral);
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      const cleaned = await memory.cleanupExpired();
      expect(cleaned).toBeGreaterThan(0);
      
      const ephemeral = await memory.getByTier(MemoryTier.Ephemeral);
      expect(ephemeral).toHaveLength(0);
    });

    it("should get statistics", () => {
      const stats = memory.getStats();
      
      expect(stats.totalEntries).toBeDefined();
      expect(stats.entriesByTier).toBeDefined();
      expect(stats.hnswStats).toBeDefined();
      expect(stats.quantizationStats).toBeDefined();
      expect(stats.performance).toBeDefined();
    });

    it("should check index health", () => {
      const health = memory.getIndexHealth();
      
      expect(health.isHealthy).toBeDefined();
      expect(health.issues).toBeInstanceOf(Array);
    });
  });

  describe("analysis cache", () => {
    it("should cache and retrieve project analysis", async () => {
      const mockAnalysis = {
        modules: [],
        systems: [],
        components: [],
        services: [],
        mediators: [],
        controllers: [],
        events: [],
        dependencies: [],
        csFileCount: 10,
        analyzedAt: new Date(),
      };

      await memory.cacheAnalysis(mockAnalysis, "/test/project");
      
      const cached = await memory.getCachedAnalysis("/test/project");
      expect(cached).toBeDefined();
      expect(cached!.analyzedAt).toEqual(mockAnalysis.analyzedAt);
    });

    it("should return null for expired cache", async () => {
      const oldAnalysis = {
        modules: [],
        systems: [],
        components: [],
        services: [],
        mediators: [],
        controllers: [],
        events: [],
        dependencies: [],
        csFileCount: 10,
        analyzedAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 48 hours old
      };

      await memory.cacheAnalysis(oldAnalysis, "/test/project");
      
      const cached = await memory.getCachedAnalysis("/test/project", 24 * 60 * 60 * 1000);
      expect(cached).toBeNull();
    });
  });
});
