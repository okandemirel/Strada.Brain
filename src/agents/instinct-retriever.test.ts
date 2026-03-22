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

    const retriever = new InstinctRetriever(mockMatcher);
    return { retriever, mockStorage, mockMatcher };
  }

  it("returns empty InsightResult when no active instincts exist", async () => {
    const { retriever, mockMatcher } = setup([], []);

    const result = await retriever.getInsightsForTask("fix null pointer");

    expect(result.insights).toEqual([]);
    expect(result.matchedInstinctIds).toEqual([]);
    expect(mockMatcher.findSimilarInstincts).toHaveBeenCalled();
  });

  it("returns formatted insights and matched IDs when matches found", async () => {
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

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0]).toBe("Add null check before accessing property (90% confidence, 80% success, applied 8x)");
    expect(result.matchedInstinctIds).toEqual(["instinct_test_001"]);
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

    expect(result.insights).toHaveLength(3);
    expect(result.matchedInstinctIds).toHaveLength(3);
    // maxResults is maxInsights + 10 to account for post-filtering of deprecated instincts
    expect(mockMatcher.findSimilarInstincts).toHaveBeenCalledWith(
      "some task",
      { minSimilarity: 0.4, maxResults: 13 },
    );
  });

  it("excludes deprecated instincts from getInsightsForTask results", async () => {
    const activeInstinct = createMockInstinct({
      id: "instinct_active" as Instinct["id"],
      status: "active",
      action: JSON.stringify({ description: "Active insight" }),
      confidence: 0.8,
      stats: {
        timesSuggested: 10,
        timesApplied: 8,
        timesFailed: 2,
        successRate: 0.8,
        averageExecutionMs: 100,
      },
    });

    const deprecatedInstinct = createMockInstinct({
      id: "instinct_deprecated" as Instinct["id"],
      status: "deprecated",
      action: JSON.stringify({ description: "Deprecated insight" }),
      confidence: 0.2,
      stats: {
        timesSuggested: 20,
        timesApplied: 5,
        timesFailed: 15,
        successRate: 0.25,
        averageExecutionMs: 100,
      },
    });

    const matches = [
      createMockMatch(activeInstinct, 0.9),
      createMockMatch(deprecatedInstinct, 0.85),
    ];

    const { retriever } = setup([activeInstinct, deprecatedInstinct], matches);
    const result = await retriever.getInsightsForTask("some task");

    // Deprecated instinct should be excluded from both insights and matchedInstinctIds
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0]).toContain("Active insight");
    expect(result.matchedInstinctIds).toEqual(["instinct_active"]);
    expect(result.matchedInstinctIds).not.toContain("instinct_deprecated");
  });

  it("excludes deprecated instincts from matchedInstinctIds", async () => {
    const deprecatedInstinct = createMockInstinct({
      id: "instinct_dep_only" as Instinct["id"],
      status: "deprecated",
      action: JSON.stringify({ description: "Old deprecated pattern" }),
      confidence: 0.1,
    });

    const matches = [createMockMatch(deprecatedInstinct, 0.7)];
    const { retriever } = setup([deprecatedInstinct], matches);
    const result = await retriever.getInsightsForTask("some task");

    expect(result.insights).toHaveLength(0);
    expect(result.matchedInstinctIds).toHaveLength(0);
  });

  it("includes permanent instincts in results (not filtered out)", async () => {
    const permanentInstinct = createMockInstinct({
      id: "instinct_perm" as Instinct["id"],
      status: "permanent",
      action: JSON.stringify({ description: "Permanent insight" }),
      confidence: 0.98,
      stats: {
        timesSuggested: 50,
        timesApplied: 48,
        timesFailed: 2,
        successRate: 0.96,
        averageExecutionMs: 80,
      },
    });

    const matches = [createMockMatch(permanentInstinct, 0.9)];
    const { retriever } = setup([permanentInstinct], matches);
    const result = await retriever.getInsightsForTask("some task");

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0]).toContain("Permanent insight");
    expect(result.matchedInstinctIds).toEqual(["instinct_perm"]);
  });

  it("applies 1.2x ranking boost to permanent instincts", async () => {
    const activeInstinct = createMockInstinct({
      id: "instinct_active_rank" as Instinct["id"],
      status: "active",
      action: JSON.stringify({ description: "Active insight" }),
      confidence: 0.85,
      stats: {
        timesSuggested: 10,
        timesApplied: 8,
        timesFailed: 2,
        successRate: 0.8,
        averageExecutionMs: 100,
      },
    });

    const permanentInstinct = createMockInstinct({
      id: "instinct_perm_rank" as Instinct["id"],
      status: "permanent",
      action: JSON.stringify({ description: "Permanent insight" }),
      confidence: 0.95,
      stats: {
        timesSuggested: 50,
        timesApplied: 48,
        timesFailed: 2,
        successRate: 0.96,
        averageExecutionMs: 80,
      },
    });

    // Give active instinct a higher base match score than permanent
    // Active: 0.85, Permanent: 0.75
    // After 1.2x boost: Permanent: 0.75 * 1.2 = 0.90 > Active: 0.85
    const matches = [
      createMockMatch(activeInstinct, 0.85),
      createMockMatch(permanentInstinct, 0.75),
    ];

    const { retriever } = setup([activeInstinct, permanentInstinct], matches);
    const result = await retriever.getInsightsForTask("some task");

    // Permanent instinct should appear first due to 1.2x boost
    expect(result.matchedInstinctIds[0]).toBe("instinct_perm_rank");
    expect(result.matchedInstinctIds[1]).toBe("instinct_active_rank");
  });

  it("includes cooling instincts (active status with coolingStartedAt) in results", async () => {
    const coolingInstinct = createMockInstinct({
      id: "instinct_cooling" as Instinct["id"],
      status: "active",
      action: JSON.stringify({ description: "Cooling insight" }),
      confidence: 0.35,
      coolingStartedAt: Date.now() as Instinct["coolingStartedAt"],
      coolingFailures: 1,
      stats: {
        timesSuggested: 15,
        timesApplied: 10,
        timesFailed: 5,
        successRate: 0.67,
        averageExecutionMs: 100,
      },
    });

    const matches = [createMockMatch(coolingInstinct, 0.8)];
    const { retriever } = setup([coolingInstinct], matches);
    const result = await retriever.getInsightsForTask("some task");

    // Cooling instincts should still be included (status is "active", not "deprecated")
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0]).toContain("Cooling insight");
    expect(result.matchedInstinctIds).toEqual(["instinct_cooling"]);
  });

  it("proposed, active, and evolved instincts continue to work as before", async () => {
    const proposed = createMockInstinct({
      id: "instinct_proposed" as Instinct["id"],
      status: "proposed",
      action: JSON.stringify({ description: "Proposed insight" }),
      confidence: 0.5,
    });
    const active = createMockInstinct({
      id: "instinct_active2" as Instinct["id"],
      status: "active",
      action: JSON.stringify({ description: "Active insight" }),
      confidence: 0.8,
    });
    const evolved = createMockInstinct({
      id: "instinct_evolved" as Instinct["id"],
      status: "evolved",
      action: JSON.stringify({ description: "Evolved insight" }),
      confidence: 0.95,
    });

    const matches = [
      createMockMatch(active, 0.9),
      createMockMatch(proposed, 0.7),
      createMockMatch(evolved, 0.6),
    ];

    const { retriever } = setup([proposed, active, evolved], matches);
    const result = await retriever.getInsightsForTask("some task");

    expect(result.insights).toHaveLength(3);
    expect(result.matchedInstinctIds).toHaveLength(3);
    expect(result.matchedInstinctIds).toContain("instinct_proposed");
    expect(result.matchedInstinctIds).toContain("instinct_active2");
    expect(result.matchedInstinctIds).toContain("instinct_evolved");
  });

  it("formatInsight falls back to tool+output when no description", async () => {
    const instinct = createMockInstinct({
      id: "instinct_tool_only" as Instinct["id"],
      action: JSON.stringify({ tool: "dotnet_build", output: "Build succeeded with 0 warnings" }),
      confidence: 0.75,
      stats: {
        timesSuggested: 5,
        timesApplied: 4,
        timesFailed: 1,
        successRate: 0.8,
        averageExecutionMs: 100,
      },
    });

    const match = createMockMatch(instinct, 0.8);
    const { retriever } = setup([instinct], [match]);

    const result = await retriever.getInsightsForTask("build project");

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0]).toContain("When using dotnet_build:");
    expect(result.insights[0]).toContain("Build succeeded with 0 warnings");
    expect(result.insights[0]).toContain("80% confidence");
  });

  it("formatInsight truncates long output via summarize", async () => {
    const longOutput = "A".repeat(300);
    const instinct = createMockInstinct({
      id: "instinct_long" as Instinct["id"],
      action: JSON.stringify({ tool: "file_read", output: longOutput }),
      confidence: 0.7,
      stats: {
        timesSuggested: 3,
        timesApplied: 2,
        timesFailed: 1,
        successRate: 0.67,
        averageExecutionMs: 50,
      },
    });

    const match = createMockMatch(instinct, 0.7);
    const { retriever } = setup([instinct], [match]);

    const result = await retriever.getInsightsForTask("read file");

    expect(result.insights).toHaveLength(1);
    // Should be truncated to 200 chars + "..."
    expect(result.insights[0]).toContain("...");
    expect(result.insights[0]).toContain("When using file_read:");
  });

  it("formatInsight includes provenance metadata when originBootCount is present", async () => {
    const createdAt = Date.now() - 2 * 86_400_000; // 2 days ago
    const instinct = createMockInstinct({
      id: "instinct_provenance" as Instinct["id"],
      action: JSON.stringify({ description: "Add error handling" }),
      confidence: 0.9,
      originBootCount: 5,
      crossSessionHitCount: 3,
      createdAt: createdAt as Instinct["createdAt"],
      stats: {
        timesSuggested: 10,
        timesApplied: 8,
        timesFailed: 2,
        successRate: 0.8,
        averageExecutionMs: 100,
      },
    });

    const match = createMockMatch(instinct, 0.85);
    const { retriever } = setup([instinct], [match]);

    const result = await retriever.getInsightsForTask("handle errors");

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0]).toContain("[boot #5");
    expect(result.insights[0]).toContain("2d ago");
    expect(result.insights[0]).toContain("used by 3 sessions]");
  });

  it("formatInsight uses match.confidence not instinct.confidence", async () => {
    const instinct = createMockInstinct({
      id: "instinct_conf_check" as Instinct["id"],
      action: JSON.stringify({ description: "Use match confidence" }),
      confidence: 0.5, // instinct confidence is 50%
      stats: {
        timesSuggested: 5,
        timesApplied: 4,
        timesFailed: 1,
        successRate: 0.8,
        averageExecutionMs: 100,
      },
    });

    const match = createMockMatch(instinct, 0.95); // match confidence is 95%
    const { retriever } = setup([instinct], [match]);

    const result = await retriever.getInsightsForTask("check confidence");

    expect(result.insights).toHaveLength(1);
    // Should show match.confidence (95%), not instinct.confidence (50%)
    expect(result.insights[0]).toContain("95% confidence");
  });

  it("handles JSON parse errors gracefully (still collects IDs)", async () => {
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

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0]).toBe("Valid insight (90% confidence, 80% success, applied 4x)");
    // Both instinct IDs are collected even if formatting fails
    expect(result.matchedInstinctIds).toEqual(["instinct_good", "instinct_bad"]);
  });
});
