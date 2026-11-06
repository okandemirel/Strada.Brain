/**
 * The triggers this repository ships, run through the real loader and the
 * real heartbeat loop: what a daemon does on its own, all day, on a project
 * where nothing is wrong.
 *
 * Measured in a live run: HEARTBEAT.md carried a 5-minute cron trigger whose
 * action was the sentence "Run periodic health check on the project". Every
 * occurrence became an agent task, so every five minutes the daemon asked a
 * model to look at a healthy project, and the run's task list filled with
 * these, each one waiting on provider quota. The health of the project is measured
 * without a model by the real-tree guardian, which compiles (and plays) the
 * project and opens ONE fix task only when the compile proves an error. The
 * cron trigger was that guardian's model-calling twin.
 *
 * A trigger reaches a provider by two paths: its task (`taskManager.submit`)
 * and its `daemon:trigger_fired` event, which the trigger observer hands to
 * AgentCore's reasoning call. Both are counted here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type * as winston from "winston";
import { loadDaemonTriggersStage } from "../core/bootstrap-stages/stage-daemon.js";
import { TypedEventBus } from "../core/event-bus.js";
import type { DaemonEventMap } from "./daemon-events.js";
import type { DaemonConfig } from "./daemon-types.js";
import { HeartbeatLoop } from "./heartbeat-loop.js";
import { RealTreeGuardian } from "./real-tree-guardian.js";
import { TriggerRegistry } from "./trigger-registry.js";
import type { TaskManager } from "../tasks/task-manager.js";
import { TaskStatus } from "../tasks/types.js";

/** The repository root: where a source checkout's daemon reads HEARTBEAT.md. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const START = new Date("2026-03-02T08:00:00Z");
const MINUTE_MS = 60_000;
/** Two hours of one-minute heartbeat ticks: 24 occurrences of a 5-minute cron. */
const TICKS = 120;

function stubLogger(): winston.Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as winston.Logger;
}

function daemonConfig(heartbeatFile: string): DaemonConfig {
  return {
    heartbeat: { intervalMs: MINUTE_MS, heartbeatFile, idlePause: false },
    security: { approvalTimeoutMin: 30, autoApproveTools: [] },
    budget: { dailyBudgetUsd: 10, warnPct: 0.8 },
    backoff: { baseCooldownMs: MINUTE_MS, maxCooldownMs: 60 * MINUTE_MS, failureThreshold: 3 },
    timezone: "UTC",
    triggers: {
      webhookRateLimit: "10/min",
      dedupWindowMs: 5 * MINUTE_MS,
      defaultDebounceMs: 500,
      checklistMorningHour: 9,
      checklistAfternoonHour: 14,
      checklistEveningHour: 18,
    },
    triggerFireRetentionDays: 30,
  } as DaemonConfig;
}

