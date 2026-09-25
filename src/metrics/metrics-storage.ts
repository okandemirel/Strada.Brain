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
import { getLoggerSafe } from "../utils/logger.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  TaskMetric,
  MetricsFilter,
  MetricsAggregation,
  InstinctLeaderboardEntry,
  RetrievalMetric,
  RetrievalAggregation,
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

CREATE TABLE IF NOT EXISTS retrieval_metrics (
  id TEXT PRIMARY KEY,
  retrieval_time_ms INTEGER NOT NULL,
  instincts_scanned INTEGER NOT NULL DEFAULT 0,
  scope_filtered INTEGER NOT NULL DEFAULT 0,
  insights_returned INTEGER NOT NULL DEFAULT 0,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_metrics_recorded ON retrieval_metrics(recorded_at DESC);

-- FND-23: raw rows older than the retention period are folded into these
-- per-UTC-day totals before they are deleted, so every aggregate still covers
-- all time. Sums, not averages, so rolled and raw rows combine exactly.
CREATE TABLE IF NOT EXISTS task_metrics_rollup (
  day_start INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  completion_status TEXT NOT NULL,
  task_count INTEGER NOT NULL,
  paor_iterations_sum INTEGER NOT NULL,
  tool_call_sum INTEGER NOT NULL,
  tasks_with_instincts INTEGER NOT NULL,
  instinct_count_sum INTEGER NOT NULL,
  PRIMARY KEY (day_start, session_id, task_type, completion_status)
);

CREATE TABLE IF NOT EXISTS instinct_usage_rollup (
  instinct_id TEXT PRIMARY KEY,
  usage_count INTEGER NOT NULL,
  success_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS retrieval_metrics_rollup (
  day_start INTEGER PRIMARY KEY,
  retrievals INTEGER NOT NULL,
  retrieval_time_sum INTEGER NOT NULL,
  instincts_scanned_sum INTEGER NOT NULL,
  insights_returned_sum INTEGER NOT NULL
);
`;

const DAY_MS = 86_400_000;

/** How long raw metric rows are kept before they are folded into the rollups. */
export const DEFAULT_METRICS_RETENTION_DAYS = 90;

export interface MetricsStorageOptions {
  /** Raw-row retention; older rows survive only in the all-time rollups. */
  retentionDays?: number;
}

/** Start of the UTC day containing `ms`. */
function dayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

interface TaskSums {
  total: number | null;
  success_count: number | null;
  failure_count: number | null;
  partial_count: number | null;
  iterations_sum: number | null;
  tool_calls_sum: number | null;
  tasks_with_instincts: number | null;
  instinct_count_sum: number | null;
}

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
  private readonly retentionDays: number;
  private lastRetentionAt = 0;

  // Prepared statement cache
  private stmts: {
    insert?: Database.Statement;
    insertRetrieval?: Database.Statement;
    instinctLeaderboard?: Database.Statement;
  } = {};

  constructor(dbPath: string, options: MetricsStorageOptions = {}) {
    this.dbPath = dbPath;
    this.retentionDays = options.retentionDays ?? DEFAULT_METRICS_RETENTION_DAYS;
  }

  /** Initialize the database connection and create the task_metrics table */
  initialize(): void {
    const dir = dirname(this.dbPath);
    if (dir && dir !== ".") {
      mkdirSync(dir, { recursive: true });
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
    this.stmts.insertRetrieval = this.db.prepare(`
      INSERT OR REPLACE INTO retrieval_metrics
      (id, retrieval_time_ms, instincts_scanned, scope_filtered, insights_returned, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.stmts.instinctLeaderboard = this.db.prepare(`
      SELECT
        instinct_id,
        SUM(usage_count) as usage_count,
        SUM(success_count) * 1.0 / SUM(usage_count) as task_success_rate
      FROM (
        SELECT j.value as instinct_id, COUNT(*) as usage_count,
          SUM(CASE WHEN tm.completion_status = 'success' THEN 1 ELSE 0 END) as success_count
        FROM task_metrics tm, json_each(tm.instinct_ids) j
        GROUP BY j.value
        UNION ALL
        SELECT instinct_id, usage_count, success_count FROM instinct_usage_rollup
      )
      GROUP BY instinct_id
      ORDER BY usage_count DESC
      LIMIT ?
    `);

    this.applyRetention();
  }

  /**
   * Fold raw rows older than the retention period into the all-time rollups
   * and delete them (FND-23): every task and every retrieval added a row
   * forever. The cutoff is a UTC day boundary, so each rollup day is complete
   * and a query window inside the retention period never touches a rollup.
   * Runs at initialize() and then at most once a day from the record paths.
   */
  applyRetention(now: number = Date.now()): void {
    this.ensureConnection();
    this.lastRetentionAt = now;
    const cutoff = dayStart(now - this.retentionDays * DAY_MS);
    const db = this.db!;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO task_metrics_rollup
          (day_start, session_id, task_type, completion_status, task_count,
           paor_iterations_sum, tool_call_sum, tasks_with_instincts, instinct_count_sum)
        SELECT (CAST(completed_at AS INTEGER) / ${DAY_MS}) * ${DAY_MS}, session_id, task_type, completion_status, COUNT(*),
          SUM(paor_iterations), SUM(tool_call_count),
          SUM(CASE WHEN instinct_count > 0 THEN 1 ELSE 0 END),
          SUM(CASE WHEN instinct_count > 0 THEN instinct_count ELSE 0 END)
        FROM task_metrics WHERE completed_at < ?
        GROUP BY 1, 2, 3, 4
        ON CONFLICT(day_start, session_id, task_type, completion_status) DO UPDATE SET
          task_count = task_count + excluded.task_count,
          paor_iterations_sum = paor_iterations_sum + excluded.paor_iterations_sum,
          tool_call_sum = tool_call_sum + excluded.tool_call_sum,
          tasks_with_instincts = tasks_with_instincts + excluded.tasks_with_instincts,
          instinct_count_sum = instinct_count_sum + excluded.instinct_count_sum
      `).run(cutoff);
      db.prepare(`
        INSERT INTO instinct_usage_rollup (instinct_id, usage_count, success_count)
        SELECT j.value, COUNT(*), SUM(CASE WHEN tm.completion_status = 'success' THEN 1 ELSE 0 END)
        FROM task_metrics tm, json_each(tm.instinct_ids) j WHERE tm.completed_at < ?
        GROUP BY j.value
        ON CONFLICT(instinct_id) DO UPDATE SET
          usage_count = usage_count + excluded.usage_count,
          success_count = success_count + excluded.success_count
      `).run(cutoff);
      db.prepare("DELETE FROM task_metrics WHERE completed_at < ?").run(cutoff);

      db.prepare(`
        INSERT INTO retrieval_metrics_rollup
          (day_start, retrievals, retrieval_time_sum, instincts_scanned_sum, insights_returned_sum)
        SELECT (CAST(recorded_at AS INTEGER) / ${DAY_MS}) * ${DAY_MS}, COUNT(*), SUM(retrieval_time_ms),
          SUM(instincts_scanned), SUM(insights_returned)
        FROM retrieval_metrics WHERE recorded_at < ?
        GROUP BY 1
        ON CONFLICT(day_start) DO UPDATE SET
          retrievals = retrievals + excluded.retrievals,
          retrieval_time_sum = retrieval_time_sum + excluded.retrieval_time_sum,
          instincts_scanned_sum = instincts_scanned_sum + excluded.instincts_scanned_sum,
          insights_returned_sum = insights_returned_sum + excluded.insights_returned_sum
      `).run(cutoff);
      db.prepare("DELETE FROM retrieval_metrics WHERE recorded_at < ?").run(cutoff);
    })();
  }

  /** The daily retention pass; a failure is logged, never lost with the metric. */
  private maybeApplyRetention(): void {
    if (Date.now() - this.lastRetentionAt < DAY_MS) return;
    try {
      this.applyRetention();
    } catch (error) {
      getLoggerSafe().warn("Metrics retention pass failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Record a task metric row (synchronous, fire-and-forget) */
  recordTaskMetric(metric: TaskMetric): void {
    this.ensureConnection();
    this.maybeApplyRetention();
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

  /**
   * Record one instinct retrieval. Lives in its own table — a retrieval is not
   * a task, and the task_metrics CHECK rejected the old "simple" task_type so
   * this telemetry had never landed once (audited 2026-09-02).
   */
  recordRetrievalMetric(metric: RetrievalMetric): void {
    this.ensureConnection();
    this.maybeApplyRetention();
    this.stmts.insertRetrieval!.run(
      metric.id,
      metric.retrievalTimeMs,
      metric.instinctsScanned,
      metric.scopeFiltered,
      metric.insightsReturned,
      metric.recordedAt,
    );
  }

  /** Most recent retrieval rows (newest first) */
  getRetrievalMetrics(limit: number = 100): RetrievalMetric[] {
    this.ensureConnection();
    const rows = this.db!
      .prepare(`SELECT * FROM retrieval_metrics ORDER BY recorded_at DESC LIMIT ?`)
      .all(limit) as Array<{
        id: string;
        retrieval_time_ms: number;
        instincts_scanned: number;
        scope_filtered: number;
        insights_returned: number;
        recorded_at: number;
      }>;
    return rows.map((r) => ({
      id: r.id,
      retrievalTimeMs: r.retrieval_time_ms,
      instinctsScanned: r.instincts_scanned,
      scopeFiltered: r.scope_filtered,
      insightsReturned: r.insights_returned,
      recordedAt: r.recorded_at,
    }));
  }

  /**
   * Aggregate over retrievals recorded at or after `since` (all time when
   * omitted). Rolled-up days (older than the retention period) count whole.
   */
  getRetrievalAggregation(since?: number): RetrievalAggregation {
    this.ensureConnection();
    const rawWhere = since !== undefined ? "WHERE recorded_at >= ?" : "";
    const rollWhere = since !== undefined ? "WHERE day_start >= ?" : "";
    const params = since !== undefined ? [since, dayStart(since)] : [];
    const row = this.db!
      .prepare(`SELECT SUM(n) as total, SUM(time_sum) as time_sum, SUM(scanned_sum) as scanned_sum,
        SUM(returned_sum) as returned_sum FROM (
          SELECT COUNT(*) as n, SUM(retrieval_time_ms) as time_sum, SUM(instincts_scanned) as scanned_sum,
            SUM(insights_returned) as returned_sum FROM retrieval_metrics ${rawWhere}
          UNION ALL
          SELECT SUM(retrievals), SUM(retrieval_time_sum), SUM(instincts_scanned_sum), SUM(insights_returned_sum)
            FROM retrieval_metrics_rollup ${rollWhere}
        )`)
      .get(...params) as { total: number | null; time_sum: number | null; scanned_sum: number | null; returned_sum: number | null };
    const total = row.total ?? 0;
    const avg = (sum: number | null): number => (total > 0 ? (sum ?? 0) / total : 0);
    return {
      retrievals: total,
      avgRetrievalTimeMs: avg(row.time_sum),
      avgInstinctsScanned: avg(row.scanned_sum),
      avgInsightsReturned: avg(row.returned_sum),
    };
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

  /**
   * Get aggregated metrics matching the filter: the retained raw rows plus the
   * rollup of the pruned ones, so "all time" still means all time (FND-23).
   * A window reaching past the retention period counts rolled-up days whole.
   */
  getAggregation(filter: MetricsFilter): MetricsAggregation {
    this.ensureConnection();

    const raw = this.buildWhereClause(filter);
    const rolled = this.buildWhereClause(filter, "day_start");

    const rawSums = this.db!.prepare(`SELECT
      COUNT(*) as total,
      SUM(CASE WHEN completion_status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN completion_status = 'failure' THEN 1 ELSE 0 END) as failure_count,
      SUM(CASE WHEN completion_status = 'partial' THEN 1 ELSE 0 END) as partial_count,
      SUM(paor_iterations) as iterations_sum,
      SUM(tool_call_count) as tool_calls_sum,
      SUM(CASE WHEN instinct_count > 0 THEN 1 ELSE 0 END) as tasks_with_instincts,
      SUM(CASE WHEN instinct_count > 0 THEN instinct_count ELSE 0 END) as instinct_count_sum
    FROM task_metrics ${raw.sql}`).get(...raw.params) as TaskSums;

    const rolledSums = this.db!.prepare(`SELECT
      SUM(task_count) as total,
      SUM(CASE WHEN completion_status = 'success' THEN task_count ELSE 0 END) as success_count,
      SUM(CASE WHEN completion_status = 'failure' THEN task_count ELSE 0 END) as failure_count,
      SUM(CASE WHEN completion_status = 'partial' THEN task_count ELSE 0 END) as partial_count,
      SUM(paor_iterations_sum) as iterations_sum,
      SUM(tool_call_sum) as tool_calls_sum,
      SUM(tasks_with_instincts) as tasks_with_instincts,
      SUM(instinct_count_sum) as instinct_count_sum
    FROM task_metrics_rollup ${rolled.sql}`).get(...rolled.params) as TaskSums;

    const add = (key: keyof TaskSums): number => (rawSums[key] ?? 0) + (rolledSums[key] ?? 0);
    const total = add("total");
    const successCount = add("success_count");
    const tasksWithInstincts = add("tasks_with_instincts");

    return {
      totalTasks: total,
      successCount,
      failureCount: add("failure_count"),
      partialCount: add("partial_count"),
      completionRate: total > 0 ? successCount / total : 0,
      avgIterations: total > 0 ? add("iterations_sum") / total : 0,
      avgToolCalls: total > 0 ? add("tool_calls_sum") / total : 0,
      tasksWithInstincts,
      instinctReusePct: total > 0 ? (tasksWithInstincts / total) * 100 : 0,
      avgInstinctsPerInformedTask: tasksWithInstincts > 0 ? add("instinct_count_sum") / tasksWithInstincts : 0,
    };
  }

  /** Get instinct IDs ranked by usage count with success rates */
  getInstinctLeaderboard(limit: number = 50): InstinctLeaderboardEntry[] {
    this.ensureConnection();

    const rows = this.stmts.instinctLeaderboard!.all(limit) as Array<{
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
    if (!this.db || !this.stmts.insert) {
      throw new Error("MetricsStorage not initialized. Call initialize() first.");
    }
  }

  /**
   * WHERE clause for the raw table, or (timeColumn "day_start") for the daily
   * rollup, where `since` selects from the day that contains it.
   */
  private buildWhereClause(
    filter: MetricsFilter,
    timeColumn: "completed_at" | "day_start" = "completed_at",
  ): { sql: string; params: (string | number)[] } {
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
      conditions.push(`${timeColumn} >= ?`);
      params.push(timeColumn === "day_start" ? dayStart(filter.since) : filter.since);
    }
    if (filter.until !== undefined) {
      conditions.push(`${timeColumn} <= ?`);
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
