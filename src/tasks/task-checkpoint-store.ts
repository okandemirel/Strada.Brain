/**
 * Task Checkpoint Store
 *
 * Persistent SQLite-backed snapshots of in-flight task context that
 * allow the orchestrator to resume after a token budget exceedance,
 * provider failure, or manual pause.
 *
 * Schema intentionally flat: one row per task, full payload JSON-encoded.
 * Follows the same pragma / prepared-statement pattern as {@link TaskStorage}.
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
  timestamp: number;
  stage: string;
  payload: string;
}

// Schema

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_checkpoints (
  task_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  stage TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_chat_ts
  ON task_checkpoints(chat_id, timestamp DESC);
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
    this.prepareStatements();
  }

  close(): void {
    this.statements.clear();
    this.db?.close();
    this.db = null;
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
    this.getStmt("upsert").run(cp.taskId, cp.chatId, cp.timestamp, cp.stage, payload);
  }

  // Defensive bounds for checkpoint payload fields. Balanced to preserve
  // enough context for resume while capping DB growth + PII footprint.
  private static readonly MAX_USER_MESSAGE_CHARS = 8_000;
  private static readonly MAX_TOUCHED_FILES = 200;
  private static readonly MAX_INTENT_CHARS = 2_000;

  async loadLatest(chatId: string): Promise<PendingTaskCheckpoint | null> {
    this.ensureConnection();
    const row = this.getStmt("loadLatestByChat").get(chatId) as CheckpointRow | undefined;
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

  async listRecent(chatId: string, limit: number = 10): Promise<PendingTaskCheckpoint[]> {
    this.ensureConnection();
    const rows = this.getStmt("listRecent").all(chatId, limit) as CheckpointRow[];
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
        INSERT INTO task_checkpoints (task_id, chat_id, timestamp, stage, payload)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          chat_id = excluded.chat_id,
          timestamp = excluded.timestamp,
          stage = excluded.stage,
          payload = excluded.payload
      `,
      loadLatestByChat: `
        SELECT * FROM task_checkpoints
        WHERE chat_id = ?
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
      return {
        ...parsed,
        taskId: row.task_id,
        chatId: row.chat_id,
        timestamp: row.timestamp,
        stage: (parsed.stage ?? (row.stage as CheckpointStage)),
        touchedFiles: Array.isArray(parsed.touchedFiles) ? parsed.touchedFiles : [],
      };
    } catch {
      return null;
    }
  }
}
