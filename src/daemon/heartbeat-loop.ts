/**
 * HeartbeatLoop
 *
 * Core daemon loop that evaluates registered triggers each tick. Ties together
 * the trigger system (Plan 02) and security/budget systems (Plan 03) into a
 * cohesive tick-evaluate-fire pipeline.
 *
 * Tick flow:
 *  1. Expire stale approvals
 *  2. Get active triggers from registry
 *  3. For each trigger (sequential to prevent budget race conditions):
 *     a. Check circuit breaker -- skip if OPEN
 *     b. Check budget -- break if exceeded
 *     c. Check overlap -- skip if trigger already has an active task
 *     d. If shouldFire(now) -- fire, submit task via TaskManager
 *  4. Update lastTick timestamp
 *
 * Requirements: DAEMON-01, DAEMON-02, DAEMON-04, DAEMON-05
 */

import { ProviderHealthRegistry } from "../agents/providers/provider-health.js";
import type { TriggerRegistry } from "./trigger-registry.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { BudgetTracker } from "./budget/budget-tracker.js";
import type { DaemonSecurityPolicy } from "./security/daemon-security-policy.js";
import type { ApprovalQueue } from "./security/approval-queue.js";
import type { DaemonStorage } from "./daemon-storage.js";
import type { DaemonConfig, DaemonStatusSnapshot, TriggerType } from "./daemon-types.js";
import type { DaemonEventMap } from "./daemon-events.js";
import type { IEventBus } from "../core/event-bus.js";
import type { TaskId } from "../tasks/types.js";
import { ACTIVE_STATUSES, TaskStatus } from "../tasks/types.js";
import { MS_PER_DAY } from "../learning/types.js";
import { CircuitBreaker } from "./resilience/circuit-breaker.js";
import type { TriggerDeduplicator } from "./dedup/trigger-deduplicator.js";
import type * as winston from "winston";
import type { UnifiedBudgetManager } from "../budget/unified-budget-manager.js";

/** Identity manager interface -- only the subset HeartbeatLoop uses */
interface IdentityActivity {
  recordActivity(): void;
}

/** Consolidation engine interface -- only the subset HeartbeatLoop uses */
interface ConsolidationEngineContract {
  runCycle(signal: AbortSignal): Promise<{ status: string; processed: number; remaining: number; clustersFound: number; costUsd: number }>;
}

/** Deploy trigger interface -- only the subset HeartbeatLoop uses */
interface DeployTriggerContract {
  triggerReadinessCheck(): Promise<{ ready: boolean }>;
}

export class HeartbeatLoop {
  private intervalId: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private lastTick: Date | null = null;
  /**
   * Bumped by every start() and stop(). A timer callback captures the
   * generation it was armed under and refuses to re-arm into a newer one —
   * audited 2026-09-02: stop()+start() while a tick awaited agentCore.tick()
   * let the stale callback overwrite the new chain's handle and run a second,
   * untracked chain (2x ticks, 2x OODA spend) until the next stop.
   */
  private generation = 0;
  private readonly activeTriggerTasks = new Map<string, TaskId>();
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();

  /** Track budget exceeded/warning state to emit events only once per state change */
  private budgetExceededEmitted = false;
  private budgetWarningEmitted = false;
  /**
   * Same latch for the unified daemon sub-limit. Audited 2026-09-02: that emit
   * was unlatched, and its gate returns before the trigger loop, so the same
   * breach was re-announced every heartbeat tick (one push per tick, for up to
   * a whole day) instead of once per crossing.
   */
  private daemonSubLimitExceededEmitted = false;

  /** Consolidation state (Phase 25) */
  private consolidationEngine?: ConsolidationEngineContract;
  private consolidationConfig?: { idleMinutes: number };
  private consolidationAbort?: AbortController;
  private consolidationRunning = false;
  private lastUserActivity = Date.now();

  /** Deploy trigger (Phase 25) -- refreshed when user tasks settle */
  private deployTrigger?: DeployTriggerContract;
  private deployReadinessCheckInFlight?: Promise<void>;

