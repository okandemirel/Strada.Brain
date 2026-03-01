import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  IEmbeddingProvider,
  IVectorStore,
  VectorSearchHit,
  VectorEntry,
  CodeChunk,
  EmbeddingResult,
} from "./rag.interface.js";

// ---------------------------------------------------------------------------
// Mock the logger so RAGPipeline (and any transitive deps) never throw.
// ---------------------------------------------------------------------------
vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

// ---------------------------------------------------------------------------
// Mock the chunker so indexFile tests are deterministic.
// We expose a mutable array so individual tests can control what chunks are
// produced without re-importing the module.
// ---------------------------------------------------------------------------
const mockChunks: CodeChunk[] = [];

vi.mock("./chunker.js", () => ({
  chunkCSharpFile: (_filePath: string, _content: string): CodeChunk[] => {
    return [...mockChunks];
  },
}));

import { RAGPipeline } from "./rag-pipeline.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A deterministic embedding provider: each text gets a unit vector based on
 *  its index position in the batch, so results are reproducible.  */
function makeEmbeddingProvider(dims = 4): IEmbeddingProvider {
  return {
    name: "mock-embedder",
    dimensions: dims,
    embed: vi.fn(async (texts: string[]): Promise<EmbeddingResult> => {
      const embeddings = texts.map((_, i) => {
        const vec = new Array<number>(dims).fill(0);
        vec[i % dims] = 1;
        return vec;
      });
      return { embeddings, usage: { totalTokens: texts.length * 10 } };
    }),
  };
}

function makeVectorStore(): IVectorStore {
  const store: Map<string, { vector: number[]; chunk: CodeChunk }> = new Map();
  const fileIndex: Map<string, Set<string>> = new Map();

  function addToFileIndex(filePath: string, id: string): void {
    let s = fileIndex.get(filePath);
    if (!s) {
      s = new Set();
      fileIndex.set(filePath, s);
    }
    s.add(id);
  }

  return {
    initialize: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),

    upsert: vi.fn(async (entries: VectorEntry[]): Promise<void> => {
      for (const e of entries) {
        store.set(e.id, { vector: e.vector, chunk: e.chunk });
        addToFileIndex(e.chunk.filePath, e.id);
      }
    }),

    remove: vi.fn(async (ids: string[]): Promise<void> => {
      for (const id of ids) {
        const entry = store.get(id);
        if (entry) {
          fileIndex.get(entry.chunk.filePath)?.delete(id);
        }
        store.delete(id);
      }
    }),

    removeByFile: vi.fn(async (filePath: string): Promise<void> => {
      const ids = fileIndex.get(filePath);
      if (!ids) return;
      for (const id of ids) store.delete(id);
      fileIndex.delete(filePath);
    }),

    search: vi.fn(async (_queryVector: number[], topK: number): Promise<VectorSearchHit[]> => {
      const hits: VectorSearchHit[] = Array.from(store.values()).map(({ chunk }, i) => ({
        chunk,
        score: 1 - i * 0.05, // deterministic descending scores
      }));
      return hits.slice(0, topK);
    }),

    count: vi.fn((): number => store.size),
    has: vi.fn((id: string): boolean => store.has(id)),
    getFileChunkIds: vi.fn((filePath: string): string[] => {
      const s = fileIndex.get(filePath);
      return s ? Array.from(s) : [];
    }),
  };
}

function makeChunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
  return {
    id: "chunk-1",
    filePath: "Assets/Foo.cs",
    content: "public class Foo { }",
    startLine: 1,
    endLine: 5,
    kind: "class",
    contentHash: "abc123",
    indexedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSearchHit(score: number, overrides: Partial<CodeChunk> = {}): VectorSearchHit {
  return { score, chunk: makeChunk(overrides) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RAGPipeline", () => {
  let embeddingProvider: IEmbeddingProvider;
  let vectorStore: IVectorStore;
  let pipeline: RAGPipeline;

  beforeEach(() => {
    embeddingProvider = makeEmbeddingProvider();
    vectorStore = makeVectorStore();
    pipeline = new RAGPipeline(embeddingProvider, vectorStore);
    // Reset shared mutable state between tests.
    mockChunks.length = 0;
  });

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  describe("search", () => {
    it("returns reranked results from the vector store", async () => {
      // Populate the store with two chunks via the mock.
      const chunkA = makeChunk({ id: "a", content: "damage system", kind: "class" });
      const chunkB = makeChunk({ id: "b", content: "movement logic", kind: "method" });

      // Override search to return these two hits.
      vi.mocked(vectorStore.search).mockResolvedValueOnce([
        { chunk: chunkA, score: 0.9 },
        { chunk: chunkB, score: 0.5 },
      ]);

      const results = await pipeline.search("damage system");

      expect(results.length).toBeGreaterThan(0);
      // The first result should have a finalScore property.
      expect(results[0]).toHaveProperty("finalScore");
      expect(results[0]).toHaveProperty("vectorScore");
      expect(results[0]).toHaveProperty("chunk");
    });

    it("filters out results below minScore", async () => {
      const chunkA = makeChunk({ id: "a", content: "health component", kind: "class" });
      const chunkB = makeChunk({ id: "b", content: "input handler", kind: "method" });

      vi.mocked(vectorStore.search).mockResolvedValueOnce([
        { chunk: chunkA, score: 0.9 },
        { chunk: chunkB, score: 0.01 }, // very low — will be below any reasonable minScore after reranking
      ]);

      const results = await pipeline.search("health", { minScore: 0.5 });

      // Only chunkA's reranked score should pass the threshold.
      for (const r of results) {
        expect(r.finalScore).toBeGreaterThanOrEqual(0.5);
      }
    });

    it("filters candidates by kinds before reranking", async () => {
      const classChunk = makeChunk({ id: "cls", kind: "class", content: "public class Foo {}" });
      const methodChunk = makeChunk({ id: "mth", kind: "method", content: "void Update() {}" });

      vi.mocked(vectorStore.search).mockResolvedValueOnce([
        { chunk: classChunk, score: 0.8 },
        { chunk: methodChunk, score: 0.75 },
      ]);

      const results = await pipeline.search("foo", { kinds: ["class"] });

      expect(results.every((r) => r.chunk.kind === "class")).toBe(true);
      expect(results.find((r) => r.chunk.id === "mth")).toBeUndefined();
    });

    it("slices results to topK", async () => {
      const hits: VectorSearchHit[] = Array.from({ length: 20 }, (_, i) =>
        makeSearchHit(1 - i * 0.04, { id: `chunk-${i}`, content: `content ${i}` })
      );

      vi.mocked(vectorStore.search).mockResolvedValueOnce(hits);

      const results = await pipeline.search("query", { topK: 3, minScore: 0 });

      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  // -------------------------------------------------------------------------
  // formatContext
  // -------------------------------------------------------------------------

  describe("formatContext", () => {
    it("produces markdown with fenced code blocks for each result", () => {
      const results = [
        {
          chunk: makeChunk({ id: "c1", filePath: "Assets/Foo.cs", startLine: 1, endLine: 10, kind: "class", symbol: "Foo", content: "public class Foo {}" }),
          vectorScore: 0.9,
          finalScore: 0.85,
        },
      ];

      const output = pipeline.formatContext(results);

      expect(output).toContain("```csharp");
      expect(output).toContain("```");
      expect(output).toContain("public class Foo {}");
      expect(output).toContain("Assets/Foo.cs");
    });

    it("respects token budget and drops lowest-scored chunks when over budget", () => {
      // Two chunks: both would exceed a very small budget together.
      // Only the first (highest score) should appear.
      // We distinguish them by their unique symbol name so it appears in the header.
      const longContent = "x".repeat(500);
      const results = [
        {
          chunk: makeChunk({ id: "high", symbol: "HighScoreSystem", content: longContent }),
          vectorScore: 0.9,
          finalScore: 0.9,
        },
        {
          chunk: makeChunk({ id: "low", symbol: "LowScoreHelper", content: longContent }),
          vectorScore: 0.4,
          finalScore: 0.4,
        },
      ];

      // maxTokens * 4 = 600 chars; first chunk (500 chars) fits, second (500) doesn't.
      const output = pipeline.formatContext(results, {
        maxTokens: 150,
        truncationStrategy: "drop_lowest",
        contextLines: 2,
      });

      // The high chunk's symbol should appear in the header; the low chunk's should not.
      expect(output).toContain("HighScoreSystem");
      expect(output).not.toContain("LowScoreHelper");
    });

    it("returns an empty string for an empty results array", () => {
      expect(pipeline.formatContext([])).toBe("");
    });

    it("includes score annotation in the output header", () => {
      const results = [
        {
          chunk: makeChunk({ id: "c1", content: "public class Bar {}" }),
          vectorScore: 0.75,
          finalScore: 0.82,
        },
      ];

      const output = pipeline.formatContext(results);

      expect(output).toContain("0.820");
    });
  });

  // -------------------------------------------------------------------------
  // indexFile
  // -------------------------------------------------------------------------

  describe("indexFile", () => {
    it("skips indexing when the file content has not changed (same hash)", async () => {
      const content = "public class Foo {}";

      // Provide one chunk so the first call actually indexes.
      mockChunks.push(makeChunk({ id: "foo-1" }));

      const firstCount = await pipeline.indexFile("Assets/Foo.cs", content);
      expect(firstCount).toBe(1);

      // Clear mock chunks so a re-index would produce nothing — but the
      // pipeline should short-circuit before reaching the chunker.
      mockChunks.length = 0;
      mockChunks.push(makeChunk({ id: "foo-1-new" }));

      const secondCount = await pipeline.indexFile("Assets/Foo.cs", content);

      // Same content hash → returns 0 without re-indexing.
      expect(secondCount).toBe(0);
    });

    it("re-indexes when the file content changes", async () => {
      const original = "public class Foo {}";
      const updated = "public class Foo { void NewMethod() {} }";

      // First index
      mockChunks.push(makeChunk({ id: "chunk-orig" }));
      const firstCount = await pipeline.indexFile("Assets/Foo.cs", original);
      expect(firstCount).toBe(1);

      // Change the content — the hash will differ.
      mockChunks.length = 0;
      mockChunks.push(makeChunk({ id: "chunk-new-1" }));
      mockChunks.push(makeChunk({ id: "chunk-new-2" }));

      const secondCount = await pipeline.indexFile("Assets/Foo.cs", updated);
      expect(secondCount).toBe(2);

      // removeByFile should have been called to clear stale vectors.
      expect(vectorStore.removeByFile).toHaveBeenCalledWith("Assets/Foo.cs");
    });
  });
});
