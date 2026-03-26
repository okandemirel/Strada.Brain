import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgressReporter } from "./progress-reporter.js";
import { TaskStatus, type Task, type TaskProgressUpdate } from "./types.js";

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

  emitProgress(taskId: string, message: TaskProgressUpdate): void {
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

  emitBlocked(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.result = result;
      task.status = TaskStatus.blocked;
    }
    this.emit("task:blocked", taskId, result);
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

  it("opens the initial live status after the shorter phase-driven heartbeat window", async () => {
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

    await vi.advanceTimersByTimeAsync(19_999);
    expect(channel.sendText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(channel.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Stage: working. Last action: I'm moving through \"Investigate the failing build and fix it\". Next: I'll share the verified result once it is ready.",
    );

    await vi.advanceTimersByTimeAsync(300_000);
    expect(channel.sendText).toHaveBeenCalledTimes(1);
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
    await vi.advanceTimersByTimeAsync(20_000);
    expect(channel.sendText).toHaveBeenCalledTimes(1);

    taskManager.emitCompleted("task_heartbeat", "**Done**");
    expect(channel.sendMarkdown).toHaveBeenCalledWith("chat-1", "**Done**");

    await vi.advanceTimersByTimeAsync(300_000);
    expect(channel.sendText).toHaveBeenCalledTimes(1);
  });

  it("updates a streaming status message in place and finalizes it on blocked", async () => {
    const channel = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
      sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
      startStreamingMessage: vi.fn().mockResolvedValue("stream-1"),
      updateStreamingMessage: vi.fn().mockResolvedValue(undefined),
      finalizeStreamingMessage: vi.fn().mockResolvedValue(undefined),
    };
    const taskManager = new MockTaskManager();
    new ProgressReporter(channel as any, taskManager as any, undefined, "tr");

    taskManager.emitCreated(createTask({
      title: "console üzerinden errorlere bak ve çöz",
      prompt: "console üzerinden errorlere bak ve çöz",
    }));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(channel.startStreamingMessage).toHaveBeenCalledWith("chat-1");
    expect(channel.updateStreamingMessage).toHaveBeenCalledWith(
      "chat-1",
      "stream-1",
      "Aşama: çalışma. Son aksiyon: \"console üzerinden errorlere bak ve çöz\" üzerinde ilerliyorum. Sıradaki adım: doğruladığım sonucu paylaşacağım.",
    );

    taskManager.emitProgress("task_heartbeat", {
      kind: "editing",
      message: "Running tools: file_edit",
      files: ["Assets/Game/UnityAdsService.cs", "Assets/Game/GameController.cs"],
    });
    await vi.advanceTimersByTimeAsync(8_000);

    expect(channel.updateStreamingMessage).toHaveBeenCalledWith(
      "chat-1",
      "stream-1",
      "Aşama: düzenleme. Son aksiyon: UnityAdsService.cs ve GameController.cs üzerinde düzeltme uyguluyorum. Sıradaki adım: değişiklikleri hemen doğrulayacağım.",
    );

    taskManager.emitBlocked("task_heartbeat", "Blocked checkpoint");
    expect(channel.finalizeStreamingMessage).toHaveBeenCalledWith("chat-1", "stream-1", "");
    expect(channel.sendMarkdown).toHaveBeenCalledWith("chat-1", "Blocked checkpoint");
  });

  it("opens a live status early once meaningful progress arrives", async () => {
    const channel = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
      sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
      startStreamingMessage: vi.fn().mockResolvedValue("stream-1"),
      updateStreamingMessage: vi.fn().mockResolvedValue(undefined),
      finalizeStreamingMessage: vi.fn().mockResolvedValue(undefined),
    };
    const taskManager = new MockTaskManager();
    new ProgressReporter(channel as any, taskManager as any, undefined, "en");

    taskManager.emitCreated(createTask());
    taskManager.emitProgress("task_heartbeat", {
      kind: "analysis",
      message: "Inspecting files",
      userSummary: "Strada agent: inspecting the project state and surrounding evidence.",
    });

    await vi.advanceTimersByTimeAsync(1_499);
    expect(channel.startStreamingMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(channel.startStreamingMessage).toHaveBeenCalledWith("chat-1");
    expect(channel.updateStreamingMessage).toHaveBeenCalledWith(
      "chat-1",
      "stream-1",
      "Strada agent: inspecting the project state and surrounding evidence.",
    );
  });

  it("surfaces a kickoff summary shortly after execution starts", async () => {
    const channel = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
      sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
      startStreamingMessage: vi.fn().mockResolvedValue("stream-1"),
      updateStreamingMessage: vi.fn().mockResolvedValue(undefined),
      finalizeStreamingMessage: vi.fn().mockResolvedValue(undefined),
    };
    const taskManager = new MockTaskManager();
    new ProgressReporter(channel as any, taskManager as any, undefined, "en");

    taskManager.emitCreated(createTask());
    taskManager.emitProgress("task_heartbeat", {
      kind: "analysis",
      message: "Task started",
      userSummary: "Stage: inspection. Last action: I started a quick first pass over the relevant evidence. Next: I'll line up the first concrete intervention point.",
    });

    await vi.advanceTimersByTimeAsync(1_499);
    expect(channel.startStreamingMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(channel.startStreamingMessage).toHaveBeenCalledWith("chat-1");
    expect(channel.updateStreamingMessage).toHaveBeenCalledWith(
      "chat-1",
      "stream-1",
      "Stage: inspection. Last action: I started a quick first pass over the relevant evidence. Next: I'll line up the first concrete intervention point.",
    );
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
