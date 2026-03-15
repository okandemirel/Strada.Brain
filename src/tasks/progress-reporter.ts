/**
 * Progress Reporter
 *
 * Sends task completion and failure updates to the channel.
 * Created/progress/cancelled events are suppressed — the typing indicator
 * signals processing, and the user sees only the final result.
 */

import type { IChannelSender, IChannelRichMessaging } from "../channels/channel-core.interface.js";
import { supportsRichMessaging } from "../channels/channel-core.interface.js";
import type { TaskManager } from "./task-manager.js";
import type { Task, TaskId } from "./types.js";
import { getLogger } from "../utils/logger.js";
import { classifyTaskErrorMessage } from "../utils/error-messages.js";

export class ProgressReporter {
  constructor(
    private readonly channel: IChannelSender,
    taskManager: TaskManager,
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

  private reportCreated(task: Task): void {
    // Send typing indicator so user knows agent is working
    this.sendTyping(task.chatId);
  }

  private reportProgress(task: Task, _message: string): void {
    // Keep typing indicator alive during long tasks
    this.sendTyping(task.chatId);
  }

  private sendTyping(chatId: string): void {
    if (supportsRichMessaging(this.channel)) {
      (this.channel as IChannelRichMessaging).sendTypingIndicator(chatId).catch(() => {});
    }
  }

  private reportCompleted(task: Task, result: string): void {
    this.sendToChannel(task.chatId, result);
  }

  private reportFailed(task: Task, error: string): void {
    this.sendToChannel(task.chatId, classifyTaskErrorMessage(error));
    getLogger().error("Task failed", { taskId: task.id, error });
  }

  private reportCancelled(_task: Task): void {
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
