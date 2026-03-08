import type { ITool, ToolContext, ToolExecutionResult } from "./tool.interface.js";
import type { LearningStorage } from "../../learning/storage/learning-storage.js";
import type { MetricsStorage } from "../../metrics/metrics-storage.js";
import { buildSection, unavailableSection, checkToolRateLimit } from "./introspection-helpers.js";

/**
 * Introspection tool that lets the LLM query learning pipeline health.
 *
 * Returns instinct counts, trajectory history, task completion rates, and
 * confidence distribution.  Read-only -- never modifies state.  Gracefully
 * degrades when optional dependencies (LearningStorage, MetricsStorage) are
 * unavailable.  Per-tool rate limited.
 */
export class LearningStatsTool implements ITool {
  readonly name = "learning_stats";
  readonly description =
    "Get statistics about your learning pipeline: instinct counts, active patterns, " +
    "trajectory history, task completion rates, and confidence distribution. " +
    "Use this to report on your learning health.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      section: {
        type: "string",
        enum: ["instincts", "metrics", "all"],
        description:
          "Which section to return. Defaults to all. 'instincts' for pattern data, 'metrics' for task data.",
      },
    },
    required: [] as string[],
  };

  private readonly learningStorage?: LearningStorage;
  private readonly metricsStorage?: MetricsStorage;

  constructor(
    learningStorage?: LearningStorage,
    metricsStorage?: MetricsStorage,
  ) {
    this.learningStorage = learningStorage;
    this.metricsStorage = metricsStorage;
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    // Per-tool rate limit
    const rateLimited = checkToolRateLimit(this.name);
    if (rateLimited) return rateLimited;

    const validSections = ["instincts", "metrics", "all"];
    const raw = (input["section"] as string) ?? "all";
    const section = validSections.includes(raw) ? raw : "all";
    const sections: string[] = [];

    if (section === "instincts" || section === "all") {
      sections.push(this.formatInstincts());
    }

    if (section === "metrics" || section === "all") {
      sections.push(this.formatMetrics());
    }

    return { content: sections.join("\n\n") };
  }

  private formatInstincts(): string {
    if (!this.learningStorage) {
      return unavailableSection("Instincts", "LearningStorage not initialized");
    }

    try {
      const stats = this.learningStorage.getStats();
      return buildSection("Instincts", [
        `**Total instincts:** ${stats.instinctCount}`,
        `**Active instincts:** ${stats.activeInstinctCount}`,
        `**Trajectories:** ${stats.trajectoryCount}`,
        `**Error patterns:** ${stats.errorPatternCount}`,
        `**Observations:** ${stats.observationCount} (${stats.unprocessedObservationCount} unprocessed)`,
      ]);
    } catch {
      return unavailableSection("Instincts", "error reading learning storage");
    }
  }

  private formatMetrics(): string {
    if (!this.metricsStorage) {
      return unavailableSection("Task Metrics", "MetricsStorage not initialized");
    }

    try {
      const agg = this.metricsStorage.getAggregation({});
      const completionPct = (agg.completionRate * 100).toFixed(1);
      return buildSection("Task Metrics", [
        `**Total tasks:** ${agg.totalTasks}`,
        `**Success rate:** ${completionPct}% (${agg.successCount}/${agg.totalTasks})`,
        `**Failures:** ${agg.failureCount} | **Partial:** ${agg.partialCount}`,
        `**Avg iterations:** ${agg.avgIterations}`,
        `**Avg tool calls:** ${agg.avgToolCalls}`,
        `**Instinct reuse:** ${agg.instinctReusePct}% of tasks guided by instincts`,
      ]);
    } catch {
      return unavailableSection("Task Metrics", "error reading metrics storage");
    }
  }
}
