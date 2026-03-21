/**
 * Task Storage
 *
 * SQLite-based persistent storage for the task system.
 * Follows the existing LearningStorage pattern with WAL mode
 * and prepared statement caching.
 */

import Database from "better-sqlite3";
import { configureSqlitePragmas } from "../memory/unified/sqlite-pragmas.js";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Task, TaskId, ProgressEntry } from "./types.js";
import { TaskStatus } from "./types.js";

// ─── Schema ──────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
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
  parent_id TEXT,
  FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS task_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  message TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_chat_status ON tasks(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_progress_task ON task_progress(task_id, timestamp ASC);
`;

// ─── Row Types ───────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  chat_id: string;
  channel_type: string;
  title: string;
  status: string;
  prompt: string;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  parent_id: string | null;
}

interface ProgressRow {
  id: number;
  task_id: string;
  timestamp: number;
  message: string;
}

// ─── Storage Class ───────────────────────────────────────────────────────────────

export class TaskStorage {
  private db: Database.Database | null = null;
  private statements: Map<string, Database.Statement> = new Map();

  constructor(private readonly dbPath: string = "./data/tasks.db") {}

  initialize(): void {
    const dir = dirname(this.dbPath);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    // Standardized pragma configuration (8MB cache, 5s busy_timeout)
    configureSqlitePragmas(this.db, "tasks");
    this.db.exec(SCHEMA_SQL);
    this.prepareStatements();
  }

  close(): void {
    this.statements.clear();
    this.db?.close();
    this.db = null;
  }

  // ─── Task CRUD ──────────────────────────────────────────────────────────────

  save(task: Task): void {
    this.ensureConnection();
    this.getStmt("insertTask").run(
      task.id,
      task.chatId,
      task.channelType,
      task.title,
      task.status,
      task.prompt,
      task.result ?? null,
      task.error ?? null,
      task.createdAt,
      task.updatedAt,
      task.completedAt ?? null,
      task.parentId ?? null,
    );
  }

  load(id: TaskId): Task | null {
    this.ensureConnection();
    const row = this.getStmt("getTask").get(id) as TaskRow | undefined;
    if (!row) return null;
    const progress = this.getProgress(row.id);
    return this.rowToTask(row, progress);
  }

  updateStatus(id: TaskId, status: TaskStatus): void {
    this.ensureConnection();
    this.getStmt("updateStatus").run(status, Date.now(), id);
  }

  updateResult(id: TaskId, result: string): void {
    this.ensureConnection();
    this.getStmt("updateResult").run(result, TaskStatus.completed, Date.now(), Date.now(), id);
  }

  updateError(id: TaskId, error: string): void {
    this.ensureConnection();
    this.getStmt("updateError").run(error, TaskStatus.failed, Date.now(), Date.now(), id);
  }

  updateBlocked(id: TaskId, result: string): void {
    this.ensureConnection();
    this.getStmt("updateBlocked").run(result, TaskStatus.blocked, Date.now(), Date.now(), id);
  }

  addProgress(id: TaskId, message: string): void {
    this.ensureConnection();
    const now = Date.now();
    this.getStmt("insertProgress").run(id, now, message);
    this.getStmt("touchTask").run(now, id);
  }

  // ─── Queries ────────────────────────────────────────────────────────────────

  listByChatId(chatId: string, limit = 10): Task[] {
    this.ensureConnection();
    const rows = this.getStmt("listByChatId").all(chatId, limit) as TaskRow[];
    return rows.map((r) => this.rowToTask(r, this.getProgress(r.id)));
  }

  listActiveByChatId(chatId: string): Task[] {
    this.ensureConnection();
    const rows = this.getStmt("listActiveByChatId").all(chatId) as TaskRow[];
    return rows.map((r) => this.rowToTask(r, this.getProgress(r.id)));
  }

  loadIncomplete(): Task[] {
    this.ensureConnection();
    const rows = this.getStmt("loadIncomplete").all() as TaskRow[];
    return rows.map((r) => this.rowToTask(r, this.getProgress(r.id)));
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private getProgress(taskId: string): ProgressEntry[] {
    const rows = this.getStmt("getProgress").all(taskId) as ProgressRow[];
    return rows.map((r) => ({ timestamp: r.timestamp, message: r.message }));
  }

  private rowToTask(row: TaskRow, progress: ProgressEntry[]): Task {
    return {
      id: row.id as TaskId,
      chatId: row.chat_id,
      channelType: row.channel_type,
      title: row.title,
      status: row.status as TaskStatus,
      prompt: row.prompt,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      progress,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
      parentId: row.parent_id ? (row.parent_id as TaskId) : undefined,
    };
  }

  private ensureConnection(): void {
    if (!this.db) {
      throw new Error("TaskStorage not initialized. Call initialize() first.");
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
      insertTask: `
        INSERT INTO tasks (id, chat_id, channel_type, title, status, prompt, result, error, created_at, updated_at, completed_at, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      getTask: `SELECT * FROM tasks WHERE id = ?`,
      updateStatus: `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`,
      updateResult: `UPDATE tasks SET result = ?, status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      updateError: `UPDATE tasks SET error = ?, status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      updateBlocked: `UPDATE tasks SET result = ?, status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      listByChatId: `SELECT * FROM tasks WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?`,
      listActiveByChatId: `SELECT * FROM tasks WHERE chat_id = ? AND status IN ('pending', 'planning', 'executing', 'paused', 'waiting_for_input') ORDER BY created_at DESC`,
      loadIncomplete: `SELECT * FROM tasks WHERE status IN ('pending', 'planning', 'executing', 'paused', 'waiting_for_input')`,
      insertProgress: `INSERT INTO task_progress (task_id, timestamp, message) VALUES (?, ?, ?)`,
      touchTask: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      getProgress: `SELECT * FROM task_progress WHERE task_id = ? ORDER BY timestamp ASC`,
    };

    for (const [name, sql] of Object.entries(stmts)) {
      this.statements.set(name, this.db.prepare(sql));
    }
  }
}
