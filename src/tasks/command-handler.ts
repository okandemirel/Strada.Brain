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
import { projectScopeMatches } from "../learning/runtime-artifact-manager.js";
import type { RuntimeArtifactManager } from "../learning/runtime-artifact-manager.js";
import type { UserProfileStore } from "../memory/unified/user-profile-store.js";
import type { SoulLoader } from "../agents/soul/index.js";
import type { ExecutionTrace, PhaseOutcome, PhaseScore, RoutingDecision } from "../agent-core/routing/routing-types.js";

/** Structural interface for ProviderRouter to avoid circular dependency */
interface ProviderRouterRef {
  getPreset(): string;
  setPreset(p: string): void;
  getRecentDecisions(n: number, identityKey?: string): RoutingDecision[];
  getRecentExecutionTraces?(n: number, identityKey?: string): ExecutionTrace[];
  getRecentPhaseOutcomes?(n: number, identityKey?: string): PhaseOutcome[];
  getPhaseScoreboard?(n: number, identityKey?: string): PhaseScore[];
}

/** Structural interface for HeartbeatLoop to avoid circular dependency */
interface HeartbeatLoopRef {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  getDaemonStatus(): { running: boolean; intervalMs: number; triggerCount: number; lastTick: Date | null };
  getSecurityPolicy?(): { setAutonomousOverride(enabled: boolean, expiresAt?: number): void } | undefined;
}

export class CommandHandler {
  private providerRouter?: ProviderRouterRef;

  constructor(
    private readonly taskManager: TaskManager,
    private readonly channel: IChannelSender,
    private readonly providerManager?: ProviderManager,
    private readonly dmPolicy?: DMPolicy,
    private readonly userProfileStore?: UserProfileStore,
    private readonly soulLoader?: SoulLoader,
    private readonly runtimeArtifactManager?: Pick<RuntimeArtifactManager, "getRecentArtifactsForIdentity">,
    private readonly projectScopeFingerprint?: string,
    private heartbeatLoopRef?: HeartbeatLoopRef,
  ) {}

  /** Set HeartbeatLoop reference for daemon control (set after construction due to init order) */
  setHeartbeatLoop(loop: HeartbeatLoopRef): void {
    this.heartbeatLoopRef = loop;
  }

  /** Set ProviderRouter reference for /routing command (set after construction due to init order) */
  setProviderRouter(router: ProviderRouterRef): void {
    this.providerRouter = router;
  }

  private getIdentityKey(chatId: string, userId?: string): string {
    const normalizedUserId = userId?.trim();
    return normalizedUserId ? normalizedUserId : chatId;
  }

