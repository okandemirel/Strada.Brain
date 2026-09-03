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

  it("the goal auto-resume abandons a cancelled lineage too", () => {
    // Measured live 2026-09-03 10:35: with the keep-alive guarded, the same
    // delivered campaign's sprint work came back through "Replanning a
    // stalled goal instead of replaying it" — three fresh tasks against a
    // game that had already shipped.
    const { executor, internals } = harness("cancelled");
    const replan = vi.fn();
    (internals.taskManager as { replanGoalRoot?: unknown }).replanGoalRoot = replan;
    (internals.taskManager as { retryGoalRoot?: unknown }).retryGoalRoot = replan;

    (executor as unknown as {
      autoResumeBlockedGoal(t: unknown, tree: unknown, n: number, o: readonly string[]): void;
    }).autoResumeBlockedGoal(
      { id: "task_1", chatId: "cli-local", prompt: "sprint", origin: "user" },
      { rootId: "goal_1" },
      0,
      ["node failed"],
    );

    expect(replan).not.toHaveBeenCalled();
  });

  it("a cancel ANYWHERE in the ancestry retires the lineage", async () => {
    // Measured live 2026-09-03 10:45, a sixth resurrection: once a
    // continuation minted a fresh task after the cancel, the lineage TIP was
    // that new task and the chain walked straight around a tip-only guard.
    vi.useFakeTimers();
    try {
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
      // tip is BLOCKED (a fresh task), but its grandparent was cancelled.
      // origin/chatId/prompt matter: scheduleMissionKeepAlive returns early
      // for anything that is not a user mission, which would make this test
      // pass for the wrong reason.
      const rows: Record<string, {
        id: string; status: string; parentId?: string; origin: string; chatId: string; prompt: string;
      }> = {
        task_new: { id: "task_new", status: "blocked", parentId: "task_mid", origin: "user", chatId: "cli-local", prompt: "sprint" },
        task_mid: { id: "task_mid", status: "blocked", parentId: "task_root", origin: "user", chatId: "cli-local", prompt: "sprint" },
        task_root: { id: "task_root", status: "cancelled", origin: "user", chatId: "cli-local", prompt: "sprint" },
      };
      internals.taskManager = {
        // The tip is ALIVE: a tip-only guard sees nothing wrong here.
        findLatestLineageTask: () => rows["task_new"],
        getStatus: (id: string) => rows[id] ?? null,
        findLineageRootId: () => "task_root",
        listTasks: () => [],
        retryTask: (id: string) => { submitted.push(id); return { id: "x" }; },
        submit: (o: { prompt: string }) => { submitted.push(o.prompt); return { id: "x" }; },
        appendTaskNotice: vi.fn(),
        block: vi.fn(),
      };

      (executor as unknown as { scheduleMissionKeepAlive(t: unknown, r: string): boolean })
        .scheduleMissionKeepAlive(rows["task_new"], "transient");
      await vi.advanceTimersByTimeAsync(15 * 60_000);

      expect(submitted).toHaveLength(0);
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
