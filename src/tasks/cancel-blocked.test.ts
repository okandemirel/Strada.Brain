import { describe, expect, it, vi } from "vitest";
import { TaskManager } from "./task-manager.js";
import { TaskStatus } from "./types.js";
import { createLogger } from "../utils/logger.js";

createLogger("error", "/tmp/strada-cancel-blocked-test.log");

/**
 * Measured live 2026-09-03: a delivered campaign's sweep logged 33
 * cancellations while the database recorded 9, and its sprint work came back
 * seven times — because every straggler was BLOCKED, and cancel() only
 * accepted active tasks. A blocked task is parked, not finished: a
 * continuation is waiting to revive it, and cancelling is how a deliberate
 * stop is expressed.
 */
describe("cancelling a parked task", () => {
  function managerWith(status: TaskStatus) {
    const task = { id: "task_1", status, chatId: "c", channelType: "cli" };
    const updates: Array<{ id: string; status: string }> = [];
    const manager = Object.create(TaskManager.prototype) as TaskManager;
    (manager as unknown as { storage: unknown }).storage = {
      load: () => task,
      updateStatus: (id: string, s: string) => { updates.push({ id, status: s }); task.status = s as TaskStatus; },
    };
    (manager as unknown as { abortControllers: Map<string, AbortController> }).abortControllers = new Map();
    (manager as unknown as { emit: unknown }).emit = vi.fn();
    return { manager, updates };
  }

  it("cancels a BLOCKED task so its continuations stop", () => {
    const { manager, updates } = managerWith(TaskStatus.blocked);
    expect(manager.cancel("task_1" as never)).toBe(true);
    expect(updates).toEqual([{ id: "task_1", status: TaskStatus.cancelled }]);
  });

  it("still refuses a task that already finished", () => {
    for (const status of [TaskStatus.completed, TaskStatus.failed, TaskStatus.cancelled]) {
      const { manager, updates } = managerWith(status);
      expect(manager.cancel("task_1" as never)).toBe(false);
      expect(updates).toHaveLength(0);
    }
  });
});
