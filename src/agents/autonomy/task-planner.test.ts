import { describe, it, expect, beforeEach, vi } from "vitest";
import { TaskPlanner, type TaskState } from "./task-planner.ts";
import { LearningPipeline } from "../../learning/pipeline/learning-pipeline.ts";
import { LearningStorage } from "../../learning/storage/learning-storage.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("TaskPlanner", () => {
  let planner: TaskPlanner;

  beforeEach(() => {
    planner = new TaskPlanner();
  });

  describe("Lifecycle", () => {
    it("should reset to initial state", () => {
      planner.trackToolCall("file_write", false);
      planner.reset();

      const state = planner.getState();
      expect(state.iterationsUsed).toBe(0);
      expect(state.budgetWindowIterationsUsed).toBe(0);
      expect(state.consecutiveErrors).toBe(0);
    });

    it("should start task with learning", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "planner-test-"));
      const dbPath = join(tempDir, "test.db");
      const storage = new LearningStorage(dbPath);
      storage.initialize();
      const pipeline = new LearningPipeline(storage);

      planner.startTask({
        sessionId: "test-session",
        taskDescription: "Test task",
        learningPipeline: pipeline,
      });

      expect(planner.isActive()).toBe(true);
      const state = planner.getState();
      expect(state.sessionId).toBe("test-session");
      expect(state.taskDescription).toBe("Test task");

      storage.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("should end task and record trajectory", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "planner-test-"));
      const dbPath = join(tempDir, "test.db");
      const storage = new LearningStorage(dbPath);
      storage.initialize();
      const pipeline = new LearningPipeline(storage);

      planner.startTask({
        sessionId: "test-session",
        taskDescription: "Test task",
        learningPipeline: pipeline,
      });

      planner.trackToolCall("file_write", false);

      planner.endTask({
        success: true,
        hadErrors: false,
        errorCount: 0,
      });

      expect(planner.isActive()).toBe(false);
      expect(pipeline.getStats().trajectoryCount).toBe(1);

      storage.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("persists chatId and taskRunId with the recorded trajectory", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "planner-test-"));
      const dbPath = join(tempDir, "test.db");
      const storage = new LearningStorage(dbPath);
      storage.initialize();
      const pipeline = new LearningPipeline(storage);

      planner.startTask({
        sessionId: "test-session",
        chatId: "chat-31",
        taskDescription: "Inspect Level_031",
        learningPipeline: pipeline,
      });

      const taskRunId = planner.getTaskRunId();
      expect(taskRunId).toMatch(/^taskrun_/);

      planner.endTask({
        success: true,
        hadErrors: false,
        errorCount: 0,
      });

      const trajectory = storage.getTrajectories({ limit: 1 })[0];
      expect(trajectory?.chatId).toBe("chat-31");
      expect(trajectory?.taskRunId).toBe(taskRunId);

      storage.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("records replay context alongside the trajectory outcome", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "planner-test-"));
      const dbPath = join(tempDir, "test.db");
      const storage = new LearningStorage(dbPath);
      storage.initialize();
      const pipeline = new LearningPipeline(storage);

      planner.startTask({
        sessionId: "test-session",
        taskDescription: "Test task",
        learningPipeline: pipeline,
      });
      planner.attachReplayContext({
        projectWorldFingerprint: "root tiki arrows modules castle systems 9",
        projectWorldSummary: "root=/Users/okan/Tiki/arrows | modules=Castle",
        branchSummary: "stable checkpoint: inspected Level_031",
        verifierSummary: "runtime replay still required",
        learnedInsights: ["Avoid trusting serialized YAML alone."],
        phaseTelemetry: [
          {
            phase: "planning",
            role: "planner",
            provider: "kimi",
            model: "kimi-k2",
            source: "supervisor-strategy",
            status: "approved",
            verifierDecision: "approve",
            phaseVerdict: "clean",
            phaseVerdictScore: 1,
            timestamp: Date.now(),
          },
        ],
      });

      planner.endTask({
        success: true,
        hadErrors: false,
        errorCount: 0,
      });

      const trajectory = storage.getTrajectories({ limit: 1 })[0];
      expect(trajectory?.outcome.replayContext?.projectWorldFingerprint).toContain(
        "castle systems 9",
      );
      expect(trajectory?.outcome.replayContext?.branchSummary).toContain("Level_031");
      expect(trajectory?.outcome.replayContext?.learnedInsights).toEqual([
        "Avoid trusting serialized YAML alone.",
      ]);
      expect(trajectory?.outcome.replayContext?.phaseTelemetry).toEqual([
        expect.objectContaining({
          phase: "planning",
          provider: "kimi",
          status: "approved",
          phaseVerdict: "clean",
          phaseVerdictScore: 1,
        }),
      ]);

      storage.close();
      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("Tool Call Tracking", () => {
    it("should track mutations", () => {
      planner.trackToolCall("file_write", false);
      planner.trackToolCall("file_edit", false);

      const state = planner.getState();
      expect(state.mutationsSinceVerify).toBe(2);
    });

    it("should track verifications", () => {
      planner.trackToolCall("file_write", false);
      planner.trackToolCall("file_write", false);
      planner.trackToolCall("dotnet_build", false);

      const state = planner.getState();
      expect(state.mutationsSinceVerify).toBe(0);
      expect(state.buildVerified).toBe(true);
    });

    it("should treat generic Unity verification tools as successful verification", () => {
      planner.trackToolCall("file_write", false);
      planner.trackToolCall("unity_playmode_test", false);

      const state = planner.getState();
      expect(state.mutationsSinceVerify).toBe(0);
      expect(state.buildVerified).toBe(true);
    });

    it("should expand nested batch_execute operations for verification tracking", () => {
      planner.trackToolCall(
        "batch_execute",
        false,
        {
          operations: [
            { tool: "file_write", input: { path: "Assets/Gameplay/BatchedSystem.cs" } },
            { tool: "unity_playmode_test", input: {} },
          ],
        },
        JSON.stringify({
          results: [
            { tool: "file_write", success: true, content: "written" },
            { tool: "unity_playmode_test", success: true, content: "all green" },
          ],
        }),
      );

      const state = planner.getState();
      expect(state.mutationsSinceVerify).toBe(0);
      expect(state.buildVerified).toBe(true);
    });

    it("should track consecutive errors", () => {
      planner.trackToolCall("file_write", true);
      planner.trackToolCall("file_edit", true);
      planner.trackToolCall("dotnet_build", true);

      const state = planner.getState();
      expect(state.consecutiveErrors).toBe(3);
    });

    it("should reset consecutive errors on success", () => {
      planner.trackToolCall("file_write", true);
      planner.trackToolCall("file_write", true);
      planner.trackToolCall("file_read", false);

      const state = planner.getState();
      expect(state.consecutiveErrors).toBe(0);
    });

    it("should track iterations", () => {
      planner.trackToolCall("file_read", false);
      planner.trackToolCall("file_write", false);
      planner.trackToolCall("dotnet_build", false);

      const state = planner.getState();
      expect(state.iterationsUsed).toBe(3);
      expect(state.budgetWindowIterationsUsed).toBe(3);
    });

    it("should reset only the active budget window", () => {
      planner.trackToolCall("file_read", false);
      planner.trackToolCall("file_read", false);

      planner.resetBudgetWindow();

      const state = planner.getState();
      expect(state.iterationsUsed).toBe(2);
      expect(state.budgetWindowIterationsUsed).toBe(0);
    });
  });

  describe("Error Tracking", () => {
    it("should record error summary", () => {
      planner.recordError("missing_type error in File.cs");

      const state = planner.getState();
      expect(state.errorHistory).toContain("missing_type error in File.cs");
    });

    it("should bound error history to 10 entries", () => {
      for (let i = 0; i < 15; i++) {
        planner.recordError(`Error ${i}`);
      }

      const state = planner.getState();
      expect(state.errorHistory.length).toBeLessThanOrEqual(10);
    });
  });

  describe("State Injection", () => {
    it("should return empty string when no intervention needed", () => {
      planner.trackToolCall("file_read", false);

      const injection = planner.getStateInjection();
      expect(injection).toBe("");
    });

    it("should warn about verification when threshold exceeded", () => {
      planner.trackToolCall("file_write", false);
      planner.trackToolCall("file_write", false);
      planner.trackToolCall("file_write", false);

      const injection = planner.getStateInjection();
      expect(injection).toContain("[VERIFY]");
      expect(injection).toContain("Run dotnet_build");
    });

    it("should warn about stall when consecutive errors exceed threshold", () => {
      planner.recordError("Error 1");
      planner.recordError("Error 2");
      planner.trackToolCall("file_write", true);
      planner.trackToolCall("file_write", true);
      planner.trackToolCall("file_write", true);

      const injection = planner.getStateInjection();
      expect(injection).toContain("[STALL]");
      expect(injection).toContain("Consider a different approach");
    });

    it("should warn about budget when iterations exceed the configured threshold", () => {
      planner = new TaskPlanner({ iterationBudget: 10 });

      for (let i = 0; i < 8; i++) {
        planner.trackToolCall("file_read", false);
      }

      const injection = planner.getStateInjection();
      expect(injection).toContain("[BUDGET]");
      expect(injection).toContain("8/10");
      expect(injection).toContain("current execution window");
    });

    it("should include multiple warnings when applicable", () => {
      planner.recordError("Error 1");
      planner.recordError("Error 2");

      planner.trackToolCall("file_write", true);
      planner.trackToolCall("file_write", true);
      planner.trackToolCall("file_write", true);

      const injection = planner.getStateInjection();
      expect(injection).toContain("[VERIFY]");
      expect(injection).toContain("[STALL]");
    });
  });

  describe("Trajectory Tracking", () => {
    it("should record steps during task", () => {
      planner.startTask({
        sessionId: "test",
        taskDescription: "Test",
      });

      planner.trackToolCall("file_read", false, { path: "test.cs" }, "content");
      planner.trackToolCall("file_write", true, { path: "test.cs" }, "error");

      const steps = planner.getTrajectorySteps();
      expect(steps).toHaveLength(2);
      expect(steps[0]?.toolName).toBe("file_read");
      expect(steps[1]?.toolName).toBe("file_write");
    });

    it("should not record steps when no task active", () => {
      planner.trackToolCall("file_read", false, { path: "test.cs" }, "content");

      const steps = planner.getTrajectorySteps();
      expect(steps).toHaveLength(0);
    });
  });

  describe("Correction Recording", () => {
    it("should record corrections", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "planner-test-"));
      const dbPath = join(tempDir, "test.db");
      const storage = new LearningStorage(dbPath);
      storage.initialize();
      const pipeline = new LearningPipeline(storage);

      planner.startTask({
        sessionId: "test-session",
        taskDescription: "Test task",
        learningPipeline: pipeline,
      });

      await planner.recordCorrection({
        toolName: "file_edit",
        originalInput: { path: "test.cs" },
        originalOutput: "Wrong code",
        correctedOutput: "Fixed code",
        correction: "Add missing semicolon",
      });

      expect(pipeline.getStats().observationCount).toBe(1);
      expect(planner.getTrajectorySteps()).toHaveLength(1);

      storage.close();
      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("Learning Integration", () => {
    it("should enable learning", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "planner-test-"));
      const dbPath = join(tempDir, "test.db");
      const storage = new LearningStorage(dbPath);
      storage.initialize();
      const pipeline = new LearningPipeline(storage);

      planner.enableLearning(pipeline);

      planner.startTask({
        sessionId: "test",
        taskDescription: "Test",
      });

      planner.trackToolCall("file_read", false, {}, "output");

      // After decoupling: trackToolCall no longer calls pipeline.observeToolUse
      // Events replace direct coupling, so observation count stays 0
      expect(pipeline.getStats().observationCount).toBe(0);

      storage.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("should disable learning", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "planner-test-"));
      const dbPath = join(tempDir, "test.db");
      const storage = new LearningStorage(dbPath);
      storage.initialize();
      const pipeline = new LearningPipeline(storage);

      planner.enableLearning(pipeline);
      planner.disableLearning();

      planner.startTask({
        sessionId: "test",
        taskDescription: "Test",
      });

      planner.trackToolCall("file_read", false, {}, "output");

      expect(pipeline.getStats().observationCount).toBe(0);

      storage.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("should no longer call pipeline.observeToolUse from trackToolCall", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "planner-test-"));
      const dbPath = join(tempDir, "test.db");
      const storage = new LearningStorage(dbPath);
      storage.initialize();
      const pipeline = new LearningPipeline(storage);
      const observeSpy = vi.spyOn(pipeline, "observeToolUse");

      planner.enableLearning(pipeline);
      planner.startTask({
        sessionId: "test-decouple",
        taskDescription: "Decoupling test",
        learningPipeline: pipeline,
      });

      planner.trackToolCall("file_read", false, { path: "test.cs" }, "content");

      // observeToolUse should NOT be called -- events replace it
      expect(observeSpy).not.toHaveBeenCalled();

      storage.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("should still record trajectory steps (step tracking not removed)", () => {
      planner.startTask({
        sessionId: "test-steps",
        taskDescription: "Step tracking test",
      });

      planner.trackToolCall("file_read", false, { path: "test.cs" }, "content");
      planner.trackToolCall("file_write", true, { path: "test.cs" }, "error");

      const steps = planner.getTrajectorySteps();
      expect(steps).toHaveLength(2);
      expect(steps[0]?.toolName).toBe("file_read");
      expect(steps[1]?.toolName).toBe("file_write");
    });
  });
});
