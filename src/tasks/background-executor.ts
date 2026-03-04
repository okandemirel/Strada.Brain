/**
 * Background Executor
 *
 * Async execution queue for running tasks in the background.
 * Uses a FIFO queue with configurable concurrency limit.
 * All work is I/O-bound (LLM API calls), so same event loop is fine.
 */

import type { Task } from "./types.js";
import { TaskStatus } from "./types.js";
import type { TaskManager } from "./task-manager.js";
import type { Orchestrator } from "../agents/orchestrator.js";
import { getLogger } from "../utils/logger.js";

interface QueueEntry {
  task: Task;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}

export class BackgroundExecutor {
  private readonly queue: QueueEntry[] = [];
  private running = 0;
  private taskManager: TaskManager | null = null;

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly concurrencyLimit: number = 3,
  ) {}

  /**
   * Set the task manager reference (avoids circular dependency).
   */
  setTaskManager(manager: TaskManager): void {
    this.taskManager = manager;
  }

  /**
   * Add a task to the execution queue.
   */
  enqueue(task: Task, signal: AbortSignal, onProgress: (message: string) => void): void {
    this.queue.push({ task, signal, onProgress });
    this.processQueue();
  }

  /**
   * Process the queue, starting tasks up to the concurrency limit.
   */
  private processQueue(): void {
    while (this.running < this.concurrencyLimit && this.queue.length > 0) {
      const entry = this.queue.shift()!;

      // Skip if already cancelled
      if (entry.signal.aborted) {
        continue;
      }

      this.running++;
      this.executeTask(entry).finally(() => {
        this.running--;
        this.processQueue();
      });
    }
  }

  private async executeTask(entry: QueueEntry): Promise<void> {
    const { task, signal, onProgress } = entry;
    const logger = getLogger();

    if (!this.taskManager) {
      logger.error("TaskManager not set on BackgroundExecutor");
      return;
    }

    // Update status to executing
    this.taskManager.updateStatus(task.id, TaskStatus.executing);
    onProgress("Task started");

    try {
      const result = await this.orchestrator.runBackgroundTask(task.prompt, {
        signal,
        onProgress,
        chatId: task.chatId,
        channelType: task.channelType,
      });

      if (signal.aborted) {
        // Already cancelled — don't overwrite the cancelled status
        return;
      }

      this.taskManager.complete(task.id, result);
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Background task execution error", { taskId: task.id, error: errMsg });
      this.taskManager.fail(task.id, errMsg);
    }
  }
}
