import { describe, it, expect } from "vitest";
import { rerankResults } from "./reranker.js";
import type { VectorSearchHit, CodeChunk } from "./rag.interface.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
  return {
    id: "test-id",
    filePath: "Assets/Test.cs",
    content: "public class TestClass {}",
    startLine: 1,
    endLine: 5,
    kind: "class",
    contentHash: "abc123",
    indexedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeHit(score: number, chunkOverrides: Partial<CodeChunk> = {}): VectorSearchHit {
  return { score, chunk: makeChunk(chunkOverrides) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rerankResults", () => {
  it("higher vectorScore ranks higher when keywords and structure are equal", () => {
    const candidates: VectorSearchHit[] = [
      makeHit(0.5, { id: "low", content: "no relevant terms here" }),
      makeHit(0.9, { id: "high", content: "no relevant terms here" }),
    ];

    const results = rerankResults(candidates, "something unrelated");

    expect(results[0]!.chunk.id).toBe("high");
    expect(results[1]!.chunk.id).toBe("low");
  });

  it("keyword match boosts score above a candidate with higher vectorScore", () => {
    // "low vector" candidate matches all query terms → should overtake "high vector"
    const query = "damage system";
    const candidates: VectorSearchHit[] = [
      makeHit(0.9, { id: "high-vector", content: "unrelated content xyz" }),
      makeHit(0.5, { id: "keyword-match", content: "damage system implementation" }),
    ];

    const results = rerankResults(candidates, query);

    expect(results[0]!.chunk.id).toBe("keyword-match");
  });

  it("structural boost applies for class kind", () => {
    const candidates: VectorSearchHit[] = [
      makeHit(0.7, { id: "method-chunk", kind: "method", content: "void Update() {}" }),
      makeHit(0.7, { id: "class-chunk", kind: "class", content: "public class Foo {}" }),
    ];

    const results = rerankResults(candidates, "foo");

    // class-chunk gets +0.3 structural boost + symbol match boost
    // method-chunk gets nothing structural
    expect(results[0]!.chunk.id).toBe("class-chunk");
  });

  it("structural boost applies when symbol name matches a query term", () => {
    const candidates: VectorSearchHit[] = [
      makeHit(0.7, {
        id: "unrelated-symbol",
        kind: "method",
        symbol: "UnrelatedMethod",
        content: "void UnrelatedMethod() {}",
      }),
      makeHit(0.7, {
        id: "matching-symbol",
        kind: "method",
        symbol: "DamageCalculator",
        content: "void DamageCalculator() {}",
      }),
    ];

    const results = rerankResults(candidates, "damage");

    // matching-symbol has symbol "DamageCalculator" which contains "damage" → +0.5 boost
    expect(results[0]!.chunk.id).toBe("matching-symbol");
  });

  it("System suffix gives a structural boost", () => {
    const candidates: VectorSearchHit[] = [
      makeHit(0.7, {
        id: "plain",
        kind: "class",
        symbol: "EnemyController",
        content: "public class EnemyController {}",
      }),
      makeHit(0.7, {
        id: "system",
        kind: "class",
        symbol: "MovementSystem",
        content: "public class MovementSystem {}",
      }),
    ];

    const results = rerankResults(candidates, "unrelated query with no overlap");

    // Both are class kind (+0.3). "MovementSystem" also gets +0.1 for System suffix.
    expect(results[0]!.chunk.id).toBe("system");
  });

  it("IComponent content gives a structural boost", () => {
    const candidates: VectorSearchHit[] = [
      makeHit(0.7, {
        id: "plain",
        kind: "struct",
        content: "public struct PlainStruct { }",
      }),
      makeHit(0.7, {
        id: "component",
        kind: "struct",
        content: "public struct HealthComponent : IComponent { }",
      }),
    ];

    const results = rerankResults(candidates, "unrelated");

    // Both struct (+0.3). component also gets +0.2 for IComponent.
    expect(results[0]!.chunk.id).toBe("component");
  });

  it("empty query returns results sorted by vectorScore only", () => {
    const candidates: VectorSearchHit[] = [
      makeHit(0.4, { id: "low" }),
      makeHit(0.95, { id: "high" }),
      makeHit(0.7, { id: "mid" }),
    ];

    const results = rerankResults(candidates, "");

    // With empty query: keywordScore = 0 for all, structuralScore depends only on chunk
    // but all chunks have the same structure here, so order is driven by vectorScore.
    expect(results[0]!.chunk.id).toBe("high");
    expect(results[2]!.chunk.id).toBe("low");
  });

  it("empty candidates returns empty array", () => {
    const results = rerankResults([], "some query");
    expect(results).toEqual([]);
  });

  it("finalScore is returned on each result", () => {
    const candidates: VectorSearchHit[] = [makeHit(0.8)];
    const results = rerankResults(candidates, "test");

    expect(results[0]!.finalScore).toBeGreaterThan(0);
    expect(results[0]!.vectorScore).toBe(0.8);
  });

  it("custom config weights are applied", () => {
    // Give all weight to keywords, none to vector
    const candidates: VectorSearchHit[] = [
      makeHit(0.9, { id: "high-vector", content: "unrelated" }),
      makeHit(0.1, { id: "keyword-match", content: "damage health combat" }),
    ];

    const results = rerankResults(candidates, "damage health combat", {
      vectorWeight: 0,
      keywordWeight: 1,
      structuralWeight: 0,
    });

    expect(results[0]!.chunk.id).toBe("keyword-match");
  });
});
