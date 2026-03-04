import { describe, it, expect, beforeEach, vi } from "vitest";
import { PatternMatcher, extractKeywords, jaccardSimilarity, vectorCosineSimilarity } from "./pattern-matcher.ts";
import type { LearningStorage } from "../storage/learning-storage.ts";
import type { Instinct, PatternMatchInput } from "../types.ts";
import type { EmbedderLike } from "./pattern-matcher.ts";

// Mock LearningStorage
const createMockStorage = (): LearningStorage => {
  const instincts: Instinct[] = [
    {
      id: "instinct-1",
      name: "Missing Type Fix",
      type: "error_fix",
      status: "active",
      confidence: 0.85,
      triggerPattern: "CS0246: The type or namespace name 'MyType' could not be found",
      action: "Add using MyNamespace;",
      contextConditions: [{ type: "error_code", value: "CS0246", match: "include" }],
      stats: { timesSuggested: 10, timesApplied: 9, timesFailed: 1, successRate: 0.9 },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "instinct-2",
      name: "Undefined Symbol Fix",
      type: "error_fix",
      status: "active",
      confidence: 0.75,
      triggerPattern: "CS0103: The name 'variable' does not exist in the current context",
      action: "Declare the variable or check spelling",
      contextConditions: [{ type: "error_code", value: "CS0103", match: "include" }],
      stats: { timesSuggested: 5, timesApplied: 4, timesFailed: 1, successRate: 0.8 },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  return {
    getInstincts: vi.fn(() => instincts),
    getInstinct: vi.fn((id: string) => instincts.find(i => i.id === id) ?? null),
    getErrorPatterns: vi.fn(() => []),
  } as unknown as LearningStorage;
};

describe("PatternMatcher", () => {
  let matcher: PatternMatcher;
  let mockStorage: LearningStorage;

  beforeEach(() => {
    mockStorage = createMockStorage();
    matcher = new PatternMatcher(mockStorage);
  });

  describe("findInstinctsForError", () => {
    it("should find matching instincts by error code", () => {
      const input: PatternMatchInput = {
        errorCode: "CS0246",
        errorMessage: "The type or namespace name 'Test' could not be found",
      };

      const matches = matcher.findInstinctsForError(input);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0]?.instinct?.id).toBe("instinct-1");
    });

    it("should find matching instincts by message similarity", () => {
      const input: PatternMatchInput = {
        errorMessage: "The type or namespace name 'SomeClass' could not be found",
      };

      const matches = matcher.findInstinctsForError(input);
      expect(matches.length).toBeGreaterThan(0);
    });

    it("should return empty array for no matches", () => {
      const input: PatternMatchInput = {
        errorMessage: "Completely unrelated error message that matches nothing",
      };

      const matches = matcher.findInstinctsForError(input, { minConfidence: 0.9 });
      expect(matches).toHaveLength(0);
    });

    it("should respect maxResults option", () => {
      const input: PatternMatchInput = {
        errorCode: "CS0246",
      };

      const matches = matcher.findInstinctsForError(input, { maxResults: 1 });
      expect(matches.length).toBeLessThanOrEqual(1);
    });
  });

  describe("findSimilarInstincts", () => {
    it("should find similar instincts by pattern", () => {
      const matches = matcher.findSimilarInstincts(
        "The type or namespace name could not be found"
      );
      expect(matches.length).toBeGreaterThan(0);
    });

    it("should return exact match for identical patterns", () => {
      const matches = matcher.findSimilarInstincts(
        "CS0246: The type or namespace name 'MyType' could not be found"
      );
      
      const exactMatch = matches.find(m => m.type === "exact" || m.confidence > 0.9);
      expect(exactMatch).toBeDefined();
    });

    it("should filter by type when specified", () => {
      const allMatches = matcher.findSimilarInstincts("error pattern");
      const filteredMatches = matcher.findSimilarInstincts("error pattern", {
        typeFilter: "correction",
      });

      expect(filteredMatches.length).toBeLessThanOrEqual(allMatches.length);
    });
  });

  describe("isApplicable", () => {
    it("should return true when all conditions match", () => {
      const instinct: Instinct = {
        id: "test",
        name: "Test",
        type: "error_fix",
        status: "active",
        confidence: 0.5,
        triggerPattern: "test",
        action: "fix",
        contextConditions: [
          { type: "tool_name", value: "dotnet_build", match: "include" },
        ],
        stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0 },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(matcher.isApplicable(instinct, { tool_name: "dotnet_build" })).toBe(true);
    });

    it("should return false when exclude condition matches", () => {
      const instinct: Instinct = {
        id: "test",
        name: "Test",
        type: "error_fix",
        status: "active",
        confidence: 0.5,
        triggerPattern: "test",
        action: "fix",
        contextConditions: [
          { type: "file_type", value: ".cs", match: "exclude" },
        ],
        stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0 },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(matcher.isApplicable(instinct, { file_type: ".cs" })).toBe(false);
    });

    it("should return true when no conditions specified", () => {
      const instinct: Instinct = {
        id: "test",
        name: "Test",
        type: "error_fix",
        status: "active",
        confidence: 0.5,
        triggerPattern: "test",
        action: "fix",
        contextConditions: [],
        stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0 },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(matcher.isApplicable(instinct, {})).toBe(true);
    });
  });

  describe("getBestMatch", () => {
    it("should return the highest confidence match", () => {
      const input: PatternMatchInput = {
        errorCode: "CS0246",
        errorMessage: "The type or namespace name 'MyType' could not be found",
      };

      const bestMatch = matcher.getBestMatch(input);
      expect(bestMatch).not.toBeNull();
      expect(bestMatch?.instinct?.id).toBe("instinct-1");
    });

    it("should return null when no match meets minimum confidence", () => {
      const input: PatternMatchInput = {
        errorMessage: "Something completely different",
      };

      const bestMatch = matcher.getBestMatch(input, 0.99);
      expect(bestMatch).toBeNull();
    });
  });

  describe("findSimilarInstinctsSemantic", () => {
    const createMockEmbedder = (): EmbedderLike => ({
      embed: vi.fn(async (text: string) => ({
        vector: text.includes("missing type")
          ? [1, 0, 0]
          : text.includes("undefined")
            ? [0, 1, 0]
            : [0.9, 0.1, 0], // query vector close to "missing type"
        dimensions: 3,
      })),
    });

    const createStorageWithEmbeddings = (): LearningStorage => {
      const instincts: Instinct[] = [
        {
          id: "instinct-emb-1",
          name: "Missing Type Fix",
          type: "error_fix",
          status: "active",
          confidence: 0.85,
          triggerPattern: "missing type error",
          action: "Add using MyNamespace;",
          contextConditions: [],
          stats: { timesSuggested: 10, timesApplied: 9, timesFailed: 1, successRate: 0.9 },
          createdAt: new Date(),
          updatedAt: new Date(),
          embedding: [1, 0, 0], // unit vector along x-axis
        },
        {
          id: "instinct-emb-2",
          name: "Undefined Symbol Fix",
          type: "error_fix",
          status: "active",
          confidence: 0.75,
          triggerPattern: "undefined symbol error",
          action: "Declare the variable",
          contextConditions: [],
          stats: { timesSuggested: 5, timesApplied: 4, timesFailed: 1, successRate: 0.8 },
          createdAt: new Date(),
          updatedAt: new Date(),
          embedding: [0, 1, 0], // unit vector along y-axis
        },
        {
          id: "instinct-emb-3",
          name: "No Embedding Instinct",
          type: "error_fix",
          status: "active",
          confidence: 0.9,
          triggerPattern: "no embedding here",
          action: "No action",
          contextConditions: [],
          stats: { timesSuggested: 1, timesApplied: 1, timesFailed: 0, successRate: 1 },
          createdAt: new Date(),
          updatedAt: new Date(),
          // no embedding field
        },
      ];

      return {
        getInstincts: vi.fn(() => instincts),
        getInstinct: vi.fn((id: string) => instincts.find(i => i.id === id) ?? null),
        getErrorPatterns: vi.fn(() => []),
      } as unknown as LearningStorage;
    };

    it("should return empty array when no embedder is configured", async () => {
      // matcher has no embedder (default constructor)
      const results = await matcher.findSimilarInstinctsSemantic("some query");
      expect(results).toEqual([]);
    });

    it("should find semantically similar instincts using vector embeddings", async () => {
      const embStorage = createStorageWithEmbeddings();
      const embedder = createMockEmbedder();
      const semanticMatcher = new PatternMatcher(embStorage, { embedder });

      // Query vector [0.9, 0.1, 0] is close to instinct-emb-1 [1, 0, 0]
      const results = await semanticMatcher.findSimilarInstinctsSemantic("some query");

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.instinct!.id).toBe("instinct-emb-1");
      expect(results[0]!.type).toBe("semantic");
      expect(results[0]!.matchedFields).toContain("embedding");
    });

    it("should skip instincts without embeddings", async () => {
      const embStorage = createStorageWithEmbeddings();
      const embedder = createMockEmbedder();
      const semanticMatcher = new PatternMatcher(embStorage, { embedder });

      const results = await semanticMatcher.findSimilarInstinctsSemantic("some query", {
        minScore: 0,
      });

      // instinct-emb-3 has no embedding, should be excluded
      const ids = results.map(r => r.id);
      expect(ids).not.toContain("instinct-emb-3");
    });

    it("should respect minScore option", async () => {
      const embStorage = createStorageWithEmbeddings();
      const embedder = createMockEmbedder();
      const semanticMatcher = new PatternMatcher(embStorage, { embedder });

      // Query [0.9, 0.1, 0] vs [0, 1, 0] should have low similarity
      const results = await semanticMatcher.findSimilarInstinctsSemantic("some query", {
        minScore: 0.9,
      });

      // Only instinct-emb-1 should pass (cosine ~0.994), instinct-emb-2 should not
      expect(results.length).toBe(1);
      expect(results[0]!.instinct!.id).toBe("instinct-emb-1");
    });

    it("should respect maxResults option", async () => {
      const embStorage = createStorageWithEmbeddings();
      const embedder = createMockEmbedder();
      const semanticMatcher = new PatternMatcher(embStorage, { embedder });

      const results = await semanticMatcher.findSimilarInstinctsSemantic("some query", {
        maxResults: 1,
        minScore: 0,
      });

      expect(results.length).toBe(1);
    });

    it("should sort results by similarity score descending", async () => {
      const embStorage = createStorageWithEmbeddings();
      const embedder = createMockEmbedder();
      const semanticMatcher = new PatternMatcher(embStorage, { embedder });

      const results = await semanticMatcher.findSimilarInstinctsSemantic("some query", {
        minScore: 0,
      });

      // Results should be sorted by confidence (similarity * instinct.confidence) descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.confidence).toBeGreaterThanOrEqual(results[i]!.confidence);
      }
    });
  });
});

