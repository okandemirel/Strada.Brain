/**
 * Progress Reporter
 *
 * Sends task completion/failure/block updates to the channel.
 * In silent-first mode it opens a single transient status message for
 * long-running tasks and updates it in place when the summarized task state changes.
 */

import type { IChannelAdapter, IChannelRichMessaging } from "../channels/channel.interface.js";
import { supportsRichMessaging, supportsStreaming } from "../channels/channel-core.interface.js";
import { DEFAULT_INTERACTION_CONFIG, type InteractionConfig } from "../config/config.js";
import type { TaskManager } from "./task-manager.js";
import type { Task, TaskId, TaskProgressUpdate } from "./types.js";
import { buildTaskProgressSummary, type ProgressLanguage } from "./progress-signals.js";
import { getLogger } from "../utils/logger.js";
import { classifyTaskErrorMessage } from "../utils/error-messages.js";

interface HeartbeatState {
  chatId?: string;
  timeoutId?: ReturnType<typeof setTimeout>;
  earlyTimeoutId?: ReturnType<typeof setTimeout>;
  scheduledUpdateId?: ReturnType<typeof setTimeout>;
  live?: boolean;
  streamId?: string;
  lastProgress?: TaskProgressUpdate;
  lastSummary?: string;
  lastSentAt?: number;
}

function unrefTimer(timer: { unref?: () => void }): void {
  timer.unref?.();
}

const STREAMING_UPDATE_THROTTLE_MS = 4_000;
const FALLBACK_UPDATE_THROTTLE_MS = 60_000;
const EARLY_PROGRESS_HEARTBEAT_MS = 1_500;
const EARLY_GOAL_HEARTBEAT_MS = 750;
const PHASE_DRIVEN_INITIAL_HEARTBEAT_MS = 20_000;

export class ProgressReporter {
  private readonly interaction: InteractionConfig;
  private readonly heartbeats = new Map<TaskId, HeartbeatState>();
  private readonly defaultLanguage: ProgressLanguage;
  private lastNarrativeAt = 0;

  constructor(
    private readonly channel: IChannelAdapter,
    taskManager: TaskManager,
    interaction: InteractionConfig = DEFAULT_INTERACTION_CONFIG,
    defaultLanguage: ProgressLanguage = "en",
  ) {
    this.interaction = interaction;
    this.defaultLanguage = defaultLanguage;
    this.setupListeners(taskManager);
  }

