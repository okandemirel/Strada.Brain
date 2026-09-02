import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskManager } from "./task-manager.js";
import { TaskStorage } from "./task-storage.js";
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

  it("does not count parked tasks (paused / waiting_for_input) as active foreground work", () => {
    // A parked task waits on a person and consumes no execution slot. Counting
    // it made one abandoned pause defer every daemon-origin task in the queue
    // for the life of the process.
    const storage = {
      loadIncomplete: vi.fn().mockReturnValue([
        buildTask({ id: "task_paused" as Task["id"], status: TaskStatus.paused }),
        buildTask({ id: "task_waiting" as Task["id"], status: TaskStatus.waiting_for_input }),
      ]),
    } as any;
    const manager = new TaskManager(storage, {} as any);

    expect(manager.countActiveForegroundTasks()).toBe(0);
    expect(manager.hasActiveForegroundTasks()).toBe(false);
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

  // Regression: enqueue() throws on queue overflow. submit() runs fire-and-forget
  // from MessageRouter.flushPendingChat (`void this.flushPendingChat(...)`), so a
  // throw escaping submit() becomes an unhandledRejection — which the global
  // handler in src/index.ts escalates to a full daemon shutdown.
  it("does not let an enqueue overflow throw escape submit()", () => {
    const storage = { save: vi.fn() } as any;
    const executor = {
      enqueue: vi.fn().mockImplementation(() => {
        throw new Error("Task queue full (max 100). Try again later.");
      }),
    } as any;
    const manager = new TaskManager(storage, executor);

    let task: Task | undefined;
    expect(() => {
      task = manager.submit("chat-1", "cli", "do the thing");
    }).not.toThrow();
    expect(executor.enqueue).toHaveBeenCalledOnce();
    expect(task).toBeDefined();
    // The unusable abort controller for the rejected task is cleaned up.
    expect((manager as unknown as { abortControllers: Map<string, AbortController> })
      .abortControllers.has(task!.id)).toBe(false);
  });

  // Regression (H1): cancelling a *paused* task must release its conversation
  // lock — otherwise the conversationKey is stuck in pausedConversations forever
  // (resumeTask() can no longer remove it once the task is cancelled) and every
  // future task in that conversation is skipped.
  it("releases the conversation lock when cancelling a paused task", () => {
    const pausedTask = buildTask({
      id: "task_paused1" as Task["id"],
      status: TaskStatus.paused,
      chatId: "chat-x",
      channelType: "cli",
    });
    const storage = {
      load: vi.fn().mockReturnValue(pausedTask),
      updateStatus: vi.fn(),
    } as any;
    const executor = { resumeConversation: vi.fn() } as any;
    const manager = new TaskManager(storage, executor);

    const cancelled = manager.cancel("task_paused1" as Task["id"]);

    expect(cancelled).toBe(true);
    expect(executor.resumeConversation).toHaveBeenCalledTimes(1);
    expect(storage.updateStatus).toHaveBeenCalledWith("task_paused1", TaskStatus.cancelled);
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
      updateStatus: vi.fn(),
      updateError: vi.fn(),
    } as any;
    const goalStorage = { updateTreeStatus: vi.fn() } as any;
    const manager = new TaskManager(storage, {} as any, goalStorage);
    const pausedListener = vi.fn();
    manager.on("task:paused", pausedListener);

    manager.recoverOnStartup();

    expect(storage.updateStatus).toHaveBeenCalledWith(
      interruptedTask.id,
      TaskStatus.paused,
    );
    expect(storage.updateError).toHaveBeenCalledWith(
      interruptedTask.id,
      expect.stringContaining("Resume is available"),
    );
    expect(goalStorage.updateTreeStatus).toHaveBeenCalledWith("goal_root", "paused");
    expect(pausedListener).toHaveBeenCalled()
  });

  it("leaves a recovered user task paused, not failed (updateError must not clobber paused)", () => {
    const interruptedTask = buildTask({
      id: "task_order123" as Task["id"],
      status: TaskStatus.executing,
      origin: "user",
    });
    // Fake storage mirroring the real SQL: updateError forces status=failed;
    // updateStatus only changes status. Recovery must end on 'paused'.
    let status: TaskStatus = interruptedTask.status;
    const storage = {
      loadIncomplete: vi.fn().mockReturnValue([interruptedTask]),
      updateStatus: vi.fn((_id: Task["id"], s: TaskStatus) => { status = s; }),
      updateError: vi.fn(() => { status = TaskStatus.failed; }),
    } as any;
    const manager = new TaskManager(storage, {} as any);

    manager.recoverOnStartup();

    expect(status).toBe(TaskStatus.paused);
  });

  it("a replay keeps the live orchestrator and workspace policy the task was submitted with", () => {
    // Audited 2026-09-02: every replay path rebuilt the task from SQLite.
    // The live orchestrator has no column, so an agent's retried mission ran
    // as the MAIN agent (wrong memory namespace, wrong budget) with nothing
    // logged; workspacePolicy was neither persisted nor forwarded, so a
    // "run against the real root" fix task came back leased on retry.
    const dir = mkdtempSync(join(tmpdir(), "task-manager-replay-"));
    const storage = new TaskStorage(join(dir, "tasks.db"));
    storage.initialize();
    const executor = { enqueue: vi.fn(), resumeConversation: vi.fn() } as any;
    const manager = new TaskManager(storage, executor);
    const agentOrchestrator = { name: "agent-orchestrator" } as any;
    try {
      const task = manager.submit("chat-1", "cli", "an agent's own overnight mission", {
        orchestrator: agentOrchestrator,
        workspacePolicy: "none",
      });
      // The row round-trips through SQLite without the live object graph.
      expect(storage.load(task.id)?.orchestrator).toBeUndefined();

      manager.block(task.id, "Transient failure — provider blink.");
      const retry = manager.retryTask(task.id);
      expect(retry).not.toBeNull();

      const enqueued = executor.enqueue.mock.calls[1]?.[0] as Task;
      expect(enqueued.id).toBe(retry!.id);
      expect(enqueued.orchestrator).toBe(agentOrchestrator);
      expect(enqueued.workspacePolicy).toBe("none");
      // The retry's own row carries the policy for the round after it.
      expect(storage.load(retry!.id)?.workspacePolicy).toBe("none");
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a replay keeps the rich-input fields the task was submitted with (attachments, userContent, forceSharedPlanning)", () => {
    // Audited 2026-09-02: every replay path rebuilds the task from SQLite and
    // re-submits it field by field. forceSharedPlanning was persisted but NOT
    // forwarded, so a task submitted with rich input — reflection.ts sets
    // forceSharedPlanning when the message carries images/files, because that
    // input can only be planned, not decomposed blind — came back on retry as
    // an ordinary worker run (background-executor gates shared planning on
    // `goalTree || forceSharedPlanning || shouldDecompose`). The attachments
    // and userContent it planned FROM still rode along, so the replay reran
    // the same screenshot task down a route that never sees the plan.
    const dir = mkdtempSync(join(tmpdir(), "task-manager-replay-rich-"));
    const storage = new TaskStorage(join(dir, "tasks.db"));
    storage.initialize();
    const executor = { enqueue: vi.fn(), resumeConversation: vi.fn() } as any;
    const manager = new TaskManager(storage, executor);
    const attachments = [{
      type: "image" as const,
      name: "layout.png",
      mimeType: "image/png",
      data: Buffer.from("png-bytes"),
      size: 9,
    }];
    const userContent = [
      { type: "text" as const, text: "match this layout" },
      { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "cG5n" } },
    ];
    try {
      const task = manager.submit("chat-1", "cli", "match the attached layout", {
        attachments,
        userContent: userContent as any,
        forceSharedPlanning: true,
      });

      manager.block(task.id, "Transient failure — provider blink.");
      const retry = manager.retryTask(task.id);
      expect(retry).not.toBeNull();

      const enqueued = executor.enqueue.mock.calls[1]?.[0] as Task;
      expect(enqueued.id).toBe(retry!.id);
      // The rich input the plan was built FROM survives the round-trip…
      expect(enqueued.attachments).toHaveLength(1);
      expect(enqueued.attachments![0]!.name).toBe("layout.png");
      expect(enqueued.attachments![0]!.mimeType).toBe("image/png");
      expect(enqueued.attachments![0]!.data?.toString("utf8")).toBe("png-bytes");
      expect(enqueued.userContent).toEqual(userContent);
      // …and so does the routing decision that input forced.
      expect(enqueued.forceSharedPlanning).toBe(true);
      // The retry's own row carries it for the round after it.
      expect(storage.load(retry!.id)?.forceSharedPlanning).toBe(true);
      expect(storage.load(retry!.id)?.attachments).toHaveLength(1);
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a paused rich-input task keeps forceSharedPlanning across resume too", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-manager-resume-rich-"));
    const storage = new TaskStorage(join(dir, "tasks.db"));
    storage.initialize();
    const executor = { enqueue: vi.fn(), resumeConversation: vi.fn(), pauseConversation: vi.fn() } as any;
    const manager = new TaskManager(storage, executor);
    try {
      const task = manager.submit("chat-1", "cli", "match the attached layout", {
        forceSharedPlanning: true,
      });
      manager.updateStatus(task.id, TaskStatus.executing);
      expect(manager.pauseTask(task.id)).toBe(true);
      const resumed = manager.resumeTask(task.id);
      expect(resumed).not.toBeNull();

      const enqueued = executor.enqueue.mock.calls[1]?.[0] as Task;
      expect(enqueued.id).toBe(resumed!.id);
      expect(enqueued.forceSharedPlanning).toBe(true);
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
