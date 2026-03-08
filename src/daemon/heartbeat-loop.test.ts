/**
 * HeartbeatLoop Integration Tests
 *
 * Tests the tick-evaluate-fire pipeline: circuit breaker gates, budget checks,
 * overlap suppression, trigger fire/failure handling, and daemon status reporting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HeartbeatLoop } from "./heartbeat-loop.js";
import { TriggerRegistry } from "./trigger-registry.js";
import { CircuitBreaker } from "./resilience/circuit-breaker.js";
import type { ITrigger, TriggerMetadata, TriggerState, DaemonConfig } from "./daemon-types.js";
import type { DaemonEventMap } from "./daemon-events.js";
import type { IEventBus } from "../core/event-bus.js";
import type { TaskId } from "../tasks/types.js";
import { ACTIVE_STATUSES } from "../tasks/types.js";

// =============================================================================
// MOCKS
// =============================================================================

function makeTrigger(
  name: string,
  opts: {
    shouldFire?: boolean;
    state?: TriggerState;
    description?: string;
  } = {},
): ITrigger {
  const metadata: TriggerMetadata = {
    name,
    description: opts.description ?? `Trigger: ${name}`,
    type: "cron",
  };
  return {
    metadata,
    shouldFire: vi.fn(() => opts.shouldFire ?? false),
    onFired: vi.fn(),
    getNextRun: () => null,
    getState: vi.fn(() => opts.state ?? "active"),
  };
}

function makeTaskManager() {
  const tasks = new Map<string, { id: string; status: string }>();
  let taskCounter = 0;
  return {
    submit: vi.fn((_chatId: string, _channelType: string, _prompt: string, _options?: { origin?: string }) => {
      const id = `task_${++taskCounter}` as TaskId;
      const task = { id, chatId: _chatId, channelType: _channelType, title: _prompt.slice(0, 80), status: "pending", prompt: _prompt, progress: [], createdAt: Date.now(), updatedAt: Date.now() };
      tasks.set(id, { id, status: "pending" });
      return task;
    }),
    getStatus: vi.fn((taskId: string) => {
      const t = tasks.get(taskId);
      if (!t) return null;
      return { ...t, status: t.status };
    }),
    _setTaskStatus: (taskId: string, status: string) => {
      const t = tasks.get(taskId);
      if (t) t.status = status;
    },
    on: vi.fn(),
    emit: vi.fn(),
  };
}

function makeBudgetTracker(exceeded = false, warning = false) {
  return {
    isExceeded: vi.fn(() => exceeded),
    isWarning: vi.fn(() => warning),
    getUsage: vi.fn(() => ({ usedUsd: 0, limitUsd: 10, pct: 0 })),
    recordCost: vi.fn(),
    resetBudget: vi.fn(),
  };
}

function makeSecurityPolicy() {
  return {
    checkPermission: vi.fn(() => "allow" as const),
    requestApproval: vi.fn(),
  };
}

function makeApprovalQueue() {
  return {
    expireStale: vi.fn(),
    enqueue: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    getPending: vi.fn(() => []),
    getById: vi.fn(),
    getAuditLog: vi.fn(() => []),
  };
}

function makeStorage() {
  const state = new Map<string, string>();
  const circuitStates = new Map<string, {
    state: string;
    consecutiveFailures: number;
    lastFailureTime: number | null;
    cooldownMs: number;
  }>();
  return {
    getDaemonState: vi.fn((key: string) => state.get(key)),
    setDaemonState: vi.fn((key: string, value: string) => { state.set(key, value); }),
    upsertCircuitState: vi.fn((name: string, st: string, failures: number, lastTime: number | null, cooldown: number) => {
      circuitStates.set(name, { state: st, consecutiveFailures: failures, lastFailureTime: lastTime, cooldownMs: cooldown });
    }),
    getCircuitState: vi.fn((name: string) => circuitStates.get(name)),
    getAllCircuitStates: vi.fn(() => circuitStates),
    deleteCircuitState: vi.fn(),
    initialize: vi.fn(),
    close: vi.fn(),
  };
}

function makeIdentityManager() {
  return {
    recordActivity: vi.fn(),
  };
}

function makeEventBus(): IEventBus<DaemonEventMap> {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeDaemonConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    heartbeat: {
      intervalMs: 60000,
      heartbeatFile: "HEARTBEAT.md",
      idlePause: false,
    },
    security: {
      approvalTimeoutMin: 30,
      autoApproveTools: [],
    },
    budget: {
      dailyBudgetUsd: 10,
      warnPct: 0.8,
    },
    backoff: {
      baseCooldownMs: 60000,
      maxCooldownMs: 3600000,
      failureThreshold: 3,
    },
    timezone: "UTC",
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("HeartbeatLoop", () => {
  let registry: TriggerRegistry;
  let taskManager: ReturnType<typeof makeTaskManager>;
  let budgetTracker: ReturnType<typeof makeBudgetTracker>;
  let securityPolicy: ReturnType<typeof makeSecurityPolicy>;
  let approvalQueue: ReturnType<typeof makeApprovalQueue>;
  let storage: ReturnType<typeof makeStorage>;
  let identityManager: ReturnType<typeof makeIdentityManager>;
  let eventBus: IEventBus<DaemonEventMap>;
  let config: DaemonConfig;
  let logger: ReturnType<typeof makeLogger>;
  let loop: HeartbeatLoop;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new TriggerRegistry();
    taskManager = makeTaskManager();
    budgetTracker = makeBudgetTracker();
    securityPolicy = makeSecurityPolicy();
    approvalQueue = makeApprovalQueue();
    storage = makeStorage();
    identityManager = makeIdentityManager();
    eventBus = makeEventBus();
    config = makeDaemonConfig();
    logger = makeLogger();

    loop = new HeartbeatLoop(
      registry,
      taskManager as any,
      budgetTracker as any,
      securityPolicy as any,
      approvalQueue as any,
      storage as any,
      identityManager as any,
      eventBus,
      config,
      logger as any,
    );
  });

  afterEach(() => {
    loop.stop();
    vi.useRealTimers();
  });

  // =========================================================================
  // Start / Stop / isRunning
  // =========================================================================

  it("start() begins interval, isRunning returns true", () => {
    expect(loop.isRunning()).toBe(false);
    loop.start();
    expect(loop.isRunning()).toBe(true);
  });

  it("stop() clears interval and sets running to false", () => {
    loop.start();
    expect(loop.isRunning()).toBe(true);
    loop.stop();
    expect(loop.isRunning()).toBe(false);
  });

  it("start() stores daemon_was_running state", () => {
    loop.start();
    expect(storage.setDaemonState).toHaveBeenCalledWith("daemon_was_running", "true");
  });

  it("stop() stores daemon_was_running=false", () => {
    loop.start();
    loop.stop();
    expect(storage.setDaemonState).toHaveBeenCalledWith("daemon_was_running", "false");
  });

  // =========================================================================
  // Tick -- trigger evaluation
  // =========================================================================

  it("tick() is called after intervalMs", async () => {
    const trigger = makeTrigger("t1", { shouldFire: false });
    registry.register(trigger);
    loop.start();

    // Advance past intervalMs
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    // shouldFire should have been called (trigger was evaluated)
    expect(trigger.shouldFire).toHaveBeenCalled();
  });

  it("tick() iterates over registry.getActive() and calls shouldFire(now)", async () => {
    const t1 = makeTrigger("t1", { shouldFire: false });
    const t2 = makeTrigger("t2", { shouldFire: false });
    registry.register(t1);
    registry.register(t2);

    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    expect(t1.shouldFire).toHaveBeenCalled();
    expect(t2.shouldFire).toHaveBeenCalled();
  });

  it("when shouldFire returns true, trigger.onFired is called and task is submitted", async () => {
    const trigger = makeTrigger("fire-me", { shouldFire: true });
    registry.register(trigger);

    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    expect(trigger.onFired).toHaveBeenCalled();
    expect(taskManager.submit).toHaveBeenCalledWith(
      "daemon",
      "daemon",
      expect.any(String),
      expect.objectContaining({ origin: "daemon" }),
    );
  });

  it("submitted task has origin 'daemon'", async () => {
    const trigger = makeTrigger("daemon-origin", { shouldFire: true });
    registry.register(trigger);

    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    const call = taskManager.submit.mock.calls[0];
    expect(call[3]).toEqual(expect.objectContaining({ origin: "daemon" }));
  });

  // =========================================================================
  // Circuit breaker
  // =========================================================================

  it("when circuit breaker isOpen(), trigger is skipped", async () => {
    const trigger = makeTrigger("broken", { shouldFire: true });
    registry.register(trigger);

    // Pre-load a circuit breaker in OPEN state via storage
    storage.getAllCircuitStates.mockReturnValue(
      new Map([
        ["broken", {
          state: "OPEN",
          consecutiveFailures: 5,
          lastFailureTime: Date.now(),
          cooldownMs: 999999999, // Very long cooldown so it stays open
        }],
      ]),
    );

    // Re-create loop so it loads the circuit breaker states on start()
    loop = new HeartbeatLoop(
      registry, taskManager as any, budgetTracker as any, securityPolicy as any,
      approvalQueue as any, storage as any, identityManager as any, eventBus,
      config, logger as any,
    );
    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    expect(trigger.shouldFire).not.toHaveBeenCalled();
    expect(taskManager.submit).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Budget
  // =========================================================================

  it("when budgetTracker.isExceeded(), tick breaks early", async () => {
    budgetTracker = makeBudgetTracker(true);
    const t1 = makeTrigger("t1", { shouldFire: true });
    const t2 = makeTrigger("t2", { shouldFire: true });
    registry.register(t1);
    registry.register(t2);

    loop = new HeartbeatLoop(
      registry, taskManager as any, budgetTracker as any, securityPolicy as any,
      approvalQueue as any, storage as any, identityManager as any, eventBus,
      config, logger as any,
    );
    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    // Neither trigger should fire because budget is exceeded
    expect(taskManager.submit).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Circuit breaker success/failure recording
  // =========================================================================

  it("on trigger fire success, circuit breaker recordSuccess() is tracked", async () => {
    const trigger = makeTrigger("success-cb", { shouldFire: true });
    registry.register(trigger);

    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    // Circuit state should have been persisted after success
    expect(storage.upsertCircuitState).toHaveBeenCalledWith(
      "success-cb",
      expect.any(String),
      expect.any(Number),
      expect.anything(),
      expect.any(Number),
    );
  });

  it("on trigger fire failure, circuit breaker recordFailure() is called", async () => {
    const trigger = makeTrigger("fail-cb", { shouldFire: true });
    // Make onFired throw
    (trigger.onFired as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("fire failed");
    });
    registry.register(trigger);

    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    // Should have emitted trigger_failed
    expect(eventBus.emit).toHaveBeenCalledWith(
      "daemon:trigger_failed",
      expect.objectContaining({ triggerName: "fail-cb" }),
    );
    // Circuit state persisted after failure
    expect(storage.upsertCircuitState).toHaveBeenCalled();
  });

  // =========================================================================
  // Approval queue expiry
  // =========================================================================

  it("approval queue expireStale() is called each tick", async () => {
    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    expect(approvalQueue.expireStale).toHaveBeenCalled();
  });

  // =========================================================================
  // Silent logging
  // =========================================================================

  it("no log output on idle ticks (only on trigger fire or error)", async () => {
    // No triggers registered -- idle tick
    loop.start();
    logger.info.mockClear(); // Clear startup logs

    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    // info should not be called during idle tick (no triggers fired)
    const infoCalls = logger.info.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && !c[0].includes("Daemon"),
    );
    expect(infoCalls).toHaveLength(0);
  });

  // =========================================================================
  // getDaemonStatus
  // =========================================================================

  it("getDaemonStatus() returns correct status", () => {
    const trigger = makeTrigger("s1");
    registry.register(trigger);
    loop.start();

    const status = loop.getDaemonStatus();
    expect(status).toEqual(
      expect.objectContaining({
        running: true,
        intervalMs: 60000,
        triggerCount: 1,
      }),
    );
    expect(status).toHaveProperty("lastTick");
    expect(status).toHaveProperty("budgetUsage");
  });

  it("isRunning() returns correct state", () => {
    expect(loop.isRunning()).toBe(false);
    loop.start();
    expect(loop.isRunning()).toBe(true);
    loop.stop();
    expect(loop.isRunning()).toBe(false);
  });

  // =========================================================================
  // Overlap suppression
  // =========================================================================

  it("trigger with pending/executing task is skipped (overlap suppression)", async () => {
    const trigger = makeTrigger("overlap-test", { shouldFire: true });
    registry.register(trigger);

    loop.start();

    // First tick: trigger fires, task submitted
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);
    expect(taskManager.submit).toHaveBeenCalledTimes(1);

    // Second tick: the task is still pending so trigger should be skipped
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);
    expect(taskManager.submit).toHaveBeenCalledTimes(1); // Still 1, not 2
  });

  // =========================================================================
  // Event emissions
  // =========================================================================

  it("emits daemon:tick event on each tick", async () => {
    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    expect(eventBus.emit).toHaveBeenCalledWith(
      "daemon:tick",
      expect.objectContaining({ triggerCount: expect.any(Number) }),
    );
  });

  it("emits daemon:trigger_fired on successful fire", async () => {
    const trigger = makeTrigger("fire-event", { shouldFire: true });
    registry.register(trigger);

    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    expect(eventBus.emit).toHaveBeenCalledWith(
      "daemon:trigger_fired",
      expect.objectContaining({ triggerName: "fire-event" }),
    );
  });

  it("emits daemon:budget_exceeded when budget is exceeded", async () => {
    budgetTracker = makeBudgetTracker(true);
    const trigger = makeTrigger("budget-test", { shouldFire: true });
    registry.register(trigger);

    loop = new HeartbeatLoop(
      registry, taskManager as any, budgetTracker as any, securityPolicy as any,
      approvalQueue as any, storage as any, identityManager as any, eventBus,
      config, logger as any,
    );
    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    expect(eventBus.emit).toHaveBeenCalledWith(
      "daemon:budget_exceeded",
      expect.objectContaining({ timestamp: expect.any(Number) }),
    );
  });

  // =========================================================================
  // Identity manager integration
  // =========================================================================

  it("records activity on trigger fire", async () => {
    const trigger = makeTrigger("identity-test", { shouldFire: true });
    registry.register(trigger);

    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    expect(identityManager.recordActivity).toHaveBeenCalled();
  });

  // =========================================================================
  // undefined identityManager
  // =========================================================================

  it("works without identityManager", async () => {
    const trigger = makeTrigger("no-identity", { shouldFire: true });
    registry.register(trigger);

    loop = new HeartbeatLoop(
      registry, taskManager as any, budgetTracker as any, securityPolicy as any,
      approvalQueue as any, storage as any, undefined, eventBus,
      config, logger as any,
    );
    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    // Should not throw
    expect(taskManager.submit).toHaveBeenCalled();
  });

  // =========================================================================
  // getCircuitBreaker
  // =========================================================================

  it("getCircuitBreaker returns breaker for known trigger", async () => {
    const trigger = makeTrigger("cb-lookup", { shouldFire: true });
    registry.register(trigger);

    loop.start();
    await vi.advanceTimersByTimeAsync(config.heartbeat.intervalMs + 10);

    const cb = loop.getCircuitBreaker("cb-lookup");
    expect(cb).toBeDefined();
    expect(cb!.getState()).toBe("CLOSED");
  });

  it("getCircuitBreaker returns undefined for unknown trigger", () => {
    loop.start();
    expect(loop.getCircuitBreaker("nonexistent")).toBeUndefined();
  });
});
