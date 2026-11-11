import { describe, expect, it, vi } from "vitest";
import { BackgroundExecutor } from "./background-executor.js";
import { TaskManager } from "./task-manager.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

/**
 * A stop that waits on a person — a question, or a spent retry budget — writes
 * the block and then a notice saying what is needed. block() announced the
 * first and appendTaskNotice() announced the second with the first inside it,
 * so the channel carried the same long message twice (owner task #39).
 */
describe("a stop that needs a person is announced once", () => {
  const STOPPED = 'Steps finished: 0 of 2.\n\nCould not finish "Sort the recipe cards" (boom)';
  const task = { id: "task_1", chatId: "cli-local", prompt: "Sort the recipe cards.", origin: "agent" };

  function harness() {
    // A storage that remembers what the manager writes, as the real one does.
    const rows = new Map<string, { id: string; status: string; result?: string }>();
    rows.set(task.id, { id: task.id, status: "executing" });
    const storage = {
      load: (id: string) => rows.get(id) ?? null,
      updateBlocked: (id: string, text: string) => {
        rows.set(id, { id, status: "blocked", result: text });
      },
    };
    const manager = new TaskManager(storage as never, {} as never);
    const announced: string[] = [];
    manager.on("task:blocked", (_id: string, text: string) => announced.push(text));

    const executor = Object.create(BackgroundExecutor.prototype) as BackgroundExecutor;
    Object.assign(executor, {
      taskManager: manager,
      autoResumeState: new Map(),
      missionRetries: new Map(),
      allProvidersCoolingDownMs: () => 0,
      lineageRootTaskId: () => "task_root",
    });
    const resume = (outcomes: readonly string[]): void =>
      (executor as unknown as {
        autoResumeBlockedGoal(t: unknown, tr: unknown, s: number, o: readonly string[], m: string): void;
      }).autoResumeBlockedGoal(task, { rootId: "goal_root" }, 0, outcomes, STOPPED);
    return { manager, rows, announced, resume };
  }

  it("a question reaches the channel once, with the stuck steps and the question together", () => {
    const { rows, announced, resume } = harness();
    resume(["goal_a blocked on deepseek: blocked:ask_user"]);

    expect(announced).toHaveLength(1);
    expect(announced[0]).toContain(STOPPED);
    expect(announced[0]).toContain("Paused on a question for you");
    // What a later reader of the row sees is what the channel was told.
    expect(rows.get(task.id)?.result).toBe(announced[0]);
  });

  it("a spent retry budget reaches the channel once, with the stuck steps and the stop notice", () => {
    const { manager, announced, resume } = harness();
    // Stub the spending: the next decision is a stop (three rounds without progress).
    (manager as unknown as { retryGoalRoot: () => unknown }).retryGoalRoot = () => ({ id: "t2" });
    (manager as unknown as { replanGoalRoot: () => unknown }).replanGoalRoot = () => ({ id: "t3" });
    (manager as unknown as { findLatestLineageTask: () => unknown }).findLatestLineageTask = () => null;
    (manager as unknown as { getStatus: () => unknown }).getStatus = () => null;
    for (let round = 0; round < 3; round++) resume(["goal_a failed on deepseek: boom"]);
    announced.length = 0;

    resume(["goal_a failed on deepseek: boom"]);

    expect(announced).toHaveLength(1);
    expect(announced[0]).toContain(STOPPED);
    expect(announced[0]).toContain("Goal stopped after");
  });

  it("two separate blocks inside one scope are both announced, and a notice is not a second message", () => {
    const { manager, announced } = harness();
    manager.announceBlockedOnce(task.id as never, () => {
      manager.block(task.id as never, "first stop");
      manager.block(task.id as never, "second stop");
      manager.appendTaskNotice(task.id as never, "needs you");
    });

    expect(announced).toEqual(["first stop", "second stop\n\nneeds you"]);
  });

  it("outside a scope each write is still announced as before", () => {
    const { manager, announced } = harness();
    manager.block(task.id as never, "stop");
    manager.appendTaskNotice(task.id as never, "needs you");

    expect(announced).toEqual(["stop", "stop\n\nneeds you"]);
  });
});
