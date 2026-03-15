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
import type { ProviderManager } from "../agents/providers/provider-manager.js";
import type { DMPolicy } from "../security/dm-policy.js";
import type { UserProfileStore } from "../memory/unified/user-profile-store.js";
import type { SoulLoader } from "../agents/soul/index.js";

export class CommandHandler {
  constructor(
    private readonly taskManager: TaskManager,
    private readonly channel: IChannelSender,
    private readonly providerManager?: ProviderManager,
    private readonly dmPolicy?: DMPolicy,
    private readonly userProfileStore?: UserProfileStore,
    private readonly soulLoader?: SoulLoader,
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
      case "model":
        await this.handleModel(chatId, args);
        break;
      case "goal":
        await this.handleGoal(chatId, args);
        break;
      case "autonomous":
        await this.handleAutonomous(chatId, args);
        break;
      case "persona":
        await this.handlePersona(chatId, args);
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

  private async handleGoal(chatId: string, args: string[]): Promise<void> {
    if (args.length === 0) {
      await this.channel.sendText(
        chatId,
        "Usage: /goal <description> | /goal list | /goal cancel [id]",
      );
      return;
    }

    const subcommand = args[0]!.toLowerCase();

    if (subcommand === "list") {
      await this.handleTasks(chatId);
      return;
    }

    if (subcommand === "cancel") {
      await this.handleCancel(chatId, args[1] as TaskId | undefined);
      return;
    }

    // Default: submit as a goal task
    const prompt = args.join(" ").slice(0, 2000);
    await this.taskManager.submit(chatId, "goal", prompt);
    await this.channel.sendText(chatId, `Goal submitted: ${prompt.slice(0, 80)}`);
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
      "*Goal Commands*",
      "",
      "`/goal <description>` - Start a goal",
      "`/goal list` - List goals",
      "`/goal cancel [id]` - Cancel a goal",
      "",
      "*Model Commands*",
      "",
      "`/model` - Show current provider/model",
      "`/model list` - List available providers",
      "`/model <provider>` - Switch provider",
      "`/model <provider>/<model>` - Switch provider and model",
      "`/model reset` - Return to system default",
      "",
      "*Autonomous Mode*",
      "",
      "`/autonomous on [hours]` - Enable autonomous mode (default: 24h, max: 168h)",
      "`/autonomous off` - Disable autonomous mode",
      "`/autonomous` - Show autonomous mode status",
      "",
      "*Personality*",
      "",
      "`/persona` - Show active personality profile",
      "`/persona list` - List all profiles",
      "`/persona switch <name>` - Switch to a profile",
      "`/persona create <name>` - Create a custom profile",
      "`/persona delete <name>` - Delete a custom profile",
      "",
      "Turkish: /durum, /iptal, /gorevler, /detay, /yardim, /hedef, /kisilik, /model listele, /model sıfırla",
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

  private async handleModel(chatId: string, args: string[]): Promise<void> {
    if (!this.providerManager) {
      await this.channel.sendText(chatId, "Model switching is not available.");
      return;
    }

    const subcommand = args[0]?.toLowerCase();

    // No args → show current
    if (!subcommand) {
      const info = this.providerManager.getActiveInfo(chatId);
      const status = info.isDefault ? " (system default)" : "";
      await this.channel.sendMarkdown(
        chatId,
        `*Current Model*\nProvider: \`${info.providerName}\`\nModel: \`${info.model}\`${status}`,
      );
      return;
    }

    // list / listele
    if (subcommand === "list" || subcommand === "listele") {
      const available = this.providerManager.listAvailable();
      const lines = available.map(
        (p) => `\`${p.name}\` — ${p.label} (${p.defaultModel})`,
      );
      await this.channel.sendMarkdown(
        chatId,
        `*Available Providers*\n\n${lines.join("\n")}\n\nUsage: \`/model provider\` or \`/model provider/model\``,
      );
      return;
    }

    // reset / sıfırla
    if (subcommand === "reset" || subcommand === "sıfırla") {
      this.providerManager.clearPreference(chatId);
      const info = this.providerManager.getActiveInfo(chatId);
      await this.channel.sendMarkdown(
        chatId,
        `Model reset to system default: \`${info.providerName}\``,
      );
      return;
    }

    // provider/model or just provider
    const slashIndex = subcommand.indexOf("/");
    let providerName: string;
    let model: string | undefined;

    if (slashIndex > 0) {
      providerName = subcommand.slice(0, slashIndex);
      model = subcommand.slice(slashIndex + 1);
    } else {
      providerName = subcommand;
    }

    if (!this.providerManager.isAvailable(providerName)) {
      await this.channel.sendText(
        chatId,
        `Provider "${providerName}" is not available. Use \`/model list\` to see options.`,
      );
      return;
    }

    this.providerManager.setPreference(chatId, providerName, model);
    const info = this.providerManager.getActiveInfo(chatId);
    await this.channel.sendMarkdown(
      chatId,
      `Switched to \`${info.providerName}\` (model: \`${info.model}\`)`,
    );
  }

  private async handleAutonomous(chatId: string, args: string[]): Promise<void> {
    if (!this.dmPolicy || !this.userProfileStore) {
      await this.channel.sendText(chatId, "Autonomous mode requires profile store.");
      return;
    }

    const subcommand = args[0]?.toLowerCase();

    // status / no args → show current state
    if (!subcommand || subcommand === "status") {
      const result = await this.userProfileStore.isAutonomousMode(chatId);
      if (!result.enabled) {
        await this.channel.sendText(chatId, "Autonomous mode is currently disabled.");
        return;
      }

      if (result.remainingMs !== undefined && result.remainingMs > 0) {
        const hours = Math.round(result.remainingMs / 3600_000 * 10) / 10;
        await this.channel.sendText(chatId, `Autonomous mode is enabled. ${hours}h remaining.`);
      } else if (result.expiresAt !== undefined) {
        await this.channel.sendText(chatId, "Autonomous mode is enabled (expired, pending refresh).");
      } else {
        await this.channel.sendText(chatId, "Autonomous mode is enabled.");
      }
      return;
    }

    // on [hours]
    if (subcommand === "on") {
      const DEFAULT_HOURS = 24;
      const MIN_HOURS = 1;
      const MAX_HOURS = 168;

      let hours = DEFAULT_HOURS;
      const hoursArg = args[1];
      if (hoursArg) {
        const parsed = Number(hoursArg);
        if (isNaN(parsed) || parsed < MIN_HOURS || parsed > MAX_HOURS) {
          await this.channel.sendText(
            chatId,
            `Invalid hours. Must be between ${MIN_HOURS} and ${MAX_HOURS}.`,
          );
          return;
        }
        hours = parsed;
      }

      const expiresAt = Date.now() + hours * 3600_000;
      await this.userProfileStore.setAutonomousMode(chatId, true, expiresAt);
      this.dmPolicy.initFromProfile(chatId, { autonomousMode: true, autonomousExpiresAt: expiresAt });

      await this.channel.sendText(
        chatId,
        `Autonomous mode enabled for ${hours} hours. I'll execute tasks without asking for approval.`,
      );
      return;
    }

    // off
    if (subcommand === "off") {
      await this.userProfileStore.setAutonomousMode(chatId, false);
      this.dmPolicy.initFromProfile(chatId, { autonomousMode: false });

      await this.channel.sendText(
        chatId,
        "Autonomous mode disabled. I'll ask for approval before sensitive operations.",
      );
      return;
    }

    await this.channel.sendText(chatId, "Usage: /autonomous on [hours] | off | status");
  }

  private async handlePersona(chatId: string, args: string[]): Promise<void> {
    if (!this.soulLoader) {
      await this.channel.sendText(chatId, "Personality management is not available.");
      return;
    }

    const subcommand = args[0]?.toLowerCase();

    // No args → show current profile + usage
    if (!subcommand) {
      const active = this.soulLoader.getActiveProfile();
      const profiles = this.soulLoader.getProfiles();
      const customTag = this.soulLoader.isCustomProfile(active) ? " (custom)" : "";
      await this.channel.sendMarkdown(
        chatId,
        `*Active Personality:* \`${active}\`${customTag}\n` +
        `*Available:* ${profiles.map(p => `\`${p}\``).join(", ")}\n\n` +
        "Usage:\n" +
        "`/persona list` - List all profiles\n" +
        "`/persona switch <name>` - Switch profile\n" +
        "`/persona create <name>` - Create a custom profile\n" +
        "`/persona delete <name>` - Delete a custom profile",
      );
      return;
    }

    // list / listele
    if (subcommand === "list" || subcommand === "listele") {
      const profiles = this.soulLoader.getProfiles();
      const active = this.soulLoader.getActiveProfile();
      const lines = profiles.map((p) => {
        const marker = p === active ? " **(active)**" : "";
        const custom = this.soulLoader!.isCustomProfile(p) ? " _(custom)_" : "";
        return `\`${p}\`${marker}${custom}`;
      });
      await this.channel.sendMarkdown(
        chatId,
        `*Personality Profiles*\n\n${lines.join("\n")}`,
      );
      return;
    }

