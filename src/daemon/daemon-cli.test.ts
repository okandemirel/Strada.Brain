/**
 * Daemon CLI Tests
 *
 * Tests for registerDaemonCommands: status, trigger, reset, audit, config, budget reset.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Command } from "commander";
import { registerDaemonCommands, type DaemonContext } from "./daemon-cli.js";
import type { DaemonConfig, ITrigger, TriggerMetadata, TriggerState, AuditEntry } from "./daemon-types.js";
import { CircuitBreaker } from "./resilience/circuit-breaker.js";
import {
  createDaemonDashboardClient,
  createDaemonOperatorClient,
  resolveDaemonOperatorClient,
  type DashboardClientResolution,
  type OperatorClientResolution,
} from "../core/daemon-dashboard-client.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  getDashboardClient?: () => DashboardClientResolution,
  getOperatorClient?: () => Promise<OperatorClientResolution>,
): Promise<{ stdout: string; stderr: string }> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });

  registerDaemonCommands(program, getDaemonContext, getDashboardClient, getOperatorClient);

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => stdoutLines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderrLines.push(args.map(String).join(" "));

  try {
    await program.parseAsync(["node", "strada", "daemon", ...args]);
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

afterEach(() => {
  // Commands report failure through process.exitCode; keep it per test.
  process.exitCode = undefined;
});

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

  // COR-13: without an in-process context (every shell invocation) the CLI
  // cannot know whether a daemon runs; it used to print "not running" anyway.
  it("does not claim 'not running' when it has no way to reach the daemon", async () => {
    const { stdout, stderr } = await runDaemonCommand(() => undefined, ["status"]);
    expect(`${stdout}\n${stderr}`.toLowerCase()).not.toContain("not running");
    expect(stderr).toContain("Cannot read the daemon status");
    expect(process.exitCode).toBe(1);
  });
});

describe("daemon trigger <name>", () => {
  // These used to assert trigger.onFired() was called: that recorded a fire
  // and ran nothing. The command now fires through the heartbeat's own path.
  const withFire = (fireNow: ReturnType<typeof vi.fn>) =>
    makeMockContext({ heartbeatLoop: { ...makeMockContext().heartbeatLoop, fireNow } as unknown as DaemonContext["heartbeatLoop"] });

  it("fires a named trigger through the heartbeat and names the task it submitted", async () => {
    const fireNow = vi.fn(() => ({ status: "submitted", taskId: "task_9" }));

    const { stdout, stderr } = await runDaemonCommand(() => withFire(fireNow), ["trigger", "daily-report"]);

    expect(fireNow).toHaveBeenCalledWith("daily-report");
    expect(stdout).toBe("Trigger 'daily-report' fired manually: task task_9 submitted");
    expect(stderr).toBe("");
    expect(process.exitCode).toBeUndefined();
  });

  it("says a trigger's action is waiting for approval", async () => {
    const { stdout } = await runDaemonCommand(() => withFire(vi.fn(() => ({ status: "approval" }))), ["trigger", "deploy-readiness"]);
    expect(stdout).toBe("Trigger 'deploy-readiness' fired manually: its action is waiting for approval (pending approvals: strada daemon status)");
  });

  it("names the gate that refused it and exits non-zero", async () => {
    const fireNow = vi.fn(() => ({ status: "refused", gate: "budget_exceeded", reason: "the daemon budget is exhausted ($5.10 of $5.00)" }));
    const { stdout, stderr } = await runDaemonCommand(() => withFire(fireNow), ["trigger", "daily-report"]);
    expect(stdout).toBe("");
    expect(stderr).toBe("Trigger 'daily-report' did not fire: the daemon budget is exhausted ($5.10 of $5.00)");
    expect(process.exitCode).toBe(1);
  });

  it("errors when trigger not found", async () => {
    const { stderr } = await runDaemonCommand(() => withFire(vi.fn(() => ({ status: "not_found" }))), ["trigger", "nonexistent"]);

    expect(stderr).toBe("Trigger 'nonexistent' not found");
    expect(process.exitCode).toBe(1);
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

  it("labels security.autoApproveTools as unenforced so a dead gate never reads as live (audited 2026-09-02)", async () => {
    // DaemonSecurityPolicy.checkPermission has no production caller; the
    // allowlist is parsed but consulted by nothing. Printing it as plain
    // configuration made a skipped check read like a passed one.
    const ctx = makeMockContext();

    const { stdout } = await runDaemonCommand(() => ctx, ["config"]);

    const row = stdout.split("\n").find((line) => line.includes("security.autoApproveTools"));
    expect(row).toBeDefined();
    expect(row).toContain("file_read");
    expect(row).toContain("not enforced");
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

  it("prints to stdout in --dry-run mode, without sending anything", async () => {
    // COR-13 made the flag mean what it says: this test used to expect
    // sendDigest() — which delivers the digest and moves its baseline — to run
    // for a dry run.
    const sendDigest = vi.fn().mockResolvedValue("sent");
    const previewDigest = vi.fn().mockReturnValue("**3 tasks done, 1 error**\n\n---\nDashboard: http://localhost:3100");
    const ctx = makeMockContext({
      digestReporter: { sendDigest, previewDigest, start: vi.fn(), stop: vi.fn(), getLastDigestTime: vi.fn() } as any,
    });

    const { stdout } = await runDaemonCommand(() => ctx, ["digest", "--dry-run"]);

    expect(previewDigest).toHaveBeenCalled();
    expect(sendDigest).not.toHaveBeenCalled();
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

  it("outside the runtime process with no dashboard connection, says it cannot read it (COR-13)", async () => {
    const { stdout, stderr } = await runDaemonCommand(() => undefined, ["memory:decay-status"]);

    expect(stderr).toContain("Cannot read the memory decay status");
    expect(`${stdout}\n${stderr}`.toLowerCase()).not.toContain("not running");
    expect(process.exitCode).toBe(1);
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

  it("outside the runtime process with no dashboard connection, says it cannot read it (COR-13)", async () => {
    const { stdout, stderr } = await runDaemonCommand(() => undefined, ["chain:status"]);

    expect(stderr).toContain("Cannot read the tool chain status");
    expect(`${stdout}\n${stderr}`.toLowerCase()).not.toContain("not running");
    expect(process.exitCode).toBe(1);
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

// =============================================================================
// COR-13: `strada daemon …` from a shell reads the running runtime over HTTP
// =============================================================================

describe("daemon commands outside the runtime process (COR-13)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  /** A stub dashboard that serves GET /api/daemon to the right bearer only. */
  async function startStubDashboard(token: string, body: unknown): Promise<{ baseUrl: string; seen: string[] }> {
    const seen: string[] = [];
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers["authorization"] ?? "-"}`);
      if (req.headers["authorization"] !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
      }
      if (req.url !== "/api/daemon") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}`, seen };
  }

  const liveDaemon = {
    running: true,
    configured: true,
    intervalMs: 60000,
    triggers: [{ name: "nightly-build", type: "cron", state: "active", circuitState: "OPEN", lastFired: null, nextRun: "2026-03-09T00:00:00.000Z" }],
    budget: { usedUsd: 1.25, limitUsd: 5, pct: 0.25 },
    approvalQueue: [{ id: "a1", toolName: "shell_exec", triggerName: "nightly-build", status: "pending", createdAt: 1, expiresAt: 2 }],
  };

  it("daemon status prints the running daemon's state read from the dashboard, sending its bearer token", async () => {
    const { baseUrl, seen } = await startStubDashboard("s3cret", liveDaemon);
    const client = createDaemonDashboardClient({ baseUrl, token: "s3cret" });

    const { stdout, stderr } = await runDaemonCommand(() => undefined, ["status"], () => ({ kind: "ok", client }));

    expect(stderr).toBe("");
    expect(seen).toEqual(["GET /api/daemon Bearer s3cret"]);
    expect(stdout).toContain("Daemon: running");
    expect(stdout).toContain("nightly-build");
    expect(stdout).toContain("OPEN");
    expect(stdout).toContain("Budget: $1.25 / $5.00 (25.0%)");
    expect(stdout).toContain("Pending approvals: 1");
    expect(process.exitCode).toBeUndefined();
  });

  it("daemon status reports a runtime without daemon mode as such, not as 'not running'", async () => {
    const { baseUrl } = await startStubDashboard("t", { running: false, configured: false, triggers: [], budget: { usedUsd: 0, limitUsd: 0, pct: 0 }, approvalQueue: [] });
    const client = createDaemonDashboardClient({ baseUrl, token: "t" });

    const { stdout } = await runDaemonCommand(() => undefined, ["status"], () => ({ kind: "ok", client }));

    expect(stdout).toContain("Daemon: not enabled");
    expect(stdout.toLowerCase()).not.toContain("not running");
  });

  it("daemon status names the URL and exits non-zero when nothing answers, without claiming the daemon is down", async () => {
    // Bind and release a port so nothing is listening on it.
    const { baseUrl } = await startStubDashboard("t", liveDaemon);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const client = createDaemonDashboardClient({ baseUrl, token: "t" });

    const { stdout, stderr } = await runDaemonCommand(() => undefined, ["status"], () => ({ kind: "ok", client }));

    expect(stderr).toContain(`could not reach the daemon dashboard at ${baseUrl}`);
    expect(stderr).toContain("is Strada running with the dashboard enabled?");
    expect(`${stdout}\n${stderr}`.toLowerCase()).not.toContain("not running");
    expect(process.exitCode).toBe(1);
  });

  it("daemon status surfaces an auth refusal and exits non-zero", async () => {
    const { baseUrl } = await startStubDashboard("right", liveDaemon);
    const client = createDaemonDashboardClient({ baseUrl, token: "wrong" });

    const { stderr } = await runDaemonCommand(() => undefined, ["status"], () => ({ kind: "ok", client }));

    expect(stderr).toContain("Authentication required");
    expect(stderr).toContain("WEBSOCKET_DASHBOARD_AUTH_TOKEN");
    expect(process.exitCode).toBe(1);
  });

  it("daemon status reports an unusable configuration instead of a daemon state", async () => {
    const { stderr } = await runDaemonCommand(
      () => undefined,
      ["status"],
      () => ({ kind: "unavailable", message: "the dashboard is disabled in this install's configuration (DASHBOARD_ENABLED)" }),
    );
    expect(stderr).toContain("DASHBOARD_ENABLED");
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [["trigger", "nightly-build"], "fire trigger 'nightly-build'"],
    [["reset", "nightly-build"], "reset the circuit breaker for 'nightly-build'"],
    [["budget", "reset"], "reset the daemon budget"],
    [["digest"], "send the digest"],
    [["notify", "--level", "high", "--message", "hi"], "send the notification"],
    [["delegation:tier", "code_review", "cheap"], "set the tier override"],
    [["agent", "stop", "123e4567-e89b-42d3-a456-426614174000"], "stop agent '123e4567-e89b-42d3-a456-426614174000'"],
    [["agent", "start", "123e4567-e89b-42d3-a456-426614174000"], "start agent '123e4567-e89b-42d3-a456-426614174000'"],
    [["agent", "budget", "set", "123e4567-e89b-42d3-a456-426614174000", "2"], "set agent '123e4567-e89b-42d3-a456-426614174000' budget cap"],
    [["memory:consolidate"], "run memory consolidation"],
    [["memory:consolidation-undo", "log-1"], "undo consolidation 'log-1'"],
    [["deploy:check"], "run the readiness check"],
  ])("%j with no way to reach the runtime says it cannot, and exits non-zero instead of claiming 'not running'", async (args, what) => {
    const { stdout, stderr } = await runDaemonCommand(() => undefined, args, undefined, async () => ({
      kind: "unavailable",
      message: "no running Strada has published an operator credential at /cfg/.strada/locks/k.operator.json",
    }));
    expect(stderr).toContain(`Cannot ${what}: no running Strada has published an operator credential at /cfg/.strada/locks/k.operator.json.`);
    expect(`${stdout}\n${stderr}`.toLowerCase()).not.toContain("daemon is not running");
    expect(process.exitCode).toBe(1);
  });
});

