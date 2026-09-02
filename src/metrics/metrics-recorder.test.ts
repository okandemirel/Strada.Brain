/**
 * MetricsRecorder Tests
 *
 * Tests the thin facade that the orchestrator calls to record metrics.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const warnSpy = vi.fn();
vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() }),
}));

import { MetricsRecorder } from "./metrics-recorder.js";
import { MetricsStorage } from "./metrics-storage.js";
import { AgentPhase } from "../agents/agent-state.js";

function createMockStorage(): MetricsStorage {
  return {
    recordTaskMetric: vi.fn(),
    recordRetrievalMetric: vi.fn(),
    getTaskMetrics: vi.fn().mockReturnValue([]),
    getAggregation: vi.fn(),
    getInstinctLeaderboard: vi.fn(),
    initialize: vi.fn(),
    close: vi.fn(),
  } as unknown as MetricsStorage;
}

describe("MetricsRecorder", () => {
  let mockStorage: MetricsStorage;
  let recorder: MetricsRecorder;

  beforeEach(() => {
    mockStorage = createMockStorage();
    recorder = new MetricsRecorder(mockStorage);
  });

  describe("startTask", () => {
    it("should return a unique metric ID", () => {
      const id1 = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Build project",
        taskType: "interactive",
      });
      const id2 = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Run tests",
        taskType: "interactive",
      });

      expect(id1).toMatch(/^metric_/);
      expect(id2).toMatch(/^metric_/);
      expect(id1).not.toBe(id2);
    });

    it("should accept optional instinctIds", () => {
      const id = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Build project",
        taskType: "interactive",
        instinctIds: ["inst_001", "inst_002"],
      });
      expect(id).toMatch(/^metric_/);
    });

    it("should accept optional parentTaskId", () => {
      const id = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Subtask 1",
        taskType: "subtask",
        parentTaskId: "metric_parent",
      });
      expect(id).toMatch(/^metric_/);
    });
  });

  describe("endTask", () => {
    it("should map AgentPhase.COMPLETE to success", () => {
      const id = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Build project",
        taskType: "interactive",
      });

      recorder.endTask(id, {
        agentPhase: AgentPhase.COMPLETE,
        iterations: 3,
        toolCallCount: 5,
        terminatedByIterationBudget: false,
      });

      expect(mockStorage.recordTaskMetric).toHaveBeenCalledOnce();
      const metric = (mockStorage.recordTaskMetric as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(metric.completionStatus).toBe("success");
    });

    it("should map AgentPhase.FAILED to failure", () => {
      const id = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Build project",
        taskType: "interactive",
      });

      recorder.endTask(id, {
        agentPhase: AgentPhase.FAILED,
        iterations: 2,
        toolCallCount: 4,
        terminatedByIterationBudget: false,
      });

      const metric = (mockStorage.recordTaskMetric as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(metric.completionStatus).toBe("failure");
    });

    it("should map terminatedByIterationBudget=true to partial", () => {
      const id = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Build project",
        taskType: "interactive",
      });

      recorder.endTask(id, {
        agentPhase: AgentPhase.EXECUTING,
        iterations: 50,
        toolCallCount: 100,
        iterationBudgetReached: true,
        continuedAfterBudget: false,
        epochCount: 1,
        terminatedByIterationBudget: true,
      });

      const metric = (mockStorage.recordTaskMetric as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(metric.completionStatus).toBe("partial");
    });

    it("should write metric with correct iterations and tool count", () => {
      const id = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Build project",
        taskType: "interactive",
      });

      recorder.endTask(id, {
        agentPhase: AgentPhase.COMPLETE,
        iterations: 7,
        toolCallCount: 15,
        terminatedByIterationBudget: false,
      });

      const metric = (mockStorage.recordTaskMetric as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(metric.paorIterations).toBe(7);
      expect(metric.toolCallCount).toBe(15);
    });

    it("should pass instinctIds from startTask to the recorded metric", () => {
      const id = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Build project",
        taskType: "interactive",
        instinctIds: ["inst_001", "inst_002"],
      });

      recorder.endTask(id, {
        agentPhase: AgentPhase.COMPLETE,
        iterations: 1,
        toolCallCount: 2,
        terminatedByIterationBudget: false,
      });

      const metric = (mockStorage.recordTaskMetric as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(metric.instinctIds).toEqual(["inst_001", "inst_002"]);
      expect(metric.instinctCount).toBe(2);
    });

    it("should pass parentTaskId from startTask to the recorded metric", () => {
      const id = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Subtask 1",
        taskType: "subtask",
        parentTaskId: "metric_parent",
      });

      recorder.endTask(id, {
        agentPhase: AgentPhase.COMPLETE,
        iterations: 1,
        toolCallCount: 2,
        terminatedByIterationBudget: false,
      });

      const metric = (mockStorage.recordTaskMetric as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(metric.parentTaskId).toBe("metric_parent");
      expect(metric.taskType).toBe("subtask");
    });

    it("should compute durationMs from start to end", () => {
      const id = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Build project",
        taskType: "interactive",
      });

      // Small delay to ensure non-zero duration
      recorder.endTask(id, {
        agentPhase: AgentPhase.COMPLETE,
        iterations: 1,
        toolCallCount: 1,
        terminatedByIterationBudget: false,
      });

      const metric = (mockStorage.recordTaskMetric as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(metric.durationMs).toBeGreaterThanOrEqual(0);
      expect(metric.startedAt).toBeLessThanOrEqual(metric.completedAt);
    });
  });

  describe("idempotent endTask", () => {
    it("should be safe to call endTask twice (no-op on second call)", () => {
      const id = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Build project",
        taskType: "interactive",
      });

      recorder.endTask(id, {
        agentPhase: AgentPhase.COMPLETE,
        iterations: 1,
        toolCallCount: 1,
        terminatedByIterationBudget: false,
      });

      // Second call should be a no-op (not throw, not double-record)
      recorder.endTask(id, {
        agentPhase: AgentPhase.FAILED,
        iterations: 2,
        toolCallCount: 5,
        terminatedByIterationBudget: false,
      });

      // Only one record call
      expect(mockStorage.recordTaskMetric).toHaveBeenCalledTimes(1);
    });

    it("should be safe to call endTask with unknown ID", () => {
      // Should not throw
      recorder.endTask("metric_unknown", {
        agentPhase: AgentPhase.COMPLETE,
        iterations: 1,
        toolCallCount: 1,
        terminatedByIterationBudget: false,
      });

      expect(mockStorage.recordTaskMetric).not.toHaveBeenCalled();
    });
  });
});

// ─── Retrieval metrics land, in their own table (audited 2026-09-02) ─────────

describe("MetricsRecorder.recordRetrievalMetrics against a REAL MetricsStorage", () => {
  let tempDir: string;
  let storage: MetricsStorage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "metrics-recorder-retrieval-"));
    storage = new MetricsStorage(join(tempDir, "learning.db"));
    storage.initialize();
    warnSpy.mockClear();
    return () => {
      storage.close();
      rmSync(tempDir, { recursive: true, force: true });
    };
  });

  it("persists every retrieval field and leaves the task aggregates untouched", () => {
    // Before: the row went to task_metrics as task_type 'simple', the CHECK
    // constraint rejected it, the bare catch swallowed it — zero rows ever landed.
    const recorder = new MetricsRecorder(storage);
    recorder.recordRetrievalMetrics({
      retrievalTimeMs: 42,
      instinctsScanned: 7,
      scopeFiltered: 2,
      insightsReturned: 3,
    });

    const rows = storage.getRetrievalMetrics();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ retrievalTimeMs: 42, instinctsScanned: 7, scopeFiltered: 2, insightsReturned: 3 });
    expect(rows[0]!.id).toMatch(/^retrieval_/);
    expect(storage.getRetrievalAggregation()).toMatchObject({ retrievals: 1, avgRetrievalTimeMs: 42, avgInsightsReturned: 3 });

    // A retrieval is not a task: EVAL-01/EVAL-03 must not see it.
    expect(storage.getTaskMetrics({})).toHaveLength(0);
    expect(storage.getAggregation({}).totalTasks).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs a warning (once) when the write fails instead of silently discarding it", () => {
    storage.close(); // ensureConnection() now throws
    const recorder = new MetricsRecorder(storage);
    recorder.recordRetrievalMetrics({ retrievalTimeMs: 1, instinctsScanned: 0, scopeFiltered: 0, insightsReturned: 0 });
    recorder.recordRetrievalMetrics({ retrievalTimeMs: 1, instinctsScanned: 0, scopeFiltered: 0, insightsReturned: 0 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/NOT being recorded/);
  });
});
