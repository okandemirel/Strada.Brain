import { describe, expect, it, vi } from "vitest";
import { BackgroundExecutor } from "./background-executor.js";

/**
 * Measured live 2026-09-03: three times after the campaign delivered (09:19,
 * 09:37, 09:53) the mission keep-alive revived a blocked pre-delivery task
 * and resubmitted the sprint against a game that had already shipped — each
 * one able to write to the project the user was inspecting. The campaign
 * cancels its lineages when it finishes; a deliberate stop must outrank a
 * keep-alive.
 */
describe("mission keep-alive vs a cancelled lineage", () => {
  function harness(tipStatus: string) {
    const executor = Object.create(BackgroundExecutor.prototype) as BackgroundExecutor;
    const internals = executor as unknown as {
      missionRetries: Map<string, number>;
      taskManager: unknown;
      allProvidersCoolingDownMs: () => number;
      lineageRootTaskId: (t: { id: string }) => string;
    };
    internals.missionRetries = new Map();
    internals.allProvidersCoolingDownMs = () => 0;
    internals.lineageRootTaskId = () => "task_root";
    const submitted: string[] = [];
    internals.taskManager = {
      findLatestLineageTask: () => ({ id: "task_tip", status: tipStatus }),
      listTasks: () => [],
      getStatus: () => null,
      retryTask: (id: string) => { submitted.push(id); return { id: "task_new" }; },
      submit: (o: { prompt: string }) => { submitted.push(o.prompt); return { id: "task_new" }; },
      appendTaskNotice: vi.fn(),
      block: vi.fn(),
    };
    return { executor, internals, submitted };
  }

  it("abandons the retry when the lineage tip was cancelled", async () => {
    vi.useFakeTimers();
    try {
      const { executor, internals, submitted } = harness("cancelled");
      const task = { id: "task_1", chatId: "cli-local", prompt: "sprint", origin: "user" };
      (executor as unknown as { scheduleMissionKeepAlive(t: unknown, r: string): boolean })
        .scheduleMissionKeepAlive(task, "transient");
      await vi.advanceTimersByTimeAsync(15 * 60_000);

      expect(submitted).toHaveLength(0);
      expect(internals.missionRetries.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still retries when the lineage tip is merely blocked", async () => {
    vi.useFakeTimers();
    try {
      const { executor, submitted } = harness("blocked");
      const task = { id: "task_1", chatId: "cli-local", prompt: "sprint", origin: "user" };
      (executor as unknown as { scheduleMissionKeepAlive(t: unknown, r: string): boolean })
        .scheduleMissionKeepAlive(task, "transient");
      await vi.advanceTimersByTimeAsync(15 * 60_000);

      expect(submitted.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
