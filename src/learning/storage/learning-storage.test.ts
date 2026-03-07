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

  describe("Schema Migration", () => {
    it("should not error when initialize is called twice (idempotent migration)", () => {
      // Storage is already initialized in beforeEach
      // Calling initialize again should not throw (ALTER TABLE silently fails if column exists)
      expect(() => storage.initialize()).not.toThrow();
    });

    it("should have embedding column in instincts table after initialize", () => {
      const instinct: Instinct = {
        id: randomUUID(),
        name: "Embedding Test",
        type: "error_fix",
        status: "proposed",
        confidence: 0.7,
        triggerPattern: "test pattern",
        action: "test action",
        contextConditions: [],
        stats: { timesSuggested: 0, timesApplied: 0, timesFailed: 0, successRate: 0 },
        embedding: [0.1, 0.2, 0.3],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Should not throw — embedding column must exist
      storage.createInstinct(instinct);

      const retrieved = storage.getInstinct(instinct.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.embedding).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe("Bayesian schema migration", () => {
    it("should add bayesian_alpha, bayesian_beta, cooling_started_at, cooling_failures columns", () => {
      // Insert an instinct with bayesian fields
      const instinct: Instinct = {
        id: randomUUID(),
        name: "Bayesian Test",
        type: "error_fix",
        status: "proposed",
        confidence: 0.5,
        triggerPattern: "test",
        action: "fix",
        contextConditions: [],
        stats: { timesSuggested: 0, timesApplied: 5, timesFailed: 2, successRate: 0.71 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bayesianAlpha: 6.0,
        bayesianBeta: 3.0,
      };
      storage.createInstinct(instinct);

      const retrieved = storage.getInstinct(instinct.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.bayesianAlpha).toBe(6.0);
      expect(retrieved?.bayesianBeta).toBe(3.0);
    });

    it("should accept 'permanent' in CHECK constraint", () => {
      const instinct: Instinct = {
        id: randomUUID(),
        name: "Permanent Test",
        type: "error_fix",
        status: "permanent",
        confidence: 0.96,
        triggerPattern: "test",
        action: "fix",
        contextConditions: [],
        stats: { timesSuggested: 0, timesApplied: 50, timesFailed: 2, successRate: 0.96 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Should not throw — 'permanent' must be in CHECK constraint
      expect(() => storage.createInstinct(instinct)).not.toThrow();

      const retrieved = storage.getInstinct(instinct.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.status).toBe("permanent");
    });

    it("should create instinct_lifecycle_log table with correct schema", () => {
      const entry = {
        instinctId: "instinct_test_123" as import("../types.ts").InstinctId,
        fromStatus: "active" as import("../types.ts").InstinctStatus,
        toStatus: "permanent" as import("../types.ts").InstinctStatus,
        reason: "High confidence after 30 observations",
        confidenceAtTransition: 0.96,
        bayesianAlpha: 28.5,
        bayesianBeta: 2.5,
        observationCount: 30,
        timestamp: Date.now(),
      };

      // Should not throw — lifecycle_log table must exist
      storage.writeLifecycleLog(entry);

      const logs = storage.getLifecycleLogs({ instinctId: entry.instinctId });
      expect(logs).toHaveLength(1);
      expect(logs[0]?.fromStatus).toBe("active");
      expect(logs[0]?.toStatus).toBe("permanent");
      expect(logs[0]?.reason).toBe("High confidence after 30 observations");
      expect(logs[0]?.confidenceAtTransition).toBe(0.96);
      expect(logs[0]?.bayesianAlpha).toBe(28.5);
      expect(logs[0]?.bayesianBeta).toBe(2.5);
      expect(logs[0]?.observationCount).toBe(30);
    });

    it("should create instinct_weekly_counters table with correct schema", () => {
      // Increment a counter
      storage.incrementWeeklyCounter("promoted");
      storage.incrementWeeklyCounter("promoted");
      storage.incrementWeeklyCounter("deprecated");

      const counters = storage.getWeeklyCounters(1);
      expect(counters.length).toBeGreaterThan(0);

      // Find this week's promoted count
      const promoted = counters.find(c => c.eventType === "promoted");
      expect(promoted).toBeDefined();
      expect(promoted?.count).toBe(2);

      const deprecated = counters.find(c => c.eventType === "deprecated");
      expect(deprecated).toBeDefined();
      expect(deprecated?.count).toBe(1);
    });

    it("should write and read lifecycle log entries", () => {
      const entries = [
        {
          instinctId: "instinct_a" as import("../types.ts").InstinctId,
          fromStatus: "proposed" as import("../types.ts").InstinctStatus,
          toStatus: "active" as import("../types.ts").InstinctStatus,
          reason: "Reached active threshold",
          confidenceAtTransition: 0.72,
          bayesianAlpha: 8.0,
          bayesianBeta: 3.0,
          observationCount: 10,
          timestamp: Date.now() - 1000,
        },
        {
          instinctId: "instinct_a" as import("../types.ts").InstinctId,
          fromStatus: "active" as import("../types.ts").InstinctStatus,
          toStatus: "permanent" as import("../types.ts").InstinctStatus,
          reason: "Promoted after 25 observations",
          confidenceAtTransition: 0.95,
          bayesianAlpha: 24.0,
          bayesianBeta: 2.0,
          observationCount: 25,
          timestamp: Date.now(),
        },
      ];

      for (const entry of entries) {
        storage.writeLifecycleLog(entry);
      }

      const logs = storage.getLifecycleLogs({ instinctId: "instinct_a" as import("../types.ts").InstinctId });
      expect(logs).toHaveLength(2);
    });

    it("should increment and query weekly counters", () => {
      storage.incrementWeeklyCounter("cooling_started");
      storage.incrementWeeklyCounter("cooling_started");
      storage.incrementWeeklyCounter("cooling_recovered");

      const counters = storage.getWeeklyCounters(4);
      const coolingStarted = counters.find(c => c.eventType === "cooling_started");
      expect(coolingStarted?.count).toBe(2);
    });

    it("should preserve existing instincts during CHECK constraint migration", () => {
      // Create instincts with all existing statuses
      const statuses = ["proposed", "active", "deprecated", "evolved"] as const;
      const instincts: Instinct[] = statuses.map(status => ({
        id: `instinct_${status}_${randomUUID()}` as import("../types.ts").InstinctId,
        name: `${status} instinct`,
        type: "error_fix" as const,
        status,
        confidence: 0.5,
        triggerPattern: "test",
        action: "fix",
        contextConditions: [],
        stats: { timesSuggested: 0, timesApplied: 3, timesFailed: 1, successRate: 0.75 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));

      for (const instinct of instincts) {
        storage.createInstinct(instinct);
      }

      // Verify all instincts survive after re-initialization
      storage.close();
      storage = new LearningStorage(dbPath);
      storage.initialize();

      for (const instinct of instincts) {
        const retrieved = storage.getInstinct(instinct.id);
        expect(retrieved).not.toBeNull();
        expect(retrieved?.status).toBe(instinct.status);
        expect(retrieved?.name).toBe(instinct.name);
      }
    });
  });
});
