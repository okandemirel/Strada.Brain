/**
 * The memory index and the vectors it is searched with must have one size.
 *
 * Release smoke (2026-09-25): with multi-agent on, each agent's AgentDB
 * memory is opened at the configured size (1536) with no embedder, while the
 * agent's orchestrator hands it query vectors from the resolved embedding
 * provider (Qwen, 1024). Every recall logged
 * "[HNSWVectorStore] Search failed … expected 1536, but got 1024" and
 * returned nothing. The same break followed an embedder whose vectors change
 * size at runtime (a provider that answers at a size other than the one it
 * declared): the index was never rebuilt, entries stayed out of it, and every
 * search failed.
 *
 * These run against a real AgentDBMemory and HNSW store on a temp dir.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, getLogger } from "../../utils/logger.js";
import { AgentDBMemory } from "./agentdb-memory.js";
import { MemoryTier, type UnifiedMemoryConfig } from "./unified-memory.interface.js";

beforeAll(() => {
  createLogger("error", join(tmpdir(), "agentdb-embedding-size.test.log"));
});

let dir: string;
const open: AgentDBMemory[] = [];

function memoryAt(dbPath: string, config: Partial<UnifiedMemoryConfig>): AgentDBMemory {
  const memory = new AgentDBMemory({
    dbPath,
    maxEntriesPerTier: { [MemoryTier.Working]: 20, [MemoryTier.Ephemeral]: 20, [MemoryTier.Persistent]: 20 },
    hnswParams: { efConstruction: 50, M: 8, efSearch: 32 },
    quantizationType: "none",
    cacheSize: 10,
    enableAutoTiering: false,
    ephemeralTtlMs: 60_000 as UnifiedMemoryConfig["ephemeralTtlMs"],
    ...config,
  });
  open.push(memory);
  return memory;
}

/** A provider-style vector (signed components, unit length) of `size` for `text`. */
function providerVector(text: string, size: number): number[] {
  const vector = new Array<number>(size).fill(0);
  for (let i = 0; i < text.length; i++) vector[i % size]! += Math.sin(text.charCodeAt(i) * (i + 1));
  const norm = Math.hypot(...vector) || 1;
  return vector.map((x) => x / norm);
}

const NOTES = [
  "prefer SystemBase for ECS systems",
  "the build pipeline uses IL2CPP",
  "enemy spawner lives in the Combat module",
];

function logSpies() {
  const logger = getLogger();
  const warn = vi.spyOn(logger, "warn");
  const error = vi.spyOn(logger, "error");
  const messages = (spy: typeof warn, pattern: RegExp) =>
    spy.mock.calls.filter(([message]) => pattern.test(String(message)));
  return {
    searchFailures: () => messages(error, /Search failed/),
    warnings: (pattern: RegExp) => messages(warn, pattern),
  };
}

function contents(hits: ReadonlyArray<{ entry: { content: string } }>): string[] {
  return hits.map((hit) => hit.entry.content);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentdb-embedding-size-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const memory of open.splice(0)) await memory.shutdown().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("a query vector the index cannot compare is never searched with", () => {
  it("a provider-less memory given another size's query vector serves the search and warns once", async () => {
    // The per-agent memory: configured size, no embedder of its own.
    const memory = memoryAt(join(dir, "agent"), { dimensions: 16 });
    expect((await memory.initialize()).kind).toBe("ok");
    for (const note of NOTES) await memory.storeNote(note);
    const logs = logSpies();

    // The orchestrator's pre-computed query vector, from the resolved provider.
    const queryVector = providerVector("SystemBase ECS", 8);
    for (let i = 0; i < 3; i++) {
      const hits = await memory.retrieveSemantic("SystemBase ECS", { embedding: queryVector, limit: 5 });
      expect(contents(hits)).toContain(NOTES[0]);
    }

    expect(logs.searchFailures()).toHaveLength(0);
    expect(logs.warnings(/Ignoring caller-supplied query vector/)).toHaveLength(1);
  });

  it("a provider-less memory never compares a same-size provider vector against its histogram index", async () => {
    const memory = memoryAt(join(dir, "agent"), { dimensions: 8 });
    expect((await memory.initialize()).kind).toBe("ok");
    for (const note of NOTES) await memory.storeNote(note);
    const store = memory.getConsolidationInternals().hnswStore!;
    const search = vi.spyOn(store, "search");

    const queryVector = providerVector("SystemBase ECS", 8);
    await memory.retrieveSemantic("SystemBase ECS", { embedding: queryVector, limit: 5 });

    expect(search).toHaveBeenCalled();
    const searched = search.mock.calls[0]![0];
    expect(searched).not.toEqual(queryVector);
    // The memory's own (histogram) embedding of the query text: all components >= 0.
    expect(searched.every((x) => x >= 0)).toBe(true);
  });
});