describe("vectorCosineSimilarity", () => {
  it("should return 1 for identical vectors", () => {
    expect(vectorCosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it("should return 0 for orthogonal vectors", () => {
    expect(vectorCosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
  });

  it("should return -1 for opposite vectors", () => {
    expect(vectorCosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it("should handle non-unit vectors correctly", () => {
    // [3, 4] and [6, 8] are parallel → cosine = 1
    expect(vectorCosineSimilarity([3, 4], [6, 8])).toBeCloseTo(1.0);
  });

  it("should return 0 for zero-length vectors", () => {
    expect(vectorCosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(vectorCosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("should compute correct similarity for arbitrary vectors", () => {
    // [1, 2, 3] dot [4, 5, 6] = 4 + 10 + 18 = 32
    // |[1,2,3]| = sqrt(14), |[4,5,6]| = sqrt(77)
    // cosine = 32 / sqrt(14*77) = 32 / sqrt(1078)
    const expected = 32 / Math.sqrt(14 * 77);
    expect(vectorCosineSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(expected);
  });
});

describe("extractKeywords", () => {
  it("should extract meaningful keywords", () => {
    const text = "The type or namespace 'MyClass' could not be located";
    const keywords = extractKeywords(text);

    expect(keywords).toContain("type");
    expect(keywords).toContain("namespace");
    expect(keywords).toContain("myclass");
    expect(keywords).toContain("located");
  });

  it("should filter out stop words", () => {
    const text = "The and for are but not you all can";
    const keywords = extractKeywords(text);

    expect(keywords).toHaveLength(0);
  });

  it("should handle short words correctly", () => {
    const text = "A B CD EFG";
    const keywords = extractKeywords(text);

    expect(keywords).toContain("efg");
    expect(keywords).not.toContain("a");
    expect(keywords).not.toContain("b");
  });
});

describe("jaccardSimilarity", () => {
  it("should return 1 for identical sets", () => {
    const setA = new Set(["a", "b", "c"]);
    const setB = new Set(["a", "b", "c"]);

    expect(jaccardSimilarity(setA, setB)).toBe(1);
  });

  it("should return 0 for disjoint sets", () => {
    const setA = new Set(["a", "b", "c"]);
    const setB = new Set(["x", "y", "z"]);

    expect(jaccardSimilarity(setA, setB)).toBe(0);
  });

  it("should calculate correct similarity for overlapping sets", () => {
    const setA = new Set(["a", "b", "c"]);
    const setB = new Set(["b", "c", "d"]);

    // Intersection: {b, c} = 2
    // Union: {a, b, c, d} = 4
    // Similarity: 2/4 = 0.5
    expect(jaccardSimilarity(setA, setB)).toBe(0.5);
  });
});
