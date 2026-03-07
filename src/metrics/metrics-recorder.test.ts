/**
 * MetricsRecorder Tests
 *
 * Tests the thin facade that the orchestrator calls to record metrics.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MetricsRecorder } from "./metrics-recorder.js";
import type { MetricsStorage } from "./metrics-storage.js";
import { AgentPhase } from "../agents/agent-state.js";

function createMockStorage(): MetricsStorage {
  return {
    recordTaskMetric: vi.fn(),
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
        hitMaxIterations: false,
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
        hitMaxIterations: false,
      });

      const metric = (mockStorage.recordTaskMetric as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(metric.completionStatus).toBe("failure");
    });

    it("should map hitMaxIterations=true to partial", () => {
      const id = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Build project",
        taskType: "interactive",
      });

      recorder.endTask(id, {
        agentPhase: AgentPhase.EXECUTING,
        iterations: 50,
        toolCallCount: 100,
        hitMaxIterations: true,
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
        hitMaxIterations: false,
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
        hitMaxIterations: false,
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
        hitMaxIterations: false,
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
        hitMaxIterations: false,
      });

      const metric = (mockStorage.recordTaskMetric as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(metric.durationMs).toBeGreaterThanOrEqual(0);
      expect(metric.startedAt).toBeLessThanOrEqual(metric.completedAt);
    });
  });

  describe("isRecorded", () => {
    it("should return false before endTask", () => {
      const id = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Build project",
        taskType: "interactive",
      });

      expect(recorder.isRecorded(id)).toBe(false);
    });

    it("should return true after endTask", () => {
      const id = recorder.startTask({
        sessionId: "chat_001",
        taskDescription: "Build project",
        taskType: "interactive",
      });

      recorder.endTask(id, {
        agentPhase: AgentPhase.COMPLETE,
        iterations: 1,
        toolCallCount: 1,
        hitMaxIterations: false,
      });

      expect(recorder.isRecorded(id)).toBe(true);
    });

    it("should return false for unknown metric ID", () => {
      expect(recorder.isRecorded("metric_unknown")).toBe(false);
    });
  });
});
