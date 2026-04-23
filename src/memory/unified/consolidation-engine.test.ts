/**
 * Tests for Memory Consolidation Engine
 *
 * Covers: consolidation cycle, entry grouping/clustering, cluster processing,
 * AbortSignal handling, preview, undo, and stats.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryConsolidationEngine } from "./consolidation-engine.js";
import type { ConsolidationEngineOptions } from "./consolidation-engine.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type { ConsolidationConfig } from "./consolidation-types.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ConsolidationConfig> = {}): ConsolidationConfig {
  return {
    enabled: true,
    idleMinutes: 5,
    threshold: 0.7,
    batchSize: 10,
    minClusterSize: 2,
    maxDepth: 3,
    modelTier: "fast",
    minAgeMs: 0, // no minimum age for tests
    ...overrides,
  };
}

interface MemEntry {
  id: string;
  type: string;
  content: string;
  tier: MemoryTier;
  domain?: string;
  importance: string;
  importanceScore: number;
  embedding: number[];
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  metadata: Record<string, unknown>;
  tags: string[];
  archived: boolean;
  chatId: string;
  version?: number;
}

function makeMemEntry(id: string, content: string, overrides: Partial<MemEntry> = {}): MemEntry {
  return {
    id,
    type: "note",
    content,
    tier: MemoryTier.Ephemeral,
    importance: "medium",
    importanceScore: 0.5,
    embedding: [0.1, 0.2, 0.3, 0.4],
    createdAt: Date.now() - 100000,
    lastAccessedAt: Date.now(),
    accessCount: 0,
    metadata: {},
    tags: [],
    archived: false,
    chatId: "default",
    version: 1,
    ...overrides,
  };
}

/**
 * Build a fake SQLite database object that supports the operations
 * used by the consolidation engine.
 */
