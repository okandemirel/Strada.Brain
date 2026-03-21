import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgressReporter } from "./progress-reporter.js";
import { TaskStatus, type Task } from "./types.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

class MockTaskManager extends EventEmitter {
  private readonly tasks = new Map<string, Task>();

  getStatus(taskId: string): Task | null {
    return this.tasks.get(taskId) ?? null;
  }

  emitCreated(task: Task): void {
    this.tasks.set(task.id, task);
    this.emit("task:created", task);
  }

  emitProgress(taskId: string, message: string): void {
    this.emit("task:progress", taskId, message);
  }

  emitCompleted(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.result = result;
      task.status = TaskStatus.completed;
    }
    this.emit("task:completed", taskId, result);
  }

  emitFailed(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.error = error;
      task.status = TaskStatus.failed;
    }
    this.emit("task:failed", taskId, error);
  }

  emitCancelled(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = TaskStatus.cancelled;
    }
    this.emit("task:cancelled", taskId);
  }
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_heartbeat" as any,
    chatId: "chat-1",
    channelType: "cli",
    title: "Investigate the failing build and fix it",
    status: TaskStatus.executing,
    prompt: "Investigate the failing build and fix it",
    progress: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("ProgressReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the configured delay before sending a heartbeat, then repeats on the interval", async () => {
    const channel = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
      sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
    };
    const taskManager = new MockTaskManager();
    new ProgressReporter(channel as any, taskManager as any);

    taskManager.emitCreated(createTask());

    expect(channel.sendTypingIndicator).toHaveBeenCalledWith("chat-1");
    expect(channel.sendText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(119_999);
    expect(channel.sendText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(channel.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Still working on: Investigate the failing build and fix it",
    );

    await vi.advanceTimersByTimeAsync(300_000);
    expect(channel.sendText).toHaveBeenCalledTimes(2);
  });

  it("clears heartbeat timers once the task completes", async () => {
    const channel = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
      sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
    };
    const taskManager = new MockTaskManager();
    new ProgressReporter(channel as any, taskManager as any);

    taskManager.emitCreated(createTask());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(channel.sendText).toHaveBeenCalledTimes(1);

    taskManager.emitCompleted("task_heartbeat", "**Done**");
    expect(channel.sendMarkdown).toHaveBeenCalledWith("chat-1", "**Done**");

    await vi.advanceTimersByTimeAsync(300_000);
    expect(channel.sendText).toHaveBeenCalledTimes(1);
  });

  it("disables heartbeats when interaction mode is standard", async () => {
    const channel = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
      sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
    };
    const taskManager = new MockTaskManager();
    new ProgressReporter(channel as any, taskManager as any, {
      mode: "standard",
      heartbeatAfterMs: 1_000,
      heartbeatIntervalMs: 1_000,
      escalationPolicy: "standard",
    });

    taskManager.emitCreated(createTask());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(channel.sendText).not.toHaveBeenCalled();
  });
});
