import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningStorage } from "../learning/storage/learning-storage.js";
import { TrajectoryReplayRetriever } from "./trajectory-replay-retriever.js";
import type { Trajectory } from "../learning/types.js";
import type { SessionId, TimestampMs, ToolName } from "../types/index.js";

describe("TrajectoryReplayRetriever", () => {
  let tempDir: string;
  let storage: LearningStorage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trajectory-replay-"));
    storage = new LearningStorage(join(tempDir, "learning.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("surfaces success and failure replay insights for the same world context", () => {
    storage.createTrajectoryImmediate(createTrajectory({
      id: "traj_success",
      chatId: "chat-levels",
      taskRunId: "taskrun-level-031",
      taskDescription: "Fix Unity level generation crash in Level_031",
      success: true,
      branchSummary: "inspected Level_031 asset serialization and runtime import path",
      verifierSummary: "playmode repro is now clean",
      learnedInsights: ["Verify runtime import behavior, not just serialized YAML."],
      projectWorldFingerprint: "root tiki arrows modules castle systems 9",
      createdAt: Date.now() - 3_000,
    }));
    storage.createTrajectoryImmediate(createTrajectory({
      id: "traj_failure",
      chatId: "chat-levels",
      taskRunId: "taskrun-level-100",
      taskDescription: "Analyze why Unity editor crashes while creating 100 levels",
      success: false,
      branchSummary: "assuming asset YAML alone proved runtime correctness",
      verifierSummary: "live Unity repro still crashes during batch generation",
      learnedInsights: ["Do not trust asset text alone for runtime crash analysis."],
      projectWorldFingerprint: "root tiki arrows modules castle systems 9",
      createdAt: Date.now() - 2_000,
    }));
    storage.createTrajectoryImmediate(createTrajectory({
      id: "traj_other_world",
      chatId: "chat-dashboard",
      taskRunId: "taskrun-dashboard",
      taskDescription: "Fix web socket reconnect loop in dashboard",
      success: true,
      branchSummary: "dashboard socket retry path",
      verifierSummary: "web smoke passed",
      learnedInsights: ["Back off reconnect timing before opening a new socket."],
      projectWorldFingerprint: "root strada brain modules dashboard systems 3",
      createdAt: Date.now() - 1_000,
    }));

    const retriever = new TrajectoryReplayRetriever(storage);
    const result = retriever.getInsightsForTask({
      taskDescription: "Fix the Unity editor crash during level generation",
      projectWorldFingerprint: "root tiki arrows modules castle systems 9",
      maxInsights: 2,
    });

    expect(result.matchedTrajectoryIds).toContain("traj_success");
    expect(result.matchedTrajectoryIds).toContain("traj_failure");
    expect(result.insights[0]).toContain("Replay success");
    expect(result.insights[0]).toContain("same project/world context");
    expect(result.insights.join("\n")).toContain("Replay warning");
    expect(result.insights.join("\n")).not.toContain("dashboard socket retry path");
  });

  it("retrieves exact replay context with chat-scoped taskRunId isolation", () => {
    storage.createTrajectoryImmediate(createTrajectory({
      id: "traj_current_chat",
      chatId: "chat-replay",
      taskRunId: "taskrun-shared",
      taskDescription: "Fix Level_031 runtime import path",
      success: true,
      branchSummary: "current chat Level_031 branch",
      verifierSummary: "current chat verifier memory",
      learnedInsights: ["Current chat replay should win."],
      projectWorldFingerprint: "root tiki arrows modules castle systems 9",
      createdAt: Date.now() - 2_000,
    }));
    storage.createTrajectoryImmediate(createTrajectory({
      id: "traj_other_chat",
      chatId: "chat-other",
      taskRunId: "taskrun-shared",
      taskDescription: "Different chat should not leak",
      success: true,
      branchSummary: "foreign branch",
      verifierSummary: "foreign verifier",
      learnedInsights: ["Foreign chat replay should stay isolated."],
      projectWorldFingerprint: "root tiki arrows modules castle systems 9",
      createdAt: Date.now() - 1_000,
    }));

    const retriever = new TrajectoryReplayRetriever(storage);
    const scoped = retriever.getReplayContextForTaskRun({
      taskRunId: "taskrun-shared",
      chatId: "chat-replay",
    });
    const unscoped = retriever.getReplayContextForTaskRun({
      taskRunId: "taskrun-shared",
    });

    expect(scoped.found).toBe(true);
    expect(scoped.replayContext?.branchSummary).toContain("Level_031");
    expect(scoped.replayContext?.verifierSummary).toContain("current chat");
    expect(unscoped.replayContext?.branchSummary).toContain("foreign branch");
  });
});

function createTrajectory(params: {
  id: string;
  chatId: string;
  taskRunId: string;
  taskDescription: string;
  success: boolean;
  branchSummary: string;
  verifierSummary: string;
  learnedInsights: string[];
  projectWorldFingerprint: string;
  createdAt: number;
}): Trajectory {
  return {
    id: params.id as `traj_${string}`,
    sessionId: "session-1" as SessionId,
    chatId: params.chatId,
    taskRunId: params.taskRunId,
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
        branchSummary: params.branchSummary,
        verifierSummary: params.verifierSummary,
        learnedInsights: params.learnedInsights,
      },
    },
    appliedInstinctIds: [],
    createdAt: params.createdAt as TimestampMs,
    processed: false,
  };
}