  private setupListeners(taskManager: TaskManager): void {
    taskManager.on("task:created", (task: Task) => {
      this.reportCreated(task);
    });

    taskManager.on("task:progress", (taskId: TaskId, message: TaskProgressUpdate) => {
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

    taskManager.on("task:blocked", (taskId: TaskId, result: string) => {
      const task = taskManager.getStatus(taskId);
      if (task) {
        this.reportBlocked(task, result);
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

  private reportProgress(task: Task, message: TaskProgressUpdate): void {
    // Keep typing indicator alive during long tasks
    this.sendTyping(task.chatId);
    const state = this.getHeartbeatState(task.id);
    state.lastProgress = message;
    this.scheduleEarlyHeartbeat(task, state, message);
    if (state.live) {
      void this.maybeSendLiveStatus(task, state);
    }
  }

  private sendTyping(chatId: string): void {
    if (supportsRichMessaging(this.channel)) {
      (this.channel as IChannelRichMessaging).sendTypingIndicator(chatId).catch(() => {});
    }
  }

  private reportCompleted(task: Task, result: string): void {
    this.clearHeartbeat(task.id, true);
    this.sendToChannel(task.chatId, result);
  }

  private reportFailed(task: Task, error: string): void {
    this.clearHeartbeat(task.id, true);
    this.sendToChannel(task.chatId, classifyTaskErrorMessage(error));
    getLogger().error("Task failed", { taskId: task.id, error });
  }

  private reportBlocked(task: Task, result: string): void {
    this.clearHeartbeat(task.id, true);
    this.sendToChannel(task.chatId, result);
  }

  private reportCancelled(task: Task): void {
    this.clearHeartbeat(task.id, true);
    // Suppressed — cancellation is internal state
  }

  private scheduleHeartbeat(task: Task): void {
    this.clearHeartbeat(task.id);

    if (!["silent-first", "phase-driven"].includes(this.interaction.mode) || this.interaction.heartbeatAfterMs <= 0) {
      return;
    }

    const state = this.getHeartbeatState(task.id);
    state.chatId = task.chatId;
    const heartbeatAfterMs = this.interaction.mode === "phase-driven"
      ? Math.min(this.interaction.heartbeatAfterMs, PHASE_DRIVEN_INITIAL_HEARTBEAT_MS)
      : this.interaction.heartbeatAfterMs;
    const timeoutId = setTimeout(() => {
      const current = this.heartbeats.get(task.id);
      if (!current) {
        return;
      }
      current.live = true;
      void this.maybeSendLiveStatus(task, current, true);
    }, heartbeatAfterMs);

    state.timeoutId = timeoutId;
    unrefTimer(timeoutId);
  }

  private scheduleEarlyHeartbeat(
    task: Task,
    state: HeartbeatState,
    message: TaskProgressUpdate,
  ): void {
    if (state.live || state.earlyTimeoutId) {
      return;
    }
    if (!["silent-first", "phase-driven"].includes(this.interaction.mode) || this.interaction.heartbeatAfterMs <= 0) {
      return;
    }

    const signal = typeof message === "string" ? undefined : message;
    const delay = signal?.kind === "goal" ? EARLY_GOAL_HEARTBEAT_MS : EARLY_PROGRESS_HEARTBEAT_MS;
    const effectiveDelay = Math.min(delay, this.interaction.heartbeatAfterMs);
    state.earlyTimeoutId = setTimeout(() => {
      const current = this.heartbeats.get(task.id);
      if (!current) {
        return;
      }
      current.earlyTimeoutId = undefined;
      current.live = true;
      if (current.timeoutId) {
        clearTimeout(current.timeoutId);
        current.timeoutId = undefined;
      }
      void this.maybeSendLiveStatus(task, current, true);
    }, effectiveDelay);
    unrefTimer(state.earlyTimeoutId);
  }

  private clearHeartbeat(taskId: TaskId, finalizeStream = false): void {
    const state = this.heartbeats.get(taskId);
    if (!state) {
      return;
    }
    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
    }
    if (state.earlyTimeoutId) {
      clearTimeout(state.earlyTimeoutId);
    }
    if (state.scheduledUpdateId) {
      clearTimeout(state.scheduledUpdateId);
    }
    if (finalizeStream && state.streamId && state.chatId && supportsStreaming(this.channel)) {
      const streamId = state.streamId;
      this.channel.finalizeStreamingMessage(state.chatId, streamId, "").catch((err) => {
        getLogger().debug("Failed to finalize transient progress stream", {
          taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    this.heartbeats.delete(taskId);
  }

  private getHeartbeatState(taskId: TaskId): HeartbeatState {
    const current = this.heartbeats.get(taskId);
    if (current) {
      return current;
    }
    const state: HeartbeatState = {};
    this.heartbeats.set(taskId, state);
    return state;
  }

  /** Call when a progress:narrative event is emitted to suppress fallback heartbeat. */
  onNarrativeEmitted(): void {
    this.lastNarrativeAt = Date.now();
  }

  private async maybeSendLiveStatus(
    task: Task,
    state: HeartbeatState,
    force = false,
  ): Promise<void> {
    // In phase-driven mode, skip heartbeat if narrative pipeline was recently active
    if (this.interaction.mode === "phase-driven" &&
        this.lastNarrativeAt > 0 &&
        Date.now() - this.lastNarrativeAt < this.interaction.heartbeatAfterMs) {
      return;
    }
    const summary = buildTaskProgressSummary(task, state.lastProgress, this.defaultLanguage);
    if (!summary) {
      return;
    }

    const now = Date.now();
    const throttleMs = supportsStreaming(this.channel)
      ? STREAMING_UPDATE_THROTTLE_MS
      : FALLBACK_UPDATE_THROTTLE_MS;
    if (!force && state.lastSummary === summary) {
      return;
    }
    if (!force && state.lastSentAt && now - state.lastSentAt < throttleMs) {
      const remainingMs = throttleMs - (now - state.lastSentAt);
      if (state.scheduledUpdateId) {
        clearTimeout(state.scheduledUpdateId);
      }
      state.scheduledUpdateId = setTimeout(() => {
        const current = this.heartbeats.get(task.id);
        if (!current) {
          return;
        }
        current.scheduledUpdateId = undefined;
        void this.maybeSendLiveStatus(task, current, true);
      }, remainingMs);
      unrefTimer(state.scheduledUpdateId);
      return;
    }

    if (state.scheduledUpdateId) {
      clearTimeout(state.scheduledUpdateId);
      state.scheduledUpdateId = undefined;
    }
    state.lastSummary = summary;
    state.lastSentAt = now;

    if (supportsStreaming(this.channel)) {
      await this.sendStreamingStatus(task.chatId, state, summary);
      return;
    }

    await this.channel.sendText(task.chatId, summary).catch((err) => {
      getLogger().debug("Failed to send progress status update", {
        chatId: task.chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async sendStreamingStatus(
    chatId: string,
    state: HeartbeatState,
    summary: string,
  ): Promise<void> {
    if (!supportsStreaming(this.channel)) {
      await this.channel.sendText(chatId, summary);
      return;
    }

    try {
      const channel = this.channel;
      if (!state.streamId) {
        state.streamId = await channel.startStreamingMessage(chatId);
      }
      if (!state.streamId) {
        await channel.sendText(chatId, summary);
        return;
      }
      await channel.updateStreamingMessage(chatId, state.streamId, summary);
    } catch (err) {
      getLogger().debug("Failed to stream progress status update", {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.channel.sendText(chatId, summary).catch(() => {});
    }
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
