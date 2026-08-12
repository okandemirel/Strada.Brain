/**
 * Embedding cache persistence format tests.
 *
 * The cache used to round-trip through JSON. At the default 10,000 entries and
 * 1536 dimensions that measured 821 ms to stringify into a 296 MB string plus
 * 567 ms to parse — ~1.4 s of blocking work per start/stop cycle — and left
 * only 1.7x headroom under V8's maximum string length, so raising maxCacheSize
 * past ~17,300 entries made shutdown throw and drop the entire cache.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createLogger } from "../../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { encodeEmbeddingCache, decodeEmbeddingCache } from "./embedding-cache-codec.js";
import { CachedEmbeddingProvider } from "./embedding-cache.js";
import type { IEmbeddingProvider, EmbeddingBatch } from "../rag.interface.js";

const DIMENSIONS = 8;

/** Irrational-looking values: float32 narrowing would show up as inequality. */
function embedding(seed: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, i) => Math.sin(seed * 31 + i * 7) / 3);
}

describe("embedding cache codec", () => {
  const payload = {
    providerName: "openai",
    dimensions: DIMENSIONS,
    entries: [
      { key: "a".repeat(64), embedding: embedding(1) },
      { key: "b".repeat(64), embedding: embedding(2) },
    ],
  };

  it("round-trips exactly at full double precision", () => {
    expect(decodeEmbeddingCache(encodeEmbeddingCache(payload))).toEqual(payload);

    // Guard the guard: the equality above would also hold under a lossy
    // 4-byte format if every value happened to be float32-representable.
    const values = payload.entries.flatMap((e) => e.embedding);
    expect(values.some((v) => Math.fround(v) !== v)).toBe(true);
  });

  it("preserves non-ASCII provider names", () => {
    const decoded = decodeEmbeddingCache(
      encodeEmbeddingCache({ ...payload, providerName: "ollama-türkçe-模型" }),
    );
    // Byte length differs from character length here, which is exactly what a
    // naive length-in-characters header would get wrong.
    expect(decoded?.providerName).toBe("ollama-türkçe-模型");
    expect(decoded?.entries).toEqual(payload.entries);
  });

  it("rejects a foreign or truncated file instead of inventing vectors", () => {
    const encoded = encodeEmbeddingCache(payload);
    expect(decodeEmbeddingCache(Buffer.from("not a cache file at all"))).toBeNull();
    expect(decodeEmbeddingCache(Buffer.alloc(0))).toBeNull();
    expect(decodeEmbeddingCache(encoded.subarray(0, encoded.length - 9))).toBeNull();

    // Right magic, wrong version.
    const wrongVersion = Buffer.from(encoded);
    wrongVersion.writeUInt32LE(99, 4);
    expect(decodeEmbeddingCache(wrongVersion)).toBeNull();
  });

  it("refuses to encode a row of the wrong width", () => {
    expect(() =>
      encodeEmbeddingCache({
        ...payload,
        entries: [{ key: "short", embedding: [1, 2, 3] }],
      }),
    ).toThrow(/expected 8/);
  });
});

class StubProvider implements IEmbeddingProvider {
  readonly name = "stub";
  readonly dimensions = DIMENSIONS;
  calls = 0;

  async embed(texts: string[]): Promise<EmbeddingBatch> {
    this.calls += texts.length;
    return {
      embeddings: texts.map((_, i) => embedding(i + 1)),
      usage: { totalTokens: texts.length },
    };
  }
}

describe("CachedEmbeddingProvider persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "emb-cache-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists to the binary file and reloads without re-embedding", async () => {
    const first = new CachedEmbeddingProvider(new StubProvider(), { persistPath: dir });
    await first.initialize();
    await first.embed(["alpha", "beta"]);
    await first.shutdown();

    expect(existsSync(join(dir, "embedding-cache.bin"))).toBe(true);
    expect(existsSync(join(dir, "embedding-cache.json"))).toBe(false);

    const inner = new StubProvider();
    const second = new CachedEmbeddingProvider(inner, { persistPath: dir });
    await second.initialize();
    const result = await second.embed(["alpha", "beta"]);

    expect(inner.calls).toBe(0);
    expect(result.embeddings).toEqual([embedding(1), embedding(2)]);
  });

  it("still loads a cache left by the pre-binary build", async () => {
    // Exactly what the old shutdown() wrote.
    writeFileSync(
      join(dir, "embedding-cache.json"),
      JSON.stringify({
        version: 1,
        providerName: "stub",
        dimensions: DIMENSIONS,
        entries: [{ key: "legacy-key", embedding: embedding(42) }],
      }),
      "utf8",
    );

    const provider = new CachedEmbeddingProvider(new StubProvider(), { persistPath: dir });
    await provider.initialize();
    expect(provider.getCacheStats().size).toBe(1);

    // The upgrade rewrites it in binary form, and leaves the JSON alone so a
    // downgrade still finds a usable cache.
    await provider.shutdown();
    expect(existsSync(join(dir, "embedding-cache.bin"))).toBe(true);
    expect(existsSync(join(dir, "embedding-cache.json"))).toBe(true);

    const decoded = decodeEmbeddingCache(readFileSync(join(dir, "embedding-cache.bin")));
    expect(decoded?.entries).toEqual([{ key: "legacy-key", embedding: embedding(42) }]);
  });

  it("discards a cache written by a different provider", async () => {
    writeFileSync(
      join(dir, "embedding-cache.bin"),
      encodeEmbeddingCache({
        providerName: "some-other-provider",
        dimensions: DIMENSIONS,
        entries: [{ key: "k", embedding: embedding(1) }],
      }),
    );

    const provider = new CachedEmbeddingProvider(new StubProvider(), { persistPath: dir });
    await provider.initialize();
    expect(provider.getCacheStats().size).toBe(0);
  });
});
