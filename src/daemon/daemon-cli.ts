/**
 * Daemon CLI Commands
 *
 * Commander subcommands for daemon management:
 *   strada daemon status  -- Show heartbeat state, triggers, budget, pending approvals
 *   strada daemon trigger -- Manually fire a named trigger
 *   strada daemon reset   -- Reset circuit breaker for a trigger to CLOSED
 *   strada daemon audit   -- Show recent approval/denial decisions
 *   strada daemon config  -- Show all daemon settings
 *   strada daemon budget  -- Budget management (reset)
 *   strada daemon digest  -- Send immediate digest (or --dry-run to preview)
 *   strada daemon notifications -- Show notification history
 *   strada daemon notify  -- Send a test notification
 *   strada daemon chain:status -- Show tool chain resilience status
 *
 * Uses callback-based DI: getDaemonContext() returns the daemon context when
 * these commands run inside the runtime process. `strada daemon …` typed at a
 * shell runs in a separate CLI process where it is always undefined (COR-13):
 * there, every command reaches the running runtime over its dashboard API. The
 * read-only ones GET it like any dashboard client; the ones that change state
 * POST with the runtime's local operator credential (a per-run token the
 * runtime writes under the config root, readable by its OS user only). None
 * claims the daemon is "not running", which that process cannot know.
 *
 * Requirements: DAEMON-01, DAEMON-04, RPT-01, RPT-03
 */

import type { Command } from "commander";
import type { HeartbeatLoop } from "./heartbeat-loop.js";
import type { TriggerRegistry } from "./trigger-registry.js";
import type { BudgetTracker } from "./budget/budget-tracker.js";
import type { ApprovalQueue } from "./security/approval-queue.js";
import type { DaemonStorage } from "./daemon-storage.js";
import type { DaemonConfig } from "./daemon-types.js";
import type { CircuitBreaker } from "./resilience/circuit-breaker.js";
import type { DigestReporter } from "./reporting/digest-reporter.js";
import type { NotificationRouter } from "./reporting/notification-router.js";
import type { UrgencyLevel } from "./reporting/notification-types.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type { LearningStorage } from "../learning/storage/learning-storage.js";
import type { AgentId } from "../agents/multi/agent-types.js";
import {
  ChainMetadataV2Schema,
  ChainMetadataSchema,
  migrateV1toV2,
  DEFAULT_RESILIENCE_CONFIG,
} from "../learning/chains/chain-types.js";
import { computeChainWaves } from "../learning/chains/chain-dag.js";
import type { ChainResilienceConfig, ChainMetadataV2 } from "../learning/chains/chain-types.js";
import { z } from "zod";
import type { DashboardClientResolution, OperatorClientResolution } from "../core/daemon-dashboard-client.js";

/**
 * Context for daemon CLI commands. Provided via callback since daemon
 * may not be initialized at CLI registration time.
 */
export interface DaemonContext {
  heartbeatLoop: HeartbeatLoop;
  registry: TriggerRegistry;
  budgetTracker: BudgetTracker;
  approvalQueue: ApprovalQueue;
  storage: DaemonStorage;
  config: DaemonConfig;
  digestReporter?: DigestReporter;
  notificationRouter?: NotificationRouter;
  memoryManager?: IMemoryManager;
  learningStorage?: LearningStorage;
  chainResilienceConfig?: ChainResilienceConfig;
  agentManager?: import("../agents/multi/agent-manager.js").AgentManager;
  agentBudgetTracker?: import("../agents/multi/agent-budget-tracker.js").AgentBudgetTracker;
  delegationManager?: import("../agents/multi/delegation/delegation-manager.js").DelegationManager;
  delegationLog?: import("../agents/multi/delegation/delegation-log.js").DelegationLog;
  tierRouter?: import("../agents/multi/delegation/tier-router.js").TierRouter;
  consolidationEngine?: {
    getStats(): { perTier: Record<string, { clustered: number; pending: number; total: number }>; lifetimeSavings: number; totalRuns: number; totalCostUsd: number };
    preview(): Promise<{ clusters: Array<{ seedId: string; memberIds: string[]; avgSimilarity: number; tier: string }>; estimatedCostPerCluster: number; totalEstimatedCost: number }>;
    runCycle(signal: AbortSignal): Promise<{ status: string; processed: number; remaining: number; clustersFound: number; costUsd: number }>;
    undo(logId: string): void | Promise<void>;
  };
  deploymentExecutor?: {
    getHistory(limit?: number): Array<{ id: string; proposedAt: number; approvedAt?: number; approvedBy?: string; agentId?: string; status: string; scriptOutput?: string; duration?: number; error?: string }>;
    getStats(): { totalDeployments: number; successful: number; failed: number; lastDeployment?: unknown; circuitBreakerState: string };
  };
  readinessChecker?: {
    checkReadiness(force?: boolean): Promise<{ ready: boolean; reason?: string; testPassed: boolean; gitClean: boolean; branchMatch: boolean; timestamp: number; cached: boolean }>;
  };
  deployTrigger?: {
    triggerReadinessCheck(): Promise<{ ready: boolean; reason?: string; testPassed: boolean; gitClean: boolean; branchMatch: boolean; timestamp: number; cached: boolean }>;
    onApprovalDecided(decision: string, proposalId: string, decidedBy?: string): void;
  };
}

/**
 * Register daemon management subcommands on the given Commander program.
 *
 * @param program - The root Commander program
 * @param getDaemonContext - Callback returning the in-process daemon context, or undefined outside the runtime process
 * @param getDashboardClient - Resolves a client for the running runtime's dashboard API (used when there is no in-process context)
 * @param getOperatorClient - Resolves the local operator client that commands changing state post with (likewise)
 */
