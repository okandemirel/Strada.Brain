/**
 * Daemon CLI Tests
 *
 * Tests for registerDaemonCommands: status, trigger, reset, audit, config, budget reset.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { registerDaemonCommands, type DaemonContext } from "./daemon-cli.js";
import type { DaemonConfig, ITrigger, TriggerMetadata, TriggerState, AuditEntry } from "./daemon-types.js";
import { CircuitBreaker } from "./resilience/circuit-breaker.js";

// =============================================================================
// HELPERS
// =============================================================================

function makeDaemonConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  return {
    heartbeat: { intervalMs: 60000, heartbeatFile: "HEARTBEAT.md", idlePause: true },
    security: { approvalTimeoutMin: 15, autoApproveTools: ["file_read"] },
    budget: { dailyBudgetUsd: 5.0, warnPct: 0.8 },
    backoff: { baseCooldownMs: 60000, maxCooldownMs: 3600000, failureThreshold: 3 },
    timezone: "UTC",
    triggers: {
      webhookRateLimit: "10/min",
      dedupWindowMs: 300000,
      defaultDebounceMs: 500,
      checklistMorningHour: 9,
      checklistAfternoonHour: 14,
      checklistEveningHour: 18,
    },
    triggerFireRetentionDays: 30,
    ...overrides,
  };
}

function makeTrigger(name: string, opts: { state?: TriggerState; type?: string; nextRun?: Date | null } = {}): ITrigger {
  const metadata: TriggerMetadata = { name, description: `Trigger: ${name}`, type: opts.type ?? "cron" };
  return {
    metadata,
    shouldFire: vi.fn(() => false),
    onFired: vi.fn(),
    getNextRun: () => opts.nextRun ?? null,
    getState: vi.fn(() => opts.state ?? "active"),
  };
}

function makeMockContext(overrides?: Partial<DaemonContext>): DaemonContext {
  return {
    heartbeatLoop: {
      isRunning: vi.fn(() => true),
      getDaemonStatus: vi.fn(() => ({
        running: true,
        intervalMs: 60000,
        triggerCount: 2,
        lastTick: new Date("2026-03-08T12:00:00Z"),
        budgetUsage: { usedUsd: 3.42, limitUsd: 5.0, pct: 0.684 },
      })),
      getCircuitBreaker: vi.fn(() => undefined),
    },
    registry: {
      getAll: vi.fn(() => []),
      getByName: vi.fn(() => undefined),
      count: vi.fn(() => 0),
    },
    budgetTracker: {
      getUsage: vi.fn(() => ({ usedUsd: 3.42, limitUsd: 5.0, pct: 0.684 })),
      resetBudget: vi.fn(),
    },
    approvalQueue: {
      getPending: vi.fn(() => []),
      getAuditLog: vi.fn(() => []),
    },
    storage: {
      upsertCircuitState: vi.fn(),
    },
    config: makeDaemonConfig(),
    ...overrides,
  } as unknown as DaemonContext;
}

/**
 * Execute a daemon subcommand by parsing CLI args, capturing console output.
 */
async function runDaemonCommand(
  getDaemonContext: () => DaemonContext | undefined,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });

  registerDaemonCommands(program, getDaemonContext);

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => stdoutLines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderrLines.push(args.map(String).join(" "));

  try {
    await program.parseAsync(["node", "strata", "daemon", ...args]);
  } catch {
    // Commander may throw on exitOverride
  } finally {
    console.log = origLog;
    console.error = origError;
  }

  return { stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n") };
}

// =============================================================================
// TESTS
// =============================================================================

describe("registerDaemonCommands", () => {
  it("adds a 'daemon' command group to Commander", () => {
    const program = new Command();
    program.exitOverride();
    registerDaemonCommands(program, () => undefined);

    const daemonCmd = program.commands.find((c) => c.name() === "daemon");
    expect(daemonCmd).toBeDefined();
    // Should have subcommands
    expect(daemonCmd!.commands.length).toBeGreaterThan(0);
  });
});

