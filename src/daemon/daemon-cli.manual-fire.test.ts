/**
 * `strada daemon trigger <name>` runs the trigger (COR-13 follow-up).
 *
 * Both the in-process command and POST /api/daemon/trigger used to call
 * trigger.onFired() alone: a fire was recorded and nothing ran. Here a real
 * HeartbeatLoop sits behind both paths — the command in the runtime process,
 * and the same command from a shell through the real dashboard with the
 * operator credential — and each must run the trigger's action through the
 * tick's gates, and print the same thing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerDaemonCommands, type DaemonContext } from "./daemon-cli.js";
import { HeartbeatLoop } from "./heartbeat-loop.js";
import { TriggerRegistry } from "./trigger-registry.js";
import type { DaemonConfig, ITrigger, TriggerType } from "./daemon-types.js";
import type { DaemonEventMap } from "./daemon-events.js";
import type { IEventBus } from "../core/event-bus.js";
import { DashboardServer } from "../dashboard/server.js";
import { MetricsCollector } from "../dashboard/metrics.js";
import { resolveDaemonOperatorClient } from "../core/daemon-dashboard-client.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, getLogger: () => logger, getLoggerSafe: () => logger };
});

const config: DaemonConfig = {
  heartbeat: { intervalMs: 3_600_000, heartbeatFile: "HEARTBEAT.md", idlePause: false },
  security: { approvalTimeoutMin: 30, autoApproveTools: [] },
  budget: { dailyBudgetUsd: 10, warnPct: 0.8 },
  backoff: { baseCooldownMs: 60_000, maxCooldownMs: 3_600_000, failureThreshold: 3 },
  timezone: "UTC",
  triggers: {
    webhookRateLimit: "10/min",
    dedupWindowMs: 300_000,
    defaultDebounceMs: 500,
    checklistMorningHour: 9,
    checklistAfternoonHour: 14,
    checklistEveningHour: 18,
  },
  triggerFireRetentionDays: 30,
};

function trigger(name: string, type: TriggerType, onFired: () => void = () => undefined): ITrigger {
  return {
    metadata: { name, description: `Run ${name}`, type },
    // Nothing is due: a manual fire overrides a cron schedule, nothing else.
    shouldFire: () => type === "deploy",
    onFired: vi.fn(onFired),
    getNextRun: () => null,
    getState: () => "active",
  };
}

function runtime() {
  let taskCount = 0;
  const tasks = new Map<string, string>();
  const taskManager = {
    submit: vi.fn((_chatId: string, _channel: string, prompt: string) => {
      const id = `task_${++taskCount}`;
      tasks.set(id, "pending");
      return { id, prompt };
    }),
    getStatus: vi.fn((id: string) => (tasks.has(id) ? { id, status: tasks.get(id), origin: "daemon" } : null)),
    hasActiveForegroundTasks: () => false,
    on: vi.fn(),
    off: vi.fn(),
    complete: (id: string) => tasks.set(id, "completed"),
  };
  const usage = { usedUsd: 0, limitUsd: 10, pct: 0 };
  const budgetTracker = { getUsage: vi.fn(() => ({ ...usage })), resetBudget: vi.fn() };
  const approvalQueue = { expireStale: vi.fn(), enqueue: vi.fn(), getPending: vi.fn(() => []), getAuditLog: vi.fn(() => []) };
  const storage = {
    getAllCircuitStates: () => new Map(),
    upsertCircuitState: vi.fn(),
    setDaemonState: vi.fn(),
    getDaemonState: vi.fn(),
    insertTriggerFireHistory: vi.fn(),
  };
  const eventBus: IEventBus<DaemonEventMap> = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), shutdown: vi.fn(async () => {}) };
  const registry = new TriggerRegistry();
  const loop = new HeartbeatLoop(
    registry, taskManager as never, budgetTracker as never, {} as never, approvalQueue as never,
    storage as never, undefined, eventBus, config, logger as never,
  );
  const ctx = { heartbeatLoop: loop, registry, budgetTracker, approvalQueue, storage, config } as unknown as DaemonContext;
  return { ctx, loop, registry, taskManager, usage, approvalQueue };
}

async function command(
  args: string[],
  getDaemonContext: () => DaemonContext | undefined,
  credentialFile: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | string | undefined }> {
  const program = new Command();
  program.exitOverride();
  registerDaemonCommands(program, getDaemonContext, undefined, () =>
    resolveDaemonOperatorClient(credentialFile, {
      dashboard: { enabled: true, port: 0 },
      websocketDashboard: { enabled: false, port: 0, authToken: undefined },
    }));
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => { out.push(parts.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => { err.push(parts.join(" ")); });
  process.exitCode = undefined;
  try {
    await program.parseAsync(["node", "strada", "daemon", ...args]);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { stdout: out.join("\n"), stderr: err.join("\n"), exitCode };
}

describe("strada daemon trigger runs the trigger, in-process and from a shell (COR-13 follow-up)", () => {
  let dir = "";
  let server: DashboardServer | null = null;
  let rt: ReturnType<typeof runtime>;
  let file = "";

  /** Both paths, one after the other, against the same runtime. */
  async function bothPaths(args: string[]) {
    const inProcess = await command(args, () => rt.ctx, file);
    const fromShell = await command(args, () => undefined, file);
    return { inProcess, fromShell };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "strada-manual-fire-"));
    file = join(dir, "k.operator.json");
    rt = runtime();
    rt.loop.start();
    server = new DashboardServer(0, new MetricsCollector(), () => undefined, () => false, [], "127.0.0.1", [], file);
    server.setDaemonContext({ cliContext: rt.ctx });
    try {
      await server.start();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") server = null;
      else throw error;
    }
  });

  afterEach(async () => {
    rt.loop.stop();
    await server?.stop();
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("submits the trigger's task from both paths and names it", async () => {
    if (!server) return;
    const nightly = trigger("nightly", "cron");
    rt.registry.register(nightly);

    const inProcess = await command(["trigger", "nightly"], () => rt.ctx, file);
    expect(rt.taskManager.submit, "the in-process command ran the trigger's action").toHaveBeenCalledTimes(1);
    expect(inProcess).toEqual({ stdout: "Trigger 'nightly' fired manually: task task_1 submitted", stderr: "", exitCode: undefined });
    rt.taskManager.complete("task_1");

    const fromShell = await command(["trigger", "nightly"], () => undefined, file);
    expect(rt.taskManager.submit, "the dashboard route ran the trigger's action").toHaveBeenCalledTimes(2);
    expect(fromShell).toEqual({ stdout: "Trigger 'nightly' fired manually: task task_2 submitted", stderr: "", exitCode: undefined });

    expect(rt.taskManager.submit.mock.calls.map((call) => call[2])).toEqual(["Run nightly", "Run nightly"]);
    expect(nightly.onFired).toHaveBeenCalledTimes(2);
  });

  it("is refused by an exhausted budget on both paths, with the same words, and runs nothing", async () => {
    if (!server) return;
    const nightly = trigger("nightly", "cron");
    rt.registry.register(nightly);
    Object.assign(rt.usage, { usedUsd: 12, pct: 1.2 });

    const { inProcess, fromShell } = await bothPaths(["trigger", "nightly"]);
    const refused = { stdout: "", stderr: "Trigger 'nightly' did not fire: the daemon budget is exhausted ($12.00 of $10.00)", exitCode: 1 };
    expect(inProcess).toEqual(refused);
    expect(fromShell).toEqual(refused);
    expect(nightly.onFired).not.toHaveBeenCalled();
    expect(rt.taskManager.submit).not.toHaveBeenCalled();
  });

  it("queues an approval-only trigger's action for approval on both paths, running no task", async () => {
    if (!server) return;
    rt.registry.register(trigger("deploy-readiness", "deploy", () => rt.approvalQueue.enqueue("deployment", {}, "deploy-readiness")));

    const { inProcess, fromShell } = await bothPaths(["trigger", "deploy-readiness"]);
    const queued = {
      stdout: "Trigger 'deploy-readiness' fired manually: its action is waiting for approval (pending approvals: strada daemon status)",
      stderr: "",
      exitCode: undefined,
    };
    expect(inProcess).toEqual(queued);
    expect(fromShell).toEqual(queued);
    expect(rt.approvalQueue.enqueue).toHaveBeenCalledTimes(2);
    expect(rt.taskManager.submit).not.toHaveBeenCalled();
  });

  it("names an unknown trigger on both paths and exits non-zero", async () => {
    if (!server) return;
    const { inProcess, fromShell } = await bothPaths(["trigger", "nope"]);
    const missing = { stdout: "", stderr: "Trigger 'nope' not found", exitCode: 1 };
    expect(inProcess).toEqual(missing);
    expect(fromShell).toEqual(missing);
  });
});
