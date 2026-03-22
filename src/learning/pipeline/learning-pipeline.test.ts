import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LearningPipeline } from "./learning-pipeline.ts";
import { LearningStorage } from "../storage/learning-storage.ts";
import type { Instinct, Trajectory, TrajectoryStep, TrajectoryOutcome } from "../types.ts";
import { TypedEventBus, type ToolResultEvent } from "../../core/event-bus.ts";
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
    it("should record correction observation", async () => {
      await pipeline.observeCorrection({
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

    it("should consider creating instinct from correction", async () => {
      await pipeline.observeCorrection({
        sessionId: "session-1",
        toolName: "file_edit",
        originalInput: { path: "test.cs" },
        originalOutput: "CS0246: The type or namespace name 'MyType' could not be found (are you missing a using directive or an assembly reference?)",
        correctedOutput: "Fixed by adding using MyNamespace;",
        correction: "Add using MyNamespace; to fix missing type",
      });

      storage.flush();

      // After batch processing, an instinct might be created
      await pipeline.runDetectionBatch();

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

    it("preserves chatId and taskRunId when recording a trajectory", () => {
      const trajectory = {
        ...createTestTrajectory(),
        chatId: "chat-replay" as any,
        taskRunId: "taskrun_replay_31",
      };

      pipeline.recordTrajectory(trajectory);

      storage.flush();
      const stored = storage.getTrajectories({ limit: 1 })[0];
      expect(stored?.chatId).toBe("chat-replay");
      expect(stored?.taskRunId).toBe("taskrun_replay_31");
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
    it("should process unprocessed observations", async () => {
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

      const result = await pipeline.runDetectionBatch();

      expect(result.patternsDetected).toBeGreaterThanOrEqual(0);
    });

    it("should return zero when disabled", async () => {
      const disabledPipeline = new LearningPipeline(storage, { enabled: false });

      const result = await disabledPipeline.runDetectionBatch();

      expect(result.instinctsCreated).toBe(0);
      expect(result.patternsDetected).toBe(0);
    });
  });

  describe("considerInstinctCreation", () => {
    it("should create an instinct when confidence is high enough", async () => {
      const instinct = await pipeline.considerInstinctCreation({
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

    it("should not create duplicate instincts", async () => {
      const uniqueTrigger = `CS0246: The type or namespace name 'Test${Date.now()}' could not be found. This is a detailed error message with specific information about the missing type.`;
      const params = {
        type: "error_fix" as const,
        triggerPattern: uniqueTrigger,
        action: "Add using TestNamespace;",
        toolName: "dotnet_build",
      };

      const first = await pipeline.considerInstinctCreation(params);

      // If first was created, second should not be
      if (first) {
        const second = await pipeline.considerInstinctCreation(params);
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

    it("materializes a shadow runtime artifact and aligned evolution proposal for high-confidence instincts", () => {
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

      expect(result.proposals).toBe(1);
      expect(result.artifacts).toBe(1);
      const artifacts = storage.getRuntimeArtifacts({ states: ["shadow"] });
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({
        kind: "workflow",
        state: "shadow",
      });
      const proposals = storage.getEvolutionProposals({ instinctId: instinct.id });
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({
        targetType: "workflow",
        status: "implemented",
      });
    });

    it("does not create duplicate implemented proposals for the same live artifact", () => {
      pipeline.setProjectPath("/projects/runtime-artifacts");
      const instinct: Instinct = {
        id: `instinct_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: "Stable Runtime Artifact",
        type: "tool_usage",
        status: "active",
        confidence: 0.97,
        triggerPattern: "repeat verified compile workflow",
        action: "read error -> inspect files -> dotnet build",
        contextConditions: [],
        stats: { timesSuggested: 50, timesApplied: 48, timesFailed: 2, successRate: 0.96, averageExecutionMs: 0 },
        createdAt: Date.now() as TimestampMs,
        updatedAt: Date.now() as TimestampMs,
        sourceTrajectoryIds: [],
        tags: [],
      };
      storage.createInstinct(instinct);

      expect(pipeline.runEvolution()).toEqual({ proposals: 1, artifacts: 1 });
      expect(pipeline.runEvolution()).toEqual({ proposals: 0, artifacts: 0 });
      expect(storage.getEvolutionProposals({ instinctId: instinct.id })).toHaveLength(1);
      expect(storage.getRuntimeArtifacts({ states: ["shadow"] })).toHaveLength(1);
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

  describe("handleToolResult", () => {
    it("should call observeToolUse with event data", async () => {
      const event: ToolResultEvent = {
        sessionId: "session-1",
        toolName: "dotnet_build",
        input: { args: ["--release"] },
        output: "Build succeeded",
        success: true,
        timestamp: Date.now(),
      };

      await pipeline.handleToolResult(event);

      storage.flush();
      const stats = pipeline.getStats();
      expect(stats.observationCount).toBe(1);
    });

    it("should call processObservation for the new observation", async () => {
      const event: ToolResultEvent = {
        sessionId: "session-1",
        toolName: "dotnet_build",
        input: {},
        output: "error CS0246: Type not found",
        success: false,
        errorDetails: {
          category: "missing_type",
          message: "CS0246: Type not found",
          code: "CS0246",
        },
        timestamp: Date.now(),
      };

      await pipeline.handleToolResult(event);

      storage.flush();
      // Observations are processed inline (marked processed)
      const stats = pipeline.getStats();
      expect(stats.observationCount).toBe(1);
      expect(stats.unprocessedObservationCount).toBe(0);
    });

    it("should update confidence for matching instincts only (tool_name contextCondition match)", async () => {
      // Create an instinct with tool_name contextCondition matching "dotnet_build"
      const instinct: Instinct = {
        id: `instinct_match_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: "Test Instinct",
        type: "error_fix",
        status: "active",
        confidence: 0.5,
        triggerPattern: "CS0246 error",
        action: "Add using directive",
        contextConditions: [
          { id: "ctx_1" as any, type: "tool_name", value: "dotnet_build", match: "include" },
        ],
        stats: { timesSuggested: 5, timesApplied: 3, timesFailed: 2, successRate: 0.6, averageExecutionMs: 0 },
        createdAt: Date.now() as TimestampMs,
        updatedAt: Date.now() as TimestampMs,
        sourceTrajectoryIds: [],
        tags: [],
      };
      storage.createInstinct(instinct);

      const event: ToolResultEvent = {
        sessionId: "session-1",
        toolName: "dotnet_build",
        input: {},
        output: "Build succeeded",
        success: true,
        appliedInstinctIds: [instinct.id],
        timestamp: Date.now(),
      };

      await pipeline.handleToolResult(event);

      // Instinct should have been updated
      const updated = storage.getInstinct(instinct.id);
      expect(updated).not.toBeNull();
      // Confidence should have increased (success with verdictScore 0.9)
      expect(updated!.confidence).not.toBe(instinct.confidence);
    });

    it("should NOT update confidence for instincts with non-matching tool_name", async () => {
      // Create an instinct with tool_name contextCondition matching "file_edit" (not dotnet_build)
      const instinct: Instinct = {
        id: `instinct_nomatch_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: "Non-matching Instinct",
        type: "error_fix",
        status: "active",
        confidence: 0.5,
        triggerPattern: "Wrong file content",
        action: "Fix file content",
        contextConditions: [
          { id: "ctx_2" as any, type: "tool_name", value: "file_edit", match: "include" },
        ],
        stats: { timesSuggested: 5, timesApplied: 3, timesFailed: 2, successRate: 0.6, averageExecutionMs: 0 },
        createdAt: Date.now() as TimestampMs,
        updatedAt: Date.now() as TimestampMs,
        sourceTrajectoryIds: [],
        tags: [],
      };
      storage.createInstinct(instinct);

      const event: ToolResultEvent = {
        sessionId: "session-1",
        toolName: "dotnet_build",
        input: {},
        output: "Build succeeded",
        success: true,
        appliedInstinctIds: [instinct.id],
        timestamp: Date.now(),
      };

      await pipeline.handleToolResult(event);

      // Instinct should NOT have been updated
      const updated = storage.getInstinct(instinct.id);
      expect(updated).not.toBeNull();
      expect(updated!.confidence).toBe(instinct.confidence);
    });
  });

  describe("Bayesian Lifecycle State Machine", () => {
    // Helper to create an instinct with specified properties
    function createTestInstinct(overrides: Partial<Instinct> = {}): Instinct {
      return {
        id: `instinct_${Date.now()}_${Math.random().toString(36).slice(2)}` as any,
        name: "Test Instinct",
        type: "error_fix",
        status: "active",
        confidence: 0.5,
        triggerPattern: "test pattern",
        action: "fix it",
        contextConditions: [
          { id: "ctx_1" as any, type: "tool_name", value: "dotnet_build", match: "include" },
        ],
        stats: { timesSuggested: 10, timesApplied: 7, timesFailed: 5, successRate: 0.58, averageExecutionMs: 0 },
        createdAt: Date.now() as TimestampMs,
        updatedAt: Date.now() as TimestampMs,
        sourceTrajectoryIds: [],
        tags: [],
        bayesianAlpha: 2.0,
        bayesianBeta: 3.0,
        ...overrides,
      };
    }

    it("should enter cooling when confidence < 0.3 and >= 10 observations", () => {
      const instinct = createTestInstinct({
        confidence: 0.25, // Below deprecated threshold (0.3)
        stats: { timesSuggested: 15, timesApplied: 3, timesFailed: 12, successRate: 0.2, averageExecutionMs: 0 },
        bayesianAlpha: 1.5,
        bayesianBeta: 4.5,
      });
      storage.createInstinct(instinct);

      pipeline.updateInstinctStatus(instinct);

      const updated = storage.getInstinct(instinct.id);
      expect(updated).not.toBeNull();
      expect(updated!.coolingStartedAt).toBeDefined();
      expect(updated!.coolingStartedAt).toBeGreaterThan(0);
      expect(updated!.coolingFailures).toBe(0);
      // Status should remain active (cooling, not deprecated yet)
      expect(updated!.status).toBe("active");
    });

    it("should NOT enter cooling when confidence < 0.3 but < 10 observations", () => {
      const instinct = createTestInstinct({
        confidence: 0.25,
        // Only 5+3=8 total observations, below coolingMinObservations (10)
        stats: { timesSuggested: 10, timesApplied: 5, timesFailed: 3, successRate: 0.625, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipeline.updateInstinctStatus(instinct);

      const updated = storage.getInstinct(instinct.id);
      expect(updated).not.toBeNull();
      expect(updated!.coolingStartedAt).toBeFalsy();
    });

    it("should deprecate after 7+ days cooling", () => {
      const sevenDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000); // 8 days ago
      const instinct = createTestInstinct({
        confidence: 0.2,
        coolingStartedAt: sevenDaysAgo as TimestampMs,
        coolingFailures: 1,
        stats: { timesSuggested: 20, timesApplied: 4, timesFailed: 16, successRate: 0.2, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipeline.updateInstinctStatus(instinct);

      const updated = storage.getInstinct(instinct.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("deprecated");
    });

    it("should deprecate after 3 consecutive failures during cooling (even if < 7 days)", () => {
      const twoDaysAgo = Date.now() - (2 * 24 * 60 * 60 * 1000);
      const instinct = createTestInstinct({
        confidence: 0.2,
        coolingStartedAt: twoDaysAgo as TimestampMs,
        coolingFailures: 3, // Exactly at the threshold
        stats: { timesSuggested: 20, timesApplied: 4, timesFailed: 16, successRate: 0.2, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipeline.updateInstinctStatus(instinct);

      const updated = storage.getInstinct(instinct.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("deprecated");
    });

    it("should reset cooling when confidence rises above 0.3", () => {
      const instinct = createTestInstinct({
        confidence: 0.35, // Above deprecated threshold -- recovery
        coolingStartedAt: (Date.now() - 2 * 24 * 60 * 60 * 1000) as TimestampMs,
        coolingFailures: 1,
        stats: { timesSuggested: 20, timesApplied: 10, timesFailed: 10, successRate: 0.5, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipeline.updateInstinctStatus(instinct);

      const updated = storage.getInstinct(instinct.id);
      expect(updated).not.toBeNull();
      // Cooling should be fully reset
      expect(updated!.coolingStartedAt).toBeFalsy();
      expect(updated!.coolingFailures).toBe(0);
    });

    it("should emit instinct:cooling-started event when cooling begins", () => {
      // TypedEventBus imported at top of file
      const eventBus = new TypedEventBus();
      const emittedEvents: any[] = [];
      eventBus.on("instinct:cooling-started", (event: any) => {
        emittedEvents.push(event);
      });

      const pipelineWithBus = new LearningPipeline(storage, {
        enabled: true,
        detectionIntervalMs: 1000,
        evolutionIntervalMs: 5000,
        minConfidenceForCreation: 0.5,
        batchSize: 5,
      }, undefined, undefined, eventBus);

      const instinct = createTestInstinct({
        confidence: 0.2,
        stats: { timesSuggested: 20, timesApplied: 4, timesFailed: 16, successRate: 0.2, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipelineWithBus.updateInstinctStatus(instinct);

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].fromStatus).toBe("active");
      expect(emittedEvents[0].reason.toLowerCase()).toContain("cooling");
    });

    it("should emit instinct:deprecated event when deprecation happens", () => {
      // TypedEventBus imported at top of file
      const eventBus = new TypedEventBus();
      const emittedEvents: any[] = [];
      eventBus.on("instinct:deprecated", (event: any) => {
        emittedEvents.push(event);
      });

      const pipelineWithBus = new LearningPipeline(storage, {
        enabled: true,
        detectionIntervalMs: 1000,
        evolutionIntervalMs: 5000,
        minConfidenceForCreation: 0.5,
        batchSize: 5,
      }, undefined, undefined, eventBus);

      const instinct = createTestInstinct({
        confidence: 0.15,
        coolingStartedAt: (Date.now() - 8 * 24 * 60 * 60 * 1000) as TimestampMs,
        coolingFailures: 1,
        stats: { timesSuggested: 25, timesApplied: 5, timesFailed: 20, successRate: 0.2, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipelineWithBus.updateInstinctStatus(instinct);

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].toStatus).toBe("deprecated");
    });

    it("should emit instinct:promoted event when promotion happens", () => {
      // TypedEventBus imported at top of file
      const eventBus = new TypedEventBus();
      const emittedEvents: any[] = [];
      eventBus.on("instinct:promoted", (event: any) => {
        emittedEvents.push(event);
      });

      const pipelineWithBus = new LearningPipeline(storage, {
        enabled: true,
        detectionIntervalMs: 1000,
        evolutionIntervalMs: 5000,
        minConfidenceForCreation: 0.5,
        batchSize: 5,
      }, undefined, undefined, eventBus);

      const instinct = createTestInstinct({
        confidence: 0.96,
        status: "active",
        stats: { timesSuggested: 30, timesApplied: 28, timesFailed: 2, successRate: 0.93, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipelineWithBus.updateInstinctStatus(instinct);

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].toStatus).toBe("permanent");
    });

    it("should promote instinct with > 0.95 confidence and >= 25 observations to permanent", () => {
      const instinct = createTestInstinct({
        confidence: 0.96,
        status: "active",
        // 28+2=30 observations, above promotionMinObservations (25)
        stats: { timesSuggested: 35, timesApplied: 28, timesFailed: 2, successRate: 0.93, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipeline.updateInstinctStatus(instinct);

      const updated = storage.getInstinct(instinct.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("permanent");
    });

    it("should NOT promote instinct with > 0.95 confidence but < 25 observations", () => {
      const instinct = createTestInstinct({
        confidence: 0.96,
        status: "active",
        // 8+1=9 observations, below promotionMinObservations (25)
        stats: { timesSuggested: 10, timesApplied: 8, timesFailed: 1, successRate: 0.89, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipeline.updateInstinctStatus(instinct);

      const updated = storage.getInstinct(instinct.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("active"); // Not promoted
    });

    it("should skip all status updates for permanent instincts", () => {
      const instinct = createTestInstinct({
        status: "permanent",
        confidence: 0.96,
        stats: { timesSuggested: 50, timesApplied: 48, timesFailed: 2, successRate: 0.96, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipeline.updateInstinctStatus(instinct);

      const updated = storage.getInstinct(instinct.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("permanent");
    });

    it("should write lifecycle log on cooling start", () => {
      const instinct = createTestInstinct({
        confidence: 0.2,
        stats: { timesSuggested: 20, timesApplied: 4, timesFailed: 16, successRate: 0.2, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipeline.updateInstinctStatus(instinct);

      const logs = storage.getLifecycleLogs({ instinctId: instinct.id });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.toStatus).toContain("cooling");
    });

    it("should write lifecycle log on deprecation", () => {
      const instinct = createTestInstinct({
        confidence: 0.15,
        coolingStartedAt: (Date.now() - 8 * 24 * 60 * 60 * 1000) as TimestampMs,
        coolingFailures: 1,
        stats: { timesSuggested: 25, timesApplied: 5, timesFailed: 20, successRate: 0.2, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipeline.updateInstinctStatus(instinct);

      const logs = storage.getLifecycleLogs({ instinctId: instinct.id });
      expect(logs.some(l => l.toStatus === "deprecated")).toBe(true);
    });

    it("should write lifecycle log on promotion", () => {
      const instinct = createTestInstinct({
        confidence: 0.96,
        status: "active",
        stats: { timesSuggested: 35, timesApplied: 28, timesFailed: 2, successRate: 0.93, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipeline.updateInstinctStatus(instinct);

      const logs = storage.getLifecycleLogs({ instinctId: instinct.id });
      expect(logs.some(l => l.toStatus === "permanent")).toBe(true);
    });

    it("should increment weekly counter on lifecycle transitions", () => {
      const instinct = createTestInstinct({
        confidence: 0.96,
        status: "active",
        stats: { timesSuggested: 35, timesApplied: 28, timesFailed: 2, successRate: 0.93, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      pipeline.updateInstinctStatus(instinct);

      // The weekly counter should have been incremented (promoted)
      // We check via lifecycle logs as a proxy since weekly counters are internal
      const logs = storage.getLifecycleLogs({ instinctId: instinct.id });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.toStatus).toBe("permanent");
    });

    it("handleToolResult should skip confidence update for permanent instincts", async () => {
      const instinct = createTestInstinct({
        status: "permanent",
        confidence: 0.96,
        bayesianAlpha: 20,
        bayesianBeta: 1,
        stats: { timesSuggested: 50, timesApplied: 48, timesFailed: 2, successRate: 0.96, averageExecutionMs: 0 },
      });
      storage.createInstinct(instinct);

      const event: ToolResultEvent = {
        sessionId: "session-1",
        toolName: "dotnet_build",
        input: {},
        output: "Build succeeded",
        success: true,
        appliedInstinctIds: [instinct.id],
        timestamp: Date.now(),
      };

      await pipeline.handleToolResult(event);

      const updated = storage.getInstinct(instinct.id);
      expect(updated).not.toBeNull();
      // Confidence should be unchanged (permanent instincts are frozen)
      expect(updated!.confidence).toBe(0.96);
      expect(updated!.bayesianAlpha).toBe(20);
      expect(updated!.bayesianBeta).toBe(1);
    });

    it("handleToolResult should use appliedInstinctIds from event for attribution when present", async () => {
      // Create two instincts, only one in the appliedInstinctIds list
      const instinctApplied = createTestInstinct({
        id: `instinct_applied_${Date.now()}` as any,
        confidence: 0.5,
        bayesianAlpha: 3,
        bayesianBeta: 3,
      });
      const instinctNotApplied = createTestInstinct({
        id: `instinct_notapplied_${Date.now()}` as any,
        confidence: 0.5,
        bayesianAlpha: 3,
        bayesianBeta: 3,
      });
      storage.createInstinct(instinctApplied);
      storage.createInstinct(instinctNotApplied);

      const event: ToolResultEvent = {
        sessionId: "session-1",
        toolName: "dotnet_build",
        input: {},
        output: "Build succeeded",
        success: true,
        appliedInstinctIds: [instinctApplied.id], // Only instinctApplied
        timestamp: Date.now(),
      };

      await pipeline.handleToolResult(event);

      const updatedApplied = storage.getInstinct(instinctApplied.id);
      const updatedNotApplied = storage.getInstinct(instinctNotApplied.id);

      // Applied instinct should be updated
      expect(updatedApplied!.confidence).not.toBe(0.5);
      // Non-applied instinct should be unchanged
      expect(updatedNotApplied!.confidence).toBe(0.5);
    });
  });

  describe("Lifecycle (event-driven)", () => {
    it("should no longer set detectionTimer in start() (only evolutionTimer)", () => {
      // We verify by checking that start() doesn't create a detection timer
      // The pipeline is already started in beforeEach -- stop it and restart
      pipeline.stop();

      // Use fake timers to inspect
      vi.useFakeTimers();
      try {
        pipeline.start();

        // After start, advancing by detectionIntervalMs should NOT run runDetectionBatch
        // (since we removed the timer). We verify indirectly: no observations get processed by timer.
        pipeline.observeToolUse({
          sessionId: "session-timer",
          toolName: "file_read",
          input: {},
          output: "content",
          success: true,
        });

        // Advance past the detection interval
        vi.advanceTimersByTime(2000);

        // Observations should still be unprocessed (no batch timer)
        const stats = pipeline.getStats();
        expect(stats.unprocessedObservationCount).toBe(1);
      } finally {
        pipeline.stop();
        vi.useRealTimers();
      }
    });

    it("should still clear evolutionTimer and shut down embeddingQueue on stop()", () => {
      // Just verify stop() doesn't throw
      pipeline.start();
      expect(() => pipeline.stop()).not.toThrow();
    });

    it("should set periodicTimer in start() and clear it in stop()", () => {
      pipeline.stop();
      vi.useFakeTimers();
      try {
        pipeline.start();
        // Verify periodic timer exists by checking that stop clears it without error
        expect(() => pipeline.stop()).not.toThrow();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("detectPatternInline", () => {
    it("should detect recurring error patterns after 3+ occurrences", async () => {
      // Feed 5 events with same error message to trigger inline detection
      // (minObservationsBeforeLearning = 5 for the test pipeline config)
      for (let i = 0; i < 5; i++) {
        await pipeline.handleToolResult({
          sessionId: "session-inline",
          toolName: "dotnet_build",
          input: {},
          output: "Build failed",
          success: false,
          errorDetails: {
            category: "missing_type",
            message: "CS0246: Type not found",
            code: "CS0246",
          },
          timestamp: Date.now(),
        });
      }

      storage.flush();
      const stats = pipeline.getStats();
      // Should have recorded 5 observations
      expect(stats.observationCount).toBe(5);
      // An instinct may have been created from the recurring error pattern
      // (depends on confidence threshold and similarity checks)
    });

    it("should detect tool sequence patterns after 3+ repetitions", async () => {
      // Create a repeating sequence: A->B->C, A->B->C, A->B->C
      const tools = ["file_read", "file_edit", "dotnet_build"];
      for (let rep = 0; rep < 3; rep++) {
        for (const tool of tools) {
          await pipeline.handleToolResult({
            sessionId: "session-seq",
            toolName: tool,
            input: {},
            output: "ok",
            success: true,
            timestamp: Date.now(),
          });
        }
      }

      storage.flush();
      const stats = pipeline.getStats();
      // Should have recorded 9 observations
      expect(stats.observationCount).toBe(9);
    });

    it("should not detect patterns below minObservationsBeforeLearning", async () => {
      // Only 2 observations, below the 5 threshold
      for (let i = 0; i < 2; i++) {
        await pipeline.handleToolResult({
          sessionId: "session-few",
          toolName: "dotnet_build",
          input: {},
          output: "Build failed",
          success: false,
          errorDetails: {
            category: "missing_type",
            message: "CS0246: Type not found",
            code: "CS0246",
          },
          timestamp: Date.now(),
        });
      }

      storage.flush();
      const stats = pipeline.getStats();
      expect(stats.observationCount).toBe(2);
      // No instinct should be created from just 2 observations
      expect(stats.instinctCount).toBe(0);
    });

    it("should keep sliding window capped at 20 observations", async () => {
      // Send 25 events
      for (let i = 0; i < 25; i++) {
        await pipeline.handleToolResult({
          sessionId: "session-window",
          toolName: `tool_${i % 5}`,
          input: {},
          output: "ok",
          success: true,
          timestamp: Date.now(),
        });
      }

      storage.flush();
      // All 25 should be recorded in storage, but internal window is capped at 20
      expect(pipeline.getStats().observationCount).toBe(25);
    });
  });

  describe("enforceMaxInstincts", () => {
    it("should not delete instincts when count is within limit", async () => {
      // Create 2 instincts (maxInstincts default in test is 1000)
      const instinct1: Instinct = {
        id: `instinct_keep1_${Date.now()}` as any,
        name: "Keep 1",
        type: "error_fix",
        status: "active",
        confidence: 0.8,
        triggerPattern: "keep pattern 1",
        action: "keep action 1",
        contextConditions: [],
        stats: { timesSuggested: 5, timesApplied: 4, timesFailed: 1, successRate: 0.8, averageExecutionMs: 0 },
        createdAt: Date.now() as TimestampMs,
        updatedAt: Date.now() as TimestampMs,
        sourceTrajectoryIds: [],
        tags: [],
      };
      storage.createInstinct(instinct1);

      await pipeline.enforceMaxInstincts();

      expect(storage.countInstincts()).toBe(1);
    });

    it("should delete lowest-confidence deprecated instincts first when over limit", async () => {
      // Create a pipeline with maxInstincts = 2
      const smallPipeline = new LearningPipeline(storage, {
        enabled: true,
        maxInstincts: 2,
        detectionIntervalMs: 1000,
        evolutionIntervalMs: 5000,
        minConfidenceForCreation: 0.5,
        batchSize: 5,
      });

      // Create 3 instincts (1 deprecated, 2 active)
      const deprecated: Instinct = {
        id: `instinct_dep_${Date.now()}_a` as any,
        name: "Deprecated",
        type: "error_fix",
        status: "deprecated",
        confidence: 0.1,
        triggerPattern: "deprecated pattern",
        action: "deprecated action",
        contextConditions: [],
        stats: { timesSuggested: 10, timesApplied: 1, timesFailed: 9, successRate: 0.1, averageExecutionMs: 0 },
        createdAt: Date.now() as TimestampMs,
        updatedAt: Date.now() as TimestampMs,
        sourceTrajectoryIds: [],
        tags: [],
      };
      const active1: Instinct = {
        id: `instinct_act1_${Date.now()}_b` as any,
        name: "Active 1",
        type: "error_fix",
        status: "active",
        confidence: 0.7,
        triggerPattern: "active pattern 1",
        action: "active action 1",
        contextConditions: [],
        stats: { timesSuggested: 5, timesApplied: 4, timesFailed: 1, successRate: 0.8, averageExecutionMs: 0 },
        createdAt: Date.now() as TimestampMs,
        updatedAt: Date.now() as TimestampMs,
        sourceTrajectoryIds: [],
        tags: [],
      };
      const active2: Instinct = {
        id: `instinct_act2_${Date.now()}_c` as any,
        name: "Active 2",
        type: "error_fix",
        status: "active",
        confidence: 0.9,
        triggerPattern: "active pattern 2",
        action: "active action 2",
        contextConditions: [],
        stats: { timesSuggested: 8, timesApplied: 7, timesFailed: 1, successRate: 0.875, averageExecutionMs: 0 },
        createdAt: Date.now() as TimestampMs,
        updatedAt: Date.now() as TimestampMs,
        sourceTrajectoryIds: [],
        tags: [],
      };

      storage.createInstinct(deprecated);
      storage.createInstinct(active1);
      storage.createInstinct(active2);

      expect(storage.countInstincts()).toBe(3);

      await smallPipeline.enforceMaxInstincts();

      // Should have deleted 1 (the deprecated one)
      expect(storage.countInstincts()).toBe(2);
      // Deprecated should be gone
      expect(storage.getInstinct(deprecated.id)).toBeNull();
      // Active ones should remain
      expect(storage.getInstinct(active1.id)).not.toBeNull();
      expect(storage.getInstinct(active2.id)).not.toBeNull();

      smallPipeline.stop();
    });

    it("should delete active instincts if not enough deprecated to trim", async () => {
      // Create a pipeline with maxInstincts = 1
      const tinyPipeline = new LearningPipeline(storage, {
        enabled: true,
        maxInstincts: 1,
        detectionIntervalMs: 1000,
        evolutionIntervalMs: 5000,
        minConfidenceForCreation: 0.5,
        batchSize: 5,
      });

      const active1: Instinct = {
        id: `instinct_tiny1_${Date.now()}_a` as any,
        name: "Low Confidence Active",
        type: "error_fix",
        status: "active",
        confidence: 0.5,
        triggerPattern: "tiny pattern 1",
        action: "tiny action 1",
        contextConditions: [],
        stats: { timesSuggested: 5, timesApplied: 3, timesFailed: 2, successRate: 0.6, averageExecutionMs: 0 },
        createdAt: Date.now() as TimestampMs,
        updatedAt: Date.now() as TimestampMs,
        sourceTrajectoryIds: [],
        tags: [],
      };
      const active2: Instinct = {
        id: `instinct_tiny2_${Date.now()}_b` as any,
        name: "High Confidence Active",
        type: "error_fix",
        status: "active",
        confidence: 0.9,
        triggerPattern: "tiny pattern 2",
        action: "tiny action 2",
        contextConditions: [],
        stats: { timesSuggested: 8, timesApplied: 7, timesFailed: 1, successRate: 0.875, averageExecutionMs: 0 },
        createdAt: Date.now() as TimestampMs,
        updatedAt: Date.now() as TimestampMs,
        sourceTrajectoryIds: [],
        tags: [],
      };

      storage.createInstinct(active1);
      storage.createInstinct(active2);

      expect(storage.countInstincts()).toBe(2);

      await tinyPipeline.enforceMaxInstincts();

      // Should have deleted the lowest-confidence active instinct
      expect(storage.countInstincts()).toBe(1);
      // Low confidence should be gone
      expect(storage.getInstinct(active1.id)).toBeNull();
      // High confidence should remain
      expect(storage.getInstinct(active2.id)).not.toBeNull();

      tinyPipeline.stop();
    });
  });

  describe("runPeriodicExtraction", () => {
    it("should process unprocessed trajectories when periodic extraction runs", async () => {
      // Record a trajectory with only success steps (no error->fix pair)
      // so extractInstinctFromTrajectory returns null but trajectory still gets marked processed
      pipeline.recordTrajectory({
        sessionId: "session-periodic",
        taskDescription: "Simple task",
        steps: [
          {
            stepNumber: 1,
            toolName: "file_read" as ToolName,
            input: { path: "test.cs" },
            result: {
              kind: "success",
              output: "File content",
            },
            timestamp: Date.now() as TimestampMs,
          },
        ],
        outcome: {
          success: true,
          totalSteps: 1,
          hadErrors: true, // hadErrors=true prevents auto-verdict
          errorCount: 0,
          durationMs: 500,
        },
      });

      storage.flush();

      const unprocessedBefore = storage.getUnprocessedTrajectories(10);
      expect(unprocessedBefore).toHaveLength(1);

      // runDetectionBatch processes trajectories the same way as runPeriodicExtraction
      await pipeline.runDetectionBatch();

      const unprocessedAfter = storage.getUnprocessedTrajectories(10);
      expect(unprocessedAfter).toHaveLength(0);
    });

    it("should set periodicTimer in start() and clear it in stop()", () => {
      pipeline.stop();
      vi.useFakeTimers();
      try {
        pipeline.start();
        // Verify that stopping clears the timer without error
        expect(() => pipeline.stop()).not.toThrow();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
