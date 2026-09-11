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

describe("a blocked mission without a retry marker is re-armed too (audited 2026-09-10: blocked:provider_unavailable sat through three boots)", () => {
  function harness(blocked: unknown[]) {
    const executor = Object.create(BackgroundExecutor.prototype) as BackgroundExecutor;
    const internals = executor as unknown as {
      missionRetries: Map<string, number>;
      taskManager: unknown;
      allProvidersCoolingDownMs: () => number;
      lineageRootTaskId: (t: { id: string }) => string;
      isLineageCancelled: () => boolean;
      lineageTipOf: () => unknown;
      scheduleKeepAliveRearm: () => void;
    };
    internals.missionRetries = new Map();
    internals.allProvidersCoolingDownMs = () => 0;
    internals.lineageRootTaskId = (t) => t.id;
    internals.isLineageCancelled = () => false;
    internals.lineageTipOf = () => null;
    const retried: string[] = [];
    const blocks: string[] = [];
    internals.taskManager = {
      listRecoverableTasks: () => blocked,
      listPausedByRestart: () => [],
      listTasks: () => [],
      getStatus: () => null,
      findLatestLineageTask: () => ({ id: "task_1", status: "blocked" }),
      findLineageRootId: () => null,
      retryTask: (id: string) => { retried.push(id); return { id: "task_new" }; },
      appendTaskNotice: vi.fn(),
      block: (_id: string, msg: string) => { blocks.push(msg); },
    };
    return { internals, retried, blocks };
  }

  it("retries a mission blocked with a plain reason, from attempt 1", async () => {
    vi.useFakeTimers();
    try {
      const { internals, retried, blocks } = harness([{ id: "task_1", chatId: "cli-local", prompt: "Mission: build", origin: "user", status: "blocked", result: "Blocked: [goal_1] blocked:provider_unavailable  Skipped: dependency failed" }]);
      internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(90_000 + 31_000);
      expect(retried).toEqual(["task_1"]);
      expect(blocks[0]).toMatch(/Auto-retry 1\/10/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a mission that is waiting on a person alone", async () => {
    vi.useFakeTimers();
    try {
      const { internals, retried } = harness([{ id: "task_1", chatId: "cli-local", prompt: "Mission: build", origin: "user", status: "blocked", result: "Paused on a question for you. Reply here with your answer and the work continues." }]);
      internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(90_000 + 31_000);
      expect(retried).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});


/**
 * Measured live 2026-09-11: the daemon booted at 11:54:22, 12:24:51 and
 * 12:44:57 (auto-update restarts), and each boot's re-arm of the SAME blocked
 * mission spent one of its ten retries — 8 → 9 → 10 — until the third boot
 * escalated with "MISSION STOPPED — needs you … Last blocker: keep-alive
 * re-armed after restart". The mission had not failed once in that hour.
 */
describe("a restart does not spend a mission retry, and never escalates", () => {
  function harness(blocked: unknown[]) {
    const executor = Object.create(BackgroundExecutor.prototype) as BackgroundExecutor;
    const internals = executor as unknown as {
      missionRetries: Map<string, number>;
      taskManager: unknown;
      allProvidersCoolingDownMs: () => number;
      lineageRootTaskId: (t: { id: string }) => string;
      isLineageCancelled: () => boolean;
      lineageTipOf: () => unknown;
      scheduleKeepAliveRearm: () => void;
      scheduleMissionKeepAlive: (t: unknown, reason: string, o?: { spendAttempt?: boolean }) => boolean;
    };
    internals.missionRetries = new Map();
    internals.allProvidersCoolingDownMs = () => 0;
    internals.lineageRootTaskId = (t) => t.id;
    internals.isLineageCancelled = () => false;
    internals.lineageTipOf = () => null;
    const retried: string[] = [];
    const blocks: string[] = [];
    const notices: string[] = [];
    internals.taskManager = {
      listRecoverableTasks: () => blocked,
      listPausedByRestart: () => [],
      listTasks: () => [],
      getStatus: () => null,
      findLatestLineageTask: () => ({ id: "task_1", status: "blocked" }),
      findLineageRootId: () => null,
      retryTask: (id: string) => { retried.push(id); return { id: "task_new" }; },
      appendTaskNotice: (_id: string, msg: string) => { notices.push(msg); },
      block: (_id: string, msg: string) => { blocks.push(msg); },
    };
    return { internals, retried, blocks, notices };
  }
  const blockedAt = (attempt: number, carry?: number): unknown => ({
    id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "blocked",
    result: `Transient failure — keep-alive re-armed after restart. Auto-retry ${attempt}/10 in ~600s.`
      + (carry === undefined ? "" : ` Restart re-arm — failure retries still at ${carry}/10.`),
  });

  it("carries the failure count instead of walking it up one per boot", async () => {
    vi.useFakeTimers();
    try {
      const { internals, blocks } = harness([blockedAt(9, 8)]);
      internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(90_000 + 1_000);
      expect(blocks[0]).toContain("Restart re-arm — failure retries still at 8/10.");
      expect(internals.missionRetries.get("mission:task_1")).toBe(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms a mission already at the cap rather than stopping it", async () => {
    vi.useFakeTimers();
    try {
      const { internals, retried, notices } = harness([blockedAt(10, 10)]);
      internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(90_000 + 601_000);
      expect(notices.join(" ")).not.toContain("MISSION STOPPED");
      expect(retried).toEqual(["task_1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still escalates when a REAL failure hits the cap, naming the blocker once", () => {
    const { internals, notices } = harness([]);
    internals.missionRetries.set("mission:task_1", 10);
    const kept = internals.scheduleMissionKeepAlive(
      { id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "failed" },
      "compile failed: CS1002",
    );
    expect(kept).toBe(false);
    expect(notices[0]).toContain("MISSION STOPPED");
    expect(notices[0]).toContain("Last blocker: compile failed: CS1002");
    expect(notices[0]!.match(/Last blocker:/g)).toHaveLength(1);
  });
});
