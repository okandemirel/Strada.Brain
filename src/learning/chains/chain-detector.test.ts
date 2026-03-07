/**
 * ChainDetector Tests
 *
 * Tests for contiguous tool sequence mining from trajectory data.
 * Covers detection, filtering, age limits, subsumption, and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChainDetector } from "./chain-detector.js";
import type { ToolChainConfig, CandidateChain } from "./chain-types.js";
import type { Trajectory, TrajectoryStep } from "../types.js";
import type { LearningStorage } from "../storage/learning-storage.js";

// =============================================================================
// HELPERS
// =============================================================================

function makeStep(toolName: string, stepNumber: number): TrajectoryStep {
  return {
    stepNumber,
    toolName,
    input: {},
    result: { kind: "success", output: "ok" },
    timestamp: Date.now() as never,
    durationMs: 100 as never,
  };
}

function makeTrajectory(
  id: string,
  toolNames: string[],
  success: boolean,
  createdAt?: number,
): Trajectory {
  return {
    id: `traj_${id}` as never,
    sessionId: "sess_1" as never,
    taskDescription: "test task",
    steps: toolNames.map((name, i) => makeStep(name, i + 1)),
    outcome: {
      success,
      totalSteps: toolNames.length,
      hadErrors: !success,
      errorCount: success ? 0 : 1,
      durationMs: 1000 as never,
      completionRate: (success ? 1 : 0) as never,
    },
    appliedInstinctIds: [],
    createdAt: (createdAt ?? Date.now()) as never,
    processed: true,
  };
}

function makeConfig(overrides: Partial<ToolChainConfig> = {}): ToolChainConfig {
  return {
    enabled: true,
    minOccurrences: 3,
    successRateThreshold: 0.8,
    maxActive: 10,
    maxAgeDays: 30,
    llmBudgetPerCycle: 5,
    minChainLength: 2,
    maxChainLength: 5,
    detectionIntervalMs: 60000,
    ...overrides,
  };
}

function makeMockStorage(trajectories: Trajectory[]): LearningStorage {
  return {
    getTrajectories: vi.fn().mockReturnValue(trajectories),
  } as unknown as LearningStorage;
}

// =============================================================================
// TESTS
// =============================================================================

describe("ChainDetector", () => {
  let config: ToolChainConfig;
  let storage: LearningStorage;
  let detector: ChainDetector;

  beforeEach(() => {
    config = makeConfig();
  });

  describe("detect()", () => {
    it("should detect a 2-tool sequence appearing 3+ times", () => {
      const trajectories = [
        makeTrajectory("1", ["file_read", "file_write", "git_commit"], true),
        makeTrajectory("2", ["file_read", "file_write", "git_push"], true),
        makeTrajectory("3", ["file_read", "file_write"], true),
      ];
      storage = makeMockStorage(trajectories);
      detector = new ChainDetector(storage, config);

      const results = detector.detect();

      expect(results.length).toBeGreaterThanOrEqual(1);
      const chain = results.find((c) => c.key === "file_read,file_write");
      expect(chain).toBeDefined();
      expect(chain!.occurrences).toBe(3);
      expect(chain!.toolNames).toEqual(["file_read", "file_write"]);
    });

    it("should not detect a sequence with fewer than minOccurrences", () => {
      const trajectories = [
        makeTrajectory("1", ["file_read", "file_write"], true),
        makeTrajectory("2", ["file_read", "file_write"], true),
        // Only 2 occurrences, threshold is 3
      ];
      storage = makeMockStorage(trajectories);
      detector = new ChainDetector(storage, config);

      const results = detector.detect();

      const chain = results.find((c) => c.key === "file_read,file_write");
      expect(chain).toBeUndefined();
    });

    it("should filter out chains with low success rate", () => {
      const trajectories = [
        makeTrajectory("1", ["file_read", "file_write"], true),
        makeTrajectory("2", ["file_read", "file_write"], false),
        makeTrajectory("3", ["file_read", "file_write"], false),
        makeTrajectory("4", ["file_read", "file_write"], false),
      ];
      // 1 success / 4 occurrences = 0.25 < 0.8 threshold
      storage = makeMockStorage(trajectories);
      detector = new ChainDetector(storage, config);

      const results = detector.detect();

      const chain = results.find((c) => c.key === "file_read,file_write");
      expect(chain).toBeUndefined();
    });

    it("should respect trajectory age filtering", () => {
      const now = Date.now();
      const oldTime = now - 60 * 24 * 60 * 60 * 1000; // 60 days ago
      // maxAgeDays is 30, so old trajectories should be filtered by storage
      const trajectories = [
        makeTrajectory("1", ["file_read", "file_write"], true, now),
        makeTrajectory("2", ["file_read", "file_write"], true, now),
        makeTrajectory("3", ["file_read", "file_write"], true, now),
      ];
      storage = makeMockStorage(trajectories);
      detector = new ChainDetector(storage, config);

      detector.detect();

      // Verify the storage was called with a since parameter
      expect(storage.getTrajectories).toHaveBeenCalledWith(
        expect.objectContaining({ since: expect.any(Number) }),
      );
      const call = vi.mocked(storage.getTrajectories).mock.calls[0][0]!;
      // since should be approximately now - 30 days
      const expectedSince = now - 30 * 24 * 60 * 60 * 1000;
      expect(Math.abs(call.since! - expectedSince)).toBeLessThan(1000);
    });

    it("should respect chain length bounds", () => {
      // Config allows min 2, max 5
      const trajectories = [
        makeTrajectory("1", ["a", "b", "c", "d", "e", "f", "g"], true),
        makeTrajectory("2", ["a", "b", "c", "d", "e", "f", "g"], true),
        makeTrajectory("3", ["a", "b", "c", "d", "e", "f", "g"], true),
      ];
      storage = makeMockStorage(trajectories);
      detector = new ChainDetector(storage, config);

      const results = detector.detect();

      // Should not have chains longer than maxChainLength=5
      for (const chain of results) {
        expect(chain.toolNames.length).toBeLessThanOrEqual(5);
        expect(chain.toolNames.length).toBeGreaterThanOrEqual(2);
      }
    });

    it("should apply longest-match-wins subsumption", () => {
      const trajectories = [
        makeTrajectory("1", ["a", "b", "c"], true),
        makeTrajectory("2", ["a", "b", "c"], true),
        makeTrajectory("3", ["a", "b", "c"], true),
      ];
      storage = makeMockStorage(trajectories);
      detector = new ChainDetector(storage, config);

      const results = detector.detect();

      // "a,b,c" should subsume "a,b" and "b,c" since it has equal occurrences
      const longChain = results.find((c) => c.key === "a,b,c");
      const shortAB = results.find((c) => c.key === "a,b");
      const shortBC = results.find((c) => c.key === "b,c");

      expect(longChain).toBeDefined();
      expect(shortAB).toBeUndefined();
      expect(shortBC).toBeUndefined();
    });

    it("should count per-trajectory (same sequence twice in one trajectory counts once)", () => {
      const trajectories = [
        // "a,b" appears twice in this trajectory, but should count as 1
        makeTrajectory("1", ["a", "b", "c", "a", "b"], true),
        makeTrajectory("2", ["a", "b"], true),
        makeTrajectory("3", ["a", "b"], true),
      ];
      storage = makeMockStorage(trajectories);
      detector = new ChainDetector(storage, config);

      const results = detector.detect();

      const chain = results.find((c) => c.key === "a,b");
      expect(chain).toBeDefined();
      expect(chain!.occurrences).toBe(3); // 1 per trajectory, not 2 from traj_1
    });

    it("should produce no candidates from empty or short trajectories", () => {
      const trajectories = [
        makeTrajectory("1", [], true),
        makeTrajectory("2", ["single"], true),
        makeTrajectory("3", [], true),
      ];
      storage = makeMockStorage(trajectories);
      detector = new ChainDetector(storage, config);

      const results = detector.detect();

      expect(results).toEqual([]);
    });

    it("should limit sample steps to 3", () => {
      const trajectories = [
        makeTrajectory("1", ["a", "b"], true),
        makeTrajectory("2", ["a", "b"], true),
        makeTrajectory("3", ["a", "b"], true),
        makeTrajectory("4", ["a", "b"], true),
        makeTrajectory("5", ["a", "b"], true),
      ];
      storage = makeMockStorage(trajectories);
      detector = new ChainDetector(storage, config);

      const results = detector.detect();

      const chain = results.find((c) => c.key === "a,b");
      expect(chain).toBeDefined();
      expect(chain!.sampleSteps.length).toBe(3);
    });

    it("should return candidates sorted by occurrences descending", () => {
      const trajectories = [
        // "x,y" appears in 5 trajectories
        makeTrajectory("1", ["x", "y"], true),
        makeTrajectory("2", ["x", "y"], true),
        makeTrajectory("3", ["x", "y"], true),
        makeTrajectory("4", ["x", "y"], true),
        makeTrajectory("5", ["x", "y"], true),
        // "a,b" appears in 3 trajectories
        makeTrajectory("6", ["a", "b"], true),
        makeTrajectory("7", ["a", "b"], true),
        makeTrajectory("8", ["a", "b"], true),
      ];
      storage = makeMockStorage(trajectories);
      detector = new ChainDetector(storage, config);

      const results = detector.detect();

      expect(results.length).toBeGreaterThanOrEqual(2);
      // First result should have higher occurrences
      expect(results[0].occurrences).toBeGreaterThanOrEqual(results[1].occurrences);
    });

    it("should track success count correctly", () => {
      const trajectories = [
        makeTrajectory("1", ["a", "b"], true),
        makeTrajectory("2", ["a", "b"], true),
        makeTrajectory("3", ["a", "b"], true),
        makeTrajectory("4", ["a", "b"], false),
      ];
      // 3 successes / 4 occurrences = 0.75 < 0.8 threshold
      storage = makeMockStorage(trajectories);
      detector = new ChainDetector(storage, config);

      const results = detector.detect();

      // Should be filtered out because 0.75 < 0.8
      const chain = results.find((c) => c.key === "a,b");
      expect(chain).toBeUndefined();
    });
  });
});
