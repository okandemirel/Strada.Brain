import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
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

  it("treats blocked tasks as terminal for active queries", () => {
    const blockedTask = makeTask(TaskStatus.blocked);
    storage.save(blockedTask);

    const active = storage.listActiveByChatId(blockedTask.chatId);
    const incomplete = storage.loadIncomplete();

    expect(active.map((task) => task.id)).not.toContain(blockedTask.id);
    expect(incomplete.map((task) => task.id)).not.toContain(blockedTask.id);
  });

  it("bumps updatedAt when progress is added", async () => {
    const task = makeTask(TaskStatus.executing, { updatedAt: Date.now() - 10_000 });
    storage.save(task);

    const before = storage.load(task.id)!;
    storage.addProgress(task.id, "Running tools: file_read");
    const after = storage.load(task.id)!;

    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
    expect(after.progress.at(-1)?.message).toBe("Running tools: file_read");
  });

  it("migrates legacy task tables before saving new metadata fields", () => {
    const dbPath = join(tmpDir, "legacy-tasks.db");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        prompt TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        parent_id TEXT
      );
    `);
    legacyDb.close();

    const legacyStorage = new TaskStorage(dbPath);
    legacyStorage.initialize();

    const task = makeTask(TaskStatus.executing, {
      conversationId: "thread-7",
      userId: "user-42",
      origin: "daemon",
      triggerName: "nightly-scan",
    });
    legacyStorage.save(task);

    const loaded = legacyStorage.load(task.id);
    legacyStorage.close();

    expect(loaded).toEqual(expect.objectContaining({
      conversationId: "thread-7",
      userId: "user-42",
      origin: "daemon",
      triggerName: "nightly-scan",
    }));
  });
});
