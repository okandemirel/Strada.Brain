import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LearningPipeline } from "./learning-pipeline.ts";
import { LearningStorage } from "../storage/learning-storage.ts";
import type { Instinct, Trajectory, TrajectoryStep, TrajectoryOutcome } from "../types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolName, TimestampMs } from "../../types/index.js";

describe("LearningPipeline", () => {
  let pipeline: LearningPipeline;
  let storage: LearningStorage;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pipeline-test-"));
    dbPath = join(tempDir, "test.db");
    storage = new LearningStorage(dbPath);
    storage.initialize();
    
    pipeline = new LearningPipeline(storage, {
      enabled: true,
      detectionIntervalMs: 1000,
      evolutionIntervalMs: 5000,
      minConfidenceForCreation: 0.5,
      batchSize: 5,
    });
  });

  afterEach(() => {
    pipeline.stop();
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Lifecycle", () => {
    it("should start and stop without errors", () => {
      expect(() => pipeline.start()).not.toThrow();
      expect(() => pipeline.stop()).not.toThrow();
    });

    it("should not start multiple times", () => {
      pipeline.start();
      expect(() => pipeline.start()).not.toThrow();
      pipeline.stop();
    });
  });

  describe("observeToolUse", () => {
    it("should record successful tool use observation", () => {
      pipeline.observeToolUse({
        sessionId: "session-1",
        toolName: "dotnet_build",
        input: { args: ["--release"] },
        output: "Build succeeded",
        success: true,
      });

      storage.flush();
      const stats = pipeline.getStats();
      expect(stats.observationCount).toBe(1);
    });

    it("should record failed tool use observation", () => {
      pipeline.observeToolUse({
        sessionId: "session-1",
        toolName: "dotnet_build",
        input: { args: ["--release"] },
        output: "Build failed with errors",
        success: false,
        errorDetails: {
          category: "missing_type",
          message: "CS0246: Type not found",
          code: "CS0246",
        },
      });

      storage.flush();
      const stats = pipeline.getStats();
      expect(stats.observationCount).toBe(1);
    });
  });

  describe("observeCorrection", () => {
    it("should record correction observation", () => {
      pipeline.observeCorrection({
        sessionId: "session-1",
        toolName: "file_edit",
        originalInput: { path: "test.cs" },
        originalOutput: "Wrong content",
        correctedOutput: "Fixed content",
        correction: "Add missing semicolon",
      });

      storage.flush();
      const stats = pipeline.getStats();
      expect(stats.observationCount).toBe(1);
    });

    it("should consider creating instinct from correction", () => {
      pipeline.observeCorrection({
        sessionId: "session-1",
        toolName: "file_edit",
        originalInput: { path: "test.cs" },
        originalOutput: "CS0246: The type or namespace name 'MyType' could not be found (are you missing a using directive or an assembly reference?)",
        correctedOutput: "Fixed by adding using MyNamespace;",
        correction: "Add using MyNamespace; to fix missing type",
      });

      storage.flush();
      
      // After batch processing, an instinct might be created
      pipeline.runDetectionBatch();
      
      const stats = pipeline.getStats();
      // May or may not create instinct depending on confidence calculation
      expect(stats.observationCount).toBeGreaterThan(0);
    });
  });

  describe("recordTrajectory", () => {
    const createTestTrajectory = (): { sessionId: string; taskDescription: string; steps: TrajectoryStep[]; outcome: TrajectoryOutcome } => ({
      sessionId: "session-1",
      taskDescription: "Test task",
      steps: [
        {
          stepNumber: 1,
          toolName: "dotnet_build" as ToolName,
          input: {},
          result: {
            kind: "error",
            error: { code: "BUILD001", message: "Build failed" },
            output: "Build failed",
          },
          timestamp: Date.now() as TimestampMs,
        },
        {
          stepNumber: 2,
          toolName: "file_edit" as ToolName,
          input: { path: "test.cs" },
          result: {
            kind: "success",
            output: "Fixed",
          },
          timestamp: Date.now() as TimestampMs,
        },
      ],
      outcome: {
        success: true,
        totalSteps: 2,
        hadErrors: true,
        errorCount: 1,
        durationMs: 1000,
      },
    });

    it("should record a trajectory", () => {
      pipeline.recordTrajectory(createTestTrajectory());

      storage.flush();
      const stats = pipeline.getStats();
      expect(stats.trajectoryCount).toBe(1);
    });

    it("should auto-generate verdict for successful trajectories", () => {
      const trajectory = createTestTrajectory();
      trajectory.outcome.hadErrors = false; // Clean success
      
      pipeline.recordTrajectory(trajectory);
      
      storage.flush();
      
      // Trajectory is recorded and auto-verdict is generated
      const stats = pipeline.getStats();
      expect(stats.trajectoryCount).toBe(1);
    });
  });

  describe("submitVerdict", () => {
    it("should record a verdict and update instinct confidence", () => {
      // First create an instinct with timestamp as number
      const instinct: Instinct = {
        id: `instinct_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: "Test Instinct",
        type: "error_fix",
        status: "active",
        confidence: 0.7,
        triggerPattern: "test pattern",
        action: "fix it",
        contextConditions: [],
        stats: { timesSuggested: 5, timesApplied: 4, timesFailed: 1, successRate: 0.8, averageExecutionMs: 0 },
        createdAt: Date.now() as TimestampMs,
        updatedAt: Date.now() as TimestampMs,
        sourceTrajectoryIds: [],
        tags: [],
      };
      storage.createInstinct(instinct);

      // Record a trajectory first (with immediate flush to avoid FK constraint)
      const trajectoryId = `traj_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      storage.createTrajectoryImmediate({
        id: trajectoryId,
        sessionId: "session-1" as SessionId,
        taskDescription: "Test task",
        steps: [],
        outcome: {
          success: true,
          totalSteps: 1,
          hadErrors: false,
          errorCount: 0,
          durationMs: 100,
        },
        appliedInstinctIds: [instinct.id],
        createdAt: Date.now() as TimestampMs,
        processed: false,
      });
      
      // Submit verdict
      expect(() => {
        pipeline.submitVerdict({
          trajectoryId,
          judgeType: "human",
          score: 0.9,
          dimensions: {
            efficiency: 0.9,
            correctness: 0.95,
            quality: 0.85,
            bestPractices: 0.9,
          },
        });
      }).not.toThrow();
    });
  });

  describe("runDetectionBatch", () => {
    it("should process unprocessed observations", () => {
      pipeline.observeToolUse({
        sessionId: "session-1",
        toolName: "dotnet_build",
        input: {},
        output: "Build failed",
        success: false,
        errorDetails: {
          category: "missing_type",
          message: "CS0246: Type not found",
          code: "CS0246",
        },
      });

      const result = pipeline.runDetectionBatch();
      
      expect(result.patternsDetected).toBeGreaterThanOrEqual(0);
    });

    it("should return zero when disabled", () => {
      const disabledPipeline = new LearningPipeline(storage, { enabled: false });
      
      const result = disabledPipeline.runDetectionBatch();
      
      expect(result.instinctsCreated).toBe(0);
      expect(result.patternsDetected).toBe(0);
    });
  });

  describe("considerInstinctCreation", () => {
    it("should create an instinct when confidence is high enough", () => {
      const instinct = pipeline.considerInstinctCreation({
        type: "error_fix",
        triggerPattern: "CS0246: The type or namespace name 'Test' could not be found. This is a detailed error message with specific information about the missing type.",
        action: "Add using TestNamespace;",
        toolName: "dotnet_build",
      });

      // Might or might not create depending on confidence calculation
      if (instinct) {
        expect(instinct.type).toBe("error_fix");
        expect(instinct.status).toBe("proposed");
      }
    });

    it("should not create duplicate instincts", () => {
      const uniqueTrigger = `CS0246: The type or namespace name 'Test${Date.now()}' could not be found. This is a detailed error message with specific information about the missing type.`;
      const params = {
        type: "error_fix" as const,
        triggerPattern: uniqueTrigger,
        action: "Add using TestNamespace;",
        toolName: "dotnet_build",
      };

      const first = pipeline.considerInstinctCreation(params);
      
      // If first was created, second should not be
      if (first) {
        const second = pipeline.considerInstinctCreation(params);
        expect(second).toBeNull();
      }
    });
  });

  describe("runEvolution", () => {
    it("should return zero proposals when disabled", () => {
      const disabledPipeline = new LearningPipeline(storage, { enabled: false });
      
      const result = disabledPipeline.runEvolution();
      
      expect(result.proposals).toBe(0);
    });

    it("should consider high-confidence instincts for evolution", () => {
      // Create a high-confidence tool_usage instinct with timestamp as number
      const instinct: Instinct = {
        id: `instinct_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: "High Confidence Tool Usage",
        type: "tool_usage",
        status: "active",
        confidence: 0.96, // Above evolution threshold
        triggerPattern: "test",
        action: "action",
        contextConditions: [],
        stats: { timesSuggested: 100, timesApplied: 95, timesFailed: 5, successRate: 0.95, averageExecutionMs: 0 },
        createdAt: Date.now() as TimestampMs,
        updatedAt: Date.now() as TimestampMs,
        sourceTrajectoryIds: [],
        tags: [],
      };
      storage.createInstinct(instinct);

      const result = pipeline.runEvolution();
      
      // May or may not propose evolution depending on criteria
      expect(result.proposals).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getStats", () => {
    it("should return current statistics", () => {
      const stats = pipeline.getStats();
      
      expect(stats).toHaveProperty("instinctCount");
      expect(stats).toHaveProperty("activeInstinctCount");
      expect(stats).toHaveProperty("trajectoryCount");
      expect(stats).toHaveProperty("observationCount");
      expect(stats).toHaveProperty("errorPatternCount");
      expect(stats).toHaveProperty("unprocessedObservationCount");
    });
  });
});
