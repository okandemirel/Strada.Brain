import { describe, it, expect, beforeEach, vi } from "vitest";
import { PatternMatcher, extractKeywords, jaccardSimilarity } from "./pattern-matcher.ts";
import type { LearningStorage } from "../storage/learning-storage.ts";
import type { Instinct, PatternMatchInput } from "../types.ts";

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