export function registerDaemonCommands(
  program: Command,
  getDaemonContext: () => DaemonContext | undefined,
  getDashboardClient?: () => DashboardClientResolution,
  getOperatorClient?: () => Promise<OperatorClientResolution>,
): void {
  const post = <S extends z.ZodType>(what: string, path: string, body: Record<string, unknown>, schema: S, options?: PostOptions) =>
    postToDashboard(what, path, body, schema, getOperatorClient, options);

  const daemon = program
    .command("daemon")
    .description("Daemon management commands");

  // =========================================================================
  // daemon status
  // =========================================================================
  daemon
    .command("status")
    .description("Show daemon heartbeat state, triggers, budget, and pending approvals")
    .action(async () => {
      const ctx = getDaemonContext();
      if (!ctx) {
        await printRemoteDaemonStatus(getDashboardClient);
        return;
      }

      const status = ctx.heartbeatLoop.getDaemonStatus();
      const triggers = ctx.registry.getAll();
      const pending = ctx.approvalQueue.getPending();

      // Header
      console.log(`Daemon: ${status.running ? "running" : "stopped"}`);
      console.log(`Heartbeat interval: ${status.intervalMs}ms`);
      console.log(`Last tick: ${status.lastTick ? status.lastTick.toISOString() : "never"}`);
      console.log("");

      // Trigger table
      if (triggers.length > 0) {
        console.log("Triggers:");
        console.log(
          padRight("Name", 25) +
          padRight("Type", 10) +
          padRight("State", 12) +
          padRight("Circuit", 12) +
          padRight("Next Run", 25),
        );
        console.log("-".repeat(84));

        for (const trigger of triggers) {
          const name = trigger.metadata.name;
          const circuitBreaker = ctx.heartbeatLoop.getCircuitBreaker(name);
          const circuitState = circuitBreaker ? circuitBreaker.getState() : "CLOSED";
          const nextRun = trigger.getNextRun();

          // Display next run based on trigger type
          let nextRunStr: string;
          if (nextRun) {
            nextRunStr = nextRun.toISOString();
          } else if (trigger.metadata.type === "file-watch" || trigger.metadata.type === "webhook") {
            nextRunStr = "event-driven";
          } else if (trigger.metadata.type === "checklist") {
            nextRunStr = "on-tick";
          } else {
            nextRunStr = "N/A";
          }

          console.log(
            padRight(name, 25) +
            padRight(trigger.metadata.type, 10) +
            padRight(trigger.getState(), 12) +
            padRight(circuitState, 12) +
            padRight(nextRunStr, 25),
          );
        }
        console.log("");
      } else {
        console.log("Triggers: none registered");
        console.log("");
      }

      // Budget
      const budget = status.budgetUsage;
      const limitStr = budget.limitUsd !== undefined ? budget.limitUsd.toFixed(2) : "unlimited";
      const pctStr = budget.limitUsd !== undefined ? `(${(budget.pct * 100).toFixed(1)}%)` : "";
      console.log(`Budget: $${budget.usedUsd.toFixed(2)} / $${limitStr} ${pctStr}`);

      // Dedup stats
      const deduplicator = ctx.heartbeatLoop.getDeduplicator();
      if (deduplicator) {
        const dedupStats = deduplicator.getStats();
        if (dedupStats.totalSuppressed > 0) {
          console.log(`Dedup: ${dedupStats.totalSuppressed} suppressed (${dedupStats.byCooldown} cooldown, ${dedupStats.byContentDupe} content)`);
        }
      }

      // Pending approvals
      console.log(`Pending approvals: ${pending.length}`);
    });

  // =========================================================================
  // daemon trigger <name>
  // =========================================================================
  daemon
    .command("trigger <name>")
    .description("Fire a named trigger now, through the same gates as a scheduled fire")
    .action(async (name: string) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        // A refusal (404, 409) carries the same answer the runtime would print.
        const answer = await post(`fire trigger '${name}'`, "/api/daemon/trigger", { name }, RemoteTriggerFireSchema, { answersRefusals: true });
        if (answer) printTriggerFire(name, answer);
        return;
      }

      // The fire path of a heartbeat tick: budget, circuit breaker, dedup,
      // approval. Calling onFired() alone recorded a fire and ran nothing.
      printTriggerFire(name, ctx.heartbeatLoop.fireNow(name));
    });

  // =========================================================================
  // daemon reset <name>
  // =========================================================================
  daemon
    .command("reset <name>")
    .description("Reset circuit breaker for a named trigger to CLOSED")
    .action(async (name: string) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        if (await post(`reset the circuit breaker for '${name}'`, "/api/daemon/circuit/reset", { name }, RemoteStatusSchema)) {
          printCircuitReset(name);
        }
        return;
      }

      const cb = ctx.heartbeatLoop.getCircuitBreaker(name);
      if (!cb) {
        console.error(`No circuit breaker found for trigger '${name}'`);
        return;
      }

      cb.reset();

      // Persist reset state
      persistCircuitState(ctx.storage, name, cb);

      printCircuitReset(name);
    });

  // =========================================================================
  // daemon audit
  // =========================================================================
  daemon
    .command("audit")
    .description("Show recent approval/denial decisions")
    .option("--limit <n>", "Number of entries to show", "20")
    .action(async (opts: { limit: string }) => {
      const ctx = getDaemonContext();
      const limit = parseInt(opts.limit, 10) || 20;
      if (!ctx) {
        const read = await readFromDashboard("the audit log", `/api/daemon/audit?limit=${limit}`, RemoteAuditSchema, getDashboardClient);
        if (!read) return;
        if (!read.data.enabled) {
          console.log(read.data.reason);
          return;
        }
        printAuditLog(read.data.entries);
        return;
      }

      printAuditLog(ctx.approvalQueue.getAuditLog(limit));
    });

  // =========================================================================
  // daemon config
  // =========================================================================
  daemon
    .command("config")
    .description("Show all daemon settings")
    .action(async () => {
      const ctx = getDaemonContext();
      if (!ctx) {
        await printRemoteDaemonConfig(getDashboardClient);
        return;
      }

      printDaemonConfig((settingPath) =>
        settingPath.split(".").reduce<unknown>(
          (node, key) => (node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
          ctx.config,
        ));
    });

  // =========================================================================
  // daemon budget (subcommand group)
  // =========================================================================
  const budgetCmd = daemon
    .command("budget")
    .description("Budget management commands");

  budgetCmd
    .command("reset")
    .description("Clear the budget counter")
    .action(async () => {
      const ctx = getDaemonContext();
      if (!ctx) {
        if (await post("reset the daemon budget", "/api/daemon/budget/reset", {}, RemoteStatusSchema)) printBudgetReset();
        return;
      }

      ctx.budgetTracker.resetBudget();
      printBudgetReset();
    });

  // =========================================================================
  // daemon digest
  // =========================================================================
  daemon
    .command("digest")
    .description("Send an immediate digest to the active channel")
    .option("--dry-run", "Format digest and print to stdout instead of sending")
    .action(async (opts: { dryRun?: boolean }) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        if (opts.dryRun) {
          // A dry run only reads: the digest as it would be sent now.
          const read = await readFromDashboard("the digest preview", "/api/daemon/digest/preview", RemoteDigestPreviewSchema, getDashboardClient);
          if (!read) return;
          if (!read.data.enabled) {
            console.log(read.data.reason);
            return;
          }
          printDigestPreview(read.data.markdown);
        } else if (await post("send the digest", "/api/daemon/digest/send", {}, RemoteStatusSchema)) {
          printDigestSent();
        }
        return;
      }

      if (!ctx.digestReporter) {
        console.error("DigestReporter is not available.");
        return;
      }

      if (opts.dryRun) {
        // --dry-run must not deliver: sendDigest() sends and moves the
        // "since last digest" baseline.
        printDigestPreview(ctx.digestReporter.previewDigest());
      } else {
        await ctx.digestReporter.sendDigest();
        printDigestSent();
      }
    });

  // =========================================================================
  // daemon notifications
  // =========================================================================
  daemon
    .command("notifications")
    .description("Show recent notification history")
    .option("--level <level>", "Filter by urgency level")
    .option("--limit <n>", "Number of entries to show", "20")
    .action(async (opts: { level?: string; limit: string }) => {
      const ctx = getDaemonContext();
      const limit = parseInt(opts.limit, 10) || 20;
      const levelFilter = opts.level && VALID_LEVELS.includes(opts.level as UrgencyLevel)
        ? opts.level as UrgencyLevel
        : undefined;
      if (!ctx) {
        if (opts.level && !levelFilter) {
          console.error(`Invalid level filter: ${opts.level}. Must be one of: ${VALID_LEVELS.join(", ")}`);
          process.exitCode = 1;
          return;
        }
        const query = new URLSearchParams({ limit: String(limit), ...(levelFilter ? { level: levelFilter } : {}) });
        const read = await readFromDashboard("the notification history", `/api/daemon/notifications?${query.toString()}`, RemoteNotificationsSchema, getDashboardClient);
        if (!read) return;
        if (!read.data.enabled) {
          console.log(read.data.reason);
          return;
        }
        printNotifications(read.data.entries);
        return;
      }

      if (!ctx.notificationRouter) {
        console.error("NotificationRouter is not available.");
        return;
      }

      if (opts.level && !levelFilter) {
        console.error(`Invalid level filter: ${opts.level}. Must be one of: ${VALID_LEVELS.join(", ")}`);
        return;
      }
      printNotifications(ctx.notificationRouter.getHistory(limit, levelFilter));
    });

  // =========================================================================
  // daemon notify
  // =========================================================================
  daemon
    .command("notify")
    .description("Send a test notification")
    .requiredOption("--level <level>", "Urgency level (silent, low, medium, high, critical)")
    .requiredOption("--message <message>", "Notification message")
    .action(async (opts: { level: string; message: string }) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        if (!VALID_LEVELS.includes(opts.level as UrgencyLevel)) {
          console.error(`Invalid level: ${opts.level}. Must be one of: ${VALID_LEVELS.join(", ")}`);
          process.exitCode = 1;
          return;
        }
        const body = { level: opts.level, message: opts.message };
        if (await post("send the notification", "/api/daemon/notify", body, RemoteStatusSchema)) printNotificationSent(opts.level);
        return;
      }

      if (!ctx.notificationRouter) {
        console.error("NotificationRouter is not available.");
        return;
      }

      if (!VALID_LEVELS.includes(opts.level as UrgencyLevel)) {
        console.error(`Invalid level: ${opts.level}. Must be one of: ${VALID_LEVELS.join(", ")}`);
        return;
      }

      await ctx.notificationRouter.notify({
        level: opts.level as UrgencyLevel,
        title: "Manual test",
        message: opts.message,
        timestamp: Date.now(),
      });
      printNotificationSent(opts.level);
    });

  // =========================================================================
  // daemon memory:decay-status
  // =========================================================================
  daemon
    .command("memory:decay-status")
    .description("Show memory decay status per tier")
    .option("--json", "Output as JSON instead of table")
    .action(async (opts: { json?: boolean }) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        await printRemoteDecayStatus(opts, getDashboardClient);
        return;
      }

      if (!ctx.memoryManager?.getDecayStats) {
        console.error("Memory decay stats not available (memory manager does not support getDecayStats)");
        process.exitCode = 1;
        return;
      }

      const stats = ctx.memoryManager.getDecayStats();

      if (!stats.enabled) {
        console.log("Memory decay is disabled (MEMORY_DECAY_ENABLED=false)");
        return;
      }

      printDecayStats(stats, opts.json);
    });

  // =========================================================================
  // daemon chain:status (Plan 22-04)
  // =========================================================================
  daemon
    .command("chain:status")
    .description("Show tool chain resilience status")
    .option("--json", "Output as JSON instead of table")
    .action(async (opts: { json?: boolean }) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        await printRemoteChainStatus(opts, getDashboardClient);
        return;
      }

      if (!ctx.learningStorage) {
        console.error("Learning storage not available");
        process.exitCode = 1;
        return;
      }

      // Load active tool_chain instincts
      const instincts = ctx.learningStorage
        .getInstincts({ type: "tool_chain" })
        .filter((i) => i.status === "active" || i.status === "permanent");

      if (instincts.length === 0) {
        console.log("No active tool chains");
        return;
      }

      // Parse chain metadata
      const chains: Array<{
        name: string;
        steps: number;
        topology: string;
        rollback: boolean;
        parallel: boolean;
        successRate: number;
        occurrences: number;
        v2Meta: ChainMetadataV2 | null;
      }> = [];

      for (const instinct of instincts) {
        try {
          const parsed = JSON.parse(instinct.action);

          // Try V2 first, then V1 with migration
          const v2Result = ChainMetadataV2Schema.safeParse(parsed);
          const v1Result = !v2Result.success ? ChainMetadataSchema.safeParse(parsed) : null;

          let v2Meta: ChainMetadataV2 | null = null;

          if (v2Result.success) {
            v2Meta = v2Result.data;
          } else if (v1Result?.success) {
            v2Meta = migrateV1toV2(v1Result.data);
          } else {
            continue;
          }

          const topology = buildTopologyString(v2Meta);
          const hasParallel = v2Meta.steps.some(
            (s, i) => i > 0 && s.dependsOn.length === 0,
          );

          chains.push({
            name: instinct.name,
            steps: v2Meta.steps.length,
            topology,
            rollback: v2Meta.isFullyReversible,
            parallel: hasParallel,
            successRate: v2Meta.successRate,
            occurrences: v2Meta.occurrences,
            v2Meta,
          });
        } catch {
          // Skip unparseable chains
        }
      }

      if (chains.length === 0) {
        console.log("No active tool chains");
        return;
      }

      const resilienceConfig = ctx.chainResilienceConfig ?? DEFAULT_RESILIENCE_CONFIG;

      if (opts.json) {
        const jsonOutput = {
          chains: chains.map((c) => ({
            name: c.name,
            steps: c.v2Meta?.steps ?? [],
            topology: c.topology,
            rollbackCapable: c.rollback,
            parallelCapable: c.parallel,
            successRate: c.successRate,
            occurrences: c.occurrences,
          })),
          config: resilienceConfig,
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
        return;
      }

      // Table format
      console.log("Tool Chain Resilience Status:");
      console.log("");
      console.log(
        padRight("Name", 25) +
        padRight("Steps", 7) +
        padRight("Topology", 35) +
        padRight("Rollback", 10) +
        padRight("Parallel", 10) +
        padRight("Success", 10) +
        padRight("Runs", 8),
      );
      console.log("-".repeat(105));

      for (const c of chains) {
        console.log(
          padRight(c.name.length > 24 ? c.name.slice(0, 22) + ".." : c.name, 25) +
          padRight(String(c.steps), 7) +
          padRight(c.topology.length > 34 ? c.topology.slice(0, 32) + ".." : c.topology, 35) +
          padRight(c.rollback ? "Yes" : "No", 10) +
          padRight(c.parallel ? "Yes" : "No", 10) +
          padRight((c.successRate * 100).toFixed(1) + "%", 10) +
          padRight(String(c.occurrences), 8),
        );
      }

      console.log("");
      printResilienceConfigLine(resilienceConfig);
    });

  // =========================================================================
  // Agent management commands (Plan 23-03: AGENT-01, AGENT-02, AGENT-06)
  // =========================================================================
  const agent = daemon.command("agent").description("Multi-agent management commands");

  // agent list -- combined view of all agents
  agent
    .command("list")
    .description("List all agent sessions")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        await printRemoteAgents(opts, getDashboardClient);
        return;
      }
      if (!ctx.agentManager) {
        console.error("Multi-agent mode is not enabled.");
        process.exitCode = 1;
        return;
      }
      const agents = ctx.agentManager.getAllAgents();
      if (opts.json) {
        console.log(JSON.stringify(agents, null, 2));
        return;
      }
      if (agents.length === 0) {
        console.log("No active agents.");
        return;
      }

      const usages = ctx.agentBudgetTracker?.getAllAgentUsages();
      printAgentTable(agents.map((a) => ({ ...a, budgetUsed: usages?.get(a.id as AgentId) ?? 0 })));
    });

  // agent status <id> -- detailed info for specific agent
  agent
    .command("status <id>")
    .description("Show detailed agent status")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      if (!isValidAgentId(id)) return;
      const ctx = getDaemonContext();
      if (!ctx) {
        await printRemoteAgentStatus(id, opts, getDashboardClient);
        return;
      }
      if (!ctx.agentManager) {
        console.error("Multi-agent mode is not enabled.");
        process.exitCode = 1;
        return;
      }
      const agentInstance = ctx.agentManager.getAgent(id as AgentId);
      if (!agentInstance) {
        console.error(`Agent '${id}' not found.`);
        process.exitCode = 1;
        return;
      }

      const usage = ctx.agentBudgetTracker?.getAgentUsage(
        agentInstance.id as AgentId,
        agentInstance.budgetCapUsd,
      );

      printAgentDetail(agentInstance, { usedUsd: usage?.usedUsd ?? 0, pct: usage?.pct ?? 0 }, opts.json);
    });

  // agent stop <id> -- graceful stop (--force for hard stop)
  agent
    .command("stop <id>")
    .description("Stop an agent session")
    .option("--force", "Hard stop (close memory immediately)")
    .action(async (id: string, opts: { force?: boolean }) => {
      if (!isValidAgentId(id)) return;
      const ctx = getDaemonContext();
      if (!ctx) {
        const body = opts.force ? { force: true } : {};
        if (await post(`stop agent '${id}'`, `/api/agents/${id}/stop`, body, RemoteStatusSchema)) printAgentStopped(id, opts.force);
        return;
      }
      if (!ctx.agentManager) {
        console.error("Multi-agent mode is not enabled.");
        process.exitCode = 1;
        return;
      }
      try {
        await ctx.agentManager.stopAgent(id as AgentId, opts.force);
        printAgentStopped(id, opts.force);
      } catch (err) {
        console.error(`Failed to stop agent: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // agent start <id> -- resume a stopped agent
  agent
    .command("start <id>")
    .description("Resume a stopped agent")
    .action(async (id: string) => {
      if (!isValidAgentId(id)) return;
      const ctx = getDaemonContext();
      if (!ctx) {
        if (await post(`start agent '${id}'`, `/api/agents/${id}/start`, {}, RemoteStatusSchema)) printAgentStarted(id);
        return;
      }
      if (!ctx.agentManager) {
        console.error("Multi-agent mode is not enabled.");
        process.exitCode = 1;
        return;
      }
      try {
        await ctx.agentManager.startAgent(id as AgentId);
        printAgentStarted(id);
      } catch (err) {
        console.error(`Failed to start agent: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // agent budget set <id> <amount> -- change per-agent budget cap
  const agentBudgetCmd = agent.command("budget").description("Agent budget management");
  agentBudgetCmd
    .command("set <id> <amount>")
    .description("Set per-agent budget cap (USD)")
    .action(async (id: string, amount: string) => {
      if (!isValidAgentId(id)) return;
      const usd = parseFloat(amount);
      if (!Number.isFinite(usd) || usd <= 0) {
        console.error("Invalid amount. Must be a positive number.");
        process.exitCode = 1;
        return;
      }
      const ctx = getDaemonContext();
      if (!ctx) {
        if (await post(`set agent '${id}' budget cap`, `/api/agents/${id}/budget`, { usd }, RemoteStatusSchema)) printAgentBudgetSet(id, usd);
        return;
      }
      if (!ctx.agentManager) {
        console.error("Multi-agent mode is not enabled.");
        process.exitCode = 1;
        return;
      }
      ctx.agentManager.setBudgetCap(id as AgentId, usd);
      printAgentBudgetSet(id, usd);
    });

  // =========================================================================
  // Delegation management commands (Plan 24-03: AGENT-03, AGENT-04, AGENT-05)
  // =========================================================================

  // delegation:history -- show delegation audit log
  daemon
    .command("delegation:history")
    .description("Show delegation audit log entries")
    .option("--limit <n>", "Number of entries to show", "20")
    .option("--type <type>", "Filter by delegation type")
    .option("--json", "Output as JSON")
    .action(async (opts: { limit: string; type?: string; json?: boolean }) => {
      const ctx = getDaemonContext();
      const limit = parseInt(opts.limit, 10) || 20;
      if (!ctx) {
        const read = await readDelegations(getDashboardClient);
        if (!read) return;
        if (read.history.length === DASHBOARD_DELEGATION_HISTORY && limit > DASHBOARD_DELEGATION_HISTORY) {
          console.error(`The dashboard reports the ${DASHBOARD_DELEGATION_HISTORY} most recent delegations; showing those.`);
        }
        printDelegationHistory(read.history.slice(0, limit), opts);
        return;
      }
      if (!ctx.delegationLog) {
        console.log("Task delegation is not enabled");
        return;
      }

      printDelegationHistory(ctx.delegationLog.getHistory(limit), opts);
    });

  // delegation:stats -- show aggregate stats per delegation type
  daemon
    .command("delegation:stats")
    .description("Show aggregate delegation statistics")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const ctx = getDaemonContext();
      let stats: ReadonlyArray<DelegationStatsRow>;
      if (!ctx) {
        const read = await readDelegations(getDashboardClient);
        if (!read) return;
        stats = read.stats;
      } else if (!ctx.delegationLog) {
        console.log("Task delegation is not enabled");
        return;
      } else {
        stats = ctx.delegationLog.getStats();
      }

      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      if (stats.length === 0) {
        console.log("No delegation statistics available.");
        return;
      }

      console.log("Delegation Statistics:");
      console.log(
        padRight("Type", 20) +
        padRight("Count", 8) +
        padRight("Avg Duration", 15) +
        padRight("Avg Cost", 12) +
        padRight("Success Rate", 14) +
        padRight("Tier Breakdown", 30),
      );
      console.log("-".repeat(99));

      for (const s of stats) {
        const tierStr = Object.entries(s.tierBreakdown)
          .map(([tier, count]) => `${tier}:${count}`)
          .join(", ");
        console.log(
          padRight(s.type, 20) +
          padRight(String(s.count), 8) +
          padRight(`${Math.round(s.avgDurationMs)}ms`, 15) +
          padRight(`$${s.avgCostUsd.toFixed(4)}`, 12) +
          padRight(`${(s.successRate * 100).toFixed(1)}%`, 14) +
          padRight(tierStr, 30),
        );
      }
    });

  // delegation:watch -- show currently active delegations
  daemon
    .command("delegation:watch")
    .description("Show currently active delegations")
    .action(async () => {
      const ctx = getDaemonContext();
      let active: ReadonlyArray<{ subAgentId: string; type: string; startedAt: number; elapsedMs?: number }>;
      if (!ctx) {
        const read = await readDelegations(getDashboardClient);
        if (!read) return;
        active = read.active;
      } else if (!ctx.delegationManager) {
        console.log("Task delegation is not enabled");
        return;
      } else {
        active = ctx.delegationManager.getActiveDelegations();
      }

      if (active.length === 0) {
        console.log("No active delegations");
        return;
      }

      const now = Date.now();
      console.log("Active Delegations:");
      console.log(
        padRight("Sub-Agent ID", 38) +
        padRight("Type", 20) +
        padRight("Duration", 12),
      );
      console.log("-".repeat(70));

      for (const d of active) {
        // The runtime's own measure when it sent one: no cross-process clock skew.
        const elapsed = formatDuration(d.elapsedMs ?? now - d.startedAt);
        console.log(
          padRight(d.subAgentId, 38) +
          padRight(d.type, 20) +
          padRight(elapsed, 12),
        );
      }
    });

  // delegation:tier -- set runtime tier override
  daemon
    .command("delegation:tier <type> <tier>")
    .description("Set runtime tier override for a delegation type")
    .action(async (type: string, tier: string) => {
      const ctx = getDaemonContext();
      const validTiers = ["local", "cheap", "standard", "premium"];
      if (!ctx) {
        if (!validTiers.includes(tier)) {
          console.error(`Invalid tier: ${tier}. Must be one of: ${validTiers.join(", ")}`);
          process.exitCode = 1;
          return;
        }
        if (await post("set the tier override", "/api/delegations/tier", { type, tier }, RemoteStatusSchema)) printTierOverrideSet(type, tier);
        return;
      }
      if (!ctx.tierRouter) {
        console.log("Task delegation is not enabled");
        return;
      }

      if (!validTiers.includes(tier)) {
        console.error(`Invalid tier: ${tier}. Must be one of: ${validTiers.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      ctx.tierRouter.setOverride(type, tier as "local" | "cheap" | "standard" | "premium");
      printTierOverrideSet(type, tier);
    });

  // =========================================================================
  // Memory Consolidation commands (Plan 25-03: MEM-12, MEM-13)
  // =========================================================================
  daemon
    .command("memory:consolidation-status")
    .description("Show memory consolidation status per tier")
    .option("--json", "Output as JSON instead of table")
    .action(async (opts: { json?: boolean }) => {
      const ctx = getDaemonContext();
      let stats: ConsolidationStatsRow;
      if (!ctx) {
        const read = await readFromDashboard("the consolidation status", "/api/consolidation", RemoteConsolidationSchema, getDashboardClient);
        if (!read) return;
        if (!read.data.enabled) {
          console.log("Memory consolidation is not active in the running Strada (MEMORY_CONSOLIDATION_ENABLED=false, or daemon mode is off)");
          return;
        }
        const { perTier, lifetimeSavings, totalRuns, totalCostUsd } = read.data;
        stats = { perTier, lifetimeSavings, totalRuns, totalCostUsd };
      } else if (!ctx.consolidationEngine) {
        console.log("Memory consolidation is disabled (MEMORY_CONSOLIDATION_ENABLED=false)");
        return;
      } else {
        stats = ctx.consolidationEngine.getStats();
      }

      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log("Memory Consolidation Status:");
      console.log("");
      console.log(
        padRight("Tier", 14) +
        padLeft("Total", 10) +
        padLeft("Clustered", 12) +
        padLeft("Pending", 10),
      );
      console.log("-".repeat(46));

      const tierNames = ["working", "ephemeral", "persistent"];
      for (const name of tierNames) {
        const t = stats.perTier[name];
        if (!t) continue;
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);
        console.log(
          padRight(displayName, 14) +
          padLeft(String(t.total), 10) +
          padLeft(String(t.clustered), 12) +
          padLeft(String(t.pending), 10),
        );
      }

      console.log("");
      console.log(`Lifetime: ${stats.totalRuns} runs, ${stats.lifetimeSavings} entries saved, $${stats.totalCostUsd.toFixed(4)} total cost`);
    });

  daemon
    .command("memory:consolidation-preview")
    .description("Dry-run showing clusters, similarity scores, estimated cost")
    .option("--json", "Output as JSON instead of table")
    .action(async (opts: { json?: boolean }) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        const read = await readFromDashboard("the consolidation preview", "/api/consolidation/preview", RemoteConsolidationPreviewSchema, getDashboardClient);
        if (!read) return;
        if (!read.data.enabled) {
          console.log(CONSOLIDATION_NOT_ACTIVE);
          return;
        }
        const { clusters, estimatedCostPerCluster, totalEstimatedCost } = read.data;
        printConsolidationPreview({ clusters, estimatedCostPerCluster, totalEstimatedCost }, opts.json);
        return;
      }

      if (!ctx.consolidationEngine) {
        console.log("Memory consolidation is disabled (MEMORY_CONSOLIDATION_ENABLED=false)");
        return;
      }

      printConsolidationPreview(await ctx.consolidationEngine.preview(), opts.json);
    });

  daemon
    .command("memory:consolidate")
    .description("Manually trigger memory consolidation")
    .option("--force", "Bypass idle check")
    .action(async (opts: { force?: boolean }) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        printConsolidationStart(opts.force);
        const result = await post("run memory consolidation", "/api/consolidation/run", {}, RemoteConsolidationRunSchema, { timeoutMs: LONG_OPERATION_TIMEOUT_MS });
        if (result) printConsolidationResult(result);
        return;
      }

      if (!ctx.consolidationEngine) {
        console.log("Memory consolidation is disabled (MEMORY_CONSOLIDATION_ENABLED=false)");
        return;
      }

      printConsolidationStart(opts.force);
      const controller = new AbortController();
      printConsolidationResult(await ctx.consolidationEngine.runCycle(controller.signal));
    });

  daemon
    .command("memory:consolidation-undo <logId>")
    .description("Undo a consolidation by restoring originals and removing summary")
    .action(async (logId: string) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        if (await post(`undo consolidation '${logId}'`, "/api/consolidation/undo", { logId }, RemoteStatusSchema)) {
          printConsolidationUndone(logId);
        }
        return;
      }

      if (!ctx.consolidationEngine) {
        console.log("Memory consolidation is disabled (MEMORY_CONSOLIDATION_ENABLED=false)");
        return;
      }

      try {
        await ctx.consolidationEngine.undo(logId);
        printConsolidationUndone(logId);
      } catch (err) {
        console.error(`Failed to undo: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // =========================================================================
  // Deployment commands (Plan 25-03: DEPLOY-01, DEPLOY-02, DEPLOY-03)
  // =========================================================================
  daemon
    .command("deploy:status")
    .description("Show current deployment state, circuit breaker, last readiness check")
    .option("--json", "Output as JSON instead of table")
    .action(async (opts: { json?: boolean }) => {
      const ctx = getDaemonContext();
      let stats: DeploymentStatsRow;
      if (!ctx) {
        const read = await readDeployment(getDashboardClient);
        if (!read) return;
        stats = read.stats;
      } else if (!ctx.deploymentExecutor) {
        console.log("Deployment is disabled (DEPLOY_ENABLED=false)");
        return;
      } else {
        stats = ctx.deploymentExecutor.getStats();
      }

      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log("Deployment Status:");
      console.log(`  Total deployments: ${stats.totalDeployments}`);
      console.log(`  Successful: ${stats.successful}`);
      console.log(`  Failed: ${stats.failed}`);
      console.log(`  Circuit breaker: ${stats.circuitBreakerState}`);
      if (stats.lastDeployment) {
        const last = stats.lastDeployment as Record<string, unknown>;
        console.log(`  Last deployment: ${new Date(last["proposedAt"] as number).toISOString()} (${last["status"]})`);
      }
    });

  daemon
    .command("deploy:history")
    .description("Show recent deployment history")
    .option("--limit <n>", "Number of entries to show", "10")
    .option("--json", "Output as JSON instead of table")
    .action(async (opts: { limit: string; json?: boolean }) => {
      const ctx = getDaemonContext();
      const limit = parseInt(opts.limit, 10) || 10;
      let history: ReadonlyArray<DeploymentHistoryRow>;
      if (!ctx) {
        const read = await readDeployment(getDashboardClient);
        if (!read) return;
        if (read.history.length === DASHBOARD_DEPLOYMENT_HISTORY && limit > DASHBOARD_DEPLOYMENT_HISTORY) {
          console.error(`The dashboard reports the ${DASHBOARD_DEPLOYMENT_HISTORY} most recent deployments; showing those.`);
        }
        history = read.history.slice(0, limit);
      } else if (!ctx.deploymentExecutor) {
        console.log("Deployment is disabled (DEPLOY_ENABLED=false)");
        return;
      } else {
        history = ctx.deploymentExecutor.getHistory(limit);
      }

      if (opts.json) {
        console.log(JSON.stringify(history, null, 2));
        return;
      }

      if (history.length === 0) {
        console.log("No deployment history.");
        return;
      }

      console.log("Deployment History:");
      console.log(
        padRight("Timestamp", 25) +
        padRight("Status", 20) +
        padRight("Duration", 12) +
        padRight("Approved By", 15),
      );
      console.log("-".repeat(72));

      for (const e of history) {
        const ts = new Date(e.proposedAt).toISOString();
        const durationStr = e.duration != null ? `${e.duration}ms` : "-";
        console.log(
          padRight(ts, 25) +
          padRight(e.status, 20) +
          padRight(durationStr, 12) +
          padRight(e.approvedBy ?? "-", 15),
        );
      }
    });

  daemon
    .command("deploy:check")
    .description("Run deployment readiness check")
    .option("--execute", "If ready, propose deployment")
    .option("--force", "Skip interactive confirmation (for scripted use)")
    .action(async (opts: { execute?: boolean; force?: boolean }) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        await runRemoteDeployCheck(opts, getOperatorClient);
        return;
      }

      if (!ctx.readinessChecker) {
        console.log("Deployment is disabled (DEPLOY_ENABLED=false)");
        return;
      }

      console.log("Running readiness check...");
      const result = await ctx.readinessChecker.checkReadiness(true);
      printReadiness(result);

      if (opts.execute && result.ready && ctx.deployTrigger) {
        if (opts.force) {
          console.log("Proposing deployment...");
          await ctx.deployTrigger.triggerReadinessCheck();
          console.log("Deployment proposed via approval queue.");
        } else {
          console.log("Use --force to propose deployment without interactive confirmation.");
        }
      }
    });
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build a topology string from V2 chain metadata steps.
 * Uses computeChainWaves to group steps into parallel waves.
 * Parallel steps within a wave are shown in brackets: "step_0 -> [step_1, step_2] -> step_3"
 */
function buildTopologyString(meta: ChainMetadataV2): string {
  if (meta.steps.length === 0) return "";

  try {
    const waves = computeChainWaves(meta.steps);
    return waves
      .map((w) => {
        const names = w.map((s) => s.toolName);
        return names.length > 1 ? `[${names.join(", ")}]` : names[0];
      })
      .join(" -> ");
  } catch {
    // Fallback for invalid DAGs: show linear tool sequence
    return meta.toolSequence.join(" -> ");
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a CLI-supplied agent ID is a valid UUID.
 * Prints an error and sets exitCode if invalid. Returns true if valid.
 */
function isValidAgentId(id: string): boolean {
  if (!UUID_RE.test(id)) {
    console.error("Invalid agent ID format. Expected UUID.");
    process.exitCode = 1;
    return false;
  }
  return true;
}

const VALID_LEVELS: UrgencyLevel[] = ["silent", "low", "medium", "high", "critical"];

/**
 * How long a shell waits on a change that runs to completion in the runtime (a
 * consolidation cycle, a readiness check that runs the tests). Node's fetch
 * stops waiting for response headers after 300 s whatever the signal says.
 */
const LONG_OPERATION_TIMEOUT_MS = 5 * 60_000;

interface PostOptions {
  readonly timeoutMs?: number;
  /**
   * The schema also describes the runtime's refusals (a 4xx whose JSON body
   * has that shape); the caller prints those itself, as the in-process path
   * would.
   */
  readonly answersRefusals?: boolean;
}

/**
 * POST a state change to the running runtime as its local operator (COR-13).
 * On any failure it says what could not be done and why, sets a non-zero exit
 * code and returns undefined; it never guesses that the daemon is "not
 * running", which this process cannot know.
 */
async function postToDashboard<S extends z.ZodType>(
  what: string,
  path: string,
  body: Record<string, unknown>,
  schema: S,
  getOperatorClient?: () => Promise<OperatorClientResolution>,
  options: PostOptions = {},
): Promise<z.output<S> | undefined> {
  const resolution: OperatorClientResolution = (await getOperatorClient?.())
    ?? { kind: "unavailable", message: "no operator connection is configured for this CLI" };
  if (resolution.kind === "unavailable") {
    console.error(`Cannot ${what}: ${resolution.message}.`);
    process.exitCode = 1;
    return undefined;
  }

  const result = await resolution.client.postJson(path, body, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {});
  if (result.kind === "refused" && options.answersRefusals) {
    const answer = schema.safeParse(result.body);
    if (answer.success) return answer.data;
  }
  if (result.kind !== "ok") {
    console.error(`Cannot ${what}: ${result.message}`);
    process.exitCode = 1;
    return undefined;
  }
  const parsed = schema.safeParse(result.body);
  if (!parsed.success) {
    console.error(`Cannot ${what}: the dashboard at ${resolution.client.baseUrl} answered POST ${path} in an unexpected shape.`);
    process.exitCode = 1;
    return undefined;
  }
  return parsed.data;
}

/** A state change the runtime carried out: it names what it did in `status`. */
const RemoteStatusSchema = z.looseObject({ status: z.string() });

// -----------------------------------------------------------------------------
// Printers shared by the in-process path and the shell path (COR-13), so a
// command prints the same thing wherever it runs.
// -----------------------------------------------------------------------------

/** What a manual fire did, in the shape both HeartbeatLoop.fireNow() and POST /api/daemon/trigger give. */
type TriggerFireView =
  | { status: "submitted"; taskId: string }
  | { status: "approval" }
  | { status: "refused"; reason: string }
  | { status: "not_found" };

/** POST /api/daemon/trigger: 200 for a fire, 409 for a gate's refusal, 404 for an unknown name. */
const RemoteTriggerFireSchema = z.discriminatedUnion("status", [
  z.looseObject({ status: z.literal("submitted"), taskId: z.string() }),
  z.looseObject({ status: z.literal("approval") }),
  z.looseObject({ status: z.literal("refused"), reason: z.string() }),
  z.looseObject({ status: z.literal("not_found") }),
]);

function printTriggerFire(name: string, outcome: TriggerFireView): void {
  switch (outcome.status) {
    case "submitted":
      console.log(`Trigger '${name}' fired manually: task ${outcome.taskId} submitted`);
      return;
    case "approval":
      console.log(`Trigger '${name}' fired manually: its action is waiting for approval (pending approvals: strada daemon status)`);
      return;
    case "refused":
      console.error(`Trigger '${name}' did not fire: ${outcome.reason}`);
      process.exitCode = 1;
      return;
    case "not_found":
      console.error(`Trigger '${name}' not found`);
      process.exitCode = 1;
      return;
  }
}

function printCircuitReset(name: string): void {
  console.log(`Circuit breaker for '${name}' reset to CLOSED`);
}

function printBudgetReset(): void {
  console.log("Budget counter reset");
}

function printDigestSent(): void {
  console.log("Digest sent to active channel");
}

function printDigestPreview(markdown: string): void {
  console.log("--- Digest Preview (dry-run) ---");
  console.log(markdown);
  console.log("--- End Preview ---");
}

function printNotificationSent(level: string): void {
  console.log(`Notification sent (level: ${level})`);
}

function printAgentStopped(id: string, force: boolean | undefined): void {
  console.log(`Agent '${id}' stopped${force ? " (force)" : ""}.`);
}

function printAgentStarted(id: string): void {
  console.log(`Agent '${id}' started.`);
}

function printAgentBudgetSet(id: string, usd: number): void {
  console.log(`Agent '${id}' budget cap set to $${usd.toFixed(2)}.`);
}

function printTierOverrideSet(type: string, tier: string): void {
  console.log(`Tier override set: ${type} -> ${tier} (immediate effect, no restart needed)`);
}

function printConsolidationUndone(logId: string): void {
  console.log(`Consolidation '${logId}' undone successfully.`);
}

interface AuditRow {
  timestamp: number;
  toolName: string;
  decision: string;
  decidedBy?: string | null;
  triggerName?: string | null;
}

function printAuditLog(entries: ReadonlyArray<AuditRow>): void {
  if (entries.length === 0) {
    console.log("No audit entries found.");
    return;
  }

  console.log("Recent Audit Log:");
  console.log(
    padRight("Timestamp", 25) +
    padRight("Tool", 20) +
    padRight("Decision", 12) +
    padRight("Decided By", 15) +
    padRight("Trigger", 20),
  );
  console.log("-".repeat(92));

  for (const entry of entries) {
    const ts = new Date(entry.timestamp).toISOString();
    console.log(
      padRight(ts, 25) +
      padRight(entry.toolName, 20) +
      padRight(entry.decision, 12) +
      padRight(entry.decidedBy ?? "-", 15) +
      padRight(entry.triggerName ?? "-", 20),
    );
  }
}

/** GET /api/daemon/audit: the approval queue's audit log, or why there is none. */
const RemoteAuditSchema = z.union([
  z.object({ enabled: z.literal(false), reason: z.string() }),
  z.object({
    enabled: z.literal(true),
    entries: z.array(z.object({
      timestamp: z.number(),
      toolName: z.string(),
      decision: z.string(),
      decidedBy: z.string().nullable().optional(),
      triggerName: z.string().nullable().optional(),
    })),
  }),
]);

interface NotificationRow {
  urgency: string;
  title: string;
  deliveredTo: ReadonlyArray<string>;
  createdAt: number;
}

function printNotifications(entries: ReadonlyArray<NotificationRow>): void {
  if (entries.length === 0) {
    console.log("No notification history found.");
    return;
  }

  console.log("Recent Notifications:");
  console.log(
    padRight("Timestamp", 25) +
    padRight("Level", 10) +
    padRight("Title", 35) +
    padRight("Delivered To", 20),
  );
  console.log("-".repeat(90));

  for (const entry of entries) {
    const ts = new Date(entry.createdAt).toISOString();
    const delivered = entry.deliveredTo.join(", ") || "-";
    console.log(
      padRight(ts, 25) +
      padRight(entry.urgency, 10) +
      padRight(entry.title.slice(0, 34), 35) +
      padRight(delivered, 20),
    );
  }
}

/** GET /api/daemon/notifications: the router's history, or why there is none. */
const RemoteNotificationsSchema = z.union([
  z.object({ enabled: z.literal(false), reason: z.string() }),
  z.object({
    enabled: z.literal(true),
    entries: z.array(z.object({
      urgency: z.string(),
      title: z.string(),
      deliveredTo: z.array(z.string()).default([]),
      createdAt: z.number(),
    })),
  }),
]);

/** GET /api/daemon/digest/preview: the digest as it would be sent now. */
const RemoteDigestPreviewSchema = z.union([
  z.object({ enabled: z.literal(false), reason: z.string() }),
  z.object({ enabled: z.literal(true), markdown: z.string() }),
]);

const CONSOLIDATION_NOT_ACTIVE =
  "Memory consolidation is not active in the running Strada (MEMORY_CONSOLIDATION_ENABLED=false, or daemon mode is off)";

interface ConsolidationPreviewView {
  clusters: ReadonlyArray<{ seedId: string; memberIds: ReadonlyArray<string>; avgSimilarity: number; tier: string }>;
  estimatedCostPerCluster: number;
  totalEstimatedCost: number;
}

function printConsolidationPreview(preview: ConsolidationPreviewView, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  if (preview.clusters.length === 0) {
    console.log("No clusters found for consolidation.");
    return;
  }

  console.log("Consolidation Preview:");
  console.log("");
  console.log(
    padRight("Cluster Seed", 38) +
    padRight("Members", 10) +
    padRight("Tier", 14) +
    padRight("Similarity", 14),
  );
  console.log("-".repeat(76));

  for (const c of preview.clusters) {
    console.log(
      padRight(c.seedId.slice(0, 36), 38) +
      padRight(String(c.memberIds.length), 10) +
      padRight(c.tier, 14) +
      padRight(c.avgSimilarity.toFixed(3), 14),
    );
  }

  console.log("");
  console.log(`Total clusters: ${preview.clusters.length}`);
  console.log(`Estimated cost: $${preview.totalEstimatedCost.toFixed(4)} ($${preview.estimatedCostPerCluster.toFixed(4)}/cluster)`);
}

/** GET /api/consolidation/preview: the engine's preview(), or `enabled: false`. */
const RemoteConsolidationPreviewSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    clusters: z.array(z.object({
      seedId: z.string(),
      memberIds: z.array(z.string()),
      avgSimilarity: z.number(),
      tier: z.string(),
    })),
    estimatedCostPerCluster: z.number(),
    totalEstimatedCost: z.number(),
  }),
]);

function printConsolidationStart(force: boolean | undefined): void {
  console.log(force ? "Running consolidation (forced)..." : "Running consolidation (use --force to bypass idle check)...");
}

function printConsolidationResult(result: { status: string; processed: number; remaining: number; clustersFound: number; costUsd: number }): void {
  console.log(`Status: ${result.status}`);
  console.log(`Processed: ${result.processed} clusters`);
  console.log(`Remaining: ${result.remaining}`);
  console.log(`Clusters found: ${result.clustersFound}`);
  console.log(`Cost: $${result.costUsd.toFixed(4)}`);
}

/** POST /api/consolidation/run: the engine's runCycle() result. */
const RemoteConsolidationRunSchema = z.object({
  status: z.string(),
  processed: z.number(),
  remaining: z.number(),
  clustersFound: z.number(),
  costUsd: z.number(),
});

interface ReadinessView {
  ready: boolean;
  reason?: string | null;
  testPassed: boolean;
  gitClean: boolean;
  branchMatch: boolean;
}

function printReadiness(result: ReadinessView): void {
  console.log(`Ready: ${result.ready ? "YES" : "NO"}`);
  console.log(`  Tests: ${result.testPassed ? "PASS" : "FAIL"}`);
  console.log(`  Git clean: ${result.gitClean ? "YES" : "NO"}`);
  console.log(`  Branch match: ${result.branchMatch ? "YES" : "NO"}`);
  if (result.reason) {
    console.log(`  Reason: ${result.reason}`);
  }
}

/** POST /api/deployment/check: the readiness result (and whether it proposed), or `enabled: false`. */
const RemoteDeployCheckSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    ready: z.boolean(),
    reason: z.string().nullable().optional(),
    testPassed: z.boolean(),
    gitClean: z.boolean(),
    branchMatch: z.boolean(),
    proposed: z.boolean().optional(),
  }),
]);