// =============================================================================
// COR-13: read-only commands with a matching dashboard GET endpoint
// =============================================================================

describe("read-only daemon commands over the dashboard API (COR-13)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  /** A stub dashboard serving fixed JSON per GET path, to the right bearer only. */
  async function startStub(token: string, routes: Record<string, unknown>): Promise<{ client: DashboardClientResolution; seen: string[] }> {
    const seen: string[] = [];
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.headers["authorization"] !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
      }
      const body = req.method === "GET" && req.url ? routes[req.url] : undefined;
      if (body === undefined) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { client: { kind: "ok", client: createDaemonDashboardClient({ baseUrl: `http://127.0.0.1:${port}`, token }) }, seen };
  }

  const run = (args: string[], client: DashboardClientResolution) => runDaemonCommand(() => undefined, args, () => client);

  const AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";
  const agentsBody = {
    enabled: true,
    activeCount: 1,
    agents: [{
      id: AGENT_ID, key: "web:chat-12345678", channelType: "web", chatId: "chat-12345678", status: "active",
      createdAt: Date.now() - 90_000, lastActivity: Date.now(), budgetCapUsd: 4, memoryEntryCount: 7, budgetUsed: 1,
    }],
    globalBudget: { usedUsd: 1, pct: 0.1 },
  };
  const delegationsBody = {
    enabled: true,
    active: [{ subAgentId: "sub-1", type: "code_review", startedAt: 1, elapsedMs: 125_000 }],
    history: [
      { id: 7, parentAgentId: "parent-agent-0001", subAgentId: "sub-1", type: "code_review", model: "claude-haiku", tier: "cheap", depth: 1, durationMs: 1500, costUsd: 0.0123, status: "completed", startedAt: 1 },
      { id: 8, parentAgentId: "parent-agent-0002", subAgentId: "sub-2", type: "analysis", model: "gpt-mini", tier: "cheap", depth: 1, status: "running", startedAt: 2 },
    ],
    stats: [{ type: "code_review", count: 3, avgDurationMs: 1500.4, avgCostUsd: 0.01, successRate: 0.5, tierBreakdown: { cheap: 3 } }],
  };

  it("daemon config prints the running daemon's settings from GET /api/config", async () => {
    const { client, seen } = await startStub("tok", {
      "/api/config": {
        config: {
          "daemon.heartbeat.intervalMs": 45000,
          "daemon.heartbeat.heartbeatFile": "HEARTBEAT.md",
          "daemon.heartbeat.idlePause": true,
          "daemon.security.approvalTimeoutMin": 15,
          "daemon.security.autoApproveTools": ["file_read"],
          "daemon.budget.dailyBudgetUsd": 3,
          "daemon.budget.limitScope": "daemon",
          "daemon.budget.warnPct": 0.8,
          "daemon.backoff.baseCooldownMs": 60000,
          "daemon.backoff.maxCooldownMs": 3600000,
          "daemon.backoff.failureThreshold": 3,
          "daemon.timezone": "Europe/Istanbul",
        },
      },
    });

    const { stdout, stderr } = await run(["config"], client);

    expect(stderr).toBe("");
    expect(seen).toEqual(["GET /api/config"]);
    expect(stdout).toContain("45000");
    expect(stdout).toContain("file_read [not enforced]");
    expect(stdout).toContain("3 (daemon spend)");
    expect(stdout).toContain("Europe/Istanbul");
    expect(process.exitCode).toBeUndefined();
  });

  it("daemon config refuses a configuration with no daemon settings instead of printing blanks", async () => {
    const { client } = await startStub("tok", { "/api/config": { config: {} } });
    const { stderr } = await run(["config"], client);
    expect(stderr).toContain("reported no daemon configuration");
    expect(process.exitCode).toBe(1);
  });

  it("daemon agent list and agent status read GET /api/agents", async () => {
    const { client, seen } = await startStub("tok", { "/api/agents": agentsBody });

    const list = await run(["agent", "list"], client);
    expect(list.stderr).toBe("");
    expect(list.stdout).toContain(AGENT_ID);
    expect(list.stdout).toContain("$1.00 / $4.00 (25%)");

    const status = await run(["agent", "status", AGENT_ID], client);
    expect(status.stdout).toContain(`Agent: ${AGENT_ID}`);
    expect(status.stdout).toContain("Budget:        $1.00 / $4.00 (25.0%)");
    expect(status.stdout).toContain("Memory:        7 entries");

    const missing = await run(["agent", "status", "00000000-0000-4000-8000-000000000000"], client);
    expect(missing.stderr).toContain("not found");
    expect(process.exitCode).toBe(1);
    expect(seen.every((line) => line === "GET /api/agents")).toBe(true);
  });

  it("daemon agent list says multi-agent mode is off in the running Strada", async () => {
    const { client } = await startStub("tok", { "/api/agents": { enabled: false } });
    const { stdout, stderr } = await run(["agent", "list"], client);
    expect(stderr).toContain("Multi-agent mode is not enabled in the running Strada");
    expect(`${stdout}\n${stderr}`.toLowerCase()).not.toContain("not running");
    expect(process.exitCode).toBe(1);
  });

  it("daemon delegation:history, :stats and :watch read GET /api/delegations", async () => {
    const { client, seen } = await startStub("tok", { "/api/delegations": delegationsBody });

    const history = await run(["delegation:history", "--type", "code_review"], client);
    expect(history.stdout).toContain("claude-haiku");
    expect(history.stdout).toContain("$0.0123");
    expect(history.stdout).not.toContain("gpt-mini");

    const stats = await run(["delegation:stats"], client);
    expect(stats.stdout).toContain("code_review");
    expect(stats.stdout).toContain("50.0%");
    expect(stats.stdout).toContain("cheap:3");

    const watch = await run(["delegation:watch"], client);
    expect(watch.stdout).toContain("sub-1");
    expect(watch.stdout).toContain("2m 5s");

    expect(seen.every((line) => line === "GET /api/delegations")).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("daemon delegation:history says delegation is off when the runtime reports it disabled", async () => {
    const { client } = await startStub("tok", { "/api/delegations": { enabled: false } });
    const { stdout } = await run(["delegation:history"], client);
    expect(stdout).toContain("Task delegation is not enabled in the running Strada");
  });

  it("daemon deploy:status and deploy:history read GET /api/deployment", async () => {
    const { client } = await startStub("tok", {
      "/api/deployment": {
        enabled: true,
        stats: { totalDeployments: 4, successful: 3, failed: 1, circuitBreakerState: "CLOSED" },
        history: [
          { id: "d1", proposedAt: Date.UTC(2026, 8, 1), status: "succeeded", duration: 1200, approvedBy: "okan" },
          { id: "d2", proposedAt: Date.UTC(2026, 8, 2), status: "failed" },
        ],
      },
    });

    const status = await run(["deploy:status"], client);
    expect(status.stdout).toContain("Total deployments: 4");
    expect(status.stdout).toContain("Circuit breaker: CLOSED");

    const history = await run(["deploy:history", "--limit", "1"], client);
    expect(history.stdout).toContain("2026-09-01T00:00:00.000Z");
    expect(history.stdout).toContain("okan");
    expect(history.stdout).not.toContain("2026-09-02");
  });

  it("daemon chain:status reads GET /api/chain-resilience", async () => {
    const { client } = await startStub("tok", {
      "/api/chain-resilience": {
        chains: [{ name: "build_then_test", steps: 3, rollbackCapable: true, parallelCapable: false, successRate: 0.9, occurrences: 12, lastRun: null }],
        config: { rollbackEnabled: true, parallelEnabled: false, maxParallelBranches: 4, compensationTimeoutMs: 30000 },
      },
    });

    const { stdout, stderr } = await run(["chain:status"], client);

    expect(stderr).toBe("");
    expect(stdout).toContain("build_then_test");
    expect(stdout).toContain("90.0%");
    expect(stdout).toContain("Rollback: enabled | Parallel: disabled | Max Branches: 4 | Timeout: 30000ms");
  });

  it("daemon memory:decay-status and memory:consolidation-status read GET /api/maintenance and /api/consolidation", async () => {
    const { client } = await startStub("tok", {
      "/api/maintenance": {
        decay: {
          enabled: true,
          tiers: { working: { entries: 42, avgScore: 0.71, atFloor: 3, lambda: 0.1 } },
          exemptDomains: ["instinct"],
          totalExempt: 5,
        },
        pruning: { retentionDays: 30, lastPrunedCount: 0 },
      },
      "/api/consolidation": {
        enabled: true,
        perTier: { working: { clustered: 2, pending: 1, total: 10 } },
        lifetimeSavings: 6,
        totalRuns: 2,
        totalCostUsd: 0.05,
      },
    });

    const decay = await run(["memory:decay-status"], client);
    expect(decay.stdout).toContain("Working");
    expect(decay.stdout).toContain("0.71");
    expect(decay.stdout).toContain("Exempt domains: instinct (5 entries)");

    const consolidation = await run(["memory:consolidation-status", "--json"], client);
    expect(JSON.parse(consolidation.stdout)).toEqual({
      perTier: { working: { clustered: 2, pending: 1, total: 10 } },
      lifetimeSavings: 6,
      totalRuns: 2,
      totalCostUsd: 0.05,
    });
  });

  it("a wired read command names the dashboard it could not reach and exits non-zero", async () => {
    const { client } = await startStub("tok", {});
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;

    const { stdout, stderr } = await run(["agent", "list"], client);

    expect(stderr).toContain("Cannot read the agent sessions: could not reach the daemon dashboard at http://127.0.0.1:");
    expect(`${stdout}\n${stderr}`.toLowerCase()).not.toContain("not running");
    expect(process.exitCode).toBe(1);
  });

  it("a wired read command surfaces an auth refusal", async () => {
    const { client: right } = await startStub("right", { "/api/deployment": { enabled: false } });
    if (right.kind !== "ok") throw new Error("expected a client");
    const wrong: DashboardClientResolution = {
      kind: "ok",
      client: createDaemonDashboardClient({ baseUrl: right.client.baseUrl, token: "wrong" }),
    };

    const { stderr } = await run(["deploy:status"], wrong);

    expect(stderr).toContain("Authentication required");
    expect(process.exitCode).toBe(1);
  });
});

