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
}

// =============================================================================
// Helpers
// =============================================================================

function persistCircuitState(storage: DaemonStorage, name: string, cb: CircuitBreaker): void {
  const snap = cb.serialize();
  storage.upsertCircuitState(name, snap.state, snap.consecutiveFailures, snap.lastFailureTime, snap.cooldownMs);
}

function padRight(str: string, width: number): string {
  if (str.length >= width) return str + " ";
  return str + " ".repeat(width - str.length);
}
