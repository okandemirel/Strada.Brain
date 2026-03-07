/**
 * Metrics Storage
 *
 * SQLite-based storage for the task_metrics table in learning.db.
 * Tracks task completion rate (EVAL-01), iterations per task (EVAL-02),
 * and pattern reuse rate (EVAL-03).
 *
 * Opens its own better-sqlite3 connection to the same learning.db path.
 * SQLite WAL mode supports multiple concurrent connections safely.
 */

import Database from "better-sqlite3";
import { configureSqlitePragmas } from "../memory/unified/sqlite-pragmas.js";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type {
  TaskMetric,
  MetricsFilter,
  MetricsAggregation,
  InstinctLeaderboardEntry,
} from "./metrics-types.js";

// ─── Database Schema ─────────────────────────────────────────────────────────

const METRICS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_metrics (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_task_id TEXT,
  task_type TEXT NOT NULL CHECK(task_type IN ('interactive', 'background', 'subtask')),
  task_description TEXT NOT NULL,
  completion_status TEXT NOT NULL CHECK(completion_status IN ('success', 'failure', 'partial')),
  paor_iterations INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  instinct_ids TEXT NOT NULL DEFAULT '[]',
  instinct_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_metrics_session ON task_metrics(session_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_metrics_type_status ON task_metrics(task_type, completion_status);
CREATE INDEX IF NOT EXISTS idx_task_metrics_completed ON task_metrics(completed_at DESC);
`;

// ─── Row Type ────────────────────────────────────────────────────────────────

interface TaskMetricRow {
  id: string;
  session_id: string;
  parent_task_id: string | null;
  task_type: string;
  task_description: string;
  completion_status: string;
  paor_iterations: number;
  tool_call_count: number;
  instinct_ids: string;
  instinct_count: number;
  started_at: number;
  completed_at: number;
  duration_ms: number;
}

// ─── Storage Class ───────────────────────────────────────────────────────────

export class MetricsStorage {
  private db: Database.Database | null = null;
  private readonly dbPath: string;

  // Prepared statement cache
  private stmts: {
    insert?: Database.Statement;
  } = {};

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** Initialize the database connection and create the task_metrics table */
  initialize(): void {
    const dir = dirname(this.dbPath);
    if (dir && dir !== ".") {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(this.dbPath);
    configureSqlitePragmas(this.db, "learning");
    this.db.exec(METRICS_SCHEMA_SQL);

    // Cache prepared statements
    this.stmts.insert = this.db.prepare(`
      INSERT OR REPLACE INTO task_metrics
      (id, session_id, parent_task_id, task_type, task_description, completion_status,
       paor_iterations, tool_call_count, instinct_ids, instinct_count,
       started_at, completed_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /** Record a task metric row (synchronous, fire-and-forget) */
  recordTaskMetric(metric: TaskMetric): void {
    this.ensureConnection();
    this.stmts.insert!.run(
      metric.id,
      metric.sessionId,
      metric.parentTaskId ?? null,
      metric.taskType,
      metric.taskDescription,
      metric.completionStatus,
      metric.paorIterations,
      metric.toolCallCount,
      JSON.stringify(metric.instinctIds),
      metric.instinctCount,
      metric.startedAt,
      metric.completedAt,
      metric.durationMs,
    );
  }

  /** Query task metrics with flexible filter */
  getTaskMetrics(filter: MetricsFilter): TaskMetric[] {
    this.ensureConnection();

    const { sql, params } = this.buildWhereClause(filter);
    const limit = filter.limit ?? 100;

    const query = `SELECT * FROM task_metrics ${sql} ORDER BY completed_at DESC LIMIT ?`;
    const rows = this.db!.prepare(query).all(...params, limit) as TaskMetricRow[];
    return rows.map((r) => this.rowToMetric(r));
  }

  /** Get aggregated metrics matching the filter */
  getAggregation(filter: MetricsFilter): MetricsAggregation {
    this.ensureConnection();

    const { sql, params } = this.buildWhereClause(filter);

    const query = `SELECT
      COUNT(*) as total,
      SUM(CASE WHEN completion_status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN completion_status = 'failure' THEN 1 ELSE 0 END) as failure_count,
      SUM(CASE WHEN completion_status = 'partial' THEN 1 ELSE 0 END) as partial_count,
      AVG(paor_iterations) as avg_iterations,
      AVG(tool_call_count) as avg_tool_calls,
      SUM(CASE WHEN instinct_count > 0 THEN 1 ELSE 0 END) as tasks_with_instincts,
      AVG(CASE WHEN instinct_count > 0 THEN instinct_count ELSE NULL END) as avg_instincts_per_informed
    FROM task_metrics ${sql}`;

    const row = this.db!.prepare(query).get(...params) as {
      total: number;
      success_count: number;
      failure_count: number;
      partial_count: number;
      avg_iterations: number | null;
      avg_tool_calls: number | null;
      tasks_with_instincts: number;
      avg_instincts_per_informed: number | null;
    };

    const total = row.total ?? 0;

    return {
      totalTasks: total,
      successCount: row.success_count ?? 0,
      failureCount: row.failure_count ?? 0,
      partialCount: row.partial_count ?? 0,
      completionRate: total > 0 ? (row.success_count ?? 0) / total : 0,
      avgIterations: row.avg_iterations ?? 0,
      avgToolCalls: row.avg_tool_calls ?? 0,
      tasksWithInstincts: row.tasks_with_instincts ?? 0,
      instinctReusePct: total > 0 ? ((row.tasks_with_instincts ?? 0) / total) * 100 : 0,
      avgInstinctsPerInformedTask: row.avg_instincts_per_informed ?? 0,
    };
  }

  /** Get instinct IDs ranked by usage count with success rates */
  getInstinctLeaderboard(limit: number = 50): InstinctLeaderboardEntry[] {
    this.ensureConnection();

    const query = `
      SELECT
        j.value as instinct_id,
        COUNT(*) as usage_count,
        AVG(CASE WHEN tm.completion_status = 'success' THEN 1.0 ELSE 0.0 END) as task_success_rate
      FROM task_metrics tm, json_each(tm.instinct_ids) j
      GROUP BY j.value
      ORDER BY usage_count DESC
      LIMIT ?
    `;

    const rows = this.db!.prepare(query).all(limit) as Array<{
      instinct_id: string;
      usage_count: number;
      task_success_rate: number;
    }>;

    return rows.map((r) => ({
      instinctId: r.instinct_id,
      usageCount: r.usage_count,
      taskSuccessRate: r.task_success_rate,
    }));
  }

  /** Close the database connection */
  close(): void {
    this.stmts = {};
    this.db?.close();
    this.db = null;
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private ensureConnection(): void {
    if (!this.db) {
      throw new Error("MetricsStorage not initialized. Call initialize() first.");
    }
  }

  private buildWhereClause(filter: MetricsFilter): { sql: string; params: (string | number)[] } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.sessionId) {
      conditions.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.taskType) {
      conditions.push("task_type = ?");
      params.push(filter.taskType);
    }
    if (filter.completionStatus) {
      conditions.push("completion_status = ?");
      params.push(filter.completionStatus);
    }
    if (filter.since !== undefined) {
      conditions.push("completed_at >= ?");
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      conditions.push("completed_at <= ?");
      params.push(filter.until);
    }

    const sql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return { sql, params };
  }

  private rowToMetric(row: TaskMetricRow): TaskMetric {
    return {
      id: row.id,
      sessionId: row.session_id,
      parentTaskId: row.parent_task_id ?? undefined,
      taskType: row.task_type as TaskMetric["taskType"],
      taskDescription: row.task_description,
      completionStatus: row.completion_status as TaskMetric["completionStatus"],
      paorIterations: row.paor_iterations,
      toolCallCount: row.tool_call_count,
      instinctIds: JSON.parse(row.instinct_ids) as string[],
      instinctCount: row.instinct_count,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
    };
  }
}
