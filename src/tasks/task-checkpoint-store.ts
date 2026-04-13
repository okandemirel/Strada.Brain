/**
 * Task Checkpoint Store
 *
 * Persistent SQLite-backed snapshots of in-flight task context that
 * allow the orchestrator to resume after a token budget exceedance,
 * provider failure, or manual pause.
 *
 * Schema intentionally flat: one row per task, full payload JSON-encoded.
 * Follows the same pragma / prepared-statement pattern as {@link TaskStorage}.
 *
 * Multi-user isolation: `user_id` is persisted as a top-level column so
 * checkpoints written by user A in a shared channel cannot be resumed by
 * user B via `/retry` / `/continue` or implicit recovery intents (CWE-639).
 * Legacy rows (pre-migration) carry `user_id IS NULL` and remain accessible
 * through the chatId-only `loadLatest` / `listRecent` paths for back-compat.
 */

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import { configureSqlitePragmas } from "../memory/unified/sqlite-pragmas.js";

// Types

export type CheckpointStage =
  | "budget_exceeded"
  | "provider_failed"
  | "manual_pause";

export interface PendingTaskCheckpoint {
  taskId: string;
  chatId: string;
  /**
   * Per-user isolation key. Optional for back-compat with checkpoints
   * written before the multi-user isolation migration — rows persisted with
   * `user_id IS NULL` remain readable via {@link TaskCheckpointStore.loadLatest}
   * but are filtered out of strict {@link TaskCheckpointStore.loadLatestForUser}
   * lookups to prevent cross-user resume in shared channels (CWE-639).
   */
  userId?: string;
  timestamp: number;
  stage: CheckpointStage;
  lastUserMessage: string;
  lastToolCall?: {
    toolName: string;
    args: Record<string, unknown>;
    error?: string;
  };
  touchedFiles: string[];
  budgetState?: {
    used: number;
    budget: number;
  };
  inferredIntent?: string;
}

interface CheckpointRow {
  task_id: string;
  chat_id: string;
  user_id: string | null;
  timestamp: number;
  stage: string;
  payload: string;
}

