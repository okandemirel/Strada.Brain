import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The FileVectorStore calls getLogger(), so we must initialise the singleton
// before importing the module under test.
vi.mock("../utils/logger.js", () => ({
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
});
