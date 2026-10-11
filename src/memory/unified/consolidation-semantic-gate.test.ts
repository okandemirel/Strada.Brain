/**
 * Consolidation clusters only on vectors whose similarity means something
 * (audit memory-rag#2).
 *
 * With no embedding provider every AgentDB vector is a character histogram.
 * Its cosine measures text length and character range, not meaning: unrelated
 * sentences of similar length score 0.83-0.95, above the 0.85 default
 * threshold. Consolidation then merged unrelated memories into one LLM summary
 * and soft-deleted the originals. These tests drive the real AgentDBMemory and
 * the real engine with the production defaults (threshold 0.85, minClusterSize
 * 2, batchSize 50, 1536 dimensions).
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createLogger } from "../../utils/logger.js";
import { AgentDBMemory } from "./agentdb-memory.js";
import { MemoryConsolidationEngine } from "./consolidation-engine.js";
import { MemoryTier, HISTOGRAM_PROVENANCE } from "./unified-memory.interface.js";
import type { UnifiedMemoryConfig } from "./unified-memory.interface.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const DIMENSIONS = 1536;

// Unrelated facts of similar length — the shape that clusters on histograms.
const UNRELATED = [
  "User prefers dark theme in every editor window",
  "Boss fight music loop should crossfade at 2 min",
  "Player jump height is 2.5 units on all levels",
  "Android keystore expired; renew before release",
];

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function memoryConfig(dbPath: string, extra: Partial<UnifiedMemoryConfig> = {}): Partial<UnifiedMemoryConfig> {
  return {
    dbPath,
    dimensions: DIMENSIONS,
    maxEntriesPerTier: {
      [MemoryTier.Working]: 100,
      [MemoryTier.Ephemeral]: 1000,
      [MemoryTier.Persistent]: 10000,
    },
    hnswParams: { efConstruction: 50, M: 8, efSearch: 32 },
    quantizationType: "none",
    cacheSize: 100,
    enableAutoTiering: false,
    ...extra,
  };
}

function engineFor(
  memory: AgentDBMemory,
  summaries: string[][],
  generateEmbedding: (text: string) => Promise<number[]>,
): MemoryConsolidationEngine {
  const internals = memory.getConsolidationInternals();
  return new MemoryConsolidationEngine({
    sqliteDb: internals.sqliteDb!,
    entries: internals.entries as unknown as Map<string, unknown>,
    hnswStore: internals.hnswStore,
    hnswWriteMutex: internals.hnswWriteMutex,
    textIndex: internals.textIndex,
    // Production defaults (config-schema), minus the 1 h minimum age.
    config: {
      enabled: true, idleMinutes: 5, threshold: 0.85, batchSize: 50,
      minClusterSize: 2, maxDepth: 3, modelTier: "cheap", minAgeMs: 0,
    },
    generateEmbedding,
    summarizeWithLLM: async (contents) => {
      summaries.push(contents);
      return { summary: contents.join(" / "), cost: 0, model: "test" };
    },
    eventEmitter: { emit: () => {} },
    logger: quiet,
  });
}

describe("consolidation without an embedding provider (memory-rag#2)", () => {
  const dirs: string[] = [];
  const open: AgentDBMemory[] = [];

  afterEach(async () => {
    for (const m of open.splice(0)) await m.shutdown();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("does not cluster unrelated memories whose only likeness is a character histogram", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consolidation-gate-"));
    dirs.push(dir);
    const memory = new AgentDBMemory(memoryConfig(dir));
    open.push(memory);
    expect((await memory.initialize()).kind).toBe("ok");

    const ids: string[] = [];
    for (const text of UNRELATED) {
      const entry = await memory.storeNote(text, [], MemoryTier.Persistent, { chatId: "c1" as never });
      ids.push(entry.id as string);
    }
    const internals = memory.getConsolidationInternals();
    for (const id of ids) {
      expect((internals.entries.get(id) as { embeddingProvenance?: string }).embeddingProvenance).toBe(HISTOGRAM_PROVENANCE);
    }

    const summaries: string[][] = [];
    // What the bootstrap wiring used to hand the engine without a provider: a
    // vector that exists, so nothing downstream refused the merge.
    const engine = engineFor(memory, summaries, async () =>
      Array.from({ length: DIMENSIONS }, (_, i) => (i % 7) / 7 - 0.5));

    const result = await engine.runCycle(new AbortController().signal);

    expect(summaries).toEqual([]);
    expect(result.processed).toBe(0);
    const merged = internals.sqliteDb!
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE consolidated_into IS NOT NULL")
      .get() as { n: number };
    expect(merged.n).toBe(0);
    for (const id of ids) expect(internals.entries.has(id)).toBe(true);
    expect(await engine.findClusters(MemoryTier.Persistent)).toEqual([]);
  });
});

describe("consolidation with an embedding provider", () => {
  const dirs: string[] = [];
  const open: AgentDBMemory[] = [];

  afterEach(async () => {
    for (const m of open.splice(0)) await m.shutdown();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // A toy semantic embedder: one axis per topic, so related notes are near
  // and unrelated ones orthogonal whatever their length.
  const TOPIC_DIMENSIONS = 8;
  const embed = async (text: string): Promise<number[]> => {
    const v = new Array<number>(TOPIC_DIMENSIONS).fill(0.01);
    v[/health|regen/i.test(text) ? 0 : 1] = 1;
    return v;
  };
  const providerConfig = (dir: string) => memoryConfig(dir, {
    dimensions: TOPIC_DIMENSIONS,
    embeddingProvider: embed,
    embeddingProviderId: "toy-embedder:8d",
  });

  it("still merges related memories, and the summary keeps the provider's provenance across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consolidation-gate-"));
    dirs.push(dir);
    const memory = new AgentDBMemory(providerConfig(dir));
    open.push(memory);
    expect((await memory.initialize()).kind).toBe("ok");

    await memory.storeNote("Player health regenerates slowly", [], MemoryTier.Persistent, { chatId: "c1" as never });
    await memory.storeNote("Health regen for the player is slow", [], MemoryTier.Persistent, { chatId: "c1" as never });
    const other = await memory.storeNote("Android keystore expired", [], MemoryTier.Persistent, { chatId: "c1" as never });

    const summaries: string[][] = [];
    const engine = engineFor(memory, summaries, embed);
    const result = await engine.runCycle(new AbortController().signal);

    expect(result.processed).toBe(1);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.every((c) => /health|regen/i.test(c))).toBe(true);
    const internals = memory.getConsolidationInternals();
    expect(internals.entries.has(other.id as string)).toBe(true);
    const summary = [...internals.entries.values()].find((e) => e.metadata?.["consolidation"] !== undefined);
    expect(summary).toBeDefined();
    // Unstamped, the summary was read back as "unknown" after a restart and
    // kept out of vector search and of the next consolidation pass.
    expect(summary!.embeddingProvenance).toBe("toy-embedder:8d");
    const summaryId = summary!.id as string;

    await memory.shutdown();
    open.splice(open.indexOf(memory), 1);
    const reopened = new AgentDBMemory(providerConfig(dir));
    open.push(reopened);
    expect((await reopened.initialize()).kind).toBe("ok");
    expect(reopened.getConsolidationInternals().entries.get(summaryId)?.embeddingProvenance).toBe("toy-embedder:8d");
  });
});

describe("merges made on histogram vectors before the gate (memory-rag#2)", () => {
  const dirs: string[] = [];
  const open: AgentDBMemory[] = [];

  afterEach(async () => {
    for (const m of open.splice(0)) await m.shutdown();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // The SHA-256 stand-in the bootstrap wiring used without a provider: noise
  // with negative components, so the summary row is not histogram-shaped and
  // carries no provenance — it loads back as "unknown".
  const standIn = async (text: string): Promise<number[]> =>
    Array.from({ length: DIMENSIONS }, (_, i) => Math.sin(text.length * 31 + i));

  it("lists them newest first for undo, changes nothing by listing, and the listed undo order restores every original", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consolidation-gate-"));
    dirs.push(dir);
    const memory = new AgentDBMemory(memoryConfig(dir));
    open.push(memory);
    expect((await memory.initialize()).kind).toBe("ok");
    const ids: string[] = [];
    for (const text of UNRELATED) {
      ids.push((await memory.storeNote(text, [], MemoryTier.Persistent, { chatId: "c1" as never })).id as string);
    }
    const untouched = (await memory.storeNote("Release notes go out on Fridays", [], MemoryTier.Persistent, { chatId: "c1" as never })).id as string;

    // What the engine did before findClusters checked provenance: merge on
    // histogram cosine, then merge the two summaries again (depth 2).
    const engine = engineFor(memory, [], standIn);
    const internals = memory.getConsolidationInternals();
    const db = internals.sqliteDb!;
    const tier = MemoryTier.Persistent;
    await engine.processCluster({ seedId: ids[0]!, memberIds: [ids[0]!, ids[1]!], avgSimilarity: 0.9, tier });
    await engine.processCluster({ seedId: ids[2]!, memberIds: [ids[2]!, ids[3]!], avgSimilarity: 0.88, tier });
    const summaries = (db.prepare("SELECT summary_entry_id AS id FROM consolidation_log ORDER BY rowid").all() as Array<{ id: string }>).map((r) => r.id);
    expect(summaries).toHaveLength(2);
    await engine.processCluster({ seedId: summaries[0]!, memberIds: [summaries[0]!, summaries[1]!], avgSimilarity: 0.86, tier });
    const logs = (db.prepare("SELECT id FROM consolidation_log WHERE status = 'completed' ORDER BY rowid").all() as Array<{ id: string }>).map((r) => r.id);
    expect(logs).toHaveLength(3);
    for (const id of ids) expect(internals.entries.has(id)).toBe(false);

    const snapshot = () => ({
      memories: db.prepare("SELECT id, consolidated_into, value FROM memories ORDER BY id").all(),
      log: db.prepare("SELECT id, status FROM consolidation_log ORDER BY id").all(),
      entries: [...internals.entries.keys()].sort(),
    });
    const before = snapshot();

    const merges = engine.findHistogramMerges();

    // The depth-2 merge is listed although its own sources are summaries: it
    // holds what the histogram merges made, and must be undone first.
    expect(merges.map((m) => m.logId)).toEqual([logs[2], logs[1], logs[0]]);
    expect(merges[2]).toMatchObject({ summaryEntryId: summaries[0], sourceEntryIds: [ids[0], ids[1]] });
    expect(snapshot()).toEqual(before);

    for (const merge of merges) await engine.undo(merge.logId);
    for (const id of [...ids, untouched]) expect(internals.entries.has(id)).toBe(true);
    expect(engine.findHistogramMerges()).toEqual([]);
  });

  it("does not list merges made on provider vectors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consolidation-gate-"));
    dirs.push(dir);
    const embed = async (text: string): Promise<number[]> => {
      const v = new Array<number>(8).fill(-0.01);
      v[/health|regen/i.test(text) ? 0 : 1] = 1;
      return v;
    };
    const memory = new AgentDBMemory(memoryConfig(dir, {
      dimensions: 8, embeddingProvider: embed, embeddingProviderId: "toy-embedder:8d",
    }));
    open.push(memory);
    expect((await memory.initialize()).kind).toBe("ok");
    await memory.storeNote("Player health regenerates slowly", [], MemoryTier.Persistent, { chatId: "c1" as never });
    await memory.storeNote("Health regen for the player is slow", [], MemoryTier.Persistent, { chatId: "c1" as never });

    const engine = engineFor(memory, [], embed);
    expect((await engine.runCycle(new AbortController().signal)).processed).toBe(1);
    expect(engine.findHistogramMerges()).toEqual([]);
  });

  // Consolidation predates provenance stamping, and a soft-deleted original is
  // never reloaded to be stamped, so most real histogram merges carry source
  // rows with no embeddingProvenance at all. Only their vector's shape says
  // what they were merged on; with that branch disabled every other test here
  // still passed and the startup check would report no merges.
  async function mergeUnstamped(
    memory: AgentDBMemory,
    texts: string[],
    embed: (text: string) => Promise<number[]>,
  ): Promise<{ engine: MemoryConsolidationEngine; logId: string; sourceIds: string[] }> {
    const ids: string[] = [];
    for (const text of texts) {
      ids.push((await memory.storeNote(text, [], MemoryTier.Persistent, { chatId: "c1" as never })).id as string);
    }
    const db = memory.getConsolidationInternals().sqliteDb!;
    const strip = db.prepare("UPDATE memories SET value = json_remove(value, '$.embeddingProvenance') WHERE id = ?");
    for (const id of ids) strip.run(id);
    const engine = engineFor(memory, [], embed);
    await engine.processCluster({ seedId: ids[0]!, memberIds: ids, avgSimilarity: 0.9, tier: MemoryTier.Persistent });
    const stamped = db.prepare("SELECT json_extract(value, '$.embeddingProvenance') AS p FROM memories WHERE id = ?");
    for (const id of ids) expect((stamped.get(id) as { p: unknown }).p).toBeNull();
    const log = db.prepare("SELECT id FROM consolidation_log WHERE status = 'completed'").get() as { id: string };
    return { engine, logId: log.id, sourceIds: ids };
  }

  it("lists a merge whose unstamped source rows hold histogram vectors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consolidation-gate-"));
    dirs.push(dir);
    const memory = new AgentDBMemory(memoryConfig(dir));
    open.push(memory);
    expect((await memory.initialize()).kind).toBe("ok");

    const { engine, logId, sourceIds } = await mergeUnstamped(memory, UNRELATED.slice(0, 2), standIn);

    expect(engine.findHistogramMerges()).toEqual([
      expect.objectContaining({ logId, sourceEntryIds: sourceIds }),
    ]);
  });

  it("does not list a merge whose unstamped source rows hold provider vectors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consolidation-gate-"));
    dirs.push(dir);
    const embed = async (text: string): Promise<number[]> => {
      const v = new Array<number>(8).fill(-0.01);
      v[/health|regen/i.test(text) ? 0 : 1] = 1;
      return v;
    };
    const memory = new AgentDBMemory(memoryConfig(dir, {
      dimensions: 8, embeddingProvider: embed, embeddingProviderId: "toy-embedder:8d",
    }));
    open.push(memory);
    expect((await memory.initialize()).kind).toBe("ok");

    const { engine } = await mergeUnstamped(
      memory,
      ["Player health regenerates slowly", "Health regen for the player is slow"],
      embed,
    );

    expect(engine.findHistogramMerges()).toEqual([]);
  });
});
