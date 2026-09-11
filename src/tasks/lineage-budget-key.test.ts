import { describe, expect, it } from "vitest";
import { BackgroundExecutor } from "./background-executor.js";

/**
 * The retry budget is keyed on the lineage root. A bounded parent walk that
 * gives up returns an intermediate ancestor, and an intermediate ancestor is a
 * DIFFERENT key every generation — so every failure is a first attempt and the
 * budget can never be exhausted (Codex 2026-09-11 M#11). A mission that fails
 * and retries all day reaches fifty links.
 */
describe("the retry budget's lineage key", () => {
  function harness(links: number, withStorageWalk: boolean) {
    const executor = Object.create(BackgroundExecutor.prototype) as BackgroundExecutor;
    const internals = executor as unknown as { taskManager: unknown };
    const chain = new Map<string, { id: string; parentId?: string }>();
    for (let i = 0; i <= links; i++) {
      chain.set(`task_${i}`, i === 0 ? { id: "task_0" } : { id: `task_${i}`, parentId: `task_${i - 1}` });
    }
    internals.taskManager = {
      getStatus: (id: string) => chain.get(id) ?? null,
      ...(withStorageWalk ? { findLineageRootId: () => "task_0" } : {}),
    };
    return { executor, tip: chain.get(`task_${links}`)! };
  }

  it("names the real root however long the chain is", () => {
    const { executor, tip } = harness(60, true);
    const key = (executor as unknown as { lineageRootTaskId(t: unknown): string }).lineageRootTaskId(tip);
    expect(key).toBe("task_0");
  });

  it("…and without the storage walk it still does not stop at fifty", () => {
    const { executor, tip } = harness(60, false);
    const key = (executor as unknown as { lineageRootTaskId(t: unknown): string }).lineageRootTaskId(tip);
    expect(key).toBe("task_0");
  });

  it("…and it asks the storage, which sees links the in-memory walk cannot", () => {
    // The parent walk can only follow rows it can still read. The storage's
    // own recursive walk is the authority on the lineage root.
    const executor = Object.create(BackgroundExecutor.prototype) as BackgroundExecutor;
    (executor as unknown as { taskManager: unknown }).taskManager = {
      // Every ancestor beyond the first link is unreadable from here.
      getStatus: () => null,
      findLineageRootId: () => "task_0",
    };
    const key = (executor as unknown as { lineageRootTaskId(t: unknown): string })
      .lineageRootTaskId({ id: "task_60", parentId: "task_59" });
    expect(key).toBe("task_0");
  });

  it("a short chain is unchanged", () => {
    const { executor, tip } = harness(3, false);
    expect((executor as unknown as { lineageRootTaskId(t: unknown): string }).lineageRootTaskId(tip)).toBe("task_0");
  });
});
