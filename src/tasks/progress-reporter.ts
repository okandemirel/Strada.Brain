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
  private readonly throttleMs: number;

  constructor(
    private readonly channel: IChannelSender,
    taskManager: TaskManager,
    throttleMs = 10_000,
  ) {
    this.throttleMs = throttleMs;
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
    const msg = `⏳ Task accepted: *${escapeMarkdown(task.title)}*\nID: \`${task.id}\`\nUse /status to check progress.`;
    this.sendToChannel(task.chatId, msg);
  }

  private reportProgress(task: Task, message: string): void {
    if (!this.shouldThrottle(task.id)) {
      return;
    }

    const msg = `⚙️ \`${task.id}\`: ${escapeMarkdown(message)}`;
    this.sendToChannel(task.chatId, msg);
  }

  private reportCompleted(task: Task, result: string): void {
    this.lastUpdate.delete(task.id);
    const elapsed = this.formatDuration(Date.now() - task.createdAt);
    const truncatedResult =
      result.length > 1000 ? result.slice(0, 1000) + "\n...(truncated)" : result;
    const msg = `✅ Task completed (${elapsed})\n\`${task.id}\`: *${escapeMarkdown(task.title)}*\n\n${truncatedResult}`;
    this.sendToChannel(task.chatId, msg);
  }

  private reportFailed(task: Task, error: string): void {
    this.lastUpdate.delete(task.id);
    const msg = `❌ Task failed\n\`${task.id}\`: *${escapeMarkdown(task.title)}*\nError: ${escapeMarkdown(error.slice(0, 300))}`;
    this.sendToChannel(task.chatId, msg);
  }

  private reportCancelled(task: Task): void {
    this.lastUpdate.delete(task.id);
    const msg = `🚫 Task cancelled: \`${task.id}\``;
    this.sendToChannel(task.chatId, msg);
  }

  /**
   * Returns true if enough time has passed to send another update.
   * Records the timestamp for throttling.
   */
  private shouldThrottle(taskId: TaskId): boolean {
    const now = Date.now();
    const last = this.lastUpdate.get(taskId) ?? 0;

    if (now - last < this.throttleMs) {
      return false;
    }

    this.lastUpdate.set(taskId, now);
    return true;
  }

  private sendToChannel(chatId: string, message: string): void {
    this.channel.sendMarkdown(chatId, message).catch((err) => {
      getLogger().error("Failed to send progress update", {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private formatDuration(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3600_000)}h`;
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}
