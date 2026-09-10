import { describe, expect, it, vi } from "vitest";
import { BackgroundExecutor } from "./background-executor.js";

/**
 * Measured 2026-09-10 11:47: every provider was benched by a 401 burst; the
 * keep-alive read the soonest cooldownUntil — 7.9 hours out — and parked the
 * mission on one setTimeout for exactly that long. The outage was over by
 * 11:50 (the operator rotated the key), and nothing woke the mission. The
 * wait now trusts a horizon for at most 15 minutes, then re-measures; a
 * re-poll that still finds the chain cooling parks again without spending
 * one of the ten retry attempts.
 */
describe("mission keep-alive re-polls a long provider cooldown", () => {
  function harness(coolingMs: { value: number }) {
    const executor = Object.create(BackgroundExecutor.prototype) as BackgroundExecutor;
    const internals = executor as unknown as {
      missionRetries: Map<string, number>;
      taskManager: unknown;
      allProvidersCoolingDownMs: () => number;
      lineageRootTaskId: (t: { id: string }) => string;
      isLineageCancelled: () => boolean;
      lineageTipOf: () => unknown;
    };
    internals.missionRetries = new Map();
    internals.allProvidersCoolingDownMs = () => coolingMs.value;
    internals.lineageRootTaskId = () => "task_root";
    internals.isLineageCancelled = () => false;
    internals.lineageTipOf = () => null;
    const retried: string[] = [];
    const blocks: string[] = [];
    internals.taskManager = {
      findLatestLineageTask: () => ({ id: "task_1", status: "blocked" }),
      listTasks: () => [],
      getStatus: () => null,
      findLineageRootId: () => null,
      retryTask: (id: string) => { retried.push(id); return { id: "task_new" }; },
      appendTaskNotice: vi.fn(),
      block: (_id: string, msg: string) => { blocks.push(msg); },
    };
    return { executor, internals, retried, blocks };
  }
  const task = { id: "task_1", chatId: "cli-local", prompt: "Mission: build it", origin: "user" };
  const schedule = (executor: BackgroundExecutor) =>
    (executor as unknown as { scheduleMissionKeepAlive(t: unknown, r: string): boolean }).scheduleMissionKeepAlive(task, "All providers are in cooldown");

  it("waits 15 minutes, not 8 hours, and retries as soon as the chain is back", async () => {
    vi.useFakeTimers();
    try {
      const cooling = { value: 8 * 60 * 60_000 };
      const { executor, retried, blocks } = harness(cooling);
      schedule(executor);
      expect(blocks[0]).toMatch(/Auto-retry 1\/10 in ~900s/);
      cooling.value = 0; // the key was rotated two minutes later
      await vi.advanceTimersByTimeAsync(14 * 60_000);
      expect(retried).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(retried).toEqual(["task_1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a re-poll that still finds the chain cooling parks again without spending an attempt", async () => {
    vi.useFakeTimers();
    try {
      const cooling = { value: 8 * 60 * 60_000 };
      const { executor, internals, retried, blocks } = harness(cooling);
      schedule(executor);
      expect(internals.missionRetries.get("mission:task_root")).toBe(1);
      await vi.advanceTimersByTimeAsync(16 * 60_000);
      expect(retried).toHaveLength(0);
      expect(internals.missionRetries.get("mission:task_root")).toBe(1); // still attempt 1, not 2
      expect(blocks).toHaveLength(2);
      expect(blocks[1]).toMatch(/Auto-retry 1\/10 in ~900s/);
      await vi.advanceTimersByTimeAsync(3 * 16 * 60_000);
      expect(internals.missionRetries.get("mission:task_root")).toBe(1);
      expect(retried).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a short cooldown is waited out exactly as before", async () => {
    vi.useFakeTimers();
    try {
      const cooling = { value: 5 * 60_000 };
      const { executor, retried, blocks } = harness(cooling);
      schedule(executor);
      expect(blocks[0]).toMatch(/in ~300s/);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);
      expect(retried).toEqual(["task_1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
