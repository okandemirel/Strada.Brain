import { describe, it, expect, vi, beforeEach } from "vitest";
import { CachedEmbeddingProvider } from "./embedding-cache.js";
import type { IEmbeddingProvider, EmbeddingBatch } from "../rag.interface.js";

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInnerProvider(
  overrides: Partial<IEmbeddingProvider> = {},
): IEmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn<(texts: string[]) => Promise<EmbeddingBatch>>();
  return {
    name: "test-provider",
    dimensions: 128,
    embed,
    ...overrides,
  } as IEmbeddingProvider & { embed: ReturnType<typeof vi.fn> };
}

function makeEmbedding(seed: number, dims = 128): number[] {
  return Array.from({ length: dims }, (_, i) => (seed + i) / 1000);
}

function makeEmbedResult(embeddings: number[][], totalTokens = 10): EmbeddingBatch {
  return { embeddings, usage: { totalTokens } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CachedEmbeddingProvider", () => {
  let inner: ReturnType<typeof makeInnerProvider>;
  let cached: CachedEmbeddingProvider;

  beforeEach(() => {
    inner = makeInnerProvider();
    cached = new CachedEmbeddingProvider(inner, { maxCacheSize: 100 });
  });

  // -------------------------------------------------------------------------
  // Passthrough properties
  // -------------------------------------------------------------------------

  it("exposes the inner provider's name", () => {
    expect(cached.name).toBe("test-provider");
  });

  it("exposes the inner provider's dimensions", () => {
    expect(cached.dimensions).toBe(128);
  });

  // -------------------------------------------------------------------------
  // Cache miss — delegates to inner provider
  // -------------------------------------------------------------------------

  it("delegates to inner provider on cache miss", async () => {
    const embedding = makeEmbedding(1);
    inner.embed.mockResolvedValueOnce(makeEmbedResult([embedding], 5));

    const result = await cached.embed(["hello"]);

    expect(inner.embed).toHaveBeenCalledOnce();
    expect(inner.embed).toHaveBeenCalledWith(["hello"]);
    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]).toEqual(embedding);
    expect(result.usage.totalTokens).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Cache hit — avoids inner provider call
  // -------------------------------------------------------------------------

  it("returns cached embedding on second call (cache hit)", async () => {
    const embedding = makeEmbedding(1);
    inner.embed.mockResolvedValueOnce(makeEmbedResult([embedding], 5));

    // First call — miss
    await cached.embed(["hello"]);
    // Second call — hit
    const result = await cached.embed(["hello"]);

    expect(inner.embed).toHaveBeenCalledOnce(); // NOT called again
    expect(result.embeddings[0]).toEqual(embedding);
    expect(result.usage.totalTokens).toBe(0); // No tokens spent on cached result
  });

  // -------------------------------------------------------------------------
  // Mixed cache hits and misses
  // -------------------------------------------------------------------------

  it("only fetches uncached texts when some are already cached", async () => {
    const emb1 = makeEmbedding(1);
    const emb2 = makeEmbedding(2);
    const emb3 = makeEmbedding(3);

    // Cache "hello" and "world"
    inner.embed.mockResolvedValueOnce(makeEmbedResult([emb1, emb2], 10));
    await cached.embed(["hello", "world"]);

    // Now request "hello", "foo", "world" — only "foo" is uncached
    inner.embed.mockResolvedValueOnce(makeEmbedResult([emb3], 3));
    const result = await cached.embed(["hello", "foo", "world"]);

    expect(inner.embed).toHaveBeenCalledTimes(2);
    // Second call should only contain "foo"
    expect(inner.embed.mock.calls[1]![0]).toEqual(["foo"]);
    // Results should be in original order
    expect(result.embeddings[0]).toEqual(emb1); // hello (cached)
    expect(result.embeddings[1]).toEqual(emb3); // foo (fetched)
    expect(result.embeddings[2]).toEqual(emb2); // world (cached)
  });

  // -------------------------------------------------------------------------
  // Empty input
  // -------------------------------------------------------------------------

  it("returns empty result for empty input without calling inner provider", async () => {
    const result = await cached.embed([]);

    expect(inner.embed).not.toHaveBeenCalled();
    expect(result.embeddings).toHaveLength(0);
    expect(result.usage.totalTokens).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Size limits (LRU eviction)
  // -------------------------------------------------------------------------

  it("evicts oldest entries when cache exceeds maxCacheSize", async () => {
    const smallCached = new CachedEmbeddingProvider(inner, { maxCacheSize: 3 });

    // Fill cache with 3 entries
    for (let i = 0; i < 3; i++) {
      inner.embed.mockResolvedValueOnce(makeEmbedResult([makeEmbedding(i)], 1));
      await smallCached.embed([`text-${i}`]);
    }

    // Add a 4th entry — should evict the first
    inner.embed.mockResolvedValueOnce(makeEmbedResult([makeEmbedding(99)], 1));
    await smallCached.embed(["text-new"]);

    expect(inner.embed).toHaveBeenCalledTimes(4);

    // Re-request the first entry — should be a miss (evicted)
    inner.embed.mockResolvedValueOnce(makeEmbedResult([makeEmbedding(0)], 1));
    await smallCached.embed(["text-0"]);
    expect(inner.embed).toHaveBeenCalledTimes(5);
  });

  // -------------------------------------------------------------------------
  // Cache stats
  // -------------------------------------------------------------------------

  it("tracks hits and misses in cache stats", async () => {
    const emb = makeEmbedding(1);
    inner.embed.mockResolvedValueOnce(makeEmbedResult([emb], 5));

    await cached.embed(["hello"]); // miss
    await cached.embed(["hello"]); // hit
    await cached.embed(["hello"]); // hit

    const stats = cached.getCacheStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
    expect(stats.maxSize).toBe(100);
  });

  it("marks cache as dirty after fetching new embeddings", async () => {
    inner.embed.mockResolvedValueOnce(makeEmbedResult([makeEmbedding(1)], 5));

    expect(cached.getCacheStats().dirty).toBe(false);

    await cached.embed(["hello"]);

    expect(cached.getCacheStats().dirty).toBe(true);
  });

  it("reports persistPath in stats", () => {
    const withPath = new CachedEmbeddingProvider(inner, {
      persistPath: "/tmp/test-cache",
    });
    expect(withPath.getCacheStats().persistPath).toBe("/tmp/test-cache");
  });

  it("reports undefined persistPath when none set", () => {
    expect(cached.getCacheStats().persistPath).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Cache key isolation
  // -------------------------------------------------------------------------

  it("produces different cache keys for different provider names", async () => {
    const inner1 = makeInnerProvider({ name: "provider-a" });
    const inner2 = makeInnerProvider({ name: "provider-b" });
    const cached1 = new CachedEmbeddingProvider(inner1, { maxCacheSize: 100 });
    const cached2 = new CachedEmbeddingProvider(inner2, { maxCacheSize: 100 });

    const emb1 = makeEmbedding(1);
    const emb2 = makeEmbedding(2);
    inner1.embed.mockResolvedValueOnce(makeEmbedResult([emb1]));
    inner2.embed.mockResolvedValueOnce(makeEmbedResult([emb2]));

    await cached1.embed(["same text"]);
    await cached2.embed(["same text"]);

    // Both should have called inner (cache keys differ because provider name differs)
    expect(inner1.embed).toHaveBeenCalledOnce();
    expect(inner2.embed).toHaveBeenCalledOnce();
  });

  it("produces different cache keys for different dimensions", async () => {
    const inner1 = makeInnerProvider({ dimensions: 128 });
    const inner2 = makeInnerProvider({ dimensions: 256 });
    const cached1 = new CachedEmbeddingProvider(inner1, { maxCacheSize: 100 });
    const cached2 = new CachedEmbeddingProvider(inner2, { maxCacheSize: 100 });

    inner1.embed.mockResolvedValueOnce(makeEmbedResult([makeEmbedding(1)]));
    inner2.embed.mockResolvedValueOnce(makeEmbedResult([makeEmbedding(2, 256)]));

    await cached1.embed(["same text"]);
    await cached2.embed(["same text"]);

    expect(inner1.embed).toHaveBeenCalledOnce();
    expect(inner2.embed).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Multiple texts: all misses
  // -------------------------------------------------------------------------

  it("handles batch of all-miss texts correctly", async () => {
    const embs = [makeEmbedding(1), makeEmbedding(2), makeEmbedding(3)];
    inner.embed.mockResolvedValueOnce(makeEmbedResult(embs, 15));

    const result = await cached.embed(["a", "b", "c"]);

    expect(result.embeddings).toHaveLength(3);
    expect(result.embeddings[0]).toEqual(embs[0]);
    expect(result.embeddings[1]).toEqual(embs[1]);
    expect(result.embeddings[2]).toEqual(embs[2]);
    expect(result.usage.totalTokens).toBe(15);
  });

  // -------------------------------------------------------------------------
  // Multiple texts: all hits
  // -------------------------------------------------------------------------

  it("handles batch of all-hit texts (no inner provider call)", async () => {
    const embs = [makeEmbedding(1), makeEmbedding(2)];
    inner.embed.mockResolvedValueOnce(makeEmbedResult(embs, 10));

    await cached.embed(["x", "y"]);
    inner.embed.mockClear();

    const result = await cached.embed(["x", "y"]);

    expect(inner.embed).not.toHaveBeenCalled();
    expect(result.embeddings).toHaveLength(2);
    expect(result.usage.totalTokens).toBe(0);
  });
});
