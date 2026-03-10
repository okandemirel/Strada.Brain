/**
 * ChainValidator Tests
 *
 * Tests for post-synthesis validation (INTEL-05) and runtime feedback (INTEL-06).
 * Covers: trajectory replay, confidence updates, deprecation cascade, edge cases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChainValidator } from "./chain-validator.js";
import type { Instinct, Trajectory, TrajectoryStep } from "../types.js";
import { CONFIDENCE_THRESHOLDS } from "../types.js";
import type { LearningStorage } from "../storage/learning-storage.js";
import type { ConfidenceScorer } from "../scoring/confidence-scorer.js";
import type {
  IEventEmitter,
  LearningEventMap,
  ChainExecutionEvent,
} from "../../core/event-bus.js";

// =============================================================================
// HELPERS
// =============================================================================

function makeInstinct(overrides: Partial<Instinct> = {}): Instinct {
  return {
    id: "instinct_test_001" as Instinct["id"],
    name: "test_chain",
    type: "tool_chain",
    status: "active",
    confidence: 0.5,
    triggerPattern: "file_read -> file_write",
    action: JSON.stringify({ toolSequence: ["file_read", "file_write"] }),
    contextConditions: [],
    stats: {
      timesSuggested: 10,
      timesApplied: 8,
      timesFailed: 2,
      successRate: 0.8,
      averageExecutionMs: 500,
    },
    createdAt: Date.now() as never,
    updatedAt: Date.now() as never,
    sourceTrajectoryIds: [],
    tags: [],
    bayesianAlpha: 5,
    bayesianBeta: 3,
    ...overrides,
  } as Instinct;
}

function makeStep(
  toolName: string,
  stepNumber: number,
  success = true,
): TrajectoryStep {
  return {
    stepNumber,
    toolName,
    input: {},
    result: success
      ? { kind: "success", output: "ok" }
      : { kind: "error", error: { category: "runtime", message: "fail" } },
    timestamp: Date.now() as never,
    durationMs: 100 as never,
  };
}

function makeTrajectory(
  id: string,
  toolNames: string[],
  allSuccess = true,
  createdAt?: number,
): Trajectory {
  return {
    id: `traj_${id}` as never,
    sessionId: "sess_1" as never,
    taskDescription: "test task",
    steps: toolNames.map((name, i) => makeStep(name, i + 1, allSuccess)),
    outcome: {
      success: allSuccess,
      totalSteps: toolNames.length,
      hadErrors: !allSuccess,
      errorCount: allSuccess ? 0 : 1,
      durationMs: 1000 as never,
      completionRate: (allSuccess ? 1 : 0) as never,
    },
    appliedInstinctIds: [],
    createdAt: (createdAt ?? Date.now()) as never,
    processed: true,
  };
}

function makeChainExecutionEvent(
  overrides: Partial<ChainExecutionEvent> = {},
): ChainExecutionEvent {
  return {
    chainName: "test_chain",
    success: true,
    stepResults: [
      { tool: "file_read", success: true, durationMs: 50 },
      { tool: "file_write", success: true, durationMs: 50 },
    ],
    totalDurationMs: 100,
    timestamp: Date.now(),
    ...overrides,
  };
}

interface MockDeps {
  storage: {
    getInstincts: ReturnType<typeof vi.fn>;
    getInstinct: ReturnType<typeof vi.fn>;
    getTrajectories: ReturnType<typeof vi.fn>;
    updateInstinct: ReturnType<typeof vi.fn>;
  };
  confidenceScorer: {
    updateConfidence: ReturnType<typeof vi.fn>;
  };
  eventBus: {
    emit: ReturnType<typeof vi.fn>;
  };
  updateInstinctStatus: ReturnType<typeof vi.fn>;
  onChainDeprecated: ReturnType<typeof vi.fn>;
}

function makeMockDeps(): MockDeps {
  return {
    storage: {
      getInstincts: vi.fn().mockReturnValue([]),
      getInstinct: vi.fn().mockReturnValue(null),
      getTrajectories: vi.fn().mockReturnValue([]),
      updateInstinct: vi.fn(),
    },
    confidenceScorer: {
      updateConfidence: vi.fn().mockImplementation((inst: Instinct) => inst),
    },
    eventBus: {
      emit: vi.fn(),
    },
    updateInstinctStatus: vi.fn(),
    onChainDeprecated: vi.fn(),
  };
}

function createValidator(deps: MockDeps): ChainValidator {
  return new ChainValidator({
    storage: deps.storage as unknown as LearningStorage,
    confidenceScorer: deps.confidenceScorer as unknown as ConfidenceScorer,
    eventBus: deps.eventBus as unknown as IEventEmitter<LearningEventMap>,
    updateInstinctStatus: deps.updateInstinctStatus,
    onChainDeprecated: deps.onChainDeprecated,
    maxAgeDays: 30,
  });
}

// =============================================================================
// TESTS: INTEL-05 (Post-Synthesis Validation)
// =============================================================================

describe("ChainValidator", () => {
  let deps: MockDeps;
  let validator: ChainValidator;

  beforeEach(() => {
    deps = makeMockDeps();
    validator = createValidator(deps);
  });

  describe("validatePostSynthesis (INTEL-05)", () => {
    it("updates instinct confidence for matching trajectories", () => {
      const instinct = makeInstinct();
      deps.storage.getInstincts.mockReturnValue([instinct]);

      // Trajectory with [file_read, file_write, deploy] contains [file_read, file_write]
      const traj = makeTrajectory("1", [
        "file_read",
        "file_write",
        "deploy",
      ]);
      deps.storage.getTrajectories.mockReturnValue([traj]);

      const updatedInstinct = makeInstinct({ confidence: 0.55 });
      deps.confidenceScorer.updateConfidence.mockReturnValue(updatedInstinct);

      validator.validatePostSynthesis(
        "test_chain",
        ["file_read", "file_write"],
        "instinct_test_001",
      );

      expect(deps.confidenceScorer.updateConfidence).toHaveBeenCalledWith(
        instinct,
        true,
      );
      expect(deps.storage.updateInstinct).toHaveBeenCalledWith(
        updatedInstinct,
      );
    });

    it("returns early when no matching trajectories exist", () => {
      const instinct = makeInstinct();
      deps.storage.getInstincts.mockReturnValue([instinct]);

      // Trajectory with unrelated tools
      const traj = makeTrajectory("1", ["git_status", "git_commit"]);
      deps.storage.getTrajectories.mockReturnValue([traj]);

      validator.validatePostSynthesis(
        "test_chain",
        ["file_read", "file_write"],
        "instinct_test_001",
      );

      expect(deps.confidenceScorer.updateConfidence).not.toHaveBeenCalled();
      expect(deps.storage.updateInstinct).not.toHaveBeenCalled();
    });

    it("returns early when instinct is not found", () => {
      deps.storage.getInstincts.mockReturnValue([]);

      validator.validatePostSynthesis(
        "test_chain",
        ["file_read", "file_write"],
        "instinct_missing",
      );

      expect(deps.storage.getTrajectories).not.toHaveBeenCalled();
      expect(deps.confidenceScorer.updateConfidence).not.toHaveBeenCalled();
    });

    it("emits chain:validated event with correct payload", () => {
      const instinct = makeInstinct();
      deps.storage.getInstincts.mockReturnValue([instinct]);

      const traj = makeTrajectory("1", [
        "file_read",
        "file_write",
        "deploy",
      ]);
      deps.storage.getTrajectories.mockReturnValue([traj]);

      const updatedInstinct = makeInstinct({ confidence: 0.55 });
      deps.confidenceScorer.updateConfidence.mockReturnValue(updatedInstinct);

      validator.validatePostSynthesis(
        "test_chain",
        ["file_read", "file_write"],
        "instinct_test_001",
      );

      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        "chain:validated",
        expect.objectContaining({
          chainName: "test_chain",
          validationCount: 1,
          resultingConfidence: 0.55,
          deprecated: false,
        }),
      );
    });

    it("triggers deprecation when confidence drops below 0.3", () => {
      const instinct = makeInstinct();
      deps.storage.getInstincts.mockReturnValue([instinct]);

      // Trajectory with failed steps
      const traj = makeTrajectory(
        "1",
        ["file_read", "file_write", "deploy"],
        false,
      );
      deps.storage.getTrajectories.mockReturnValue([traj]);

      const deprecatedInstinct = makeInstinct({
        confidence: 0.2,
        status: "active",
      });
      deps.confidenceScorer.updateConfidence.mockReturnValue(
        deprecatedInstinct,
      );

      validator.validatePostSynthesis(
        "test_chain",
        ["file_read", "file_write"],
        "instinct_test_001",
      );

      // Should trigger deprecation cascade
      expect(deps.onChainDeprecated).toHaveBeenCalledWith("test_chain");
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        "chain:invalidated",
        expect.objectContaining({
          chainName: "test_chain",
          reason: expect.stringContaining("confidence below threshold"),
        }),
      );
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        "chain:validated",
        expect.objectContaining({
          deprecated: true,
        }),
      );
    });

    it("handles multiple matching trajectories", () => {
      const instinct = makeInstinct();
      deps.storage.getInstincts.mockReturnValue([instinct]);

      const traj1 = makeTrajectory("1", ["file_read", "file_write", "deploy"]);
      const traj2 = makeTrajectory("2", [
        "init",
        "file_read",
        "file_write",
      ]);
      const traj3 = makeTrajectory("3", ["git_status", "git_commit"]); // no match
      deps.storage.getTrajectories.mockReturnValue([traj1, traj2, traj3]);

      const updated1 = makeInstinct({ confidence: 0.55 });
      const updated2 = makeInstinct({ confidence: 0.6 });
      deps.confidenceScorer.updateConfidence
        .mockReturnValueOnce(updated1)
        .mockReturnValueOnce(updated2);

      validator.validatePostSynthesis(
        "test_chain",
        ["file_read", "file_write"],
        "instinct_test_001",
      );

      expect(deps.confidenceScorer.updateConfidence).toHaveBeenCalledTimes(2);
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        "chain:validated",
        expect.objectContaining({
          validationCount: 2,
          resultingConfidence: 0.6,
        }),
      );
    });
  });

  // ===========================================================================
  // TESTS: INTEL-06 (Runtime Feedback + Auto-Deprecation)
  // ===========================================================================

  describe("handleChainExecuted (INTEL-06)", () => {
    it("updates confidence on success", () => {
      const instinct = makeInstinct();
      deps.storage.getInstincts.mockReturnValue([instinct]);

      const updatedInstinct = makeInstinct({ confidence: 0.55 });
      deps.confidenceScorer.updateConfidence.mockReturnValue(updatedInstinct);

      // After updateInstinctStatus, re-read from storage (still active)
      deps.storage.getInstinct.mockReturnValue(updatedInstinct);

      const event = makeChainExecutionEvent({ success: true });
      validator.handleChainExecuted(event);

      expect(deps.confidenceScorer.updateConfidence).toHaveBeenCalledWith(
        instinct,
        true,
      );
      expect(deps.storage.updateInstinct).toHaveBeenCalledWith(
        updatedInstinct,
      );
    });

    it("updates confidence on failure", () => {
      const instinct = makeInstinct();
      deps.storage.getInstincts.mockReturnValue([instinct]);

      const updatedInstinct = makeInstinct({ confidence: 0.4 });
      deps.confidenceScorer.updateConfidence.mockReturnValue(updatedInstinct);

      deps.storage.getInstinct.mockReturnValue(updatedInstinct);

      const event = makeChainExecutionEvent({ success: false });
      validator.handleChainExecuted(event);

      expect(deps.confidenceScorer.updateConfidence).toHaveBeenCalledWith(
        instinct,
        false,
      );
    });

    it("skips permanent instincts", () => {
      const permanent = makeInstinct({ status: "permanent" });
      deps.storage.getInstincts.mockReturnValue([permanent]);

      const event = makeChainExecutionEvent();
      validator.handleChainExecuted(event);

      expect(deps.confidenceScorer.updateConfidence).not.toHaveBeenCalled();
      expect(deps.storage.updateInstinct).not.toHaveBeenCalled();
    });

    it("skips deprecated instincts", () => {
      const deprecated = makeInstinct({ status: "deprecated" });
      deps.storage.getInstincts.mockReturnValue([deprecated]);

      const event = makeChainExecutionEvent();
      validator.handleChainExecuted(event);

      expect(deps.confidenceScorer.updateConfidence).not.toHaveBeenCalled();
      expect(deps.storage.updateInstinct).not.toHaveBeenCalled();
    });

    it("calls updateInstinctStatus for lifecycle management", () => {
      const instinct = makeInstinct();
      deps.storage.getInstincts.mockReturnValue([instinct]);

      const updatedInstinct = makeInstinct({ confidence: 0.55 });
      deps.confidenceScorer.updateConfidence.mockReturnValue(updatedInstinct);
      deps.storage.getInstinct.mockReturnValue(updatedInstinct);

      const event = makeChainExecutionEvent();
      validator.handleChainExecuted(event);

      expect(deps.updateInstinctStatus).toHaveBeenCalledWith(updatedInstinct);
    });

    it("calls onChainDeprecated when instinct becomes deprecated", () => {
      const instinct = makeInstinct();
      deps.storage.getInstincts.mockReturnValue([instinct]);

      const updatedInstinct = makeInstinct({ confidence: 0.2 });
      deps.confidenceScorer.updateConfidence.mockReturnValue(updatedInstinct);

      // After updateInstinctStatus, storage returns deprecated instinct
      const deprecatedInstinct = makeInstinct({
        confidence: 0.2,
        status: "deprecated",
      });
      deps.storage.getInstinct.mockReturnValue(deprecatedInstinct);

      const event = makeChainExecutionEvent({ success: false });
      validator.handleChainExecuted(event);

      expect(deps.onChainDeprecated).toHaveBeenCalledWith("test_chain");
    });

    it("does nothing for unknown chain name", () => {
      deps.storage.getInstincts.mockReturnValue([]);

      const event = makeChainExecutionEvent({
        chainName: "nonexistent_chain",
      });
      validator.handleChainExecuted(event);

      expect(deps.confidenceScorer.updateConfidence).not.toHaveBeenCalled();
      expect(deps.storage.updateInstinct).not.toHaveBeenCalled();
      expect(deps.updateInstinctStatus).not.toHaveBeenCalled();
    });
  });
});
