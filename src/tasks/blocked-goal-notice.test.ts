import { describe, expect, it, vi } from "vitest";
import { BackgroundExecutor } from "./background-executor.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

/**
 * A stopped goal is blocked once, by autoResumeBlockedGoal, after it has
 * decided what happens next, so the one message the user reads can say it.
 *
 * Measured 2026-11-06 (golden run): the block was written before that
 * decision, the goal was resumed in the same tick, and nothing told the user;
 * they read a failure, then an answer nobody had explained. The block also
 * has to come before the resubmission: a task that is still running cannot be
 * retried.
 */
describe("the block a stopped goal is given", () => {
  const STOPPED = 'Steps finished: 0 of 2.\n\nCould not finish "Sort the recipe cards" (boom)';
  const RETRY = "Retrying automatically now (automatic retry 1); finished steps are kept.";
  const task = { id: "task_1", chatId: "cli-local", prompt: "Sort the recipe cards and rebuild the index.", origin: "agent" };
  const tree = { rootId: "goal_root" };

  function harness(opts: { tipStatus?: string } = {}) {
    const executor = Object.create(BackgroundExecutor.prototype) as BackgroundExecutor;
    const taskManager = {
      findLatestLineageTask: () => (opts.tipStatus ? { id: "task_tip", status: opts.tipStatus } : null),
      getStatus: () => null,
      block: vi.fn(),
      appendTaskNotice: vi.fn(),
      retryGoalRoot: vi.fn(() => ({ id: "task_2" })),
      replanGoalRoot: vi.fn(() => ({ id: "task_2" })),
    };
    Object.assign(executor, {
      taskManager,
      autoResumeState: new Map(),
      missionRetries: new Map(),
      allProvidersCoolingDownMs: () => 0,
      lineageRootTaskId: () => "task_root",
    });
    const resume = (outcomes: readonly string[] = ["goal_a failed on deepseek: boom"]): void =>
      (executor as unknown as {
        autoResumeBlockedGoal(t: unknown, tr: unknown, s: number, o: readonly string[], m: string): void;
      }).autoResumeBlockedGoal(task, tree, 0, outcomes, STOPPED);
    return { taskManager, resume };
  }

  it("a replay says it is retrying, and is written before the retry is submitted", () => {
    const { taskManager, resume } = harness();
    resume();

    expect(taskManager.block.mock.calls).toEqual([[task.id, `${STOPPED}\n\n${RETRY}`]]);
    expect(taskManager.retryGoalRoot).toHaveBeenCalledWith(tree.rootId);
    expect(taskManager.block.mock.invocationCallOrder[0]!)
      .toBeLessThan(taskManager.retryGoalRoot.mock.invocationCallOrder[0]!);
  });

  it("a round that finished nothing new is planned again, and the block says that instead", () => {
    const { taskManager, resume } = harness();
    resume();
    resume();

    expect(taskManager.block.mock.calls[1]).toEqual([
      task.id,
      `${STOPPED}\n\nThe last retry finished no new step, so the unfinished work is being planned again ` +
        "automatically (new plan 1); finished steps are kept.",
    ]);
    expect(taskManager.replanGoalRoot).toHaveBeenCalledTimes(1);
    expect(taskManager.block.mock.invocationCallOrder[1]!)
      .toBeLessThan(taskManager.replanGoalRoot.mock.invocationCallOrder[0]!);
  });

  it("promises no retry when it waits on a person, stops, or the lineage was cancelled", () => {
    // A question: blocked as it is, then the notice that asks for the answer.
    const asked = harness();
    asked.resume(["goal_a blocked on deepseek: blocked:ask_user"]);
    expect(asked.taskManager.block.mock.calls).toEqual([[task.id, STOPPED]]);
    expect(asked.taskManager.appendTaskNotice).toHaveBeenCalledWith(task.id, expect.stringContaining("Paused on a question"));

    // Three rounds without progress (a replay, then two fresh plans) spend
    // the budget; the fourth is blocked as it is, then the stop notice.
    const spent = harness();
    for (let round = 0; round < 3; round++) spent.resume();
    spent.taskManager.block.mockClear();
    spent.resume();
    expect(spent.taskManager.block.mock.calls).toEqual([[task.id, STOPPED]]);
    expect(spent.taskManager.appendTaskNotice).toHaveBeenCalledWith(task.id, expect.stringContaining("Goal stopped after"));
    expect(spent.taskManager.retryGoalRoot).toHaveBeenCalledTimes(1);
    expect(spent.taskManager.replanGoalRoot).toHaveBeenCalledTimes(2);

    // A cancelled lineage: blocked as it is, and nothing resubmitted.
    const cancelled = harness({ tipStatus: "cancelled" });
    cancelled.resume();
    expect(cancelled.taskManager.block.mock.calls).toEqual([[task.id, STOPPED]]);
    expect(cancelled.taskManager.retryGoalRoot).not.toHaveBeenCalled();
    expect(cancelled.taskManager.replanGoalRoot).not.toHaveBeenCalled();
  });
});