/**
 * `deploy:check` from a shell. As in-process, --execute proposes only with
 * --force: the shell asks the runtime to propose only then, so a check never
 * turns into a proposal without the operator's explicit say-so.
 */
async function runRemoteDeployCheck(
  opts: { execute?: boolean; force?: boolean },
  getOperatorClient?: () => Promise<OperatorClientResolution>,
): Promise<void> {
  const propose = opts.execute === true && opts.force === true;
  console.log("Running readiness check...");
  const result = await postToDashboard(
    "run the readiness check",
    "/api/deployment/check",
    propose ? { propose: true } : {},
    RemoteDeployCheckSchema,
    getOperatorClient,
    { timeoutMs: LONG_OPERATION_TIMEOUT_MS },
  );
  if (!result) return;
  if ("enabled" in result) {
    console.log("Deployment is not active in the running Strada (DEPLOY_ENABLED=false, or daemon mode is off)");
    return;
  }
  printReadiness(result);
  if (!opts.execute || !result.ready) return;
  if (!opts.force) {
    console.log("Use --force to propose deployment without interactive confirmation.");
  } else if (result.proposed) {
    console.log("Proposing deployment...");
    console.log("Deployment proposed via approval queue.");
  }
}

/** The part of GET /api/daemon that `daemon status` prints. */
const RemoteDaemonStatusSchema = z.object({
  running: z.boolean(),
  configured: z.boolean().optional(),
  intervalMs: z.number().optional(),
  triggers: z.array(z.object({
    name: z.string(),
    type: z.string(),
    state: z.string(),
    circuitState: z.string().optional(),
    nextRun: z.string().nullable().optional(),
  })).default([]),
  budget: z.object({
    usedUsd: z.number(),
    limitUsd: z.number(),
    pct: z.number(),
  }).optional(),
  approvalQueue: z.array(z.unknown()).default([]),
});

