/**
 * Metrics CLI Tests
 *
 * Tests for formatMetricsTable, formatMetricsJson, and runMetricsCommand.
 */

import { describe, it, expect, vi } from "vitest";
import type { MetricsAggregation } from "./metrics-types.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const MOCK_AGGREGATION: MetricsAggregation = {
  totalTasks: 42,
  successCount: 36,
  failureCount: 3,
  partialCount: 3,
  completionRate: 0.857,
  avgIterations: 4.2,
  avgToolCalls: 8.7,
  tasksWithInstincts: 26,
  instinctReusePct: 61.9,
  avgInstinctsPerInformedTask: 2.3,
};

const ZERO_AGGREGATION: MetricsAggregation = {
  totalTasks: 0,
  successCount: 0,
  failureCount: 0,
  partialCount: 0,
  completionRate: 0,
  avgIterations: 0,
  avgToolCalls: 0,
  tasksWithInstincts: 0,
  instinctReusePct: 0,
  avgInstinctsPerInformedTask: 0,
};

const PERFECT_AGGREGATION: MetricsAggregation = {
  totalTasks: 10,
  successCount: 10,
  failureCount: 0,
  partialCount: 0,
  completionRate: 1.0,
  avgIterations: 3.0,
  avgToolCalls: 5.0,
  tasksWithInstincts: 10,
  instinctReusePct: 100,
  avgInstinctsPerInformedTask: 4.0,
};

describe("metrics-cli", () => {
  describe("formatMetricsTable", () => {
    it("should format aggregation into readable ASCII table", async () => {
      const { formatMetricsTable } = await import("./metrics-cli.js");
      const output = formatMetricsTable(MOCK_AGGREGATION);

      expect(output).toContain("Agent Performance Metrics");
      expect(output).toContain("Total Tasks:");
      expect(output).toContain("42");
      expect(output).toContain("Completion Rate:");
      expect(output).toContain("85.7%");
      expect(output).toContain("Success:");
      expect(output).toContain("36");
      expect(output).toContain("Failure:");
      expect(output).toContain("3");
      expect(output).toContain("Partial:");
      expect(output).toContain("Avg Iterations:");
      expect(output).toContain("4.2");
      expect(output).toContain("Avg Tool Calls:");
      expect(output).toContain("8.7");
      expect(output).toContain("Instinct Reuse:");
      expect(output).toContain("61.9%");
      expect(output).toContain("Avg Instincts/Task:");
      expect(output).toContain("2.3");
    });

    it("should handle zero tasks gracefully (no NaN)", async () => {
      const { formatMetricsTable } = await import("./metrics-cli.js");
      const output = formatMetricsTable(ZERO_AGGREGATION);

      expect(output).toContain("Total Tasks:");
      expect(output).toContain("0");
      expect(output).toContain("0.0%");
      expect(output).not.toContain("NaN");
      expect(output).not.toContain("undefined");
    });

    it("should handle 100% completion rate", async () => {
      const { formatMetricsTable } = await import("./metrics-cli.js");
      const output = formatMetricsTable(PERFECT_AGGREGATION);

      expect(output).toContain("100.0%");
      expect(output).toContain("10");
    });
  });

  describe("formatMetricsJson", () => {
    it("should return valid pretty-printed JSON", async () => {
      const { formatMetricsJson } = await import("./metrics-cli.js");
      const output = formatMetricsJson(MOCK_AGGREGATION);

      const parsed = JSON.parse(output);
      expect(parsed.totalTasks).toBe(42);
      expect(parsed.completionRate).toBe(0.857);
      expect(parsed.avgIterations).toBe(4.2);
    });

    it("should round-trip back to same data", async () => {
      const { formatMetricsJson } = await import("./metrics-cli.js");
      const output = formatMetricsJson(MOCK_AGGREGATION);

      const parsed = JSON.parse(output) as MetricsAggregation;
      expect(parsed).toEqual(MOCK_AGGREGATION);
    });
  });
});
