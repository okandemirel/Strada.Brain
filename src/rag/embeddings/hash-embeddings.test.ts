import { describe, it, expect } from "vitest";
import { HashEmbeddingProvider, DEFAULT_HASH_EMBEDDING_DIMENSIONS } from "./hash-embeddings.js";

describe("HashEmbeddingProvider", () => {
  it("is deterministic: same text → identical vector", async () => {
    const p = new HashEmbeddingProvider();
    const [a] = (await p.embed(["the quick brown fox"])).embeddings;
    const [b] = (await p.embed(["the quick brown fox"])).embeddings;
    expect(a).toEqual(b);
  });

  it("produces vectors of the configured dimension", async () => {
    const p = new HashEmbeddingProvider({ dimensions: 64 });
    expect(p.dimensions).toBe(64);
    const [v] = (await p.embed(["hello world"])).embeddings;
    expect(v).toHaveLength(64);
  });

  it("defaults to DEFAULT_HASH_EMBEDDING_DIMENSIONS and guards bad dims", () => {
    expect(new HashEmbeddingProvider().dimensions).toBe(DEFAULT_HASH_EMBEDDING_DIMENSIONS);
    expect(new HashEmbeddingProvider({ dimensions: 0 }).dimensions).toBe(DEFAULT_HASH_EMBEDDING_DIMENSIONS);
    expect(new HashEmbeddingProvider({ dimensions: -5 }).dimensions).toBe(DEFAULT_HASH_EMBEDDING_DIMENSIONS);
  });

  it("L2-normalizes non-empty text (norm ≈ 1)", async () => {
    const [v] = (await new HashEmbeddingProvider().embed(["unity gameobject transform component"])).embeddings;
    const norm = Math.sqrt((v as number[]).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("returns a zero vector for token-less text", async () => {
    const [v] = (await new HashEmbeddingProvider({ dimensions: 16 }).embed(["   !!!  "])).embeddings;
    expect((v as number[]).every((x) => x === 0)).toBe(true);
  });

  it("texts sharing tokens are more similar than unrelated texts", async () => {
    const p = new HashEmbeddingProvider({ dimensions: 512 });
    const { embeddings } = await p.embed([
      "player movement controller script",
      "player movement input handler",
      "database migration sql schema",
    ]);
    const cos = (x: number[], y: number[]) => x.reduce((s, xi, i) => s + xi * y[i]!, 0);
    const related = cos(embeddings[0] as number[], embeddings[1] as number[]);
    const unrelated = cos(embeddings[0] as number[], embeddings[2] as number[]);
    expect(related).toBeGreaterThan(unrelated);
  });

  it("reports token usage and model name", async () => {
    const batch = await new HashEmbeddingProvider().embed(["one two three"]);
    expect(batch.usage.totalTokens).toBe(3);
    expect(batch.model).toBe("hash-fallback");
  });

  it("embedOne matches embed for a single text", async () => {
    const p = new HashEmbeddingProvider({ dimensions: 32 });
    const one = await p.embedOne("alpha beta");
    const [batch] = (await p.embed(["alpha beta"])).embeddings;
    expect(one).toEqual(batch);
  });
});
