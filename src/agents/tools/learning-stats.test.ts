import { describe, it, expect, vi } from "vitest";
import { LearningStatsTool } from "./learning-stats.js";
import type { ToolContext } from "./tool-core.interface.js";

function createMockLearningStorage() {
  return {
    getStats: vi.fn(() => ({
      instinctCount: 15,
      activeInstinctCount: 8,
      trajectoryCount: 50,
      errorPatternCount: 5,
      observationCount: 100,
      unprocessedObservationCount: 3,
    })),
  };
}

function createMockMetricsStorage() {
  return {
    getAggregation: vi.fn(() => ({
      totalTasks: 30,
      successCount: 25,
      failureCount: 3,
      partialCount: 2,
      completionRate: 0.833,
      avgIterations: 3.5,
      avgToolCalls: 8.2,
      tasksWithInstincts: 20,
      instinctReusePct: 66.7,
      avgInstinctsPerInformedTask: 2.1,
    })),
  };
}

const dummyContext: ToolContext = {
  projectPath: "/tmp/test",
  workingDirectory: "/tmp/test",
  readOnly: false,
};

describe("LearningStatsTool", () => {
  it("execute({}) returns both instincts and metrics sections", async () => {
    const ls = createMockLearningStorage();
    const ms = createMockMetricsStorage();
    const tool = new LearningStatsTool(ls as never, ms as never);

    const result = await tool.execute({}, dummyContext);

    expect(result.isError).toBeFalsy();
    // Should contain instinct data
    expect(result.content).toContain("15"); // instinctCount
    expect(result.content).toContain("8"); // activeInstinctCount
    // Should contain metrics data
    expect(result.content).toContain("30"); // totalTasks
    expect(result.content).toContain("83.3"); // completionRate as percentage
  });

  it('execute({section: "instincts"}) returns instinct count, active count, trajectories, error patterns, observations', async () => {
    const ls = createMockLearningStorage();
    const ms = createMockMetricsStorage();
    const tool = new LearningStatsTool(ls as never, ms as never);

    const result = await tool.execute({ section: "instincts" }, dummyContext);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("15"); // instinctCount
    expect(result.content).toContain("8"); // activeInstinctCount
    expect(result.content).toContain("50"); // trajectoryCount
    expect(result.content).toContain("5"); // errorPatternCount
    expect(result.content).toContain("100"); // observationCount
  });

  it('execute({section: "metrics"}) returns total tasks, success rate, avg iterations, avg tool calls, instinct reuse pct', async () => {
    const ls = createMockLearningStorage();
    const ms = createMockMetricsStorage();
    const tool = new LearningStatsTool(ls as never, ms as never);

    const result = await tool.execute({ section: "metrics" }, dummyContext);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("30"); // totalTasks
    expect(result.content).toContain("83.3"); // completionRate as pct
    expect(result.content).toContain("3.5"); // avgIterations
    expect(result.content).toContain("8.2"); // avgToolCalls
    expect(result.content).toContain("66.7"); // instinctReusePct
  });

  it("execute({}) with undefined learningStorage returns 'Not available' for instincts", async () => {
    const ms = createMockMetricsStorage();
    const tool = new LearningStatsTool(undefined, ms as never);

    const result = await tool.execute({}, dummyContext);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Not available");
    // Metrics section should still be present
    expect(result.content).toContain("30"); // totalTasks
  });

  it("execute({}) with undefined metricsStorage returns 'Not available' for metrics", async () => {
    const ls = createMockLearningStorage();
    const tool = new LearningStatsTool(ls as never, undefined);

    const result = await tool.execute({}, dummyContext);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("15"); // instincts should work
    expect(result.content).toContain("Not available"); // metrics not available
  });

  it("execute({}) with both undefined returns both 'Not available'", async () => {
    const tool = new LearningStatsTool(undefined, undefined);

    const result = await tool.execute({}, dummyContext);

    expect(result.isError).toBeFalsy();
    const content = result.content;
    // Should mention "Not available" twice (once for instincts, once for metrics)
    const matches = content.match(/Not available/gi);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it('name is "learning_stats" and description mentions learning pipeline', () => {
    const tool = new LearningStatsTool(undefined, undefined);

    expect(tool.name).toBe("learning_stats");
    expect(tool.description.toLowerCase()).toContain("learning pipeline");
  });
});
