/**
 * Progress Reporter
 *
 * Sends task completion and failure updates to the channel.
 * Created/progress/cancelled events are suppressed — the typing indicator
 * signals processing, and the user sees only the final result plus sparse
 * long-running heartbeats when silent-first execution is enabled.
 */

import type { IChannelAdapter, IChannelRichMessaging } from "../channels/channel.interface.js";
import { supportsRichMessaging } from "../channels/channel-core.interface.js";
import { DEFAULT_INTERACTION_CONFIG, type InteractionConfig } from "../config/config.js";
import type { TaskManager } from "./task-manager.js";
import type { Task, TaskId } from "./types.js";
import { getLogger } from "../utils/logger.js";
import { classifyTaskErrorMessage } from "../utils/error-messages.js";

interface HeartbeatState {
  timeoutId?: ReturnType<typeof setTimeout>;
  intervalId?: ReturnType<typeof setInterval>;
}

function unrefTimer(timer: { unref?: () => void }): void {
  timer.unref?.();
}

export class ProgressReporter {
  private readonly interaction: InteractionConfig;
  private readonly heartbeats = new Map<TaskId, HeartbeatState>();

  constructor(
    private readonly channel: IChannelAdapter,
    taskManager: TaskManager,
    interaction: InteractionConfig = DEFAULT_INTERACTION_CONFIG,
  ) {
    this.interaction = interaction;
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
    this.scheduleHeartbeat(task);
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
    this.clearHeartbeat(task.id);
    this.sendToChannel(task.chatId, result);
  }

  private reportFailed(task: Task, error: string): void {
    this.clearHeartbeat(task.id);
    this.sendToChannel(task.chatId, classifyTaskErrorMessage(error));
    getLogger().error("Task failed", { taskId: task.id, error });
  }

  private reportCancelled(task: Task): void {
    this.clearHeartbeat(task.id);
    // Suppressed — cancellation is internal state
  }

  private scheduleHeartbeat(task: Task): void {
    this.clearHeartbeat(task.id);

    if (this.interaction.mode !== "silent-first" || this.interaction.heartbeatAfterMs <= 0) {
      return;
    }

    const state: HeartbeatState = {};
    const timeoutId = setTimeout(() => {
      this.sendHeartbeat(task);

      if (this.interaction.heartbeatIntervalMs > 0) {
        const intervalId = setInterval(() => {
          this.sendHeartbeat(task);
        }, this.interaction.heartbeatIntervalMs);
        unrefTimer(intervalId);
        const current = this.heartbeats.get(task.id);
        if (current) {
          current.intervalId = intervalId;
        }
      }
    }, this.interaction.heartbeatAfterMs);

    state.timeoutId = timeoutId;
    this.heartbeats.set(task.id, state);
    unrefTimer(timeoutId);
  }

  private clearHeartbeat(taskId: TaskId): void {
    const state = this.heartbeats.get(taskId);
    if (!state) {
      return;
    }
    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
    }
    if (state.intervalId) {
      clearInterval(state.intervalId);
    }
    this.heartbeats.delete(taskId);
  }

  private sendHeartbeat(task: Task): void {
    const title = task.title.replace(/\s+/g, " ").trim().slice(0, 80);
    const message = title ? `Still working on: ${title}` : "Still working.";
    this.channel.sendText(task.chatId, message).catch((err) => {
      getLogger().debug("Failed to send progress heartbeat", {
        chatId: task.chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
