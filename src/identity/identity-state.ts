/**
 * Identity State Manager
 *
 * Persists agent identity (UUID, boot count, cumulative uptime, activity
 * timestamps, message/task counts) in SQLite. Provides crash detection
 * via a clean_shutdown flag.
 *
 * Uses key-value schema for flexibility and forward-compatibility.
 * Counters are cached in memory and flushed periodically to minimize
 * per-message SQLite writes.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { configureSqlitePragmas } from "../memory/unified/sqlite-pragmas.js";

/** Typed identity state returned by getState() */
export interface IdentityState {
  agentUuid: string;
  agentName: string;
  firstBootTs: number; // epoch ms
  bootCount: number;
  cumulativeUptimeMs: number;
  lastActivityTs: number; // epoch ms
  totalMessages: number;
  totalTasks: number;
  projectContext: string;
  cleanShutdown: boolean;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS identity_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Single source of truth for SQLite key names. */
const K = {
  uuid: "agent_uuid",
  name: "agent_name",
  firstBoot: "first_boot_ts",
  bootCount: "boot_count",
  uptime: "cumulative_uptime_ms",
  lastActivity: "last_activity_ts",
  messages: "total_messages",
  tasks: "total_tasks",
  project: "project_context",
  cleanShutdown: "clean_shutdown",
} as const;

const DEFAULT_KEYS: Record<string, string> = {
  [K.uuid]: "",
  [K.name]: "Strata Brain",
  [K.firstBoot]: "0",
  [K.bootCount]: "0",
  [K.uptime]: "0",
  [K.lastActivity]: "0",
  [K.messages]: "0",
  [K.tasks]: "0",
  [K.project]: "",
  [K.cleanShutdown]: "true",
};

/**
 * Manages persistent agent identity state in SQLite.
 */
export class IdentityStateManager {
  private db: Database.Database | null = null;
  private bootStartTime: number = 0;
  private crashDetected: boolean = false;
  private readonly agentName: string;

  // In-memory counter cache — flushed on shutdown and periodic intervals
  private cache: Map<string, string> = new Map();
  private dirty: Set<string> = new Set();

  // Prepared statements
  private stmtGet: Database.Statement | null = null;
  private stmtSet: Database.Statement | null = null;

  constructor(
    private readonly dbPath: string,
    agentName?: string,
  ) {
    this.agentName = agentName ?? "Strata Brain";
  }

  /**
   * Open database, apply pragmas, create schema, and seed defaults on first boot.
   */
  initialize(): void {
    const resolved = resolve(this.dbPath);
    const dir = dirname(resolved);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolved);
    configureSqlitePragmas(this.db, "identity");
    this.db.exec(SCHEMA_SQL);

    // Prepare statements
    this.stmtGet = this.db.prepare("SELECT value FROM identity_state WHERE key = ?");
    this.stmtSet = this.db.prepare(
      "INSERT OR REPLACE INTO identity_state (key, value, updated_at) VALUES (?, ?, ?)",
    );

    // Seed defaults for any missing keys
    const now = new Date().toISOString();
    for (const [key, defaultValue] of Object.entries(DEFAULT_KEYS)) {
      const existing = this.stmtGet.get(key) as { value: string } | undefined;
      if (!existing) {
        this.stmtSet.run(key, defaultValue, now);
      }
    }

    // On first boot, generate UUID and set first_boot_ts
    const uuid = this.readDb(K.uuid);
    if (!uuid) {
      const newUuid = randomUUID();
      const bootTs = Date.now().toString();
      this.writeDb(K.uuid, newUuid);
      this.writeDb(K.firstBoot, bootTs);
      this.writeDb(K.name, this.agentName);
    }

    // Load all values into in-memory cache
    this.loadCache();
  }

  /**
   * Record a new boot. Increments boot_count, sets clean_shutdown to false,
   * and captures whether the previous session crashed.
   */
  recordBoot(): void {
    this.bootStartTime = Date.now();

    // Check if previous session crashed (clean_shutdown was false)
    const prevClean = this.getCached(K.cleanShutdown);
    this.crashDetected = prevClean === "false";

    // Increment boot count
    this.incrementValue(K.bootCount);

    // Mark this boot as started (not yet cleanly shut down)
    this.setCached(K.cleanShutdown, "false");

    // Update last activity
    this.setCached(K.lastActivity, Date.now().toString());

    // Flush boot-critical state immediately
    this.flush();
  }