/**
 * GET `path` from the running runtime's dashboard for a read-only command run
 * from a shell (COR-13). On any failure it says what could not be read and
 * why, sets a non-zero exit code and returns undefined; it never guesses that
 * the daemon is "not running", which this process cannot know.
 */
async function readFromDashboard<S extends z.ZodType>(
  what: string,
  path: string,
  schema: S,
  getDashboardClient?: () => DashboardClientResolution,
): Promise<{ data: z.output<S>; baseUrl: string } | undefined> {
  const resolution: DashboardClientResolution = getDashboardClient?.()
    ?? { kind: "unavailable", message: "no dashboard connection is configured for this CLI" };
  if (resolution.kind === "unavailable") {
    console.error(`Cannot read ${what}: ${resolution.message}.`);
    process.exitCode = 1;
    return undefined;
  }

  const result = await resolution.client.getJson(path);
  if (result.kind !== "ok") {
    console.error(`Cannot read ${what}: ${result.message}`);
    process.exitCode = 1;
    return undefined;
  }
  const parsed = schema.safeParse(result.body);
  if (!parsed.success) {
    console.error(`Cannot read ${what}: the dashboard at ${resolution.client.baseUrl} answered ${path} in an unexpected shape.`);
    process.exitCode = 1;
    return undefined;
  }
  return { data: parsed.data, baseUrl: resolution.client.baseUrl };
}

