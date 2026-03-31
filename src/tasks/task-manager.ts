/**
 * Task Manager
 *
 * Business logic and state machine for task lifecycle.
 * Manages task creation, status transitions, cancellation,
 * and startup recovery.
 */

import { EventEmitter } from "node:events";
import type { Task, TaskId, TaskProgressUpdate } from "./types.js";
import { TaskStatus, ACTIVE_STATUSES, TERMINAL_STATUSES, generateTaskId } from "./types.js";
import { getTaskProgressMessage, toTaskProgressSignal } from "./progress-signals.js";
import type { TaskStorage } from "./task-storage.js";
import type { BackgroundExecutor } from "./background-executor.js";
import { getLogger } from "../utils/logger.js";
import { sanitizeSecrets } from "../security/secret-sanitizer.js";
import type { TaskOrigin } from "../daemon/daemon-types.js";
import type { GoalTree } from "../goals/types.js";
import type { GoalNodeId } from "../goals/types.js";
import type { GoalStorage } from "../goals/goal-storage.js";
import { prepareTreeForResume, prepareTreeForRetry } from "../goals/goal-resume.js";
import type { Orchestrator } from "../agents/orchestrator.js";
import { stripVisibleProviderArtifacts } from "../agents/orchestrator-text-utils.js";
import type { MessageContent } from "../agents/providers/provider-core.interface.js";

export class TaskManager extends EventEmitter {
  private readonly abortControllers = new Map<TaskId, AbortController>();

  constructor(
    private readonly storage: TaskStorage,
    private readonly executor: BackgroundExecutor,
    private readonly goalStorage?: GoalStorage,
  ) {
    super();
    this.setMaxListeners(20);
  }

  /**
   * Submit a new task for background execution.
   *
   * @param options Optional settings. `origin` defaults to 'user'; daemon-initiated
   *   tasks pass `{ origin: 'daemon' }` for security policy enforcement.
   */
  submit(
    chatId: string,
    channelType: string,
    prompt: string,
    options?: {
      origin?: TaskOrigin;
      triggerName?: string;
      goalTree?: GoalTree;
      forceSharedPlanning?: boolean;
      userContent?: string | MessageContent[];
      attachments?: import("../channels/channel.interface.js").Attachment[];
      orchestrator?: Orchestrator;
      conversationId?: string;
      userId?: string;
      parentId?: TaskId;
      goalRootId?: string;
    },
  ): Task {
    const logger = getLogger();
    const now = Date.now();

    const task: Task = {
      id: generateTaskId(),
      chatId,
      channelType,
      conversationId: options?.conversationId,
      userId: options?.userId,
      goalRootId: options?.goalRootId,
      title: prompt.slice(0, 80),
      status: TaskStatus.pending,
      prompt,
      progress: [],
      createdAt: now,
      updatedAt: now,
      parentId: options?.parentId,
      origin: options?.origin ?? "user",
      triggerName: options?.triggerName,
      goalTree: options?.goalTree,
      forceSharedPlanning: options?.forceSharedPlanning,
      userContent: options?.userContent,
      attachments: options?.attachments,
      orchestrator: options?.orchestrator,
    };

    this.storage.save(task);
    logger.info("Task submitted", { taskId: task.id, chatId, promptLength: prompt.length });
    this.emit("task:created", task);

    // Enqueue for execution
    const ac = new AbortController();
    this.abortControllers.set(task.id, ac);

    this.executor.enqueue(task, ac.signal, (message: TaskProgressUpdate) => {
      this.addProgress(task.id, message);
    });

    return task;
  }

  attachGoalRoot(taskId: TaskId, goalRootId: string): void {
    this.storage.updateGoalRoot(taskId, goalRootId);
  }

  /**
   * Cancel a running task.
   */
  cancel(taskId: TaskId): boolean {
    const task = this.storage.load(taskId);
    if (!task || !ACTIVE_STATUSES.has(task.status)) {
      return false;
    }

    const ac = this.abortControllers.get(taskId);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(taskId);
    }

