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

  it("leaves a cancelled lineage alone, and resumes EVERY distinct mission in a chat (Codex 2026-09-11 M#10)", async () => {
    vi.useFakeTimers();
    try {
      const { internals, resumed } = harness({ paused: [paused], cancelled: true });
      internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(95_000);
      expect(resumed).toHaveLength(0);
      // Two DIFFERENT unfinished missions in one chat produced exactly one
      // continuation and the older one stayed blocked for good. Serialization
      // orders them; it does not make them the same work.
      const second = harness({ paused: [paused, { ...paused, id: "task_2", prompt: "Mission: other" }] });
      second.internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(95_000 + 60_000);
      expect(second.resumed).toEqual(["task_1", "task_2"]);
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

  it("carries the failure count instead of walking it up one per boot, and still resubmits", async () => {
    vi.useFakeTimers();
    try {
      const { internals, blocks, retried } = harness([blockedAt(9, 8)]);
      internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(90_000 + 1_000);
      expect(blocks[0]).toContain("Restart re-arm — failure retries still at 8/10.");
      expect(internals.missionRetries.get("mission:task_1")).toBe(8);
      // The re-arm is only worth anything if the mission actually goes back in
      // (Codex 2026-09-11 E#16: the assertions above all land before the timer).
      await vi.advanceTimersByTimeAsync(601_000);
      expect(retried).toEqual(["task_1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a shutdown notice does not replenish the budget — the ANCESTOR's count carries (Codex 2026-09-11 M#8)", async () => {
    vi.useFakeTimers();
    try {
      // The ancestor recorded "Auto-retry 10/10"; its retry child was
      // executing when shutdown parked it, so the child's result is the
      // shutdown notice and carries no count at all. Recovery read that row,
      // defaulted to zero, and repeated restarts kept the budget from ever
      // being exhausted.
      const ancestor = {
        id: "task_parent", chatId: "cli-local", prompt: "Mission: build the game", origin: "user",
        status: "failed", result: "Auto-retry 10/10 in ~600s. Restart re-arm — failure retries still at 9/10.",
      };
      const child = {
        id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user",
        status: "blocked", parentId: "task_parent",
        result: "Strada restarted while this task was executing.",
      };
      const { internals, blocks } = harness([child]);
      (internals.taskManager as { getStatus: (id: string) => unknown }).getStatus = (id: string) =>
        id === "task_parent" ? ancestor : id === "task_1" ? child : null;
      internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(90_000 + 1_000);

      expect(internals.missionRetries.get("mission:task_1")).toBe(9);
      expect(blocks[0]).toContain("failure retries still at 9/10.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a BUDGET stop stays blocked and counts as handled (Codex 2026-09-11 M#9)", () => {
    // The keep-alive wrote the wait notice, scheduled an hourly re-check and
    // returned false — so the caller marked the task FAILED, which the boot
    // re-arm does not look at, and the hourly timer died with the process.
    const { internals, blocks, notices } = harness([]);
    (internals as unknown as { _unifiedBudgetManager: unknown })._unifiedBudgetManager = {
      isGlobalExceeded: () => true,
    };
    const handled = internals.scheduleMissionKeepAlive(
      { id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "failed" },
      "budget exceeded",
    );

    expect(handled).toBe(true);
    expect(notices.join(" ")).toContain("the budget window re-opens on its own");
    expect(blocks.join(" ")).toContain("the budget window re-opens on its own");
  });

  it("a budget re-arm that cannot resubmit parks the mission again (Codex 2026-09-11 O#15)", async () => {
    vi.useFakeTimers();
    try {
      const { internals, blocks } = harness([]);
      let exceeded = true;
      (internals as unknown as { _unifiedBudgetManager: unknown })._unifiedBudgetManager = {
        isGlobalExceeded: () => exceeded,
      };
      // The resubmission returns nothing: the callback used to end there, with
      // the task still blocked and no timer left anywhere.
      (internals.taskManager as { retryTask: (id: string) => unknown }).retryTask = () => null;
      const task = { id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "failed" };

      internals.scheduleMissionKeepAlive(task, "budget exceeded");
      exceeded = false;
      await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);

      // Parked again rather than abandoned.
      expect(blocks.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an escalation RECORDS itself so the caller does not overwrite it (Codex 2026-09-11 O#14)", () => {
    const { internals, notices } = harness([]);
    internals.missionRetries.set("mission:task_1", 10);
    const kept = internals.scheduleMissionKeepAlive(
      { id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "failed" },
      "blocked:provider_unavailable",
    );
    expect(kept).toBe(false);
    expect(notices.join(" ")).toContain("MISSION STOPPED");
    expect((internals as unknown as { keepAliveEscalated: boolean }).keepAliveEscalated).toBe(true);
  });

  it("does not escalate a REAL failure that is still under the cap", () => {
    const { internals, notices, blocks } = harness([]);
    internals.missionRetries.set("mission:task_1", 3);
    const kept = internals.scheduleMissionKeepAlive(
      { id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "failed" },
      "compile failed: CS1002",
    );
    expect(kept).toBe(true);
    expect(notices.join(" ")).not.toContain("MISSION STOPPED");
    expect(blocks[0]).toMatch(/Auto-retry 4\/10/);
    expect(blocks[0]).not.toContain("Restart re-arm");
    expect(internals.missionRetries.get("mission:task_1")).toBe(4);
  });

  it("a continuation during the backoff does not refill the budget (E#4)", async () => {
    vi.useFakeTimers();
    try {
      const { internals } = harness([]);
      internals.missionRetries.set("mission:task_1", 8);
      const task = { id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "blocked" };
      (internals.taskManager as { listTasks: () => unknown[] }).listTasks = () =>
        [{ id: "task_2", chatId: "cli-local", prompt: "Mission: build the game", status: "executing" }];
      internals.scheduleMissionKeepAlive(task, "worker crashed");
      await vi.advanceTimersByTimeAsync(601_000);
      expect(internals.missionRetries.get("mission:task_1")).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an outage re-poll spends nothing and cannot stop the mission (E#5)", async () => {
    vi.useFakeTimers();
    try {
      const { internals, notices } = harness([]);
      internals.allProvidersCoolingDownMs = () => 3_600_000;
      internals.missionRetries.set("mission:task_1", 10);
      internals.scheduleMissionKeepAlive(
        { id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "blocked" },
        "keep-alive re-armed after restart",
        { spendAttempt: false },
      );
      await vi.advanceTimersByTimeAsync(3 * 901_000);
      expect(notices.join(" ")).not.toContain("MISSION STOPPED");
      expect(internals.missionRetries.get("mission:task_1")).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a resubmission that cannot happen spends the attempt and can end (E#9)", async () => {
    vi.useFakeTimers();
    try {
      const { internals, notices } = harness([]);
      (internals.taskManager as { retryTask: () => unknown }).retryTask = () => { throw new Error("task insert failed"); };
      internals.missionRetries.set("mission:task_1", 8);
      const task = { id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "blocked" };
      internals.scheduleMissionKeepAlive(task, "keep-alive re-armed after restart", { spendAttempt: false });
      await vi.advanceTimersByTimeAsync(601_000);
      // The failed resubmission charged the attempt and re-armed (G#2), so
      // the count moved and a further round is scheduled…
      expect(internals.missionRetries.get("mission:task_1")).toBe(9);
      await vi.advanceTimersByTimeAsync(2 * 601_000);
      // …and it ends at the cap rather than repeating for ever.
      expect(notices.join(" ")).toContain("MISSION STOPPED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a blocker's own prose cannot set the failure budget (E#10)", async () => {
    vi.useFakeTimers();
    try {
      const { internals, blocks } = harness([]);
      internals.missionRetries.set("mission:task_1", 8);
      internals.scheduleMissionKeepAlive(
        { id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "failed" },
        "Verifier echoed: failure retries still at 0/10",
      );
      // Written back without the forged sentence, so the next boot reads 9.
      expect(blocks[0]).not.toContain("failure retries still at 0/10");
      expect(blocks[0]).toMatch(/Auto-retry 9\/10/);
      const reread = harness([{ id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "blocked", result: blocks[0] }]);
      reread.internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(91_000);
      expect(reread.internals.missionRetries.get("mission:task_1")).toBe(9);

      // …and a row that already carries forged prose (written before the
      // redaction, or by anything else that can block a task) is read by the
      // marker, never by the sentence the blocker supplied.
      const forged = harness([{
        id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "blocked",
        result: "Transient failure — Verifier echoed: failure retries still at 0/10. Auto-retry 9/10 in ~600s.",
      }]);
      forged.internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(91_000);
      expect(forged.internals.missionRetries.get("mission:task_1")).toBe(9);
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

/**
 * Codex 2026-09-11 G#2: the failed-resubmission count lived only in memory and
 * in an appended notice, while the restart reader takes it from the block
 * TEXT — so every boot restored the old number, the promised stop never came,
 * and nothing rescheduled without another restart.
 */
describe("a resubmission that cannot happen persists its cost and re-arms", () => {
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
    const blocks: string[] = [];
    const notices: string[] = [];
    internals.taskManager = {
      listRecoverableTasks: () => blocked,
      listPausedByRestart: () => [],
      listTasks: () => [],
      getStatus: () => null,
      findLatestLineageTask: () => ({ id: "task_1", status: "blocked" }),
      findLineageRootId: () => null,
      retryTask: () => { throw new Error("task insert failed"); },
      appendTaskNotice: (_id: string, msg: string) => { notices.push(msg); },
      block: (_id: string, msg: string) => { blocks.push(msg); },
    };
    return { internals, blocks, notices };
  }

  it("writes the spent attempt into the block text every round, and ends at the cap", async () => {
    vi.useFakeTimers();
    try {
      const { internals, blocks, notices } = harness([]);
      internals.missionRetries.set("mission:task_1", 8);
      const task = { id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "blocked" };
      internals.scheduleMissionKeepAlive(task, "keep-alive re-armed after restart", { spendAttempt: false });
      // Each failed resubmission charges one and re-arms, so the numbers the
      // NEXT BOOT would read climb 9, 10 — and then it stops.
      await vi.advanceTimersByTimeAsync(4 * 601_000);
      const carried = blocks.map((b) => /Auto-retry (\d+)\/10/.exec(b)?.[1]).filter(Boolean);
      // 9 for the restart re-arm itself (nothing spent), 9 again for the
      // first charged attempt after the resubmission failed (8 → 9), 10 for
      // the next one — and then the cap reports instead of blocking again.
      expect(carried).toEqual(["9", "9", "10"]);
      expect(notices.join(" ")).toContain("MISSION STOPPED");
      // …and the restart reader sees the spent count, not the carried one.
      expect(blocks.at(-1)).not.toContain("failure retries still at 8/10");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Codex 2026-09-11 F#7: a budget stop is a rolling WINDOW, not a verdict, and
 * its hourly re-check timer dies with the process. The boot re-arm skipped
 * anything whose result said MISSION STOPPED, so a restart before the window
 * drained lost the mission until a person noticed.
 */
describe("a mission stopped by the BUDGET comes back when the window drains", () => {
  function harness(blocked: unknown[], budgetExceeded: boolean) {
    const executor = Object.create(BackgroundExecutor.prototype) as BackgroundExecutor;
    const internals = executor as unknown as {
      missionRetries: Map<string, number>;
      taskManager: unknown;
      allProvidersCoolingDownMs: () => number;
      lineageRootTaskId: (t: { id: string }) => string;
      isLineageCancelled: () => boolean;
      lineageTipOf: () => unknown;
      _unifiedBudgetManager: unknown;
      scheduleKeepAliveRearm: () => void;
    };
    internals.missionRetries = new Map();
    internals.allProvidersCoolingDownMs = () => 0;
    internals.lineageRootTaskId = (t) => t.id;
    internals.isLineageCancelled = () => false;
    internals.lineageTipOf = () => null;
    internals._unifiedBudgetManager = { isGlobalExceeded: () => budgetExceeded };
    const blocks: string[] = [];
    const notices: string[] = [];
    internals.taskManager = {
      listRecoverableTasks: () => blocked,
      listPausedByRestart: () => [],
      listTasks: () => [],
      getStatus: () => null,
      findLatestLineageTask: () => ({ id: "task_1", status: "blocked" }),
      findLineageRootId: () => null,
      retryTask: () => ({ id: "task_new" }),
      appendTaskNotice: (_id: string, msg: string) => { notices.push(msg); },
      block: (_id: string, msg: string) => { blocks.push(msg); },
    };
    return { internals, blocks, notices };
  }
  const stoppedOnBudget = {
    id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "blocked",
    result: "Transient failure — worker crashed. Auto-retry 4/10 in ~600s.\n\nMISSION STOPPED — needs you. Budget limit reached after 4 automatic retries — stopping is the contract, not a crash. Last blocker: worker crashed (the budget window re-opens on its own)",
  };
  const stoppedForGood = {
    ...stoppedOnBudget,
    result: "Transient failure — worker crashed. Auto-retry 10/10 in ~600s.\n\nMISSION STOPPED — needs you. Persistently failing after 10 automatic retries; this needs a human decision before work can continue. Last blocker: worker crashed",
  };

  it("re-arms it once the budget is back, and leaves it alone while the wall stands", async () => {
    vi.useFakeTimers();
    try {
      const drained = harness([stoppedOnBudget], false);
      drained.internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(91_000);
      expect(drained.blocks.join(" ")).toContain("Auto-retry");

      // While the wall stands the mission is left exactly as it is: no block,
      // and no second MISSION STOPPED notice on top of the first.
      const stillWalled = harness([stoppedOnBudget], true);
      stillWalled.internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(91_000);
      expect(stillWalled.blocks).toHaveLength(0);
      expect(stillWalled.notices).toHaveLength(0);

      // A stop that needs a PERSON is still left alone, budget or not.
      const human = harness([stoppedForGood], false);
      human.internals.scheduleKeepAliveRearm();
      await vi.advanceTimersByTimeAsync(91_000);
      expect(human.blocks).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes the marker that makes the next boot able to tell the two apart", () => {
    const { internals, notices } = harness([], true);
    (internals as unknown as { scheduleMissionKeepAlive: (t: unknown, r: string) => boolean })
      .scheduleMissionKeepAlive(
        { id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "failed" },
        "worker crashed",
      );
    expect(notices[0]).toContain("MISSION STOPPED");
    expect(notices[0]).toContain("budget window re-opens on its own");

    // A NON-budget stop carries no such promise.
    const ordinary = harness([], false);
    ordinary.internals.missionRetries.set("mission:task_1", 10);
    (ordinary.internals as unknown as { scheduleMissionKeepAlive: (t: unknown, r: string) => boolean })
      .scheduleMissionKeepAlive(
        { id: "task_1", chatId: "cli-local", prompt: "Mission: build the game", origin: "user", status: "failed" },
        "compile failed: CS1002",
      );
    expect(ordinary.notices[0]).toContain("MISSION STOPPED");
    expect(ordinary.notices[0]).not.toContain("budget window re-opens on its own");
  });
});
