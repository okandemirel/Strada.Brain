import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createLogger, getLogger } from "../../utils/logger.js";

// Initialize logger for tests
beforeAll(() => {
  createLogger("error", "test.log");
});

import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { HNSWVectorStore, createHNSWVectorStore, isHnswAvailable } from "./hnsw-vector-store.js";
import type { VectorEntry, CodeChunk } from "../rag.interface.js";

const describeIfHnsw = isHnswAvailable() ? describe : describe.skip;

describeIfHnsw("HNSWVectorStore", () => {
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

  function fileEntries(name: string, n: number): VectorEntry[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `${name}-${i}`,
      vector: createRandomVector(dimensions),
      chunk: createMockChunk(`${name}-${i}`, `${name} ${i}`, `/test/${name}.cs`),
      addedAt: Date.now(),
      accessCount: 0,
    }));
  }

  const reopen = (): Promise<HNSWVectorStore> =>
    createHNSWVectorStore(tempDir, {
      dimensions, maxElements: 1000, M: 8, efConstruction: 50, efSearch: 32, metric: "cosine", quantization: "none",
    });

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

    it("keeps live non-quantized vectors after background compaction", async () => {
      const entries: VectorEntry[] = [];
      for (let i = 0; i < 10; i++) {
        const vec = new Array(dimensions).fill(0);
        vec[i] = 1;
        entries.push({
          id: `compact-${i}`,
          vector: vec,
          chunk: createMockChunk(`compact-${i}`, `Content ${i}`),
          addedAt: Date.now(),
          accessCount: 0,
        });
      }
      await store.upsert(entries);

      await store.remove(["compact-0", "compact-1", "compact-2", "compact-3"]);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(store.count()).toBe(6);
      expect(store.has("compact-9")).toBe(true);
      const query = new Array(dimensions).fill(0);
      query[9] = 1;
      const results = await store.search(query, 3);
      expect(results.some((hit) => hit.id === "compact-9")).toBe(true);
    });
  });

  describe("background compaction serialization (M1)", () => {
    function compactionEntries(n: number): VectorEntry[] {
      const entries: VectorEntry[] = [];
      for (let i = 0; i < n; i++) {
        const vec = new Array(dimensions).fill(0);
        vec[i] = 1;
        entries.push({
          id: `m1-${i}`,
          vector: vec,
          chunk: createMockChunk(`m1-${i}`, `Content ${i}`),
          addedAt: Date.now(),
          accessCount: 0,
        });
      }
      return entries;
    }

    it("runs the deleted-ratio rebuild through the injected write serializer", async () => {
      await store.upsert(compactionEntries(5));

      let lockCalls = 0;
      let lastLock: Promise<unknown> | undefined;
      store.setWriteSerializer({
        withLock: (fn: () => Promise<unknown>) => {
          lockCalls++;
          lastLock = Promise.resolve().then(fn);
          return lastLock;
        },
      } as any);

      // Remove 2 of 5 → deleted ratio 0.4 > 0.3 triggers background compaction.
      await store.remove(["m1-0", "m1-1"]);
      await lastLock; // wait for the fire-and-forget, serializer-gated rebuild

      // TEETH: the unfixed code scheduled the rebuild via setImmediate(rebuildIndex)
      // and never touched the serializer, so lockCalls would stay 0.
      expect(lockCalls).toBe(1);
      expect(store.count()).toBe(3);
      expect(store.has("m1-4")).toBe(true);
    });

    it("coalesces concurrent rebuild requests behind the rebuildScheduled guard", async () => {
      await store.upsert(compactionEntries(5));

      let lockCalls = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      store.setWriteSerializer({
        withLock: async (fn: () => Promise<unknown>) => {
          lockCalls++;
          await gate; // hold the rebuild in-flight so the guard stays set
          return fn();
        },
      } as any);

      await store.remove(["m1-0", "m1-1"]); // ratio 0.4 → schedules rebuild (guard set)
      await store.remove(["m1-2"]);         // ratio higher, but a rebuild is already pending

      // TEETH: without the rebuildScheduled guard the second remove would schedule
      // a second rebuild → lockCalls === 2.
      expect(lockCalls).toBe(1);

      release(); // let the gated rebuild complete before afterEach shutdown
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  });

  describe("background compaction with no serializer (memory-rag#4)", () => {
    it("a file removed while the rebuild is re-adding the index stays removed", async () => {
      // The 300 survivors are more than one 128-point slice, so the rebuild
      // yields with "kept" half re-added and "victim" not re-added yet.
      await store.upsert([...fileEntries("gone", 200), ...fileEntries("kept", 200), ...fileEntries("victim", 100)]);
      await store.removeByFile("/test/gone.cs"); // 200 of 500 deleted: compaction scheduled

      for (let i = 0; i < 100 && store.count() >= 300; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      // The race this test is about: the rebuild has started and not finished.
      expect(store.count()).toBeGreaterThan(0);
      expect(store.count()).toBeLessThan(300);

      await store.removeByFile("/test/victim.cs");
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(store.getFileChunkIds("/test/victim.cs")).toEqual([]);
      expect(store.count()).toBe(200);
    });

    it("an entry written while the rebuild runs is the one the id keeps", async () => {
      await store.upsert([...fileEntries("gone", 200), ...fileEntries("kept", 300)]);
      await store.removeByFile("/test/gone.cs");

      for (let i = 0; i < 100 && store.count() >= 300; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(store.count()).toBeLessThan(300);

      // "kept-299" sits in the slice the rebuild has not re-added yet.
      const fresh = fileEntries("kept", 300)[299]!;
      fresh.chunk = { ...fresh.chunk, content: "fresh body" };
      await store.upsert([fresh]);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(store.count()).toBe(300);
      const hits = await store.search(fresh.vector, 1);
      expect(hits[0]?.id).toBe("kept-299");
      expect(hits[0]?.chunk.content).toBe("fresh body");
    });

    it("a shutdown while the rebuild is re-adding the index saves all of it (hnsw-shutdown)", async () => {
      await store.upsert([...fileEntries("gone", 200), ...fileEntries("a", 100), ...fileEntries("b", 100), ...fileEntries("c", 100)]);
      await store.removeByFile("/test/gone.cs");

      for (let i = 0; i < 100 && store.count() >= 300; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(store.count()).toBeGreaterThan(0);
      expect(store.count()).toBeLessThan(300);

      await store.shutdown();

      // A file cut short still carries its own content hash, so the next boot
      // takes it as indexed and never re-embeds the chunks the save left out.
      const reopened = await reopen();
      try {
        expect(reopened.count()).toBe(300);
        for (const name of ["a", "b", "c"]) {
          expect(reopened.getFileChunkIds(`/test/${name}.cs`)).toHaveLength(100);
        }
      } finally {
        await reopened.shutdown();
      }
    });

    it("a compaction that comes due while a save is writing waits for the save (hnsw-shutdown)", async () => {
      const entries = [...fileEntries("gone", 200), ...fileEntries("a", 100), ...fileEntries("b", 100), ...fileEntries("c", 100)];
      await store.upsert(entries);
      await store.removeByFile("/test/gone.cs");

      // Hold the native write open long enough for the compaction removeByFile
      // scheduled to run: it swaps in a new index and maps, so a save that
      // reads its metadata after the write pairs the old file with new labels.
      const index = (store as unknown as { hnswIndex: { writeIndex(file: string): Promise<boolean> } }).hnswIndex;
      const write = index.writeIndex.bind(index);
      // The native method is read-only on the prototype; define an own one.
      Object.defineProperty(index, "writeIndex", {
        value: async (file: string) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return write(file);
        },
      });
      await store.shutdown();

      const reopened = await reopen();
      try {
        expect(reopened.count()).toBe(300);
        for (const name of ["a", "b", "c"]) {
          const last = entries.find((e) => e.id === `${name}-99`)!;
          expect((await reopened.search(last.vector, 1))[0]?.id).toBe(`${name}-99`);
        }
      } finally {
        await reopened.shutdown();
      }
    });
  });

  describe("a save while a write is in flight (hnsw-writes-inflight)", () => {
    it("a shutdown while an upsert is parked between slices saves all of it", async () => {
      // One file of more than one 128-point slice, as RAGPipeline.indexFile
      // upserts it, under the content hash it is indexed at.
      const entries = fileEntries("big", 300).map((e) => ({
        ...e,
        chunk: { ...e.chunk, fileContentHash: "h-new" },
      }));
      // The native write runs off-thread while the parked batch resumes, so
      // what it captures depends on timing. Pin it: capture the index the
      // moment the save writes it, then stay open the way the real write does,
      // long enough for the batch to finish before the metadata is read.
      const index = (store as unknown as {
        hnswIndex: { writeIndex(file: string): Promise<boolean>; writeIndexSync(file: string): void };
      }).hnswIndex;
      Object.defineProperty(index, "writeIndex", {
        value: async (file: string) => {
          index.writeIndexSync(file);
          await new Promise((resolve) => setTimeout(resolve, 50));
          return true;
        },
      });
      const upsert = store.upsert(entries);
      await new Promise((resolve) => setImmediate(resolve));
      // The race this test is about: the batch has parked with part of the file added.
      expect(store.count()).toBeGreaterThan(0);
      expect(store.count()).toBeLessThan(300);

      await store.shutdown();
      await upsert;

      // A file cut short still carries its new content hash, so the next boot
      // takes it as indexed and never re-embeds the chunks the save left out.
      const reopened = await reopen();
      try {
        expect(reopened.listIndexedFiles()).toEqual([{ filePath: "/test/big.cs", fileContentHash: "h-new" }]);
        expect(reopened.getFileChunkIds("/test/big.cs")).toHaveLength(300);
        // The metadata is read after the native write, so it names every
        // chunk while hnsw.index holds only the slices added before the write.
        const missing: string[] = [];
        for (const entry of entries) {
          if ((await reopened.search(entry.vector, 1))[0]?.id !== entry.id) missing.push(entry.id);
        }
        expect(missing).toEqual([]);
      } finally {
        await reopened.shutdown();
      }
    });

    it("an upsert that arrives while a save is writing waits for the save", async () => {
      const a = fileEntries("a", 100);
      await store.upsert(a);

      // Hold the save open after the native write: hnsw.index already holds
      // "a" alone, and the metadata the save writes next must name only it.
      const index = (store as unknown as { hnswIndex: { writeIndex(file: string): Promise<boolean> } }).hnswIndex;
      const write = index.writeIndex.bind(index);
      let written!: () => void;
      const indexWritten = new Promise<void>((resolve) => (written = resolve));
      Object.defineProperty(index, "writeIndex", {
        value: async (file: string) => {
          const ok = await write(file);
          written();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return ok;
        },
      });
      const save = store.saveIndex(tempDir);
      await indexWritten;
      const b = fileEntries("b", 100);
      await store.upsert(b);
      await save;

      // Labels on disk without their points: the reopened store counts "b"
      // and every search for it answers with an "a" chunk.
      const reopened = await reopen();
      try {
        expect(reopened.count()).toBe(100);
        for (const entry of [...a, ...b]) {
          if (!reopened.has(entry.id)) continue;
          expect((await reopened.search(entry.vector, 1))[0]?.id).toBe(entry.id);
        }
      } finally {
        await reopened.shutdown();
      }
      expect(store.count()).toBe(200);
    });

    // Review of the fix: only upsert's wait for the save was pinned, and
    // putting the other writes back to waiting for a rebuild alone still
    // passed. The remove below stays under the compaction ratio, so no
    // rebuild runs and the save is the only thing to wait for.
    it.each([
      { write: "removeByFile", run: (s: HNSWVectorStore) => s.removeByFile("/test/b.cs") },
      { write: "remove", run: (s: HNSWVectorStore, b: VectorEntry[]) => s.remove(b.map((e) => e.id)) },
      { write: "replaceAll", run: (s: HNSWVectorStore) => s.replaceAll(fileEntries("c", 100)) },
    ])("a $write that arrives while a save is writing waits for the save", async ({ run }) => {
      const a = fileEntries("a", 100);
      const b = fileEntries("b", 40);
      await store.upsert([...a, ...b]);

      // Hold the save open after the native write: hnsw.index already holds
      // "a" and "b", and the metadata the save writes next must name both.
      const index = (store as unknown as { hnswIndex: { writeIndex(file: string): Promise<boolean> } }).hnswIndex;
      const write = index.writeIndex.bind(index);
      let written!: () => void;
      const indexWritten = new Promise<void>((resolve) => (written = resolve));
      Object.defineProperty(index, "writeIndex", {
        value: async (file: string) => {
          const ok = await write(file);
          written();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return ok;
        },
      });
      const save = store.saveIndex(tempDir);
      await indexWritten;
      await run(store, b);
      await save;

      // Otherwise the metadata, read after the native write, names what the
      // write left behind, over a hnsw.index that still holds "a" and "b".
      const reopened = await reopen();
      try {
        expect(reopened.count()).toBe(140);
        const missing: string[] = [];
        for (const entry of [...a, ...b]) {
          if ((await reopened.search(entry.vector, 1))[0]?.id !== entry.id) missing.push(entry.id);
        }
        expect(missing).toEqual([]);
      } finally {
        await reopened.shutdown();
      }
      expect(store.count()).toBe(100);
    });

    // AgentDB's stores quantize by default (scalar), and there an update
    // awaits between entries before the inserts land, so upsert counts its
    // whole body as a write in flight. Every test above runs unquantized,
    // where that loop never awaits, and dropping the count still passed.
    it("a shutdown during a scalar-quantized update-upsert saves all of it", async () => {
      const dir = mkdtempSync(join(tmpdir(), "hnsw-scalar-"));
      const config = {
        dimensions, maxElements: 1000, M: 8, efConstruction: 50, efSearch: 32, metric: "cosine" as const, quantization: "scalar" as const,
      };
      try {
        const quantized = await createHNSWVectorStore(dir, config);
        await quantized.upsert(fileEntries("u", 200));
        const updates = fileEntries("u", 200).map((e) => ({ ...e, chunk: { ...e.chunk, content: "v2" } }));
        // Pin the native write as above: capture the index the moment the
        // save writes it, then stay open long enough for the updates to end.
        const index = (quantized as unknown as {
          hnswIndex: { writeIndex(file: string): Promise<boolean>; writeIndexSync(file: string): void };
        }).hnswIndex;
        Object.defineProperty(index, "writeIndex", {
          value: async (file: string) => {
            index.writeIndexSync(file);
            await new Promise((resolve) => setTimeout(resolve, 50));
            return true;
          },
        });
        let updated = false;
        const upsert = quantized.upsert(updates).then(() => { updated = true; });
        await Promise.resolve();
        // The race this test is about: the updates are still under way.
        expect(updated).toBe(false);

        await quantized.shutdown();
        await upsert;

        const reopened = await createHNSWVectorStore(dir, config);
        try {
          expect(reopened.count()).toBe(200);
          const stale: string[] = [];
          for (const entry of updates) {
            const hit = (await reopened.search(entry.vector, 1))[0];
            if (hit?.id !== entry.id || hit.chunk.content !== "v2") stale.push(entry.id);
          }
          expect(stale).toEqual([]);
        } finally {
          await reopened.shutdown();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([
      { first: "the shutdown", saved: 300 },
      { first: "the upsert", saved: 600 },
    ])("a shutdown and an upsert both waiting out a rebuild do not overlap, $first first", async ({ first, saved }) => {
      const kept = [...fileEntries("a", 100), ...fileEntries("b", 100), ...fileEntries("c", 100)];
      await store.upsert([...fileEntries("gone", 200), ...kept]);
      await store.removeByFile("/test/gone.cs");
      for (let i = 0; i < 100 && store.count() >= 300; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(store.count()).toBeLessThan(300);

      // Both resume when the rebuild settles, in the order they began to
      // wait. Whichever goes second has to see the first in the same turn it
      // checked: the save already holding saveInFlight, or the upsert already
      // counted in writesInFlight and the save draining it.
      const late = fileEntries("late", 300);
      await Promise.all(
        first === "the shutdown" ? [store.shutdown(), store.upsert(late)] : [store.upsert(late), store.shutdown()],
      );

      const reopened = await reopen();
      try {
        expect(reopened.count()).toBe(saved);
        const missing: string[] = [];
        for (const entry of [...kept, ...late]) {
          if (!reopened.has(entry.id)) continue;
          if ((await reopened.search(entry.vector, 1))[0]?.id !== entry.id) missing.push(entry.id);
        }
        expect(missing).toEqual([]);
      } finally {
        await reopened.shutdown();
      }
    });
  });

  describe("an id claimed by more than one index (memory-rag#1)", () => {
    it("keeps one point per id when a batch repeats an id", async () => {
      const first = createRandomVector(dimensions);
      const second = createRandomVector(dimensions);
      await store.upsert([
        { id: "ctor", vector: first, chunk: { ...createMockChunk("ctor", "as method", "/test/Big.cs"), kind: "method" }, addedAt: Date.now(), accessCount: 0 },
        { id: "ctor", vector: second, chunk: { ...createMockChunk("ctor", "as constructor", "/test/Big.cs"), kind: "constructor" }, addedAt: Date.now(), accessCount: 0 },
      ]);

      expect(store.count()).toBe(1);
      expect((await store.search(first, 5)).map((h) => h.chunk.content)).toEqual(["as constructor"]);

      await store.removeByFile("/test/Big.cs");
      expect(store.count()).toBe(0);
    });

    it("removeByFile drops the orphans an index saved by an older build still holds", async () => {
      await store.upsert([
        { id: "ctor", vector: createRandomVector(dimensions), chunk: createMockChunk("ctor", "v1 body", "/test/Big.cs"), addedAt: Date.now(), accessCount: 0 },
        { id: "other", vector: createRandomVector(dimensions), chunk: createMockChunk("other", "v2 body", "/test/Big.cs"), addedAt: Date.now(), accessCount: 0 },
      ]);
      await store.saveIndex(tempDir);
      // The shape the duplicate-id bug wrote to disk: two indices claim one
      // id, and the id maps to only the second.
      const metadataPath = join(tempDir, "metadata.json");
      const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
      metadata.indexToId = [[0, "ctor"], [1, "ctor"]];
      metadata.idToIndex = [["ctor", 1]];
      writeFileSync(metadataPath, JSON.stringify(metadata), "utf-8");

      const reloaded = await createHNSWVectorStore(tempDir, {
        dimensions, maxElements: 1000, M: 8, efConstruction: 50, efSearch: 32, metric: "cosine", quantization: "none",
      });
      expect(reloaded.count()).toBe(2);

      await reloaded.removeByFile("/test/Big.cs");

      expect(reloaded.count()).toBe(0);
      expect(await reloaded.search(createRandomVector(dimensions), 5)).toEqual([]);
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

    it("resizes loaded indexes before accepting new inserts", async () => {
      const limitedDir = join(tempDir, "limited-index");
      const limitedStore = await createHNSWVectorStore(limitedDir, {
        dimensions,
        maxElements: 1,
        M: 8,
        efConstruction: 50,
        efSearch: 32,
        metric: "cosine",
        quantization: "none",
      });

      await limitedStore.upsert([
        {
          id: "seed",
          vector: createRandomVector(dimensions),
          chunk: createMockChunk("seed", "seed content"),
          addedAt: Date.now(),
          accessCount: 0,
        },
      ]);
      await limitedStore.shutdown();

      const metadataPath = join(limitedDir, "metadata.json");
      const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as {
        config: { maxElements: number };
      };
      metadata.config.maxElements = 8;
      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

      const reloadedStore = new HNSWVectorStore(limitedDir, {
        dimensions,
        maxElements: 8,
        M: 8,
        efConstruction: 50,
        efSearch: 32,
        metric: "cosine",
        quantization: "none",
      });

      await reloadedStore.initialize();
      await expect(
        reloadedStore.upsert([
          {
            id: "next",
            vector: createRandomVector(dimensions),
            chunk: createMockChunk("next", "next content"),
            addedAt: Date.now(),
            accessCount: 0,
          },
        ]),
      ).resolves.toBeUndefined();
      expect(reloadedStore.count()).toBe(2);

      await reloadedStore.shutdown();
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

  describe("embedding size changes", () => {
    const entry = (id: string, dim: number): VectorEntry => ({
      id,
      vector: createRandomVector(dim),
      chunk: createMockChunk(id, `content ${id}`),
      addedAt: Date.now(),
      accessCount: 0,
    });

    it("a query of another size returns no hits and is logged once, not as a failed search per call", async () => {
      await store.upsert([entry("a", dimensions), entry("b", dimensions)]);
      const logger = getLogger();
      const warn = vi.spyOn(logger, "warn");
      const error = vi.spyOn(logger, "error");
      try {
        for (let i = 0; i < 3; i++) {
          expect(await store.search(createRandomVector(dimensions / 2), 2)).toEqual([]);
        }
        expect(error.mock.calls.filter(([m]) => /Search failed/.test(String(m)))).toHaveLength(0);
        expect(warn.mock.calls.filter(([m]) => /Query vector size does not match/.test(String(m)))).toHaveLength(1);
        // Right-size queries still work.
        expect((await store.search(createRandomVector(dimensions), 2)).length).toBeGreaterThan(0);
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    });

    it("resetDimensions empties the index at the new size, which then stores, searches and persists", async () => {
      await store.upsert([entry("a", dimensions), entry("b", dimensions)]);
      store.resetDimensions(dimensions / 2);

      expect(store.count()).toBe(0);
      expect(store.dimensions).toBe(dimensions / 2);
      await store.upsert([entry("c", dimensions / 2), entry("d", dimensions / 2)]);
      expect((await store.search(createRandomVector(dimensions / 2), 2)).map((h) => h.id).sort()).toEqual(["c", "d"]);

      await store.saveIndex(tempDir);
      const reopened = await createHNSWVectorStore(tempDir, { dimensions: dimensions / 2, maxElements: 1000, M: 8, efConstruction: 50, efSearch: 32 });
      try {
        expect(reopened.count()).toBe(2);
        expect(reopened.has("c")).toBe(true);
      } finally {
        await reopened.shutdown();
      }
    });

    it("resetDimensions refuses a size that is not a positive integer", () => {
      expect(() => store.resetDimensions(0)).toThrow(/Invalid vector dimensions/);
      expect(() => store.resetDimensions(1.5)).toThrow(/Invalid vector dimensions/);
      expect(store.dimensions).toBe(dimensions);
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

    it("migrates a legacy id that appears twice as one point (memory-rag#1)", async () => {
      // The legacy store appended a repeated id as a second row.
      const legacyDir = join(tempDir, "legacy-dup");
      mkdirSync(legacyDir, { recursive: true });
      const chunks: CodeChunk[] = [
        { ...createMockChunk("dup", "as method", "/test/Big.cs"), kind: "method" },
        { ...createMockChunk("dup", "as constructor", "/test/Big.cs"), kind: "constructor" },
      ];
      writeFileSync(join(legacyDir, "chunks.json"), JSON.stringify(chunks), "utf8");
      const vectors = Float32Array.from([...createRandomVector(dimensions), ...createRandomVector(dimensions)]);
      writeFileSync(join(legacyDir, "vectors.bin"), Buffer.from(vectors.buffer));

      const migrationStore = new HNSWVectorStore(legacyDir, {
        dimensions, maxElements: 100, M: 8, efConstruction: 50, efSearch: 32, metric: "cosine",
      });
      await migrationStore.initialize();

      expect(migrationStore.count()).toBe(1);
      expect(migrationStore.getFileChunkIds("/test/Big.cs")).toEqual(["dup"]);

      await migrationStore.shutdown();
    });
  });
});
