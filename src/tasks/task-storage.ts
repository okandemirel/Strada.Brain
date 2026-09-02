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
import type { TaskOrigin } from "../daemon/daemon-types.js";
import type { Attachment } from "../channels/channel.interface.js";
import type { MessageContent } from "../agents/providers/provider-core.interface.js";

// ─── Schema ──────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  conversation_id TEXT,
  user_id TEXT,
  goal_root_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  prompt TEXT NOT NULL,
  result TEXT,
  error TEXT,
  origin TEXT,
  trigger_name TEXT,
  force_shared_planning INTEGER NOT NULL DEFAULT 0,
  user_content_json TEXT,
  attachments_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  parent_id TEXT,
  workspace_policy TEXT,
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
  conversation_id: string | null;
  user_id: string | null;
  goal_root_id: string | null;
  title: string;
  status: string;
  prompt: string;
  result: string | null;
  verification_json?: string | null;
  error: string | null;
  origin: string | null;
  trigger_name: string | null;
  force_shared_planning: number | null;
  user_content_json: string | null;
  attachments_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  parent_id: string | null;
  workspace_policy?: string | null;
}

interface ProgressRow {
  id: number;
  task_id: string;
  timestamp: number;
  message: string;
}

interface StoredAttachment {
  type: Attachment["type"];
  name: string;
  url?: string;
  dataBase64?: string;
  mimeType?: string;
  size?: number;
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
    this.migrateLegacySchema();
    // After migration so a legacy table has the column before the index lands.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)");
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
      task.conversationId ?? null,
      task.userId ?? null,
      task.goalRootId ?? null,
      task.title,
      task.status,
      task.prompt,
      task.result ?? null,
      task.error ?? null,
      task.origin ?? null,
      task.triggerName ?? null,
      task.forceSharedPlanning ? 1 : 0,
      this.serializeUserContent(task.userContent),
      this.serializeAttachments(task.attachments),
      task.createdAt,
      task.updatedAt,
      task.completedAt ?? null,
      task.parentId ?? null,
      // Audited 2026-09-02: never persisted, so a replayed "run against the
      // real root" fix task silently took a lease and its deletions were declined.
      task.workspacePolicy ?? null,
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

  updateGoalRoot(id: TaskId, goalRootId: string): void {
    this.ensureConnection();
    this.getStmt("updateGoalRoot").run(goalRootId, Date.now(), id);
  }

  /** Persist the mechanical test verdict derived at settle time. */
  setVerification(id: TaskId, verdictJson: string): void {
    this.ensureConnection();
    this.db!.prepare("UPDATE tasks SET verification_json = ? WHERE id = ?").run(verdictJson, id);
  }

  addProgress(id: TaskId, message: string): void {
    this.ensureConnection();
    const now = Date.now();
    this.getStmt("insertProgress").run(id, now, message);
    this.getStmt("touchTask").run(now, id);
  }

  /**
   * Bump updated_at without a progress row. The stuck-task reaper reads
   * updated_at as the liveness signal; a heartbeat is activity, not progress
   * worth rendering, so it must not accumulate empty progress entries.
   */
  touch(id: TaskId): void {
    this.ensureConnection();
    this.getStmt("touchTask").run(Date.now(), id);
  }

  // ─── Queries ────────────────────────────────────────────────────────────────

  listExecuting(): Task[] {
    this.ensureConnection();
    const rows = this.getStmt("listExecuting").all() as TaskRow[];
    return rows.map((r) => this.rowToTask(r, this.getProgress(r.id)));
  }

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

  listRecoverable(limit = 20): Task[] {
    this.ensureConnection();
    const rows = this.getStmt("listRecoverable").all(limit) as TaskRow[];
    return rows.map((r) => this.rowToTask(r, this.getProgress(r.id)));
  }

  loadIncomplete(): Task[] {
    this.ensureConnection();
    const rows = this.getStmt("loadIncomplete").all() as TaskRow[];
    return rows.map((r) => this.rowToTask(r, this.getProgress(r.id)));
  }

  findLatestByGoalRoot(goalRootId: string): Task | null {
    this.ensureConnection();
    const row = this.getStmt("findLatestByGoalRoot").get(goalRootId) as TaskRow | undefined;
    if (!row) return null;
    return this.rowToTask(row, this.getProgress(row.id));
  }