  /**
   * Returns true if the previous session did not shut down cleanly.
   */
  wasCrash(): boolean {
    return this.crashDetected;
  }

  /**
   * Atomically increment cumulative uptime by deltaMs milliseconds.
   */
  updateUptime(deltaMs: number): void {
    this.incrementValue(K.uptime, deltaMs);
  }

  /**
   * Update last_activity_ts to current time.
   */
  recordActivity(): void {
    this.setCached(K.lastActivity, Date.now().toString());
  }

  /**
   * Increment total_messages counter.
   */
  incrementMessages(): void {
    this.incrementValue(K.messages);
  }

  /**
   * Increment total_tasks counter.
   */
  incrementTasks(): void {
    this.incrementValue(K.tasks);
  }

  /**
   * Set the project context path.
   */
  setProjectContext(path: string): void {
    this.setCached(K.project, path);
  }

  /**
   * Record a clean shutdown. Calculates final uptime delta from boot start,
   * adds it to cumulative_uptime_ms, and sets clean_shutdown=true.
   */
  recordShutdown(): void {
    if (this.bootStartTime > 0) {
      const delta = Date.now() - this.bootStartTime;
      this.incrementValue(K.uptime, delta);
      this.bootStartTime = 0;
    }
    this.setCached(K.cleanShutdown, "true");
    this.flush();
  }

  /**
   * Read all identity keys and return a typed IdentityState object.
   * Uses in-memory cache — no SQLite reads.
   */
  getState(): IdentityState {
    return {
      agentUuid: this.getCached(K.uuid) ?? "",
      agentName: this.getCached(K.name) ?? "Strata Brain",
      firstBootTs: parseInt(this.getCached(K.firstBoot) ?? "0", 10),
      bootCount: parseInt(this.getCached(K.bootCount) ?? "0", 10),
      cumulativeUptimeMs: parseInt(this.getCached(K.uptime) ?? "0", 10),
      lastActivityTs: parseInt(this.getCached(K.lastActivity) ?? "0", 10),
      totalMessages: parseInt(this.getCached(K.messages) ?? "0", 10),
      totalTasks: parseInt(this.getCached(K.tasks) ?? "0", 10),
      projectContext: this.getCached(K.project) ?? "",
      cleanShutdown: this.getCached(K.cleanShutdown) === "true",
    };
  }

  /**
   * Flush all dirty in-memory values to SQLite.
   */
  flush(): void {
    if (this.dirty.size === 0) return;
    const now = new Date().toISOString();
    for (const key of this.dirty) {
      const value = this.cache.get(key);
      if (value !== undefined) {
        this.stmtSet?.run(key, value, now);
      }
    }
    this.dirty.clear();
  }

  /**
   * Close the database connection. Flushes pending writes first.
   */
  close(): void {
    this.flush();
    this.stmtGet = null;
    this.stmtSet = null;
    this.db?.close();
    this.db = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Load all rows from SQLite into the in-memory cache. */
  private loadCache(): void {
    if (!this.db) return;
    const rows = this.db.prepare("SELECT key, value FROM identity_state").all() as Array<{ key: string; value: string }>;
    this.cache.clear();
    for (const row of rows) {
      this.cache.set(row.key, row.value);
    }
  }

  /** Read a value from in-memory cache. */
  private getCached(key: string): string | undefined {
    return this.cache.get(key);
  }

  /** Set a value in cache and mark as dirty for next flush. */
  private setCached(key: string, value: string): void {
    this.cache.set(key, value);
    this.dirty.add(key);
  }

  /** Increment a numeric counter in cache by the given amount. */
  private incrementValue(key: string, by: number = 1): void {
    const current = parseInt(this.getCached(key) ?? "0", 10);
    this.setCached(key, (current + by).toString());
  }

  /** Read directly from SQLite (used during initialization only). */
  private readDb(key: string): string | undefined {
    const row = this.stmtGet?.get(key) as { value: string } | undefined;
    return row?.value;
  }

  /** Write directly to SQLite (used during initialization only). */
  private writeDb(key: string, value: string): void {
    this.stmtSet?.run(key, value, new Date().toISOString());
  }
}
