/**
 * Task Manager
 *
 * Business logic and state machine for task lifecycle.
 * Manages task creation, status transitions, cancellation,
 * and startup recovery.
 */

import { EventEmitter } from "node:events";
import type { Task, TaskId, TaskProgressUpdate } from "./types.js";
import { TaskStatus, ACTIVE_STATUSES, generateTaskId } from "./types.js";
import { getTaskProgressMessage } from "./progress-signals.js";
import type { TaskStorage } from "./task-storage.js";
import type { BackgroundExecutor } from "./background-executor.js";
import { getLogger } from "../utils/logger.js";
import type { TaskOrigin } from "../daemon/daemon-types.js";
import type { GoalTree } from "../goals/types.js";
import type { Orchestrator } from "../agents/orchestrator.js";

export class TaskManager extends EventEmitter {
  private readonly abortControllers = new Map<TaskId, AbortController>();

  constructor(
    private readonly storage: TaskStorage,
    private readonly executor: BackgroundExecutor,
  ) {
    super();
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
      attachments?: import("../channels/channel.interface.js").Attachment[];
      orchestrator?: Orchestrator;
      conversationId?: string;
      userId?: string;
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
      title: prompt.slice(0, 80),
      status: TaskStatus.pending,
      prompt,
      progress: [],
      createdAt: now,
      updatedAt: now,
      origin: options?.origin ?? "user",
      triggerName: options?.triggerName,
      goalTree: options?.goalTree,
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

  /**
   * Get current status of a task.
   */
  getStatus(taskId: TaskId): Task | null {
    return this.storage.load(taskId);
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
   * Add a progress entry to a task.
   */
  addProgress(taskId: TaskId, message: TaskProgressUpdate): void {
    this.storage.addProgress(taskId, getTaskProgressMessage(message));
    this.emit("task:progress", taskId, message);
  }

  /**
   * Mark a task as completed with result.
   */
  complete(taskId: TaskId, result: string): void {
    this.storage.updateResult(taskId, result);
    this.abortControllers.delete(taskId);
    this.emit("task:completed", taskId, result);
    getLogger().info("Task completed", { taskId, resultLength: result.length });
  }

  /**
   * Mark a task as failed with error.
   */
  fail(taskId: TaskId, error: string): void {
    this.storage.updateError(taskId, error);
    this.abortControllers.delete(taskId);
    this.emit("task:failed", taskId, error);
    getLogger().error("Task failed", { taskId, error });
  }

  /**
   * Mark a task as blocked with a checkpoint summary.
   */
  block(taskId: TaskId, result: string): void {
    this.storage.updateBlocked(taskId, result);
    this.abortControllers.delete(taskId);
    this.emit("task:blocked", taskId, result);
    getLogger().warn("Task blocked", { taskId, resultLength: result.length });
  }

  /**
   * Update task status.
   */
  updateStatus(taskId: TaskId, status: TaskStatus): void {
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
      this.storage.updateError(
        task.id,
        "Task interrupted by system restart. Please submit again.",
      );
      logger.warn("Task marked as failed on recovery", { taskId: task.id, previousStatus: task.status });
    }
  }
}
