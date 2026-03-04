/**
 * Command Handler
 *
 * Executes parsed commands against the TaskManager and
 * formats responses for the channel.
 */

import type { IChannelSender } from "../channels/channel-core.interface.js";
import type { TaskCommand, Task, TaskId } from "./types.js";
import { TaskStatus, ACTIVE_STATUSES } from "./types.js";
import type { TaskManager } from "./task-manager.js";

export class CommandHandler {
  constructor(
    private readonly taskManager: TaskManager,
    private readonly channel: IChannelSender,
  ) {}

  async handle(chatId: string, command: TaskCommand, args: string[]): Promise<void> {
    switch (command) {
      case "status":
        await this.handleStatus(chatId, args[0] as TaskId | undefined);
        break;
      case "cancel":
        await this.handleCancel(chatId, args[0] as TaskId | undefined);
        break;
      case "tasks":
        await this.handleTasks(chatId);
        break;
      case "detail":
        await this.handleDetail(chatId, args[0] as TaskId | undefined);
        break;
      case "help":
        await this.handleHelp(chatId);
        break;
      case "pause":
        await this.handlePause(chatId, args[0] as TaskId | undefined);
        break;
      case "resume":
        await this.handleResume(chatId, args[0] as TaskId | undefined);
        break;
    }
  }

  private async handleStatus(chatId: string, taskId?: TaskId): Promise<void> {
    if (taskId) {
      const task = this.taskManager.getStatus(taskId);
      if (!task) {
        await this.channel.sendText(chatId, `Task ${taskId} not found.`);
        return;
      }
      await this.channel.sendMarkdown(chatId, this.formatTaskStatus(task));
      return;
    }

    // Show all active tasks for this chat
    const tasks = this.taskManager.listTasks(chatId);
    const active = tasks.filter((t) => ACTIVE_STATUSES.has(t.status));
    if (active.length === 0) {
      await this.channel.sendText(chatId, "No active tasks.");
      return;
    }

    const lines = active.map((t) => this.formatTaskBrief(t));
    await this.channel.sendMarkdown(chatId, `*Active Tasks*\n\n${lines.join("\n")}`);
  }

  private async handleCancel(chatId: string, taskId?: TaskId): Promise<void> {
    if (!taskId) {
      // Cancel the most recent active task
      const tasks = this.taskManager.listTasks(chatId);
      const active = tasks.find((t) => ACTIVE_STATUSES.has(t.status));
      if (!active) {
        await this.channel.sendText(chatId, "No active tasks to cancel.");
        return;
      }
      taskId = active.id;
    }

    const success = this.taskManager.cancel(taskId);
    if (success) {
      await this.channel.sendText(chatId, `Task ${taskId} cancelled.`);
    } else {
      await this.channel.sendText(chatId, `Could not cancel task ${taskId}. It may already be finished.`);
    }
  }

  private async handleTasks(chatId: string): Promise<void> {
    const tasks = this.taskManager.listTasks(chatId);
    if (tasks.length === 0) {
      await this.channel.sendText(chatId, "No tasks found.");
      return;
    }

    const lines = tasks.map((t) => this.formatTaskBrief(t));
    await this.channel.sendMarkdown(chatId, `*Recent Tasks*\n\n${lines.join("\n")}`);
  }

  private async handleDetail(chatId: string, taskId?: TaskId): Promise<void> {
    if (!taskId) {
      await this.channel.sendText(chatId, "Usage: /detail <task_id>");
      return;
    }

    const task = this.taskManager.getStatus(taskId);
    if (!task) {
      await this.channel.sendText(chatId, `Task ${taskId} not found.`);
      return;
    }

    await this.channel.sendMarkdown(chatId, this.formatTaskDetail(task));
  }

  private async handleHelp(chatId: string): Promise<void> {
    const help = [
      "*Task Commands*",
      "",
      "`/status [id]` - Show active task status",
      "`/cancel [id]` - Cancel a running task",
      "`/tasks` - List recent tasks",
      "`/detail <id>` - Show full task details",
      "`/pause [id]` - Pause a running task",
      "`/resume [id]` - Resume a paused task",
      "`/help` - Show this help",
      "",
      "You can also use Turkish: /durum, /iptal, /gorevler, /detay, /yardim",
      "",
      "Send any other message to start a new background task.",
    ].join("\n");
    await this.channel.sendMarkdown(chatId, help);
  }