describe("the memory's embedder changes size", () => {
  it("rebuilds the index once for the new size and searches it (provider answers at another size at runtime)", async () => {
    let size = 8;
    const embeddingProvider = vi.fn(async (text: string) => providerVector(text, size));
    const memory = memoryAt(join(dir, "main"), {
      dimensions: 8,
      embeddingProvider,
      embeddingProviderId: "smoke:model:8d",
    });
    expect((await memory.initialize()).kind).toBe("ok");
    for (const note of NOTES) await memory.storeNote(note);
    const store = memory.getConsolidationInternals().hnswStore!;
    expect(store.count()).toBe(3);
    const logs = logSpies();

    size = 4;
    // The first search after the change must not fail; it may be served by text.
    await memory.retrieveSemantic("SystemBase ECS systems", { limit: 5 });

    await vi.waitFor(() => {
      expect(store.getHNSWStats().config.dimensions).toBe(4);
      expect(store.count()).toBe(3);
    }, { timeout: 5_000 });
    // Rebuilt in place: holders of the store (the consolidation engine) keep a live index.
    expect(memory.getConsolidationInternals().hnswStore).toBe(store);

    const search = vi.spyOn(store, "search");
    for (let i = 0; i < 3; i++) {
      const hits = await memory.retrieveSemantic("SystemBase ECS systems", { limit: 5 });
      expect(contents(hits)).toContain(NOTES[0]);
    }
    expect(search).toHaveBeenCalledTimes(3);
    for (const [vector] of search.mock.calls) expect(vector).toHaveLength(4);

    await memory.storeNote("audio mixer groups are in Assets/Audio");
    expect(store.count()).toBe(4);

    expect(logs.searchFailures()).toHaveLength(0);
    expect(logs.warnings(/Embedding size changed/)).toHaveLength(1);
  });

  it("adopts the provider's real size when it differs from the declared one from the start", async () => {
    // Declared 8 (what the memory was opened with), real 4.
    const embeddingProvider = vi.fn(async (text: string) => providerVector(text, 4));
    const memory = memoryAt(join(dir, "main"), {
      dimensions: 8,
      embeddingProvider,
      embeddingProviderId: "custom:model:8d",
    });
    expect((await memory.initialize()).kind).toBe("ok");
    const logs = logSpies();

    for (const note of NOTES) await memory.storeNote(note);
    const store = memory.getConsolidationInternals().hnswStore!;
    await vi.waitFor(() => {
      expect(store.getHNSWStats().config.dimensions).toBe(4);
      expect(store.count()).toBe(3);
    }, { timeout: 5_000 });

    const hits = await memory.retrieveSemantic("enemy spawner Combat", { limit: 5 });
    expect(contents(hits)).toContain(NOTES[2]);
    expect(logs.searchFailures()).toHaveLength(0);
    expect(logs.warnings(/Embedding size changed/)).toHaveLength(1);
    expect(logs.warnings(/Skipping entry with mismatched dimensions/)).toHaveLength(0);
  });

  it("recall with the orchestrator's vectors from the same provider adopts the size instead of discarding them", async () => {
    // Declared 8, real 4; the orchestrator pre-computes its recall vector with the same provider.
    const embed = async (text: string) => providerVector(text, 4);
    const memory = memoryAt(join(dir, "main"), {
      dimensions: 8,
      embeddingProvider: embed,
      embeddingProviderId: "custom:model:8d",
    });
    expect((await memory.initialize()).kind).toBe("ok");
    const logs = logSpies();

    const query = "IL2CPP build pipeline";
    await memory.retrieveSemantic(query, { embedding: await embed(query), limit: 5 });
    await memory.storeNote(NOTES[1]!);
    const store = memory.getConsolidationInternals().hnswStore!;
    await vi.waitFor(() => expect(store.dimensions).toBe(4), { timeout: 5_000 });
    await vi.waitFor(() => expect(store.count()).toBe(1), { timeout: 5_000 });

    const search = vi.spyOn(store, "search");
    const hits = await memory.retrieveSemantic(query, { embedding: await embed(query), limit: 5 });
    expect(contents(hits)).toContain(NOTES[1]);
    expect(search).toHaveBeenCalledTimes(1);

    expect(logs.warnings(/Embedding size changed/)).toHaveLength(1);
    expect(logs.warnings(/Ignoring caller-supplied query vector/)).toHaveLength(0);
    expect(logs.searchFailures()).toHaveLength(0);
  });

  it("a restart with an embedder of another size serves the old entries and re-embeds them into the new index", async () => {
    const dbPath = join(dir, "main");
    // Run 1: no provider — 16-wide histogram vectors (the hash fallback).
    const first = memoryAt(dbPath, { dimensions: 16 });
    expect((await first.initialize()).kind).toBe("ok");
    for (const note of NOTES) await first.storeNote(note);
    await first.shutdown();

    // Run 2: a provider with 8-wide vectors.
    const second = memoryAt(dbPath, {
      dimensions: 8,
      embeddingProvider: async (text: string) => providerVector(text, 8),
      embeddingProviderId: "qwen:text-embedding-v3:8d",
    });
    expect((await second.initialize()).kind).toBe("ok");
    const logs = logSpies();

    const before = await second.retrieveSemantic("IL2CPP build pipeline", { limit: 5 });
    expect(contents(before)).toContain(NOTES[1]);

    await second.reEmbedHashEntries();
    const store = second.getConsolidationInternals().hnswStore!;
    expect(store.getHNSWStats().config.dimensions).toBe(8);
    expect(store.count()).toBe(3);
    const after = await second.retrieveSemantic("IL2CPP build pipeline", { limit: 5 });
    expect(contents(after)).toContain(NOTES[1]);

    expect(logs.searchFailures()).toHaveLength(0);
  });
});
