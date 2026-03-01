import { describe, it, expect } from "vitest";
import {
  extractTerms,
  computeTF,
  cosineSimilarity,
  TextIndex,
} from "./text-index.js";

describe("extractTerms", () => {
  it("splits on non-alphanumeric and lowercases", () => {
    const terms = extractTerms("Hello World! Test_123");
    expect(terms).toContain("hello");
    expect(terms).toContain("world");
    expect(terms).toContain("test");
    expect(terms).toContain("123");
  });

  it("filters stop words", () => {
    const terms = extractTerms("the class is a public void method");
    // "class", "public", "void" are stop words
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("is");
    expect(terms).not.toContain("class");
    expect(terms).not.toContain("public");
    expect(terms).not.toContain("void");
    expect(terms).toContain("method");
  });

  it("filters single-character terms", () => {
    const terms = extractTerms("a b c de fg");
    expect(terms).not.toContain("a");
    expect(terms).not.toContain("b");
    expect(terms).not.toContain("c");
    expect(terms).toContain("de");
    expect(terms).toContain("fg");
  });

  it("handles C# code snippets", () => {
    const terms = extractTerms("PlayerSystem : SystemBase { float3 position; }");
    expect(terms).toContain("playersystem");
    expect(terms).toContain("systembase");
    expect(terms).toContain("float3");
    expect(terms).toContain("position");
  });

  it("returns empty array for empty input", () => {
    expect(extractTerms("")).toEqual([]);
  });
});

describe("computeTF", () => {
  it("normalizes term frequencies by max frequency", () => {
    const tf = computeTF(["apple", "banana", "apple", "apple"]);
    expect(tf["apple"]).toBe(1); // 3/3
    expect(tf["banana"]).toBeCloseTo(1 / 3); // 1/3
  });

  it("handles single term", () => {
    const tf = computeTF(["only"]);
    expect(tf["only"]).toBe(1);
  });

  it("handles empty array", () => {
    const tf = computeTF([]);
    expect(Object.keys(tf)).toHaveLength(0);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = { a: 1, b: 2 };
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    const v1 = { a: 1 };
    const v2 = { b: 1 };
    expect(cosineSimilarity(v1, v2)).toBe(0);
  });

  it("returns value between 0 and 1 for partial overlap", () => {
    const v1 = { a: 1, b: 1 };
    const v2 = { a: 1, c: 1 };
    const sim = cosineSimilarity(v1, v2);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it("handles empty vectors", () => {
    expect(cosineSimilarity({}, {})).toBe(0);
    expect(cosineSimilarity({ a: 1 }, {})).toBe(0);
  });
});

describe("TextIndex", () => {
  it("tracks document frequency", () => {
    const index = new TextIndex();
    index.addDocument(["combat", "system", "health"]);
    index.addDocument(["combat", "damage"]);

    expect(index.getDocumentCount()).toBe(2);
  });

  it("computes TF-IDF with higher weight for rare terms", () => {
    const index = new TextIndex();
    index.addDocument(["combat", "system"]);
    index.addDocument(["combat", "health"]);
    index.addDocument(["combat", "damage"]);

    const tfidf = index.computeTFIDF(["system", "combat"]);
    // "system" appears in 1 doc, "combat" in 3 — system should have higher IDF
    expect(tfidf["system"]).toBeGreaterThan(tfidf["combat"]!);
  });

  it("removeDocument decrements frequency", () => {
    const index = new TextIndex();
    index.addDocument(["alpha", "beta"]);
    index.addDocument(["alpha", "gamma"]);

    expect(index.getDocumentCount()).toBe(2);

    index.removeDocument(["alpha", "beta"]);
    expect(index.getDocumentCount()).toBe(1);
  });

  it("rebuild recreates index from documents", () => {
    const index = new TextIndex();
    index.rebuild([["one", "two"], ["two", "three"], ["three"]]);
    expect(index.getDocumentCount()).toBe(3);
  });

  it("serializes and deserializes", () => {
    const index = new TextIndex();
    index.addDocument(["foo", "bar"]);
    index.addDocument(["bar", "baz"]);

    const serialized = index.serialize();
    const restored = TextIndex.deserialize(serialized);

    expect(restored.getDocumentCount()).toBe(2);

    // Compute TF-IDF should produce same results
    const original = index.computeTFIDF(["foo"]);
    const restoredResult = restored.computeTFIDF(["foo"]);
    expect(restoredResult["foo"]).toBeCloseTo(original["foo"]!);
  });

  it("handles empty corpus", () => {
    const index = new TextIndex();
    const tfidf = index.computeTFIDF(["anything"]);
    expect(tfidf["anything"]).toBeGreaterThan(0); // IDF defaults to log(1/1)+1
  });
});