  private async handlePause(chatId: string, taskId?: TaskId): Promise<void> {
    if (!taskId) {
      const tasks = this.taskManager.listTasks(chatId);
      const running = tasks.find((t) => t.status === TaskStatus.executing);
      if (!running) {
        await this.channel.sendText(chatId, "No running tasks to pause.");
        return;
      }
      taskId = running.id;
    }

    // Pause is a Phase 2 feature - acknowledge but don't implement yet
    await this.channel.sendText(chatId, `Pause is not yet supported. Use /cancel ${taskId} to stop the task.`);
  }

  private async handleResume(chatId: string, taskId?: TaskId): Promise<void> {
    if (!taskId) {
      const tasks = this.taskManager.listTasks(chatId);
      const paused = tasks.find((t) => t.status === TaskStatus.paused);
      if (!paused) {
        await this.channel.sendText(chatId, "No paused tasks to resume.");
        return;
      }
      taskId = paused.id;
    }

    await this.channel.sendText(chatId, `Resume is not yet supported. Please start a new task.`);
  }

  // ─── Formatting ─────────────────────────────────────────────────────────────

  private formatTaskBrief(task: Task): string {
    const icon = this.statusIcon(task.status);
    const elapsed = this.formatElapsed(task.createdAt);
    return `${icon} \`${task.id}\` ${task.title} (${elapsed})`;
  }

  private formatTaskStatus(task: Task): string {
    const icon = this.statusIcon(task.status);
    const lines = [
      `${icon} *${task.title}*`,
      `ID: \`${task.id}\``,
      `Status: ${task.status}`,
      `Started: ${this.formatElapsed(task.createdAt)}`,
    ];

    if (task.progress.length > 0) {
      const last = task.progress[task.progress.length - 1]!;
      lines.push(`Last update: ${last.message}`);
    }

    if (task.result) {
      lines.push(`Result: ${task.result.slice(0, 200)}`);
    }

    if (task.error) {
      lines.push(`Error: ${task.error.slice(0, 200)}`);
    }

    return lines.join("\n");
  }

  private formatTaskDetail(task: Task): string {
    const icon = this.statusIcon(task.status);
    const lines = [
      `${icon} *${task.title}*`,
      `ID: \`${task.id}\``,
      `Status: ${task.status}`,
      `Channel: ${task.channelType}`,
      `Created: ${new Date(task.createdAt).toISOString()}`,
      `Updated: ${new Date(task.updatedAt).toISOString()}`,
    ];

    if (task.completedAt) {
      lines.push(`Completed: ${new Date(task.completedAt).toISOString()}`);
    }

    lines.push("", `*Prompt:* ${task.prompt.slice(0, 300)}`);

    if (task.progress.length > 0) {
      lines.push("", "*Progress:*");
      for (const entry of task.progress.slice(-10)) {
        const time = new Date(entry.timestamp).toLocaleTimeString();
        lines.push(`  ${time} - ${entry.message}`);
      }
    }

    if (task.result) {
      lines.push("", `*Result:*\n${task.result.slice(0, 500)}`);
    }

    if (task.error) {
      lines.push("", `*Error:*\n${task.error.slice(0, 500)}`);
    }

    return lines.join("\n");
  }

  private statusIcon(status: TaskStatus): string {
    switch (status) {
      case TaskStatus.pending: return "⏳";
      case TaskStatus.planning: return "📋";
      case TaskStatus.executing: return "⚙️";
      case TaskStatus.completed: return "✅";
      case TaskStatus.failed: return "❌";
      case TaskStatus.cancelled: return "🚫";
      case TaskStatus.paused: return "⏸️";
      case TaskStatus.waiting_for_input: return "❓";
    }
  }

  private formatElapsed(startMs: number): string {
    const elapsed = Date.now() - startMs;
    if (elapsed < 60_000) return `${Math.round(elapsed / 1000)}s ago`;
    if (elapsed < 3600_000) return `${Math.round(elapsed / 60_000)}m ago`;
    return `${Math.round(elapsed / 3600_000)}h ago`;
  }
}
