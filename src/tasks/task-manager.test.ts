import { beforeAll, describe, expect, it, vi } from "vitest";
import { TaskManager } from "./task-manager.js";
import { TaskStatus, type Task } from "./types.js";
import { createLogger } from "../utils/logger.js";
import type { GoalNode, GoalTree, GoalNodeId } from "../goals/types.js";

function buildTask(overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task_test123" as Task["id"],
    chatId: "chat-1",
    channelType: "cli",
    title: "test task",
    status: TaskStatus.executing,
    prompt: "test prompt",
    progress: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeGoalTree(): GoalTree {
  const now = Date.now();
  const rootId = "goal_root" as GoalNodeId;
  const failedNodeId = "goal_failed" as GoalNodeId;
  const pendingNodeId = "goal_pending" as GoalNodeId;
  const nodes = new Map<GoalNodeId, GoalNode>([
    [rootId, {
      id: rootId,
      parentId: null,
      task: "Root",
      dependsOn: [],
      depth: 0,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }],
    [failedNodeId, {
      id: failedNodeId,
      parentId: rootId,
      task: "Fix bug",
      dependsOn: [],
      depth: 1,
      status: "failed",
      error: "boom",
      createdAt: now,
      updatedAt: now,
    }],
    [pendingNodeId, {
      id: pendingNodeId,
      parentId: rootId,
      task: "Verify",
      dependsOn: [failedNodeId],
      depth: 1,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }],
  ]);
  return {
    rootId,
    sessionId: "chat-1",
    taskDescription: "Repair the pipeline",
    nodes,
    createdAt: now,
  };
}

describe("TaskManager", () => {
  beforeAll(() => {
    try { createLogger("error", "/tmp/strada-task-manager-test.log"); } catch { /* already initialized */ }
  });

  it("fails active tasks during shutdown cleanup", () => {
    const activeTask = buildTask();
    const storage = {
      loadIncomplete: vi.fn().mockReturnValue([activeTask]),
      updateBlocked: vi.fn(),
      updateError: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);
    const failedListener = vi.fn();
    manager.on("task:failed", failedListener);

    manager.failActiveTasksOnShutdown("Shutdown cleanup.");

    expect(storage.loadIncomplete).toHaveBeenCalledOnce();
    expect(storage.updateBlocked).toHaveBeenCalledWith(activeTask.id, "Shutdown cleanup.");
    expect(failedListener).not.toHaveBeenCalled();
  });

  it("aborts tracked controllers while failing active tasks on shutdown", () => {
    const activeTask = buildTask({ id: "task_abort123" as Task["id"] });
    const storage = {
      loadIncomplete: vi.fn().mockReturnValue([activeTask]),
      updateBlocked: vi.fn(),
      updateError: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);
    const abort = vi.fn();

    (manager as any).abortControllers.set(activeTask.id, { abort });

    manager.failActiveTasksOnShutdown();

    expect(abort).toHaveBeenCalledOnce();
  });

  it("does not overwrite terminal task status during shutdown races", () => {
    const failedTask = buildTask({ status: TaskStatus.failed });
    const storage = {
      load: vi.fn().mockReturnValue(failedTask),
      updateStatus: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);

    manager.updateStatus(failedTask.id, TaskStatus.executing);

    expect(storage.updateStatus).not.toHaveBeenCalled();
  });

  it("strips provider reasoning artifacts before completing a task", () => {
    const storage = {
      updateResult: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);
    const completedListener = vi.fn();
    manager.on("task:completed", completedListener);

    manager.complete(
      "task_reasoning123" as Task["id"],
      "<reasoning>\ninternal\n</reasoning>\n\nVisible answer.",
    );

    expect(storage.updateResult).toHaveBeenCalledWith("task_reasoning123", "Visible answer.");
    expect(completedListener).toHaveBeenCalledWith("task_reasoning123", "Visible answer.");
  });

  it("counts only foreground tasks when agent-core asks for active user work", () => {
    const storage = {
      loadIncomplete: vi.fn().mockReturnValue([
        buildTask({ id: "task_user123" as Task["id"], chatId: "cli-local", channelType: "cli" }),
        buildTask({ id: "task_goal123" as Task["id"], chatId: "chat-2", channelType: "goal" }),
        buildTask({ id: "task_daemon123" as Task["id"], chatId: "daemon", channelType: "daemon" }),
        buildTask({ id: "task_agent123" as Task["id"], chatId: "agent-core", channelType: "daemon" }),
      ]),
    } as any;
    const manager = new TaskManager(storage, {} as any);

    expect(manager.countActiveForegroundTasks(["cli-local"])).toBe(1);
    expect(manager.hasActiveForegroundTasks(["cli-local"])).toBe(true);
  });

  it("stores the user-facing summary when structured progress is provided", () => {
    const storage = {
      addProgress: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);

    manager.addProgress("task_progress123" as Task["id"], {
      kind: "verification",
      message: "Verification required before completion",
      userSummary: "Aşama: doğrulama. Son aksiyon: son değişiklikleri build ve kalite kontrollerine soktum. Sıradaki adım: çıkan sinyalleri teyit edip sonucu paylaşacağım.",
    });

    expect(storage.addProgress).toHaveBeenCalledWith(
      "task_progress123",
      "Aşama: doğrulama. Son aksiyon: son değişiklikleri build ve kalite kontrollerine soktum. Sıradaki adım: çıkan sinyalleri teyit edip sonucu paylaşacağım.",
    );
  });

  it("creates a new retry attempt for a failed standalone task", () => {
    const failedTask = buildTask({
      id: "task_failed123" as Task["id"],
      status: TaskStatus.failed,
      error: "Build failed",
    });
    const storage = {
      load: vi.fn().mockReturnValue(failedTask),
      save: vi.fn(),
    } as any;
    const executor = { enqueue: vi.fn() } as any;
    const manager = new TaskManager(storage, executor);

    const nextTask = manager.retryTask(failedTask.id);

    expect(nextTask).toEqual(expect.objectContaining({
      parentId: failedTask.id,
      status: TaskStatus.pending,
    }));
    expect(nextTask?.prompt).toContain("Previous background execution failed or stalled")
    expect(storage.save).toHaveBeenCalledWith(expect.objectContaining({
      id: nextTask?.id,
      parentId: failedTask.id,
    }))
    expect(executor.enqueue).toHaveBeenCalledOnce()
  });

  it("creates a goal retry attempt that preserves completed checkpoints", () => {
    const failedTask = buildTask({
      id: "task_goal123" as Task["id"],
      status: TaskStatus.failed,
      goalRootId: "goal_root",
      prompt: "Repair the pipeline",
    });
    const storage = {
      findLatestByGoalRoot: vi.fn().mockReturnValue(failedTask),
      save: vi.fn(),
    } as any;
    const executor = { enqueue: vi.fn() } as any;
    const goalStorage = {
      getTree: vi.fn().mockReturnValue(makeGoalTree()),
    } as any;
    const manager = new TaskManager(storage, executor, goalStorage);

    const nextTask = manager.retryGoalRoot("goal_root", "goal_failed");

    expect(nextTask?.goalTree?.nodes.get("goal_failed" as GoalNodeId)?.status).toBe("pending")
    expect(nextTask?.goalTree?.nodes.get("goal_pending" as GoalNodeId)?.status).toBe("pending")
    expect(nextTask).toEqual(expect.objectContaining({
      parentId: failedTask.id,
      goalRootId: "goal_root",
      forceSharedPlanning: true,
    }))
    expect(executor.enqueue).toHaveBeenCalledOnce()
  });

  it("marks user tasks blocked on startup recovery so they can be resumed", () => {
    const interruptedTask = buildTask({
      id: "task_resume123" as Task["id"],
      status: TaskStatus.executing,
      origin: "user",
      goalRootId: "goal_root",
    });
    const storage = {
      loadIncomplete: vi.fn().mockReturnValue([interruptedTask]),
      updateBlocked: vi.fn(),
      updateError: vi.fn(),
    } as any;
    const goalStorage = { updateTreeStatus: vi.fn() } as any;
    const manager = new TaskManager(storage, {} as any, goalStorage);
    const blockedListener = vi.fn();
    manager.on("task:blocked", blockedListener);

    manager.recoverOnStartup();

    expect(storage.updateBlocked).toHaveBeenCalledWith(
      interruptedTask.id,
      expect.stringContaining("Resume is available"),
    )
    expect(storage.updateError).not.toHaveBeenCalled()
    expect(goalStorage.updateTreeStatus).toHaveBeenCalledWith("goal_root", "blocked")
    expect(blockedListener).toHaveBeenCalled()
  });
});