// =============================================================================
// COR-13: every other command, against a stub of the running runtime
// =============================================================================

describe("daemon commands over the dashboard API from a shell (COR-13)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  const OPERATOR = "operator-token-0123456789abcdef0123456789abcdef";
  const CREDENTIAL = "/cfg/.strada/locks/k.operator.json";
  const AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";

  interface Seen {
    line: string;
    operator: string | undefined;
    authorization: string | undefined;
    contentType: string | undefined;
    body: unknown;
  }

  /**
   * A stub runtime: GETs need the bearer when one is set, POSTs need this run's
   * operator token in its header (as the real dashboard's allowlisted routes).
   */
  interface Answer { status?: number; body: unknown }

  /** A route answers the same each time, or a list of answers in turn (the last one repeats). */
  async function startRuntime(
    routes: Record<string, Answer | Answer[]>,
    bearer?: string,
  ): Promise<{ baseUrl: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
      req.on("end", () => {
        const line = `${req.method} ${req.url}`;
        seen.push({
          line,
          operator: req.headers["x-strada-operator-token"] as string | undefined,
          authorization: req.headers["authorization"],
          contentType: req.headers["content-type"],
          body: raw ? JSON.parse(raw) : undefined,
        });
        const refuse = req.method === "POST"
          ? req.headers["x-strada-operator-token"] !== OPERATOR
          : bearer !== undefined && req.headers["authorization"] !== `Bearer ${bearer}`;
        if (refuse) {
          res.writeHead(req.method === "POST" ? 403 : 401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: req.method === "POST" ? "Trusted same-origin request required" : "Authentication required" }));
          return;
        }
        const route = routes[line];
        const answer = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
        res.writeHead(answer ? answer.status ?? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answer ? answer.body : { error: "Not found" }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}`, seen };
  }

  const operatorAt = (baseUrl: string, operatorToken = OPERATOR, bearer?: string) =>
    async (): Promise<OperatorClientResolution> => ({
      kind: "ok",
      client: createDaemonOperatorClient({ baseUrl, operatorToken, credentialPath: CREDENTIAL, ...(bearer ? { token: bearer } : {}) }),
    });
  const readerAt = (baseUrl: string, bearer?: string) =>
    (): DashboardClientResolution => ({ kind: "ok", client: createDaemonDashboardClient({ baseUrl, ...(bearer ? { token: bearer } : {}) }) });
  const run = (args: string[], baseUrl: string, bearer?: string) =>
    runDaemonCommand(() => undefined, args, readerAt(baseUrl, bearer), operatorAt(baseUrl, OPERATOR, bearer));

  const ok = { body: { status: "done" } };

  it("daemon trigger and reset post the trigger name with the operator token, and print what the in-process commands print", async () => {
    const { baseUrl, seen } = await startRuntime({
      "POST /api/daemon/trigger": { body: { trigger: "nightly-build", status: "submitted", taskId: "task_7" } },
      "POST /api/daemon/circuit/reset": ok,
    });

    const fired = await run(["trigger", "nightly-build"], baseUrl);
    expect(fired.stderr).toBe("");
    expect(fired.stdout).toBe("Trigger 'nightly-build' fired manually: task task_7 submitted");

    const reset = await run(["reset", "nightly-build"], baseUrl);
    expect(reset.stdout).toBe("Circuit breaker for 'nightly-build' reset to CLOSED");

    expect(seen.map((s) => [s.line, s.operator, s.contentType, s.body])).toEqual([
      ["POST /api/daemon/trigger", OPERATOR, "application/json", { name: "nightly-build" }],
      ["POST /api/daemon/circuit/reset", OPERATOR, "application/json", { name: "nightly-build" }],
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("daemon trigger prints a gate's refusal and an unknown name as the in-process command does, exiting non-zero", async () => {
    const reason = "the daemon budget is exhausted ($5.10 of $5.00)";
    const { baseUrl } = await startRuntime({
      "POST /api/daemon/trigger": [
        { status: 409, body: { trigger: "nightly-build", status: "refused", gate: "budget_exceeded", reason, error: `Trigger 'nightly-build' did not fire: ${reason}` } },
        { status: 404, body: { trigger: "nope", status: "not_found", error: "Trigger 'nope' not found" } },
      ],
    });

    const refused = await run(["trigger", "nightly-build"], baseUrl);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toBe(`Trigger 'nightly-build' did not fire: ${reason}`);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    const missing = await run(["trigger", "nope"], baseUrl);
    expect(missing.stderr).toBe("Trigger 'nope' not found");
    expect(process.exitCode).toBe(1);
  });

  it("daemon budget reset and digest post an empty JSON object, and send the dashboard bearer too when the install has one", async () => {
    const { baseUrl, seen } = await startRuntime({
      "POST /api/daemon/budget/reset": ok,
      "POST /api/daemon/digest/send": ok,
    }, "bearer-1");

    expect((await run(["budget", "reset"], baseUrl, "bearer-1")).stdout).toBe("Budget counter reset");
    expect((await run(["digest"], baseUrl, "bearer-1")).stdout).toBe("Digest sent to active channel");
    expect(seen.map((s) => [s.line, s.body, s.authorization])).toEqual([
      ["POST /api/daemon/budget/reset", {}, "Bearer bearer-1"],
      ["POST /api/daemon/digest/send", {}, "Bearer bearer-1"],
    ]);
  });

  it("daemon notify checks the level before posting it", async () => {
    const { baseUrl, seen } = await startRuntime({ "POST /api/daemon/notify": ok });

    const bad = await run(["notify", "--level", "loud", "--message", "hi"], baseUrl);
    expect(bad.stderr).toContain("Invalid level: loud");
    expect(process.exitCode).toBe(1);
    expect(seen).toEqual([]);
    process.exitCode = undefined;

    const sent = await run(["notify", "--level", "high", "--message", "disk almost full"], baseUrl);
    expect(sent.stdout).toBe("Notification sent (level: high)");
    expect(seen.map((s) => [s.line, s.body])).toEqual([["POST /api/daemon/notify", { level: "high", message: "disk almost full" }]]);
  });

  it("daemon agent stop, start and budget set post to the agent's route", async () => {
    const { baseUrl, seen } = await startRuntime({
      [`POST /api/agents/${AGENT_ID}/stop`]: ok,
      [`POST /api/agents/${AGENT_ID}/start`]: ok,
      [`POST /api/agents/${AGENT_ID}/budget`]: ok,
    });

    expect((await run(["agent", "stop", AGENT_ID, "--force"], baseUrl)).stdout).toBe(`Agent '${AGENT_ID}' stopped (force).`);
    expect((await run(["agent", "stop", AGENT_ID], baseUrl)).stdout).toBe(`Agent '${AGENT_ID}' stopped.`);
    expect((await run(["agent", "start", AGENT_ID], baseUrl)).stdout).toBe(`Agent '${AGENT_ID}' started.`);
    expect((await run(["agent", "budget", "set", AGENT_ID, "2.5"], baseUrl)).stdout).toBe(`Agent '${AGENT_ID}' budget cap set to $2.50.`);

    const bad = await run(["agent", "budget", "set", AGENT_ID, "0"], baseUrl);
    expect(bad.stderr).toContain("Invalid amount");
    expect(process.exitCode).toBe(1);

    expect(seen.map((s) => [s.line, s.body])).toEqual([
      [`POST /api/agents/${AGENT_ID}/stop`, { force: true }],
      [`POST /api/agents/${AGENT_ID}/stop`, {}],
      [`POST /api/agents/${AGENT_ID}/start`, {}],
      [`POST /api/agents/${AGENT_ID}/budget`, { usd: 2.5 }],
    ]);
  });

  it("daemon delegation:tier checks the tier before posting it", async () => {
    const { baseUrl, seen } = await startRuntime({ "POST /api/delegations/tier": ok });

    expect((await run(["delegation:tier", "code_review", "gold"], baseUrl)).stderr).toContain("Invalid tier: gold");
    expect(seen).toEqual([]);
    process.exitCode = undefined;

    const set = await run(["delegation:tier", "code_review", "cheap"], baseUrl);
    expect(set.stdout).toBe("Tier override set: code_review -> cheap (immediate effect, no restart needed)");
    expect(seen.map((s) => s.body)).toEqual([{ type: "code_review", tier: "cheap" }]);
  });

  it("daemon memory:consolidate runs one cycle and prints its result; consolidation-undo surfaces the runtime's refusal", async () => {
    const { baseUrl } = await startRuntime({
      "POST /api/consolidation/run": { body: { status: "completed", processed: 3, remaining: 1, clustersFound: 4, costUsd: 0.0123 } },
      "POST /api/consolidation/undo": { status: 409, body: { error: "Failed to undo: Consolidation log entry not found: log-9" } },
    });

    const cycle = await run(["memory:consolidate", "--force"], baseUrl);
    expect(cycle.stdout.split("\n")).toEqual([
      "Running consolidation (forced)...",
      "Status: completed",
      "Processed: 3 clusters",
      "Remaining: 1",
      "Clusters found: 4",
      "Cost: $0.0123",
    ]);

    const undo = await run(["memory:consolidation-undo", "log-9"], baseUrl);
    expect(undo.stderr).toBe(
      `Cannot undo consolidation 'log-9': the dashboard at ${baseUrl} refused POST /api/consolidation/undo: Failed to undo: Consolidation log entry not found: log-9`,
    );
    expect(process.exitCode).toBe(1);
  });

  it("daemon deploy:check asks the runtime to propose only with --execute --force, as in-process", async () => {
    const ready = { ready: true, testPassed: true, gitClean: true, branchMatch: true, timestamp: 1, cached: false };
    const { baseUrl, seen } = await startRuntime({ "POST /api/deployment/check": { body: { ...ready, proposed: true } } });

    const check = await run(["deploy:check"], baseUrl);
    expect(check.stdout).toContain("Ready: YES");
    expect(check.stdout).not.toContain("propos");

    const unconfirmed = await run(["deploy:check", "--execute"], baseUrl);
    expect(unconfirmed.stdout).toContain("Use --force to propose deployment without interactive confirmation.");

    const proposed = await run(["deploy:check", "--execute", "--force"], baseUrl);
    expect(proposed.stdout).toContain("Deployment proposed via approval queue.");

    expect(seen.map((s) => s.body)).toEqual([{}, {}, { propose: true }]);
  });

  it("daemon deploy:check reports deployment that is off in the running Strada", async () => {
    const { baseUrl } = await startRuntime({ "POST /api/deployment/check": { body: { enabled: false } } });
    const { stdout } = await run(["deploy:check"], baseUrl);
    expect(stdout).toContain("Deployment is not active in the running Strada");
  });

  it("a refused operator token names the credential file, and exits non-zero", async () => {
    const { baseUrl } = await startRuntime({ "POST /api/daemon/budget/reset": ok });
    const { stdout, stderr } = await runDaemonCommand(() => undefined, ["budget", "reset"], undefined, operatorAt(baseUrl, "stale-token"));
    expect(stderr).toContain(`Cannot reset the daemon budget: the dashboard at ${baseUrl} refused POST /api/daemon/budget/reset`);
    expect(stderr).toContain(`the operator credential in ${CREDENTIAL} was not accepted`);
    expect(stdout).toBe("");
    expect(process.exitCode).toBe(1);
  });

  it("an unreachable dashboard is named, without claiming the daemon is down", async () => {
    const { baseUrl } = await startRuntime({});
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;

    const { stdout, stderr } = await run(["trigger", "nightly-build"], baseUrl);
    expect(stderr).toContain(`Cannot fire trigger 'nightly-build': could not reach the dashboard at ${baseUrl} named in ${CREDENTIAL}`);
    expect(`${stdout}\n${stderr}`.toLowerCase()).not.toContain("not running");
    expect(process.exitCode).toBe(1);
  });

  it("a runtime that cannot do it says why (503), and the command exits non-zero", async () => {
    const { baseUrl } = await startRuntime({
      [`POST /api/agents/${AGENT_ID}/start`]: { status: 503, body: { error: "Multi-agent mode is not enabled in the running Strada" } },
    });
    const { stderr } = await run(["agent", "start", AGENT_ID], baseUrl);
    expect(stderr).toContain("Multi-agent mode is not enabled in the running Strada");
    expect(process.exitCode).toBe(1);
  });

  it("with no credential file, names the file and what that can mean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strada-cli-"));
    try {
      const file = join(dir, "k.operator.json");
      const resolve = () => resolveDaemonOperatorClient(file, {
        dashboard: { enabled: true, port: 3100 },
        websocketDashboard: { enabled: false, port: 3101, authToken: undefined },
      });
      const { stdout, stderr } = await runDaemonCommand(() => undefined, ["budget", "reset"], undefined, resolve);
      expect(stderr).toContain(`Cannot reset the daemon budget: no running Strada has published an operator credential at ${file}`);
      expect(stderr).toContain("runs as another OS user, or uses a different config root");
      expect(stdout).toBe("");
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("daemon audit, notifications, digest --dry-run and memory:consolidation-preview read their GET endpoints", async () => {
    const { baseUrl, seen } = await startRuntime({
      "GET /api/daemon/audit?limit=20": {
        body: { enabled: true, entries: [{ id: 1, toolName: "shell_exec", decision: "approved", decidedBy: "owner", timestamp: Date.UTC(2026, 8, 1) }] },
      },
      "GET /api/daemon/notifications?limit=5&level=high": {
        body: { enabled: true, entries: [{ id: 2, urgency: "high", title: "Budget exceeded", message: "m", deliveredTo: ["chat"], createdAt: 1 }] },
      },
      "GET /api/daemon/digest/preview": { body: { enabled: true, markdown: "**3 tasks done**" } },
      "GET /api/consolidation/preview": {
        body: { enabled: true, clusters: [{ seedId: "seed-1", memberIds: ["a", "b"], avgSimilarity: 0.9123, tier: "working" }], estimatedCostPerCluster: 0.01, totalEstimatedCost: 0.01 },
      },
    }, "bearer-2");

    const audit = await run(["audit"], baseUrl, "bearer-2");
    expect(audit.stdout).toContain("shell_exec");
    expect(audit.stdout).toContain("2026-09-01T00:00:00.000Z");

    const notifications = await run(["notifications", "--level", "high", "--limit", "5"], baseUrl, "bearer-2");
    expect(notifications.stdout).toContain("Budget exceeded");

    const preview = await run(["digest", "--dry-run"], baseUrl, "bearer-2");
    expect(preview.stdout.split("\n")).toEqual(["--- Digest Preview (dry-run) ---", "**3 tasks done**", "--- End Preview ---"]);

    const clusters = await run(["memory:consolidation-preview"], baseUrl, "bearer-2");
    expect(clusters.stdout).toContain("seed-1");
    expect(clusters.stdout).toContain("0.912");

    // Reads go as any dashboard client: the bearer, never the operator token, never a POST.
    expect(seen.every((s) => s.line.startsWith("GET ") && s.operator === undefined && s.authorization === "Bearer bearer-2")).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("the reads say what is off in the running Strada", async () => {
    const { baseUrl } = await startRuntime({
      "GET /api/daemon/audit?limit=20": { body: { enabled: false, reason: "Daemon mode is not enabled in the running Strada (start it with --daemon)" } },
      "GET /api/consolidation/preview": { body: { enabled: false } },
    });
    expect((await run(["audit"], baseUrl)).stdout).toContain("Daemon mode is not enabled in the running Strada");
    expect((await run(["memory:consolidation-preview"], baseUrl)).stdout).toContain("Memory consolidation is not active in the running Strada");
  });

  it("daemon notifications checks the level filter before reading", async () => {
    const { baseUrl, seen } = await startRuntime({});
    const { stderr } = await run(["notifications", "--level", "loud"], baseUrl);
    expect(stderr).toContain("Invalid level filter: loud");
    expect(seen).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});
