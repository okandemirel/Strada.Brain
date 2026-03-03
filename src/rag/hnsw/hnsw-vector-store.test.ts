import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createLogger } from "../../utils/logger.js";

// Initialize logger for tests
beforeAll(() => {
  createLogger("error", "test.log");
});

import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { HNSWVectorStore, createHNSWVectorStore } from "./hnsw-vector-store.js";
import type { VectorEntry, CodeChunk } from "../rag.interface.js";

describe("HNSWVectorStore", () => {
  let tempDir: string;
  let store: HNSWVectorStore;
  const dimensions = 128;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "hnsw-test-"));
    store = await createHNSWVectorStore(tempDir, {
      dimensions,
      maxElements: 1000,
      M: 8,
      efConstruction: 50,
      efSearch: 32,
      metric: "cosine",
      quantization: "none",
    });
  });

  afterEach(async () => {
    await store.shutdown();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createMockChunk(id: string, content: string, filePath?: string): CodeChunk {
    return {
      id,
      filePath: filePath ?? `/test/${id}.cs`,
      content,
      startLine: 1,
      endLine: content.split("\n").length,
      kind: "class",
      contentHash: "abc123",
      indexedAt: Date.now(),
      language: "csharp",
    };
  }

  function createRandomVector(dim: number): number[] {
    const vec = new Array(dim).fill(0).map(() => Math.random() - 0.5);
    // Normalize for cosine similarity
    const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
    return vec.map(v => v / (norm + 1e-10));
  }

  describe("basic operations", () => {
    it("should initialize and shutdown", () => {
      expect(store.count()).toBe(0);
    });

    it("should insert single entry", async () => {
      const entry: VectorEntry = {
        id: "test-1",
        vector: createRandomVector(dimensions),
        chunk: createMockChunk("test-1", "public class Test {}"),
        addedAt: Date.now(),
        accessCount: 0,
      };

      await store.upsert([entry]);
      expect(store.count()).toBe(1);
      expect(store.has("test-1")).toBe(true);
    });

    it("should insert multiple entries", async () => {
      const entries: VectorEntry[] = [
        {
          id: "test-1",
          vector: createRandomVector(dimensions),
          chunk: createMockChunk("test-1", "class A {}"),
          addedAt: Date.now(),
          accessCount: 0,
        },
        {
          id: "test-2",
          vector: createRandomVector(dimensions),
          chunk: createMockChunk("test-2", "class B {}"),
          addedAt: Date.now(),
          accessCount: 0,
        },
        {
          id: "test-3",
          vector: createRandomVector(dimensions),
          chunk: createMockChunk("test-3", "class C {}"),
          addedAt: Date.now(),
          accessCount: 0,
        },
      ];

      await store.upsert(entries);
      expect(store.count()).toBe(3);
    });

    it("should update existing entry", async () => {
      const entry: VectorEntry = {
        id: "test-1",
        vector: createRandomVector(dimensions),
        chunk: createMockChunk("test-1", "original content"),
        addedAt: Date.now(),
        accessCount: 0,
      };

      await store.upsert([entry]);
      
      const updatedEntry: VectorEntry = {
        id: "test-1",
        vector: createRandomVector(dimensions),
        chunk: createMockChunk("test-1", "updated content"),
        addedAt: Date.now(),
        accessCount: 0,
      };

      await store.upsert([updatedEntry]);
      expect(store.count()).toBe(1);
    });

    it("should remove entries by id", async () => {
      const entries: VectorEntry[] = [
        { id: "test-1", vector: createRandomVector(dimensions), chunk: createMockChunk("test-1", "A"), addedAt: Date.now(), accessCount: 0 },
        { id: "test-2", vector: createRandomVector(dimensions), chunk: createMockChunk("test-2", "B"), addedAt: Date.now(), accessCount: 0 },
      ];

      await store.upsert(entries);
      await store.remove(["test-1"]);

      expect(store.count()).toBe(1);
      expect(store.has("test-1")).toBe(false);
      expect(store.has("test-2")).toBe(true);
    });

    it("should remove entries by file path", async () => {
      const entries: VectorEntry[] = [
        { id: "test-1", vector: createRandomVector(dimensions), chunk: createMockChunk("test-1", "A", "/test/file1.cs"), addedAt: Date.now(), accessCount: 0 },
        { id: "test-2", vector: createRandomVector(dimensions), chunk: createMockChunk("test-2", "B", "/test/file1.cs"), addedAt: Date.now(), accessCount: 0 },
        { id: "test-3", vector: createRandomVector(dimensions), chunk: createMockChunk("test-3", "C", "/test/file2.cs"), addedAt: Date.now(), accessCount: 0 },
      ];

      await store.upsert(entries);
      await store.removeByFile("/test/file1.cs");

      expect(store.count()).toBe(1);
      expect(store.has("test-3")).toBe(true);
    });
  });

  describe("search operations", () => {
    beforeEach(async () => {
      // Insert test vectors with known relationships
      // Using orthogonal vectors for deterministic search results
      const entries: VectorEntry[] = [];
      
      for (let i = 0; i < 10; i++) {
        const vec = new Array(dimensions).fill(0);
        vec[i % dimensions] = 1; // One-hot encoding
        
        entries.push({
          id: `vec-${i}`,
          vector: vec,
          chunk: createMockChunk(`vec-${i}`, `Content for vector ${i}`),
          addedAt: Date.now(),
          accessCount: 0,
        });
      }

      await store.upsert(entries);
    });

    it("should search for nearest neighbors", async () => {
      const query = new Array(dimensions).fill(0);
      query[0] = 1; // Search for first dimension

      const results = await store.search(query, 3);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.score).toBeGreaterThan(0);
    });

    it("should return topK results", async () => {
      const query = createRandomVector(dimensions);
      
      const results = await store.search(query, 5);
      
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it("should return empty results when store is empty", async () => {
      const emptyStore = await createHNSWVectorStore(join(tempDir, "empty"), {
        dimensions,
        maxElements: 100,
        M: 8,
        efConstruction: 50,
        efSearch: 32,
        metric: "cosine",
      });

      const query = createRandomVector(dimensions);
      const results = await emptyStore.search(query, 5);
      
      expect(results).toHaveLength(0);
      
      await emptyStore.shutdown();
    });

    it("should support filtered search", async () => {
      // Add entries with different kinds
      await store.upsert([
        {
          id: "class-1",
          vector: createRandomVector(dimensions),
          chunk: { ...createMockChunk("class-1", ""), kind: "class" },
          addedAt: Date.now(),
          accessCount: 0,
        },
        {
          id: "method-1",
          vector: createRandomVector(dimensions),
          chunk: { ...createMockChunk("method-1", ""), kind: "method" },
          addedAt: Date.now(),
          accessCount: 0,
        },
      ]);

      const query = createRandomVector(dimensions);
      const results = await store.searchFiltered(
        query,
        10,
        chunk => chunk.kind === "class"
      );

      expect(results.every(r => r.chunk.kind === "class")).toBe(true);
    });
  });

  describe("batch operations", () => {
    it("should handle batch insert efficiently", async () => {
      const entries: VectorEntry[] = [];
      
      for (let i = 0; i < 100; i++) {
        entries.push({
          id: `batch-${i}`,
          vector: createRandomVector(dimensions),
          chunk: createMockChunk(`batch-${i}`, `Content ${i}`),
          addedAt: Date.now(),
          accessCount: 0,
        });
      }

      const startTime = Date.now();
      await store.upsertBatch(entries);
      const duration = Date.now() - startTime;

      expect(store.count()).toBe(100);
      expect(duration).toBeLessThan(10000); // Should complete within 10 seconds
    });
  });

  describe("persistence", () => {
    it("should save and load index", async () => {
      const entries: VectorEntry[] = [
        { id: "test-1", vector: createRandomVector(dimensions), chunk: createMockChunk("test-1", "A"), addedAt: Date.now(), accessCount: 0 },
        { id: "test-2", vector: createRandomVector(dimensions), chunk: createMockChunk("test-2", "B"), addedAt: Date.now(), accessCount: 0 },
      ];

      await store.upsert(entries);
      
      const savePath = join(tempDir, "saved-index");
      await store.saveIndex(savePath);

      // Verify files exist
      expect(existsSync(join(savePath, "hnsw.index"))).toBe(true);
      expect(existsSync(join(savePath, "metadata.json"))).toBe(true);

      // Create new store and load
      const newStore = new HNSWVectorStore(savePath, {
        dimensions,
        maxElements: 100,
        M: 8,
        efConstruction: 50,
        efSearch: 32,
        metric: "cosine",
      });

      await newStore.initialize();
      
      expect(newStore.count()).toBe(2);
      expect(newStore.has("test-1")).toBe(true);
      expect(newStore.has("test-2")).toBe(true);

      await newStore.shutdown();
    });
  });

  describe("statistics", () => {
    it("should return HNSW statistics", () => {
      const stats = store.getHNSWStats();

      expect(stats.elementCount).toBe(0); // Empty store
      expect(stats.maxElements).toBe(1000);
      expect(stats.config.dimensions).toBe(dimensions);
      expect(stats.totalSearches).toBe(0);
    });

    it("should track search times", async () => {
      // Add some data
      await store.upsert([
        { id: "test-1", vector: createRandomVector(dimensions), chunk: createMockChunk("test-1", "A"), addedAt: Date.now(), accessCount: 0 },
      ]);

      // Perform searches
      const query = createRandomVector(dimensions);
      for (let i = 0; i < 5; i++) {
        await store.search(query, 1);
      }

      const stats = store.getHNSWStats();
      expect(stats.totalSearches).toBe(5);
      expect(stats.avgSearchTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should report memory usage", () => {
      const usage = store.getMemoryUsage();
      expect(usage).toBeGreaterThanOrEqual(0);
    });
  });

  describe("file chunk tracking", () => {
    it("should track chunks per file", async () => {
      await store.upsert([
        { id: "file1-a", vector: createRandomVector(dimensions), chunk: createMockChunk("file1-a", "A", "/test/file1.cs"), addedAt: Date.now(), accessCount: 0 },
        { id: "file1-b", vector: createRandomVector(dimensions), chunk: createMockChunk("file1-b", "B", "/test/file1.cs"), addedAt: Date.now(), accessCount: 0 },
        { id: "file2-a", vector: createRandomVector(dimensions), chunk: createMockChunk("file2-a", "C", "/test/file2.cs"), addedAt: Date.now(), accessCount: 0 },
      ]);

      const file1Ids = store.getFileChunkIds("/test/file1.cs");
      expect(file1Ids).toContain("file1-a");
      expect(file1Ids).toContain("file1-b");
      expect(file1Ids).not.toContain("file2-a");
    });
  });

  describe("migration", () => {
    it("should migrate from legacy format", async () => {
      // Create legacy format files
      const legacyDir = join(tempDir, "legacy");
      mkdirSync(legacyDir, { recursive: true });

      // Create legacy chunks.json
      const chunks: CodeChunk[] = [
        {
          id: "legacy-1",
          filePath: "/test/legacy.cs",
          content: "public class Legacy {}",
          startLine: 1,
          endLine: 1,
          kind: "class",
          contentHash: "abc",
          indexedAt: Date.now(),
          language: "csharp",
        },
        {
          id: "legacy-2",
          filePath: "/test/legacy.cs",
          content: "public void Method() {}",
          startLine: 2,
          endLine: 2,
          kind: "method",
          contentHash: "def",
          indexedAt: Date.now(),
          language: "csharp",
        },
      ];

      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(legacyDir, "chunks.json"), JSON.stringify(chunks), "utf8");

      // Create legacy vectors.bin (2 vectors of 'dimensions' length)
      const vectors = new Float32Array(dimensions * 2);
      for (let i = 0; i < dimensions; i++) {
        vectors[i] = Math.random();
        vectors[dimensions + i] = Math.random();
      }
      const buf = Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength);
      writeFileSync(join(legacyDir, "vectors.bin"), buf);

      // Create store pointing to legacy directory
      const migrationStore = new HNSWVectorStore(legacyDir, {
        dimensions,
        maxElements: 100,
        M: 8,
        efConstruction: 50,
        efSearch: 32,
        metric: "cosine",
      });

      // Initialize should trigger migration
      await migrationStore.initialize();

      // Should have migrated the data
      expect(migrationStore.count()).toBe(2);
      expect(migrationStore.has("legacy-1")).toBe(true);
      expect(migrationStore.has("legacy-2")).toBe(true);

      // Legacy files should be removed and backup created
      expect(existsSync(join(legacyDir, "vectors.bin"))).toBe(false);
      expect(existsSync(join(legacyDir, "chunks.json"))).toBe(false);
      expect(existsSync(join(legacyDir, "legacy-backup"))).toBe(true);

      await migrationStore.shutdown();
    });
  });
});


