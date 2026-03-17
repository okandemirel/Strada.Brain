/**
 * Agent Registry
 *
 * SQLite-backed persistence for agent instance state. Provides CRUD operations
 * with prepared statements following the DaemonStorage pattern.
 *
 * The agents table stores runtime agent state (id, key, channel, status, budget).
 * A composite unique index on `key` (channelType:chatId) prevents duplicates.
 *
 * Requirements: AGENT-01 (session isolation)
 */

import type Database from "better-sqlite3";
import type { AgentId, AgentInstance, AgentStatus } from "./agent-types.js";

// =============================================================================
// SCHEMA
// =============================================================================

const AGENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  channel_type TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  budget_cap_usd REAL NOT NULL,
  memory_entry_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agents_key ON agents(key);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
`;

// =============================================================================
// ROW TYPE
// =============================================================================

interface AgentRow {
  id: string;
  key: string;
  channel_type: string;
  chat_id: string;
  status: string;
  created_at: number;
  last_activity: number;
  budget_cap_usd: number;
  memory_entry_count: number;
}

// =============================================================================
// REGISTRY CLASS
// =============================================================================

export class AgentRegistry {
  private readonly db: Database.Database;
  private stmts: {
    upsert?: Database.Statement;
    getByKey?: Database.Statement;
    getById?: Database.Statement;
    getAll?: Database.Statement;
    updateStatus?: Database.Statement;
    updateLastActivity?: Database.Statement;
    updateMemoryCount?: Database.Statement;
    deleteAgent?: Database.Statement;
    count?: Database.Statement;
  } = {};

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Create the agents table and prepare statements */
  initialize(): void {
    this.db.exec(AGENTS_SCHEMA_SQL);
    this.prepareStatements();
  }

  /** Upsert agent instance (insert or update on key conflict) */
  upsert(agent: AgentInstance): void {
    this.stmts.upsert!.run(
      agent.id,
      agent.key,
      agent.channelType,
      agent.chatId,
      agent.status,
      agent.createdAt,
      agent.lastActivity,
      agent.budgetCapUsd,
      agent.memoryEntryCount,
    );
  }

  /** Get agent by composite key (channelType:chatId) */
  getByKey(key: string): AgentInstance | undefined {
    const row = this.stmts.getByKey!.get(key) as AgentRow | undefined;
    return row ? this.rowToAgent(row) : undefined;
  }

  /** Get agent by id */
  getById(id: AgentId): AgentInstance | undefined {
    const row = this.stmts.getById!.get(id) as AgentRow | undefined;
    return row ? this.rowToAgent(row) : undefined;
  }

  /** Get all agents */
  getAll(): AgentInstance[] {
    const rows = this.stmts.getAll!.all() as AgentRow[];
    return rows.map(this.rowToAgent);
  }

  /** Update agent status */
  updateStatus(id: AgentId, status: AgentStatus): void {
    this.stmts.updateStatus!.run(status, id);
  }

  /** Update last activity timestamp */
  updateLastActivity(id: AgentId, timestamp: number): void {
    this.stmts.updateLastActivity!.run(timestamp, id);
  }

  /** Update memory entry count */
  updateMemoryCount(id: AgentId, count: number): void {
    this.stmts.updateMemoryCount!.run(count, id);
  }

  /** Delete agent by id */
  delete(id: AgentId): void {
    this.stmts.deleteAgent!.run(id);
  }

  /** Get total agent count */
  count(): number {
    const row = this.stmts.count!.get() as { cnt: number };
    return row.cnt;
  }

  // =========================================================================
  // Private
  // =========================================================================

  private prepareStatements(): void {
    this.stmts.upsert = this.db.prepare(
      `INSERT INTO agents (id, key, channel_type, chat_id, status, created_at, last_activity, budget_cap_usd, memory_entry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         chat_id = excluded.chat_id,
         status = excluded.status,
         last_activity = excluded.last_activity,
         budget_cap_usd = excluded.budget_cap_usd,
         memory_entry_count = excluded.memory_entry_count`,
    );
    this.stmts.getByKey = this.db.prepare(`SELECT * FROM agents WHERE key = ?`);
    this.stmts.getById = this.db.prepare(`SELECT * FROM agents WHERE id = ?`);
    this.stmts.getAll = this.db.prepare(`SELECT * FROM agents ORDER BY created_at ASC`);
    this.stmts.updateStatus = this.db.prepare(`UPDATE agents SET status = ? WHERE id = ?`);
    this.stmts.updateLastActivity = this.db.prepare(`UPDATE agents SET last_activity = ? WHERE id = ?`);
    this.stmts.updateMemoryCount = this.db.prepare(`UPDATE agents SET memory_entry_count = ? WHERE id = ?`);
    this.stmts.deleteAgent = this.db.prepare(`DELETE FROM agents WHERE id = ?`);
    this.stmts.count = this.db.prepare(`SELECT COUNT(*) AS cnt FROM agents`);
  }

  private rowToAgent(row: AgentRow): AgentInstance {
    return {
      id: row.id as AgentId,
      key: row.key,
      channelType: row.channel_type as AgentInstance["channelType"],
      chatId: row.chat_id,
      status: row.status as AgentStatus,
      createdAt: row.created_at,
      lastActivity: row.last_activity,
      budgetCapUsd: row.budget_cap_usd,
      memoryEntryCount: row.memory_entry_count,
    };
  }
}
