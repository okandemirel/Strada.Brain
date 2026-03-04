import { describe, it, expect, vi } from "vitest";
import { InstinctRetriever } from "./instinct-retriever.js";
import type { PatternMatcher } from "../learning/matching/pattern-matcher.js";
import type { LearningStorage } from "../learning/storage/learning-storage.js";
import type { Instinct, PatternMatch } from "../learning/types.js";

function createMockInstinct(overrides: Partial<Instinct> = {}): Instinct {
  return {
    id: "instinct_test_001" as Instinct["id"],
    name: "Test Instinct",
    type: "error_fix",
    status: "active",
    confidence: 0.85,
    triggerPattern: "test pattern",
    action: JSON.stringify({ description: "Add null check before accessing property" }),
    contextConditions: [],
    stats: {
      timesSuggested: 10,
      timesApplied: 8,
      timesFailed: 2,
      successRate: 0.8,
      averageExecutionMs: 100,
    },
    createdAt: Date.now() as Instinct["createdAt"],
    updatedAt: Date.now() as Instinct["updatedAt"],
    sourceTrajectoryIds: [],
    tags: [],
    ...overrides,
  } as Instinct;
}

function createMockMatch(instinct: Instinct, confidence: number = 0.8): PatternMatch {
  return {
    id: instinct.id,
    type: "fuzzy",
    confidence,
    relevance: confidence,
    instinct,
    matchReason: `Similarity: ${(confidence * 100).toFixed(1)}%`,
    matchedFields: ["triggerPattern"],
    priority: Math.round(confidence * 100),
  } as PatternMatch;
}

describe("InstinctRetriever", () => {
  function setup(
    instincts: Instinct[] = [],
    matches: PatternMatch[] = [],
  ) {
    const mockStorage = {
      getInstincts: vi.fn().mockReturnValue(instincts),
    } as unknown as LearningStorage;

    const mockMatcher = {
      findSimilarInstincts: vi.fn().mockReturnValue(matches),
    } as unknown as PatternMatcher;

    const retriever = new InstinctRetriever(mockMatcher, mockStorage);
    return { retriever, mockStorage, mockMatcher };
  }

  it("returns empty array when no active instincts exist", async () => {
    const { retriever, mockStorage, mockMatcher } = setup([], []);

    const result = await retriever.getInsightsForTask("fix null pointer");

    expect(result).toEqual([]);
    expect(mockStorage.getInstincts).toHaveBeenCalledWith({ minConfidence: 0.5 });
    expect(mockMatcher.findSimilarInstincts).not.toHaveBeenCalled();
  });

  it("returns formatted insights when matches found", async () => {
    const instinct = createMockInstinct({
      action: JSON.stringify({ description: "Add null check before accessing property" }),
      confidence: 0.85,
      stats: {
        timesSuggested: 10,
        timesApplied: 8,
        timesFailed: 2,
        successRate: 0.8,
        averageExecutionMs: 100,
      },
    });

    const match = createMockMatch(instinct, 0.9);
    const { retriever } = setup([instinct], [match]);

    const result = await retriever.getInsightsForTask("handle null values");

    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Add null check before accessing property (85% confidence, 80% success, applied 8x)");
  });

  it("limits results to maxInsights parameter", async () => {
    const instincts = Array.from({ length: 10 }, (_, i) =>
      createMockInstinct({
        id: `instinct_test_${i}` as Instinct["id"],
        action: JSON.stringify({ description: `Insight ${i}` }),
        confidence: 0.7 + i * 0.02,
        stats: {
          timesSuggested: 5,
          timesApplied: 4,
          timesFailed: 1,
          successRate: 0.8,
          averageExecutionMs: 100,
        },
      }),
    );

    const allMatches = instincts.map((inst, i) => createMockMatch(inst, 0.9 - i * 0.05));
    // Mock returns only the first 3 matches (matcher respects maxResults)
    const { retriever, mockMatcher } = setup(instincts, allMatches.slice(0, 3));

    const result = await retriever.getInsightsForTask("some task", 3);

    expect(result).toHaveLength(3);
    expect(mockMatcher.findSimilarInstincts).toHaveBeenCalledWith(
      "some task",
      { minSimilarity: 0.4, maxResults: 3, statusFilter: ["active", "proposed"] },
    );
  });

  it("handles JSON parse errors gracefully", async () => {
    const goodInstinct = createMockInstinct({
      id: "instinct_good" as Instinct["id"],
      action: JSON.stringify({ description: "Valid insight" }),
      confidence: 0.9,
      stats: {
        timesSuggested: 5,
        timesApplied: 4,
        timesFailed: 1,
        successRate: 0.8,
        averageExecutionMs: 100,
      },
    });

    const badInstinct = createMockInstinct({
      id: "instinct_bad" as Instinct["id"],
      action: "not valid json {{{",
      confidence: 0.8,
    });

    const matches = [
      createMockMatch(goodInstinct, 0.9),
      createMockMatch(badInstinct, 0.85),
    ];

    const { retriever } = setup([goodInstinct, badInstinct], matches);

    const result = await retriever.getInsightsForTask("some task");

    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Valid insight (90% confidence, 80% success, applied 4x)");
  });
});
