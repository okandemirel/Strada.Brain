import { describe, it, expect, beforeAll } from "vitest";
import { createLogger } from "../../utils/logger.js";

// Initialize logger for tests
beforeAll(() => {
  createLogger("error", "test.log");
});

import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHNSWVectorStore } from "./hnsw-vector-store.js";
import type { VectorEntry, CodeChunk } from "../rag.interface.js";

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
    const numSearches = Math.min(100, vectorCount);

    for (let i = 0; i < numSearches; i++) {
      const query = new Array(dimensions).fill(0).map(() => Math.random() - 0.5);
      const norm = Math.sqrt(query.reduce((a, b) => a + b * b, 0));
      const normalizedQuery = query.map((v) => v / (norm + 1e-10));

      const searchStart = performance.now();
      await store.search(normalizedQuery, topK);
      searchTimes.push(performance.now() - searchStart);
    }

    const avgSearchTimeMs = searchTimes.reduce((a, b) => a + b, 0) / searchTimes.length;

    await store.shutdown();
    rmSync(tempDir, { recursive: true, force: true });

    return {
      insertTimeMs,
      searchTimeMs: avgSearchTimeMs,
      vectorsPerSecond: (vectorCount / insertTimeMs) * 1000,
      searchesPerSecond: (1 / avgSearchTimeMs) * 1000,
    };
  }

  // Performance tests with different vector counts
  it("should handle 10K vectors efficiently", async () => {
    const results = await runBenchmark(10000);

    console.log("\n=== 10K Vectors Performance ===");
    console.log(`Insert time: ${results.insertTimeMs.toFixed(2)}ms`);
    console.log(`Avg search time: ${results.searchTimeMs.toFixed(2)}ms`);
    console.log(`Vectors/sec: ${results.vectorsPerSecond.toFixed(0)}`);
    console.log(`Searches/sec: ${results.searchesPerSecond.toFixed(0)}`);

    expect(results.insertTimeMs).toBeLessThan(30000); // Should insert in < 30s
    expect(results.searchTimeMs).toBeLessThan(10); // Should search in < 10ms
  }, 60000);

  // Skip in CI — too slow for standard test runs
  it.skip("should handle 100K vectors efficiently", async () => {
    const results = await runBenchmark(100000);

    console.log("\n=== 100K Vectors Performance ===");
    console.log(`Insert time: ${results.insertTimeMs.toFixed(2)}ms`);
    console.log(`Avg search time: ${results.searchTimeMs.toFixed(2)}ms`);
    console.log(`Vectors/sec: ${results.vectorsPerSecond.toFixed(0)}`);
    console.log(`Searches/sec: ${results.searchesPerSecond.toFixed(0)}`);

    expect(results.insertTimeMs).toBeLessThan(180000); // Should insert in < 3min
    expect(results.searchTimeMs).toBeLessThan(20); // Should search in < 20ms
  }, 180000);

  // Skip 1M test in CI - too slow
  it.skip("should handle 1M vectors", async () => {
    const results = await runBenchmark(1000000);

    console.log("\n=== 1M Vectors Performance ===");
    console.log(`Insert time: ${results.insertTimeMs.toFixed(2)}ms`);
    console.log(`Avg search time: ${results.searchTimeMs.toFixed(2)}ms`);
    console.log(`Vectors/sec: ${results.vectorsPerSecond.toFixed(0)}`);
    console.log(`Searches/sec: ${results.searchesPerSecond.toFixed(0)}`);

    expect(results.insertTimeMs).toBeLessThan(600000); // Should insert in < 10min
    expect(results.searchTimeMs).toBeLessThan(50); // Should search in < 50ms
  }, 600000);
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