  async handle(chatId: string, command: TaskCommand, args: string[], userId?: string): Promise<void> {
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
        await this.handleModel(chatId, args, userId);
        break;
      case "goal":
        await this.handleGoal(chatId, args, userId);
        break;
      case "autonomous":
        await this.handleAutonomous(chatId, args, userId);
        break;
      case "persona":
        await this.handlePersona(chatId, args, userId);
        break;
      case "daemon":
        await this.handleDaemon(chatId, args);
        break;
      case "agent":
        await this.handleAgent(chatId, args);
        break;
      case "routing":
        await this.handleRouting(chatId, args, userId);
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

  private async handleGoal(chatId: string, args: string[], userId?: string): Promise<void> {
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
    await this.taskManager.submit(chatId, "goal", prompt, {
      userId: this.getIdentityKey(chatId, userId),
    });
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
      "`/model` - Show Strada's primary execution worker",
      "`/model list` - List available worker providers",
      "`/model <provider>` - Set Strada's primary execution provider",
      "`/model <provider>/<model>` - Set Strada's primary execution model",
      "`/model info [provider]` - Show provider capabilities",
      "`/model reset` - Return to Strada's system default worker",
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
      "*Daemon Mode*",
      "",
      "`/daemon` - Show daemon status",
      "`/daemon start` - Start daemon heartbeat loop (requires startup with --daemon)",
      "`/daemon stop` - Stop daemon heartbeat loop",
      "`/daemon triggers` - Show active triggers",
      "",
      "*Agent Core*",
      "",
      "`/agent` - Show agent core status",
      "",
      "*Routing*",
      "",
      "`/routing` - Show routing status",
      "`/routing preset <name>` - Switch routing preset (budget/balanced/performance)",
      "`/routing info` - Show recent routing decisions",
      "",
      "Turkish: /durum, /iptal, /gorevler, /detay, /yardim, /hedef, /kisilik, /ajan, /yonlendirme, /model listele, /model bilgi, /model sıfırla",
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

  private async handleModel(chatId: string, args: string[], userId?: string): Promise<void> {
    if (!this.providerManager) {
      await this.channel.sendText(chatId, "Model switching is not available.");
      return;
    }

    const identityKey = this.getIdentityKey(chatId, userId);
    const subcommand = args[0]?.toLowerCase();

    // No args → show current
    if (!subcommand) {
      const info = this.providerManager.getActiveInfo(identityKey);
      const executionPool = this.providerManager.listExecutionCandidates(identityKey)
        .map((entry) => `\`${entry.name}\``)
        .join(", ");
      const status = info.isDefault ? " (system default)" : "";
      await this.channel.sendMarkdown(
        chatId,
        [
          "*Strada Execution Policy*",
          `Primary worker provider: \`${info.providerName}\``,
          `Primary worker model: \`${info.model}\`${status}`,
          executionPool ? `Execution pool: ${executionPool}` : "",
          "",
          info.executionPolicyNote,
        ].filter(Boolean).join("\n"),
      );
      return;
    }

    // list / listele
    if (subcommand === "list" || subcommand === "listele") {
      const available = this.providerManager.listAvailable();
      const executionPool = this.providerManager.listExecutionCandidates(identityKey);
      const lines = available.map(
        (p) => `\`${p.name}\` — ${p.label} (${p.defaultModel})`,
      );
      const poolLines = executionPool.map(
        (p) => `\`${p.name}\` — ${p.label} (${p.defaultModel})`,
      );
      await this.channel.sendMarkdown(
        chatId,
        [
          "*Available Worker Providers*",
          "",
          lines.join("\n"),
          "",
          "*Current Execution Pool*",
          "",
          poolLines.join("\n") || "(none)",
          "",
          "Usage: `/model provider` or `/model provider/model`",
          "",
          "Strada remains the control plane; this only changes the primary execution worker.",
        ].join("\n"),
      );
      return;
    }

    // info / bilgi — show provider capabilities and intelligence
    if (subcommand === "info" || subcommand === "bilgi") {
      if (!this.providerManager) {
        await this.channel.sendText(chatId, "Provider manager not available.");
        return;
      }

      const providerArg = args[1]?.toLowerCase();
      const targetProvider = providerArg || this.providerManager.getActiveInfo(identityKey)?.providerName;

      if (!targetProvider) {
        await this.channel.sendText(chatId, "Could not determine current provider.");
        return;
      }

      try {
        const {
          getProviderIntelligenceSnapshot,
          formatContextWindow,
        } = await import("../agents/providers/provider-knowledge.js");
        const providerManager = this.providerManager;
        const available = providerManager.describeAvailable?.()
          ?? providerManager.listAvailable().map((provider) => ({
            ...provider,
            capabilities: providerManager.getProviderCapabilities?.(provider.name, provider.defaultModel) ?? null,
          }));
        const descriptor = available.find((provider) => provider.name === targetProvider);
        const activeInfo = providerManager.getActiveInfo(identityKey);
        const modelId = activeInfo?.providerName === targetProvider
          ? activeInfo.model
          : descriptor?.defaultModel;
        const snapshot = getProviderIntelligenceSnapshot(
          targetProvider,
          modelId,
          undefined,
          descriptor?.capabilities ?? providerManager.getProviderCapabilities?.(targetProvider, modelId),
          descriptor?.label ?? targetProvider,
        );

        const lines = [
          `*Provider Intelligence: ${snapshot.providerLabel}*`,
          "",
          `Model: ${snapshot.modelId ?? "default"}`,
          `Context Window: ${formatContextWindow(snapshot.contextWindow)} tokens`,
          `Max Messages: ${snapshot.maxMessages}`,
          "",
          `*Strengths*: ${snapshot.strengths.join(", ")}`,
          "",
          `*Limitations*: ${snapshot.limitations.join(", ")}`,
          "",
          `*Hints*: ${snapshot.behavioralHints.join(". ")}`,
        ];
        const officialSignals = descriptor?.officialSnapshot?.signals ?? [];
        if (officialSignals.length > 0) {
          lines.push(
            "",
            `*Official Signals*: ${officialSignals.slice(0, 3).map((signal) => signal.kind === "command" ? signal.value : signal.title).join(" | ")}`,
          );
        }
        await this.channel.sendMarkdown(chatId, lines.join("\n"));
      } catch {
        await this.channel.sendText(chatId, "Provider intelligence module not available.");
      }
      return;
    }

    // reset / sıfırla
    if (subcommand === "reset" || subcommand === "sıfırla") {
      this.providerManager.clearPreference(identityKey);
      const info = this.providerManager.getActiveInfo(identityKey);
      await this.channel.sendMarkdown(
        chatId,
        `Strada reset to the system-default execution worker: \`${info.providerName}\` (model: \`${info.model}\`)`,
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

    this.providerManager.setPreference(identityKey, providerName, model);
    const info = this.providerManager.getActiveInfo(identityKey);
    await this.channel.sendMarkdown(
      chatId,
      [
        `Strada will use \`${info.providerName}\` (model: \`${info.model}\`) as the primary execution worker.`,
        "",
        info.executionPolicyNote,
      ].join("\n"),
    );
  }

  private async handleAutonomous(chatId: string, args: string[], userId?: string): Promise<void> {
    if (!this.dmPolicy || !this.userProfileStore) {
      await this.channel.sendText(chatId, "Autonomous mode requires profile store.");
      return;
    }

    const identityKey = this.getIdentityKey(chatId, userId);
    const subcommand = args[0]?.toLowerCase();

    // status / no args → show current state
    if (!subcommand || subcommand === "status") {
      const result = await this.userProfileStore.isAutonomousMode(identityKey);
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
      await this.userProfileStore.setAutonomousMode(identityKey, true, expiresAt);
      this.dmPolicy.initFromProfile(chatId, { autonomousMode: true, autonomousExpiresAt: expiresAt }, identityKey);
      // Propagate autonomous mode to daemon security policy (with expiry for auto-revocation)
      this.heartbeatLoopRef?.getSecurityPolicy?.()?.setAutonomousOverride(true, expiresAt);

      await this.channel.sendText(
        chatId,
        `Autonomous mode enabled for ${hours} hours. I'll execute tasks without asking for approval.`,
      );
      return;
    }

    // off
    if (subcommand === "off") {
      await this.userProfileStore.setAutonomousMode(identityKey, false);
      this.dmPolicy.initFromProfile(chatId, { autonomousMode: false }, identityKey);
      // Propagate autonomous mode off to daemon security policy
      this.heartbeatLoopRef?.getSecurityPolicy?.()?.setAutonomousOverride(false);

      await this.channel.sendText(
        chatId,
        "Autonomous mode disabled. I'll ask for approval before sensitive operations.",
      );
      return;
    }

    await this.channel.sendText(chatId, "Usage: /autonomous on [hours] | off | status");
  }

  private async handlePersona(chatId: string, args: string[], userId?: string): Promise<void> {
    if (!this.soulLoader) {
      await this.channel.sendText(chatId, "Personality management is not available.");
      return;
    }

    const identityKey = this.getIdentityKey(chatId, userId);
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
            this.userProfileStore.setActivePersona(identityKey, name);
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
            this.userProfileStore.setActivePersona(identityKey, "default");
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

  private async handleDaemon(chatId: string, args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();

    // status / no args → show current state
    if (!subcommand || subcommand === "status") {
      if (!this.heartbeatLoopRef) {
        await this.channel.sendText(chatId, "Daemon mode is not available. Start with --daemon flag.");
        return;
      }
      const running = this.heartbeatLoopRef.isRunning();
      const status = this.heartbeatLoopRef.getDaemonStatus();
      await this.channel.sendMarkdown(
        chatId,
        `*Daemon Status*\n\n` +
        `Status: ${running ? "Running" : "Stopped"}\n` +
        `Triggers: ${status.triggerCount}\n` +
        (status.intervalMs ? `Interval: ${Math.round(status.intervalMs / 1000)}s` : ""),
      );
      return;
    }

    // start
    if (subcommand === "start") {
      if (!this.heartbeatLoopRef) {
        await this.channel.sendText(chatId, "Daemon mode is not available. Start with --daemon flag.");
        return;
      }
      if (this.heartbeatLoopRef.isRunning()) {
        await this.channel.sendText(chatId, "Daemon is already running.");
        return;
      }
      this.heartbeatLoopRef.start();
      await this.channel.sendText(chatId, "Daemon started.");
      return;
    }

    // stop
    if (subcommand === "stop") {
      if (!this.heartbeatLoopRef) {
        await this.channel.sendText(chatId, "Daemon mode is not available.");
        return;
      }
      if (!this.heartbeatLoopRef.isRunning()) {
        await this.channel.sendText(chatId, "Daemon is already stopped.");
        return;
      }
      this.heartbeatLoopRef.stop();
      await this.channel.sendText(chatId, "Daemon stopped.");
      return;
    }

    // triggers
    if (subcommand === "triggers") {
      if (!this.heartbeatLoopRef) {
        await this.channel.sendText(chatId, "Daemon mode is not available.");
        return;
      }
      // Trigger list is exposed through getDaemonStatus
      const status = this.heartbeatLoopRef.getDaemonStatus();
      if (!status.running) {
        await this.channel.sendText(chatId, "Daemon is not running. No active triggers.");
        return;
      }
      await this.channel.sendMarkdown(
        chatId,
        `*Daemon Triggers*\n\n${status.triggerCount} trigger(s) registered.\nUse the dashboard for detailed trigger info.`,
      );
      return;
    }

    await this.channel.sendText(
      chatId,
      "Usage: /daemon | /daemon start | /daemon stop | /daemon triggers (daemon-capable startup required)",
    );
  }

  private async handleAgent(chatId: string, args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();

    if (!subcommand || subcommand === "status") {
      // Show agent core status
      await this.channel.sendMarkdown(
        chatId,
        "*Agent Core Status*\n\n" +
        "Agent Core is the autonomous reasoning engine that observes the environment, " +
        "reasons about what to do, and acts proactively.\n\n" +
        "The agent activates when daemon mode is running with `/autonomous on`.\n\n" +
        "Use `/daemon` to check daemon status.\n" +
        "Use `/autonomous` to check autonomous mode status.",
      );
      return;
    }

    await this.channel.sendText(chatId, "Usage: /agent");
  }

  private async handleRouting(chatId: string, args: string[], userId?: string): Promise<void> {
    const subcommand = args[0]?.toLowerCase();

    // No args → show status
    if (!subcommand || subcommand === "status") {
      const preset = this.providerRouter?.getPreset?.() ?? "balanced";
      const available = this.providerManager?.listAvailable() ?? [];
      await this.channel.sendMarkdown(
        chatId,
        `*Routing Status*\n\n` +
        `Preset: \`${preset}\`\n` +
        `Available Providers: ${available.length}\n` +
        `Phase Switching: ${available.length > 1 ? "Enabled" : "N/A (single provider)"}\n\n` +
        `Strada remains the control plane and uses this preset to bias worker assignment across planning, execution, clarification review, review, and synthesis.\n\n` +
        `Use \`/routing preset <budget|balanced|performance>\` to change.`,
      );
      return;
    }

    // preset <name>
    if (subcommand === "preset") {
      const preset = args[1]?.toLowerCase();
      if (!preset || !["budget", "balanced", "performance"].includes(preset)) {
        await this.channel.sendText(chatId, "Usage: /routing preset <budget|balanced|performance>");
        return;
      }
      this.providerRouter?.setPreset?.(preset as "budget" | "balanced" | "performance");
      await this.channel.sendText(chatId, `Strada routing preset changed to: ${preset}`);
      return;
    }

    // info → recent decisions
    if (subcommand === "info") {
      const identityKey = this.getIdentityKey(chatId, userId);
      const decisions = this.providerRouter?.getRecentDecisions?.(10, identityKey) ?? [];
      const executionTraces = this.providerRouter?.getRecentExecutionTraces?.(10, identityKey) ?? [];
      const phaseOutcomes = this.providerRouter?.getRecentPhaseOutcomes?.(10, identityKey) ?? [];
      const phaseScores = this.providerRouter?.getPhaseScoreboard?.(10, identityKey) ?? [];
      const runtimeArtifacts = this.runtimeArtifactManager?.getRecentArtifactsForIdentity(identityKey, {
        states: ["active", "shadow", "retired", "rejected"],
        limit: 6,
      }).filter((artifact) =>
        projectScopeMatches(artifact.projectWorldFingerprint, this.projectScopeFingerprint),
      ) ?? [];
      if (decisions.length === 0 && executionTraces.length === 0 && phaseOutcomes.length === 0 && phaseScores.length === 0 && runtimeArtifacts.length === 0) {
        await this.channel.sendText(chatId, "No routing decisions recorded yet.");
        return;
      }
      const sections: string[] = [];
      if (decisions.length > 0) {
        const lines = decisions.map((decision) => {
          const catalogSignal = decision.catalogSignal
            ? ` freshness=\`${decision.catalogSignal.freshnessScore.toFixed(2)}\` alignment=\`${decision.catalogSignal.alignmentScore.toFixed(2)}\`${decision.catalogSignal.stale ? " stale=`yes`" : ""}`
            : "";
          return `\`${decision.task.type}\` -> \`${decision.provider}\`${catalogSignal} (${decision.reason})`;
        });
        sections.push(`*Recent Routing Decisions*\n\n${lines.join("\n")}`);
      }
      if (executionTraces.length > 0) {
        const lines = executionTraces.map((trace) => {
          const modelPart = trace.model ? ` model=\`${trace.model}\`` : "";
          return `\`${trace.phase}/${trace.role}\` -> \`${trace.provider}\`${modelPart} source=\`${trace.source}\` (${trace.reason})`;
        });
        sections.push(`*Recent Runtime Execution*\n\n${lines.join("\n")}`);
      }
      if (phaseOutcomes.length > 0) {
        const lines = phaseOutcomes.map((outcome) => {
          const modelPart = outcome.model ? ` model=\`${outcome.model}\`` : "";
          return `\`${outcome.phase}/${outcome.role}\` -> \`${outcome.provider}\`${modelPart} status=\`${outcome.status}\` source=\`${outcome.source}\` (${outcome.reason})`;
        });
        sections.push(`*Recent Phase Outcomes*\n\n${lines.join("\n")}`);
      }
      if (phaseScores.length > 0) {
        const lines = phaseScores.map((entry) =>
          `\`${entry.phase}/${entry.role}\` -> \`${entry.provider}\` score=\`${entry.score.toFixed(2)}\` samples=\`${entry.sampleSize}\` verifier=\`${entry.verifierCleanRate.toFixed(2)}\` rollback=\`${entry.rollbackRate.toFixed(2)}\` retries=\`${entry.avgRetryCount.toFixed(2)}\` cost=\`${Math.round(entry.avgTokenCost)}\` repeats=\`${entry.repeatedFailureCount}\` approved=\`${entry.approvedCount}\` continued=\`${entry.continuedCount}\` replanned=\`${entry.replannedCount}\` failed=\`${entry.failedCount}\``
        );
        sections.push(`*Adaptive Phase Scores*\n\n${lines.join("\n")}`);
      }
      if (runtimeArtifacts.length > 0) {
        const lines = runtimeArtifacts.map((artifact) => {
          const scope = artifact.projectWorldFingerprint ? "project-scoped" : "general";
          const sampleCount = (artifact.stats.shadowSampleCount ?? 0) + (artifact.stats.activeUseCount ?? 0);
          return `\`${artifact.kind}\` state=\`${artifact.state}\` samples=\`${sampleCount}\` clean=\`${artifact.stats.cleanCount}\` retry=\`${artifact.stats.retryCount}\` failed=\`${artifact.stats.failureCount}\` blocker=\`${artifact.stats.blockerCount}\` scope=\`${scope}\` (${artifact.lastStateReason ?? artifact.description})`;
        });
        sections.push(`*Runtime Self-Improvement*\n\n${lines.join("\n")}`);
      }
      await this.channel.sendMarkdown(chatId, sections.join("\n\n"));
      return;
    }

    await this.channel.sendText(chatId, "Usage: /routing | /routing preset <name> | /routing info");
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