/** `daemon status` from a shell: read the running runtime over its dashboard API. */
async function printRemoteDaemonStatus(getDashboardClient?: () => DashboardClientResolution): Promise<void> {
  const read = await readFromDashboard("the daemon status", "/api/daemon", RemoteDaemonStatusSchema, getDashboardClient);
  if (!read) return;

  const status = read.data;
  if (status.configured === false) {
    // The runtime answered, so it IS running — just without the heartbeat.
    console.log("Daemon: not enabled (Strada is running without daemon mode; start it with --daemon)");
    console.log(`Dashboard: ${read.baseUrl}`);
    return;
  }

  console.log(`Daemon: ${status.running ? "running" : "stopped"}`);
  console.log(`Dashboard: ${read.baseUrl}`);
  if (status.intervalMs !== undefined) console.log(`Heartbeat interval: ${status.intervalMs}ms`);
  console.log("");

  if (status.triggers.length > 0) {
    console.log("Triggers:");
    console.log(padRight("Name", 25) + padRight("Type", 10) + padRight("State", 12) + padRight("Circuit", 12) + padRight("Next Run", 25));
    console.log("-".repeat(84));
    for (const trigger of status.triggers) {
      console.log(
        padRight(trigger.name, 25) +
        padRight(trigger.type, 10) +
        padRight(trigger.state, 12) +
        padRight(trigger.circuitState ?? "-", 12) +
        padRight(trigger.nextRun ?? "N/A", 25),
      );
    }
    console.log("");
  } else {
    console.log("Triggers: none registered");
    console.log("");
  }

  if (status.budget) {
    // The API reports an absent limit as 0.
    const { usedUsd, limitUsd, pct } = status.budget;
    console.log(limitUsd > 0
      ? `Budget: $${usedUsd.toFixed(2)} / $${limitUsd.toFixed(2)} (${(pct * 100).toFixed(1)}%)`
      : `Budget: $${usedUsd.toFixed(2)} (no daily limit)`);
  }
  console.log(`Pending approvals: ${status.approvalQueue.length}`);
}

