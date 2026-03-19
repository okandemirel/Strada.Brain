import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "../../learning/storage/learning-storage.js";
import { TrajectoryPhaseSignalRetriever } from "./trajectory-phase-signal-retriever.js";
import type { Trajectory } from "../../learning/types.js";
import type { SessionId, TimestampMs, ToolName } from "../../types/index.js";

describe("TrajectoryPhaseSignalRetriever", () => {
  let tempDir: string;
  let storage: LearningStorage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trajectory-phase-signals-"));
    storage = new LearningStorage(join(tempDir, "learning.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("aggregates phase/provider replay signals from similar trajectories", () => {
    storage.createTrajectoryImmediate(createTrajectory({
      id: "traj_beta_success",
      taskDescription: "Fix Unity editor crash while generating 100 levels",
      success: true,
      projectWorldFingerprint: "root tiki arrows modules castle systems 9",
      phaseTelemetry: [
        {
          phase: "planning",
          role: "planner",
          provider: "beta",
          model: "beta-model",
          source: "supervisor-strategy",
          status: "approved",
          verifierDecision: "approve",
          timestamp: Date.now() - 4_000,
        },
      ],
      createdAt: Date.now() - 4_000,
    }));
    storage.createTrajectoryImmediate(createTrajectory({
      id: "traj_alpha_failure",
      taskDescription: "Analyze why Unity editor crashes while creating 100 levels",
      success: false,
      projectWorldFingerprint: "root tiki arrows modules castle systems 9",
      phaseTelemetry: [
        {
          phase: "planning",
          role: "planner",
          provider: "alpha",
          model: "alpha-model",
          source: "supervisor-strategy",
          status: "replanned",
          verifierDecision: "replan",
          retryCount: 4,
          rollbackDepth: 2,
          timestamp: Date.now() - 2_000,
        },
      ],
      createdAt: Date.now() - 2_000,
    }));

    const retriever = new TrajectoryPhaseSignalRetriever(storage);
    const signals = retriever.getSignalsForTask({
      taskDescription: "Fix the Unity crash during 100-level generation",
      phase: "planning",
      projectWorldFingerprint: "root tiki arrows modules castle systems 9",
    });

    const beta = signals.find((signal) => signal.provider === "beta");
    const alpha = signals.find((signal) => signal.provider === "alpha");
    expect(beta).toBeDefined();
    expect(alpha).toBeDefined();
    expect(beta!.score).toBeGreaterThan(alpha!.score);
    expect(beta!.sameWorldMatches).toBeGreaterThan(0);
    expect(alpha!.failureCount).toBeGreaterThan(0);
  });

  it("does not penalize an approved phase because a later phase failed", () => {
    storage.createTrajectoryImmediate(createTrajectory({
      id: "traj_beta_phase_clean",
      taskDescription: "Plan the fix for the Unity editor crash while generating 100 levels",
      success: false,
      projectWorldFingerprint: "root tiki arrows modules castle systems 9",
      phaseTelemetry: [
        {
          phase: "planning",
          role: "planner",
          provider: "beta",
          model: "beta-model",
          source: "supervisor-strategy",
          status: "approved",
          verifierDecision: "approve",
          timestamp: Date.now() - 3_000,
        },
        {
          phase: "executing",
          role: "executor",
          provider: "alpha",
          model: "alpha-model",
          source: "supervisor-strategy",
          status: "failed",
          verifierDecision: "replan",
          timestamp: Date.now() - 2_000,
        },
      ],
      createdAt: Date.now() - 3_000,
    }));

    const retriever = new TrajectoryPhaseSignalRetriever(storage);
    const signals = retriever.getSignalsForTask({
      taskDescription: "Fix the Unity crash during 100-level generation",
      phase: "planning",
      projectWorldFingerprint: "root tiki arrows modules castle systems 9",
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      provider: "beta",
      successCount: 1,
      failureCount: 0,
    });
    expect(signals[0]!.score).toBeGreaterThan(0.6);
  });
});

function createTrajectory(params: {
  id: string;
  taskDescription: string;
  success: boolean;
  projectWorldFingerprint: string;
  phaseTelemetry: NonNullable<Trajectory["outcome"]["replayContext"]>["phaseTelemetry"];
  createdAt: number;
}): Trajectory {
  return {
    id: params.id as `traj_${string}`,
    sessionId: "session-1" as SessionId,
    taskDescription: params.taskDescription,
    steps: [{
      stepNumber: 1,
      toolName: "file_read" as ToolName,
      input: {},
      result: {
        kind: params.success ? "success" : "error",
        ...(params.success
          ? { output: "ok" }
          : { error: { category: "runtime", message: "Unity crash" } }),
      },
      timestamp: params.createdAt as TimestampMs,
      durationMs: 0 as any,
    }],
    outcome: {
      success: params.success,
      totalSteps: 3,
      hadErrors: !params.success,
      errorCount: params.success ? 0 : 2,
      durationMs: 1000 as any,
      completionRate: 0.8 as any,
      replayContext: {
        projectWorldFingerprint: params.projectWorldFingerprint,
        projectWorldSummary: "root=/Users/okan/Tiki/arrows | modules=Castle",
        branchSummary: "stable checkpoint: inspected Level_031",
        verifierSummary: params.success ? "playmode repro clean" : "live repro still crashes",
        learnedInsights: ["Avoid repeating YAML-only assumptions."],
        phaseTelemetry: params.phaseTelemetry,
      },
    },
    appliedInstinctIds: [],
    createdAt: params.createdAt as TimestampMs,
    processed: false,
  };
}
