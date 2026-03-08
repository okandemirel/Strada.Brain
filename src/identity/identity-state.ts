/**
 * Identity State Manager
 *
 * Persists agent identity (UUID, boot count, cumulative uptime, activity
 * timestamps, message/task counts) in SQLite. Provides crash detection
 * via a clean_shutdown flag.
 *
 * Uses key-value schema for flexibility and forward-compatibility.
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

const DEFAULT_KEYS: Record<string, string> = {
  agent_uuid: "",
  agent_name: "Strata Brain",
  first_boot_ts: "0",
  boot_count: "0",
  cumulative_uptime_ms: "0",
  last_activity_ts: "0",
  total_messages: "0",
  total_tasks: "0",
  project_context: "",
  clean_shutdown: "true",
};

/**
 * Manages persistent agent identity state in SQLite.
 */
export class IdentityStateManager {
  private db: Database.Database | null = null;
  private bootStartTime: number = 0;
  private crashDetected: boolean = false;
  private readonly agentName: string;

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
    if (resolved.includes("..")) {
      throw new Error("IdentityStateManager: path traversal not allowed");
    }
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
    const uuid = this.getValue("agent_uuid");
    if (!uuid) {
      const newUuid = randomUUID();
      const bootTs = Date.now().toString();
      this.setValue("agent_uuid", newUuid);
      this.setValue("first_boot_ts", bootTs);
      this.setValue("agent_name", this.agentName);
    }
  }

  /**
   * Record a new boot. Increments boot_count, sets clean_shutdown to false,
   * and captures whether the previous session crashed.
   */
  recordBoot(): void {
    this.bootStartTime = Date.now();

    // Check if previous session crashed (clean_shutdown was false)
    const prevClean = this.getValue("clean_shutdown");
    this.crashDetected = prevClean === "false";

    // Increment boot count
    const currentCount = parseInt(this.getValue("boot_count") ?? "0", 10);
    this.setValue("boot_count", (currentCount + 1).toString());

    // Mark this boot as started (not yet cleanly shut down)
    this.setValue("clean_shutdown", "false");

    // Update last activity
    this.setValue("last_activity_ts", Date.now().toString());
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
    const current = parseInt(this.getValue("cumulative_uptime_ms") ?? "0", 10);
    this.setValue("cumulative_uptime_ms", (current + deltaMs).toString());
  }

  /**
   * Update last_activity_ts to current time.
   */
  recordActivity(): void {
    this.setValue("last_activity_ts", Date.now().toString());
  }

  /**
   * Increment total_messages counter.
   */
  incrementMessages(): void {
    const current = parseInt(this.getValue("total_messages") ?? "0", 10);
    this.setValue("total_messages", (current + 1).toString());
  }

  /**
   * Increment total_tasks counter.
   */
  incrementTasks(): void {
    const current = parseInt(this.getValue("total_tasks") ?? "0", 10);
    this.setValue("total_tasks", (current + 1).toString());
  }

  /**
   * Set the project context path.
   */
  setProjectContext(path: string): void {
    this.setValue("project_context", path);
  }

  /**
   * Record a clean shutdown. Calculates final uptime delta from boot start,
   * adds it to cumulative_uptime_ms, and sets clean_shutdown=true.
   */
  recordShutdown(): void {
    if (this.bootStartTime > 0) {
      const delta = Date.now() - this.bootStartTime;
      this.updateUptime(delta);
      this.bootStartTime = 0;
    }
    this.setValue("clean_shutdown", "true");
  }

  /**
   * Read all identity keys and return a typed IdentityState object.
   */
  getState(): IdentityState {
    return {
      agentUuid: this.getValue("agent_uuid") ?? "",
      agentName: this.getValue("agent_name") ?? "Strata Brain",
      firstBootTs: parseInt(this.getValue("first_boot_ts") ?? "0", 10),
      bootCount: parseInt(this.getValue("boot_count") ?? "0", 10),
      cumulativeUptimeMs: parseInt(this.getValue("cumulative_uptime_ms") ?? "0", 10),
      lastActivityTs: parseInt(this.getValue("last_activity_ts") ?? "0", 10),
      totalMessages: parseInt(this.getValue("total_messages") ?? "0", 10),
      totalTasks: parseInt(this.getValue("total_tasks") ?? "0", 10),
      projectContext: this.getValue("project_context") ?? "",
      cleanShutdown: this.getValue("clean_shutdown") === "true",
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.stmtGet = null;
    this.stmtSet = null;
    this.db?.close();
    this.db = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getValue(key: string): string | undefined {
    const row = this.stmtGet?.get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setValue(key: string, value: string): void {
    this.stmtSet?.run(key, value, new Date().toISOString());
  }
}
