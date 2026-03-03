import { describe, it, expect } from "vitest";
import {
  CONFIDENCE_THRESHOLDS,
  DEFAULT_LEARNING_CONFIG,
  type Instinct,
  type Trajectory,
  type Observation,
  type ErrorPattern,
} from "./types.ts";

describe("Learning Types", () => {
  describe("CONFIDENCE_THRESHOLDS", () => {
    it("should have correct threshold values", () => {
      expect(CONFIDENCE_THRESHOLDS.PROPOSED).toBe(0.0);
      expect(CONFIDENCE_THRESHOLDS.ACTIVE).toBe(0.7);
      expect(CONFIDENCE_THRESHOLDS.DEPRECATED).toBe(0.3);
      expect(CONFIDENCE_THRESHOLDS.EVOLUTION).toBe(0.9);
    });

    it("should have thresholds in logical order", () => {
      expect(CONFIDENCE_THRESHOLDS.PROPOSED).toBeLessThan(CONFIDENCE_THRESHOLDS.DEPRECATED);
      expect(CONFIDENCE_THRESHOLDS.DEPRECATED).toBeLessThan(CONFIDENCE_THRESHOLDS.ACTIVE);
      expect(CONFIDENCE_THRESHOLDS.ACTIVE).toBeLessThan(CONFIDENCE_THRESHOLDS.EVOLUTION);
    });
  });

  describe("DEFAULT_LEARNING_CONFIG", () => {
    it("should have reasonable default values", () => {
      expect(DEFAULT_LEARNING_CONFIG.dbPath).toBe("./data/learning.db");
      expect(DEFAULT_LEARNING_CONFIG.batchSize).toBe(10);
      expect(DEFAULT_LEARNING_CONFIG.enabled).toBe(true);
      expect(DEFAULT_LEARNING_CONFIG.minConfidenceForCreation).toBe(0.6);
      expect(DEFAULT_LEARNING_CONFIG.maxInstincts).toBe(1000);
    });

    it("should have positive time intervals", () => {
      expect(DEFAULT_LEARNING_CONFIG.detectionIntervalMs).toBeGreaterThan(0);
      expect(DEFAULT_LEARNING_CONFIG.evolutionIntervalMs).toBeGreaterThan(0);
    });
  });

  describe("Instinct interface", () => {
    it("should allow creating a valid instinct object", () => {
      const instinct: Instinct = {
        id: "test-instinct-1",
        name: "Test Instinct",
        type: "error_fix",
        status: "proposed",
        confidence: 0.5,
        triggerPattern: "CS0246",
        action: "Add using directive",
        contextConditions: [
          { type: "error_code", value: "CS0246", match: "include" },
        ],
        stats: {
          timesSuggested: 0,
          timesApplied: 0,
          timesFailed: 0,
          successRate: 0,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(instinct.id).toBe("test-instinct-1");
      expect(instinct.type).toBe("error_fix");
      expect(instinct.status).toBe("proposed");
      expect(instinct.confidence).toBe(0.5);
    });
  });

  describe("Trajectory interface", () => {
    it("should allow creating a valid trajectory object", () => {
      const trajectory: Trajectory = {
        id: "traj-1",
        sessionId: "session-1",
        taskDescription: "Test task",
        steps: [
          {
            stepNumber: 1,
            toolName: "dotnet_build",
            input: {},
            output: "Build failed",
            isError: true,
            timestamp: new Date(),
          },
          {
            stepNumber: 2,
            toolName: "file_edit",
            input: { path: "test.cs" },
            output: "Fixed",
            isError: false,
            timestamp: new Date(),
          },
        ],
        outcome: {
          success: true,
          totalSteps: 2,
          hadErrors: true,
          errorCount: 1,
          durationMs: 1000,
        },
        appliedInstinctIds: [],
        createdAt: new Date(),
        processed: false,
      };

      expect(trajectory.steps).toHaveLength(2);
      expect(trajectory.outcome.success).toBe(true);
      expect(trajectory.processed).toBe(false);
    });
  });

  describe("Observation interface", () => {
    it("should allow creating different observation types", () => {
      const toolObservation: Observation = {
        id: "obs-1",
        type: "tool_use",
        sessionId: "session-1",
        toolName: "dotnet_build",
        input: { args: ["--release"] },
        output: "Build succeeded",
        success: true,
        timestamp: new Date(),
        processed: false,
      };

      const correctionObservation: Observation = {
        id: "obs-2",
        type: "correction",
        sessionId: "session-1",
        correction: "Use correct namespace",
        timestamp: new Date(),
        processed: false,
      };

      expect(toolObservation.type).toBe("tool_use");
      expect(correctionObservation.type).toBe("correction");
    });
  });

  describe("ErrorPattern interface", () => {
    it("should allow creating a valid error pattern", () => {
      const pattern: ErrorPattern = {
        id: "pattern-1",
        name: "Missing Type Error",
        category: "missing_type",
        codePattern: "CS0246",
        messagePattern: "The type or namespace name '%NAME%' could not be found",
        filePatterns: [".cs"],
        occurrenceCount: 5,
        firstSeen: new Date(),
        lastSeen: new Date(),
      };

      expect(pattern.category).toBe("missing_type");
      expect(pattern.occurrenceCount).toBe(5);
    });
  });
});
