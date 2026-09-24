/**
 * X-6: hnswlib-node is an optional native dependency, but AgentDB memory has
 * no vector path without it — initialize() threw and every AgentDB memory
 * fell out of reach wherever the native build failed. A store opened with
 * `allowExactFallback` now searches exactly (brute force) instead.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "../../utils/logger.js";
import {
  _simulateMissingHnswForTests,
  createHNSWVectorStore,
  isHnswAvailable,
  type HNSWConfig,
} from "./hnsw-vector-store.js";
import type { CodeChunk, VectorEntry } from "../rag.interface.js";
import { AgentDBMemory } from "../../memory/unified/agentdb-memory.js";
import { MemoryTier } from "../../memory/unified/unified-memory.interface.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const DIMS = 16;

function chunk(id: string): CodeChunk {
  return {
    id, filePath: `/t/${id}.cs`, content: id, startLine: 1, endLine: 1,
    kind: "class", contentHash: id, indexedAt: 1, language: "csharp",
  };
}

function vec(seed: number): number[] {
  return Array.from({ length: DIMS }, (_, i) => Math.sin(seed * 13 + i * 3.1));
}

function entry(i: number): VectorEntry {
  return { id: `c${i}`, vector: vec(i), chunk: chunk(`c${i}`) };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return dot / Math.sqrt(na * nb);
}

const config = (extra: Partial<HNSWConfig> = {}): Partial<HNSWConfig> => ({
  dimensions: DIMS, maxElements: 50, M: 8, efConstruction: 50, efSearch: 32,
  metric: "cosine", quantization: "none", ...extra,
});

describe("HNSW store without hnswlib-node (X-6)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hnsw-exact-"));
    _simulateMissingHnswForTests(true);
  });

  afterEach(() => {
    _simulateMissingHnswForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("still refuses to open without the opt-in, and names no deprecated installer", async () => {
    const failure = createHNSWVectorStore(dir, config());
    await expect(failure).rejects.toThrow(/hnswlib-node is not available/);
    await expect(failure).rejects.not.toThrow(/windows-build-tools/);
  });

  it("answers searches exactly with the opt-in", async () => {
    const store = await createHNSWVectorStore(dir, config({ allowExactFallback: true }));
    expect(store.isExactSearch()).toBe(true);
    await store.upsert(Array.from({ length: 30 }, (_, i) => entry(i)));
    const query = vec(7.5);
    const expected = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, s: cosine(query, vec(i)) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 5)
      .map((h) => h.id);

    const hits = await store.search(query, 5);
    expect(hits.map((h) => h.id)).toEqual(expected);
    expect(hits[0]!.score).toBeCloseTo(cosine(query, vec(Number(expected[0]!.slice(1)))), 6);

    await store.remove([expected[0]!]);
    expect((await store.search(query, 1))[0]!.id).toBe(expected[1]);
    await expect(store.upsertBatch(Array.from({ length: 30 }, (_, i) => entry(100 + i)))).rejects.toThrow(/capacity/);
    await store.shutdown();
  });

  it("reopens from its own saved files", async () => {
    const store = await createHNSWVectorStore(dir, config({ allowExactFallback: true }));
    await store.upsert(Array.from({ length: 10 }, (_, i) => entry(i)));
    await store.shutdown();

    const reopened = await createHNSWVectorStore(dir, config({ allowExactFallback: true }));
    expect(reopened.count()).toBe(10);
    expect((await reopened.search(vec(3), 1))[0]!.id).toBe("c3");
    await reopened.shutdown();
  });

  it.runIf(isHnswAvailable())("an index saved by the fallback reopens under hnswlib", async () => {
    const store = await createHNSWVectorStore(dir, config({ allowExactFallback: true }));
    await store.upsert(Array.from({ length: 10 }, (_, i) => entry(i)));
    await store.shutdown();

    _simulateMissingHnswForTests(null);
    const native = await createHNSWVectorStore(dir, config());
    expect(native.isExactSearch()).toBe(false);
    expect((await native.search(vec(4), 1))[0]!.id).toBe("c4");
    await native.shutdown();
  });

  it("AgentDB memory initializes and indexes vectors without hnswlib-node", async () => {
    const memory = new AgentDBMemory({
      dbPath: dir,
      dimensions: 32,
      maxEntriesPerTier: {
        [MemoryTier.Working]: 10,
        [MemoryTier.Ephemeral]: 10,
        [MemoryTier.Persistent]: 10,
      },
      hnswParams: { efConstruction: 50, M: 8, efSearch: 32 },
      quantizationType: "none",
      cacheSize: 10,
      enableAutoTiering: false,
      ephemeralTtlMs: 60_000,
    });
    try {
      expect((await memory.initialize()).kind).toBe("ok");
      await memory.storeNote("Player health regenerates", ["hp"]);
      await memory.storeNote("Enemy spawner wave timer", ["waves"]);
      const store = memory.getConsolidationInternals().hnswStore!;
      expect(store.isExactSearch()).toBe(true);
      expect(store.count()).toBe(2);
      const hits = await memory.retrieveSemantic("Player health regenerates", { limit: 1 });
      expect(hits[0]?.entry.content).toBe("Player health regenerates");
    } finally {
      await memory.shutdown();
    }
  });
});
