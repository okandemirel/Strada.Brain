/**
 * Progress Reporter
 *
 * Proactive channel updates for task progress.
 * Throttled to max 1 update per 10 seconds per task.
 */

import type { IChannelSender } from "../channels/channel-core.interface.js";
import type { TaskManager } from "./task-manager.js";
import type { Task, TaskId } from "./types.js";
import { getLogger } from "../utils/logger.js";

export class ProgressReporter {
  private readonly lastUpdate = new Map<TaskId, number>();

  constructor(
    private readonly channel: IChannelSender,
    taskManager: TaskManager,
    _throttleMs = 10_000,
  ) {
    this.setupListeners(taskManager);
  }

  private setupListeners(taskManager: TaskManager): void {
    taskManager.on("task:created", (task: Task) => {
      this.reportCreated(task);
    });

    taskManager.on("task:progress", (taskId: TaskId, message: string) => {
      const task = taskManager.getStatus(taskId);
      if (task) {
        this.reportProgress(task, message);
      }
    });

    taskManager.on("task:completed", (taskId: TaskId, result: string) => {
      const task = taskManager.getStatus(taskId);
      if (task) {
        this.reportCompleted(task, result);
      }
    });

    taskManager.on("task:failed", (taskId: TaskId, error: string) => {
      const task = taskManager.getStatus(taskId);
      if (task) {
        this.reportFailed(task, error);
      }
    });

    taskManager.on("task:cancelled", (taskId: TaskId) => {
      const task = taskManager.getStatus(taskId);
      if (task) {
        this.reportCancelled(task);
      }
    });
  }

  private reportCreated(_task: Task): void {
    // Suppressed — the typing indicator already signals processing.
    // The user sees only the final result when the task completes.
  }

  private reportProgress(_task: Task, _message: string): void {
    // Suppressed — tool execution details are internal implementation.
    // The user sees only task acceptance and the final result.
  }

  private reportCompleted(task: Task, result: string): void {
    this.lastUpdate.delete(task.id);
    // Send the full result — no truncation. The user wants complete responses.
    this.sendToChannel(task.chatId, result);
  }

  private reportFailed(_task: Task, _error: string): void {
    this.lastUpdate.delete(_task.id);
    // Send generic error — don't leak internal API errors to user
    this.sendToChannel(_task.chatId, "An error occurred while processing your request. Please try again.");
    getLogger().error("Task failed", { taskId: _task.id, error: _error });
  }

  private reportCancelled(_task: Task): void {
    this.lastUpdate.delete(_task.id);
    // Suppressed — cancellation is internal state
  }

  private sendToChannel(chatId: string, message: string): void {
    this.channel.sendMarkdown(chatId, message).catch((err) => {
      getLogger().error("Failed to send progress update", {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
