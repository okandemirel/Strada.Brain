/**
 * Daemon Storage
 *
 * SQLite-based persistence for the daemon subsystem. Manages a single daemon.db
 * file with 5 tables: budget_entries, approval_queue, audit_log,
 * circuit_breaker_state, and daemon_state.
 *
 * Uses better-sqlite3 with configureSqlitePragmas (WAL mode, daemon profile).
 * All queries use prepared statements for performance.
 */

import Database from "better-sqlite3";
import { configureSqlitePragmas } from "../memory/unified/sqlite-pragmas.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ApprovalEntry,
  ApprovalStatus,
  AuditEntry,
  BudgetEntry,
  CircuitState,
} from "./daemon-types.js";

// =============================================================================
// SCHEMA
// =============================================================================

const DAEMON_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS budget_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cost_usd REAL NOT NULL,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  trigger_name TEXT,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_queue (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  params TEXT NOT NULL,
  trigger_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  params_summary TEXT,
  decision TEXT NOT NULL,
  decided_by TEXT,
  trigger_name TEXT,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS circuit_breaker_state (
  trigger_name TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'CLOSED',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_time INTEGER,
  cooldown_ms INTEGER NOT NULL DEFAULT 60000,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daemon_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_budget_timestamp ON budget_entries(timestamp);
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_queue(status);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
`;

// =============================================================================
// ROW TYPES
// =============================================================================

interface BudgetRow {
  id: number;
  cost_usd: number;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  trigger_name: string | null;
  timestamp: number;
}

interface ApprovalRow {
  id: string;
  tool_name: string;
  params: string;
  trigger_name: string | null;
  status: string;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  expires_at: number;
}

interface AuditRow {
  id: number;
  tool_name: string;
  params_summary: string | null;
  decision: string;
  decided_by: string | null;
  trigger_name: string | null;
  timestamp: number;
}

interface CircuitRow {
  trigger_name: string;
  state: string;
  consecutive_failures: number;
  last_failure_time: number | null;
  cooldown_ms: number;
  updated_at: number;
}

interface DaemonStateRow {
  key: string;
  value: string;
  updated_at: number;
}

interface SumRow {
  total: number | null;
}

// =============================================================================
// STORAGE CLASS
// =============================================================================

export class DaemonStorage {
  private db: Database.Database | null = null;
  private readonly dbPath: string;

  // Prepared statement cache
  private stmts: {
    insertBudget?: Database.Statement;
    sumBudget?: Database.Statement;
    clearBudget?: Database.Statement;
    recentBudget?: Database.Statement;
    insertApproval?: Database.Statement;
    getPending?: Database.Statement;
    getApprovalById?: Database.Statement;
    updateApproval?: Database.Statement;
    getExpired?: Database.Statement;
    insertAudit?: Database.Statement;
    recentAudit?: Database.Statement;
    upsertCircuit?: Database.Statement;
    getCircuit?: Database.Statement;
    allCircuits?: Database.Statement;
    deleteCircuit?: Database.Statement;
    setState?: Database.Statement;
    getState?: Database.Statement;
  } = {};

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** Initialize the database connection and create all daemon tables */
  initialize(): void {
    const dir = dirname(this.dbPath);
    if (dir && dir !== ".") {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    configureSqlitePragmas(this.db, "daemon");
    this.db.exec(DAEMON_SCHEMA_SQL);
    this.prepareStatements();
  }

  /** Close the database connection */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Get table names (for testing) */
  getTableNames(): string[] {
    this.assertOpen();
    const rows = this.db!.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  // =========================================================================
  // Budget Methods
  // =========================================================================

  /** Insert a budget cost entry */
  insertBudgetEntry(entry: Omit<BudgetEntry, "id">): void {
    this.assertOpen();
    this.stmts.insertBudget!.run(
      entry.costUsd,
      entry.model ?? null,
      entry.tokensIn ?? null,
      entry.tokensOut ?? null,
      entry.triggerName ?? null,
      entry.timestamp,
    );
  }

  /** Sum all budget entries since a given timestamp (rolling window) */
  sumBudgetSince(sinceMs: number): number {
    this.assertOpen();
    const row = this.stmts.sumBudget!.get(sinceMs) as SumRow;
    return row.total ?? 0;
  }

  /** Clear all budget entries (manual reset) */
  clearBudgetEntries(): void {
    this.assertOpen();
    this.stmts.clearBudget!.run();
  }

  /** Get recent budget entries ordered by timestamp desc */
  getRecentBudgetEntries(limit = 50): BudgetEntry[] {
    this.assertOpen();
    const rows = this.stmts.recentBudget!.all(limit) as BudgetRow[];
    return rows.map(this.rowToBudgetEntry);
  }

  // =========================================================================
  // Approval Queue Methods
  // =========================================================================

  /** Insert an approval request */
  insertApproval(entry: ApprovalEntry): void {
    this.assertOpen();
    this.stmts.insertApproval!.run(
      entry.id,
      entry.toolName,
      JSON.stringify(entry.params),
      entry.triggerName ?? null,
      entry.status,
      entry.createdAt,
      entry.decidedAt ?? null,
      entry.decidedBy ?? null,
      entry.expiresAt,
    );
  }

  /** Get all pending approval entries */
  getPending(): ApprovalEntry[] {
    this.assertOpen();
    const rows = this.stmts.getPending!.all() as ApprovalRow[];
    return rows.map(this.rowToApprovalEntry);
  }

  /** Get a specific approval by ID */
  getApprovalById(id: string): ApprovalEntry | undefined {
    this.assertOpen();
    const row = this.stmts.getApprovalById!.get(id) as ApprovalRow | undefined;
    return row ? this.rowToApprovalEntry(row) : undefined;
  }

  /** Update an approval decision */
  updateApprovalDecision(
    id: string,
    decision: ApprovalStatus,
    decidedBy?: string,
  ): void {
    this.assertOpen();
    this.stmts.updateApproval!.run(decision, Date.now(), decidedBy ?? null, id);
  }

  /** Get all expired pending approvals */
  getExpiredApprovals(now: number): ApprovalEntry[] {
    this.assertOpen();
    const rows = this.stmts.getExpired!.all(now) as ApprovalRow[];
    return rows.map(this.rowToApprovalEntry);
  }

  // =========================================================================
  // Audit Log Methods
  // =========================================================================

  /** Insert an audit log entry */
  insertAuditEntry(entry: Omit<AuditEntry, "id">): void {
    this.assertOpen();
    this.stmts.insertAudit!.run(
      entry.toolName,
      entry.paramsSummary ?? null,
      entry.decision,
      entry.decidedBy ?? null,
      entry.triggerName ?? null,
      entry.timestamp,
    );
  }

  /** Get recent audit entries in reverse chronological order */
  getRecentAudit(limit = 50): AuditEntry[] {
    this.assertOpen();
    const rows = this.stmts.recentAudit!.all(limit) as AuditRow[];
    return rows.map(this.rowToAuditEntry);
  }

  // =========================================================================
  // Circuit Breaker Methods
  // =========================================================================

  /** Insert or update circuit breaker state for a trigger */
  upsertCircuitState(
    triggerName: string,
    state: CircuitState,
    consecutiveFailures: number,
    lastFailureTime: number | null,
    cooldownMs: number,
  ): void {
    this.assertOpen();
    this.stmts.upsertCircuit!.run(
      triggerName,
      state,
      consecutiveFailures,
      lastFailureTime,
      cooldownMs,
      Date.now(),
    );
  }

  /** Get circuit breaker state for a trigger */
  getCircuitState(
    triggerName: string,
  ):
    | {
        state: CircuitState;
        consecutiveFailures: number;
        lastFailureTime: number | null;
        cooldownMs: number;
      }
    | undefined {
    this.assertOpen();
    const row = this.stmts.getCircuit!.get(triggerName) as
      | CircuitRow
      | undefined;
    if (!row) return undefined;
    return {
      state: row.state as CircuitState,
      consecutiveFailures: row.consecutive_failures,
      lastFailureTime: row.last_failure_time,
      cooldownMs: row.cooldown_ms,
    };
  }

  /** Get all circuit breaker states */
  getAllCircuitStates(): Map<
    string,
    {
      state: CircuitState;
      consecutiveFailures: number;
      lastFailureTime: number | null;
      cooldownMs: number;
    }
  > {
    this.assertOpen();
    const rows = this.stmts.allCircuits!.all() as CircuitRow[];
    const map = new Map<
      string,
      {
        state: CircuitState;
        consecutiveFailures: number;
        lastFailureTime: number | null;
        cooldownMs: number;
      }
    >();
    for (const row of rows) {
      map.set(row.trigger_name, {
        state: row.state as CircuitState,
        consecutiveFailures: row.consecutive_failures,
        lastFailureTime: row.last_failure_time,
        cooldownMs: row.cooldown_ms,
      });
    }
    return map;
  }

  /** Delete circuit breaker state for a trigger */
  deleteCircuitState(triggerName: string): void {
    this.assertOpen();
    this.stmts.deleteCircuit!.run(triggerName);
  }

  // =========================================================================
  // Daemon State Methods
  // =========================================================================

  /** Set a key-value pair in daemon state */
  setDaemonState(key: string, value: string): void {
    this.assertOpen();
    this.stmts.setState!.run(key, value, Date.now());
  }

  /** Get a value from daemon state by key */
  getDaemonState(key: string): string | undefined {
    this.assertOpen();
    const row = this.stmts.getState!.get(key) as DaemonStateRow | undefined;
    return row?.value;
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private assertOpen(): void {
    if (!this.db) {
      throw new Error("DaemonStorage is not initialized. Call initialize() first.");
    }
  }

  private prepareStatements(): void {
    const db = this.db!;

    // Budget
    this.stmts.insertBudget = db.prepare(
      `INSERT INTO budget_entries (cost_usd, model, tokens_in, tokens_out, trigger_name, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stmts.sumBudget = db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM budget_entries WHERE timestamp >= ?`,
    );
    this.stmts.clearBudget = db.prepare(`DELETE FROM budget_entries`);
    this.stmts.recentBudget = db.prepare(
      `SELECT * FROM budget_entries ORDER BY timestamp DESC LIMIT ?`,
    );

    // Approval Queue
    this.stmts.insertApproval = db.prepare(
      `INSERT INTO approval_queue (id, tool_name, params, trigger_name, status, created_at, decided_at, decided_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmts.getPending = db.prepare(
      `SELECT * FROM approval_queue WHERE status = 'pending' ORDER BY created_at ASC`,
    );
    this.stmts.getApprovalById = db.prepare(
      `SELECT * FROM approval_queue WHERE id = ?`,
    );
    this.stmts.updateApproval = db.prepare(
      `UPDATE approval_queue SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?`,
    );
    this.stmts.getExpired = db.prepare(
      `SELECT * FROM approval_queue WHERE status = 'pending' AND expires_at < ?`,
    );

    // Audit Log
    this.stmts.insertAudit = db.prepare(
      `INSERT INTO audit_log (tool_name, params_summary, decision, decided_by, trigger_name, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stmts.recentAudit = db.prepare(
      `SELECT * FROM audit_log ORDER BY timestamp DESC, id DESC LIMIT ?`,
    );

    // Circuit Breaker
    this.stmts.upsertCircuit = db.prepare(
      `INSERT OR REPLACE INTO circuit_breaker_state (trigger_name, state, consecutive_failures, last_failure_time, cooldown_ms, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stmts.getCircuit = db.prepare(
      `SELECT * FROM circuit_breaker_state WHERE trigger_name = ?`,
    );
    this.stmts.allCircuits = db.prepare(
      `SELECT * FROM circuit_breaker_state ORDER BY trigger_name`,
    );
    this.stmts.deleteCircuit = db.prepare(
      `DELETE FROM circuit_breaker_state WHERE trigger_name = ?`,
    );

    // Daemon State
    this.stmts.setState = db.prepare(
      `INSERT OR REPLACE INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?)`,
    );
    this.stmts.getState = db.prepare(
      `SELECT * FROM daemon_state WHERE key = ?`,
    );
  }

  // Row mappers
  private rowToBudgetEntry(row: BudgetRow): BudgetEntry {
    return {
      id: row.id,
      costUsd: row.cost_usd,
      model: row.model ?? undefined,
      tokensIn: row.tokens_in ?? undefined,
      tokensOut: row.tokens_out ?? undefined,
      triggerName: row.trigger_name ?? undefined,
      timestamp: row.timestamp,
    };
  }

  private rowToApprovalEntry(row: ApprovalRow): ApprovalEntry {
    return {
      id: row.id,
      toolName: row.tool_name,
      params: JSON.parse(row.params) as Record<string, unknown>,
      triggerName: row.trigger_name ?? undefined,
      status: row.status as ApprovalStatus,
      createdAt: row.created_at,
      decidedAt: row.decided_at ?? undefined,
      decidedBy: row.decided_by ?? undefined,
      expiresAt: row.expires_at,
    };
  }

  private rowToAuditEntry(row: AuditRow): AuditEntry {
    return {
      id: row.id,
      toolName: row.tool_name,
      paramsSummary: row.params_summary ?? undefined,
      decision: row.decision,
      decidedBy: row.decided_by ?? undefined,
      triggerName: row.trigger_name ?? undefined,
      timestamp: row.timestamp,
    };
  }
}