  /** Unified Budget Manager (optional -- injected after construction) */
  private unifiedBudgetManager?: UnifiedBudgetManager;

  /** Agent Core autonomous reasoning loop (Phase 4) */
  private agentCore?: import("../agent-core/agent-core.js").AgentCore;

  constructor(
    private readonly registry: TriggerRegistry,
    private readonly taskManager: TaskManager,
    private readonly budgetTracker: BudgetTracker,
    private readonly securityPolicy: DaemonSecurityPolicy,
    private readonly approvalQueue: ApprovalQueue,
    private readonly storage: DaemonStorage,
    private readonly identityManager: IdentityActivity | undefined,
    private readonly eventBus: IEventBus<DaemonEventMap>,
    private readonly config: DaemonConfig,
    private readonly logger: winston.Logger,
    private readonly deduplicator?: TriggerDeduplicator,
  ) {}

  /**
   * Start the heartbeat loop. Loads circuit breaker states from storage,
   * marks daemon as running, and begins the interval timer.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;

    // Load persisted circuit breaker states
    const savedStates = this.storage.getAllCircuitStates();
    for (const [name, data] of savedStates) {
      try {
        this.circuitBreakers.set(
          name,
          CircuitBreaker.deserialize(
            {
              state: data.state as "CLOSED" | "OPEN" | "HALF_OPEN",
              consecutiveFailures: data.consecutiveFailures,
              lastFailureTime: data.lastFailureTime ?? 0,
              cooldownMs: data.cooldownMs,
            },
            this.config.backoff.failureThreshold,
            this.config.backoff.baseCooldownMs,
            this.config.backoff.maxCooldownMs,
          ),
        );
      } catch (err) {
        this.logger.warn("Failed to deserialize circuit breaker, using fresh state", { name, error: String(err) });
      }
    }

    // Persist daemon running state for crash recovery
    this.storage.setDaemonState("daemon_was_running", "true");

    this.logger.info("Daemon heartbeat started", {
      intervalMs: this.config.heartbeat.intervalMs,
      triggers: this.registry.count(),
      budget: this.config.budget.dailyBudgetUsd
        ? `$${this.config.budget.dailyBudgetUsd}`
        : "unlimited",
    });

    // Schedule first tick -- uses recursive setTimeout to prevent drift and
    // overlap when a tick() run exceeds the interval duration.
    this.scheduleNextTick();
  }

  /**
   * Arm the next tick `delayMs` from now (defaults to the configured interval).
   *
   * Audited 2026-09-02: this used to arm an intermediate timer for
   * `intervalMs - elapsed` whose only job was to call scheduleNextTick(),
   * which then armed ANOTHER full intervalMs — so ticks landed every
   * 2 * intervalMs while `/daemon status` reported intervalMs, and minute-pinned
   * crons on the unobserved parity never fired. The compensated delay IS the
   * schedule; it is passed straight into the one timer.
   */
  private scheduleNextTick(delayMs: number = this.config.heartbeat.intervalMs): void {
    const intervalMs = this.config.heartbeat.intervalMs;
    const armedGeneration = this.generation;
    this.intervalId = setTimeout(async () => {
      const start = Date.now();
      try {
        await this.tick();
      } catch (err) {
        this.logger.error("Heartbeat tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // A callback from a previous run (stop()+start() happened while it was
      // awaiting) must not re-arm into the current chain.
      if (!this.running || armedGeneration !== this.generation) return;
      const elapsed = Date.now() - start;
      this.scheduleNextTick(Math.max(0, intervalMs - elapsed));
    }, delayMs);
    this.intervalId.unref?.();
  }

  /**
   * Pause the heartbeat loop. Persists circuit breaker states and marks the
   * daemon as not running. Triggers stay registered and armed so a later
   * start() resumes them.
   *
   * Audited 2026-09-02: this used to dispose every trigger, and start() never
   * rebuilt them — FileWatchTrigger.dispose() closes its chokidar watcher for
   * good, so `/daemon stop` then `/daemon start` (or the dashboard toggle)
   * left file-watch triggers permanently dead while status still counted them
   * as armed. Disposal belongs to process shutdown: see shutdown().
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation += 1;

    if (this.intervalId) {
      clearTimeout(this.intervalId);
      this.intervalId = undefined;
    }

    // Persist all circuit breaker states
    for (const [name, cb] of this.circuitBreakers) {
      this.persistCircuitState(name, cb);
    }

    this.storage.setDaemonState("daemon_was_running", "false");
    this.logger.info("Daemon heartbeat stopped");
  }

  /**
   * Stop the loop AND release every trigger's resources (file watchers,
   * buffers). One-way: the loop cannot be restarted in-process afterwards.
   * Wired to process shutdown, never to the user-facing pause.
   */
  async shutdown(): Promise<void> {
    this.stop();
    const triggers = this.registry.getAll();
    if (triggers.length === 0) return;
    const results = await Promise.allSettled(triggers.map((t) => t.dispose?.()));
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        this.logger.warn("Trigger dispose failed during shutdown", {
          trigger: triggers[i]?.metadata.name,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
  }

  /**
   * Execute a single tick of the heartbeat loop.
   * Evaluates all active triggers sequentially.
   */
  async tick(): Promise<void> {
    if (!this.running) return;

    const now = new Date();

    // Expire stale approval requests
    this.approvalQueue.expireStale();

    // Prune old trigger fire history entries (Phase 21, OPS-01)
    try {
      const retentionMs = this.config.triggerFireRetentionDays * MS_PER_DAY;
      const pruned = this.storage.pruneTriggerFireHistoryByAge(retentionMs);
      if (pruned > 0) {
        this.logger.debug("Trigger fire history pruned", { count: pruned });
        this.eventBus.emit("daemon:maintenance", {
          type: "trigger_history_pruned",
          count: pruned,
          timestamp: now.getTime(),
        });
      }
    } catch (error) {
      this.logger.warn("Failed to prune trigger fire history", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Idle-driven memory consolidation (Phase 25, MEM-12, MEM-13)
    // Skip if all providers are in cooldown — consolidation requires LLM calls
    // and attempting them against overloaded providers just adds log noise.
    if (this.consolidationEngine && this.consolidationConfig && !this.consolidationRunning) {
      const idleMs = now.getTime() - this.lastUserActivity;
      const idleThresholdMs = this.consolidationConfig.idleMinutes * 60000;
      if (idleMs >= idleThresholdMs && !ProviderHealthRegistry.getInstance().areAllUnavailable()) {
        this.consolidationRunning = true;
        this.consolidationAbort = new AbortController();
        const signal = this.consolidationAbort.signal;
        const engine = this.consolidationEngine;
        // Fire-and-forget -- async consolidation runs in background
        void engine.runCycle(signal).then((result) => {
          if (result.status === "completed" || result.status === "interrupted") {
            this.eventBus.emit("daemon:maintenance", {
              type: "consolidation_" + result.status,
              count: result.processed,
              timestamp: Date.now(),
            });
            this.logger.info("Consolidation cycle finished", {
              status: result.status,
              processed: result.processed,
              clusters: result.clustersFound,
              cost: result.costUsd,
            });
          }
        }).catch((err: unknown) => {
          this.logger.warn("Consolidation cycle failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }).finally(() => {
          this.consolidationRunning = false;
          this.consolidationAbort = undefined;
        });
      }
    }

    // Get active triggers
    const triggers = this.registry.getActive();

    // Emit tick event
    this.eventBus.emit("daemon:tick", {
      timestamp: now.getTime(),
      triggerCount: triggers.length,
    });

    // Get budget usage once per tick (avoids up to 3 SQLite queries)
    const budgetUsage = this.budgetTracker.getUsage();

    // Unified budget check -- run once per tick, not per trigger
    if (this.unifiedBudgetManager) {
      this.unifiedBudgetManager.checkAndEmitEvents();
      if (this.unifiedBudgetManager.isGlobalExceeded()) {
        this.eventBus.emit("daemon:budget_exceeded", { source: "unified", timestamp: now.getTime() } as never);
        this.lastTick = now;
        return; // Skip all triggers this tick
      }
      // The portal's "Daemon daily sub-limit" (subLimits.daemonDailyUsd) was
      // accepted, persisted and displayed but read by nothing on the dispatch
      // path — isSourceExceeded() had no production caller, so the setting
      // enforced nothing (audited 2026-09-02). Gate the tick on it here, next
      // to the global wall, and name the limit that stopped the daemon.
      if (this.unifiedBudgetManager.isSourceExceeded("daemon")) {
        const usedUsd = this.unifiedBudgetManager.getSnapshot().breakdown.daemon;
        const limitUsd = this.unifiedBudgetManager.getConfig().subLimits.daemonDailyUsd;
        // Latched like the legacy budget wall (audited 2026-09-02): announce the
        // crossing once, not once per tick for as long as spend sits over it.
        if (!this.daemonSubLimitExceededEmitted) {
          this.eventBus.emit("daemon:budget_exceeded", {
            source: "unified:daemon-sublimit",
            usedUsd,
            limitUsd,
            timestamp: now.getTime(),
          } as never);
          this.daemonSubLimitExceededEmitted = true;
        }
        this.logger.info("Daemon daily sub-limit reached — triggers skipped this tick", { usedUsd, limitUsd });
        this.lastTick = now;
        return;
      }
      // Under the sub-limit again (window drained, or the operator raised it) —
      // re-arm so the next crossing is announced.
      this.daemonSubLimitExceededEmitted = false;
    }

    // Sequential evaluation -- prevents budget race conditions
    for (const trigger of triggers) {
      const name = trigger.metadata.name;

      // 1. Get or create circuit breaker
      const cb = this.getOrCreateCircuitBreaker(name);

      // 2. Check circuit breaker
      if (cb.isOpen()) {
        this.logger.debug("Trigger skipped (circuit open)", { trigger: name });
        continue;
      }

      if (budgetUsage.pct >= 1.0) {
        if (!this.budgetExceededEmitted) {
          this.eventBus.emit("daemon:budget_exceeded", {
            usedUsd: budgetUsage.usedUsd,
            limitUsd: budgetUsage.limitUsd ?? 0,
            timestamp: now.getTime(),
          });
          this.budgetExceededEmitted = true;
        }
        break;
      } else if (budgetUsage.limitUsd === undefined && this.unifiedBudgetManager) {
        // Fall back to unified budget manager when dailyBudgetUsd is undefined
        const globalExceeded = this.unifiedBudgetManager.isGlobalExceeded();
        if (globalExceeded) {
          if (!this.budgetExceededEmitted) {
            this.eventBus.emit("daemon:budget_exceeded", {
              usedUsd: budgetUsage.usedUsd,
              limitUsd: 0,
              timestamp: now.getTime(),
            });
            this.budgetExceededEmitted = true;
          }
          break;
        } else if (this.budgetExceededEmitted) {
          this.budgetExceededEmitted = false;
          this.budgetWarningEmitted = false;
        }
      } else {
        // Budget recovered -- reset flags so events fire again on next breach
        if (this.budgetExceededEmitted) {
          this.budgetExceededEmitted = false;
          this.budgetWarningEmitted = false;
        }
      }

      // 4. Check warning threshold. Same latch defect as the unified manager
      // (audited 2026-09-02): the flag was cleared only inside the exceeded-
      // recovery branches, so once the sliding window drained below warnPct
      // without a hard stop, no further warning could ever fire — and this
      // legacy event is the one that drives push notifications. Re-arm on
      // every drop below the threshold.
      if (budgetUsage.pct < this.config.budget.warnPct) {
        this.budgetWarningEmitted = false;
      }
      if (budgetUsage.pct >= this.config.budget.warnPct && !this.budgetWarningEmitted) {
        this.eventBus.emit("daemon:budget_warning", {
          usedUsd: budgetUsage.usedUsd,
          limitUsd: budgetUsage.limitUsd ?? 0,
          pct: budgetUsage.pct,
          timestamp: now.getTime(),
        });
        this.budgetWarningEmitted = true;
      }

      // 5. Check overlap suppression
      const existingTaskId = this.activeTriggerTasks.get(name);
      if (existingTaskId) {
        const taskStatus = this.taskManager.getStatus(existingTaskId);
        if (taskStatus && ACTIVE_STATUSES.has(taskStatus.status as TaskStatus)) {
          this.logger.debug("Trigger skipped (task still active)", {
            trigger: name,
            taskId: existingTaskId,
          });
          try {
            this.storage.insertTriggerFireHistory({
              triggerName: name,
              result: "deduplicated",
              taskId: existingTaskId,
              timestamp: now.getTime(),
            });
          } catch (err) {
            this.logger.warn("Failed to record trigger fire history", { trigger: name, error: String(err) });
          }
          continue;
        }
        // Task is done -- clean up
        this.activeTriggerTasks.delete(name);
      }

      if (
        this.config.heartbeat.idlePause &&
        this.taskManager.hasActiveForegroundTasks?.()
      ) {
        this.logger.debug("Trigger skipped (foreground task active)", { trigger: name });
        continue;
      }

      // 6. Evaluate trigger
      try {
        if (trigger.shouldFire(now)) {
          const cooldownMs = trigger.metadata.cooldownSeconds
            ? (trigger.metadata.cooldownSeconds * 1000)
            : 0;
          // Dedup check (TRIG-05) -- before onFired and task submission.
          // Hash what THIS fire would publish: description-rewriting triggers
          // expose it via previewFireDescription, because metadata.description
          // still holds the PREVIOUS fire's summary here (audited 2026-09-02:
          // hashing it let a true repeat through and then suppressed the next
          // genuinely new change set as a "duplicate").
          const fireContent = trigger.previewFireDescription?.(now) ?? trigger.metadata.description;
          if (this.deduplicator) {
            if (this.deduplicator.shouldSuppress(name, fireContent, now.getTime(), cooldownMs)) {
              const reason = this.deduplicator.getSuppressionReason();
              this.eventBus.emit("daemon:trigger_deduplicated", {
                triggerName: name,
                reason: reason ?? "cooldown",
                timestamp: now.getTime(),
              });
              try {
                this.storage.insertTriggerFireHistory({
                  triggerName: name,
                  result: "deduplicated",
                  timestamp: now.getTime(),
                });
              } catch (err) {
                this.logger.warn("Failed to record trigger fire history", { trigger: name, error: String(err) });
              }
              this.logger.debug("Trigger deduplicated", { trigger: name, reason });
              continue;
            }
          }

          // Emit type-specific events BEFORE onFired drains event buffers
          this.emitTypedTriggerEvent(trigger, name, now);

          trigger.onFired(now);

          // Approval-only triggers: DeployTrigger's whole effect is the
          // approval it enqueued in onFired, and its description is the
          // static label "Deployment readiness detection", not an instruction.
          // Audited 2026-09-02: submitting it spawned a full agent run against
          // that label on every readiness event, charged to the daemon budget.
          if (trigger.metadata.type === "deploy") {
            if (this.deduplicator) {
              this.deduplicator.recordFired(name, trigger.metadata.description, now.getTime(), cooldownMs);
            }
            cb.recordSuccess();
            this.persistCircuitState(name, cb);
            try {
              this.storage.insertTriggerFireHistory({
                triggerName: name,
                result: "success",
                timestamp: now.getTime(),
              });
            } catch (err) {
              this.logger.warn("Failed to record trigger fire history", { trigger: name, error: String(err) });
            }
            this.logger.info("Trigger fired (approval-only; no task submitted)", { trigger: name });
            continue;
          }

          // Mark trigger as in-flight BEFORE submission to prevent
          // duplicate fires if the next tick runs before submit returns.
          this.activeTriggerTasks.set(name, "pending" as TaskId);

          // Submit task via TaskManager with daemon origin
          const task = this.taskManager.submit(
            "daemon",
            "daemon",
            trigger.metadata.description,
            { origin: "daemon", triggerName: name },
          );

          // Record dedup fire — with this trigger's own cooldown so another
          // trigger's cleanup pass cannot evict it early (audited 2026-09-02)
          if (this.deduplicator) {
            this.deduplicator.recordFired(name, trigger.metadata.description, now.getTime(), cooldownMs);
          }

          // Update with real task ID now that submission succeeded
          this.activeTriggerTasks.set(name, task.id);

          // Record circuit breaker success
          cb.recordSuccess();
          this.persistCircuitState(name, cb);

          // Record activity in identity manager
          this.identityManager?.recordActivity();

          // Emit trigger fired event
          this.eventBus.emit("daemon:trigger_fired", {
            triggerName: name,
            taskId: task.id,
            timestamp: now.getTime(),
          });
          try {
            this.storage.insertTriggerFireHistory({
              triggerName: name,
              result: "success",
              taskId: task.id,
              timestamp: now.getTime(),
            });
          } catch (err) {
            this.logger.warn("Failed to record trigger fire history", { trigger: name, error: String(err) });
          }

          this.logger.info("Trigger fired", {
            trigger: name,
            taskId: task.id,
          });
        }
      } catch (error) {
        // Record circuit breaker failure
        cb.recordFailure();
        this.persistCircuitState(name, cb);

        // Emit trigger failed event
        this.eventBus.emit("daemon:trigger_failed", {
          triggerName: name,
          error: error instanceof Error ? error.message : String(error),
          circuitState: cb.getState(),
          timestamp: now.getTime(),
        });
        try {
          this.storage.insertTriggerFireHistory({
            triggerName: name,
            result: "failure",
            timestamp: now.getTime(),
          });
        } catch (histErr) {
          this.logger.warn("Failed to persist trigger fire history", {
            trigger: name,
            error: histErr instanceof Error ? histErr.message : String(histErr),
          });
        }

        this.logger.error("Trigger evaluation failed", {
          trigger: name,
          error: error instanceof Error ? error.message : String(error),
          circuitState: cb.getState(),
        });
      }
    }

    // Agent Core reasoning (Phase 4 — autonomous agent OODA loop)
    // Skip OODA tick when user foreground tasks are active to avoid
    // provider contention and unnecessary budget consumption.
    if (this.agentCore && !this.taskManager?.hasActiveForegroundTasks?.()) {
      // AgentCore.tick() has its own tickInFlight guard — safe to call every heartbeat
      await this.agentCore.tick();
    }

    // Update lastTick
    this.lastTick = now;
  }

  /**
   * Returns whether the heartbeat loop is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Returns the current daemon status for AgentStatusTool (Plan 05).
   */
  getDaemonStatus(): DaemonStatusSnapshot {
    return {
      running: this.running,
      intervalMs: this.config.heartbeat.intervalMs,
      triggerCount: this.registry.count(),
      lastTick: this.lastTick,
      budgetUsage: this.budgetTracker.getUsage(),
    };
  }

  /**
   * Get a circuit breaker for a specific trigger (for status display and manual reset).
   */
  getCircuitBreaker(triggerName: string): CircuitBreaker | undefined {
    return this.circuitBreakers.get(triggerName);
  }

  /**
   * Get the security policy (for Plan 05 AgentStatusTool and approval flow).
   */
  getSecurityPolicy(): DaemonSecurityPolicy {
    return this.securityPolicy;
  }

  /**
   * Get the deduplicator (for CLI stats display).
   */
  getDeduplicator(): TriggerDeduplicator | undefined {
    return this.deduplicator;
  }

  /**
   * Set the consolidation engine for idle-driven memory consolidation (Phase 25).
   */
  setConsolidationEngine(engine: ConsolidationEngineContract, config: { idleMinutes: number }): void {
    this.consolidationEngine = engine;
    this.consolidationConfig = config;
  }

  /**
   * Set the deploy trigger for readiness checks after task/goal completion (Phase 25).
   */
  setDeployTrigger(trigger: DeployTriggerContract): void {
    this.deployTrigger = trigger;
  }

  /**
   * Refresh deployment readiness after a non-daemon task settles.
   * The cached readiness is then evaluated on the next heartbeat tick.
   */
  onTaskSettled(taskId: TaskId): void {
    if (!this.running || !this.deployTrigger || this.deployReadinessCheckInFlight) {
      return;
    }

    const task = this.taskManager.getStatus(taskId);
    if (!task || task.origin === "daemon") {
      return;
    }

    this.deployReadinessCheckInFlight = this.deployTrigger
      .triggerReadinessCheck()
      .then((result) => {
        this.logger.debug("Deployment readiness refreshed after task settlement", {
          taskId,
          ready: result.ready,
        });
      })
      .catch((error: unknown) => {
        this.logger.warn("Deployment readiness check failed", {
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.deployReadinessCheckInFlight = undefined;
      });
  }

  /**
   * Set the Agent Core for autonomous OODA reasoning each tick (Phase 4).
   */
  setAgentCore(core: import("../agent-core/agent-core.js").AgentCore): void {
    this.agentCore = core;
  }

  /**
   * Set the Unified Budget Manager for global cross-source budget enforcement.
   */
  setUnifiedBudgetManager(mgr: UnifiedBudgetManager): void {
    this.unifiedBudgetManager = mgr;
  }

  /**
   * Record user activity timestamp and abort any in-progress consolidation (MEM-13).
   * Called from message handler when user sends a message.
   */
  onUserActivity(): void {
    this.lastUserActivity = Date.now();
    if (this.consolidationRunning && this.consolidationAbort) {
      this.consolidationAbort.abort();
      this.logger.info("Consolidation interrupted by user activity");
    }
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  /**
   * Emit a type-specific event based on the trigger type.
   * These events are broadcast over WebSocket for real-time dashboard updates.
   */
  private emitTypedTriggerEvent(trigger: { metadata: { type: TriggerType; name: string; description: string }; getPendingEvents?: () => ReadonlyArray<unknown>; getDueItems?: () => ReadonlyArray<unknown> }, name: string, now: Date): void {
    switch (trigger.metadata.type) {
      case "file-watch": {
        const fwTrigger = trigger as { getPendingEvents?: () => ReadonlyArray<{ path: string; event: string }> };
        const events = fwTrigger.getPendingEvents?.() ?? [];
        this.eventBus.emit("daemon:file_change", {
          triggerName: name,
          paths: events.map((e) => e.path),
          eventTypes: events.map((e) => e.event),
          timestamp: now.getTime(),
        });
        break;
      }
      case "checklist": {
        const clTrigger = trigger as { getDueItems?: () => ReadonlyArray<{ text: string; priority: string }> };
        const items = clTrigger.getDueItems?.() ?? [];
        this.eventBus.emit("daemon:checklist_due", {
          triggerName: name,
          items,
          timestamp: now.getTime(),
        });
        break;
      }
      case "webhook": {
        this.eventBus.emit("daemon:webhook_received", {
          triggerName: name,
          action: trigger.metadata.description,
          timestamp: now.getTime(),
        });
        break;
      }
      // cron: no additional typed event (trigger_fired is sufficient)
    }
  }

  private persistCircuitState(name: string, cb: CircuitBreaker): void {
    const snap = cb.serialize();
    this.storage.upsertCircuitState(
      name,
      snap.state,
      snap.consecutiveFailures,
      snap.lastFailureTime,
      snap.cooldownMs,
    );
  }

  private getOrCreateCircuitBreaker(triggerName: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(triggerName);
    if (!cb) {
      cb = new CircuitBreaker(
        this.config.backoff.failureThreshold,
        this.config.backoff.baseCooldownMs,
        this.config.backoff.maxCooldownMs,
      );
      this.circuitBreakers.set(triggerName, cb);
    }
    return cb;
  }
}
