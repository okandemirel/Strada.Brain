/**
 * MetricsStorage Tests
 *
 * Tests SQLite storage for the task_metrics table in learning.db.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetricsStorage } from "./metrics-storage.js";
import type { TaskMetric } from "./metrics-types.js";

function createMetric(overrides: Partial<TaskMetric> = {}): TaskMetric {
  const now = Date.now();
  return {
    id: `metric_test_${Math.random().toString(36).slice(2)}`,
    sessionId: "chat_001",
    taskType: "interactive",
    taskDescription: "Fix the build error",
    completionStatus: "success",
    paorIterations: 3,
    toolCallCount: 5,
    instinctIds: [],
    instinctCount: 0,
    startedAt: now - 1000,
    completedAt: now,
    durationMs: 1000,
    ...overrides,
  };
}

describe("MetricsStorage", () => {
  let tempDir: string;
  let storage: MetricsStorage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "metrics-storage-test-"));
    const dbPath = join(tempDir, "learning.db");
    storage = new MetricsStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("initialize", () => {
    it("should create task_metrics table in the database", () => {
      // Re-opening the DB should not fail (table already exists)
      const dbPath = join(tempDir, "learning.db");
      const storage2 = new MetricsStorage(dbPath);
      storage2.initialize();
      storage2.close();
    });
  });

  describe("recordTaskMetric", () => {
    it("should insert a metric row", () => {
      const metric = createMetric({ id: "metric_insert_test" });
      storage.recordTaskMetric(metric);

      const rows = storage.getTaskMetrics({});
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe("metric_insert_test");
    });

    it("should be idempotent on duplicate ID (INSERT OR REPLACE)", () => {
      const metric = createMetric({ id: "metric_dup" });
      storage.recordTaskMetric(metric);
      storage.recordTaskMetric({ ...metric, completionStatus: "failure" });

      const rows = storage.getTaskMetrics({});
      expect(rows).toHaveLength(1);
      expect(rows[0]!.completionStatus).toBe("failure");
    });

    it("should store instinct_ids as JSON array", () => {
      const metric = createMetric({
        instinctIds: ["inst_001", "inst_002"],
        instinctCount: 2,
      });
      storage.recordTaskMetric(metric);

      const rows = storage.getTaskMetrics({});
      expect(rows[0]!.instinctIds).toEqual(["inst_001", "inst_002"]);
      expect(rows[0]!.instinctCount).toBe(2);
    });

    it("should store parent_task_id for subtasks", () => {
      const metric = createMetric({
        taskType: "subtask",
        parentTaskId: "metric_parent_001",
      });
      storage.recordTaskMetric(metric);

      const rows = storage.getTaskMetrics({});
      expect(rows[0]!.parentTaskId).toBe("metric_parent_001");
    });
  });

  describe("getTaskMetrics", () => {
    beforeEach(() => {
      storage.recordTaskMetric(createMetric({ id: "m1", sessionId: "chat_001", taskType: "interactive", completionStatus: "success", completedAt: 1000 }));
      storage.recordTaskMetric(createMetric({ id: "m2", sessionId: "chat_001", taskType: "background", completionStatus: "failure", completedAt: 2000 }));
      storage.recordTaskMetric(createMetric({ id: "m3", sessionId: "chat_002", taskType: "interactive", completionStatus: "partial", completedAt: 3000 }));
      storage.recordTaskMetric(createMetric({ id: "m4", sessionId: "chat_002", taskType: "subtask", completionStatus: "success", completedAt: 4000, parentTaskId: "m3" }));
    });

    it("should return all rows with empty filter", () => {
      const rows = storage.getTaskMetrics({});
      expect(rows).toHaveLength(4);
    });

    it("should filter by sessionId", () => {
      const rows = storage.getTaskMetrics({ sessionId: "chat_002" });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.sessionId === "chat_002")).toBe(true);
    });

    it("should filter by taskType", () => {
      const rows = storage.getTaskMetrics({ taskType: "interactive" });
      expect(rows).toHaveLength(2);
    });

    it("should filter by completionStatus", () => {
      const rows = storage.getTaskMetrics({ completionStatus: "success" });
      expect(rows).toHaveLength(2);
    });

    it("should filter by since timestamp", () => {
      const rows = storage.getTaskMetrics({ since: 2500 });
      expect(rows).toHaveLength(2);
    });

    it("should filter by until timestamp", () => {
      const rows = storage.getTaskMetrics({ until: 2500 });
      expect(rows).toHaveLength(2);
    });

    it("should respect limit", () => {
      const rows = storage.getTaskMetrics({ limit: 2 });
      expect(rows).toHaveLength(2);
    });
  });

  describe("getAggregation", () => {
    beforeEach(() => {
      storage.recordTaskMetric(createMetric({
        id: "a1", sessionId: "chat_001", completionStatus: "success",
        paorIterations: 4, toolCallCount: 10, instinctIds: ["inst_1"], instinctCount: 1,
      }));
      storage.recordTaskMetric(createMetric({
        id: "a2", sessionId: "chat_001", completionStatus: "failure",
        paorIterations: 2, toolCallCount: 6, instinctIds: [], instinctCount: 0,
      }));
      storage.recordTaskMetric(createMetric({
        id: "a3", sessionId: "chat_002", completionStatus: "partial",
        paorIterations: 6, toolCallCount: 8, instinctIds: ["inst_1", "inst_2"], instinctCount: 2,
      }));
    });

    it("should return correct totals across all metrics", () => {
      const agg = storage.getAggregation({});
      expect(agg.totalTasks).toBe(3);
      expect(agg.successCount).toBe(1);
      expect(agg.failureCount).toBe(1);
      expect(agg.partialCount).toBe(1);
    });

    it("should compute completion rate correctly", () => {
      const agg = storage.getAggregation({});
      expect(agg.completionRate).toBeCloseTo(1 / 3, 5);
    });

    it("should compute average iterations and tool calls", () => {
      const agg = storage.getAggregation({});
      expect(agg.avgIterations).toBeCloseTo(4, 5); // (4+2+6)/3
      expect(agg.avgToolCalls).toBe(8); // (10+6+8)/3
    });

    it("should compute instinct reuse metrics", () => {
      const agg = storage.getAggregation({});
      expect(agg.tasksWithInstincts).toBe(2);
      expect(agg.instinctReusePct).toBeCloseTo((2 / 3) * 100, 1);
      expect(agg.avgInstinctsPerInformedTask).toBe(1.5); // (1+2)/2
    });

    it("should filter by sessionId correctly", () => {
      const agg = storage.getAggregation({ sessionId: "chat_001" });
      expect(agg.totalTasks).toBe(2);
      expect(agg.successCount).toBe(1);
      expect(agg.failureCount).toBe(1);
    });

    it("should filter by taskType (excludes background/subtask)", () => {
      storage.recordTaskMetric(createMetric({
        id: "a4", taskType: "background", completionStatus: "success",
        paorIterations: 0, toolCallCount: 3,
      }));
      const agg = storage.getAggregation({ taskType: "interactive" });
      // Only the 3 original interactive metrics
      expect(agg.totalTasks).toBe(3);
    });

    it("should return zeroes for empty result set", () => {
      const agg = storage.getAggregation({ sessionId: "nonexistent" });
      expect(agg.totalTasks).toBe(0);
      expect(agg.completionRate).toBe(0);
      expect(agg.avgIterations).toBe(0);
      expect(agg.avgToolCalls).toBe(0);
      expect(agg.instinctReusePct).toBe(0);
      expect(agg.avgInstinctsPerInformedTask).toBe(0);
    });
  });

  describe("getInstinctLeaderboard", () => {
    beforeEach(() => {
      storage.recordTaskMetric(createMetric({
        id: "lb1", completionStatus: "success",
        instinctIds: ["inst_alpha", "inst_beta"], instinctCount: 2,
      }));
      storage.recordTaskMetric(createMetric({
        id: "lb2", completionStatus: "failure",
        instinctIds: ["inst_alpha"], instinctCount: 1,
      }));
      storage.recordTaskMetric(createMetric({
        id: "lb3", completionStatus: "success",
        instinctIds: ["inst_alpha", "inst_gamma"], instinctCount: 2,
      }));
    });

    it("should return instinct IDs ranked by usage count", () => {
      const board = storage.getInstinctLeaderboard();
      expect(board).toHaveLength(3);
      expect(board[0]!.instinctId).toBe("inst_alpha");
      expect(board[0]!.usageCount).toBe(3);
    });

    it("should compute success rate per instinct", () => {
      const board = storage.getInstinctLeaderboard();
      const alpha = board.find((e) => e.instinctId === "inst_alpha")!;
      // alpha used in 3 tasks: 2 success, 1 failure
      expect(alpha.taskSuccessRate).toBeCloseTo(2 / 3, 5);

      const beta = board.find((e) => e.instinctId === "inst_beta")!;
      // beta used in 1 task: 1 success
      expect(beta.taskSuccessRate).toBe(1);
    });

    it("should respect limit parameter", () => {
      const board = storage.getInstinctLeaderboard(2);
      expect(board).toHaveLength(2);
    });
  });

  describe("close", () => {
    it("should close the database connection without error", () => {
      expect(() => storage.close()).not.toThrow();
    });
  });
});
