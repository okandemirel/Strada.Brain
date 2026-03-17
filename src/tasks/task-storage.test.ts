import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStorage } from "./task-storage.js";
import { TaskStatus, type Task } from "./types.js";

function makeTask(status: TaskStatus, overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: `task_${Math.random().toString(16).slice(2, 10)}` as Task["id"],
    chatId: "chat-1",
    channelType: "cli",
    title: "Test task",
    status,
    prompt: "Test prompt",
    progress: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("TaskStorage", () => {
  let tmpDir: string;
  let storage: TaskStorage;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-storage-test-"));
    storage = new TaskStorage(join(tmpDir, "tasks.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes waiting_for_input tasks in active task queries", () => {
    const waitingTask = makeTask(TaskStatus.waiting_for_input);
    storage.save(waitingTask);

    const active = storage.listActiveByChatId(waitingTask.chatId);

    expect(active.map((task) => task.id)).toContain(waitingTask.id);
  });

  it("recovers waiting_for_input tasks as incomplete on startup", () => {
    const waitingTask = makeTask(TaskStatus.waiting_for_input);
    storage.save(waitingTask);

    const incomplete = storage.loadIncomplete();

    expect(incomplete.map((task) => task.id)).toContain(waitingTask.id);
  });
});
