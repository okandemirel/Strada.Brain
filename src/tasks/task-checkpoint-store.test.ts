/**
 * Task Checkpoint Store — multi-user isolation tests.
 *
 * Focus: CWE-639 (insecure direct object reference). Shared channels
 * (web, Slack, Discord) can host multiple users; a checkpoint persisted by
 * user A must not be resumable by user B via `/retry` / `/continue` or
 * implicit intent-based recovery. Legacy rows (pre-migration, `user_id IS
 * NULL`) stay reachable through the chatId-only path for back-compat.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import {
  TaskCheckpointStore,
  type PendingTaskCheckpoint,
} from "./task-checkpoint-store.js";

function makeCheckpoint(
  overrides: Partial<PendingTaskCheckpoint> = {},
): PendingTaskCheckpoint {
  return {
    taskId: `task_${Math.random().toString(16).slice(2, 10)}`,
    chatId: "chat-1",
    timestamp: Date.now(),
    stage: "budget_exceeded",
    lastUserMessage: "please finish the task",
    touchedFiles: [],
    ...overrides,
  };
}

describe("TaskCheckpointStore — multi-user isolation", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: TaskCheckpointStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "task-checkpoint-test-"));
    dbPath = join(tmpDir, "task-checkpoints.db");
    store = new TaskCheckpointStore(dbPath);
    store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("legacy save/load without userId persists NULL user_id and is retrievable", async () => {
    const cp = makeCheckpoint({ taskId: "task-legacy" });
    await store.save(cp);

    const loaded = await store.loadLatest(cp.chatId);
    expect(loaded).not.toBeNull();
    expect(loaded?.taskId).toBe("task-legacy");
    expect(loaded?.userId).toBeUndefined();

    // Verify the column really is NULL at the SQL layer.
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT user_id FROM task_checkpoints WHERE task_id = ?")
        .get("task-legacy") as { user_id: string | null } | undefined;
      expect(row).toBeDefined();
      expect(row?.user_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it("save(userId=A) + loadLatest(chatId) without userId still returns the row (back-compat)", async () => {
    const cp = makeCheckpoint({ taskId: "task-a", userId: "user-A" });
    await store.save(cp);

    const loaded = await store.loadLatest(cp.chatId); // chatId-only scope
    expect(loaded).not.toBeNull();
    expect(loaded?.taskId).toBe("task-a");
    expect(loaded?.userId).toBe("user-A");
  });

  it("save(userId=A) + loadLatest(chatId, A) returns match", async () => {
    const cp = makeCheckpoint({ taskId: "task-a", userId: "user-A" });
    await store.save(cp);

    const loaded = await store.loadLatest(cp.chatId, "user-A");
    expect(loaded).not.toBeNull();
    expect(loaded?.taskId).toBe("task-a");
    expect(loaded?.userId).toBe("user-A");
  });

  it("save(userId=A) + loadLatest(chatId, B) falls back to NULL-userId legacy rows only", async () => {
    // Persist A's checkpoint first, then a legacy (NULL userId) row with an
    // OLDER timestamp. The OR-NULL fallback should surface the legacy row
    // to user B, but A's newer strict-user row must NOT leak cross-user.
    const aNow = Date.now();
    await store.save(
      makeCheckpoint({ taskId: "task-a", userId: "user-A", timestamp: aNow }),
    );
    await store.save(
      makeCheckpoint({ taskId: "task-legacy", timestamp: aNow - 1_000 }),
    );

    const loaded = await store.loadLatest("chat-1", "user-B");
    expect(loaded).not.toBeNull();
    expect(loaded?.taskId).toBe("task-legacy");
    expect(loaded?.userId).toBeUndefined();
  });

  it("save(userId=A) + loadLatestForUser(chatId, B) returns null (strict isolation, CWE-639)", async () => {
    const cp = makeCheckpoint({ taskId: "task-a", userId: "user-A" });
    await store.save(cp);

    const leaked = await store.loadLatestForUser("chat-1", "user-B");
    expect(leaked).toBeNull();
  });

  it("save(A) + save(B) in shared chat: loadLatestForUser returns only the caller's checkpoint", async () => {
    const now = Date.now();
    await store.save(
      makeCheckpoint({
        taskId: "task-a",
        chatId: "chat-shared",
        userId: "user-A",
        timestamp: now,
      }),
    );
    await store.save(
      makeCheckpoint({
        taskId: "task-b",
        chatId: "chat-shared",
        userId: "user-B",
        timestamp: now + 1_000, // B is newer — ensures we're not just picking the latest.
      }),
    );

    const aLoaded = await store.loadLatestForUser("chat-shared", "user-A");
    expect(aLoaded?.taskId).toBe("task-a");
    expect(aLoaded?.userId).toBe("user-A");

    const bLoaded = await store.loadLatestForUser("chat-shared", "user-B");
    expect(bLoaded?.taskId).toBe("task-b");
    expect(bLoaded?.userId).toBe("user-B");

    // And strict lookups with a third, unknown user find nothing.
    const cLoaded = await store.loadLatestForUser("chat-shared", "user-C");
    expect(cLoaded).toBeNull();
  });

  it("loadLatestForUser rejects empty-string userId (defensive input check)", async () => {
    await store.save(
      makeCheckpoint({ taskId: "task-a", userId: "user-A" }),
    );
    const empty = await store.loadLatestForUser("chat-1", "");
    expect(empty).toBeNull();
  });

  it("listRecent(chatId, limit, userId) OR-filters to caller + legacy rows", async () => {
    const base = Date.now();
    await store.save(
      makeCheckpoint({ taskId: "task-a", userId: "user-A", timestamp: base }),
    );
    await store.save(
      makeCheckpoint({ taskId: "task-b", userId: "user-B", timestamp: base + 1 }),
    );
    await store.save(
      makeCheckpoint({ taskId: "task-legacy", timestamp: base + 2 }),
    );

    const forA = await store.listRecent("chat-1", 10, "user-A");
    const ids = forA.map((cp) => cp.taskId).sort();
    expect(ids).toContain("task-a");
    expect(ids).toContain("task-legacy");
    expect(ids).not.toContain("task-b");
  });

  it("migrate() is idempotent: second initialize on same path keeps user_id column", async () => {
    // First instance already ran initialize() in beforeEach. Close it and
    // reopen to force a second migrate() pass on an already-migrated db.
    store.close();

    const second = new TaskCheckpointStore(dbPath);
    expect(() => second.initialize()).not.toThrow();

    // Column must exist and a round-trip must work.
    await expect(
      second.save(makeCheckpoint({ taskId: "task-after-remigrate", userId: "user-A" })),
    ).resolves.toBeUndefined();

    const db = new Database(dbPath, { readonly: true });
    try {
      const columns = db
        .prepare("PRAGMA table_info(task_checkpoints)")
        .all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toContain("user_id");
    } finally {
      db.close();
    }

    second.close();

    // Rebind `store` so afterEach's close() is a no-op on a closed db.
    store = new TaskCheckpointStore(dbPath);
    store.initialize();
  });

  it("legacy NULL-userId rows are surfaced by chatId-only loadLatest and hidden from strict loadLatestForUser", async () => {
    // Simulates a pre-migration row: a checkpoint persisted before
    // multi-user isolation landed (user_id IS NULL). `loadLatest(chatId)`
    // must still find it (back-compat), but `loadLatestForUser(chatId,
    // userId)` must refuse to surface it so a foreign user in a shared
    // channel cannot resume a legacy session they never owned.
    const legacyId = "legacy-null-userid-row";
    await store.save(
      makeCheckpoint({ taskId: legacyId, timestamp: Date.now() - 5_000 }),
    );

    const legacyLoaded = await store.loadLatest("chat-1");
    expect(legacyLoaded?.taskId).toBe(legacyId);
    expect(legacyLoaded?.userId).toBeUndefined();

    const strictLoaded = await store.loadLatestForUser("chat-1", "user-A");
    expect(strictLoaded).toBeNull();
  });

  it("concurrent save() for same taskId — later write wins via ON CONFLICT", async () => {
    const now = Date.now();
    const early = makeCheckpoint({ taskId: "task-concurrent", timestamp: now });
    const late = makeCheckpoint({
      taskId: "task-concurrent",
      timestamp: now + 500,
      stage: "manual_pause",
    });
    await Promise.all([store.save(early), store.save(late)]);
    const loaded = await store.loadByTaskId("task-concurrent");
    expect(loaded).not.toBeNull();
    expect(loaded?.taskId).toBe("task-concurrent");
    // ON CONFLICT DO UPDATE: last write wins.
    expect(loaded?.stage).toBe("manual_pause");
    expect(loaded?.timestamp).toBe(now + 500);
  });
});
