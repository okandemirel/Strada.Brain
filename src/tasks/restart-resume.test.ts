import { describe, expect, it, vi } from "vitest";
import { BackgroundExecutor } from "./background-executor.js";

/**
 * Measured 2026-09-10: five daemon boots, each marking the mission in flight
 * "paused on recovery, recoverable: true" — and then nothing resumed it. The
 * keep-alive re-arm only read blocked tasks with a retry marker; the only
 * other path was a human typing /resume. A restart is not a stop order.
 */
describe("tasks a restart paused are resumed by the re-arm pass", () => {
  function harness(opts: { paused: unknown[]; live?: unknown[]; cancelled?: boolean }) {
    const executor = Object.create(BackgroundExecutor.prototype) as BackgroundExecutor;
    const internals = executor as unknown as {
      missionRetries: Map<string, number>;
      taskManager: unknown;
      allProvidersCoolingDownMs: () => number;
      lineageRootTaskId: (t: { id: string }) => string;
      isLineageCancelled: () => boolean;
      scheduleKeepAliveRearm: () => void;
    };
    internals.missionRetries = new Map();
    internals.allProvidersCoolingDownMs = () => 0;
    internals.lineageRootTaskId = (t) => t.id;
    internals.isLineageCancelled = () => opts.cancelled ?? false;
    const resumed: string[] = [];
    internals.taskManager = {
      listRecoverableTasks: () => [],
      listPausedByRestart: () => opts.paused,
      listTasks: () => opts.live ?? [],
      getStatus: () => null,
      resumeTask: (id: string) => { resumed.push(id); return { id: "task_new" }; },
      retryTask: vi.fn(),
      appendTaskNotice: vi.fn(),
      block: vi.fn(),
    };
    return { executor, internals, resumed };
  }
  const paused = { id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "paused", error: "Task interrupted by system restart. Resume is available from the monitor and will continue from the saved plan." };

  it("resumes the paused mission 90 s after boot", async () => {
    vi.useFakeTimers();
    try {
      const { internals, resumed } = harness({ paused: [paused] });
      internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(89_000);
      expect(resumed).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(resumed).toEqual(["task_1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resume when the mission already continues under another live task with the same prompt", async () => {
    vi.useFakeTimers();
    try {
      const { internals, resumed } = harness({ paused: [paused], live: [{ id: "task_9", chatId: "cli-local", prompt: "Mission: build the game", status: "executing" }] });
      internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(95_000);
      expect(resumed).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a cancelled lineage alone, and resumes one mission per chat", async () => {
    vi.useFakeTimers();
    try {
      const { internals, resumed } = harness({ paused: [paused], cancelled: true });
      internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(95_000);
      expect(resumed).toHaveLength(0);
      const second = harness({ paused: [paused, { ...paused, id: "task_2", prompt: "Mission: other" }] });
      second.internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(95_000 + 60_000);
      expect(second.resumed).toEqual(["task_1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