// -----------------------------------------------------------------------------
// Read-only commands over the dashboard API (COR-13). Each one reads the GET
// endpoint the dashboard already serves, and shares its printer with the
// in-process path, so both print the same thing.
// -----------------------------------------------------------------------------

/** What `daemon config` prints, reading each setting through `get("heartbeat.intervalMs")`. */
function printDaemonConfig(get: (settingPath: string) => unknown): void {
  const text = (settingPath: string): string => {
    const value = get(settingPath);
    return value === undefined || value === null ? "-" : String(value);
  };
  const tools = get("security.autoApproveTools");
  const toolList = Array.isArray(tools) ? tools.map(String).join(", ") : "";
  const dailyBudget = get("budget.dailyBudgetUsd");
  const limitScope = get("budget.limitScope");

  console.log("Daemon Configuration:");
  console.log(
    padRight("Setting", 35) +
    padRight("Value", 20) +
    padRight("Env Var", 40),
  );
  console.log("-".repeat(95));

  const rows: Array<[string, string, string]> = [
    ["heartbeat.intervalMs", text("heartbeat.intervalMs"), "STRADA_DAEMON_INTERVAL_MS"],
    ["heartbeat.heartbeatFile", text("heartbeat.heartbeatFile"), "STRADA_DAEMON_HEARTBEAT_FILE"],
    ["heartbeat.idlePause", text("heartbeat.idlePause"), "STRADA_DAEMON_IDLE_PAUSE"],
    ["security.approvalTimeoutMin", text("security.approvalTimeoutMin"), "STRADA_DAEMON_APPROVAL_TIMEOUT_MINUTES"],
    // Audited 2026-09-02: DaemonSecurityPolicy.checkPermission has no
    // production caller, so this allowlist is parsed but applied by
    // nothing — daemon writes are gated by the orchestrator's self-managed
    // write review instead. Say so, rather than print it as live policy.
    ["security.autoApproveTools", `${toolList || "(none)"} [not enforced]`, "STRADA_DAEMON_AUTO_APPROVE_TOOLS"],
    // Name what the cap measures: a dedicated daemon sub-limit counts daemon
    // spend only; the shared-wallet fallback counts every source (audited 2026-09-02).
    ["budget.dailyBudgetUsd", dailyBudget !== undefined && dailyBudget !== null ? `${String(dailyBudget)} (${typeof limitScope === "string" ? limitScope : "system"} spend)` : "unlimited", "STRADA_DAEMON_DAILY_BUDGET"],
    ["budget.warnPct", text("budget.warnPct"), "STRADA_DAEMON_BUDGET_WARN_PCT"],
    ["backoff.baseCooldownMs", text("backoff.baseCooldownMs"), "STRADA_DAEMON_BACKOFF_BASE"],
    ["backoff.maxCooldownMs", text("backoff.maxCooldownMs"), "STRADA_DAEMON_BACKOFF_MAX"],
    ["backoff.failureThreshold", text("backoff.failureThreshold"), "STRADA_DAEMON_FAILURE_THRESHOLD"],
    ["timezone", text("timezone"), "STRADA_DAEMON_TIMEZONE"],
  ];

  for (const [setting, value, envVar] of rows) {
    console.log(
      padRight(setting, 35) +
      padRight(value, 20) +
      padRight(envVar, 40),
    );
  }
}