/** A task manager whose tasks finish at once, so overlap suppression never hides a fire. */
function finishingTaskManager() {
  const submitted: Array<{ prompt: string; origin?: unknown }> = [];
  const manager = {
    submit: vi.fn((_chatId: string, _channel: string, prompt: string, options?: { origin?: unknown }) => {
      submitted.push({ prompt, origin: options?.origin });
      return { id: `task_${submitted.length}`, status: TaskStatus.pending };
    }),
    getStatus: vi.fn((id: string) => ({ id, status: TaskStatus.completed })),
    hasActiveForegroundTasks: vi.fn(() => false),
    cancel: vi.fn(() => true),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { manager, submitted };
}

function memoryStorage() {
  const state = new Map<string, string>();
  return {
    getDaemonState: (key: string) => state.get(key),
    setDaemonState: (key: string, value: string) => void state.set(key, value),
    getAllCircuitStates: () => new Map(),
    upsertCircuitState: vi.fn(),
    insertTriggerFireHistory: vi.fn(),
    pruneTriggerFireHistoryByAge: () => 0,
    pruneLedgers: () => ({ notifications: 0, deployments: 0, budgetEntries: 0 }),
  };
}

/**
 * Load `heartbeatFile` from `projectRoot` the way bootstrap does, then run the
 * heartbeat for TICKS minutes. Returns what reached a provider's doorstep.
 */
async function runHeartbeat(
  options: { projectRoot: string; heartbeatFile: string; readFile?: (path: string) => string },
  tasks = finishingTaskManager(),
) {
  const registry = new TriggerRegistry();
  const config = daemonConfig(options.heartbeatFile);
  loadDaemonTriggersStage(
    { daemonConfig: config as never, logger: stubLogger(), triggerRegistry: registry, projectRoot: options.projectRoot },
    options.readFile ? { readFile: (path) => options.readFile!(String(path)) } : {},
  );
  const eventBus = new TypedEventBus<DaemonEventMap>();
  const fired: string[] = [];
  eventBus.on("daemon:trigger_fired", (event) => fired.push(event.triggerName));
  const budget = { getUsage: () => ({ usedUsd: 0, limitUsd: 10, pct: 0 }), isExceeded: () => false, isWarning: () => false };
  const loop = new HeartbeatLoop(
    registry,
    tasks.manager as never,
    budget as never,
    { checkPermission: () => "allow" } as never,
    { expireStale: vi.fn() } as never,
    memoryStorage() as never,
    undefined,
    eventBus,
    config,
    stubLogger(),
  );
  loop.start();
  try {
    for (let minute = 1; minute <= TICKS; minute++) {
      vi.setSystemTime(START.getTime() + minute * MINUTE_MS);
      await loop.tick();
    }
  } finally {
    loop.stop();
  }
  return { triggers: registry.count(), submitted: tasks.submitted, fired };
}

describe("the triggers this repository ships, on a healthy project", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("open no task and fire nothing a model would be asked about, for two hours of heartbeat", async () => {
    const run = await runHeartbeat({ projectRoot: REPO_ROOT, heartbeatFile: "./HEARTBEAT.md" });

    expect(run.submitted).toEqual([]);
    expect(run.fired).toEqual([]);
  });

  it("control: the same harness does see a cron trigger's tasks, so the zero above is a measurement", async () => {
    // Invented content, not the shipped file: a cron trigger whose action is
    // a sentence. This is the shape the shipped health check had.
    const fixture = [
      "# Daemon triggers",
      "",
      "### oven-log",
      "- type: cron",
      "- cron: */5 * * * *",
      "- action: Summarise the bakery oven log",
      "- cooldown: 300",
      "",
    ].join("\n");
    const run = await runHeartbeat({ projectRoot: REPO_ROOT, heartbeatFile: "./fixture.md", readFile: () => fixture });

    expect(run.triggers).toBe(1);
    // One task every five minutes for two hours, each one a model run.
    expect(run.submitted).toHaveLength(TICKS / 5);
    expect(run.submitted[0]).toEqual({ prompt: "Summarise the bakery oven log", origin: "daemon" });
    expect(run.fired).toHaveLength(TICKS / 5);
  });
});

describe("the project's health is still measured, and a real finding still becomes work", () => {
  it("the guardian opens no task on a green tree and ONE task naming the error on a red one", async () => {
    const tasks = finishingTaskManager();
    const notes: string[] = [];
    const verify = vi.fn().mockResolvedValue({ ok: true, ran: true, detail: "compile succeeded" });
    let clock = 0;
    const guardian = new RealTreeGuardian({
      taskManager: tasks.manager as unknown as TaskManager,
      verify,
      projectRoot: "/projects/bakery",
      messenger: async (_chatId, text) => void notes.push(text),
      now: () => clock,
    });

    for (let i = 0; i < 8; i++) {
      clock += 15 * MINUTE_MS;
      await guardian.tick();
    }
    expect(verify).toHaveBeenCalledTimes(8);
    expect(tasks.submitted).toEqual([]);

    verify.mockResolvedValue({ ok: false, ran: true, detail: "Assets/Oven.cs(12,5): error CS0103: The name 'crust' does not exist" });
    clock += 15 * MINUTE_MS;
    await guardian.tick();

    expect(tasks.submitted).toHaveLength(1);
    expect(tasks.submitted[0]!.prompt).toContain("CS0103");
    expect(tasks.submitted[0]!.origin).toBe("daemon");
    expect(notes.some((note) => note.includes("CS0103"))).toBe(true);
  });
});
