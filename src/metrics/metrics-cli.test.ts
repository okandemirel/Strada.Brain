/**
 * Metrics CLI Tests
 *
 * Tests for formatMetricsTable, formatMetricsJson, and runMetricsCommand.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { MetricsAggregation } from "./metrics-types.js";
import { MetricsStorage } from "./metrics-storage.js";

// A real learning.db in a temp dir stands in for the configured memory path.
const cliDb = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), "metrics-cli-since-")) };
});
vi.mock("../config/config.js", () => ({
  loadConfigSafe: () => ({ kind: "ok", value: { memory: { dbPath: cliDb.dir } } }),
}));

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

  describe("formatMetricsTable with lifecycle", () => {
    it("should include Instinct Library Health section with status counts", async () => {
      const { formatMetricsTable } = await import("./metrics-cli.js");
      const aggWithLifecycle: MetricsAggregation = {
        ...MOCK_AGGREGATION,
        lifecycle: {
          statusCounts: { permanent: 5, active: 23, cooling: 3, proposed: 8, deprecated: 2 },
          weeklyTrends: [{ weekStart: Date.now(), promoted: 2, deprecated: 1, coolingStarted: 0, coolingRecovered: 0 }],
        },
      };

      const output = formatMetricsTable(aggWithLifecycle);

      expect(output).toContain("Instinct Library Health");
      expect(output).toContain("Permanent:");
      expect(output).toContain("5");
      expect(output).toContain("Active:");
      expect(output).toContain("23");
      expect(output).toContain("Cooling:");
      expect(output).toContain("3");
      expect(output).toContain("Proposed:");
      expect(output).toContain("8");
      expect(output).toContain("Deprecated:");
      expect(output).toContain("2");
    });

    it("should include weekly trends line", async () => {
      const { formatMetricsTable } = await import("./metrics-cli.js");
      const aggWithLifecycle: MetricsAggregation = {
        ...MOCK_AGGREGATION,
        lifecycle: {
          statusCounts: { permanent: 5, active: 23, cooling: 3, proposed: 8, deprecated: 2 },
          weeklyTrends: [{ weekStart: Date.now(), promoted: 2, deprecated: 1, coolingStarted: 0, coolingRecovered: 0 }],
        },
      };

      const output = formatMetricsTable(aggWithLifecycle);

      expect(output).toContain("This week:");
      expect(output).toContain("2 promoted");
      expect(output).toContain("1 deprecated");
    });

    it("should not show lifecycle section when lifecycle data absent (backward compat)", async () => {
      const { formatMetricsTable } = await import("./metrics-cli.js");
      const output = formatMetricsTable(MOCK_AGGREGATION);

      expect(output).not.toContain("Instinct Library Health");
      expect(output).not.toContain("Permanent:");
    });
  });

  describe("formatMetricsJson with lifecycle", () => {
    it("should include lifecycle object with status counts and weekly trends", async () => {
      const { formatMetricsJson } = await import("./metrics-cli.js");
      const aggWithLifecycle: MetricsAggregation = {
        ...MOCK_AGGREGATION,
        lifecycle: {
          statusCounts: { permanent: 5, active: 23, cooling: 3, proposed: 8, deprecated: 2 },
          weeklyTrends: [{ weekStart: 1000, promoted: 2, deprecated: 1, coolingStarted: 0, coolingRecovered: 0 }],
        },
      };

      const output = formatMetricsJson(aggWithLifecycle);
      const parsed = JSON.parse(output);

      expect(parsed.lifecycle).toBeDefined();
      expect(parsed.lifecycle.statusCounts.permanent).toBe(5);
      expect(parsed.lifecycle.statusCounts.active).toBe(23);
      expect(parsed.lifecycle.weeklyTrends).toHaveLength(1);
      expect(parsed.lifecycle.weeklyTrends[0].promoted).toBe(2);
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

// ─── --since must name its window or refuse (audited 2026-09-02) ─────────────

describe("runMetricsCommand --since", () => {
  const DAY = 86_400_000;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // 9 failures 100 days old, 1 success 1 day old — a 7-day window and "all
    // time" disagree by 10x, so a dropped filter cannot hide.
    const seed = new MetricsStorage(join(cliDb.dir, "learning.db"));
    seed.initialize();
    const now = Date.now();
    for (let i = 0; i < 9; i++) {
      seed.recordTaskMetric({
        id: `metric_old_${i}`, sessionId: "s", taskType: "background", taskDescription: "old",
        completionStatus: "failure", paorIterations: 1, toolCallCount: 1, instinctIds: [], instinctCount: 0,
        startedAt: now - 100 * DAY - 1000, completedAt: now - 100 * DAY, durationMs: 1000,
      });
    }
    seed.recordTaskMetric({
      id: "metric_new", sessionId: "s", taskType: "background", taskDescription: "new",
      completionStatus: "success", paorIterations: 1, toolCallCount: 1, instinctIds: [], instinctCount: 0,
      startedAt: now - DAY - 1000, completedAt: now - DAY, durationMs: 1000,
    });
    seed.close();

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    rmSync(cliDb.dir, { recursive: true, force: true });
  });

  it("refuses an unparseable window, names the bad token, and prints no metrics", async () => {
    const { runMetricsCommand } = await import("./metrics-cli.js");
    expect(() => runMetricsCommand({ since: "1w" })).toThrow("process.exit(1)");
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain('"1w"');
    expect(stderr).toMatch(/7d/); // the accepted grammar is spelled out
    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stdout).not.toContain("Agent Performance Metrics");
    expect(stdout).not.toContain("Total Tasks");
  });

  it("prints the window it measured when the filter is applied, and 'all time' when it is not", async () => {
    const { runMetricsCommand } = await import("./metrics-cli.js");

    runMetricsCommand({ since: "7d" });
    const scoped = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(scoped).toMatch(/Window:\s+last 7d \(since \d{4}-\d{2}-\d{2}T/);
    expect(scoped).toMatch(/Total Tasks:\s+1\b/);

    logSpy.mockClear();
    runMetricsCommand({});
    const unscoped = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(unscoped).toMatch(/Window:\s+all time/);
    expect(unscoped).toMatch(/Total Tasks:\s+10\b/);

    logSpy.mockClear();
    runMetricsCommand({ since: "7d", json: true });
    const parsed = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join("\n")) as { totalTasks: number; window: { since: number | null; label: string } };
    expect(parsed.totalTasks).toBe(1);
    expect(parsed.window.label).toBe("last 7d");
    expect(typeof parsed.window.since).toBe("number");
  });

  it("accepts a window older than the epoch and says it was clamped", async () => {
    // audited 2026-09-02: `30000d` is inside the documented grammar, but
    // now - 30000d is negative, so the parser returned null and the CLI died
    // with "Unrecognized --since" — a grammar error for a legal token.
    const { runMetricsCommand } = await import("./metrics-cli.js");

    runMetricsCommand({ since: "30000d" });
    const stdout = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stdout).toMatch(/Window:\s+last 30000d \(clamped to the epoch\)/);
    // Clamped means "everything on record", and it is labelled as such — not
    // silently shortened, and not passed off as an ordinary 30000d window.
    expect(stdout).toMatch(/Total Tasks:\s+10\b/);
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).not.toMatch(/Unrecognized/);

    logSpy.mockClear();
    runMetricsCommand({ since: "30000d", json: true });
    const parsed = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join("\n")) as {
      window: { since: number | null; label: string };
    };
    expect(parsed.window.since).toBe(0);
    expect(parsed.window.label).toBe("last 30000d (clamped to the epoch)");
  });
});