/** GET /api/config: the runtime's configuration, flattened to dotted keys and masked. */
const RemoteConfigSchema = z.object({ config: z.record(z.string(), z.unknown()) });

async function printRemoteDaemonConfig(getDashboardClient?: () => DashboardClientResolution): Promise<void> {
  const read = await readFromDashboard("the daemon settings", "/api/config", RemoteConfigSchema, getDashboardClient);
  if (!read) return;
  const flat = read.data.config;
  if (!Object.keys(flat).some((key) => key.startsWith("daemon."))) {
    console.error(`Cannot read the daemon settings: the dashboard at ${read.baseUrl} reported no daemon configuration.`);
    process.exitCode = 1;
    return;
  }
  printDaemonConfig((settingPath) => flat[`daemon.${settingPath}`]);
}

interface DecayStatsView {
  enabled: boolean;
  tiers: Record<string, { entries: number; avgScore: number; atFloor: number; lambda: number }>;
  exemptDomains: string[];
  totalExempt: number;
}

function printDecayStats(stats: DecayStatsView, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  // Table format
  console.log("Memory Decay Status:");
  console.log("");
  console.log(
    padRight("Tier", 14) +
    padLeft("Entries", 10) +
    padLeft("Avg Score", 12) +
    padLeft("At Floor", 10) +
    padLeft("Lambda", 10),
  );
  console.log("-".repeat(56));

  const tierNames = ["working", "ephemeral", "persistent"];
  for (const name of tierNames) {
    const t = stats.tiers[name];
    if (!t) continue;
    const displayName = name.charAt(0).toUpperCase() + name.slice(1);
    console.log(
      padRight(displayName, 14) +
      padLeft(String(t.entries), 10) +
      padLeft(t.avgScore.toFixed(2), 12) +
      padLeft(String(t.atFloor), 10) +
      padLeft(t.lambda.toFixed(2), 10),
    );
  }

  console.log("");
  if (stats.exemptDomains.length > 0) {
    console.log(`Exempt domains: ${stats.exemptDomains.join(", ")} (${stats.totalExempt} entries)`);
  }
}

/** GET /api/maintenance: `decay` is the memory manager's getDecayStats(). */
const RemoteMaintenanceSchema = z.object({
  decay: z.object({
    enabled: z.boolean(),
    tiers: z.record(z.string(), z.object({ entries: z.number(), avgScore: z.number(), atFloor: z.number(), lambda: z.number() })),
    exemptDomains: z.array(z.string()).default([]),
    totalExempt: z.number().default(0),
  }),
});

async function printRemoteDecayStatus(
  opts: { json?: boolean },
  getDashboardClient?: () => DashboardClientResolution,
): Promise<void> {
  const read = await readFromDashboard("the memory decay status", "/api/maintenance", RemoteMaintenanceSchema, getDashboardClient);
  if (!read) return;
  if (!read.data.decay.enabled) {
    // The API cannot tell "disabled" from "this memory backend reports no decay".
    console.log("Memory decay is not active in the running Strada (MEMORY_DECAY_ENABLED=false, or its memory backend reports no decay)");
    return;
  }
  printDecayStats(read.data.decay, opts.json);
}

function printResilienceConfigLine(config: {
  rollbackEnabled: boolean;
  parallelEnabled: boolean;
  maxParallelBranches: number;
  compensationTimeoutMs: number;
}): void {
  console.log(
    `Rollback: ${config.rollbackEnabled ? "enabled" : "disabled"}` +
    ` | Parallel: ${config.parallelEnabled ? "enabled" : "disabled"}` +
    ` | Max Branches: ${config.maxParallelBranches}` +
    ` | Timeout: ${config.compensationTimeoutMs}ms`,
  );
}

/** GET /api/chain-resilience: per-chain summary (no step graph) and the resilience config. */
const RemoteChainResilienceSchema = z.object({
  chains: z.array(z.object({
    name: z.string(),
    steps: z.number(),
    rollbackCapable: z.boolean(),
    parallelCapable: z.boolean(),
    successRate: z.number(),
    occurrences: z.number(),
  })).default([]),
  config: z.object({
    rollbackEnabled: z.boolean(),
    parallelEnabled: z.boolean(),
    maxParallelBranches: z.number(),
    compensationTimeoutMs: z.number(),
  }),
});

async function printRemoteChainStatus(
  opts: { json?: boolean },
  getDashboardClient?: () => DashboardClientResolution,
): Promise<void> {
  const read = await readFromDashboard("the tool chain status", "/api/chain-resilience", RemoteChainResilienceSchema, getDashboardClient);
  if (!read) return;
  const { chains, config } = read.data;
  if (opts.json) {
    console.log(JSON.stringify(read.data, null, 2));
    return;
  }
  if (chains.length === 0) {
    console.log("No active tool chains");
    return;
  }

  // The API reports each chain's step count, not its graph, so there is no
  // topology column here.
  console.log("Tool Chain Resilience Status:");
  console.log("");
  console.log(
    padRight("Name", 25) +
    padRight("Steps", 7) +
    padRight("Rollback", 10) +
    padRight("Parallel", 10) +
    padRight("Success", 10) +
    padRight("Runs", 8),
  );
  console.log("-".repeat(70));
  for (const c of chains) {
    console.log(
      padRight(c.name.length > 24 ? c.name.slice(0, 22) + ".." : c.name, 25) +
      padRight(String(c.steps), 7) +
      padRight(c.rollbackCapable ? "Yes" : "No", 10) +
      padRight(c.parallelCapable ? "Yes" : "No", 10) +
      padRight((c.successRate * 100).toFixed(1) + "%", 10) +
      padRight(String(c.occurrences), 8),
    );
  }
  console.log("");
  printResilienceConfigLine(config);
}

/** One agent as both the in-process manager and GET /api/agents describe it. */
interface AgentView {
  id: string;
  key: string;
  channelType: string;
  chatId: string;
  status: string;
  createdAt: number;
  lastActivity: number;
  budgetCapUsd: number;
  memoryEntryCount: number;
}

