import { beforeAll, describe, expect, it, vi } from "vitest";
import { SYSTEM_INTERRUPTION_MARKER, systemInterrupted } from "./interruption.js";
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
    // STAMPED as the system's own interruption: a downstream reader exempts
    // this from its budgets, and it used to decide that by looking for the
    // word "shutdown" in the task's output (Codex 2026-09-12 AD#14).
    expect(storage.updateBlocked).toHaveBeenCalledWith(activeTask.id, `${SYSTEM_INTERRUPTION_MARKER} Shutdown cleanup.`);
    expect(systemInterrupted(String((storage.updateBlocked as ReturnType<typeof vi.fn>).mock.calls[0]![1]))).toBe(true);
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
      // complete() refuses to overwrite a terminal state now (Codex
      // 2026-09-12 S#3), so the stub answers what an executing task looks
      // like.
      load: vi.fn().mockReturnValue({ id: "task_reasoning123", status: "executing" }),
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

  // TSK-12: this count runs on every heartbeat tick (per trigger) and every
  // scheduling pass; it loaded every incomplete row's whole progress history.
  it("counts foreground work without loading progress history, and prunes history at boot", () => {
    const storage = {
      loadIncomplete: vi.fn().mockReturnValue([]),
      pruneHistory: vi.fn().mockReturnValue({ tasks: 0, progress: 0 }),
    } as any;
    const manager = new TaskManager(storage, {} as any);

    manager.countActiveForegroundTasks();
    expect(storage.loadIncomplete).toHaveBeenCalledWith({ withProgress: false });

    manager.recoverOnStartup();
    expect(storage.pruneHistory).toHaveBeenCalledTimes(1);
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

  it("a retry keeps serving the same campaign, so its spend is still attributed (round 11 #4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-manager-campaign-"));
    const storage = new TaskStorage(join(dir, "tasks.db"));
    storage.initialize();
    const executor = { enqueue: vi.fn(), resumeConversation: vi.fn() } as any;
    const manager = new TaskManager(storage, executor);
    try {
      const task = manager.submit("chat-1", "cli", "a campaign milestone", { campaignId: "camp_7" });
      expect(storage.load(task.id)?.campaignId).toBe("camp_7");
      manager.block(task.id, "Transient failure — provider blink.");
      const retry = manager.retryTask(task.id);
      expect(retry).not.toBeNull();
      // The continuation charges the same campaign; losing this reported a
      // partial total as if it were the whole.
      expect(retry!.campaignId).toBe("camp_7");
      expect(storage.load(retry!.id)?.campaignId).toBe("camp_7");
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
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
      markCancelled: vi.fn(),
    } as any;
    const executor = { resumeConversation: vi.fn() } as any;
    const manager = new TaskManager(storage, executor);

    const cancelled = manager.cancel("task_paused1" as Task["id"]);

    expect(cancelled).toBe(true);
    expect(executor.resumeConversation).toHaveBeenCalledTimes(1);
    expect(storage.markCancelled).toHaveBeenCalledWith("task_paused1", undefined);
  });

  it("a deliberate cancel of a terminal row EMITS the stop, and an unmarked row can be upgraded (Codex 2026-09-11 L#1, L#6)", () => {
    // The upgrade persisted the reason and emitted nothing, so a campaign
    // watching for the stop never saw one and its milestone carried on (L#1).
    const superseded = buildTask({
      id: "task_sup2" as Task["id"], status: TaskStatus.cancelled, cancelReason: "superseded",
      chatId: "chat-x", channelType: "cli",
    });
    const storage = { load: vi.fn().mockReturnValue(superseded), updateStatus: vi.fn(), markCancelled: vi.fn() } as any;
    const manager = new TaskManager(storage, { resumeConversation: vi.fn() } as any);
    const stops: string[] = [];
    manager.on("task:cancelled", (id: string) => stops.push(id));

    expect(manager.cancel("task_sup2" as Task["id"], { reason: "user" })).toBe(true);
    expect(stops).toEqual(["task_sup2"]);

    // A row cancelled with NO reason — an older version, or the executor's own
    // cancel — can be upgraded the same way; refusing it left a person's stop
    // with no record anywhere (L#6).
    const unmarked = buildTask({
      id: "task_legacy" as Task["id"], status: TaskStatus.cancelled, chatId: "chat-x", channelType: "cli",
    });
    const legacyStorage = { load: vi.fn().mockReturnValue(unmarked), updateStatus: vi.fn(), markCancelled: vi.fn() } as any;
    const legacyManager = new TaskManager(legacyStorage, { resumeConversation: vi.fn() } as any);
    const legacyStops: string[] = [];
    legacyManager.on("task:cancelled", (id: string) => legacyStops.push(id));

    expect(legacyManager.cancel("task_legacy" as Task["id"], { reason: "user" })).toBe(true);
    expect(legacyStorage.markCancelled).toHaveBeenCalledWith("task_legacy", "user");
    expect(legacyStops).toEqual(["task_legacy"]);

    // …and an automatic retirement of the same row still changes nothing.
    legacyStorage.markCancelled.mockClear();
    expect(legacyManager.cancel("task_legacy" as Task["id"], { reason: "superseded" })).toBe(false);
    expect(legacyStorage.markCancelled).not.toHaveBeenCalled();
  });

  it("a deliberate cancel WITHDRAWS a supersession, and leaves other terminal rows alone (Codex 2026-09-11 J#3)", () => {
    // "superseded" says "replaced, carry on", and a person cancelling that
    // task means stop. Writing nothing left the stop with no record, so the
    // campaign's revival read the supersession and continued.
    const superseded = buildTask({
      id: "task_sup" as Task["id"],
      status: TaskStatus.cancelled,
      cancelReason: "superseded",
      chatId: "chat-x",
      channelType: "cli",
    });
    const storage = { load: vi.fn().mockReturnValue(superseded), updateStatus: vi.fn(), markCancelled: vi.fn() } as any;
    const manager = new TaskManager(storage, { resumeConversation: vi.fn() } as any);
    // A PERSON's cancel withdraws it and says who did it (Codex K#6).
    expect(manager.cancel("task_sup" as Task["id"], { reason: "user" })).toBe(true);
    expect(storage.markCancelled).toHaveBeenCalledWith("task_sup", "user");

    // The campaign's own supersession of an already-superseded row changes
    // nothing, and neither does an automatic retirement with no reason.
    storage.markCancelled.mockClear();
    expect(manager.cancel("task_sup" as Task["id"], { reason: "superseded" })).toBe(false);
    expect(manager.cancel("task_sup" as Task["id"])).toBe(false);
    expect(storage.markCancelled).not.toHaveBeenCalled();

    // A completed task is still left alone.
    const done = buildTask({ id: "task_done" as Task["id"], status: TaskStatus.completed, chatId: "chat-x", channelType: "cli" });
    const doneStorage = { load: vi.fn().mockReturnValue(done), updateStatus: vi.fn(), markCancelled: vi.fn() } as any;
    const doneManager = new TaskManager(doneStorage, { resumeConversation: vi.fn() } as any);
    expect(doneManager.cancel("task_done" as Task["id"])).toBe(false);
    expect(doneStorage.markCancelled).not.toHaveBeenCalled();
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
    const manager = new TaskManager(storage, {} as any, goalStorage, Date.now() + 60_000);
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

  it("replays the nearest non-replay ancestor's prompt, not the stale lineage root's", () => {
    // Measured 2026-09-08 04:18: a campaign lineage 30 deep, every resubmission
    // a fresh prompt carrying the latest delivery gate; the replay quoted the
    // root — 29 sprints old, no gate.
    const root = buildTask({ id: "task_A" as Task["id"], status: TaskStatus.failed, prompt: "OLD ROOT PROMPT (no gate)" });
    const fresh = buildTask({ id: "task_B" as Task["id"], status: TaskStatus.failed, parentId: "task_A" as Task["id"], prompt: "FRESH PROMPT [DELIVERY GATE — latest measurement]" });
    const replay = buildTask({
      id: "task_C" as Task["id"],
      status: TaskStatus.failed,
      parentId: "task_B" as Task["id"],
      prompt: "Previous background execution was interrupted. Resume from the strongest checkpoint.\n\nOriginal request: OLD ROOT PROMPT (no gate)",
    });
    const byId: Record<string, Task> = { task_A: root, task_B: fresh, task_C: replay };
    const storage = {
      load: vi.fn((id: string) => byId[id] ?? null),
      findLineageRootId: vi.fn(() => "task_A"),
    } as any;
    const manager = new TaskManager(storage, {} as any);
    const submit = vi.spyOn(manager, "submit").mockReturnValue(null as any);

    manager.retryTask("task_C" as Task["id"]);

    expect(submit).toHaveBeenCalledTimes(1);
    const prompt = submit.mock.calls[0]![2];
    expect(prompt).toContain("Original request: FRESH PROMPT [DELIVERY GATE — latest measurement]");
    expect(prompt).not.toContain("OLD ROOT PROMPT");
    // A task that is not a replay quotes itself.
    submit.mockClear();
    manager.retryTask("task_B" as Task["id"]);
    expect(submit.mock.calls[0]![2]).toContain("Original request: FRESH PROMPT");
  });

  it("leaves a task submitted by this process alone — it is live, not interrupted", () => {
    // Measured 2026-09-08 04:18: the campaign submitted attempt 2 sixteen
    // seconds before recovery ran; recovery paused it and the campaign then
    // replayed it with a prompt that had lost the delivery gate block.
    const bootedAt = 1_000_000;
    const liveTask = buildTask({
      id: "task_live" as Task["id"],
      status: TaskStatus.executing,
      origin: "user",
      createdAt: bootedAt + 9_000,
    });
    const oldTask = buildTask({
      id: "task_old" as Task["id"],
      status: TaskStatus.executing,
      origin: "user",
      createdAt: bootedAt - 60_000,
    });
    const storage = {
      loadIncomplete: vi.fn().mockReturnValue([liveTask, oldTask]),
      updateStatus: vi.fn(),
      updateError: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any, undefined, bootedAt);

    manager.recoverOnStartup();

    expect(storage.updateStatus).not.toHaveBeenCalledWith("task_live", expect.anything());
    expect(storage.updateError).not.toHaveBeenCalledWith("task_live", expect.anything());
    expect(storage.updateStatus).toHaveBeenCalledWith("task_old", TaskStatus.paused);
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
    const manager = new TaskManager(storage, {} as any, undefined, Date.now() + 60_000);

    manager.recoverOnStartup();

    expect(status).toBe(TaskStatus.paused);
    // …and the reason is STAMPED as the system's own interruption, so a
    // reader does not have to recognise the sentence (Codex 2026-09-12 AD#14).
    expect(systemInterrupted(String((storage.updateError as ReturnType<typeof vi.fn>).mock.calls[0]![1]))).toBe(true);
  });

  it("a DAEMON task interrupted by a restart is failed with the system marker", () => {
    // The daemon recreates its own work; the row must still say WHO stopped
    // it, because a downstream reader exempts a system interruption from its
    // budgets (Codex 2026-09-12 AD#14).
    const daemonTask = buildTask({ id: "task_daemon1" as Task["id"], status: TaskStatus.executing, origin: "daemon" });
    const storage = {
      loadIncomplete: vi.fn().mockReturnValue([daemonTask]),
      updateStatus: vi.fn(),
      updateError: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any, undefined, Date.now() + 60_000);

    manager.recoverOnStartup();

    const reason = String((storage.updateError as ReturnType<typeof vi.fn>).mock.calls[0]![1]);
    expect(systemInterrupted(reason)).toBe(true);
    expect(reason).toContain("system restart");
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

describe("a task a restart PAUSED can be resumed (measured live 2026-09-11 21:12:53)", () => {
  it("resumes a paused goal root, and refuses one that is still running or done", () => {
    const paused = buildTask({
      id: "task_p" as Task["id"], status: TaskStatus.paused, goalRootId: "goal_root",
      chatId: "chat-x", channelType: "cli", prompt: "Mission: finish the thing",
    });
    const storage = {
      load: vi.fn().mockReturnValue(paused),
      findLatestByGoalRoot: vi.fn().mockReturnValue(paused),
      save: vi.fn(),
      updateStatus: vi.fn(),
      markCancelled: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, { resumeConversation: vi.fn(), enqueue: vi.fn(), schedule: vi.fn() } as any);
    // `paused` sits in ACTIVE_STATUSES, and this guard used to refuse the very
    // task the caller had asked to resume.
    expect(manager.resumeGoalRoot("goal_root")).not.toBeNull();

    for (const status of [TaskStatus.executing, TaskStatus.planning, TaskStatus.pending, TaskStatus.completed]) {
      storage.findLatestByGoalRoot.mockReturnValue(buildTask({ ...paused, status } as never));
      expect(manager.resumeGoalRoot("goal_root")).toBeNull();
    }
  });
});

describe("one bad listener does not silence the others (Codex 2026-09-12 T#9)", () => {
  beforeAll(() => {
    try { createLogger("error", "/tmp/strada-task-manager-test.log"); } catch { /* already initialized */ }
  });

  it("delivers the terminal event to every subscriber", () => {
    const storage = {
      load: vi.fn().mockReturnValue({ id: "task_l", status: "executing" }),
      updateResult: vi.fn(),
      updateError: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);
    const heard: string[] = [];
    manager.on("task:completed", () => { throw new Error("the campaign handler blew up"); });
    manager.on("task:completed", () => { heard.push("second"); });
    manager.once("task:completed", () => { heard.push("once"); });

    manager.complete("task_l" as Task["id"], "done");

    // The throw used to stop the rest, and the retry could not help: the task
    // was already stored as completed, so the terminal guard refused to write
    // again and the later subscribers never heard anything.
    expect(heard).toEqual(["second", "once"]);

    // `once` still means once.
    storage.load.mockReturnValue({ id: "task_l2", status: "executing" });
    heard.length = 0;
    manager.complete("task_l2" as Task["id"], "done again");
    expect(heard).toEqual(["second"]);
  });

  it("stores and emits a long final answer whole, with secrets redacted (SEC-3)", () => {
    // complete() ran the answer through the 8 KB display cap before storing it.
    const storage = {
      load: vi.fn().mockReturnValue({ id: "task_long", status: "executing" }),
      updateResult: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);
    const key = "sk-proj-abc123DEF456ghi789JKL012mno345PQR678stu901VWX234";
    const answer = `${"All tests pass.\n".repeat(1000)}key was ${key}`;
    let emitted = "";
    manager.on("task:completed", (_id: unknown, result: string) => { emitted = result; });

    manager.complete("task_long" as Task["id"], answer);

    const stored = storage.updateResult.mock.calls[0]![1] as string;
    expect(stored.startsWith("All tests pass.\n".repeat(1000))).toBe(true);
    expect(stored).not.toContain(key);
    expect(stored).not.toContain("(truncated)");
    expect(emitted).toBe(stored);
  });

  it("calls each listener with the emitter as `this` (Codex 2026-09-12 U#F12)", () => {
    // rawListeners hands back the bare functions, and calling them bare loses
    // the binding EventEmitter gives: a normal-function subscriber saw
    // `this === undefined` for terminal events and for those alone.
    const storage = {
      load: vi.fn().mockReturnValue({ id: "task_b", status: "executing" }),
      updateResult: vi.fn(),
      updateError: vi.fn(),
      addProgress: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);
    const bound: unknown[] = [];
    manager.on("task:completed", function (this: unknown) { bound.push(this); });
    // A progress event goes through EventEmitter's own emit; both must agree.
    manager.on("task:progress", function (this: unknown) { bound.push(this); });

    manager.complete("task_b" as Task["id"], "done");
    manager.addProgress("task_b" as Task["id"], "half way" as never);

    expect(bound).toEqual([manager, manager]);
  });

  it("does the same for a failure", () => {
    const storage = {
      load: vi.fn().mockReturnValue({ id: "task_f", status: "executing" }),
      updateError: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);
    const heard: string[] = [];
    manager.on("task:failed", () => { throw new Error("boom"); });
    manager.on("task:failed", () => { heard.push("second"); });

    manager.fail("task_f" as Task["id"], "it broke");

    expect(heard).toEqual(["second"]);
  });
});

describe("settlement is a conditional transition (Codex 2026-09-12 S#3)", () => {
  it("does not overwrite a cancel, and does not complete twice", () => {
    const settled: string[] = [];
    const storage = {
      load: vi.fn().mockReturnValue({ id: "task_c", status: "cancelled" }),
      updateResult: vi.fn(() => { settled.push("result"); }),
    } as any;
    const manager = new TaskManager(storage, {} as any);
    manager.on("task:completed", () => { settled.push("emitted"); });

    manager.complete("task_c" as Task["id"], "the work finished after the cancel");

    // A cancelled task stays cancelled: nothing written, nothing emitted.
    expect(settled).toEqual([]);

    // …and a task that is already COMPLETED is not completed a second time,
    // which is what a throwing listener used to cause.
    storage.load.mockReturnValue({ id: "task_c", status: "completed" });
    manager.complete("task_c" as Task["id"], "again");
    expect(settled).toEqual([]);

    // An executing task settles normally.
    storage.load.mockReturnValue({ id: "task_c", status: "executing" });
    manager.complete("task_c" as Task["id"], "done");
    expect(settled).toEqual(["result", "emitted"]);
  });
});

describe("a resumed paused task is retired, so a restart does not replay it (TSK-2)", () => {
  beforeAll(() => {
    try { createLogger("error", "/tmp/strada-task-manager-test.log"); } catch { /* already initialized */ }
  });

  // Each step a second apart, as a real lineage is: a continuation is always
  // newer than the row it continues.
  function withStorage(run: (storage: TaskStorage, step: () => void) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "task-manager-resume-retire-"));
    const storage = new TaskStorage(join(dir, "tasks.db"));
    storage.initialize();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
    const step = (): void => { vi.setSystemTime(Date.now() + 1_000); };
    try {
      run(storage, step);
    } finally {
      vi.useRealTimers();
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const makeExecutor = () => ({ enqueue: vi.fn(), resumeConversation: vi.fn(), pauseConversation: vi.fn() }) as any;

  it("crash, resume on boot 2, child completes: boot 3 submits nothing", () => {
    withStorage((storage, step) => {
      // Boot 1: the mission is executing when the process dies.
      const boot1 = new TaskManager(storage, makeExecutor(), undefined, Date.now() - 60_000);
      const a = boot1.submit("chat-1", "cli", "ship the feature");
      boot1.updateStatus(a.id, TaskStatus.executing);

      // Boot 2: recovery pauses it, the restart re-arm resumes it, the child finishes.
      step();
      const boot2 = new TaskManager(storage, makeExecutor(), undefined, Date.now());
      boot2.recoverOnStartup();
      step();
      expect(boot2.listPausedByRestart().map((t) => t.id)).toEqual([a.id]);
      const b = boot2.resumeTask(a.id);
      expect(b).not.toBeNull();
      expect(storage.load(a.id)?.status).toBe(TaskStatus.cancelled);
      expect(storage.load(a.id)?.cancelReason).toBe("superseded");
      boot2.updateStatus(b!.id, TaskStatus.executing);
      boot2.complete(b!.id, "done");

      // Boot 3: nothing is paused, nothing is resubmitted.
      step();
      const exec3 = makeExecutor();
      const boot3 = new TaskManager(storage, exec3, undefined, Date.now());
      boot3.recoverOnStartup();
      expect(boot3.listPausedByRestart()).toEqual([]);
      expect(boot3.resumeTask(a.id)).toBeNull();
      expect(exec3.enqueue).not.toHaveBeenCalled();
      expect(storage.listActiveByChatId("chat-1")).toEqual([]);
    });
  });

  it("heals a paused row an older version left behind after its continuation completed", () => {
    withStorage((storage, step) => {
      const manager = new TaskManager(storage, makeExecutor(), undefined, Date.now() - 60_000);
      const a = manager.submit("chat-1", "cli", "ship the feature");
      step();
      // What the old resumeTask left: a child that completed, a parent still paused.
      const b = manager.submit("chat-1", "cli", "resume: ship the feature", { parentId: a.id });
      manager.updateStatus(b.id, TaskStatus.executing);
      manager.complete(b.id, "done");
      storage.updateError(a.id, "Task interrupted by system restart.");
      storage.updateStatus(a.id, TaskStatus.paused);

      step();
      const exec = makeExecutor();
      const nextBoot = new TaskManager(storage, exec, undefined, Date.now());
      nextBoot.recoverOnStartup();
      expect(storage.load(a.id)?.status).toBe(TaskStatus.cancelled);
      expect(nextBoot.listPausedByRestart()).toEqual([]);
      expect(nextBoot.resumeTask(a.id)).toBeNull();
      expect(exec.enqueue).not.toHaveBeenCalled();
    });
  });

  it("/pause then resume leaves only the continuation active", () => {
    withStorage((storage, step) => {
      const manager = new TaskManager(storage, makeExecutor());
      const a = manager.submit("chat-1", "cli", "ship the feature");
      manager.updateStatus(a.id, TaskStatus.executing);
      expect(manager.pauseTask(a.id)).toBe(true);
      step();
      const b = manager.resumeTask(a.id);
      expect(b).not.toBeNull();
      expect(storage.listActiveByChatId("chat-1").map((t) => t.id)).toEqual([b!.id]);
    });
  });

  it("a goal-backed resume retires the parent and keeps the continuation the goal root's latest task", () => {
    withStorage((storage, step) => {
      const goalStorage = { getTree: () => makeGoalTree(), updateTreeStatus: vi.fn() } as any;
      const manager = new TaskManager(storage, makeExecutor(), goalStorage);
      const a = manager.submit("chat-1", "cli", "Repair the pipeline", { goalRootId: "goal_root" });
      manager.updateStatus(a.id, TaskStatus.paused);
      step();
      const b = manager.resumeTask(a.id);
      expect(b).not.toBeNull();
      expect(storage.load(a.id)?.status).toBe(TaskStatus.cancelled);
      expect(storage.findLatestByGoalRoot("goal_root")?.id).toBe(b!.id);
    });
  });

  it("leaves the parent resumable when the queue refused the continuation", () => {
    withStorage((storage) => {
      const executor = makeExecutor();
      const manager = new TaskManager(storage, executor);
      const a = manager.submit("chat-1", "cli", "ship the feature");
      manager.updateStatus(a.id, TaskStatus.paused);
      executor.enqueue.mockImplementation((task: Task) => {
        storage.updateError(task.id, "Task queue full");
        throw new Error("Task queue full");
      });
      manager.resumeTask(a.id);
      expect(storage.load(a.id)?.status).toBe(TaskStatus.paused);
    });
  });
});

// TSK-14: pauseTask wrote `touchedFiles: []` over the rolling checkpoint
// (same task_id, upserted), so the resume replay lost the files the run had
// already changed; and the save's rejection was never caught.
describe("pauseTask keeps the rolling checkpoint's files (TSK-14)", () => {
  beforeAll(() => {
    try { createLogger("error", "/tmp/strada-task-manager-test.log"); } catch { /* already initialized */ }
  });

  it("merges with the existing checkpoint instead of clobbering its touched files", async () => {
    const running = buildTask({ id: "task_pause1" as Task["id"], status: TaskStatus.executing });
    const storage = { load: vi.fn().mockReturnValue(running), updateStatus: vi.fn() } as any;
    const executor = { pauseConversation: vi.fn() } as any;
    const manager = new TaskManager(storage, executor);
    const save = vi.fn().mockRejectedValue(new Error("disk full"));
    manager.setCheckpointStore({
      loadByTaskIdSync: vi.fn().mockReturnValue({
        taskId: "task_pause1", chatId: "chat-1", timestamp: 1, stage: "tool_error",
        lastUserMessage: "test prompt", touchedFiles: ["Assets/Scripts/Board.cs"],
      }),
      save,
    } as any);

    expect(manager.pauseTask(running.id)).toBe(true);
    await Promise.resolve();

    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      stage: "manual_pause",
      touchedFiles: ["Assets/Scripts/Board.cs"],
    }));
  });
});