describe("daemon status", () => {
  it("formats daemon state with trigger table, budget, and pending approvals", async () => {
    const trigger1 = makeTrigger("daily-report", { type: "cron", nextRun: new Date("2026-03-09T00:00:00Z") });
    const trigger2 = makeTrigger("health-check", { type: "cron", state: "paused" });
    const cb = new CircuitBreaker(3, 60000, 3600000);

    const ctx = makeMockContext({
      registry: {
        getAll: vi.fn(() => [trigger1, trigger2]),
        getByName: vi.fn(),
        count: vi.fn(() => 2),
      } as any,
      heartbeatLoop: {
        isRunning: vi.fn(() => true),
        getDaemonStatus: vi.fn(() => ({
          running: true,
          intervalMs: 60000,
          triggerCount: 2,
          lastTick: new Date("2026-03-08T12:00:00Z"),
          budgetUsage: { usedUsd: 3.42, limitUsd: 5.0, pct: 0.684 },
        })),
        getCircuitBreaker: vi.fn((name: string) => name === "daily-report" ? cb : undefined),
      } as any,
      approvalQueue: {
        getPending: vi.fn(() => [{ id: "1", toolName: "file_write", status: "pending" }]),
        getAuditLog: vi.fn(() => []),
      } as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["status"]);

    expect(stdout).toContain("running");
    expect(stdout).toContain("daily-report");
    expect(stdout).toContain("health-check");
    expect(stdout).toContain("3.42");
    expect(stdout).toContain("5.00");
    // Should mention pending approvals
    expect(stdout).toContain("1");
  });

  it("shows 'Daemon: not running' when context is undefined", async () => {
    const { stdout } = await runDaemonCommand(() => undefined, ["status"]);
    expect(stdout.toLowerCase()).toContain("not running");
  });
});

describe("daemon trigger <name>", () => {
  it("fires a named trigger manually", async () => {
    const trigger = makeTrigger("daily-report");
    const ctx = makeMockContext({
      registry: {
        getAll: vi.fn(() => [trigger]),
        getByName: vi.fn((name: string) => name === "daily-report" ? trigger : undefined),
        count: vi.fn(() => 1),
      } as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["trigger", "daily-report"]);

    expect(trigger.onFired).toHaveBeenCalled();
    expect(stdout.toLowerCase()).toContain("fired");
    expect(stdout).toContain("daily-report");
  });

  it("errors when trigger not found", async () => {
    const ctx = makeMockContext();

    const { stderr } = await runDaemonCommand(() => ctx, ["trigger", "nonexistent"]);

    expect(stderr.toLowerCase()).toContain("not found");
  });
});

describe("daemon reset <name>", () => {
  it("resets circuit breaker for a named trigger", async () => {
    const cb = new CircuitBreaker(3, 60000, 3600000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure(); // Opens circuit

    expect(cb.getState()).toBe("OPEN");

    const ctx = makeMockContext({
      heartbeatLoop: {
        isRunning: vi.fn(() => true),
        getDaemonStatus: vi.fn(() => ({
          running: true,
          intervalMs: 60000,
          triggerCount: 1,
          lastTick: null,
          budgetUsage: { usedUsd: 0, limitUsd: 5.0, pct: 0 },
        })),
        getCircuitBreaker: vi.fn((name: string) => name === "my-trigger" ? cb : undefined),
      } as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["reset", "my-trigger"]);

    expect(cb.getState()).toBe("CLOSED");
    expect(stdout.toLowerCase()).toContain("reset");
    expect(stdout).toContain("CLOSED");
  });
});

describe("daemon audit", () => {
  it("formats recent audit entries as table", async () => {
    const auditEntries: AuditEntry[] = [
      { id: 1, toolName: "file_write", paramsSummary: '{"path":"foo.ts"}', decision: "approved", decidedBy: "dashboard", triggerName: "daily-report", timestamp: 1709900000000 },
      { id: 2, toolName: "shell_exec", paramsSummary: '{"cmd":"ls"}', decision: "denied", decidedBy: "user", triggerName: "health-check", timestamp: 1709900100000 },
    ];

    const ctx = makeMockContext({
      approvalQueue: {
        getPending: vi.fn(() => []),
        getAuditLog: vi.fn(() => auditEntries),
      } as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["audit"]);

    expect(stdout).toContain("file_write");
    expect(stdout).toContain("approved");
    expect(stdout).toContain("shell_exec");
    expect(stdout).toContain("denied");
  });
});

describe("daemon config", () => {
  it("shows all daemon settings in a formatted table", async () => {
    const ctx = makeMockContext();

    const { stdout } = await runDaemonCommand(() => ctx, ["config"]);

    expect(stdout).toContain("60000"); // intervalMs
    expect(stdout).toContain("5"); // dailyBudgetUsd
    expect(stdout).toContain("UTC"); // timezone
    expect(stdout).toContain("15"); // approvalTimeoutMin
  });
});

describe("daemon budget reset", () => {
  it("calls BudgetTracker.resetBudget()", async () => {
    const ctx = makeMockContext();

    const { stdout } = await runDaemonCommand(() => ctx, ["budget", "reset"]);

    expect(ctx.budgetTracker.resetBudget).toHaveBeenCalled();
    expect(stdout.toLowerCase()).toContain("reset");
  });
});

// =============================================================================
// DIGEST SUBCOMMAND (Plan 18-02)
// =============================================================================

describe("daemon digest", () => {
  it("calls digestReporter.sendDigest()", async () => {
    const sendDigest = vi.fn().mockResolvedValue("**All quiet** -- no activity");
    const ctx = makeMockContext({
      digestReporter: { sendDigest, start: vi.fn(), stop: vi.fn(), getLastDigestTime: vi.fn() } as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["digest"]);

    expect(sendDigest).toHaveBeenCalled();
    expect(stdout.toLowerCase()).toContain("digest sent");
  });

  it("prints to stdout in --dry-run mode", async () => {
    const sendDigest = vi.fn().mockResolvedValue("**3 tasks done, 1 error**\n\n---\nDashboard: http://localhost:3100");
    const ctx = makeMockContext({
      digestReporter: { sendDigest, start: vi.fn(), stop: vi.fn(), getLastDigestTime: vi.fn() } as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["digest", "--dry-run"]);

    expect(sendDigest).toHaveBeenCalled();
    expect(stdout).toContain("Preview");
    expect(stdout).toContain("3 tasks done");
  });
});

// =============================================================================
// NOTIFICATIONS SUBCOMMAND (Plan 18-02)
// =============================================================================

describe("daemon notifications", () => {
  it("shows notification history filtered by --level", async () => {
    const getHistory = vi.fn().mockReturnValue([
      { id: 1, urgency: "high", title: "Budget exceeded", message: "Budget exhausted", deliveredTo: ["chat"], createdAt: Date.now() },
    ]);
    const ctx = makeMockContext({
      notificationRouter: {
        notify: vi.fn(),
        getHistory,
        start: vi.fn(),
        stop: vi.fn(),
      } as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["notifications", "--level", "high"]);

    expect(getHistory).toHaveBeenCalledWith(20, "high");
    expect(stdout).toContain("Budget exceeded");
    expect(stdout).toContain("high");
  });
});

// =============================================================================
// NOTIFY SUBCOMMAND (Plan 18-02)
// =============================================================================

describe("daemon notify", () => {
  it("calls notificationRouter.notify() with level and message", async () => {
    const notifyFn = vi.fn().mockResolvedValue(undefined);
    const ctx = makeMockContext({
      notificationRouter: {
        notify: notifyFn,
        getHistory: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      } as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["notify", "--level", "high", "--message", "test notification"]);

    expect(notifyFn).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "high",
        title: "Manual test",
        message: "test notification",
      }),
    );
    expect(stdout).toContain("Notification sent");
    expect(stdout).toContain("high");
  });
});

// =============================================================================
// MEMORY:DECAY-STATUS SUBCOMMAND (Plan 21-03)
// =============================================================================

describe("daemon memory:decay-status", () => {
  const MOCK_DECAY_STATS = {
    enabled: true,
    tiers: {
      working: { entries: 42, avgScore: 0.65, atFloor: 3, lambda: 0.10 },
      ephemeral: { entries: 128, avgScore: 0.72, atFloor: 8, lambda: 0.05 },
      persistent: { entries: 512, avgScore: 0.84, atFloor: 12, lambda: 0.01 },
    },
    exemptDomains: ["instinct", "analysis-cache"],
    totalExempt: 15,
  };

  it("prints formatted table with per-tier stats", async () => {
    const ctx = makeMockContext({
      memoryManager: {
        getDecayStats: vi.fn().mockReturnValue(MOCK_DECAY_STATS),
      } as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["memory:decay-status"]);

    expect(stdout).toContain("Memory Decay Status");
    expect(stdout).toContain("Working");
    expect(stdout).toContain("42");
    expect(stdout).toContain("0.65");
    expect(stdout).toContain("Ephemeral");
    expect(stdout).toContain("128");
    expect(stdout).toContain("Persistent");
    expect(stdout).toContain("512");
    expect(stdout).toContain("0.01");
    expect(stdout).toContain("instinct");
    expect(stdout).toContain("15 entries");
  });

  it("outputs JSON when --json flag is passed", async () => {
    const ctx = makeMockContext({
      memoryManager: {
        getDecayStats: vi.fn().mockReturnValue(MOCK_DECAY_STATS),
      } as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["memory:decay-status", "--json"]);

    const parsed = JSON.parse(stdout);
    expect(parsed.enabled).toBe(true);
    expect(parsed.tiers.working.entries).toBe(42);
    expect(parsed.tiers.persistent.lambda).toBe(0.01);
    expect(parsed.exemptDomains).toEqual(["instinct", "analysis-cache"]);
  });

  it("shows disabled message when decay is off", async () => {
    const ctx = makeMockContext({
      memoryManager: {
        getDecayStats: vi.fn().mockReturnValue({ ...MOCK_DECAY_STATS, enabled: false }),
      } as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["memory:decay-status"]);

    expect(stdout).toContain("Memory decay is disabled");
    expect(stdout).toContain("MEMORY_DECAY_ENABLED=false");
  });

  it("errors when daemon is not running", async () => {
    const { stderr } = await runDaemonCommand(() => undefined, ["memory:decay-status"]);

    expect(stderr).toContain("Daemon is not running");
  });

  it("errors when memory manager has no getDecayStats", async () => {
    const ctx = makeMockContext({
      memoryManager: {} as any,
    });

    const { stderr } = await runDaemonCommand(() => ctx, ["memory:decay-status"]);

    expect(stderr).toContain("not available");
  });
});

// =============================================================================
// CHAIN:STATUS SUBCOMMAND (Plan 22-04)
// =============================================================================

describe("daemon chain:status", () => {
  const V2_CHAIN_ACTION = JSON.stringify({
    version: 2,
    toolSequence: ["file_read", "file_write"],
    steps: [
      { stepId: "step_0", toolName: "file_read", dependsOn: [], reversible: true },
      { stepId: "step_1", toolName: "file_write", dependsOn: ["step_0"], reversible: true, compensatingAction: { toolName: "file_delete", inputMappings: { path: "path" } } },
    ],
    parameterMappings: [],
    isFullyReversible: true,
    successRate: 0.95,
    occurrences: 10,
  });

  const V2_PARALLEL_ACTION = JSON.stringify({
    version: 2,
    toolSequence: ["fetch", "process_a", "process_b", "merge"],
    steps: [
      { stepId: "step_0", toolName: "fetch", dependsOn: [], reversible: false },
      { stepId: "step_1", toolName: "process_a", dependsOn: ["step_0"], reversible: false },
      { stepId: "step_2", toolName: "process_b", dependsOn: [], reversible: false },
      { stepId: "step_3", toolName: "merge", dependsOn: ["step_1", "step_2"], reversible: false },
    ],
    parameterMappings: [],
    isFullyReversible: false,
    successRate: 0.88,
    occurrences: 5,
  });

  const V1_CHAIN_ACTION = JSON.stringify({
    toolSequence: ["api_call", "transform", "save"],
    parameterMappings: [],
    successRate: 0.75,
    occurrences: 3,
  });

  function makeMockLearningStorage(instincts: Array<{ name: string; action: string; status?: string }>) {
    return {
      getInstincts: vi.fn().mockReturnValue(
        instincts.map((i, idx) => ({
          id: `inst-${idx}`,
          name: i.name,
          type: "tool_chain",
          status: i.status ?? "active",
          action: i.action,
          updatedAt: 1710000000000,
        })),
      ),
    };
  }

  it("prints 'No active tool chains' when no chains exist", async () => {
    const ctx = makeMockContext({
      learningStorage: makeMockLearningStorage([]) as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["chain:status"]);

    expect(stdout).toContain("No active tool chains");
  });

  it("displays chain table with correct columns for V2 chain", async () => {
    const ctx = makeMockContext({
      learningStorage: makeMockLearningStorage([
        { name: "read_then_write", action: V2_CHAIN_ACTION },
      ]) as any,
      chainResilienceConfig: {
        rollbackEnabled: true,
        parallelEnabled: false,
        maxParallelBranches: 4,
        compensationTimeoutMs: 30000,
      },
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["chain:status"]);

    expect(stdout).toContain("Tool Chain Resilience Status");
    expect(stdout).toContain("read_then_write");
    expect(stdout).toContain("Yes"); // rollback
    expect(stdout).toContain("No");  // parallel (sequential chain)
    expect(stdout).toContain("95.0%");
    expect(stdout).toContain("10");
    expect(stdout).toContain("Rollback: enabled");
    expect(stdout).toContain("Parallel: disabled");
    expect(stdout).toContain("Max Branches: 4");
    expect(stdout).toContain("Timeout: 30000ms");
  });

  it("outputs valid JSON with --json flag", async () => {
    const ctx = makeMockContext({
      learningStorage: makeMockLearningStorage([
        { name: "read_then_write", action: V2_CHAIN_ACTION },
      ]) as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["chain:status", "--json"]);

    const parsed = JSON.parse(stdout);
    expect(parsed.chains).toHaveLength(1);
    expect(parsed.chains[0].name).toBe("read_then_write");
    expect(parsed.chains[0].rollbackCapable).toBe(true);
    expect(parsed.chains[0].parallelCapable).toBe(false);
    expect(parsed.chains[0].steps).toHaveLength(2);
    expect(parsed.config).toBeDefined();
  });

  it("correctly represents DAG topology with parallel steps", async () => {
    const ctx = makeMockContext({
      learningStorage: makeMockLearningStorage([
        { name: "parallel_pipeline", action: V2_PARALLEL_ACTION },
      ]) as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["chain:status"]);

    // Should show parallel steps in brackets
    expect(stdout).toContain("[");
    expect(stdout).toContain("]");
    expect(stdout).toContain("parallel_pipeline");
  });

  it("handles V1 chains with migration to V2", async () => {
    const ctx = makeMockContext({
      learningStorage: makeMockLearningStorage([
        { name: "legacy_chain", action: V1_CHAIN_ACTION },
      ]) as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["chain:status"]);

    expect(stdout).toContain("legacy_chain");
    expect(stdout).toContain("No"); // Not rollback capable
    expect(stdout).toContain("75.0%");
  });

  it("errors when daemon is not running", async () => {
    const { stderr } = await runDaemonCommand(() => undefined, ["chain:status"]);

    expect(stderr).toContain("Daemon is not running");
  });

  it("errors when learning storage is not available", async () => {
    const ctx = makeMockContext();

    const { stderr } = await runDaemonCommand(() => ctx, ["chain:status"]);

    expect(stderr).toContain("not available");
  });

  it("filters out deprecated/proposed instincts", async () => {
    const ctx = makeMockContext({
      learningStorage: makeMockLearningStorage([
        { name: "active_chain", action: V2_CHAIN_ACTION, status: "active" },
        { name: "deprecated_chain", action: V2_CHAIN_ACTION, status: "deprecated" },
        { name: "proposed_chain", action: V2_CHAIN_ACTION, status: "proposed" },
      ]) as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["chain:status"]);

    expect(stdout).toContain("active_chain");
    expect(stdout).not.toContain("deprecated_chain");
    expect(stdout).not.toContain("proposed_chain");
  });
});
