import { beforeAll, describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "./bootstrap-wiring.js";
import { createLogger } from "../utils/logger.js";
import { TaskStatus, type Task } from "../tasks/types.js";

function buildTask(overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task_shutdown123" as Task["id"],
    chatId: "chat-1",
    channelType: "cli",
    title: "shutdown task",
    status: TaskStatus.executing,
    prompt: "test prompt",
    progress: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("createShutdownHandler", () => {
  beforeAll(() => {
    try { createLogger("error", "/tmp/strada-bootstrap-wiring-test.log"); } catch { /* already initialized */ }
  });

  it("persists active task failures before closing storage", async () => {
    const activeTask = buildTask();
    const taskManager = {
      failActiveTasksOnShutdown: vi.fn(),
    } as any;
    const taskStorage = {
      loadIncomplete: vi.fn().mockReturnValue([activeTask]),
      updateError: vi.fn(),
      close: vi.fn(),
    } as any;

    const shutdown = createShutdownHandler({
      channel: { disconnect: vi.fn(async () => {}) } as any,
      cleanupInterval: setInterval(() => {}, 1000),
      taskManager,
      taskStorage,
    });

    await shutdown();

    expect(taskManager.failActiveTasksOnShutdown).toHaveBeenCalledWith(
      "Task interrupted by system shutdown. Resume is available after restart.",
    );
    expect(taskStorage.updateError).not.toHaveBeenCalled();
    expect(taskStorage.close).toHaveBeenCalledOnce();
  });
});
