import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The FileVectorStore calls getLogger(), so we must initialise the singleton
// before importing the module under test.
vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

import { FileVectorStore } from "./vector-store.js";
import type { VectorEntry, CodeChunk } from "./rag.interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIMS = 8;

function randomVector(dims: number = DIMS): number[] {
  return Array.from({ length: dims }, () => Math.random() * 2 - 1);
}

function makeChunk(id: string, filePath: string = "/src/Foo.cs"): CodeChunk {
  return {
    id,
    filePath,
    content: `// chunk ${id}`,
    startLine: 1,
    endLine: 10,
    kind: "class",
    contentHash: `hash-${id}`,
    indexedAt: new Date().toISOString(),
  };
}

function makeEntry(
  id: string,
  filePath: string = "/src/Foo.cs",
  vector?: number[],
): VectorEntry {
  return {
    id,
    vector: vector ?? randomVector(),
    chunk: makeChunk(id, filePath),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vector-store-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FileVectorStore", () => {
  describe("initialize", () => {
    it("creates the store directory if it does not exist", async () => {
      const storePath = join(tmpDir, "new-store");
      const store = new FileVectorStore(storePath, DIMS);
      await store.initialize();

      const { existsSync } = await import("node:fs");
      expect(existsSync(storePath)).toBe(true);
    });

    it("starts with an empty store when the directory is freshly created", async () => {
      const store = new FileVectorStore(join(tmpDir, "empty"), DIMS);
      await store.initialize();

      expect(store.count()).toBe(0);
    });
  });

  describe("upsert / count", () => {
    it("adds entries and increases count", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      await store.upsert([makeEntry("a"), makeEntry("b"), makeEntry("c")]);
      expect(store.count()).toBe(3);
      await store.shutdown();
    });

    it("does nothing for an empty upsert array", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      await store.upsert([]);
      expect(store.count()).toBe(0);
      await store.shutdown();
    });
  });

  describe("search", () => {
    it("returns the correct top-K results sorted by cosine similarity descending", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      // Three entries with distinct vectors.
      const vA = [1, 0, 0, 0, 0, 0, 0, 0];
      const vB = [0, 1, 0, 0, 0, 0, 0, 0];
      const vC = [0, 0, 1, 0, 0, 0, 0, 0];

      await store.upsert([
        makeEntry("a", "/src/A.cs", vA),
        makeEntry("b", "/src/B.cs", vB),
        makeEntry("c", "/src/C.cs", vC),
      ]);

      // Query aligned with vA → "a" should rank first.
      const results = await store.search(vA, 2);
      expect(results).toHaveLength(2);
      expect(results[0]!.chunk.id).toBe("a");
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score);

      await store.shutdown();
    });

    it("returns score ~1.0 when querying with the identical stored vector", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      const vec = randomVector();
      await store.upsert([makeEntry("x", "/src/X.cs", vec)]);

      const results = await store.search(vec, 1);
      expect(results).toHaveLength(1);
      expect(results[0]!.score).toBeCloseTo(1.0, 5);

      await store.shutdown();
    });

    it("returns score ~0.0 for orthogonal vectors", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      // Unit vectors along different axes are orthogonal.
      const vStored = [1, 0, 0, 0, 0, 0, 0, 0];
      const vQuery  = [0, 1, 0, 0, 0, 0, 0, 0];

      await store.upsert([makeEntry("p", "/src/P.cs", vStored)]);

      const results = await store.search(vQuery, 1);
      expect(results).toHaveLength(1);
      expect(results[0]!.score).toBeCloseTo(0.0, 5);

      await store.shutdown();
    });

    it("returns an empty array when the store is empty", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      const results = await store.search(randomVector(), 5);
      expect(results).toHaveLength(0);

      await store.shutdown();
    });

    it("clamps results to the available count when topK exceeds count", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      await store.upsert([makeEntry("only")]);
      const results = await store.search(randomVector(), 10);
      expect(results).toHaveLength(1);

      await store.shutdown();
    });
  });

  describe("upsert existing ID (in-place update)", () => {
    it("updates the chunk and vector without adding a duplicate entry", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      const original = makeEntry("u", "/src/U.cs", [1, 0, 0, 0, 0, 0, 0, 0]);
      await store.upsert([original]);
      expect(store.count()).toBe(1);

      const updated: VectorEntry = {
        id: "u",
        vector: [0, 0, 0, 0, 0, 0, 0, 1],
        chunk: { ...makeChunk("u", "/src/U.cs"), content: "// updated" },
      };
      await store.upsert([updated]);
      expect(store.count()).toBe(1);

      // Search should now return results aligned with the new vector.
      const results = await store.search([0, 0, 0, 0, 0, 0, 0, 1], 1);
      expect(results[0]!.chunk.content).toBe("// updated");
      expect(results[0]!.score).toBeCloseTo(1.0, 5);

      await store.shutdown();
    });
  });

  describe("remove", () => {
    it("deletes entries by ID", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      await store.upsert([makeEntry("r1"), makeEntry("r2"), makeEntry("r3")]);
      expect(store.count()).toBe(3);

      await store.remove(["r1", "r3"]);
      expect(store.count()).toBe(1);
      expect(store.has("r1")).toBe(false);
      expect(store.has("r2")).toBe(true);
      expect(store.has("r3")).toBe(false);

      await store.shutdown();
    });

    it("does nothing when passed an empty array", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      await store.upsert([makeEntry("keep")]);
      await store.remove([]);
      expect(store.count()).toBe(1);

      await store.shutdown();
    });
  });

  describe("removeByFile", () => {
    it("removes all chunks belonging to the given file", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      await store.upsert([
        makeEntry("f1-a", "/src/File1.cs"),
        makeEntry("f1-b", "/src/File1.cs"),
        makeEntry("f2-a", "/src/File2.cs"),
      ]);
      expect(store.count()).toBe(3);

      await store.removeByFile("/src/File1.cs");
      expect(store.count()).toBe(1);
      expect(store.has("f1-a")).toBe(false);
      expect(store.has("f1-b")).toBe(false);
      expect(store.has("f2-a")).toBe(true);

      await store.shutdown();
    });

    it("does nothing for an unknown file path", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      await store.upsert([makeEntry("x")]);
      await store.removeByFile("/no/such/file.cs");
      expect(store.count()).toBe(1);

      await store.shutdown();
    });
  });

  describe("persistence", () => {
    it("persists data across shutdown and re-initialization", async () => {
      const storePath = join(tmpDir, "persist");

      // Write data with first instance.
      const store1 = new FileVectorStore(storePath, DIMS);
      await store1.initialize();
      const vec = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
      await store1.upsert([makeEntry("p1", "/src/P.cs", vec)]);
      await store1.shutdown();

      // Read data with second instance.
      const store2 = new FileVectorStore(storePath, DIMS);
      await store2.initialize();

      expect(store2.count()).toBe(1);
      expect(store2.has("p1")).toBe(true);

      // Search should still work correctly.
      const results = await store2.search(vec, 1);
      expect(results[0]!.chunk.id).toBe("p1");
      expect(results[0]!.score).toBeCloseTo(1.0, 5);

      await store2.shutdown();
    });

    it("refuses a chunks.json and vectors.bin from different saves instead of mispairing them (MEM-13)", async () => {
      const storePath = join(tmpDir, "torn");
      const store1 = new FileVectorStore(storePath, DIMS);
      await store1.initialize();
      await store1.upsert([makeEntry("a", "/src/A.cs"), makeEntry("b", "/src/B.cs")]);
      await store1.shutdown();
      const olderChunks = readFileSync(join(storePath, "chunks.json"));

      // Re-index A: its chunk leaves and comes back at the end, so the order
      // (and every vector position) changes while the count stays 2.
      const store2 = new FileVectorStore(storePath, DIMS);
      await store2.initialize();
      await store2.removeByFile("/src/A.cs");
      await store2.upsert([makeEntry("a2", "/src/A.cs")]);
      await store2.shutdown();

      // A crash between the two file writes: new vectors, old chunk list.
      writeFileSync(join(storePath, "chunks.json"), olderChunks);

      const store3 = new FileVectorStore(storePath, DIMS);
      await store3.initialize();
      expect(store3.count()).toBe(0);
      const names = readdirSync(storePath);
      expect(names.some((n) => n.startsWith("chunks.json.corrupt-"))).toBe(true);
      expect(names.some((n) => n.startsWith("vectors.bin.corrupt-"))).toBe(true);
      await store3.shutdown();
    });

    it("refuses a vectors.bin whose size does not match the chunk count, and keeps the files", async () => {
      const storePath = join(tmpDir, "short");
      const store1 = new FileVectorStore(storePath, DIMS);
      await store1.initialize();
      await store1.upsert([makeEntry("a"), makeEntry("b")]);
      await store1.shutdown();
      const vectors = readFileSync(join(storePath, "vectors.bin"));
      writeFileSync(join(storePath, "vectors.bin"), vectors.subarray(0, DIMS * 4));

      const store2 = new FileVectorStore(storePath, DIMS);
      await store2.initialize();
      expect(store2.count()).toBe(0);
      const aside = readdirSync(storePath).find((n) => n.startsWith("vectors.bin.corrupt-"));
      expect(aside).toBeDefined();
      expect(readFileSync(join(storePath, aside!)).byteLength).toBe(DIMS * 4);
      await store2.shutdown();
    });
  });

  describe("listIndexedFiles()", () => {
    it("reports each indexed file with the file hash its chunks carry, across a restart (D46)", async () => {
      const storePath = join(tmpDir, "indexed-files");
      const store1 = new FileVectorStore(storePath, DIMS);
      await store1.initialize();
      await store1.upsert([
        { ...makeEntry("a1", "/src/A.cs"), chunk: { ...makeChunk("a1", "/src/A.cs"), fileContentHash: "aaaa111122223333" } },
        { ...makeEntry("a2", "/src/A.cs"), chunk: { ...makeChunk("a2", "/src/A.cs"), fileContentHash: "aaaa111122223333" } },
        // B.cs predates the stamp: the store must not invent a hash for it.
        makeEntry("b1", "/src/B.cs"),
      ]);
      await store1.shutdown();

      const store2 = new FileVectorStore(storePath, DIMS);
      await store2.initialize();

      const indexed = store2.listIndexedFiles();
      expect(indexed).toHaveLength(2);
      expect(indexed).toEqual(
        expect.arrayContaining([
          { filePath: "/src/A.cs", fileContentHash: "aaaa111122223333" },
          { filePath: "/src/B.cs" },
        ]),
      );

      await store2.shutdown();
    });
  });

  describe("has() and getFileChunkIds()", () => {
    it("has() returns true for inserted IDs and false for unknown ones", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      await store.upsert([makeEntry("known")]);
      expect(store.has("known")).toBe(true);
      expect(store.has("unknown")).toBe(false);

      await store.shutdown();
    });

    it("getFileChunkIds() returns all IDs for a given file", async () => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();

      await store.upsert([
        makeEntry("id-1", "/src/Target.cs"),
        makeEntry("id-2", "/src/Target.cs"),
        makeEntry("id-3", "/src/Other.cs"),
      ]);

      const ids = store.getFileChunkIds("/src/Target.cs");
      expect(ids).toHaveLength(2);
      expect(ids).toContain("id-1");
      expect(ids).toContain("id-2");

      expect(store.getFileChunkIds("/src/Other.cs")).toEqual(["id-3"]);
      expect(store.getFileChunkIds("/src/NoSuch.cs")).toEqual([]);

      await store.shutdown();
    });
  });

  describe("HNSW search after removals (regression)", () => {
    it("does not crash when searching after the entry point / neighbors are removed", async () => {
      // A zero scan budget forces the HNSW search path (FileVectorStore.search).
      const store = new FileVectorStore(tmpDir, DIMS, { exactScanMaxFloats: 0 });
      await store.initialize();

      const entries = Array.from({ length: 200 }, (_, i) =>
        makeEntry(`v${i}`, "/src/Big.cs", randomVector()),
      );
      await store.upsert(entries);
      await store.search(randomVector(), 10); // builds the graph before the removals

      // Remove the earliest 50 ids — these include the HNSW entry point and are
      // dense neighbors of the survivors, still referenced by the survivors'
      // connection lists.
      await store.remove(Array.from({ length: 50 }, (_, i) => `v${i}`));
      expect(store.count()).toBe(150);

      // Several queries must complete without throwing and only reference live ids.
      for (let q = 0; q < 5; q++) {
        const results = await store.search(randomVector(), 10);
        for (const r of results) {
          expect(store.has(r.id)).toBe(true);
        }
      }

      await store.shutdown();
    });
  });

  // An unscoped code_search past 100 chunks was answered by the JS HNSW graph
  // whenever hnswlib-node was missing. Its pruning kept each node's oldest
  // links and dropped the new one, so a search reached ~35 nodes and the exact
  // top 8 showed up 1-13% of the time: the answers were close to random.
  // `exactScanMaxFloats: 0` makes these stores search through the graph.
  describe("HNSW recall against an exact scan", () => {
    const K = 8;
    const QUERIES = 40;
    const GRAPH = { exactScanMaxFloats: 0 };

    function seeded(seed: number): () => number {
      return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    }

    function cosine(a: number[], b: number[]): number {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
      return dot / Math.sqrt(na * nb);
    }

    async function recall(store: FileVectorStore, live: VectorEntry[], nextQuery: () => number[]) {
      let found = 0;
      for (let q = 0; q < QUERIES; q++) {
        const query = nextQuery();
        const exact = live
          .map((e) => ({ id: e.id, s: cosine(query, e.vector) }))
          .sort((a, b) => b.s - a.s)
          .slice(0, K)
          .map((e) => e.id);
        const hits = await store.search(query, K);
        const ids = new Set(hits.map((h) => h.id));
        found += exact.filter((id) => ids.has(id)).length;
      }
      return found / (QUERIES * K);
    }

    it.each([
      [400, 8],
      [2000, 8],
      [2000, 64],
    ])("finds the exact top 8 among %i chunks at %i dims", async (n, dims) => {
      const store = new FileVectorStore(tmpDir, dims, GRAPH);
      await store.initialize();
      const next = seeded(11);
      const entries = Array.from({ length: n }, (_, i) =>
        makeEntry(`v${i}`, `/src/F${i % 50}.cs`, Array.from({ length: dims }, next)),
      );
      await store.upsert(entries);

      expect(await recall(store, entries, () => Array.from({ length: dims }, next))).toBeGreaterThanOrEqual(0.9);
      await store.shutdown();
    });

    // Chunks of one file embed close together and are indexed together.
    // Linking each node to its nearest neighbours alone joins every cluster
    // to nothing but itself (0.74-0.88 here), so this one asks for more.
    it("finds the exact top 8 among 4000 chunks of 40 files indexed file by file", async () => {
      const dims = 8;
      const store = new FileVectorStore(tmpDir, dims, GRAPH);
      await store.initialize();
      const next = seeded(5);
      const centers = Array.from({ length: 40 }, () => Array.from({ length: dims }, next));
      const entries = Array.from({ length: 4000 }, (_, i) => {
        const file = Math.floor(i / 100);
        return makeEntry(`v${i}`, `/src/F${file}.cs`, centers[file]!.map((c) => c + 0.15 * next()));
      });
      await store.upsert(entries);

      let q = 0;
      const nearAFile = () => centers[q++ % 40]!.map((c) => c + 0.2 * next());
      expect(await recall(store, entries, nearAFile)).toBeGreaterThanOrEqual(0.95);
      await store.shutdown();
    });

    // Re-indexing removes a file's chunks and upserts new ones. A removed
    // node must stay a waypoint to the nodes reached through it (made
    // impassable, recall here fell to 0.66-0.71), and a re-vectored one must
    // be linked where it now sits (left at its old links: 0.85, and 9-11 of 40
    // moved chunks found at their new vector).
    it("keeps its recall as files are removed and chunks re-vectored", async () => {
      const dims = 8;
      const store = new FileVectorStore(tmpDir, dims, GRAPH);
      await store.initialize();
      const next = seeded(23);
      const centers = Array.from({ length: 40 }, () => Array.from({ length: dims }, next));
      const near = (file: number, spread: number) => centers[file]!.map((c) => c + spread * next());
      const fileOf = (e: VectorEntry) => Number(e.chunk.filePath.match(/F(\d+)/)![1]);
      const entries = Array.from({ length: 3000 }, (_, i) =>
        makeEntry(`v${i}`, `/src/F${Math.floor(i / 75)}.cs`, near(Math.floor(i / 75), 0.15)),
      );
      await store.upsert(entries);
      let q = 0;
      const nearAFile = () => near(q++ % 40, 0.2);
      await store.search(nearAFile(), K); // builds the graph before the edits

      for (let f = 0; f < 16; f++) await store.removeByFile(`/src/F${f}.cs`);
      const moved = entries
        .slice(1200)
        .filter((_, i) => i % 20 === 0)
        .map((e, j) => makeEntry(e.id, e.chunk.filePath, near((j * 7) % 40, 0.15)));
      await store.upsert(moved);

      const live = new Map(entries.slice(1200).map((e) => [e.id, e]));
      for (const e of moved) live.set(e.id, e);
      expect(store.count()).toBe(live.size);
      expect(await recall(store, [...live.values()], nearAFile)).toBeGreaterThanOrEqual(0.95);
      let movedFound = 0;
      for (const e of moved.slice(0, 40)) {
        if ((await store.search(e.vector, K)).some((h) => h.id === e.id)) movedFound++;
      }
      expect(movedFound).toBeGreaterThanOrEqual(36);

      // Past half removed, the graph is rebuilt from the live chunks.
      for (let f = 16; f < 30; f++) await store.removeByFile(`/src/F${f}.cs`);
      const rest = [...live.values()].filter((e) => fileOf(e) >= 30);
      expect(store.count()).toBe(rest.length);
      expect(await recall(store, rest, nearAFile)).toBeGreaterThanOrEqual(0.95);
      await store.shutdown();
    });

    // Below EXACT_SCAN_MAX_FLOATS a search scans every vector: exact answers,
    // and no graph to build on every boot.
    it("answers a store under the scan budget exactly", async () => {
      const dims = 64;
      const store = new FileVectorStore(tmpDir, dims);
      await store.initialize();
      const next = seeded(31);
      const entries = Array.from({ length: 2000 }, (_, i) =>
        makeEntry(`v${i}`, `/src/F${i % 50}.cs`, Array.from({ length: dims }, next)),
      );
      await store.upsert(entries);

      expect(await recall(store, entries, () => Array.from({ length: dims }, next))).toBe(1);
      await store.shutdown();
    });
  });

  // A file-scoped code_search ranks the whole store (topK = count) and then
  // filters by path. Past 100 chunks the JS HNSW graph answered it: its
  // pruning leaves most nodes unreachable, so 36 of 400 chunks came back and
  // a scoped search answered "No results found" about its exact nearest
  // neighbour whenever hnswlib-node was missing. The exact scan, asked for
  // every chunk, handed them back unsorted.
  describe("search asking for every chunk", () => {
    it.each([40, 400])("returns all %i chunks, best first", async (n) => {
      const store = new FileVectorStore(tmpDir, DIMS);
      await store.initialize();
      let seed = 7;
      const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
      const entries = Array.from({ length: n }, (_, i) =>
        makeEntry(`v${i}`, `/src/F${i}.cs`, Array.from({ length: DIMS }, next)),
      );
      await store.upsert(entries);

      const query = entries[23]!.vector;
      const hits = await store.search(query, store.count());

      expect(hits).toHaveLength(n);
      expect(new Set(hits.map((h) => h.id)).size).toBe(n);
      expect(hits[0]!.id).toBe("v23");
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
      }

      await store.shutdown();
    });
  });
});