// Schema
//
// `user_id` is included in the initial CREATE for fresh databases. For
// databases created before the multi-user isolation migration, the column
// is added idempotently in {@link TaskCheckpointStore.migrate} using
// PRAGMA table_info + ALTER TABLE (mirroring the task-storage migration
// pattern). Legacy rows with user_id IS NULL remain readable.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_checkpoints (
  task_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  stage TEXT NOT NULL,
  payload TEXT NOT NULL,
  user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_chat_ts
  ON task_checkpoints(chat_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoints_chat_user_ts
  ON task_checkpoints(chat_id, user_id, timestamp DESC);
`;

// Store

export class TaskCheckpointStore {
  private db: Database.Database | null = null;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly dbPath: string;

  constructor(dbPath: string = "./data/task-checkpoints.db") {
    this.dbPath = dbPath;
  }

  initialize(): void {
    const dir = dirname(this.dbPath);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(this.dbPath);
    configureSqlitePragmas(this.db, "tasks");
    this.db.exec(SCHEMA_SQL);
    this.migrate();
    this.prepareStatements();
  }

  close(): void {
    this.statements.clear();
    this.db?.close();
    this.db = null;
  }

  /**
   * Idempotent schema migration. Adds the `user_id` column and the composite
   * (chat_id, user_id, timestamp) index to pre-existing databases that were
   * created before multi-user checkpoint isolation landed. Safe to run on
   * every startup — detects existing columns/indexes via PRAGMA before
   * issuing ALTER TABLE.
   *
   * Back-compat: legacy rows keep `user_id = NULL` and remain accessible via
   * the chatId-only `loadLatest` / `listRecent` paths. Strict-isolation
   * callers (`loadLatestForUser`) ignore NULL-userId rows so a shared-chat
   * user B cannot resume user A's pending task.
   */
  private migrate(): void {
    if (!this.db) return;
    const columns = this.db
      .prepare("PRAGMA table_info(task_checkpoints)")
      .all() as Array<{ name: string }>;
    const known = new Set(columns.map((c) => c.name));
    if (!known.has("user_id")) {
      this.db.exec("ALTER TABLE task_checkpoints ADD COLUMN user_id TEXT");
    }
    // Composite index creation is IF NOT EXISTS and cheap — safe to always run.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_checkpoints_chat_user_ts ON task_checkpoints(chat_id, user_id, timestamp DESC)",
    );
  }

  async save(cp: PendingTaskCheckpoint): Promise<void> {
    this.ensureConnection();
    // Defensive clamping: incoming callers (orchestrator, command-handler)
    // may pass unbounded user input or file lists. Without limits, a large
    // message or file-tree blast could balloon the SQLite row and act as a
    // DoS/PII amplifier (full user prompts persisted forever).
    const clamped: PendingTaskCheckpoint = {
      ...cp,
      lastUserMessage:
        typeof cp.lastUserMessage === "string"
          ? cp.lastUserMessage.slice(0, TaskCheckpointStore.MAX_USER_MESSAGE_CHARS)
          : "",
      touchedFiles: Array.isArray(cp.touchedFiles)
        ? cp.touchedFiles.slice(0, TaskCheckpointStore.MAX_TOUCHED_FILES)
        : [],
      inferredIntent:
        typeof cp.inferredIntent === "string"
          ? cp.inferredIntent.slice(0, TaskCheckpointStore.MAX_INTENT_CHARS)
          : cp.inferredIntent,
    };
    const payload = JSON.stringify(clamped);
    // Persist userId as a dedicated column (nullable for back-compat). When
    // absent, NULL is stored so legacy chatId-only paths still read the row.
    const userIdCol = typeof cp.userId === "string" && cp.userId.length > 0 ? cp.userId : null;
    this.getStmt("upsert").run(
      cp.taskId,
      cp.chatId,
      cp.timestamp,
      cp.stage,
      payload,
      userIdCol,
    );
  }

  // Defensive bounds for checkpoint payload fields. Balanced to preserve
  // enough context for resume while capping DB growth + PII footprint.
  private static readonly MAX_USER_MESSAGE_CHARS = 8_000;
  private static readonly MAX_TOUCHED_FILES = 200;
  private static readonly MAX_INTENT_CHARS = 2_000;

  /**
   * Return the most recent checkpoint for a chat, optionally scoped to the
   * calling user. When `userId` is provided the query matches rows where
   * `user_id = ?` OR `user_id IS NULL` — this keeps legacy (pre-migration)
   * checkpoints reachable for back-compat while ensuring any new checkpoint
   * written by a different user in the same multi-user chat is ignored.
   * When `userId` is omitted the behaviour is unchanged (chatId-only scope).
   *
   * For strict single-user isolation (no legacy fallback) use
   * {@link loadLatestForUser}.
   */
  async loadLatest(chatId: string, userId?: string): Promise<PendingTaskCheckpoint | null> {
    this.ensureConnection();
    const row =
      typeof userId === "string" && userId.length > 0
        ? (this.getStmt("loadLatestByChatAndUserOrLegacy").get(chatId, userId) as
            | CheckpointRow
            | undefined)
        : (this.getStmt("loadLatestByChat").get(chatId) as CheckpointRow | undefined);
    return row ? this.rowToCheckpoint(row) : null;
  }

  /**
   * Strict per-user checkpoint lookup. Matches `chat_id = ? AND user_id = ?`
   * only — legacy NULL-userId rows are intentionally excluded so a user in a
   * shared channel cannot resume a checkpoint that predates the isolation
   * migration (CWE-639). Callers that still need to surface legacy data
   * should use {@link loadLatest} instead.
   */
  async loadLatestForUser(
    chatId: string,
    userId: string,
  ): Promise<PendingTaskCheckpoint | null> {
    this.ensureConnection();
    if (typeof userId !== "string" || userId.length === 0) return null;
    const row = this.getStmt("loadLatestByChatAndUserStrict").get(chatId, userId) as
      | CheckpointRow
      | undefined;
    return row ? this.rowToCheckpoint(row) : null;
  }

  async loadByTaskId(taskId: string): Promise<PendingTaskCheckpoint | null> {
    this.ensureConnection();
    const row = this.getStmt("loadByTaskId").get(taskId) as CheckpointRow | undefined;
    return row ? this.rowToCheckpoint(row) : null;
  }

  async clear(taskId: string): Promise<void> {
    this.ensureConnection();
    this.getStmt("clear").run(taskId);
  }

  async listRecent(
    chatId: string,
    limit: number = 10,
    userId?: string,
  ): Promise<PendingTaskCheckpoint[]> {
    this.ensureConnection();
    const rows =
      typeof userId === "string" && userId.length > 0
        ? (this.getStmt("listRecentByChatAndUserOrLegacy").all(
            chatId,
            userId,
            limit,
          ) as CheckpointRow[])
        : (this.getStmt("listRecent").all(chatId, limit) as CheckpointRow[]);
    return rows
      .map((row) => this.rowToCheckpoint(row))
      .filter((cp): cp is PendingTaskCheckpoint => cp !== null);
  }

  // Private

  private ensureConnection(): void {
    if (!this.db) {
      throw new Error("TaskCheckpointStore not initialized. Call initialize() first.");
    }
  }

  private getStmt(name: string): Database.Statement {
    const stmt = this.statements.get(name);
    if (!stmt) throw new Error(`Statement not found: ${name}`);
    return stmt;
  }

  private prepareStatements(): void {
    if (!this.db) return;

    const stmts: Record<string, string> = {
      upsert: `
        INSERT INTO task_checkpoints (task_id, chat_id, timestamp, stage, payload, user_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          chat_id = excluded.chat_id,
          timestamp = excluded.timestamp,
          stage = excluded.stage,
          payload = excluded.payload,
          user_id = excluded.user_id
      `,
      loadLatestByChat: `
        SELECT * FROM task_checkpoints
        WHERE chat_id = ?
        ORDER BY timestamp DESC
        LIMIT 1
      `,
      // Scoped-with-legacy-fallback variant. Matches the caller's userId OR
      // rows written before the migration (NULL user_id). Used by the
      // non-strict `loadLatest(chatId, userId)` path so back-compat replays
      // still work in single-user channels that upgraded mid-session.
      loadLatestByChatAndUserOrLegacy: `
        SELECT * FROM task_checkpoints
        WHERE chat_id = ? AND (user_id = ? OR user_id IS NULL)
        ORDER BY timestamp DESC
        LIMIT 1
      `,
      // Strict per-user variant. Legacy NULL rows are excluded so a
      // multi-user channel cannot cross-resume a foreign session.
      loadLatestByChatAndUserStrict: `
        SELECT * FROM task_checkpoints
        WHERE chat_id = ? AND user_id = ?
        ORDER BY timestamp DESC
        LIMIT 1
      `,
      loadByTaskId: `SELECT * FROM task_checkpoints WHERE task_id = ?`,
      listRecent: `
        SELECT * FROM task_checkpoints
        WHERE chat_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `,
      listRecentByChatAndUserOrLegacy: `
        SELECT * FROM task_checkpoints
        WHERE chat_id = ? AND (user_id = ? OR user_id IS NULL)
        ORDER BY timestamp DESC
        LIMIT ?
      `,
      clear: `DELETE FROM task_checkpoints WHERE task_id = ?`,
    };

    for (const [name, sql] of Object.entries(stmts)) {
      this.statements.set(name, this.db.prepare(sql));
    }
  }

  private rowToCheckpoint(row: CheckpointRow): PendingTaskCheckpoint | null {
    try {
      const parsed = JSON.parse(row.payload) as PendingTaskCheckpoint;
      if (!parsed || typeof parsed !== "object") return null;
      // Prefer the dedicated user_id column (source of truth for isolation).
      // Fall back to the payload's userId if the column is NULL (legacy row
      // written by a migration-aware save() but with userId only in JSON).
      const resolvedUserId =
        typeof row.user_id === "string" && row.user_id.length > 0
          ? row.user_id
          : typeof parsed.userId === "string" && parsed.userId.length > 0
            ? parsed.userId
            : undefined;
      return {
        ...parsed,
        taskId: row.task_id,
        chatId: row.chat_id,
        userId: resolvedUserId,
        timestamp: row.timestamp,
        stage: (parsed.stage ?? (row.stage as CheckpointStage)),
        touchedFiles: Array.isArray(parsed.touchedFiles) ? parsed.touchedFiles : [],
      };
    } catch {
      return null;
    }
  }
}