    // switch / degistir
    if (subcommand === "switch" || subcommand === "degistir") {
      const name = args[1]?.toLowerCase();
      if (!name) {
        await this.channel.sendText(chatId, "Usage: /persona switch <name>");
        return;
      }

      const success = await this.soulLoader.switchProfile(name);
      if (success) {
        // Update user profile store if available
        if (this.userProfileStore) {
          try {
            this.userProfileStore.setActivePersona(chatId, name);
          } catch {
            // Non-fatal
          }
        }
        await this.channel.sendMarkdown(
          chatId,
          `Personality switched to \`${name}\`. My responses will now reflect this style.`,
        );
      } else {
        const available = this.soulLoader.getProfiles();
        await this.channel.sendText(
          chatId,
          `Profile "${name}" not found. Available: ${available.join(", ")}`,
        );
      }
      return;
    }

    // create / olustur
    if (subcommand === "create" || subcommand === "olustur") {
      const name = args[1]?.toLowerCase();
      if (!name) {
        await this.channel.sendText(chatId, "Usage: /persona create <name>");
        return;
      }
      await this.channel.sendText(
        chatId,
        `Tell me what kind of personality you want for "${name}" and I'll create it for you! ` +
        "Describe the tone, style, and behavior you'd like.",
      );
      return;
    }

