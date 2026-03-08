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
    await program.parseAsync(["node", "strata", "daemon", ...args], { from: "user" });
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
