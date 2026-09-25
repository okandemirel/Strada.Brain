import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LearningStorage } from "../learning/storage/learning-storage.js";
import { LearningPipeline } from "../learning/pipeline/learning-pipeline.js";
import { TaskPlanner } from "./autonomy/task-planner.js";
import { TrajectoryReplayRetriever } from "./trajectory-replay-retriever.js";
import { buildContextLayers, type ContextBuilderDeps } from "./orchestrator-context-builder.js";
import type { Trajectory } from "../learning/types.js";
import type { SessionId, TimestampMs, ToolName } from "../types/index.js";

const OWNER = { userId: "user-a", projectId: "/projects/arrows" } as const;

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
      ...OWNER,
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
      ...OWNER,
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
      ...OWNER,
    }));

    const retriever = new TrajectoryReplayRetriever(storage);
    const result = retriever.getInsightsForTask({
      taskDescription: "Fix the Unity editor crash during level generation",
      projectWorldFingerprint: "root tiki arrows modules castle systems 9",
      maxInsights: 2,
      ...OWNER,
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

  describe("owner scoping (ORC-9)", () => {
    const TASK = "Fix the Unity editor crash during level generation";

    function record(id: string, owner: { userId?: string; projectId?: string }): void {
      storage.createTrajectoryImmediate(createTrajectory({
        id,
        chatId: `chat-${id}`,
        taskRunId: `taskrun-${id}`,
        taskDescription: `Fix Unity editor crash in level generation (${id})`,
        success: true,
        branchSummary: `branch of ${id}`,
        verifierSummary: `verifier of ${id}`,
        learnedInsights: [`insight of ${id}`],
        projectWorldFingerprint: "root tiki arrows modules castle systems 9",
        createdAt: Date.now() - 1_000,
        ...owner,
      }));
    }

    function insightsFor(owner: { userId?: string; projectId?: string }) {
      return new TrajectoryReplayRetriever(storage).getInsightsForTask({
        taskDescription: TASK,
        maxInsights: 5,
        ...owner,
      });
    }

    it("does not return a trajectory recorded for user A to user B", () => {
      record("traj_alice", OWNER);

      const forB = insightsFor({ userId: "user-b", projectId: OWNER.projectId });
      expect(forB.matchedTrajectoryIds).toEqual([]);
      expect(forB.insights.join("\n")).not.toContain("traj_alice");

      const forA = insightsFor(OWNER);
      expect(forA.matchedTrajectoryIds).toEqual(["traj_alice"]);
      expect(forA.insights[0]).toContain("branch of traj_alice");
    });

    it("keeps the same user's trajectories to the project they were recorded in", () => {
      record("traj_arrows", OWNER);
      record("traj_other_project", { userId: OWNER.userId, projectId: "/projects/other" });

      expect(insightsFor(OWNER).matchedTrajectoryIds).toEqual(["traj_arrows"]);
    });

    it("returns nothing when the turn carries no user", () => {
      record("traj_alice", OWNER);

      expect(insightsFor({ projectId: OWNER.projectId }).matchedTrajectoryIds).toEqual([]);
    });

    it("does not let another user's newer rows crowd out the owner's within the limit", () => {
      record("traj_alice_old", OWNER);
      for (let i = 0; i < 5; i++) {
        storage.createTrajectoryImmediate(createTrajectory({
          id: `traj_bob_${i}`,
          chatId: "chat-bob",
          taskRunId: `taskrun-bob-${i}`,
          taskDescription: TASK,
          success: true,
          branchSummary: "bob branch",
          verifierSummary: "bob verifier",
          learnedInsights: [],
          projectWorldFingerprint: "x",
          createdAt: Date.now() - 100 + i,
          userId: "user-b",
          projectId: OWNER.projectId,
        }));
      }

      const result = new TrajectoryReplayRetriever(storage, { maxTrajectories: 3 })
        .getInsightsForTask({ taskDescription: TASK, maxInsights: 5, ...OWNER });
      expect(result.matchedTrajectoryIds).toEqual(["traj_alice_old"]);
    });

    it("reads replay candidates without their steps", () => {
      record("traj_alice", OWNER);

      const [candidate] = storage.getReplayTrajectoriesForOwner({ ...OWNER, limit: 5 });
      expect(candidate?.id).toBe("traj_alice");
      expect(candidate).not.toHaveProperty("steps");
    });

    it("shows a legacy row with no recorded owner to nobody, without rewriting it", () => {
      storage.close();
      const legacyPath = join(tempDir, "legacy-learning.db");
      const legacyDb = new Database(legacyPath);
      legacyDb.exec(`
        CREATE TABLE trajectories (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          chat_id TEXT,
          task_run_id TEXT,
          task_description TEXT NOT NULL,
          steps TEXT NOT NULL,
          outcome TEXT NOT NULL,
          applied_instinct_ids TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          processed INTEGER NOT NULL DEFAULT 0
        );
      `);
      const legacy = createTrajectory({
        id: "traj_legacy",
        chatId: "chat-legacy",
        taskRunId: "taskrun-legacy",
        taskDescription: TASK,
        success: true,
        branchSummary: "legacy branch",
        verifierSummary: "legacy verifier",
        learnedInsights: [],
        projectWorldFingerprint: "x",
        createdAt: Date.now() - 1_000,
      });
      legacyDb.prepare(
        "INSERT INTO trajectories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        legacy.id, legacy.sessionId, legacy.chatId, legacy.taskRunId, legacy.taskDescription,
        JSON.stringify(legacy.steps), JSON.stringify(legacy.outcome), "[]", legacy.createdAt, 0,
      );
      legacyDb.close();

      storage = new LearningStorage(legacyPath);
      storage.initialize();

      // The migration is additive: the row is still there, owner still unrecorded.
      const kept = storage.getTrajectory("traj_legacy");
      expect(kept?.taskDescription).toBe(TASK);
      expect(kept?.userId).toBeUndefined();
      expect(kept?.projectId).toBeUndefined();

      expect(insightsFor(OWNER).matchedTrajectoryIds).toEqual([]);
      expect(insightsFor({ userId: "user-b" }).matchedTrajectoryIds).toEqual([]);
    });

    it("the per-turn context build asks for the turn's own user and project", async () => {
      record("traj_alice", OWNER);
      const deps = {
        systemPrompt: "base",
        defaultLanguage: "en",
        projectPath: OWNER.projectId,
        taskClassifier: { classify: () => ({ type: "general", confidence: 1 }) },
        toolDefinitions: [],
        toolMetadataByName: new Map(),
        trajectoryReplayRetriever: new TrajectoryReplayRetriever(storage),
      } as unknown as ContextBuilderDeps;
      const build = (userId: string) =>
        buildContextLayers(deps, "goal", "exec", TASK, null, undefined, { userId });

      expect((await build(OWNER.userId)).context).toContain("branch of traj_alice");
      expect((await build("user-b")).context).not.toContain("traj_alice");
    });

    it("records the route-level owner so it reaches that owner and nobody else", () => {
      const pipeline = new LearningPipeline(storage);
      const planner = new TaskPlanner();
      planner.startTask({
        sessionId: "session-a",
        chatId: "chat-a",
        ...OWNER,
        taskDescription: "Fix Unity editor crash during level generation",
        learningPipeline: pipeline,
      });
      planner.endTask({ success: true, hadErrors: false, errorCount: 0 });

      expect(insightsFor(OWNER).matchedTrajectoryIds).toHaveLength(1);
      expect(insightsFor({ userId: "user-b", projectId: OWNER.projectId }).matchedTrajectoryIds).toEqual([]);
    });
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
  userId?: string;
  projectId?: string;
}): Trajectory {
  return {
    id: params.id as `traj_${string}`,
    sessionId: "session-1" as SessionId,
    chatId: params.chatId,
    taskRunId: params.taskRunId,
    userId: params.userId,
    projectId: params.projectId,
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