    // delete / sil
    if (subcommand === "delete" || subcommand === "sil") {
      const name = args[1]?.toLowerCase();
      if (!name) {
        await this.channel.sendText(chatId, "Usage: /persona delete <name>");
        return;
      }

      const SYSTEM_PROFILES = ["default", "casual", "formal", "minimal"];
      if (SYSTEM_PROFILES.includes(name)) {
        await this.channel.sendText(
          chatId,
          `Cannot delete system profile "${name}". Only custom profiles can be deleted.`,
        );
        return;
      }

      const success = await this.soulLoader.deleteProfile(name);
      if (success) {
        // If active persona was deleted, update profile store
        if (this.userProfileStore) {
          try {
            this.userProfileStore.setActivePersona(chatId, "default");
          } catch {
            // Non-fatal
          }
        }
        await this.channel.sendMarkdown(
          chatId,
          `Custom profile \`${name}\` deleted.` +
          (this.soulLoader.getActiveProfile() === "default"
            ? " Switched back to default personality."
            : ""),
        );
      } else {
        await this.channel.sendText(
          chatId,
          `Could not delete "${name}". It may not exist or may be a system profile.`,
        );
      }
      return;
    }

    await this.channel.sendText(
      chatId,
      "Usage: /persona | /persona list | /persona switch <name> | /persona create <name> | /persona delete <name>",
    );
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