    this.storage.updateStatus(taskId, TaskStatus.cancelled);
    this.emit("task:cancelled", taskId);
    getLogger().info("Task cancelled", { taskId });
    return true;
  }

  cancelGoalRoot(goalRootId: string): boolean {
    const task = this.storage.findLatestByGoalRoot(goalRootId);
    if (!task) {
      return false;
    }
    return this.cancel(task.id);
  }

  /**
   * Get current status of a task.
   */
  getStatus(taskId: TaskId): Task | null {
    return this.storage.load(taskId);
  }

  retryTask(taskId: TaskId): Task | null {
    const task = this.storage.load(taskId);
    if (!task || ACTIVE_STATUSES.has(task.status) || task.status === TaskStatus.completed) {
      return null;
    }

    if (task.goalRootId) {
      return this.retryGoalRoot(task.goalRootId);
    }

    return this.submit(task.chatId, task.channelType, this.buildReplayPrompt(task, "retry"), {
      origin: task.origin ?? "user",
      triggerName: task.triggerName,
      conversationId: task.conversationId,
      userId: task.userId,
      orchestrator: task.orchestrator,
      userContent: task.userContent,
      attachments: task.attachments,
      parentId: task.id,
    });
  }

  resumeTask(taskId: TaskId): Task | null {
    const task = this.storage.load(taskId);
    if (!task || ACTIVE_STATUSES.has(task.status) || task.status === TaskStatus.completed) {
      return null;
    }

    if (task.goalRootId) {
      return this.resumeGoalRoot(task.goalRootId);
    }

    return this.submit(task.chatId, task.channelType, this.buildReplayPrompt(task, "resume"), {
      origin: task.origin ?? "user",
      triggerName: task.triggerName,
      conversationId: task.conversationId,
      userId: task.userId,
      orchestrator: task.orchestrator,
      userContent: task.userContent,
      attachments: task.attachments,
      parentId: task.id,
    });
  }

  retryGoalRoot(goalRootId: string, nodeId?: string): Task | null {
    const task = this.storage.findLatestByGoalRoot(goalRootId);
    if (!task || ACTIVE_STATUSES.has(task.status) || task.status === TaskStatus.completed) {
      return null;
    }
    const tree = this.goalStorage?.getTree(goalRootId as GoalNodeId);
    if (!tree) {
      return this.submit(task.chatId, task.channelType, this.buildReplayPrompt(task, "retry"), {
        origin: task.origin ?? "user",
        triggerName: task.triggerName,
        conversationId: task.conversationId,
        userId: task.userId,
        orchestrator: task.orchestrator,
        userContent: task.userContent,
        attachments: task.attachments,
        parentId: task.id,
      });
    }

    const replayTree = prepareTreeForRetry(tree, nodeId as GoalNodeId | undefined);
    return this.submit(task.chatId, task.channelType, task.prompt, {
      origin: task.origin ?? "user",
      triggerName: task.triggerName,
      goalTree: replayTree,
      goalRootId,
      forceSharedPlanning: true,
      userContent: task.userContent,
      attachments: task.attachments,
      orchestrator: task.orchestrator,
      conversationId: task.conversationId,
      userId: task.userId,
      parentId: task.id,
    });
  }

  resumeGoalRoot(goalRootId: string): Task | null {
    const task = this.storage.findLatestByGoalRoot(goalRootId);
    if (!task || ACTIVE_STATUSES.has(task.status) || task.status === TaskStatus.completed) {
      return null;
    }
    const tree = this.goalStorage?.getTree(goalRootId as GoalNodeId);
    if (!tree) {
      return this.submit(task.chatId, task.channelType, this.buildReplayPrompt(task, "resume"), {
        origin: task.origin ?? "user",
        triggerName: task.triggerName,
        conversationId: task.conversationId,
        userId: task.userId,
        orchestrator: task.orchestrator,
        userContent: task.userContent,
        attachments: task.attachments,
        parentId: task.id,
      });
    }

    const replayTree = task.status === TaskStatus.blocked
      ? prepareTreeForRetry(tree)
      : prepareTreeForResume(tree);
    return this.submit(task.chatId, task.channelType, task.prompt, {
      origin: task.origin ?? "user",
      triggerName: task.triggerName,
      goalTree: replayTree,
      goalRootId,
      forceSharedPlanning: true,
      userContent: task.userContent,
      attachments: task.attachments,
      orchestrator: task.orchestrator,
      conversationId: task.conversationId,
      userId: task.userId,
      parentId: task.id,
    });
  }

  /**
   * List recent tasks for a chat (active + recent completed).
   */
  listTasks(chatId: string, limit = 10): Task[] {
    return this.storage.listByChatId(chatId, limit);
  }

  /**
   * List only active tasks for a chat.
   */
  listActiveTasks(chatId: string): Task[] {
    return this.storage.listActiveByChatId(chatId);
  }

  /**
   * List all currently active tasks, newest first.
   */
  listAllActiveTasks(): Task[] {
    return this.storage.loadIncomplete();
  }

  listRecoverableTasks(limit = 20): Task[] {
    return this.storage
      .listRecoverable(limit)
      .filter((task) => task.channelType !== "daemon");
  }

  /**
   * Count active user-facing tasks across chats.
   * Daemon-internal tasks are excluded so control-plane observers do not
   * mistake their own background work for a foreground user session.
   */
  countActiveForegroundTasks(excludedChatIds: readonly string[] = []): number {
    const excluded = new Set(excludedChatIds);
    return this.storage.loadIncomplete().filter((task) =>
      task.channelType !== "daemon" && !excluded.has(task.chatId)
    ).length;
  }

  /**
   * Check whether any foreground user task is currently active.
   */
  hasActiveForegroundTasks(excludedChatIds: readonly string[] = []): boolean {
    return this.countActiveForegroundTasks(excludedChatIds) > 0;
  }

  /**
   * Add a progress entry to a task.
   */
  addProgress(taskId: TaskId, message: TaskProgressUpdate): void {
    const signal = toTaskProgressSignal(message);
    this.storage.addProgress(taskId, signal.userSummary?.trim() || getTaskProgressMessage(message));
    this.emit("task:progress", taskId, message);
  }

  /**
   * Mark a task as completed with result.
   */
  complete(taskId: TaskId, result: string): void {
    const sanitizedResult = sanitizeSecrets(stripVisibleProviderArtifacts(result));
    this.storage.updateResult(taskId, sanitizedResult);
    this.abortControllers.delete(taskId);
    this.emit("task:completed", taskId, sanitizedResult);
    getLogger().info("Task completed", { taskId, resultLength: sanitizedResult.length });
  }

  /**
   * Mark a task as failed with error.
   */
  fail(taskId: TaskId, error: string): void {
    const sanitizedError = sanitizeSecrets(error);
    this.storage.updateError(taskId, sanitizedError);
    this.abortControllers.delete(taskId);
    this.emit("task:failed", taskId, sanitizedError);
    getLogger().error("Task failed", { taskId, error: sanitizedError });
  }

  /**
   * Mark a task as blocked with a checkpoint summary.
   */
  block(taskId: TaskId, result: string): void {
    const sanitizedResult = sanitizeSecrets(stripVisibleProviderArtifacts(result));
    this.storage.updateBlocked(taskId, sanitizedResult);
    this.abortControllers.delete(taskId);
    this.emit("task:blocked", taskId, sanitizedResult);
    getLogger().warn("Task blocked", { taskId, resultLength: sanitizedResult.length });
  }

  /**
   * Update task status.
   */
  updateStatus(taskId: TaskId, status: TaskStatus): void {
    const task = this.storage.load(taskId);
    if (task && TERMINAL_STATUSES.has(task.status)) {
      return;
    }
    this.storage.updateStatus(taskId, status);
    this.emit("task:status", taskId, status);
  }

  /**
   * Recover incomplete tasks on startup.
   * Marks them as failed since we can't resume LLM conversations.
   */
  recoverOnStartup(): void {
    const logger = getLogger();
    const incomplete = this.storage.loadIncomplete();

    if (incomplete.length === 0) return;

    logger.info("Recovering incomplete tasks on startup", { count: incomplete.length });

    for (const task of incomplete) {
      if (task.origin === "daemon") {
        this.storage.updateError(
          task.id,
          "Task interrupted by system restart. The daemon will recreate it if still needed.",
        );
        if (task.goalRootId && this.goalStorage) {
          this.goalStorage.updateTreeStatus(task.goalRootId as GoalNodeId, "failed");
        }
        logger.warn("Task marked as failed on recovery", { taskId: task.id, previousStatus: task.status });
        continue;
      }

      const blockedReason = task.goalRootId
        ? "Task interrupted by system restart. Resume is available from the monitor and will continue from the saved plan."
        : "Task interrupted by system restart. Resume is available and will continue from the strongest checkpoint.";
      this.storage.updateBlocked(task.id, blockedReason);
      if (task.goalRootId && this.goalStorage) {
        this.goalStorage.updateTreeStatus(task.goalRootId as GoalNodeId, "blocked");
      }
      this.emit("task:blocked", task.id, blockedReason);
      logger.warn("Task marked as blocked on recovery", {
        taskId: task.id,
        previousStatus: task.status,
        recoverable: true,
      });
    }
  }

  /**
   * Fail active tasks during graceful shutdown so they do not remain
   * executing until a later startup recovery pass.
   */
  failActiveTasksOnShutdown(reason = "Task interrupted by system shutdown. Resume is available after restart."): void {
    const logger = getLogger();
    const activeTasks = this.storage.loadIncomplete();

    if (activeTasks.length === 0) return;

    logger.info("Failing active tasks on shutdown", { count: activeTasks.length });

    for (const task of activeTasks) {
      const ac = this.abortControllers.get(task.id);
      if (ac) {
        ac.abort();
        this.abortControllers.delete(task.id);
      }

      if (task.origin === "daemon") {
        this.storage.updateError(task.id, reason);
        if (task.goalRootId && this.goalStorage) {
          this.goalStorage.updateTreeStatus(task.goalRootId as GoalNodeId, "failed");
        }
        this.emit("task:failed", task.id, reason);
        logger.warn("Task marked as failed on shutdown", {
          taskId: task.id,
          previousStatus: task.status,
          recoverable: false,
        });
        continue;
      }

      this.storage.updateBlocked(task.id, reason);
      if (task.goalRootId && this.goalStorage) {
        this.goalStorage.updateTreeStatus(task.goalRootId as GoalNodeId, "blocked");
      }
      this.emit("task:blocked", task.id, reason);
      logger.warn("Task marked as blocked on shutdown", {
        taskId: task.id,
        previousStatus: task.status,
        recoverable: true,
      });
    }
  }

  private buildReplayPrompt(task: Task, mode: "retry" | "resume"): string {
    const preface = mode === "resume"
      ? "Previous background execution was interrupted. Resume from the strongest checkpoint, preserve completed work, and only redo what is necessary."
      : "Previous background execution failed or stalled. First analyze the failure cause briefly, then continue from the strongest checkpoint instead of restarting blindly.";
    const lines = [preface, "", `Original request: ${task.prompt}`];

    if (task.result) {
      lines.push("", `Last known checkpoint:\n${task.result}`);
    }
    if (task.error) {
      lines.push("", `Last known failure:\n${sanitizeSecrets(task.error)}`);
    }

    return lines.join("\n");
  }
}
