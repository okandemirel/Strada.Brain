/**
 * Daemon CLI Commands
 *
 * Commander subcommands for daemon management:
 *   strata daemon status  -- Show heartbeat state, triggers, budget, pending approvals
 *   strata daemon trigger -- Manually fire a named trigger
 *   strata daemon reset   -- Reset circuit breaker for a trigger to CLOSED
 *   strata daemon audit   -- Show recent approval/denial decisions
 *   strata daemon config  -- Show all daemon settings
 *   strata daemon budget  -- Budget management (reset)
 *   strata daemon digest  -- Send immediate digest (or --dry-run to preview)
 *   strata daemon notifications -- Show notification history
 *   strata daemon notify  -- Send a test notification
 *   strata daemon chain:status -- Show tool chain resilience status
 *
 * Uses callback-based DI: getDaemonContext() returns the running daemon's
 * context or undefined if daemon is not running.
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
import {
  ChainMetadataV2Schema,
  ChainMetadataSchema,
  migrateV1toV2,
  DEFAULT_RESILIENCE_CONFIG,
} from "../learning/chains/chain-types.js";
import { computeChainWaves } from "../learning/chains/chain-dag.js";
import type { ChainResilienceConfig, ChainMetadataV2 } from "../learning/chains/chain-types.js";

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
}

/**
 * Register daemon management subcommands on the given Commander program.
 *
 * @param program - The root Commander program
 * @param getDaemonContext - Callback returning the daemon context, or undefined if daemon is not running
 */