  /**
   * Newest task in the parent_id lineage rooted at `rootId` (the root itself
   * when nothing ever retried it). Every retry/resume/replan path submits with
   * `parentId` set, so this is how a long-lived observer (the campaign layer)
   * follows work across the new task ids those paths mint.
   */
  findLatestDescendant(rootId: TaskId): Task | null {
    this.ensureConnection();
    const row = this.getStmt("findLatestDescendant").get(rootId) as TaskRow | undefined;
    if (!row) return null;
    return this.rowToTask(row, this.getProgress(row.id));
  }

  /** True when `taskId` is `rootId` or a parent_id descendant of it. */
  lineageContains(rootId: TaskId, taskId: TaskId): boolean {
    this.ensureConnection();
    return this.getStmt("lineageContains").get(rootId, taskId) !== undefined;
  }

  /** The chat a real person most recently talked in — where daemon notices
   *  that need a human should go. Null when no user-origin task exists yet. */
  findLatestUserChat(): { chatId: string; channelType: string } | null {
    this.ensureConnection();
    const row = this.getStmt("findLatestUserChat").get() as
      | { chat_id: string; channel_type: string }
      | undefined;
    return row ? { chatId: row.chat_id, channelType: row.channel_type } : null;
  }

  /**
   * The root of the retry lineage `taskId` belongs to — the ancestor with no
   * parent (the task itself when it was never a retry). Stable across every
   * retry round, which is what makes it usable as a retry-budget key.
   */
  findLineageRootId(taskId: TaskId): TaskId | null {
    this.ensureConnection();
    const row = this.getStmt("findLineageRoot").get(taskId) as { id: string } | undefined;
    return row ? (row.id as TaskId) : null;
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
      conversationId: row.conversation_id ?? undefined,
      userId: row.user_id ?? undefined,
      goalRootId: row.goal_root_id ?? undefined,
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
      origin: this.parseTaskOrigin(row.origin),
      triggerName: row.trigger_name ?? undefined,
      forceSharedPlanning: row.force_shared_planning === 1,
      userContent: this.parseUserContent(row.user_content_json),
      attachments: this.parseAttachments(row.attachments_json),
      verification: this.parseVerification(row.verification_json),
      workspacePolicy: row.workspace_policy === "none" ? "none" : undefined,
    };
  }

  private migrateLegacySchema(): void {
    if (!this.db) return;

    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const knownColumns = new Set(columns.map((column) => column.name));
    const migratableColumns: Array<[string, string]> = [
      ["conversation_id", "TEXT"],
      ["user_id", "TEXT"],
      ["goal_root_id", "TEXT"],
      ["origin", "TEXT"],
      ["trigger_name", "TEXT"],
      ["force_shared_planning", "INTEGER NOT NULL DEFAULT 0"],
      ["user_content_json", "TEXT"],
      ["attachments_json", "TEXT"],
      ["verification_json", "TEXT"],
      ["workspace_policy", "TEXT"],
    ];
    const missingColumns = migratableColumns.filter(([name]) => !knownColumns.has(name));

    for (const [name, definition] of missingColumns) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
    }
  }

  private parseVerification(raw: string | null | undefined): import("./test-verdict.js").TaskTestVerdict | undefined {
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { testsGreen?: unknown; detail?: unknown };
      return {
        testsGreen: typeof parsed.testsGreen === "boolean" ? parsed.testsGreen : undefined,
        detail: typeof parsed.detail === "string" ? parsed.detail : "",
      };
    } catch {
      return undefined;
    }
  }

  private parseTaskOrigin(origin: string | null): TaskOrigin | undefined {
    return origin === "user" || origin === "daemon" ? origin : undefined;
  }

  private serializeUserContent(userContent?: string | MessageContent[]): string | null {
    if (typeof userContent === "undefined") {
      return null;
    }
    return JSON.stringify(userContent);
  }

  private parseUserContent(value: string | null): string | MessageContent[] | undefined {
    if (!value) {
      return undefined;
    }
    try {
      return JSON.parse(value) as string | MessageContent[];
    } catch {
      return undefined;
    }
  }

  private serializeAttachments(attachments?: Attachment[]): string | null {
    if (!attachments || attachments.length === 0) {
      return null;
    }
    const encoded: StoredAttachment[] = attachments.map((attachment) => ({
      type: attachment.type,
      name: attachment.name,
      ...(attachment.url ? { url: attachment.url } : {}),
      ...(attachment.data ? { dataBase64: attachment.data.toString("base64") } : {}),
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
    }));
    return JSON.stringify(encoded);
  }

  private parseAttachments(value: string | null): Attachment[] | undefined {
    if (!value) {
      return undefined;
    }
    try {
      const decoded = JSON.parse(value) as StoredAttachment[];
      return decoded.map((attachment) => ({
        type: attachment.type,
        name: attachment.name,
        ...(attachment.url ? { url: attachment.url } : {}),
        ...(attachment.dataBase64 ? { data: Buffer.from(attachment.dataBase64, "base64") } : {}),
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
      }));
    } catch {
      return undefined;
    }
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
        INSERT INTO tasks (
          id, chat_id, channel_type, conversation_id, user_id, goal_root_id,
          title, status, prompt, result, error, origin, trigger_name,
          force_shared_planning, user_content_json, attachments_json,
          created_at, updated_at, completed_at, parent_id, workspace_policy
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      getTask: `SELECT * FROM tasks WHERE id = ?`,
      updateStatus: `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`,
      updateResult: `UPDATE tasks SET result = ?, status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      updateError: `UPDATE tasks SET error = ?, status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      updateBlocked: `UPDATE tasks SET result = ?, status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      updateGoalRoot: `UPDATE tasks SET goal_root_id = ?, updated_at = ? WHERE id = ?`,
      listByChatId: `SELECT * FROM tasks WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?`,
      listExecuting: `SELECT * FROM tasks WHERE status = 'executing' ORDER BY updated_at ASC`,
      listActiveByChatId: `SELECT * FROM tasks WHERE chat_id = ? AND status IN ('pending', 'planning', 'executing', 'paused', 'waiting_for_input') ORDER BY created_at DESC`,
      listRecoverable: `SELECT * FROM tasks WHERE status IN ('blocked', 'failed', 'cancelled') ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
      loadIncomplete: `SELECT * FROM tasks WHERE status IN ('pending', 'planning', 'executing', 'paused', 'waiting_for_input') ORDER BY updated_at DESC, created_at DESC`,
      findLatestByGoalRoot: `SELECT * FROM tasks WHERE goal_root_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      findLatestDescendant: `
        WITH RECURSIVE lineage(id) AS (
          SELECT id FROM tasks WHERE id = ?
          UNION
          SELECT t.id FROM tasks t JOIN lineage l ON t.parent_id = l.id
        )
        SELECT * FROM tasks WHERE id IN (SELECT id FROM lineage)
        ORDER BY created_at DESC, updated_at DESC LIMIT 1
      `,
      lineageContains: `
        WITH RECURSIVE lineage(id) AS (
          SELECT id FROM tasks WHERE id = ?
          UNION
          SELECT t.id FROM tasks t JOIN lineage l ON t.parent_id = l.id
        )
        SELECT 1 FROM lineage WHERE id = ? LIMIT 1
      `,
      findLatestUserChat: `SELECT chat_id, channel_type FROM tasks WHERE origin = 'user' ORDER BY created_at DESC LIMIT 1`,
      findLineageRoot: `
        WITH RECURSIVE up(id, parent_id) AS (
          SELECT id, parent_id FROM tasks WHERE id = ?
          UNION
          SELECT t.id, t.parent_id FROM tasks t JOIN up u ON t.id = u.parent_id
        )
        SELECT id FROM up WHERE parent_id IS NULL LIMIT 1
      `,
      insertProgress: `INSERT INTO task_progress (task_id, timestamp, message) VALUES (?, ?, ?)`,
      touchTask: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      getProgress: `SELECT * FROM task_progress WHERE task_id = ? ORDER BY timestamp ASC`,
    };

    for (const [name, sql] of Object.entries(stmts)) {
      this.statements.set(name, this.db.prepare(sql));
    }
  }
}
