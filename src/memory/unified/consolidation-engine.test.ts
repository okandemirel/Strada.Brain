/**
 * Tests for MemoryConsolidationEngine
 *
 * Covers: clustering, summarization, soft-delete, interruption,
 * depth tracking, undo, preview, age filter, exempt domains.
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createLogger } from "../../utils/logger.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type { ConsolidationConfig, MemoryCluster } from "./consolidation-types.js";
import { MemoryConsolidationEngine } from "./consolidation-engine.js";
import type { NormalizedScore, TimestampMs, Vector } from "../../types/index.js";
import { createBrand } from "../../types/index.js";

// Initialize logger for tests
beforeAll(() => {
  createLogger("error", "test.log");
});

// =============================================================================
// HELPERS
// =============================================================================

const DEFAULT_CONFIG: ConsolidationConfig = {
  enabled: true,
  idleMinutes: 5,
  threshold: 0.85,
  batchSize: 50,
  minClusterSize: 2,
  maxDepth: 3,
  modelTier: "cheap",
  minAgeMs: 3600000, // 1 hour
};

function makeVector(dims: number, seed: number): Vector<number> {
  const v = new Array(dims).fill(0).map((_, i) => Math.sin(seed + i));
  const mag = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((x) => x / mag) as Vector<number>;
}

interface MockEntry {
  id: string;
  type: string;
  content: string;
  tier: MemoryTier;
  domain?: string;
  importance: string;
  importanceScore: NormalizedScore;
  embedding: Vector<number>;
  createdAt: TimestampMs;
  lastAccessedAt: TimestampMs;
  accessCount: number;
  metadata: Record<string, unknown>;
  tags: string[];
  archived: boolean;
  chatId: string;
  version: number;
}

function makeEntry(overrides: Partial<MockEntry> = {}): MockEntry {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    type: "note",
    content: overrides.content ?? `Entry ${id.slice(0, 8)}`,
    tier: overrides.tier ?? MemoryTier.Ephemeral,
    domain: overrides.domain,
    importance: "medium",
    importanceScore: overrides.importanceScore ?? (0.5 as NormalizedScore),
    embedding: overrides.embedding ?? makeVector(4, Math.random() * 100),
    createdAt: overrides.createdAt ?? createBrand(Date.now() - 7200000, "TimestampMs" as const), // 2 hours ago
    lastAccessedAt: overrides.lastAccessedAt ?? createBrand(Date.now() - 3600000, "TimestampMs" as const),
    accessCount: overrides.accessCount ?? 1,
    metadata: overrides.metadata ?? {},
    tags: overrides.tags ?? [],
    archived: false,
    chatId: "default",
    version: 1,
  };
}

function setupDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  // Create memories table as AgentDB does
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      key TEXT,
      value TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      embedding BLOB,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertEntryIntoDb(db: Database.Database, entry: MockEntry): void {
  const value = JSON.stringify({
    type: entry.type,
    content: entry.content,
    tags: entry.tags,
    importance: entry.importance,
    tier: entry.tier,
    accessCount: entry.accessCount,
    lastAccessedAt: entry.lastAccessedAt,
    importanceScore: entry.importanceScore,
    domain: entry.domain,
    chatId: entry.chatId,
    version: entry.version,
  });
  const metadata = JSON.stringify(entry.metadata);
  const embBuf = Buffer.from(new Float32Array(entry.embedding).buffer);
  db.prepare(
    "INSERT OR REPLACE INTO memories (id, key, value, metadata, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(entry.id, entry.type, value, metadata, embBuf, entry.createdAt as number, Date.now());
}

// =============================================================================
// MOCK HNSW STORE
// =============================================================================

interface MockHnswStore {
  search: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
}

function createMockHnswStore(): MockHnswStore {
  return {
    search: vi.fn(async () => []),
    remove: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("MemoryConsolidationEngine", () => {
  let db: Database.Database;
  let entries: Map<string, MockEntry>;
  let mockHnsw: MockHnswStore;
  let mockEmitter: { emit: ReturnType<typeof vi.fn> };
  let mockLogger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  let generateEmbedding: ReturnType<typeof vi.fn>;
  let summarizeWithLLM: ReturnType<typeof vi.fn>;
  let engine: MemoryConsolidationEngine;

  beforeEach(() => {
    db = setupDb();
    entries = new Map();
    mockHnsw = createMockHnswStore();
    mockEmitter = { emit: vi.fn() };
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    generateEmbedding = vi.fn(async () => makeVector(4, 42));
    summarizeWithLLM = vi.fn(async () => ({
      summary: "Consolidated summary of entries",
      cost: 0.001,
      model: "test-model",
    }));

    engine = new MemoryConsolidationEngine({
      sqliteDb: db,
      entries: entries as unknown as Map<string, unknown>,
      hnswStore: mockHnsw as unknown as never,
      config: DEFAULT_CONFIG,
      generateEmbedding,
      summarizeWithLLM,
      eventEmitter: mockEmitter,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ---------------------------------------------------------------------------
  // CLUSTERING
  // ---------------------------------------------------------------------------

  describe("findClusters", () => {
    it("finds clusters: entries with same tier and similarity >= threshold are grouped", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      const e3 = makeEntry({ id: "e3", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      entries.set("e1", e1);
      entries.set("e2", e2);
      entries.set("e3", e3);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);
      insertEntryIntoDb(db, e3);

      // Mock HNSW to return neighbors above threshold
      mockHnsw.search.mockImplementation(async () => [
        { id: "e1", chunk: {}, score: 0.95 },
        { id: "e2", chunk: {}, score: 0.92 },
        { id: "e3", chunk: {}, score: 0.90 },
      ]);

      const clusters = await engine.findClusters(MemoryTier.Ephemeral);
      expect(clusters.length).toBeGreaterThanOrEqual(1);
      expect(clusters[0]!.memberIds.length).toBeGreaterThanOrEqual(2);
      expect(clusters[0]!.tier).toBe(MemoryTier.Ephemeral);
    });

    it("same tier only: entries from different tiers are never in the same cluster", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Working, embedding: sharedVec });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      mockHnsw.search.mockImplementation(async () => [
        { id: "e1", chunk: {}, score: 0.95 },
        { id: "e2", chunk: {}, score: 0.95 },
      ]);

      const clusters = await engine.findClusters(MemoryTier.Ephemeral);
      for (const cluster of clusters) {
        for (const memberId of cluster.memberIds) {
          const entry = entries.get(memberId);
          expect(entry?.tier).toBe(MemoryTier.Ephemeral);
        }
      }
    });

    it("min cluster size: clusters smaller than minClusterSize are excluded", async () => {
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral });
      entries.set("e1", e1);
      insertEntryIntoDb(db, e1);

      mockHnsw.search.mockImplementation(async () => [
        { id: "e1", chunk: {}, score: 0.95 },
      ]);

      const clusters = await engine.findClusters(MemoryTier.Ephemeral);
      expect(clusters.length).toBe(0);
    });

    it("instinct exemption: entries with domain='instinct' are excluded from clustering", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, domain: "instinct", embedding: sharedVec });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      mockHnsw.search.mockImplementation(async () => [
        { id: "e1", chunk: {}, score: 0.95 },
        { id: "e2", chunk: {}, score: 0.95 },
      ]);

      const clusters = await engine.findClusters(MemoryTier.Ephemeral);
      for (const cluster of clusters) {
        expect(cluster.memberIds).not.toContain("e1");
      }
    });

    it("exempt domains: entries whose domain is in exempt list are excluded", async () => {
      const sharedVec = makeVector(4, 1);
      const engineWithExempt = new MemoryConsolidationEngine({
        sqliteDb: db,
        entries: entries as unknown as Map<string, unknown>,
        hnswStore: mockHnsw as unknown as never,
        config: DEFAULT_CONFIG,
        generateEmbedding,
        summarizeWithLLM,
        eventEmitter: mockEmitter,
        logger: mockLogger,
        exemptDomains: ["analysis-cache", "instinct"],
      });

      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, domain: "analysis-cache", embedding: sharedVec });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      mockHnsw.search.mockImplementation(async () => [
        { id: "e1", chunk: {}, score: 0.95 },
        { id: "e2", chunk: {}, score: 0.95 },
      ]);

      const clusters = await engineWithExempt.findClusters(MemoryTier.Ephemeral);
      for (const cluster of clusters) {
        expect(cluster.memberIds).not.toContain("e1");
      }
    });

    it("max depth: entries at consolidation depth >= maxDepth are excluded", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({
        id: "e1",
        tier: MemoryTier.Ephemeral,
        embedding: sharedVec,
        metadata: { consolidation: { depth: 3 } },
      });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      mockHnsw.search.mockImplementation(async () => [
        { id: "e1", chunk: {}, score: 0.95 },
        { id: "e2", chunk: {}, score: 0.95 },
      ]);

      const clusters = await engine.findClusters(MemoryTier.Ephemeral);
      for (const cluster of clusters) {
        expect(cluster.memberIds).not.toContain("e1");
      }
    });

    it("age filter: entries created within last hour are excluded", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({
        id: "e1",
        tier: MemoryTier.Ephemeral,
        embedding: sharedVec,
        createdAt: createBrand(Date.now() - 1000, "TimestampMs" as const), // 1 second ago
      });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      mockHnsw.search.mockImplementation(async () => [
        { id: "e1", chunk: {}, score: 0.95 },
        { id: "e2", chunk: {}, score: 0.95 },
      ]);

      const clusters = await engine.findClusters(MemoryTier.Ephemeral);
      for (const cluster of clusters) {
        expect(cluster.memberIds).not.toContain("e1");
      }
    });

    it("clusters sorted by highest avg similarity first", async () => {
      const vec1 = makeVector(4, 1);
      const vec2 = makeVector(4, 5);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, embedding: vec1 });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: vec1 });
      const e3 = makeEntry({ id: "e3", tier: MemoryTier.Ephemeral, embedding: vec2 });
      const e4 = makeEntry({ id: "e4", tier: MemoryTier.Ephemeral, embedding: vec2 });
      entries.set("e1", e1);
      entries.set("e2", e2);
      entries.set("e3", e3);
      entries.set("e4", e4);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);
      insertEntryIntoDb(db, e3);
      insertEntryIntoDb(db, e4);

      let callCount = 0;
      mockHnsw.search.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return [
            { id: "e1", chunk: {}, score: 0.95 },
            { id: "e2", chunk: {}, score: 0.93 },
          ];
        }
        return [
          { id: "e3", chunk: {}, score: 0.88 },
          { id: "e4", chunk: {}, score: 0.86 },
        ];
      });

      const clusters = await engine.findClusters(MemoryTier.Ephemeral);
      if (clusters.length >= 2) {
        expect(clusters[0]!.avgSimilarity).toBeGreaterThanOrEqual(clusters[1]!.avgSimilarity);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // SUMMARIZATION & SOFT-DELETE
  // ---------------------------------------------------------------------------

  describe("processCluster", () => {
    it("summarizes cluster: LLM generates summary; summary inherits max importance", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, importanceScore: 0.3 as NormalizedScore, embedding: sharedVec, content: "Content 1" });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, importanceScore: 0.8 as NormalizedScore, embedding: sharedVec, content: "Content 2" });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      const cluster: MemoryCluster = {
        seedId: "e1",
        memberIds: ["e1", "e2"],
        avgSimilarity: 0.92,
        tier: MemoryTier.Ephemeral,
      };

      const result = await engine.processCluster(cluster);
      expect(result.cost).toBeGreaterThanOrEqual(0);
      expect(summarizeWithLLM).toHaveBeenCalled();

      // Check the summary entry was inserted into the entries map
      const summaryEntry = Array.from(entries.values()).find(
        (e) => {
          const meta = (e as unknown as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
          return meta?.consolidation !== undefined;
        },
      );
      expect(summaryEntry).toBeDefined();

      // Summary should have consolidation metadata with source IDs
      const summaryMeta = (summaryEntry as unknown as Record<string, unknown>).metadata as Record<string, unknown>;
      const consolidationMeta = summaryMeta.consolidation as Record<string, unknown>;
      expect(consolidationMeta.sourceIds).toEqual(["e1", "e2"]);
    });

    it("atomic transaction: soft-delete + summary insert + log insert in one transaction", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      const cluster: MemoryCluster = {
        seedId: "e1",
        memberIds: ["e1", "e2"],
        avgSimilarity: 0.90,
        tier: MemoryTier.Ephemeral,
      };

      await engine.processCluster(cluster);

      // Check soft-delete flags on originals (both SQL column and JSON blob)
      const row1 = db.prepare("SELECT * FROM memories WHERE id = ?").get("e1") as Record<string, unknown>;
      const val1 = JSON.parse(row1.value as string) as Record<string, unknown>;
      expect(val1.consolidated_into).toBeDefined();
      expect(val1.consolidated_at).toBeDefined();
      // SQL column must also be set (used by isConsolidated bulk query)
      expect(row1.consolidated_into).toBeDefined();
      expect(row1.consolidated_into).not.toBeNull();

      // Check consolidation log entry exists
      const logRows = db.prepare("SELECT * FROM consolidation_log").all();
      expect(logRows.length).toBe(1);
    });

    it("soft delete: original entries get consolidated_into set, NOT physically deleted", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      const cluster: MemoryCluster = {
        seedId: "e1",
        memberIds: ["e1", "e2"],
        avgSimilarity: 0.90,
        tier: MemoryTier.Ephemeral,
      };

      await engine.processCluster(cluster);

      // Originals still exist in DB (not physically deleted)
      const row1 = db.prepare("SELECT * FROM memories WHERE id = ?").get("e1");
      const row2 = db.prepare("SELECT * FROM memories WHERE id = ?").get("e2");
      expect(row1).toBeDefined();
      expect(row2).toBeDefined();
    });

    it("HNSW cleanup: original vectors removed, summary vector added", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      const cluster: MemoryCluster = {
        seedId: "e1",
        memberIds: ["e1", "e2"],
        avgSimilarity: 0.90,
        tier: MemoryTier.Ephemeral,
      };

      await engine.processCluster(cluster);

      // HNSW remove called for originals
      expect(mockHnsw.remove).toHaveBeenCalledWith(["e1", "e2"]);
      // HNSW upsert called for summary
      expect(mockHnsw.upsert).toHaveBeenCalled();
    });

    it("embedding failure: if embedding generation fails, skip cluster", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      generateEmbedding.mockRejectedValueOnce(new Error("Embedding provider failed"));

      const cluster: MemoryCluster = {
        seedId: "e1",
        memberIds: ["e1", "e2"],
        avgSimilarity: 0.90,
        tier: MemoryTier.Ephemeral,
      };

      await expect(engine.processCluster(cluster)).rejects.toThrow();

      // No consolidation log should be created
      const logRows = db.prepare("SELECT * FROM consolidation_log").all();
      expect(logRows.length).toBe(0);
    });

    it("recursive depth: summary entry depth = max(source depths) + 1", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({
        id: "e1",
        tier: MemoryTier.Ephemeral,
        embedding: sharedVec,
        metadata: { consolidation: { depth: 1 } },
      });
      const e2 = makeEntry({
        id: "e2",
        tier: MemoryTier.Ephemeral,
        embedding: sharedVec,
        metadata: { consolidation: { depth: 2 } },
      });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      const cluster: MemoryCluster = {
        seedId: "e1",
        memberIds: ["e1", "e2"],
        avgSimilarity: 0.90,
        tier: MemoryTier.Ephemeral,
      };

      await engine.processCluster(cluster);

      // Find the summary entry
      const summaryEntry = Array.from(entries.values()).find(
        (e) => {
          const meta = (e as unknown as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
          return meta?.consolidation && ((meta.consolidation as Record<string, unknown>).sourceIds as string[] | undefined)?.includes("e1");
        },
      );
      expect(summaryEntry).toBeDefined();
      const meta = (summaryEntry as unknown as Record<string, unknown>).metadata as Record<string, unknown>;
      expect((meta.consolidation as Record<string, unknown>).depth).toBe(3); // max(1,2) + 1
    });
  });

  // ---------------------------------------------------------------------------
  // INTERRUPTION (MEM-13)
  // ---------------------------------------------------------------------------

  describe("runCycle", () => {
    it("interruption: AbortSignal checked between clusters; returns 'interrupted'", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      const vec2 = makeVector(4, 5);
      const e3 = makeEntry({ id: "e3", tier: MemoryTier.Ephemeral, embedding: vec2 });
      const e4 = makeEntry({ id: "e4", tier: MemoryTier.Ephemeral, embedding: vec2 });
      entries.set("e1", e1);
      entries.set("e2", e2);
      entries.set("e3", e3);
      entries.set("e4", e4);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);
      insertEntryIntoDb(db, e3);
      insertEntryIntoDb(db, e4);

      let callCount = 0;
      mockHnsw.search.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return [
            { id: "e1", chunk: {}, score: 0.95 },
            { id: "e2", chunk: {}, score: 0.93 },
          ];
        }
        return [
          { id: "e3", chunk: {}, score: 0.88 },
          { id: "e4", chunk: {}, score: 0.86 },
        ];
      });

      const controller = new AbortController();
      // Abort after the first cluster is processed
      let processCount = 0;
      const origProcess = engine.processCluster.bind(engine);
      vi.spyOn(engine, "processCluster").mockImplementation(async (cluster) => {
        const result = await origProcess(cluster);
        processCount++;
        if (processCount >= 1) {
          controller.abort();
        }
        return result;
      });

      const result = await engine.runCycle(controller.signal);
      expect(result.status).toBe("interrupted");
      expect(result.processed).toBeGreaterThanOrEqual(1);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });

    it("completed result: returns status 'completed' with zero remaining", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      mockHnsw.search.mockImplementation(async () => [
        { id: "e1", chunk: {}, score: 0.95 },
        { id: "e2", chunk: {}, score: 0.93 },
      ]);

      const controller = new AbortController();
      const result = await engine.runCycle(controller.signal);
      expect(result.status).toBe("completed");
      expect(result.remaining).toBe(0);
    });

    it("emits consolidation:started and consolidation:completed events", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      mockHnsw.search.mockImplementation(async () => [
        { id: "e1", chunk: {}, score: 0.95 },
        { id: "e2", chunk: {}, score: 0.93 },
      ]);

      const controller = new AbortController();
      await engine.runCycle(controller.signal);

      const emitCalls = mockEmitter.emit.mock.calls.map((c) => c[0]);
      expect(emitCalls).toContain("consolidation:started");
      expect(emitCalls).toContain("consolidation:completed");
    });

    it("skipped: returns skipped when no clusters found", async () => {
      const controller = new AbortController();
      const result = await engine.runCycle(controller.signal);
      expect(result.status).toBe("skipped");
      expect(result.processed).toBe(0);
      expect(result.clustersFound).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // PREVIEW (DRY-RUN)
  // ---------------------------------------------------------------------------

  describe("preview", () => {
    it("returns clusters with similarity scores without modifying anything", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, embedding: sharedVec, content: "Short" });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec, content: "Short" });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      mockHnsw.search.mockImplementation(async () => [
        { id: "e1", chunk: {}, score: 0.95 },
        { id: "e2", chunk: {}, score: 0.93 },
      ]);

      const preview = await engine.preview();
      expect(preview.clusters.length).toBeGreaterThanOrEqual(1);
      expect(preview.totalEstimatedCost).toBeGreaterThanOrEqual(0);

      // No modifications should have been made
      expect(mockHnsw.remove).not.toHaveBeenCalled();
      expect(mockHnsw.upsert).not.toHaveBeenCalled();
      expect(summarizeWithLLM).not.toHaveBeenCalled();

      // Consolidation log should be empty
      const logRows = db.prepare("SELECT * FROM consolidation_log").all();
      expect(logRows.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // UNDO
  // ---------------------------------------------------------------------------

  describe("undo", () => {
    it("restores originals, deletes summary, rebuilds HNSW vectors, marks log undone", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, embedding: sharedVec, content: "Content 1" });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec, content: "Content 2" });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      const cluster: MemoryCluster = {
        seedId: "e1",
        memberIds: ["e1", "e2"],
        avgSimilarity: 0.90,
        tier: MemoryTier.Ephemeral,
      };

      await engine.processCluster(cluster);

      // Get the log entry
      const logRow = db.prepare("SELECT * FROM consolidation_log").get() as Record<string, unknown>;
      const logId = logRow.id as string;
      const summaryId = logRow.summary_entry_id as string;

      // Reset mock call counts before undo
      mockHnsw.remove.mockClear();
      mockHnsw.upsert.mockClear();

      // Undo it (sync call, but HNSW ops are async fire-and-forget)
      engine.undo(logId);
      await new Promise(r => setTimeout(r, 50)); // Allow async HNSW ops to settle

      // Log should be marked as undone
      const updatedLog = db.prepare("SELECT * FROM consolidation_log WHERE id = ?").get(logId) as Record<string, unknown>;
      expect(updatedLog.status).toBe("undone");

      // Originals should be unflagged
      const row1 = db.prepare("SELECT * FROM memories WHERE id = ?").get("e1") as Record<string, unknown>;
      const val1 = JSON.parse(row1.value as string) as Record<string, unknown>;
      expect(val1.consolidated_into).toBeUndefined();

      // Summary entry should be removed
      const summaryRow = db.prepare("SELECT * FROM memories WHERE id = ?").get(summaryId);
      expect(summaryRow).toBeUndefined();

      // HNSW should have been updated (remove summary, upsert originals)
      expect(mockHnsw.remove).toHaveBeenCalled();
      expect(mockHnsw.upsert).toHaveBeenCalled();
    });

    it("throws if log status is not 'completed'", () => {
      // Insert an undone log entry
      db.prepare(
        "INSERT INTO consolidation_log (id, summary_entry_id, source_entry_ids, similarity_score, model_used, cost, timestamp, depth, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("log-1", "sum-1", JSON.stringify(["e1"]), 0.9, "test", 0, Date.now(), 1, "undone");

      expect(() => engine.undo("log-1")).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // STATS
  // ---------------------------------------------------------------------------

  describe("getStats", () => {
    it("returns per-tier breakdown and lifetime savings", async () => {
      const sharedVec = makeVector(4, 1);
      const e1 = makeEntry({ id: "e1", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      const e2 = makeEntry({ id: "e2", tier: MemoryTier.Ephemeral, embedding: sharedVec });
      entries.set("e1", e1);
      entries.set("e2", e2);
      insertEntryIntoDb(db, e1);
      insertEntryIntoDb(db, e2);

      const cluster: MemoryCluster = {
        seedId: "e1",
        memberIds: ["e1", "e2"],
        avgSimilarity: 0.90,
        tier: MemoryTier.Ephemeral,
      };

      await engine.processCluster(cluster);

      const stats = engine.getStats();
      expect(stats.totalRuns).toBeGreaterThanOrEqual(1);
      expect(stats.lifetimeSavings).toBeGreaterThanOrEqual(1);
      expect(stats.perTier).toBeDefined();
    });
  });
});