function printAgentTable(agents: ReadonlyArray<AgentView & { budgetUsed: number }>): void {
  const now = Date.now();

  console.log("Agent Sessions:");
  console.log(
    padRight("ID", 38) +
    padRight("Channel", 16) +
    padRight("Status", 18) +
    padRight("Budget", 22) +
    padRight("Memory", 10) +
    padRight("Uptime", 12),
  );
  console.log("-".repeat(116));

  for (const a of agents) {
    const used = a.budgetUsed;
    const pct = a.budgetCapUsd > 0 ? ((used / a.budgetCapUsd) * 100).toFixed(0) : "0";
    const budgetStr = `$${used.toFixed(2)} / $${a.budgetCapUsd.toFixed(2)} (${pct}%)`;
    const uptimeMs = now - a.createdAt;
    console.log(
      padRight(a.id, 38) +
      padRight(`${a.channelType}:${a.chatId.slice(0, 8)}`, 16) +
      padRight(a.status, 18) +
      padRight(budgetStr, 22) +
      padRight(String(a.memoryEntryCount), 10) +
      padRight(formatDuration(uptimeMs), 12),
    );
  }
}

function printAgentDetail(agent: AgentView, usage: { usedUsd: number; pct: number }, json: boolean | undefined): void {
  const detail = {
    ...agent,
    budgetUsed: usage.usedUsd,
    budgetPct: usage.pct,
    uptimeMs: Date.now() - agent.createdAt,
  };

  if (json) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }

  console.log(`Agent: ${agent.id}`);
  console.log(`  Key:           ${agent.key}`);
  console.log(`  Channel:       ${agent.channelType}`);
  console.log(`  Chat ID:       ${agent.chatId}`);
  console.log(`  Status:        ${agent.status}`);
  console.log(`  Budget:        $${usage.usedUsd.toFixed(2)} / $${agent.budgetCapUsd.toFixed(2)} (${(usage.pct * 100).toFixed(1)}%)`);
  console.log(`  Memory:        ${agent.memoryEntryCount} entries`);
  console.log(`  Created:       ${new Date(agent.createdAt).toISOString()}`);
  console.log(`  Last Activity: ${new Date(agent.lastActivity).toISOString()}`);
  console.log(`  Uptime:        ${formatDuration(Date.now() - agent.createdAt)}`);
}

/** GET /api/agents: every agent with its spend, or `enabled: false` without multi-agent mode. */
const RemoteAgentsSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    // Loose: `--json` passes on every field the runtime sent.
    agents: z.array(z.looseObject({
      id: z.string(),
      key: z.string().default(""),
      channelType: z.string(),
      chatId: z.string(),
      status: z.string(),
      createdAt: z.number(),
      lastActivity: z.number(),
      budgetCapUsd: z.number(),
      memoryEntryCount: z.number(),
      budgetUsed: z.number().default(0),
    })).default([]),
  }),
]);

async function readAgents(
  getDashboardClient?: () => DashboardClientResolution,
): Promise<ReadonlyArray<AgentView & { budgetUsed: number }> | undefined> {
  const read = await readFromDashboard("the agent sessions", "/api/agents", RemoteAgentsSchema, getDashboardClient);
  if (!read) return undefined;
  if (!read.data.enabled) {
    console.error("Multi-agent mode is not enabled in the running Strada.");
    process.exitCode = 1;
    return undefined;
  }
  return read.data.agents;
}

async function printRemoteAgents(
  opts: { json?: boolean },
  getDashboardClient?: () => DashboardClientResolution,
): Promise<void> {
  const agents = await readAgents(getDashboardClient);
  if (!agents) return;
  if (opts.json) {
    console.log(JSON.stringify(agents, null, 2));
    return;
  }
  if (agents.length === 0) {
    console.log("No active agents.");
    return;
  }
  printAgentTable(agents);
}

async function printRemoteAgentStatus(
  id: string,
  opts: { json?: boolean },
  getDashboardClient?: () => DashboardClientResolution,
): Promise<void> {
  const agents = await readAgents(getDashboardClient);
  if (!agents) return;
  const agent = agents.find((a) => a.id === id);
  if (!agent) {
    console.error(`Agent '${id}' not found.`);
    process.exitCode = 1;
    return;
  }
  const pct = agent.budgetCapUsd > 0 ? agent.budgetUsed / agent.budgetCapUsd : 0;
  printAgentDetail(agent, { usedUsd: agent.budgetUsed, pct }, opts.json);
}

/** How many entries GET /api/delegations and /api/deployment include (server-system-routes.ts). */
const DASHBOARD_DELEGATION_HISTORY = 20;
const DASHBOARD_DEPLOYMENT_HISTORY = 10;

interface DelegationHistoryRow {
  id: number;
  parentAgentId: string;
  type: string;
  tier: string;
  model: string;
  durationMs?: number | null;
  costUsd?: number | null;
  status: string;
}

interface DelegationStatsRow {
  type: string;
  count: number;
  avgDurationMs: number;
  avgCostUsd: number;
  successRate: number;
  tierBreakdown: Record<string, number>;
}

function printDelegationHistory(history: ReadonlyArray<DelegationHistoryRow>, opts: { type?: string; json?: boolean }): void {
  const filtered = opts.type
    ? history.filter((e) => e.type === opts.type)
    : history;

  if (opts.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log("No delegation history found.");
    return;
  }

  console.log("Delegation History:");
  console.log(
    padRight("ID", 6) +
    padRight("Parent", 14) +
    padRight("Type", 18) +
    padRight("Tier", 10) +
    padRight("Model", 28) +
    padRight("Duration", 12) +
    padRight("Cost", 10) +
    padRight("Status", 12),
  );
  console.log("-".repeat(110));

  for (const e of filtered) {
    const durationStr = e.durationMs != null ? `${e.durationMs}ms` : "-";
    const costStr = e.costUsd != null ? `$${e.costUsd.toFixed(4)}` : "-";
    console.log(
      padRight(String(e.id), 6) +
      padRight(e.parentAgentId.slice(0, 12) + "..", 14) +
      padRight(e.type, 18) +
      padRight(e.tier, 10) +
      padRight(e.model.length > 26 ? e.model.slice(0, 24) + ".." : e.model, 28) +
      padRight(durationStr, 12) +
      padRight(costStr, 10) +
      padRight(e.status, 12),
    );
  }
}

/** GET /api/delegations: active delegations, the recent history and per-type stats. */
const RemoteDelegationsSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    active: z.array(z.object({
      subAgentId: z.string(),
      type: z.string(),
      startedAt: z.number(),
      elapsedMs: z.number().optional(),
    })).default([]),
    history: z.array(z.looseObject({
      id: z.number(),
      parentAgentId: z.string(),
      type: z.string(),
      tier: z.string(),
      model: z.string(),
      durationMs: z.number().nullable().optional(),
      costUsd: z.number().nullable().optional(),
      status: z.string(),
    })).default([]),
    stats: z.array(z.object({
      type: z.string(),
      count: z.number(),
      avgDurationMs: z.number(),
      avgCostUsd: z.number(),
      successRate: z.number(),
      tierBreakdown: z.record(z.string(), z.number()),
    })).default([]),
  }),
]);

async function readDelegations(
  getDashboardClient?: () => DashboardClientResolution,
): Promise<Extract<z.output<typeof RemoteDelegationsSchema>, { enabled: true }> | undefined> {
  const read = await readFromDashboard("the delegations", "/api/delegations", RemoteDelegationsSchema, getDashboardClient);
  if (!read) return undefined;
  if (!read.data.enabled) {
    console.log("Task delegation is not enabled in the running Strada");
    return undefined;
  }
  return read.data;
}

interface ConsolidationStatsRow {
  perTier: Record<string, { clustered: number; pending: number; total: number }>;
  lifetimeSavings: number;
  totalRuns: number;
  totalCostUsd: number;
}

/** GET /api/consolidation: the engine's getStats(), or `enabled: false`. */
const RemoteConsolidationSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    perTier: z.record(z.string(), z.object({ clustered: z.number(), pending: z.number(), total: z.number() })),
    lifetimeSavings: z.number(),
    totalRuns: z.number(),
    totalCostUsd: z.number(),
  }),
]);

interface DeploymentStatsRow {
  totalDeployments: number;
  successful: number;
  failed: number;
  lastDeployment?: unknown;
  circuitBreakerState: string;
}

interface DeploymentHistoryRow {
  proposedAt: number;
  status: string;
  duration?: number | null;
  approvedBy?: string | null;
}

/** GET /api/deployment: the executor's getStats() and its recent history, or `enabled: false`. */
const RemoteDeploymentSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    stats: z.object({
      totalDeployments: z.number(),
      successful: z.number(),
      failed: z.number(),
      lastDeployment: z.unknown().optional(),
      circuitBreakerState: z.string(),
    }),
    history: z.array(z.looseObject({
      proposedAt: z.number(),
      status: z.string(),
      duration: z.number().nullable().optional(),
      approvedBy: z.string().nullable().optional(),
    })).default([]),
  }),
]);

async function readDeployment(
  getDashboardClient?: () => DashboardClientResolution,
): Promise<Extract<z.output<typeof RemoteDeploymentSchema>, { enabled: true }> | undefined> {
  const read = await readFromDashboard("the deployment status", "/api/deployment", RemoteDeploymentSchema, getDashboardClient);
  if (!read) return undefined;
  if (!read.data.enabled) {
    console.log("Deployment is not active in the running Strada (DEPLOY_ENABLED=false, or daemon mode is off)");
    return undefined;
  }
  return read.data;
}

function persistCircuitState(storage: DaemonStorage, name: string, cb: CircuitBreaker): void {
  const snap = cb.serialize();
  storage.upsertCircuitState(name, snap.state, snap.consecutiveFailures, snap.lastFailureTime, snap.cooldownMs);
}

function padRight(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + " ".repeat(width - str.length);
}

function padLeft(str: string, width: number): string {
  if (str.length >= width) return str;
  return " ".repeat(width - str.length) + str;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
