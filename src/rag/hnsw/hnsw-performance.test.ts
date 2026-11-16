import { describe, it, expect, beforeAll } from "vitest";
import { createLogger } from "../../utils/logger.js";

// Initialize logger for tests
beforeAll(() => {
  createLogger("error", "test.log");
});

import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHNSWVectorStore, isHnswAvailable } from "./hnsw-vector-store.js";
import type { VectorEntry, CodeChunk } from "../rag.interface.js";

/**
 * Work, not time. A millisecond ceiling on the search said how fast the machine
 * was that day. What makes the search cheap is that it visits a few hundred
 * nodes whatever the store holds, so the tests count that: hnswlib calls the
 * search filter once for each node that enters its candidate set, and a scan
 * (or an efSearch as large as the store) calls it for every vector. The count
 * does not depend on the clock or the load: with a fixed seed and fixed vectors
 * it is the same on every run. Measured 2026-11-16, 384 dimensions, M=16,
 * efSearch=64: 2000 vectors ~235 calls, 4000 vectors ~250; efSearch=2000
 * visits all 2000.
 */
function countSearchWork(store: { search: (q: number[], k: number) => Promise<unknown[]> }) {
  const holder = store as unknown as {
    hnswIndex: { searchKnn: (q: number[], k: number, filter?: (label: number) => boolean) => unknown };
  };
  const native = holder.hnswIndex;
  let calls = 0;
  holder.hnswIndex = new Proxy(native, {
    get(target, prop) {
      if (prop === "searchKnn") {
        return (q: number[], k: number) =>
          target.searchKnn(q, k, () => {
            calls++;
            return true;
          });
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    /** Search once and say how many nodes the index put into its candidate set. */
    async visited(query: number[], topK: number): Promise<number> {
      calls = 0;
      await store.search(query, topK);
      return calls;
    },
    restore(): void {
      holder.hnswIndex = native;
    },
  };
}

/** A seeded random unit vector: the same stream gives the same index on every run. */
function seededUnitVectors(count: number, dimensions: number, seed: number): number[][] {
  let state = seed >>> 0;
  const next = (): number => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  return Array.from({ length: count }, () => {
    const vec = Array.from({ length: dimensions }, next);
    const norm = Math.hypot(...vec);
    return vec.map((v) => v / norm);
  });
}

// This file is a benchmark-style suite and is too memory-intensive for the default test run.
const runHnswPerfTests = !!process.env["HNSW_PERF_TESTS"];

describe.skipIf(!runHnswPerfTests)("HNSWVectorStore Performance", () => {
  const dimensions = 384; // MiniLM dimensions

  async function runBenchmark(
    vectorCount: number,
    topK: number = 10,
  ): Promise<{
    insertTimeMs: number;
    searchTimeMs: number;
    /** Nodes the index visited per search, averaged: the work, whatever the clock said. */
    visitedPerSearch: number;
    vectorsPerSecond: number;
    searchesPerSecond: number;
  }> {
    const tempDir = mkdtempSync(join(tmpdir(), `hnsw-bench-${vectorCount}-`));

    const store = await createHNSWVectorStore(tempDir, {
      dimensions,
      maxElements: vectorCount + 1000,
      M: 16,
      efConstruction: 200,
      efSearch: 64,
      metric: "cosine",
    });

    // Generate random vectors
    const entries: VectorEntry[] = [];
    for (let i = 0; i < vectorCount; i++) {
      const vec = new Array(dimensions).fill(0).map(() => Math.random() - 0.5);
      const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
      const normalized = vec.map((v) => v / (norm + 1e-10));

      entries.push({
        id: `bench-${i}`,
        vector: normalized,
        chunk: {
          id: `bench-${i}`,
          filePath: `/test/file${i % 100}.cs`,
          content: `Content for entry ${i}`,
          startLine: 1,
          endLine: 10,
          kind: "class",
          contentHash: "bench",
          indexedAt: Date.now(),
          language: "csharp",
        },
        addedAt: Date.now(),
        accessCount: 0,
      });
    }

    // Benchmark insert
    const insertStart = performance.now();
    await store.upsertBatch(entries);
    const insertTimeMs = performance.now() - insertStart;

    // Benchmark search (average of 100 searches)
    const searchTimes: number[] = [];
    const visitedCounts: number[] = [];
    const work = countSearchWork(store);
    const numSearches = Math.min(100, vectorCount);

    for (let i = 0; i < numSearches; i++) {
      const query = new Array(dimensions).fill(0).map(() => Math.random() - 0.5);
      const norm = Math.sqrt(query.reduce((a, b) => a + b * b, 0));
      const normalizedQuery = query.map((v) => v / (norm + 1e-10));

      const searchStart = performance.now();
      visitedCounts.push(await work.visited(normalizedQuery, topK));
      searchTimes.push(performance.now() - searchStart);
    }

    const avgSearchTimeMs = searchTimes.reduce((a, b) => a + b, 0) / searchTimes.length;
    const visitedPerSearch = visitedCounts.reduce((a, b) => a + b, 0) / visitedCounts.length;
    work.restore();

    await store.shutdown();
    rmSync(tempDir, { recursive: true, force: true });

    return {
      insertTimeMs,
      searchTimeMs: avgSearchTimeMs,
      visitedPerSearch,
      vectorsPerSecond: (vectorCount / insertTimeMs) * 1000,
      searchesPerSecond: (1 / avgSearchTimeMs) * 1000,
    };
  }

  // Performance tests with different vector counts
  it("should handle 10K vectors efficiently", async () => {
    const results = await runBenchmark(10000);

    console.log("\n=== 10K Vectors Performance ===");
    console.log(`Insert time: ${results.insertTimeMs.toFixed(2)}ms`);
    console.log(`Avg search time: ${results.searchTimeMs.toFixed(2)}ms, ${results.visitedPerSearch.toFixed(0)} nodes visited`);
    console.log(`Vectors/sec: ${results.vectorsPerSecond.toFixed(0)}`);
    console.log(`Searches/sec: ${results.searchesPerSecond.toFixed(0)}`);

    expect(results.insertTimeMs).toBeLessThan(30000); // Should insert in < 30s
    expect(results.visitedPerSearch).toBeLessThan(10000 / 10); // visits a tenth of the store at most
  }, 60000);

  // Skip in CI — too slow for standard test runs
  it.skip("should handle 100K vectors efficiently", async () => {
    const results = await runBenchmark(100000);

    console.log("\n=== 100K Vectors Performance ===");
    console.log(`Insert time: ${results.insertTimeMs.toFixed(2)}ms`);
    console.log(`Avg search time: ${results.searchTimeMs.toFixed(2)}ms, ${results.visitedPerSearch.toFixed(0)} nodes visited`);
    console.log(`Vectors/sec: ${results.vectorsPerSecond.toFixed(0)}`);
    console.log(`Searches/sec: ${results.searchesPerSecond.toFixed(0)}`);

    expect(results.insertTimeMs).toBeLessThan(180000); // Should insert in < 3min
    expect(results.visitedPerSearch).toBeLessThan(100000 / 10);
  }, 180000);

  // Skip 1M test in CI - too slow
  it.skip("should handle 1M vectors", async () => {
    const results = await runBenchmark(1000000);

    console.log("\n=== 1M Vectors Performance ===");
    console.log(`Insert time: ${results.insertTimeMs.toFixed(2)}ms`);
    console.log(`Avg search time: ${results.searchTimeMs.toFixed(2)}ms, ${results.visitedPerSearch.toFixed(0)} nodes visited`);
    console.log(`Vectors/sec: ${results.vectorsPerSecond.toFixed(0)}`);
    console.log(`Searches/sec: ${results.searchesPerSecond.toFixed(0)}`);

    expect(results.insertTimeMs).toBeLessThan(600000); // Should insert in < 10min
    expect(results.visitedPerSearch).toBeLessThan(1000000 / 10);
  }, 600000);
});

// Not behind HNSW_PERF_TESTS: 6000 small inserts take seconds, and this is the
// proof that the search stays cheap as the store grows, so the gates run it.
// It needs the native hnswlib-node: the exact fallback has no search filter to
// count with, so it would count nothing. Where hnswlib-node is missing (the
// Windows CI runner) the describe does not run; macOS and Linux runs carry it.
describe.runIf(isHnswAvailable())("HNSWVectorStore search work", () => {
  const dimensions = 384;
  const efSearch = 64;
  const topK = 10;

  async function visitedAt(vectorCount: number, ef: number): Promise<number> {
    const tempDir = mkdtempSync(join(tmpdir(), `hnsw-work-${vectorCount}-`));
    const store = await createHNSWVectorStore(tempDir, {
      dimensions,
      maxElements: vectorCount + 10,
      M: 16,
      efConstruction: 100,
      efSearch: ef,
      metric: "cosine",
      seed: 42,
    });
    try {
      const vectors = seededUnitVectors(vectorCount + 3, dimensions, 12345);
      await store.upsertBatch(
        vectors.slice(0, vectorCount).map((vector, i) => ({
          id: `w-${i}`,
          vector,
          chunk: {
            id: `w-${i}`, filePath: "/test/w.cs", content: `w ${i}`, startLine: 1, endLine: 1,
            kind: "class", contentHash: "w", indexedAt: 1, language: "csharp",
          } as CodeChunk,
          addedAt: 1,
          accessCount: 0,
        })),
      );
      const work = countSearchWork(store);
      const counts: number[] = [];
      for (const query of vectors.slice(vectorCount)) counts.push(await work.visited(query, topK));
      return counts.reduce((a, b) => a + b, 0) / counts.length;
    } finally {
      await store.shutdown();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it("visits a small fraction of the store, and little more when the store doubles", async () => {
    const small = await visitedAt(2000, efSearch);
    const doubled = await visitedAt(4000, efSearch);
    expect(small).toBeGreaterThanOrEqual(topK);
    expect(small).toBeLessThan(2000 / 4);
    expect(doubled).toBeLessThan(4000 / 8);
    // A scan doubles with the store; the graph search grows by about 6%.
    expect(doubled).toBeLessThan(small * 1.5);
  }, 120000);

  it("is a scan when efSearch is as large as the store (what the test above guards against)", async () => {
    expect(await visitedAt(2000, 2000)).toBeGreaterThanOrEqual(2000);
  }, 120000);
});

describe.skipIf(!runHnswPerfTests)("HNSWVectorStore Recall Accuracy", () => {
  const dimensions = 384;

  it("should have high recall compared to brute force", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "hnsw-recall-"));
    const vectorCount = 1000;
    const topK = 10;

    const store = await createHNSWVectorStore(tempDir, {
      dimensions,
      maxElements: vectorCount + 100,
      M: 16,
      efConstruction: 200,
      efSearch: 128, // Higher for better recall
      metric: "cosine",
    });

    // Generate random vectors
    const vectors: number[][] = [];
    const entries: VectorEntry[] = [];

    for (let i = 0; i < vectorCount; i++) {
      const vec = new Array(dimensions).fill(0).map(() => Math.random() - 0.5);
      const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
      const normalized = vec.map((v) => v / (norm + 1e-10));

      vectors.push(normalized);
      entries.push({
        id: `recall-${i}`,
        vector: normalized,
        chunk: {
          id: `recall-${i}`,
          filePath: `/test/file.cs`,
          content: `Content ${i}`,
          startLine: 1,
          endLine: 1,
          kind: "class",
          contentHash: "test",
          indexedAt: Date.now(),
          language: "csharp",
        },
        addedAt: Date.now(),
        accessCount: 0,
      });
    }

    await store.upsertBatch(entries);

    // Test recall with multiple queries
    let totalRecall = 0;
    const numQueries = 50;

    for (let q = 0; q < numQueries; q++) {
      const query = new Array(dimensions).fill(0).map(() => Math.random() - 0.5);
      const norm = Math.sqrt(query.reduce((a, b) => a + b * b, 0));
      const normalizedQuery = query.map((v) => v / (norm + 1e-10));

      // Brute force search
      const bruteForceResults = vectors
        .map((vec, idx) => ({
          id: `recall-${idx}`,
          score: cosineSimilarity(normalizedQuery, vec),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map((r) => r.id);

      // HNSW search
      const hnswResults = await store.search(normalizedQuery, topK);
      const hnswIds = hnswResults.map((r) => r.id);

      // Calculate recall
      const matches = hnswIds.filter((id) => bruteForceResults.includes(id)).length;
      totalRecall += matches / topK;
    }

    const avgRecall = totalRecall / numQueries;

    console.log(`\n=== Recall Accuracy ===`);
    console.log(`Average recall@${topK}: ${(avgRecall * 100).toFixed(2)}%`);

    await store.shutdown();
    rmSync(tempDir, { recursive: true, force: true });

    expect(avgRecall).toBeGreaterThan(0.9); // Should have >90% recall
  }, 60000);
});

// Helper function for brute force comparison
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
