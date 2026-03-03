import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LearningStorage } from "./learning-storage.ts";
import type { Instinct, Trajectory, Observation, ErrorPattern } from "../types.ts";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("LearningStorage", () => {
  let storage: LearningStorage;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "learning-test-"));
    dbPath = join(tempDir, "test.db");
    storage = new LearningStorage(dbPath);
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Instinct Operations", () => {
    const createTestInstinct = (): Instinct => ({
      id: randomUUID(),
      name: "Test Instinct",
      type: "error_fix",
      status: "proposed",
      confidence: 0.5,
      triggerPattern: "CS0246",
      action: "Add using directive",
      contextConditions: [{ type: "error_code", value: "CS0246", match: "include" }],
      stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    it("should create and retrieve an instinct", () => {
      const instinct = createTestInstinct();
      storage.createInstinct(instinct);

      const retrieved = storage.getInstinct(instinct.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.name).toBe(instinct.name);
      expect(retrieved?.type).toBe(instinct.type);
    });

    it("should return null for non-existent instinct", () => {
      const retrieved = storage.getInstinct("non-existent-id");
      expect(retrieved).toBeNull();
    });

    it("should update an existing instinct", () => {
      const instinct = createTestInstinct();
      storage.createInstinct(instinct);

      instinct.confidence = 0.9;
      instinct.status = "active";
      storage.updateInstinct(instinct);

      const retrieved = storage.getInstinct(instinct.id);
      expect(retrieved?.confidence).toBe(0.9);
      expect(retrieved?.status).toBe("active");
    });

    it("should filter instincts by status", () => {
      const active = { ...createTestInstinct(), id: randomUUID(), status: "active" as const, confidence: 0.8 };
      const proposed = { ...createTestInstinct(), id: randomUUID(), status: "proposed" as const, confidence: 0.4 };

      storage.createInstinct(active);
      storage.createInstinct(proposed);

      const activeInstincts = storage.getInstincts({ status: "active" });
      expect(activeInstincts).toHaveLength(1);
      expect(activeInstincts[0]?.id).toBe(active.id);
    });

    it("should filter instincts by minimum confidence", () => {
      const high = { ...createTestInstinct(), id: randomUUID(), confidence: 0.9 };
      const low = { ...createTestInstinct(), id: randomUUID(), confidence: 0.3 };

      storage.createInstinct(high);
      storage.createInstinct(low);

      const highConfidence = storage.getInstincts({ minConfidence: 0.7 });
      expect(highConfidence).toHaveLength(1);
      expect(highConfidence[0]?.id).toBe(high.id);
    });

    it("should delete an instinct", () => {
      const instinct = createTestInstinct();
      storage.createInstinct(instinct);

      storage.deleteInstinct(instinct.id);
      const retrieved = storage.getInstinct(instinct.id);
      expect(retrieved).toBeNull();
    });
  });

  describe("Trajectory Operations", () => {
    const createTestTrajectory = (): Trajectory => ({
      id: randomUUID(),
      sessionId: "session-1",
      taskDescription: "Test task",
      steps: [
        {
          stepNumber: 1,
          toolName: "dotnet_build",
          input: {},
          output: "Error",
          isError: true,
          timestamp: Date.now(),
        },
      ],
      outcome: {
        success: true,
        totalSteps: 1,
        hadErrors: true,
        errorCount: 1,
        durationMs: 1000,
      },
      appliedInstinctIds: [],
      createdAt: Date.now(),
      processed: false,
    });

    it("should create and retrieve a trajectory", () => {
      const trajectory = createTestTrajectory();
      storage.createTrajectory(trajectory);
      storage.flush(); // Flush batch before reading

      const retrieved = storage.getTrajectory(trajectory.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.taskDescription).toBe(trajectory.taskDescription);
      expect(retrieved?.steps).toHaveLength(1);
    });

    it("should get unprocessed trajectories", () => {
      const unprocessed = createTestTrajectory();
      const processed = { ...createTestTrajectory(), id: randomUUID(), processed: true };

      storage.createTrajectory(unprocessed);
      storage.createTrajectory(processed);
      storage.flush(); // Flush batch before reading

      const unprocessedTrajectories = storage.getUnprocessedTrajectories(10);
      expect(unprocessedTrajectories).toHaveLength(1);
      expect(unprocessedTrajectories[0]?.id).toBe(unprocessed.id);
    });

    it("should mark trajectories as processed", () => {
      const trajectory = createTestTrajectory();
      storage.createTrajectory(trajectory);

      storage.markTrajectoriesProcessed([trajectory.id]);

      const unprocessed = storage.getUnprocessedTrajectories(10);
      expect(unprocessed).toHaveLength(0);
    });
  });

  describe("Observation Operations", () => {
    const createTestObservation = (): Observation => ({
      id: randomUUID(),
      type: "tool_use",
      sessionId: "session-1",
      toolName: "dotnet_build",
      input: {},
      output: "Success",
      success: true,
      timestamp: Date.now(),
      processed: false,
    });

    it("should record and retrieve observations", () => {
      const observation = createTestObservation();
      storage.recordObservation(observation);
      storage.flush(); // Flush batch before reading

      const unprocessed = storage.getUnprocessedObservations(10);
      expect(unprocessed).toHaveLength(1);
      expect(unprocessed[0]?.id).toBe(observation.id);
    });

    it("should mark observations as processed", () => {
      const observation = createTestObservation();
      storage.recordObservation(observation);

      storage.markObservationsProcessed([observation.id]);

      const unprocessed = storage.getUnprocessedObservations(10);
      expect(unprocessed).toHaveLength(0);
    });
  });

  describe("Error Pattern Operations", () => {
    const createTestErrorPattern = (): ErrorPattern => ({
      id: randomUUID(),
      name: "Test Pattern",
      category: "missing_type",
      codePattern: "CS0246",
      messagePattern: "The type or namespace name could not be found",
      filePatterns: [".cs"],
      occurrenceCount: 1,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });

    it("should create error patterns", () => {
      const pattern = createTestErrorPattern();
      storage.upsertErrorPattern(pattern);

      const patterns = storage.getErrorPatterns();
      expect(patterns.length).toBeGreaterThan(0);
    });

    it("should increment occurrence count for existing patterns", () => {
      const pattern = createTestErrorPattern();
      storage.upsertErrorPattern(pattern);
      storage.upsertErrorPattern(pattern); // Same pattern again

      const patterns = storage.getErrorPatterns();
      const found = patterns.find(p => p.messagePattern === pattern.messagePattern);
      expect(found?.occurrenceCount).toBeGreaterThan(1);
    });

    it("should filter patterns by category", () => {
      const missingType = createTestErrorPattern();
      const syntaxError = { ...createTestErrorPattern(), id: randomUUID(), category: "syntax" };

      storage.upsertErrorPattern(missingType);
      storage.upsertErrorPattern(syntaxError);

      const missingTypePatterns = storage.getErrorPatterns("missing_type");
      expect(missingTypePatterns.every(p => p.category === "missing_type")).toBe(true);
    });
  });

  describe("Statistics", () => {
    it("should return accurate statistics", () => {
      const stats = storage.getStats();

      expect(typeof stats.instinctCount).toBe("number");
      expect(typeof stats.trajectoryCount).toBe("number");
      expect(typeof stats.observationCount).toBe("number");
      expect(typeof stats.errorPatternCount).toBe("number");
    });

    it("should update stats after creating data", () => {
      const initialStats = storage.getStats();

      const instinct: Instinct = {
        id: randomUUID(),
        name: "Test",
        type: "error_fix",
        status: "proposed",
        confidence: 0.5,
        triggerPattern: "test",
        action: "fix",
        contextConditions: [],
        stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      storage.createInstinct(instinct);

      const updatedStats = storage.getStats();
      expect(updatedStats.instinctCount).toBe(initialStats.instinctCount + 1);
    });
  });
});