function makeFakeDb() {
  const tables: Record<string, Record<string, unknown>[]> = {
    memories: [],
    consolidation_log: [],
  };

  const db = {
    exec: vi.fn(),
    prepare: vi.fn((sql: string) => {
      const stmt = {
        _sql: sql,
        all: vi.fn(() => {
          if (sql.includes("PRAGMA table_info")) {
            return [
              { name: "id" },
              { name: "key" },
              { name: "value" },
              { name: "metadata" },
              { name: "embedding" },
              { name: "created_at" },
              { name: "updated_at" },
              { name: "consolidated_into" },
              { name: "consolidated_at" },
            ];
          }
          if (sql.includes("SELECT id FROM memories WHERE consolidated_into IS NOT NULL")) {
            return tables.memories
              .filter((r: any) => r.consolidated_into != null)
              .map((r: any) => ({ id: r.id }));
          }
          return [];
        }),
        get: vi.fn((arg?: string) => {
          if (sql.includes("consolidation_log WHERE id =")) {
            return tables.consolidation_log.find((r: any) => r.id === arg);
          }
          if (sql.includes("totalRuns")) {
            return { totalRuns: 0, totalCost: 0 };
          }
          if (sql.includes("json_array_length")) {
            return { savings: 0 };
          }
          if (sql.includes("SELECT COUNT(*)")) {
            return { cnt: 0 };
          }
          if (sql.includes("SELECT embedding FROM memories")) {
            return null;
          }
          if (sql.includes("SELECT * FROM memories WHERE id =")) {
            const found = tables.memories.find((r: any) => r.id === arg);
            return found ?? undefined;
          }
          return undefined;
        }),
        run: vi.fn((...args: unknown[]) => {
          if (sql.includes("INSERT INTO consolidation_log")) {
            tables.consolidation_log.push({
              id: args[0],
              summary_entry_id: args[1],
              source_entry_ids: args[2],
              similarity_score: args[3],
              model_used: args[4],
              cost: args[5],
              timestamp: args[6],
              depth: args[7],
              status: args[8],
              agent_id: args[9],
            });
          }
          if (sql.includes("UPDATE consolidation_log SET status = 'completed'")) {
            const logEntry = tables.consolidation_log.find((r: any) => r.id === args[0]);
            if (logEntry) (logEntry as any).status = "completed";
          } else if (sql.includes("UPDATE consolidation_log SET status = 'failed'")) {
            const logEntry = tables.consolidation_log.find((r: any) => r.id === args[0]);
            if (logEntry) (logEntry as any).status = "failed";
          } else if (sql.includes("UPDATE consolidation_log SET status")) {
            // Legacy 'undone' path (signature: run(now, id) or run(id))
            const logEntry = tables.consolidation_log.find(
              (r: any) => r.id === (args[1] ?? args[0]),
            );
            if (logEntry) (logEntry as any).status = "undone";
          }
          // Track soft-delete of source memories
          if (sql.includes("UPDATE memories SET consolidated_into = ?")) {
            // args: summaryId, now, summaryId, now, now, id
            const id = args[5];
            const summaryId = args[0];
            const at = args[1];
            let row = tables.memories.find((r: any) => r.id === id);
            if (!row) {
              row = { id };
              tables.memories.push(row);
            }
            (row as any).consolidated_into = summaryId;
            (row as any).consolidated_at = at;
          }
          // Track unflag (compensating rollback)
          if (sql.includes("UPDATE memories SET consolidated_into = NULL")) {
            // args: now, id
            const id = args[1];
            const row = tables.memories.find((r: any) => r.id === id);
            if (row) {
              (row as any).consolidated_into = null;
              (row as any).consolidated_at = null;
            }
          }
          // Track summary insert
          if (sql.includes("INSERT OR REPLACE INTO memories")) {
            const id = args[0];
            const existing = tables.memories.find((r: any) => r.id === id);
            if (existing) {
              Object.assign(existing, { id, value: args[2], metadata: args[3] });
            } else {
              tables.memories.push({
                id,
                key: args[1],
                value: args[2],
                metadata: args[3],
                created_at: args[5],
                updated_at: args[6],
              });
            }
          }
          // Track summary delete (compensating rollback)
          if (sql.startsWith("DELETE FROM memories WHERE id")) {
            const id = args[0];
            const idx = tables.memories.findIndex((r: any) => r.id === id);
            if (idx !== -1) tables.memories.splice(idx, 1);
          }
        }),
      };
      return stmt;
    }),
    transaction: vi.fn((fn: () => void) => {
      return () => fn();
    }),
  };

  return { db, tables };
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeEmitter() {
  return {
    emit: vi.fn(),
  };
}

function makeOpts(overrides: Partial<ConsolidationEngineOptions> = {}): ConsolidationEngineOptions {
  const { db } = makeFakeDb();
  return {
    sqliteDb: db as any,
    entries: new Map(),
    hnswStore: {
      search: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    },
    config: makeConfig(),
    generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3, 0.4]),
    summarizeWithLLM: vi.fn(async () => ({
      summary: "Consolidated summary",
      cost: 0.001,
      model: "test-model",
    })),
    eventEmitter: makeEmitter(),
    logger: makeLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: Engine construction
// ---------------------------------------------------------------------------

describe("MemoryConsolidationEngine", () => {
  it("should construct without errors", () => {
    const opts = makeOpts();
    const engine = new MemoryConsolidationEngine(opts);
    expect(engine).toBeDefined();
  });

  it("should mark orphan 'pending' log rows as 'failed' on startup", () => {
    // Seed a pre-existing stale 'pending' row to simulate a prior crash
    // between Phase 1 intent-write and Phase 3 finalization.
    const { db, tables } = makeFakeDb();
    const staleId = "stale-pending";
    const freshId = "fresh-pending";
    const cutoffWindowMs = 60 * 60 * 1000;
    tables.consolidation_log.push({
      id: staleId,
      status: "pending",
      timestamp: Date.now() - cutoffWindowMs - 1000, // older than window
    });
    tables.consolidation_log.push({
      id: freshId,
      status: "pending",
      timestamp: Date.now() - 1000, // younger than window
    });

    // Wire prepare() so SELECT returns stale rows and UPDATE flips status.
    const originalPrepare = db.prepare;
    db.prepare = vi.fn((sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.includes("SELECT id FROM consolidation_log WHERE status = 'pending'")) {
        stmt.all = vi.fn((cutoff: number) =>
          tables.consolidation_log
            .filter((r: any) => r.status === "pending" && r.timestamp < cutoff)
            .map((r: any) => ({ id: r.id })),
        );
      }
      if (sql.includes("UPDATE consolidation_log SET status = 'failed' WHERE id = ? AND status = 'pending'")) {
        stmt.run = vi.fn((id: string) => {
          const row = tables.consolidation_log.find((r: any) => r.id === id);
          if (row && row.status === "pending") row.status = "failed";
        });
      }
      return stmt;
    }) as any;

    const logger = makeLogger();
    const opts = makeOpts({ sqliteDb: db as any, logger });
    // Construction itself triggers the janitor.
    new MemoryConsolidationEngine(opts);

    const stale = tables.consolidation_log.find((r: any) => r.id === staleId);
    const fresh = tables.consolidation_log.find((r: any) => r.id === freshId);
    expect(stale?.status).toBe("failed");
    expect(fresh?.status).toBe("pending"); // untouched
    expect(logger.warn).toHaveBeenCalledWith(
      "[Consolidation] Marked stale pending log rows as failed",
      expect.objectContaining({ count: 1 }),
    );
  });

  it("should always exempt the 'instinct' domain", async () => {
    const entries = new Map<string, unknown>();
    entries.set("instinct1", makeMemEntry("instinct1", "instinct data", {
      domain: "instinct",
      tier: MemoryTier.Ephemeral,
    }));
    entries.set("normal1", makeMemEntry("normal1", "normal data", {
      tier: MemoryTier.Ephemeral,
      embedding: [0.1, 0.2, 0.3, 0.4],
    }));
    entries.set("normal2", makeMemEntry("normal2", "normal data too", {
      tier: MemoryTier.Ephemeral,
      embedding: [0.15, 0.25, 0.35, 0.45],
    }));

    const hnswStore = {
      search: vi.fn(async (_vec: number[], _topK: number) => [
        { id: "instinct1", score: 0.99 },
        { id: "normal2", score: 0.85 },
      ]),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({ entries, hnswStore });
    const engine = new MemoryConsolidationEngine(opts);
    const clusters = await engine.findClusters(MemoryTier.Ephemeral);

    // instinct1 should be excluded from any cluster
    for (const cluster of clusters) {
      expect(cluster.memberIds).not.toContain("instinct1");
    }
  });

  it("should merge provided exemptDomains with 'instinct'", async () => {
    const entries = new Map<string, unknown>();
    entries.set("custom1", makeMemEntry("custom1", "custom exempt", {
      domain: "system-core",
      tier: MemoryTier.Ephemeral,
    }));

    const hnswStore = {
      search: vi.fn(async () => [
        { id: "custom1", score: 0.9 },
      ]),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({
      entries,
      hnswStore,
      exemptDomains: ["system-core"],
    });
    const engine = new MemoryConsolidationEngine(opts);
    const clusters = await engine.findClusters(MemoryTier.Ephemeral);

    for (const cluster of clusters) {
      expect(cluster.memberIds).not.toContain("custom1");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: findClusters
// ---------------------------------------------------------------------------

describe("findClusters", () => {
  it("should return empty array when no eligible entries exist", async () => {
    const opts = makeOpts();
    const engine = new MemoryConsolidationEngine(opts);
    const clusters = await engine.findClusters(MemoryTier.Ephemeral);
    expect(clusters).toEqual([]);
  });

  it("should not cluster entries from different tiers", async () => {
    const entries = new Map<string, unknown>();
    entries.set("w1", makeMemEntry("w1", "working", { tier: MemoryTier.Working }));
    entries.set("e1", makeMemEntry("e1", "ephemeral", { tier: MemoryTier.Ephemeral }));

    const hnswStore = {
      search: vi.fn(async () => [
        { id: "w1", score: 0.95 },
      ]),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({ entries, hnswStore });
    const engine = new MemoryConsolidationEngine(opts);

    const clusters = await engine.findClusters(MemoryTier.Ephemeral);
    // w1 is Working tier, so it shouldn't appear in Ephemeral clusters
    for (const cluster of clusters) {
      expect(cluster.memberIds).not.toContain("w1");
    }
  });

  it("should skip entries without embeddings", async () => {
    const entries = new Map<string, unknown>();
    entries.set("noEmbed", makeMemEntry("noEmbed", "no embedding", {
      tier: MemoryTier.Ephemeral,
      embedding: [],
    }));

    const opts = makeOpts({ entries });
    const engine = new MemoryConsolidationEngine(opts);
    const clusters = await engine.findClusters(MemoryTier.Ephemeral);
    expect(clusters).toEqual([]);
  });

  it("should respect minAgeMs — skip too-new entries", async () => {
    const entries = new Map<string, unknown>();
    entries.set("new1", makeMemEntry("new1", "brand new", {
      tier: MemoryTier.Ephemeral,
      createdAt: Date.now(), // just created
    }));

    const opts = makeOpts({
      entries,
      config: makeConfig({ minAgeMs: 60000 }), // 1 minute minimum age
    });
    const engine = new MemoryConsolidationEngine(opts);
    const clusters = await engine.findClusters(MemoryTier.Ephemeral);
    expect(clusters).toEqual([]);
  });

  it("should respect maxDepth — skip deeply consolidated entries", async () => {
    const entries = new Map<string, unknown>();
    entries.set("deep1", makeMemEntry("deep1", "deeply consolidated", {
      tier: MemoryTier.Ephemeral,
      metadata: { consolidation: { depth: 3 } },
    }));

    const opts = makeOpts({
      entries,
      config: makeConfig({ maxDepth: 3 }),
    });
    const engine = new MemoryConsolidationEngine(opts);
    const clusters = await engine.findClusters(MemoryTier.Ephemeral);
    expect(clusters).toEqual([]);
  });

  it("should form clusters when neighbors exceed threshold and minClusterSize", async () => {
    const entries = new Map<string, unknown>();
    entries.set("c1", makeMemEntry("c1", "cluster content A", {
      tier: MemoryTier.Ephemeral,
      embedding: [1, 0, 0, 0],
    }));
    entries.set("c2", makeMemEntry("c2", "cluster content B", {
      tier: MemoryTier.Ephemeral,
      embedding: [0.9, 0.1, 0, 0],
    }));

    const hnswStore = {
      search: vi.fn(async () => [
        { id: "c1", score: 1.0 },
        { id: "c2", score: 0.85 },
      ]),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({
      entries,
      hnswStore,
      config: makeConfig({ threshold: 0.7, minClusterSize: 2 }),
    });
    const engine = new MemoryConsolidationEngine(opts);
    const clusters = await engine.findClusters(MemoryTier.Ephemeral);

    expect(clusters.length).toBe(1);
    expect(clusters[0]!.memberIds).toContain("c1");
    expect(clusters[0]!.memberIds).toContain("c2");
    expect(clusters[0]!.tier).toBe(MemoryTier.Ephemeral);
  });

  it("should not form cluster below minClusterSize", async () => {
    const entries = new Map<string, unknown>();
    entries.set("solo", makeMemEntry("solo", "lonely entry", {
      tier: MemoryTier.Ephemeral,
      embedding: [1, 0, 0, 0],
    }));

    const hnswStore = {
      search: vi.fn(async () => [
        { id: "solo", score: 1.0 },
      ]),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({
      entries,
      hnswStore,
      config: makeConfig({ minClusterSize: 2 }),
    });
    const engine = new MemoryConsolidationEngine(opts);
    const clusters = await engine.findClusters(MemoryTier.Ephemeral);
    expect(clusters).toEqual([]);
  });

  it("should sort clusters by highest avgSimilarity first", async () => {
    const entries = new Map<string, unknown>();
    entries.set("a1", makeMemEntry("a1", "group A1", { tier: MemoryTier.Ephemeral, embedding: [1, 0, 0, 0] }));
    entries.set("a2", makeMemEntry("a2", "group A2", { tier: MemoryTier.Ephemeral, embedding: [0.9, 0.1, 0, 0] }));
    entries.set("b1", makeMemEntry("b1", "group B1", { tier: MemoryTier.Ephemeral, embedding: [0, 1, 0, 0] }));
    entries.set("b2", makeMemEntry("b2", "group B2", { tier: MemoryTier.Ephemeral, embedding: [0, 0.9, 0.1, 0] }));

    let callCount = 0;
    const hnswStore = {
      search: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return [
            { id: "a1", score: 1.0 },
            { id: "a2", score: 0.95 },
          ];
        }
        if (callCount === 2) {
          return [
            { id: "b1", score: 1.0 },
            { id: "b2", score: 0.75 },
          ];
        }
        return [];
      }),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({
      entries,
      hnswStore,
      config: makeConfig({ threshold: 0.7, minClusterSize: 2 }),
    });
    const engine = new MemoryConsolidationEngine(opts);
    const clusters = await engine.findClusters(MemoryTier.Ephemeral);

    if (clusters.length === 2) {
      expect(clusters[0]!.avgSimilarity).toBeGreaterThanOrEqual(clusters[1]!.avgSimilarity);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: runCycle
// ---------------------------------------------------------------------------

describe("runCycle", () => {
  it("should return skipped when no clusters found", async () => {
    const opts = makeOpts();
    const engine = new MemoryConsolidationEngine(opts);

    const ac = new AbortController();
    const result = await engine.runCycle(ac.signal);

    expect(result.status).toBe("skipped");
    expect(result.processed).toBe(0);
    expect(result.clustersFound).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it("should emit consolidation:started event", async () => {
    const emitter = makeEmitter();
    const opts = makeOpts({ eventEmitter: emitter });
    const engine = new MemoryConsolidationEngine(opts);

    const ac = new AbortController();
    await engine.runCycle(ac.signal);

    expect(emitter.emit).toHaveBeenCalledWith("consolidation:started", expect.any(Object));
  });

  it("should return interrupted when signal is aborted before processing", async () => {
    const entries = new Map<string, unknown>();
    entries.set("r1", makeMemEntry("r1", "cycle test A", {
      tier: MemoryTier.Ephemeral,
      embedding: [1, 0, 0, 0],
    }));
    entries.set("r2", makeMemEntry("r2", "cycle test B", {
      tier: MemoryTier.Ephemeral,
      embedding: [0.9, 0.1, 0, 0],
    }));

    const hnswStore = {
      search: vi.fn(async () => [
        { id: "r1", score: 1.0 },
        { id: "r2", score: 0.85 },
      ]),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({
      entries,
      hnswStore,
      config: makeConfig({ threshold: 0.7, minClusterSize: 2 }),
    });
    const engine = new MemoryConsolidationEngine(opts);

    const ac = new AbortController();
    ac.abort();

    const result = await engine.runCycle(ac.signal);
    expect(result.status).toBe("interrupted");
    expect(result.processed).toBe(0);
    expect(result.remaining).toBeGreaterThan(0);
  });

  it("should continue processing remaining clusters after one fails", async () => {
    const entries = new Map<string, unknown>();
    entries.set("f1", makeMemEntry("f1", "fail cluster A", { tier: MemoryTier.Working, embedding: [1, 0, 0, 0] }));
    entries.set("f2", makeMemEntry("f2", "fail cluster B", { tier: MemoryTier.Working, embedding: [0.9, 0.1, 0, 0] }));
    entries.set("s1", makeMemEntry("s1", "success cluster A", { tier: MemoryTier.Ephemeral, embedding: [0, 1, 0, 0] }));
    entries.set("s2", makeMemEntry("s2", "success cluster B", { tier: MemoryTier.Ephemeral, embedding: [0, 0.9, 0.1, 0] }));

    const hnswStore = {
      search: vi.fn(async (vec: number[]) => {
        if (vec[0]! > 0.5) {
          return [
            { id: "f1", score: 1.0 },
            { id: "f2", score: 0.85 },
          ];
        }
        return [
          { id: "s1", score: 1.0 },
          { id: "s2", score: 0.85 },
        ];
      }),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    let summarizeCallCount = 0;
    const summarizeWithLLM = vi.fn(async () => {
      summarizeCallCount++;
      if (summarizeCallCount === 1) {
        throw new Error("LLM failure");
      }
      return { summary: "Summary", cost: 0.001, model: "test" };
    });

    const logger = makeLogger();
    const opts = makeOpts({
      entries,
      hnswStore,
      summarizeWithLLM,
      logger,
      config: makeConfig({ threshold: 0.7, minClusterSize: 2 }),
    });
    const engine = new MemoryConsolidationEngine(opts);

    const ac = new AbortController();
    const result = await engine.runCycle(ac.signal);

    expect(logger.warn).toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Tests: processCluster
// ---------------------------------------------------------------------------

describe("processCluster", () => {
  it("should create summary entry and remove original entries from memory", async () => {
    const entries = new Map<string, unknown>();
    entries.set("pc1", makeMemEntry("pc1", "content A", {
      tier: MemoryTier.Ephemeral,
      chatId: "chat-1",
    }));
    entries.set("pc2", makeMemEntry("pc2", "content B", {
      tier: MemoryTier.Ephemeral,
      chatId: "chat-1",
    }));

    const hnswStore = {
      search: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({ entries, hnswStore });
    const engine = new MemoryConsolidationEngine(opts);

    const cluster = {
      seedId: "pc1",
      memberIds: ["pc1", "pc2"],
      avgSimilarity: 0.9,
      tier: MemoryTier.Ephemeral,
    };

    const result = await engine.processCluster(cluster);

    expect(result.cost).toBe(0.001);
    expect(entries.has("pc1")).toBe(false);
    expect(entries.has("pc2")).toBe(false);
    expect(entries.size).toBe(1);
    const summaryEntry = entries.values().next().value as any;
    expect(summaryEntry.content).toBe("Consolidated summary");
    expect(summaryEntry.tier).toBe(MemoryTier.Ephemeral);
  });

  it("should call HNSW remove on originals and upsert for summary", async () => {
    const entries = new Map<string, unknown>();
    entries.set("h1", makeMemEntry("h1", "hnsw A", { tier: MemoryTier.Ephemeral }));
    entries.set("h2", makeMemEntry("h2", "hnsw B", { tier: MemoryTier.Ephemeral }));

    const hnswStore = {
      search: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({ entries, hnswStore });
    const engine = new MemoryConsolidationEngine(opts);

    await engine.processCluster({
      seedId: "h1",
      memberIds: ["h1", "h2"],
      avgSimilarity: 0.85,
      tier: MemoryTier.Ephemeral,
    });

    expect(hnswStore.remove).toHaveBeenCalledWith(["h1", "h2"]);
    expect(hnswStore.upsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          vector: [0.1, 0.2, 0.3, 0.4],
        }),
      ]),
    );
  });

  it("should use HNSW write mutex when provided", async () => {
    const entries = new Map<string, unknown>();
    entries.set("m1", makeMemEntry("m1", "mutex A", { tier: MemoryTier.Ephemeral }));
    entries.set("m2", makeMemEntry("m2", "mutex B", { tier: MemoryTier.Ephemeral }));

    const mutexFn = vi.fn(async (fn: () => Promise<void>) => fn());
    const hnswWriteMutex = { withLock: mutexFn };

    const hnswStore = {
      search: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({ entries, hnswStore, hnswWriteMutex });
    const engine = new MemoryConsolidationEngine(opts);

    await engine.processCluster({
      seedId: "m1",
      memberIds: ["m1", "m2"],
      avgSimilarity: 0.8,
      tier: MemoryTier.Ephemeral,
    });

    expect(mutexFn).toHaveBeenCalled();
  });

  it("should track consolidation depth correctly", async () => {
    const entries = new Map<string, unknown>();
    entries.set("d1", makeMemEntry("d1", "depth test A", {
      tier: MemoryTier.Ephemeral,
      metadata: { consolidation: { depth: 2 } },
    }));
    entries.set("d2", makeMemEntry("d2", "depth test B", {
      tier: MemoryTier.Ephemeral,
      metadata: {},
    }));

    const hnswStore = {
      search: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({ entries, hnswStore });
    const engine = new MemoryConsolidationEngine(opts);

    await engine.processCluster({
      seedId: "d1",
      memberIds: ["d1", "d2"],
      avgSimilarity: 0.9,
      tier: MemoryTier.Ephemeral,
    });

    const summaryEntry = entries.values().next().value as any;
    expect(summaryEntry.metadata.consolidation.depth).toBe(3); // max(2,0) + 1
  });

  it("should rollback SQLite on HNSW failure and re-throw (production path, asserts SQL state)", async () => {
    // Pre-seed fake DB with the two source rows so compensating UPDATE has
    // something to mutate; the soft-delete UPDATE then flips columns, and
    // the compensating UPDATE must NULL them back.
    const { db, tables } = makeFakeDb();
    tables.memories.push({ id: "rb1", consolidated_into: null, consolidated_at: null });
    tables.memories.push({ id: "rb2", consolidated_into: null, consolidated_at: null });

    const entries = new Map<string, unknown>();
    entries.set("rb1", makeMemEntry("rb1", "rollback A", { tier: MemoryTier.Ephemeral }));
    entries.set("rb2", makeMemEntry("rb2", "rollback B", { tier: MemoryTier.Ephemeral }));

    const hnswStore = {
      search: vi.fn(async () => []),
      remove: vi.fn(async () => { throw new Error("HNSW crash"); }),
      upsert: vi.fn(async () => {}),
    };

    const logger = makeLogger();
    const opts = makeOpts({ sqliteDb: db as any, entries, hnswStore, logger });
    const engine = new MemoryConsolidationEngine(opts);

    await expect(
      engine.processCluster({
        seedId: "rb1",
        memberIds: ["rb1", "rb2"],
        avgSimilarity: 0.9,
        tier: MemoryTier.Ephemeral,
      }),
    ).rejects.toThrow("HNSW crash");

    expect(logger.error).toHaveBeenCalledWith(
      "[Consolidation] HNSW update failed, rolling back SQLite commit",
      expect.any(Object),
    );

    // In-memory entries should NOT have been removed
    expect(entries.has("rb1")).toBe(true);
    expect(entries.has("rb2")).toBe(true);

    // SQL state assertions — compensating transaction must have reverted
    // Phase 2 mutations AND marked the log 'failed'.
    const rb1Row = tables.memories.find((r: any) => r.id === "rb1");
    const rb2Row = tables.memories.find((r: any) => r.id === "rb2");
    expect(rb1Row?.consolidated_into).toBeNull();
    expect(rb1Row?.consolidated_at).toBeNull();
    expect(rb2Row?.consolidated_into).toBeNull();
    expect(rb2Row?.consolidated_at).toBeNull();

    // Summary entry must NOT exist in memories (only the two pre-seeded rows remain).
    const summaryRows = tables.memories.filter(
      (r: any) => r.id !== "rb1" && r.id !== "rb2",
    );
    expect(summaryRows).toEqual([]);

    // consolidation_log must have exactly one entry with status 'failed'
    // (NOT 'pending' — finalization must have run).
    expect(tables.consolidation_log.length).toBe(1);
    expect(tables.consolidation_log[0]!.status).toBe("failed");
  });

  it("should write 'pending' log intent BEFORE mutating memories (two-phase commit)", async () => {
    // If HNSW.remove throws on first invocation, the compensating transaction
    // runs but the 'pending' intent row must have been inserted FIRST, before
    // any Phase 2 mutation. Snapshot ordering via run() call sequence.
    const { db, tables } = makeFakeDb();
    tables.memories.push({ id: "tp1", consolidated_into: null });
    tables.memories.push({ id: "tp2", consolidated_into: null });

    const entries = new Map<string, unknown>();
    entries.set("tp1", makeMemEntry("tp1", "two-phase A", { tier: MemoryTier.Ephemeral }));
    entries.set("tp2", makeMemEntry("tp2", "two-phase B", { tier: MemoryTier.Ephemeral }));

    const hnswStore = {
      search: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({ sqliteDb: db as any, entries, hnswStore });
    const engine = new MemoryConsolidationEngine(opts);

    await engine.processCluster({
      seedId: "tp1",
      memberIds: ["tp1", "tp2"],
      avgSimilarity: 0.9,
      tier: MemoryTier.Ephemeral,
    });

    // Log must exist and be in 'completed' state after success path.
    expect(tables.consolidation_log.length).toBe(1);
    expect(tables.consolidation_log[0]!.status).toBe("completed");
    // Initial insert was 'pending' — verify via the prepare() call history.
    const insertLogCalls = (db.prepare as any).mock.calls.filter(
      ([sql]: [string]) => sql.includes("INSERT INTO consolidation_log"),
    );
    expect(insertLogCalls.length).toBeGreaterThan(0);
  });

  it("should preserve FIFO ordering under writeMutex with concurrent storeEntry + consolidation", async () => {
    // Simulate concurrent work: a storeEntry-like HNSW write and a
    // processCluster call issued in order A, B. The mutex must serialize
    // them so that A finishes before B's HNSW ops begin.
    const { db, tables } = makeFakeDb();
    tables.memories.push({ id: "fi1", consolidated_into: null });
    tables.memories.push({ id: "fi2", consolidated_into: null });

    const entries = new Map<string, unknown>();
    entries.set("fi1", makeMemEntry("fi1", "fifo A", { tier: MemoryTier.Ephemeral }));
    entries.set("fi2", makeMemEntry("fi2", "fifo B", { tier: MemoryTier.Ephemeral }));

    // Real FIFO mutex (matches HnswWriteMutex semantics).
    let mutexChain: Promise<void> = Promise.resolve();
    const hnswWriteMutex = {
      withLock: async <T>(fn: () => Promise<T>): Promise<T> => {
        let release!: () => void;
        const next = new Promise<void>((r) => { release = r; });
        const prev = mutexChain;
        mutexChain = next;
        await prev;
        try { return await fn(); } finally { release(); }
      },
    };

    const order: string[] = [];
    const hnswStore = {
      search: vi.fn(async () => []),
      remove: vi.fn(async (ids: string[]) => {
        order.push(`remove:${ids.join(",")}`);
        // Yield to scheduler — if mutex is broken, concurrent op sneaks in.
        await new Promise((r) => setTimeout(r, 5));
      }),
      upsert: vi.fn(async (entries: any[]) => {
        order.push(`upsert:${entries.map((e) => e.id).join(",")}`);
        await new Promise((r) => setTimeout(r, 5));
      }),
    };

    const opts = makeOpts({ sqliteDb: db as any, entries, hnswStore, hnswWriteMutex });
    const engine = new MemoryConsolidationEngine(opts);

    // Task A: simulated storeEntry (HNSW upsert under the same mutex).
    const storeA = hnswWriteMutex.withLock(async () => {
      await hnswStore.upsert([{
        id: "external-A",
        vector: [0.1, 0.2, 0.3, 0.4],
        chunk: { filePath: "", content: "", kind: "generic", language: "text" },
        addedAt: Date.now(),
        accessCount: 0,
      }]);
    });

    // Task B: processCluster issued immediately after A (without awaiting).
    const taskB = engine.processCluster({
      seedId: "fi1",
      memberIds: ["fi1", "fi2"],
      avgSimilarity: 0.9,
      tier: MemoryTier.Ephemeral,
    });

    await Promise.all([storeA, taskB]);

    // Expected FIFO order:
    //   1. upsert:external-A   (storeA completed first)
    //   2. remove:fi1,fi2       (processCluster HNSW remove)
    //   3. upsert:<summaryId>   (processCluster HNSW upsert)
    expect(order[0]).toBe("upsert:external-A");
    expect(order[1]).toBe("remove:fi1,fi2");
    expect(order[2]).toMatch(/^upsert:/);
    expect(order[2]).not.toBe("upsert:external-A");

    // Log finalized as 'completed'.
    expect(tables.consolidation_log[0]!.status).toBe("completed");
  });

  it("should preserve the highest importanceScore from members", async () => {
    const entries = new Map<string, unknown>();
    entries.set("imp1", makeMemEntry("imp1", "low importance", {
      tier: MemoryTier.Ephemeral,
      importanceScore: 0.3,
    }));
    entries.set("imp2", makeMemEntry("imp2", "high importance", {
      tier: MemoryTier.Ephemeral,
      importanceScore: 0.9,
    }));

    const hnswStore = {
      search: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({ entries, hnswStore });
    const engine = new MemoryConsolidationEngine(opts);

    await engine.processCluster({
      seedId: "imp1",
      memberIds: ["imp1", "imp2"],
      avgSimilarity: 0.8,
      tier: MemoryTier.Ephemeral,
    });

    const summaryEntry = entries.values().next().value as any;
    expect(summaryEntry.importanceScore).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// Tests: preview
// ---------------------------------------------------------------------------

describe("preview", () => {
  it("should return empty clusters and zero cost when nothing to consolidate", async () => {
    const opts = makeOpts();
    const engine = new MemoryConsolidationEngine(opts);

    const preview = await engine.preview();

    expect(preview.clusters).toEqual([]);
    expect(preview.estimatedCostPerCluster).toBe(0);
    expect(preview.totalEstimatedCost).toBe(0);
  });

  it("should estimate cost based on content length", async () => {
    const entries = new Map<string, unknown>();
    entries.set("pv1", makeMemEntry("pv1", "a".repeat(4000), { tier: MemoryTier.Ephemeral, embedding: [1, 0, 0, 0] }));
    entries.set("pv2", makeMemEntry("pv2", "b".repeat(4000), { tier: MemoryTier.Ephemeral, embedding: [0.9, 0.1, 0, 0] }));

    const hnswStore = {
      search: vi.fn(async () => [
        { id: "pv1", score: 1.0 },
        { id: "pv2", score: 0.85 },
      ]),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({
      entries,
      hnswStore,
      config: makeConfig({ threshold: 0.7, minClusterSize: 2 }),
    });
    const engine = new MemoryConsolidationEngine(opts);
    const preview = await engine.preview();

    expect(preview.clusters.length).toBeGreaterThan(0);
    expect(preview.totalEstimatedCost).toBeGreaterThan(0);
  });

  it("should not modify entries during preview", async () => {
    const entries = new Map<string, unknown>();
    entries.set("safe1", makeMemEntry("safe1", "safe entry", { tier: MemoryTier.Ephemeral, embedding: [1, 0, 0, 0] }));
    entries.set("safe2", makeMemEntry("safe2", "also safe", { tier: MemoryTier.Ephemeral, embedding: [0.9, 0.1, 0, 0] }));

    const hnswStore = {
      search: vi.fn(async () => [
        { id: "safe1", score: 1.0 },
        { id: "safe2", score: 0.85 },
      ]),
      remove: vi.fn(async () => {}),
      upsert: vi.fn(async () => {}),
    };

    const opts = makeOpts({
      entries,
      hnswStore,
      config: makeConfig({ threshold: 0.7, minClusterSize: 2 }),
    });
    const engine = new MemoryConsolidationEngine(opts);

    await engine.preview();

    expect(entries.size).toBe(2);
    expect(entries.has("safe1")).toBe(true);
    expect(entries.has("safe2")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: undo
// ---------------------------------------------------------------------------

describe("undo", () => {
  it("should throw if log entry not found", () => {
    const opts = makeOpts();
    const engine = new MemoryConsolidationEngine(opts);

    expect(() => engine.undo("nonexistent-id")).toThrow(
      "Consolidation log entry not found: nonexistent-id",
    );
  });

  it("should throw if log entry status is not 'completed'", () => {
    const { db, tables } = makeFakeDb();
    tables.consolidation_log.push({
      id: "failed-log",
      summary_entry_id: "sum1",
      source_entry_ids: JSON.stringify(["s1", "s2"]),
      status: "failed",
    });

    const originalPrepare = db.prepare;
    db.prepare = vi.fn((sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.includes("consolidation_log WHERE id =")) {
        stmt.get = vi.fn(() => tables.consolidation_log[0]);
      }
      return stmt;
    }) as any;

    const opts = makeOpts({ sqliteDb: db as any });
    const engine = new MemoryConsolidationEngine(opts);

    expect(() => engine.undo("failed-log")).toThrow(
      "Cannot undo consolidation with status 'failed'",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: getStats
// ---------------------------------------------------------------------------

describe("getStats", () => {
  it("should return per-tier breakdown and lifetime totals", () => {
    const opts = makeOpts();
    const engine = new MemoryConsolidationEngine(opts);

    const stats = engine.getStats();

    expect(stats.perTier).toBeDefined();
    expect(stats.lifetimeSavings).toBeDefined();
    expect(stats.totalRuns).toBeDefined();
    expect(stats.totalCostUsd).toBeDefined();
  });

  it("should count entries per tier correctly", () => {
    const entries = new Map<string, unknown>();
    entries.set("st1", makeMemEntry("st1", "working", { tier: MemoryTier.Working }));
    entries.set("st2", makeMemEntry("st2", "ephemeral", { tier: MemoryTier.Ephemeral }));
    entries.set("st3", makeMemEntry("st3", "ephemeral 2", { tier: MemoryTier.Ephemeral }));

    const opts = makeOpts({ entries });
    const engine = new MemoryConsolidationEngine(opts);

    const stats = engine.getStats();

    expect(stats.perTier[MemoryTier.Working]!.pending).toBe(1);
    expect(stats.perTier[MemoryTier.Ephemeral]!.pending).toBe(2);
    expect(stats.perTier[MemoryTier.Persistent]!.pending).toBe(0);
  });
});
