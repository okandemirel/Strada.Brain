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
import type { DaemonConfig } from "./daemon-types.js";
import type { DaemonEventMap } from "./daemon-events.js";
import type { IEventBus } from "../core/event-bus.js";
import type { TaskId } from "../tasks/types.js";
import { ACTIVE_STATUSES } from "../tasks/types.js";
import { CircuitBreaker } from "./resilience/circuit-breaker.js";
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
   * Stop the heartbeat loop. Persists circuit breaker states
   * and marks daemon as not running.
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
      const snap = cb.serialize();
      this.storage.upsertCircuitState(
        name,
        snap.state,
        snap.consecutiveFailures,
        snap.lastFailureTime,
        snap.cooldownMs,
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
      if (this.budgetTracker.isExceeded()) {
        if (!this.budgetExceededEmitted) {
          const usage = this.budgetTracker.getUsage();
          this.eventBus.emit("daemon:budget_exceeded", {
            usedUsd: usage.usedUsd,
            limitUsd: usage.limitUsd ?? 0,
            timestamp: now.getTime(),
          });
          this.budgetExceededEmitted = true;
        }
        break;
      }

      // 4. Check warning threshold
      if (this.budgetTracker.isWarning() && !this.budgetWarningEmitted) {
        const usage = this.budgetTracker.getUsage();
        this.eventBus.emit("daemon:budget_warning", {
          usedUsd: usage.usedUsd,
          limitUsd: usage.limitUsd ?? 0,
          pct: usage.pct,
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
          trigger.onFired(now);

          // Submit task via TaskManager with daemon origin
          const task = this.taskManager.submit(
            "daemon",
            "daemon",
            trigger.metadata.description,
            { origin: "daemon" },
          );

          // Track active task for overlap suppression
          this.activeTriggerTasks.set(name, task.id);

          // Record circuit breaker success
          cb.recordSuccess();

          // Persist circuit breaker state
          const snap = cb.serialize();
          this.storage.upsertCircuitState(
            name,
            snap.state,
            snap.consecutiveFailures,
            snap.lastFailureTime,
            snap.cooldownMs,
          );

          // Record activity in identity manager
          this.identityManager?.recordActivity();

          // Emit trigger fired event
          this.eventBus.emit("daemon:trigger_fired", {
            triggerName: name,
            taskId: task.id,
            timestamp: now.getTime(),
          });

          this.logger.info("Trigger fired", {
            trigger: name,
            taskId: task.id,
          });
        }
      } catch (error) {
        // Record circuit breaker failure
        cb.recordFailure();

        // Persist circuit breaker state
        const snap = cb.serialize();
        this.storage.upsertCircuitState(
          name,
          snap.state,
          snap.consecutiveFailures,
          snap.lastFailureTime,
          snap.cooldownMs,
        );

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
  getDaemonStatus(): {
    running: boolean;
    intervalMs: number;
    triggerCount: number;
    lastTick: Date | null;
    budgetUsage: { usedUsd: number; limitUsd: number | undefined; pct: number };
  } {
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

  // ===========================================================================
  // Private
  // ===========================================================================

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