export function registerDaemonCommands(
  program: Command,
  getDaemonContext: () => DaemonContext | undefined,
): void {
  const daemon = program
    .command("daemon")
    .description("Daemon management commands");

  // =========================================================================
  // daemon status
  // =========================================================================
  daemon
    .command("status")
    .description("Show daemon heartbeat state, triggers, budget, and pending approvals")
    .action(() => {
      const ctx = getDaemonContext();
      if (!ctx) {
        console.log("Daemon: not running");
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
    .description("Manually fire a named trigger")
    .action((name: string) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        console.error("Daemon is not running. Cannot fire triggers.");
        return;
      }

      const trigger = ctx.registry.getByName(name);
      if (!trigger) {
        console.error(`Trigger '${name}' not found`);
        return;
      }

      trigger.onFired(new Date());
      console.log(`Trigger '${name}' fired manually`);
    });

  // =========================================================================
  // daemon reset <name>
  // =========================================================================
  daemon
    .command("reset <name>")
    .description("Reset circuit breaker for a named trigger to CLOSED")
    .action((name: string) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        console.error("Daemon is not running. Cannot reset circuit breakers.");
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

      console.log(`Circuit breaker for '${name}' reset to CLOSED`);
    });

  // =========================================================================
  // daemon audit
  // =========================================================================
  daemon
    .command("audit")
    .description("Show recent approval/denial decisions")
    .option("--limit <n>", "Number of entries to show", "20")
    .action((opts: { limit: string }) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        console.log("Daemon: not running");
        return;
      }

      const limit = parseInt(opts.limit, 10) || 20;
      const entries = ctx.approvalQueue.getAuditLog(limit);

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
    });

  // =========================================================================
  // daemon config
  // =========================================================================
  daemon
    .command("config")
    .description("Show all daemon settings")
    .action(() => {
      const ctx = getDaemonContext();
      if (!ctx) {
        console.log("Daemon: not running");
        return;
      }

      const c = ctx.config;

      console.log("Daemon Configuration:");
      console.log(
        padRight("Setting", 35) +
        padRight("Value", 20) +
        padRight("Env Var", 40),
      );
      console.log("-".repeat(95));

      const rows: Array<[string, string, string]> = [
        ["heartbeat.intervalMs", String(c.heartbeat.intervalMs), "STRATA_DAEMON_INTERVAL_MS"],
        ["heartbeat.heartbeatFile", c.heartbeat.heartbeatFile, "STRATA_DAEMON_HEARTBEAT_FILE"],
        ["heartbeat.idlePause", String(c.heartbeat.idlePause), "STRATA_DAEMON_IDLE_PAUSE"],
        ["security.approvalTimeoutMin", String(c.security.approvalTimeoutMin), "STRATA_DAEMON_APPROVAL_TIMEOUT_MINUTES"],
        ["security.autoApproveTools", c.security.autoApproveTools.join(", ") || "(none)", "STRATA_DAEMON_AUTO_APPROVE_TOOLS"],
        ["budget.dailyBudgetUsd", c.budget.dailyBudgetUsd !== undefined ? String(c.budget.dailyBudgetUsd) : "unlimited", "STRATA_DAEMON_DAILY_BUDGET"],
        ["budget.warnPct", String(c.budget.warnPct), "STRATA_DAEMON_BUDGET_WARN_PCT"],
        ["backoff.baseCooldownMs", String(c.backoff.baseCooldownMs), "STRATA_DAEMON_BACKOFF_BASE"],
        ["backoff.maxCooldownMs", String(c.backoff.maxCooldownMs), "STRATA_DAEMON_BACKOFF_MAX"],
        ["backoff.failureThreshold", String(c.backoff.failureThreshold), "STRATA_DAEMON_FAILURE_THRESHOLD"],
        ["timezone", c.timezone, "STRATA_DAEMON_TIMEZONE"],
      ];

      for (const [setting, value, envVar] of rows) {
        console.log(
          padRight(setting, 35) +
          padRight(value, 20) +
          padRight(envVar, 40),
        );
      }
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
    .action(() => {
      const ctx = getDaemonContext();
      if (!ctx) {
        console.error("Daemon is not running. Cannot reset budget.");
        return;
      }

      ctx.budgetTracker.resetBudget();
      console.log("Budget counter reset");
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
        console.error("Daemon is not running.");
        return;
      }

      if (!ctx.digestReporter) {
        console.error("DigestReporter is not available.");
        return;
      }

      if (opts.dryRun) {
        const markdown = await ctx.digestReporter.sendDigest();
        console.log("--- Digest Preview (dry-run) ---");
        console.log(markdown);
        console.log("--- End Preview ---");
      } else {
        await ctx.digestReporter.sendDigest();
        console.log("Digest sent to active channel");
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
    .action((opts: { level?: string; limit: string }) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        console.log("Daemon: not running");
        return;
      }

      if (!ctx.notificationRouter) {
        console.error("NotificationRouter is not available.");
        return;
      }

      const limit = parseInt(opts.limit, 10) || 20;
      const VALID_LEVELS: UrgencyLevel[] = ["silent", "low", "medium", "high", "critical"];
      const levelFilter = opts.level && VALID_LEVELS.includes(opts.level as UrgencyLevel)
        ? opts.level as UrgencyLevel
        : undefined;
      if (opts.level && !levelFilter) {
        console.error(`Invalid level filter: ${opts.level}. Must be one of: ${VALID_LEVELS.join(", ")}`);
        return;
      }
      const entries = ctx.notificationRouter.getHistory(limit, levelFilter);

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
        console.error("Daemon is not running.");
        return;
      }

      if (!ctx.notificationRouter) {
        console.error("NotificationRouter is not available.");
        return;
      }

      const VALID_LEVELS: UrgencyLevel[] = ["silent", "low", "medium", "high", "critical"];
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
      console.log(`Notification sent (level: ${opts.level})`);
    });

  // =========================================================================
  // daemon memory:decay-status
  // =========================================================================
  daemon
    .command("memory:decay-status")
    .description("Show memory decay status per tier")
    .option("--json", "Output as JSON instead of table")
    .action((opts: { json?: boolean }) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        console.error("Daemon is not running. Start with: strata daemon start");
        process.exitCode = 1;
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

      if (opts.json) {
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
    });

  // =========================================================================
  // daemon chain:status (Plan 22-04)
  // =========================================================================
  daemon
    .command("chain:status")
    .description("Show tool chain resilience status")
    .option("--json", "Output as JSON instead of table")
    .action((opts: { json?: boolean }) => {
      const ctx = getDaemonContext();
      if (!ctx) {
        console.error("Daemon is not running. Start with: strata daemon start");
        process.exitCode = 1;
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
      console.log(
        `Rollback: ${resilienceConfig.rollbackEnabled ? "enabled" : "disabled"}` +
        ` | Parallel: ${resilienceConfig.parallelEnabled ? "enabled" : "disabled"}` +
        ` | Max Branches: ${resilienceConfig.maxParallelBranches}` +
        ` | Timeout: ${resilienceConfig.compensationTimeoutMs}ms`,
      );
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
