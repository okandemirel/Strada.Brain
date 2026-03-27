import { beforeAll, describe, expect, it, vi } from "vitest";
import { TaskManager } from "./task-manager.js";
import { TaskStatus, type Task } from "./types.js";
import { createLogger } from "../utils/logger.js";

function buildTask(overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task_test123" as Task["id"],
    chatId: "chat-1",
    channelType: "cli",
    title: "test task",
    status: TaskStatus.executing,
    prompt: "test prompt",
    progress: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("TaskManager", () => {
  beforeAll(() => {
    try { createLogger("error", "/tmp/strada-task-manager-test.log"); } catch { /* already initialized */ }
  });

  it("fails active tasks during shutdown cleanup", () => {
    const activeTask = buildTask();
    const storage = {
      loadIncomplete: vi.fn().mockReturnValue([activeTask]),
      updateError: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);
    const failedListener = vi.fn();
    manager.on("task:failed", failedListener);

    manager.failActiveTasksOnShutdown("Shutdown cleanup.");

    expect(storage.loadIncomplete).toHaveBeenCalledOnce();
    expect(storage.updateError).toHaveBeenCalledWith(activeTask.id, "Shutdown cleanup.");
    expect(failedListener).toHaveBeenCalledWith(activeTask.id, "Shutdown cleanup.");
  });

  it("aborts tracked controllers while failing active tasks on shutdown", () => {
    const activeTask = buildTask({ id: "task_abort123" as Task["id"] });
    const storage = {
      loadIncomplete: vi.fn().mockReturnValue([activeTask]),
      updateError: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);
    const abort = vi.fn();

    (manager as any).abortControllers.set(activeTask.id, { abort });

    manager.failActiveTasksOnShutdown();

    expect(abort).toHaveBeenCalledOnce();
  });

  it("does not overwrite terminal task status during shutdown races", () => {
    const failedTask = buildTask({ status: TaskStatus.failed });
    const storage = {
      load: vi.fn().mockReturnValue(failedTask),
      updateStatus: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);

    manager.updateStatus(failedTask.id, TaskStatus.executing);

    expect(storage.updateStatus).not.toHaveBeenCalled();
  });

  it("strips provider reasoning artifacts before completing a task", () => {
    const storage = {
      updateResult: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);
    const completedListener = vi.fn();
    manager.on("task:completed", completedListener);

    manager.complete(
      "task_reasoning123" as Task["id"],
      "<reasoning>\ninternal\n</reasoning>\n\nVisible answer.",
    );

    expect(storage.updateResult).toHaveBeenCalledWith("task_reasoning123", "Visible answer.");
    expect(completedListener).toHaveBeenCalledWith("task_reasoning123", "Visible answer.");
  });

  it("counts only foreground tasks when agent-core asks for active user work", () => {
    const storage = {
      loadIncomplete: vi.fn().mockReturnValue([
        buildTask({ id: "task_user123" as Task["id"], chatId: "cli-local", channelType: "cli" }),
        buildTask({ id: "task_goal123" as Task["id"], chatId: "chat-2", channelType: "goal" }),
        buildTask({ id: "task_daemon123" as Task["id"], chatId: "daemon", channelType: "daemon" }),
        buildTask({ id: "task_agent123" as Task["id"], chatId: "agent-core", channelType: "daemon" }),
      ]),
    } as any;
    const manager = new TaskManager(storage, {} as any);

    expect(manager.countActiveForegroundTasks(["cli-local"])).toBe(1);
    expect(manager.hasActiveForegroundTasks(["cli-local"])).toBe(true);
  });

  it("stores the user-facing summary when structured progress is provided", () => {
    const storage = {
      addProgress: vi.fn(),
    } as any;
    const manager = new TaskManager(storage, {} as any);

    manager.addProgress("task_progress123" as Task["id"], {
      kind: "verification",
      message: "Verification required before completion",
      userSummary: "Aşama: doğrulama. Son aksiyon: son değişiklikleri build ve kalite kontrollerine soktum. Sıradaki adım: çıkan sinyalleri teyit edip sonucu paylaşacağım.",
    });

    expect(storage.addProgress).toHaveBeenCalledWith(
      "task_progress123",
      "Aşama: doğrulama. Son aksiyon: son değişiklikleri build ve kalite kontrollerine soktum. Sıradaki adım: çıkan sinyalleri teyit edip sonucu paylaşacağım.",
    );
  });
});
