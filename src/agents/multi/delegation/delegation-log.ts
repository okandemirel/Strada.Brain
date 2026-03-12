/**
 * Delegation Log
 *
 * SQLite-backed audit log for tracking delegation lifecycle events.
 * Records start, completion, failure, timeout, and cancellation of delegations
 * with queryable history and aggregate statistics.
 *
 * Requirements: AGENT-03, AGENT-05
 */

import type Database from "better-sqlite3";

// =============================================================================
// SCHEMA
// =============================================================================

const DELEGATION_LOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS delegation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_agent_id TEXT NOT NULL,
  sub_agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  cost_usd REAL,
  status TEXT NOT NULL DEFAULT 'running',
  result_summary TEXT,
  escalated_from TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_delegation_parent ON delegation_log(parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_delegation_type ON delegation_log(type);
CREATE INDEX IF NOT EXISTS idx_delegation_status ON delegation_log(status);
`;

// =============================================================================
// EXPORTED TYPES
// =============================================================================

/** A single delegation log entry */
export interface DelegationLogEntry {
  readonly id: number;
  readonly parentAgentId: string;
  readonly subAgentId: string;
  readonly type: string;
  readonly model: string;
  readonly tier: string;
  readonly depth: number;
  readonly durationMs: number | undefined;
  readonly costUsd: number | undefined;
  readonly status: string;
  readonly resultSummary: string | undefined;
  readonly escalatedFrom: string | undefined;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
}

/** Aggregate statistics for a delegation type */
export interface DelegationStats {
  readonly type: string;
  readonly count: number;
  readonly avgDurationMs: number;
  readonly avgCostUsd: number;
  readonly successRate: number;
  readonly tierBreakdown: Record<string, number>;
}

// =============================================================================
// ROW TYPE
// =============================================================================

interface DelegationLogRow {
  id: number;
  parent_agent_id: string;
  sub_agent_id: string;
  type: string;
  model: string;
  tier: string;
  depth: number;
  duration_ms: number | null;
  cost_usd: number | null;
  status: string;
  result_summary: string | null;
  escalated_from: string | null;
  started_at: number;
  completed_at: number | null;
}

// =============================================================================
// DELEGATION LOG CLASS
// =============================================================================

export class DelegationLog {
  private readonly stmts: {
    insert: Database.Statement;
    complete: Database.Statement;
    fail: Database.Statement;
    timeout: Database.Statement;
    cancel: Database.Statement;
    history: Database.Statement;
    byParent: Database.Statement;
    activeByParent: Database.Statement;
  };

  constructor(private readonly db: Database.Database) {
    // Create table and indexes (idempotent)
    this.db.exec(DELEGATION_LOG_SCHEMA);

    // Prepare statements
    this.stmts = {
      insert: this.db.prepare(
        `INSERT INTO delegation_log (parent_agent_id, sub_agent_id, type, model, tier, depth, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      ),
      complete: this.db.prepare(
        `UPDATE delegation_log
         SET status = 'completed', duration_ms = ?, cost_usd = ?, result_summary = ?, escalated_from = ?, completed_at = ?
         WHERE id = ?`,
      ),
      fail: this.db.prepare(
        `UPDATE delegation_log
         SET status = 'failed', result_summary = ?, escalated_from = ?, completed_at = ?
         WHERE id = ?`,
      ),
      timeout: this.db.prepare(
        `UPDATE delegation_log SET status = 'timeout', completed_at = ? WHERE id = ?`,
      ),
      cancel: this.db.prepare(
        `UPDATE delegation_log SET status = 'cancelled', completed_at = ? WHERE id = ?`,
      ),
      history: this.db.prepare(
        `SELECT * FROM delegation_log ORDER BY started_at DESC LIMIT ?`,
      ),
      byParent: this.db.prepare(
        `SELECT * FROM delegation_log WHERE parent_agent_id = ? ORDER BY started_at DESC LIMIT ?`,
      ),
      activeByParent: this.db.prepare(
        `SELECT * FROM delegation_log WHERE parent_agent_id = ? AND status = 'running'`,
      ),
    };
  }

  /**
   * Record a new delegation start. Returns the delegation log ID.
   */
  start(entry: {
    parentAgentId: string;
    subAgentId: string;
    type: string;
    model: string;
    tier: string;
    depth: number;
  }): number {
    const result = this.stmts.insert.run(
      entry.parentAgentId,
      entry.subAgentId,
      entry.type,
      entry.model,
      entry.tier,
      entry.depth,
      Date.now(),
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Mark a delegation as completed with results.
   */
  complete(
    id: number,
    result: {
      durationMs: number;
      costUsd: number;
      resultSummary: string;
      escalatedFrom?: string;
    },
  ): void {
    this.stmts.complete.run(
      result.durationMs,
      result.costUsd,
      result.resultSummary,
      result.escalatedFrom ?? null,
      Date.now(),
      id,
    );
  }

  /**
   * Mark a delegation as failed.
   */
  fail(id: number, reason: string, escalatedFrom?: string): void {
    this.stmts.fail.run(reason, escalatedFrom ?? null, Date.now(), id);
  }

  /**
   * Mark a delegation as timed out.
   */
  timeout(id: number): void {
    this.stmts.timeout.run(Date.now(), id);
  }

  /**
   * Mark a delegation as cancelled.
   */
  cancel(id: number): void {
    this.stmts.cancel.run(Date.now(), id);
  }

  /**
   * Get delegation history ordered by started_at DESC.
   */
  getHistory(limit = 50): DelegationLogEntry[] {
    const rows = this.stmts.history.all(limit) as DelegationLogRow[];
    return rows.map(this.rowToEntry);
  }

  /**
   * Get delegation history for a specific parent agent.
   */
  getByParent(parentAgentId: string, limit = 50): DelegationLogEntry[] {
    const rows = this.stmts.byParent.all(parentAgentId, limit) as DelegationLogRow[];
    return rows.map(this.rowToEntry);
  }

  /**
   * Get currently running delegations for a parent agent.
   */
  getActiveByParent(parentAgentId: string): DelegationLogEntry[] {
    const rows = this.stmts.activeByParent.all(parentAgentId) as DelegationLogRow[];
    return rows.map(this.rowToEntry);
  }

  /**
   * Get aggregate statistics grouped by delegation type.
   */
  getStats(): DelegationStats[] {
    const rows = this.db.prepare(
      `SELECT
         type,
         COUNT(*) AS count,
         AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE NULL END) AS avg_duration_ms,
         AVG(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE NULL END) AS avg_cost_usd,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS success_count,
         tier
       FROM delegation_log
       GROUP BY type, tier`,
    ).all() as Array<{
      type: string;
      count: number;
      avg_duration_ms: number | null;
      avg_cost_usd: number | null;
      success_count: number;
      tier: string;
    }>;

    // Aggregate across tiers per type
    const typeMap = new Map<string, {
      count: number;
      totalDuration: number;
      durationCount: number;
      totalCost: number;
      costCount: number;
      successCount: number;
      tierBreakdown: Record<string, number>;
    }>();

    for (const row of rows) {
      let entry = typeMap.get(row.type);
      if (!entry) {
        entry = {
          count: 0,
          totalDuration: 0,
          durationCount: 0,
          totalCost: 0,
          costCount: 0,
          successCount: 0,
          tierBreakdown: {},
        };
        typeMap.set(row.type, entry);
      }

      entry.count += row.count;
      if (row.avg_duration_ms !== null) {
        entry.totalDuration += row.avg_duration_ms * row.count;
        entry.durationCount += row.count;
      }
      if (row.avg_cost_usd !== null) {
        entry.totalCost += row.avg_cost_usd * row.count;
        entry.costCount += row.count;
      }
      entry.successCount += row.success_count;
      entry.tierBreakdown[row.tier] = (entry.tierBreakdown[row.tier] ?? 0) + row.count;
    }

    const stats: DelegationStats[] = [];
    for (const [type, entry] of typeMap) {
      stats.push({
        type,
        count: entry.count,
        avgDurationMs: entry.durationCount > 0 ? entry.totalDuration / entry.durationCount : 0,
        avgCostUsd: entry.costCount > 0 ? entry.totalCost / entry.costCount : 0,
        successRate: entry.count > 0 ? entry.successCount / entry.count : 0,
        tierBreakdown: entry.tierBreakdown,
      });
    }

    return stats;
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  private rowToEntry(row: DelegationLogRow): DelegationLogEntry {
    return {
      id: row.id,
      parentAgentId: row.parent_agent_id,
      subAgentId: row.sub_agent_id,
      type: row.type,
      model: row.model,
      tier: row.tier,
      depth: row.depth,
      durationMs: row.duration_ms ?? undefined,
      costUsd: row.cost_usd ?? undefined,
      status: row.status,
      resultSummary: row.result_summary ?? undefined,
      escalatedFrom: row.escalated_from ?? undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
    };
  }
}
