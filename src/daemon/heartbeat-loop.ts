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

import type { TriggerRegistry } from "./trigger-registry.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { BudgetTracker } from "./budget/budget-tracker.js";
import type { DaemonSecurityPolicy } from "./security/daemon-security-policy.js";
import type { ApprovalQueue } from "./security/approval-queue.js";
import type { DaemonStorage } from "./daemon-storage.js";
import type { DaemonConfig, DaemonStatusSnapshot } from "./daemon-types.js";
import type { DaemonEventMap } from "./daemon-events.js";
import type { IEventBus } from "../core/event-bus.js";
import type { TaskId } from "../tasks/types.js";
import { ACTIVE_STATUSES } from "../tasks/types.js";
import { CircuitBreaker } from "./resilience/circuit-breaker.js";
import type { TriggerDeduplicator } from "./dedup/trigger-deduplicator.js";
import type * as winston from "winston";

/** Identity manager interface -- only the subset HeartbeatLoop uses */
interface IdentityActivity {
  recordActivity(): void;
}

export class HeartbeatLoop {
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private lastTick: Date | null = null;
  private readonly activeTriggerTasks = new Map<string, TaskId>();
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();

  /** Track budget exceeded/warning state to emit events only once per state change */
  private budgetExceededEmitted = false;
  private budgetWarningEmitted = false;

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

    // Load persisted circuit breaker states
    const savedStates = this.storage.getAllCircuitStates();
    for (const [name, data] of savedStates) {
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

    // Create interval -- unref so it doesn't prevent process exit
    this.intervalId = setInterval(() => {
      void this.tick();
    }, this.config.heartbeat.intervalMs);
    this.intervalId.unref();
  }

  /**
   * Stop the heartbeat loop. Persists circuit breaker states,
   * disposes all triggers, and marks daemon as not running.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    // Persist all circuit breaker states
    for (const [name, cb] of this.circuitBreakers) {
      this.persistCircuitState(name, cb);
    }

    // Dispose all triggers (fire-and-forget -- stop() is sync)
    const triggers = this.registry.getAll();
    if (triggers.length > 0) {
      void Promise.allSettled(
        triggers.map((t) => t.dispose?.()),
      );
    }

    this.storage.setDaemonState("daemon_was_running", "false");
    this.logger.info("Daemon heartbeat stopped");
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

    // Get active triggers
    const triggers = this.registry.getActive();

    // Emit tick event
    this.eventBus.emit("daemon:tick", {
      timestamp: now.getTime(),
      triggerCount: triggers.length,
    });

    // Get budget usage once per tick (avoids up to 3 SQLite queries)
    const budgetUsage = this.budgetTracker.getUsage();

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

      // 3. Check budget
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
      }

      // 4. Check warning threshold
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
        if (taskStatus && ACTIVE_STATUSES.has(taskStatus.status as any)) {
          this.logger.debug("Trigger skipped (task still active)", {
            trigger: name,
            taskId: existingTaskId,
          });
          continue;
        }
        // Task is done -- clean up
        this.activeTriggerTasks.delete(name);
      }

      // 6. Evaluate trigger
      try {
        if (trigger.shouldFire(now)) {
          // Dedup check (TRIG-05) -- before onFired and task submission
          if (this.deduplicator) {
            const cooldownMs = trigger.metadata.cooldownSeconds
              ? (trigger.metadata.cooldownSeconds * 1000)
              : 0;
            if (this.deduplicator.shouldSuppress(name, trigger.metadata.description, now.getTime(), cooldownMs)) {
              const reason = this.deduplicator.getSuppressionReason();
              this.eventBus.emit("daemon:trigger_deduplicated", {
                triggerName: name,
                reason: reason ?? "cooldown",
                timestamp: now.getTime(),
              });
              this.logger.debug("Trigger deduplicated", { trigger: name, reason });
              continue;
            }
          }

          trigger.onFired(now);

          // Submit task via TaskManager with daemon origin
          const task = this.taskManager.submit(
            "daemon",
            "daemon",
            trigger.metadata.description,
            { origin: "daemon" },
          );

          // Record dedup fire
          if (this.deduplicator) {
            this.deduplicator.recordFired(name, trigger.metadata.description, now.getTime());
          }

          // Track active task for overlap suppression
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

          // Emit type-specific events for WebSocket broadcasting
          this.emitTypedTriggerEvent(trigger, name, now);

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

        this.logger.error("Trigger evaluation failed", {
          trigger: name,
          error: error instanceof Error ? error.message : String(error),
          circuitState: cb.getState(),
        });
      }
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

  // ===========================================================================
  // Private
  // ===========================================================================

  /**
   * Emit a type-specific event based on the trigger type.
   * These events are broadcast over WebSocket for real-time dashboard updates.
   */
  private emitTypedTriggerEvent(trigger: { metadata: { type: string; name: string; description: string }; getPendingEvents?: () => ReadonlyArray<unknown>; getDueItems?: () => ReadonlyArray<unknown> }, name: string, now: Date): void {
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
