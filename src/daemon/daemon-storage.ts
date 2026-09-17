/**
 * Daemon Storage
 *
 * SQLite-based persistence for the daemon subsystem. Manages a single daemon.db
 * file with tables for budget_entries, budget_reservations, approval_queue,
 * audit_log, circuit_breaker_state, and daemon_state.
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
import type {
  UrgencyLevel,
  BufferedNotification,
  NotificationHistoryEntry,
  TriggerFireHistoryEntry,
} from "./reporting/notification-types.js";

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

CREATE TABLE IF NOT EXISTS digest_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_buffer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The chat that owns it: a quiet-hours drain reaches the chat that asked,
  -- not the fallback (Codex round 8 #9).
  chat_id TEXT,
  channel_type TEXT,
  urgency TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  action_hint TEXT,
  source_event TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_buffer_urgency ON notification_buffer(urgency);

CREATE TABLE IF NOT EXISTS trigger_fire_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_name TEXT NOT NULL,
  result TEXT NOT NULL,
  duration_ms INTEGER,
  task_id TEXT,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fire_history_trigger ON trigger_fire_history(trigger_name, timestamp DESC);

CREATE TABLE IF NOT EXISTS notification_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  urgency TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  delivered_to TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_history_time ON notification_history(created_at DESC);

CREATE TABLE IF NOT EXISTS deployment_log (
  id TEXT PRIMARY KEY,
  proposed_at INTEGER NOT NULL,
  approved_at INTEGER,
  approved_by TEXT,
  agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  script_output TEXT,
  duration INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_deployment_log_ts ON deployment_log(proposed_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployment_log_status ON deployment_log(status);

CREATE TABLE IF NOT EXISTS budget_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- PENDING LIABILITY (Codex 2026-09-17 round 8 #2). A reservation lived only
-- in the reserving process, so a crash between "provider charged us" and "the
-- usage callback recorded it" left the wallet believing neither the
-- reservation nor the spend had happened. The row is written BEFORE the work
-- is dispatched; the next boot reconciles rows whose owner is gone.
CREATE TABLE IF NOT EXISTS budget_reservations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT,
  estimate_usd REAL NOT NULL,
  charged_usd REAL NOT NULL DEFAULT 0,
  owner_pid INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_budget_reservations_owner ON budget_reservations(owner_pid);

-- OWNER LIVENESS (Codex 2026-09-17 round 10 #7). A budget process used to be
-- able to prove only ITS OWN identity alive, so a second live process's
-- reservation was classified dead, reconciled, and its headroom handed out
-- twice. Every process that touches the wallet registers its incarnation here
-- and refreshes the heartbeat as it works. One row per PID, because a PID
-- hosts one process at a time: a row naming a DIFFERENT generation with a
-- fresh heartbeat is therefore proof that the older incarnation exited.
-- A missing or stale row proves nothing and must not be read as death.
CREATE TABLE IF NOT EXISTS budget_owners (
  owner_pid INTEGER PRIMARY KEY,
  owner_generation TEXT NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings_overrides (
  key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, scope)
);
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

interface NotificationBufferRow {
  id: number;
  chat_id?: string | null;
  channel_type?: string | null;
  urgency: string;
  title: string;
  message: string;
  action_hint: string | null;
  source_event: string | null;
  created_at: number;
}

interface NotificationHistoryRow {
  id: number;
  urgency: string;
  title: string;
  message: string;
  delivered_to: string | null;
  created_at: number;
}

interface TriggerFireHistoryRow {
  id: number;
  trigger_name: string;
  result: string;
  duration_ms: number | null;
  task_id: string | null;
  timestamp: number;
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
    sumBudgetForTask?: Database.Statement;
    sumBudgetForCampaign?: Database.Statement;
    upsertReservation?: Database.Statement;
    chargeReservation?: Database.Statement;
    deleteReservation?: Database.Statement;
    allReservations?: Database.Statement;
    touchOwner?: Database.Statement;
    allOwners?: Database.Statement;
    pruneOwners?: Database.Statement;
    insertBudgetWithAgent?: Database.Statement;
    sumBudget?: Database.Statement;
    sumBudgetForAgent?: Database.Statement;
    sumBudgetGroupByAgent?: Database.Statement;
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
    // Notification Buffer (Phase 18)
    insertNotifBuffer?: Database.Statement;
    getNotifBuffer?: Database.Statement;
    clearNotifBuffer?: Database.Statement;
    deleteNotifBufferById?: Database.Statement;
    // Notification History (Phase 18)
    insertNotifHistory?: Database.Statement;
    getNotifHistory?: Database.Statement;
    getNotifHistoryFiltered?: Database.Statement;
    // Trigger Fire History (Phase 18)
    insertFireHistory?: Database.Statement;
    getFireHistory?: Database.Statement;
    // Trigger Fire History Pruning (Phase 21)
    pruneFireHistoryByAge?: Database.Statement;
    // Budget source migration
    sumBudgetBySource?: Database.Statement;
    sumBudgetForSource?: Database.Statement;
    dailyHistory?: Database.Statement;
    insertBudgetWithSource?: Database.Statement;
    insertBudgetWithSourceAndAgent?: Database.Statement;
    // Budget config
    getBudgetConfig?: Database.Statement;
    setBudgetConfig?: Database.Statement;
    getAllBudgetConfig?: Database.Statement;
    // Settings overrides
    getSettingsOverride?: Database.Statement;
    setSettingsOverride?: Database.Statement;
  } = {};

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Get the underlying better-sqlite3 Database instance.
   * Used by AgentRegistry to share the daemon.db connection (Plan 23-03).
   */
  getDatabase(): Database.Database {
    if (!this.db) {
      throw new Error("DaemonStorage not initialized. Call initialize() first.");
    }
    return this.db;
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
    // A database written before round 8 #9 has no owner columns on the
    // notification buffer; add them before any statement is prepared.
    for (const column of ["chat_id TEXT DEFAULT NULL", "channel_type TEXT DEFAULT NULL"]) {
      try {
        this.db.exec(`ALTER TABLE notification_buffer ADD COLUMN ${column}`);
      } catch {
        // Column already exists -- safe to ignore
      }
    }
    const reservationColumns = this.db.prepare("PRAGMA table_info(budget_reservations)").all() as Array<{ name: string }>;
    if (!reservationColumns.some((column) => column.name === "owner_generation")) {
      this.db.exec("ALTER TABLE budget_reservations ADD COLUMN owner_generation TEXT DEFAULT NULL");
    }
    if (!reservationColumns.some((column) => column.name === "reconciled_at")) {
      this.db.exec("ALTER TABLE budget_reservations ADD COLUMN reconciled_at INTEGER DEFAULT NULL");
    }
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

  /**
   * Migrate budget_entries table for multi-agent support (Phase 23).
   * Adds agent_id column and index. Safe to call multiple times.
   */
  migrateAgentBudget(): void {
    this.assertOpen();
    try {
      this.db!.exec(`ALTER TABLE budget_entries ADD COLUMN agent_id TEXT DEFAULT NULL`);
    } catch {
      // Column already exists -- safe to ignore
    }
    this.db!.exec(`CREATE INDEX IF NOT EXISTS idx_budget_agent ON budget_entries(agent_id, timestamp)`);
    // Prepare the agent-aware statements after migration
    this.stmts.insertBudgetWithAgent = this.db!.prepare(
      `INSERT INTO budget_entries (cost_usd, model, tokens_in, tokens_out, trigger_name, timestamp, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmts.sumBudgetForAgent = this.db!.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM budget_entries WHERE agent_id = ? AND timestamp >= ?`,
    );
    this.stmts.sumBudgetGroupByAgent = this.db!.prepare(
      `SELECT agent_id, COALESCE(SUM(cost_usd), 0) AS total FROM budget_entries WHERE agent_id IS NOT NULL AND timestamp >= ? GROUP BY agent_id`,
    );
  }

  /**
   * Migrate budget_entries table to add source column and related statements.
   * Safe to call multiple times.
   */
  migrateBudgetSource(): void {
    this.assertOpen();
    // Ensure agent_id column exists first (needed by insertBudgetWithSourceAndAgent)
    try {
      this.db!.exec(`ALTER TABLE budget_entries ADD COLUMN agent_id TEXT DEFAULT NULL`);
    } catch {
      // Column already exists -- safe to ignore
    }
    this.db!.exec(`CREATE INDEX IF NOT EXISTS idx_budget_agent ON budget_entries(agent_id, timestamp)`);
    try {
      this.db!.exec(`ALTER TABLE budget_entries ADD COLUMN source TEXT DEFAULT 'daemon'`);
    } catch {
      // Column already exists -- safe to ignore
    }
    this.db!.exec(
      `CREATE INDEX IF NOT EXISTS idx_budget_source ON budget_entries(source, timestamp)`,
    );
    // WHAT DID THIS PIECE OF WORK COST (plan 6.1): spend was keyed by source
    // and window only, so no query could attribute a dollar to a task or a
    // campaign. Both are optional — a cost nobody attributed still records.
    for (const column of ["task_id TEXT DEFAULT NULL", "campaign_id TEXT DEFAULT NULL"]) {
      try {
        this.db!.exec(`ALTER TABLE budget_entries ADD COLUMN ${column}`);
      } catch {
        // Column already exists -- safe to ignore
      }
    }
    this.db!.exec(
      `CREATE INDEX IF NOT EXISTS idx_budget_task ON budget_entries(task_id, timestamp)`,
    );
    this.db!.exec(
      `CREATE INDEX IF NOT EXISTS idx_budget_campaign ON budget_entries(campaign_id, timestamp)`,
    );
    this.stmts.sumBudgetForTask = this.db!.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS entries FROM budget_entries WHERE task_id = ?`,
    );
    this.stmts.sumBudgetForCampaign = this.db!.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS entries FROM budget_entries WHERE campaign_id = ?`,
    );


    this.stmts.sumBudgetBySource = this.db!.prepare(
      `SELECT source, COALESCE(SUM(cost_usd), 0) AS total FROM budget_entries WHERE timestamp >= ? GROUP BY source`,
    );
    this.stmts.sumBudgetForSource = this.db!.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM budget_entries WHERE source = ? AND timestamp >= ?`,
    );
    this.stmts.dailyHistory = this.db!.prepare(
      `SELECT date(timestamp / 1000, 'unixepoch') AS day, source, COALESCE(SUM(cost_usd), 0) AS total FROM budget_entries WHERE timestamp >= ? GROUP BY day, source ORDER BY day`,
    );

    this.stmts.insertBudgetWithSourceAndAgent = this.db!.prepare(
      `INSERT INTO budget_entries (cost_usd, model, tokens_in, tokens_out, trigger_name, timestamp, agent_id, source, task_id, campaign_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmts.insertBudgetWithSource = this.db!.prepare(
      `INSERT INTO budget_entries (cost_usd, model, tokens_in, tokens_out, trigger_name, timestamp, source, task_id, campaign_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /**
   * What one task, or one campaign, actually cost (plan 6.1).
   *
   * `entries` is part of the answer: zero entries means nothing was
   * attributed to this work, which is not the same as costing nothing.
   */
  sumBudgetForTask(taskId: string): { totalUsd: number; entries: number } {
    this.assertOpen();
    if (!this.stmts.sumBudgetForTask) {
      throw new Error("Budget source migration not applied. Call migrateBudgetSource() first.");
    }
    const row = this.stmts.sumBudgetForTask.get(taskId) as { total: number; entries: number };
    return { totalUsd: row.total, entries: row.entries };
  }

  /** What every task of one campaign cost together (plan 6.1). */
  sumBudgetForCampaign(campaignId: string): { totalUsd: number; entries: number } {
    this.assertOpen();
    if (!this.stmts.sumBudgetForCampaign) {
      throw new Error("Budget source migration not applied. Call migrateBudgetSource() first.");
    }
    const row = this.stmts.sumBudgetForCampaign.get(campaignId) as { total: number; entries: number };
    return { totalUsd: row.total, entries: row.entries };
  }

  /** Insert a budget cost entry with an agent_id (multi-agent support) */
  insertBudgetEntryWithAgent(entry: Omit<BudgetEntry, "id"> & { agentId: string }): void {
    this.assertOpen();
    if (!this.stmts.insertBudgetWithAgent) {
      throw new Error("Agent budget migration not applied. Call migrateAgentBudget() first.");
    }
    this.stmts.insertBudgetWithAgent.run(
      entry.costUsd,
      entry.model ?? null,
      entry.tokensIn ?? null,
      entry.tokensOut ?? null,
      entry.triggerName ?? null,
      entry.timestamp,
      entry.agentId,
    );
  }

  /** Sum budget entries for a specific agent since a timestamp */
  sumBudgetSinceForAgent(windowStart: number, agentId: string): number {
    this.assertOpen();
    if (!this.stmts.sumBudgetForAgent) {
      throw new Error("Agent budget migration not applied. Call migrateAgentBudget() first.");
    }
    const row = this.stmts.sumBudgetForAgent.get(agentId, windowStart) as SumRow;
    return row.total ?? 0;
  }

  /** Sum budget entries grouped by agent_id since a timestamp */
  sumBudgetGroupByAgent(windowStart: number): Map<string, number> {
    this.assertOpen();
    if (!this.stmts.sumBudgetGroupByAgent) {
      throw new Error("Agent budget migration not applied. Call migrateAgentBudget() first.");
    }
    const rows = this.stmts.sumBudgetGroupByAgent.all(windowStart) as Array<{ agent_id: string; total: number }>;
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.agent_id, row.total ?? 0);
    }
    return map;
  }

  /** Get recent budget entries ordered by timestamp desc */
  getRecentBudgetEntries(limit = 50): BudgetEntry[] {
    this.assertOpen();
    const rows = this.stmts.recentBudget!.all(limit) as BudgetRow[];
    return rows.map(this.rowToBudgetEntry);
  }

  /** Sum budget entries grouped by source since a timestamp */
  sumBudgetBySource(windowStart: number): Record<string, number> {
    this.assertOpen();
    if (!this.stmts.sumBudgetBySource) {
      throw new Error("Budget source migration not applied. Call migrateBudgetSource() first.");
    }
    const rows = this.stmts.sumBudgetBySource.all(windowStart) as Array<{ source: string; total: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) result[row.source ?? "daemon"] = row.total;
    return result;
  }

  /** Sum budget entries for a specific source since a timestamp */
  sumBudgetForSource(source: string, windowStart: number): number {
    this.assertOpen();
    if (!this.stmts.sumBudgetForSource) {
      throw new Error("Budget source migration not applied. Call migrateBudgetSource() first.");
    }
    const row = this.stmts.sumBudgetForSource.get(source, windowStart) as { total: number };
    return row.total;
  }

  /** Get daily budget history grouped by source since a timestamp */
  getDailyHistory(windowStart: number): Array<{ day: string; source: string; total: number }> {
    this.assertOpen();
    if (!this.stmts.dailyHistory) {
      throw new Error("Budget source migration not applied. Call migrateBudgetSource() first.");
    }
    return this.stmts.dailyHistory.all(windowStart) as Array<{ day: string; source: string; total: number }>;
  }

  /** Insert a budget cost entry with a source field */
  // ---------------------------------------------------------------------------
  // PENDING LIABILITY (round 8 #2)
  // ---------------------------------------------------------------------------

  /** Serialize wallet reads and writes across connections; roll back every write on failure. */
  budgetTransaction<T>(work: () => T): T {
    this.assertOpen();
    return this.db!.transaction(work).immediate();
  }

  /** Record (or update) an in-flight reservation, owned by this process. */
  upsertBudgetReservation(row: {
    id: string;
    source: string;
    sourceId?: string | null;
    estimateUsd: number;
    chargedUsd: number;
    ownerPid: number;
    ownerGeneration?: string | null;
    createdAt: number;
    lastActivityAt?: number | null;
  }): void {
    this.assertOpen();
    this.stmts.upsertReservation!.run(
      row.id, row.source, row.sourceId ?? null, row.estimateUsd, row.chargedUsd,
      row.ownerPid, row.createdAt, row.lastActivityAt ?? null, row.ownerGeneration ?? null,
    );
  }

  /** Book progress against a persisted reservation. */
  chargeBudgetReservation(id: string, chargedUsd: number, lastActivityAt: number): void {
    this.assertOpen();
    this.stmts.chargeReservation!.run(chargedUsd, lastActivityAt, id);
  }

  /** Explicitly release a reservation. Recovery retains it as an estimate. */
  deleteBudgetReservation(id: string): void {
    this.assertOpen();
    this.stmts.deleteReservation!.run(id);
  }

  /**
   * Register/refresh this process incarnation as a live wallet owner (round 10 #7).
   * Keyed by PID: a PID hosts one process at a time, so an upsert by a newer
   * incarnation is what proves the previous one on that PID is gone.
   */
  touchBudgetOwner(ownerPid: number, ownerGeneration: string, now: number): void {
    this.assertOpen();
    this.stmts.touchOwner!.run(ownerPid, ownerGeneration, now);
  }

  /** Registered wallet owners with their last heartbeat. */
  listBudgetOwners(): Array<{ ownerPid: number; ownerGeneration: string; heartbeatAt: number }> {
    this.assertOpen();
    const rows = this.stmts.allOwners!.all() as Array<{ owner_pid: number; owner_generation: string; heartbeat_at: number }>;
    return rows.map((r) => ({ ownerPid: r.owner_pid, ownerGeneration: r.owner_generation, heartbeatAt: r.heartbeat_at }));
  }

  /** Forget owners that stopped heartbeating long ago, so the registry stays bounded. */
  pruneBudgetOwners(heartbeatBefore: number): void {
    this.assertOpen();
    this.stmts.pruneOwners!.run(heartbeatBefore);
  }

  /** Claim uncertainty without manufacturing a provider charge. Caller holds the wallet transaction. */
  reconcileBudgetReservation(id: string, now: number): boolean {
    this.assertOpen();
    return this.db!.prepare("UPDATE budget_reservations SET reconciled_at = ? WHERE id = ? AND reconciled_at IS NULL").run(now, id).changes === 1;
  }

  /** Every persisted reservation, including recovered estimates. */
  listBudgetReservations(): Array<{
    id: string;
    source: string;
    sourceId: string | null;
    estimateUsd: number;
    chargedUsd: number;
    ownerPid: number;
    ownerGeneration?: string | null;
    createdAt: number;
    lastActivityAt: number | null;
    reconciledAt: number | null;
  }> {
    this.assertOpen();
    const rows = this.stmts.allReservations!.all() as Array<{
      id: string; source: string; source_id: string | null; estimate_usd: number;
      charged_usd: number; owner_pid: number; owner_generation: string | null; created_at: number; last_activity_at: number | null; reconciled_at: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      sourceId: r.source_id,
      estimateUsd: r.estimate_usd,
      chargedUsd: r.charged_usd,
      ownerPid: r.owner_pid,
      ownerGeneration: r.owner_generation,
      createdAt: r.created_at,
      lastActivityAt: r.last_activity_at,
      reconciledAt: r.reconciled_at,
    }));
  }

  insertBudgetEntryWithSource(entry: {
    costUsd: number;
    model?: string | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    triggerName?: string | null;
    timestamp: number;
    source: string;
    agentId?: string | null;
    taskId?: string | null;
    campaignId?: string | null;
  }): void {
    this.assertOpen();
    if (entry.agentId) {
      // Use agent-aware insert with source
      if (!this.stmts.insertBudgetWithSourceAndAgent) {
        throw new Error("Budget source migration not applied. Call migrateBudgetSource() first.");
      }
      this.stmts.insertBudgetWithSourceAndAgent.run(
        entry.costUsd,
        entry.model ?? null,
        entry.tokensIn ?? null,
        entry.tokensOut ?? null,
        entry.triggerName ?? null,
        entry.timestamp,
        entry.agentId,
        entry.source,
        entry.taskId ?? null,
        entry.campaignId ?? null,
      );
    } else {
      if (!this.stmts.insertBudgetWithSource) {
        throw new Error("Budget source migration not applied. Call migrateBudgetSource() first.");
      }
      this.stmts.insertBudgetWithSource.run(
        entry.costUsd,
        entry.model ?? null,
        entry.tokensIn ?? null,
        entry.tokensOut ?? null,
        entry.triggerName ?? null,
        entry.timestamp,
        entry.source,
        entry.taskId ?? null,
        entry.campaignId ?? null,
      );
    }
  }

  /** Get a budget config value by key */
  getBudgetConfig(key: string): string | undefined {
    this.assertOpen();
    const row = this.stmts.getBudgetConfig!.get(key) as { value: string } | undefined;
    return row?.value;
  }

  /** Set a budget config key-value pair */
  setBudgetConfig(key: string, value: string): void {
    this.assertOpen();
    this.stmts.setBudgetConfig!.run(key, value, Date.now());
  }

  /** Get all budget config entries as a Record */
  getAllBudgetConfig(): Record<string, string> {
    this.assertOpen();
    const rows = this.stmts.getAllBudgetConfig!.all() as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  /** Get a settings override value by key and scope */
  getSettingsOverride(key: string, scope: string = "global"): string | undefined {
    this.assertOpen();
    const row = this.stmts.getSettingsOverride!.get(key, scope) as { value: string } | undefined;
    return row?.value;
  }

  /** Set a settings override value */
  setSettingsOverride(key: string, value: string, scope: string = "global"): void {
    this.assertOpen();
    this.stmts.setSettingsOverride!.run(key, scope, value, Date.now());
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

  /** Delete resolved (non-pending) approval entries older than the given timestamp */
  pruneOldApprovals(olderThan: number): void {
    this.assertOpen();
    this.db!.prepare(
      `DELETE FROM approval_queue WHERE status != 'pending' AND created_at < ?`,
    ).run(olderThan);
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
  // Notification Buffer Methods (Phase 18)
  // =========================================================================

  /** Insert a notification into the quiet hours buffer */
  insertNotificationBuffer(entry: {
    urgency: UrgencyLevel;
    title: string;
    message: string;
    actionHint?: string;
    sourceEvent?: string;
    createdAt: number;
    chatId?: string;
    channelType?: string;
  }): void {
    this.assertOpen();
    this.stmts.insertNotifBuffer!.run(
      entry.urgency,
      entry.title,
      entry.message,
      entry.actionHint ?? null,
      entry.sourceEvent ?? null,
      entry.createdAt,
      entry.chatId ?? null,
      entry.channelType ?? null,
    );
  }

  /** Get all buffered notifications */
  getBufferedNotifications(): BufferedNotification[] {
    this.assertOpen();
    const rows = this.stmts.getNotifBuffer!.all() as NotificationBufferRow[];
    return rows.map(this.rowToBufferedNotification);
  }

  /** Clear all buffered notifications */
  clearNotificationBuffer(): void {
    this.assertOpen();
    this.stmts.clearNotifBuffer!.run();
  }

  /**
   * Prune notification buffer to max size.
   * Drops oldest entries first, but never drops entries with protected urgency levels.
   */
  pruneNotificationBuffer(maxSize: number, protectedLevels: UrgencyLevel[]): void {
    this.assertOpen();
    const all = this.getBufferedNotifications();
    if (all.length <= maxSize) return;

    const toRemove = all.length - maxSize;
    // Sort: unprotected first (oldest first), then protected
    const removable = all.filter((n) => !protectedLevels.includes(n.urgency));
    // Remove oldest removable entries
    const idsToDelete = removable
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, toRemove)
      .map((n) => n.id);

    for (const id of idsToDelete) {
      this.stmts.deleteNotifBufferById!.run(id);
    }
  }

  // =========================================================================
  // Notification History Methods (Phase 18)
  // =========================================================================

  /** Insert a notification history entry */
  insertNotificationHistory(entry: {
    urgency: UrgencyLevel;
    title: string;
    message: string;
    deliveredTo: string[];
    createdAt: number;
  }): void {
    this.assertOpen();
    this.stmts.insertNotifHistory!.run(
      entry.urgency,
      entry.title,
      entry.message,
      JSON.stringify(entry.deliveredTo),
      entry.createdAt,
    );
  }

  /** Get notification history sorted by created_at DESC with optional level filter */
  getNotificationHistory(limit: number, levelFilter?: UrgencyLevel): NotificationHistoryEntry[] {
    this.assertOpen();
    let rows: NotificationHistoryRow[];
    if (levelFilter) {
      rows = this.stmts.getNotifHistoryFiltered!.all(levelFilter, limit) as NotificationHistoryRow[];
    } else {
      rows = this.stmts.getNotifHistory!.all(limit) as NotificationHistoryRow[];
    }
    return rows.map(this.rowToNotificationHistory);
  }

  // =========================================================================
  // Trigger Fire History Methods (Phase 18)
  // =========================================================================

  /** Insert a trigger fire history entry */
  insertTriggerFireHistory(entry: {
    triggerName: string;
    result: "success" | "failure" | "deduplicated";
    durationMs?: number;
    taskId?: string;
    timestamp: number;
  }): void {
    this.assertOpen();
    this.stmts.insertFireHistory!.run(
      entry.triggerName,
      entry.result,
      entry.durationMs ?? null,
      entry.taskId ?? null,
      entry.timestamp,
    );
  }

  /** Get trigger fire history for a specific trigger, sorted by timestamp DESC */
  getTriggerFireHistory(triggerName: string, limit: number): TriggerFireHistoryEntry[] {
    this.assertOpen();
    const rows = this.stmts.getFireHistory!.all(triggerName, limit) as TriggerFireHistoryRow[];
    return rows.map(this.rowToTriggerFireHistory);
  }

  /**
   * Prune trigger fire history entries older than the given retention period.
   * Deletes across all triggers in a single SQL DELETE.
   * @param retentionMs Retention period in milliseconds
   * @returns Number of deleted entries
   */
  pruneTriggerFireHistoryByAge(retentionMs: number): number {
    this.assertOpen();
    const cutoff = Date.now() - retentionMs;
    const result = this.stmts.pruneFireHistoryByAge!.run(cutoff);
    return result.changes;
  }

  /**
   * @deprecated Use pruneTriggerFireHistoryByAge for time-based pruning.
   * Prune trigger fire history, keeping only the most recent entries per trigger.
   */
  pruneTriggerFireHistory(triggerName: string, keepCount: number): void {
    this.assertOpen();
    this.db!.prepare(
      `DELETE FROM trigger_fire_history
       WHERE trigger_name = ? AND id NOT IN (
         SELECT id FROM trigger_fire_history
         WHERE trigger_name = ?
         ORDER BY timestamp DESC
         LIMIT ?
       )`,
    ).run(triggerName, triggerName, keepCount);
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

    // Pending liability (round 8 #2)
    this.stmts.upsertReservation = db.prepare(
      `INSERT INTO budget_reservations (id, source, source_id, estimate_usd, charged_usd, owner_pid, created_at, last_activity_at, owner_generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET estimate_usd = excluded.estimate_usd, charged_usd = excluded.charged_usd, last_activity_at = excluded.last_activity_at`,
    );
    this.stmts.chargeReservation = db.prepare(
      `UPDATE budget_reservations SET charged_usd = ?, last_activity_at = ? WHERE id = ?`,
    );
    this.stmts.deleteReservation = db.prepare(`DELETE FROM budget_reservations WHERE id = ?`);
    this.stmts.allReservations = db.prepare(`SELECT * FROM budget_reservations ORDER BY created_at ASC`);

    // Owner liveness registry (round 10 #7)
    this.stmts.touchOwner = db.prepare(
      `INSERT INTO budget_owners (owner_pid, owner_generation, heartbeat_at) VALUES (?, ?, ?)
       ON CONFLICT(owner_pid) DO UPDATE SET owner_generation = excluded.owner_generation, heartbeat_at = excluded.heartbeat_at`,
    );
    this.stmts.allOwners = db.prepare(`SELECT owner_pid, owner_generation, heartbeat_at FROM budget_owners`);
    this.stmts.pruneOwners = db.prepare(`DELETE FROM budget_owners WHERE heartbeat_at < ?`);
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

    // Notification Buffer (Phase 18)
    this.stmts.insertNotifBuffer = db.prepare(
      `INSERT INTO notification_buffer (urgency, title, message, action_hint, source_event, created_at, chat_id, channel_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmts.getNotifBuffer = db.prepare(
      `SELECT * FROM notification_buffer ORDER BY created_at ASC`,
    );
    this.stmts.clearNotifBuffer = db.prepare(`DELETE FROM notification_buffer`);
    this.stmts.deleteNotifBufferById = db.prepare(
      `DELETE FROM notification_buffer WHERE id = ?`,
    );

    // Notification History (Phase 18)
    this.stmts.insertNotifHistory = db.prepare(
      `INSERT INTO notification_history (urgency, title, message, delivered_to, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.stmts.getNotifHistory = db.prepare(
      `SELECT * FROM notification_history ORDER BY created_at DESC LIMIT ?`,
    );
    this.stmts.getNotifHistoryFiltered = db.prepare(
      `SELECT * FROM notification_history WHERE urgency = ? ORDER BY created_at DESC LIMIT ?`,
    );

    // Trigger Fire History (Phase 18)
    this.stmts.insertFireHistory = db.prepare(
      `INSERT INTO trigger_fire_history (trigger_name, result, duration_ms, task_id, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.stmts.getFireHistory = db.prepare(
      `SELECT * FROM trigger_fire_history WHERE trigger_name = ? ORDER BY timestamp DESC LIMIT ?`,
    );

    // Trigger Fire History Pruning (Phase 21)
    this.stmts.pruneFireHistoryByAge = db.prepare(
      `DELETE FROM trigger_fire_history WHERE timestamp < ?`,
    );

    // Budget Config
    this.stmts.getBudgetConfig = db.prepare(`SELECT value FROM budget_config WHERE key = ?`);
    this.stmts.setBudgetConfig = db.prepare(
      `INSERT OR REPLACE INTO budget_config (key, value, updated_at) VALUES (?, ?, ?)`,
    );
    this.stmts.getAllBudgetConfig = db.prepare(`SELECT key, value FROM budget_config`);

    // Settings Overrides
    this.stmts.getSettingsOverride = db.prepare(
      `SELECT value FROM settings_overrides WHERE key = ? AND scope = ?`,
    );
    this.stmts.setSettingsOverride = db.prepare(
      `INSERT OR REPLACE INTO settings_overrides (key, scope, value, updated_at) VALUES (?, ?, ?, ?)`,
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

  private rowToBufferedNotification(row: NotificationBufferRow): BufferedNotification {
    return {
      id: row.id,
      urgency: row.urgency as UrgencyLevel,
      title: row.title,
      message: row.message,
      actionHint: row.action_hint ?? undefined,
      sourceEvent: row.source_event ?? undefined,
      createdAt: row.created_at,
      ...(row.chat_id ? { chatId: row.chat_id } : {}),
      ...(row.channel_type ? { channelType: row.channel_type } : {}),
    };
  }

  private rowToNotificationHistory(row: NotificationHistoryRow): NotificationHistoryEntry {
    return {
      id: row.id,
      urgency: row.urgency as UrgencyLevel,
      title: row.title,
      message: row.message,
      deliveredTo: row.delivered_to ? (JSON.parse(row.delivered_to) as string[]) : [],
      createdAt: row.created_at,
    };
  }

  private rowToTriggerFireHistory(row: TriggerFireHistoryRow): TriggerFireHistoryEntry {
    return {
      id: row.id,
      triggerName: row.trigger_name,
      result: row.result as "success" | "failure" | "deduplicated",
      durationMs: row.duration_ms ?? undefined,
      taskId: row.task_id ?? undefined,
      timestamp: row.timestamp,
    };
  }
}
