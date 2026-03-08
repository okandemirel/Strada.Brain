/**
 * Learning Storage
 * 
 * SQLite-based persistent storage for the learning system with performance optimizations:
 * - Prepared statement caching
 * - Batch insert operations
 * - Optimized indexes
 * - Connection pooling
 * - WAL mode for better concurrency
 */

import Database from "better-sqlite3";
import { configureSqlitePragmas } from "../../memory/unified/sqlite-pragmas.js";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Instinct,
  InstinctId,
  InstinctStatus,
  Trajectory,
  TrajectoryId,
  TrajectoryStep,
  TrajectoryOutcome,
  ErrorPattern,
  ErrorPatternId,
  Solution,
  Observation,
  ObservationId,
  Verdict,
  ContextCondition,
  ErrorDetails,
  InstinctStats,
  ErrorCategory,
} from "../types.js";
import type { SessionId, TimestampMs, JsonObject } from "../../types/index.js";
import { createBrand } from "../../types/index.js";
import type { IEventBus } from "../../core/event-bus.js";

// ─── Database Schema ────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
-- Core instincts table
CREATE TABLE IF NOT EXISTS instincts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('error_fix', 'tool_usage', 'correction', 'verification', 'optimization', 'tool_chain')),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'active', 'deprecated', 'evolved', 'permanent')),
  confidence REAL NOT NULL DEFAULT 0.0 CHECK(confidence >= 0.0 AND confidence <= 1.0),
  trigger_pattern TEXT NOT NULL,
  action TEXT NOT NULL,
  context_conditions TEXT NOT NULL, -- JSON array
  stats TEXT NOT NULL, -- JSON object
  embedding TEXT, -- JSON-serialized float array for semantic search
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  evolved_to TEXT,
  bayesian_alpha REAL DEFAULT 1.0,
  bayesian_beta REAL DEFAULT 1.0,
  cooling_started_at INTEGER,
  cooling_failures INTEGER DEFAULT 0
);

-- Trajectories table (experience replay)
CREATE TABLE IF NOT EXISTS trajectories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_description TEXT NOT NULL,
  steps TEXT NOT NULL, -- JSON array of TrajectoryStep
  outcome TEXT NOT NULL, -- JSON object
  applied_instinct_ids TEXT NOT NULL, -- JSON array
  created_at INTEGER NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0
);

-- Many-to-many: trajectories ↔ instincts
CREATE TABLE IF NOT EXISTS trajectory_instincts (
  trajectory_id TEXT NOT NULL,
  instinct_id TEXT NOT NULL,
  PRIMARY KEY (trajectory_id, instinct_id),
  FOREIGN KEY (trajectory_id) REFERENCES trajectories(id) ON DELETE CASCADE,
  FOREIGN KEY (instinct_id) REFERENCES instincts(id) ON DELETE CASCADE
) WITHOUT ROWID; -- Optimization: no rowid for junction table

-- Error patterns table
CREATE TABLE IF NOT EXISTS error_patterns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  code_pattern TEXT,
  message_pattern TEXT NOT NULL UNIQUE,
  file_patterns TEXT NOT NULL, -- JSON array
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  solution_instinct_id TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  FOREIGN KEY (solution_instinct_id) REFERENCES instincts(id) ON DELETE SET NULL
);

-- Solutions table
CREATE TABLE IF NOT EXISTS solutions (
  id TEXT PRIMARY KEY,
  error_pattern_id TEXT,
  description TEXT NOT NULL,
  action TEXT NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  total_attempts INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 0.0,
  created_at INTEGER NOT NULL,
  last_used INTEGER,
  FOREIGN KEY (error_pattern_id) REFERENCES error_patterns(id) ON DELETE SET NULL
);

-- Observations table (raw data for learning)
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('tool_use', 'correction', 'error', 'success')),
  session_id TEXT NOT NULL,
  tool_name TEXT,
  input TEXT, -- JSON
  output TEXT,
  success INTEGER,
  error_details TEXT, -- JSON
  correction TEXT,
  timestamp INTEGER NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0
);

-- Verdicts table (trajectory evaluation)
CREATE TABLE IF NOT EXISTS verdicts (
  id TEXT PRIMARY KEY,
  trajectory_id TEXT NOT NULL,
  judge_type TEXT NOT NULL CHECK(judge_type IN ('human', 'automated', 'self')),
  score REAL NOT NULL CHECK(score >= 0.0 AND score <= 1.0),
  dimensions TEXT NOT NULL, -- JSON
  feedback TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (trajectory_id) REFERENCES trajectories(id) ON DELETE CASCADE
);

-- Evolution proposals table
CREATE TABLE IF NOT EXISTS evolution_proposals (
  id TEXT PRIMARY KEY,
  instinct_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('skill', 'command', 'agent')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  confidence REAL NOT NULL,
  implementation TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'implemented')),
  proposed_at INTEGER NOT NULL,
  decided_at INTEGER,
  FOREIGN KEY (instinct_id) REFERENCES instincts(id) ON DELETE CASCADE
);

-- Optimized indexes for common queries
CREATE INDEX IF NOT EXISTS idx_instincts_status_confidence ON instincts(status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_instincts_type_status ON instincts(type, status);
CREATE INDEX IF NOT EXISTS idx_trajectories_session_processed ON trajectories(session_id, processed);
CREATE INDEX IF NOT EXISTS idx_trajectories_created ON trajectories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_patterns_category_count ON error_patterns(category, occurrence_count DESC);
CREATE INDEX IF NOT EXISTS idx_error_patterns_message ON error_patterns(message_pattern);
CREATE INDEX IF NOT EXISTS idx_observations_type_processed ON observations(type, processed);
CREATE INDEX IF NOT EXISTS idx_observations_timestamp ON observations(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_verdicts_trajectory ON verdicts(trajectory_id);
CREATE INDEX IF NOT EXISTS idx_solutions_pattern ON solutions(error_pattern_id);

-- Full-text search for message patterns (if available)
CREATE VIRTUAL TABLE IF NOT EXISTS error_patterns_fts USING fts5(
  message_pattern,
  content='error_patterns',
  content_rowid='rowid'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS error_patterns_ai AFTER INSERT ON error_patterns BEGIN
  INSERT INTO error_patterns_fts(rowid, message_pattern) VALUES (new.rowid, new.message_pattern);
END;

CREATE TRIGGER IF NOT EXISTS error_patterns_ad AFTER DELETE ON error_patterns BEGIN
  INSERT INTO error_patterns_fts(error_patterns_fts, rowid, message_pattern) VALUES ('delete', old.rowid, old.message_pattern);
END;

CREATE TRIGGER IF NOT EXISTS error_patterns_au AFTER UPDATE ON error_patterns BEGIN
  INSERT INTO error_patterns_fts(error_patterns_fts, rowid, message_pattern) VALUES ('delete', old.rowid, old.message_pattern);
  INSERT INTO error_patterns_fts(rowid, message_pattern) VALUES (new.rowid, new.message_pattern);
END;
`;

// ─── Storage Class ──────────────────────────────────────────────────────────────

export class LearningStorage {
  private db: Database.Database | null = null;
  private dbPath: string;
  
  // Prepared statement cache
  private statements: Map<string, Database.Statement> = new Map();
  
  // Batch insert buffer
  private observationBuffer: Observation[] = [];
  private trajectoryBuffer: Trajectory[] = [];
  private readonly BATCH_SIZE = 100;

  // Cross-session hit count dedup: tracks last counted session per instinct
  private readonly lastCountedSession = new Map<string, string>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(dbPath: string = "./data/learning.db") {
    this.dbPath = dbPath;
  }

  /** Initialize the database connection and schema */
  initialize(): void {
    const dir = dirname(this.dbPath);
    if (dir && dir !== ".") {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(this.dbPath);
    
    // Standardized pragma configuration (16MB cache, 5s busy_timeout)
    configureSqlitePragmas(this.db, "learning");
    
    // Execute schema
    this.db.exec(SCHEMA_SQL);

    // Run schema migrations for existing databases
    this.migrateSchema();

    // Prepare commonly used statements
    this.prepareStatements();

    // Start batch flush timer
    this.startBatchFlushTimer();
  }

  /**
   * Apply schema migrations for existing databases.
   * Idempotent — safe to call on every startup.
   */
  private migrateSchema(): void {
    if (!this.db) return;

    // Phase 3 migration: embedding column
    try {
      this.db.exec("ALTER TABLE instincts ADD COLUMN embedding TEXT");
    } catch {
      // Column already exists — expected after first migration
    }

    // Phase 6 migration: Bayesian columns
    const bayesianColumns = [
      "ALTER TABLE instincts ADD COLUMN bayesian_alpha REAL DEFAULT 1.0",
      "ALTER TABLE instincts ADD COLUMN bayesian_beta REAL DEFAULT 1.0",
      "ALTER TABLE instincts ADD COLUMN cooling_started_at INTEGER",
      "ALTER TABLE instincts ADD COLUMN cooling_failures INTEGER DEFAULT 0",
    ];
    for (const sql of bayesianColumns) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists — expected after first migration
      }
    }

    // Phase 13 migration: cross-session provenance columns
    const provenanceColumns = [
      "ALTER TABLE instincts ADD COLUMN origin_session_id TEXT",
      "ALTER TABLE instincts ADD COLUMN origin_boot_count INTEGER",
      "ALTER TABLE instincts ADD COLUMN cross_session_hit_count INTEGER DEFAULT 0",
      "ALTER TABLE instincts ADD COLUMN migrated_at INTEGER",
    ];
    for (const sql of provenanceColumns) {
      try {
        this.db.prepare(sql).run();
      } catch {
        // Column already exists -- expected after first migration
      }
    }

    // Phase 13: instinct_scopes table for project-scope filtering
    this.db.prepare(`CREATE TABLE IF NOT EXISTS instinct_scopes (
      instinct_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (instinct_id, project_path),
      FOREIGN KEY (instinct_id) REFERENCES instincts(id) ON DELETE CASCADE
    ) WITHOUT ROWID`).run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_instinct_scopes_path ON instinct_scopes(project_path, instinct_id)").run();

    // Phase 6: Migrate CHECK constraint to include 'permanent' and 'optimization'
    this.migrateStatusConstraint();

    // Phase 9: Migrate CHECK constraint on type to include 'tool_chain'
    this.migrateTypeConstraint();

    // Phase 6: Derive alpha/beta from existing stats for migrated instincts
    try {
      this.db.exec(`
        UPDATE instincts
        SET bayesian_alpha = (COALESCE(json_extract(stats, '$.timesApplied'), 0) + 1),
            bayesian_beta = (COALESCE(json_extract(stats, '$.timesFailed'), 0) + 1)
        WHERE bayesian_alpha = 1.0 AND bayesian_beta = 1.0
          AND (COALESCE(json_extract(stats, '$.timesApplied'), 0) > 0
               OR COALESCE(json_extract(stats, '$.timesFailed'), 0) > 0)
      `);
    } catch {
      // Stats extraction failed — leave defaults
    }

    // Phase 6: Create lifecycle log table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instinct_lifecycle_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instinct_id TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        confidence_at_transition REAL NOT NULL,
        bayesian_alpha REAL NOT NULL,
        bayesian_beta REAL NOT NULL,
        observation_count INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lifecycle_log_instinct ON instinct_lifecycle_log(instinct_id, timestamp DESC);
    `);

    // Phase 6: Create weekly counters table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instinct_weekly_counters (
        week_start INTEGER NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('promoted', 'deprecated', 'cooling_started', 'cooling_recovered')),
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (week_start, event_type)
      ) WITHOUT ROWID;
    `);
  }

  /**
   * Migrate the CHECK constraint on instincts.status to include 'permanent'.
   * Uses table recreation since SQLite cannot ALTER CHECK constraints.
   * Idempotent — only runs if 'permanent' is not already valid.
   */
  private migrateStatusConstraint(): void {
    if (!this.db) return;

    // Check if 'permanent' is already accepted
    try {
      this.db.exec("INSERT INTO instincts (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, created_at, updated_at) VALUES ('__check_permanent__', '__test__', 'error_fix', 'permanent', 0.5, '__test__', '__test__', '[]', '{}', 0, 0)");
      // If we get here, 'permanent' is already in CHECK — delete test row and return
      this.db.exec("DELETE FROM instincts WHERE id = '__check_permanent__'");
      return;
    } catch {
      // 'permanent' not valid — proceed with migration
    }

    // Temporarily disable FK checks for table recreation (standard SQLite practice)
    // legacy_alter_table prevents SQLite from updating FK references in other tables
    // when we rename instincts -> instincts_old (prevents stale FK references)
    this.db.pragma("foreign_keys = OFF");
    this.db.pragma("legacy_alter_table = ON");
    this.db.exec("BEGIN TRANSACTION");
    try {
      this.db.exec("ALTER TABLE instincts RENAME TO instincts_old");

      this.db.exec(`
        CREATE TABLE instincts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('error_fix', 'tool_usage', 'correction', 'verification', 'optimization', 'tool_chain')),
          status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'active', 'deprecated', 'evolved', 'permanent')),
          confidence REAL NOT NULL DEFAULT 0.0 CHECK(confidence >= 0.0 AND confidence <= 1.0),
          trigger_pattern TEXT NOT NULL,
          action TEXT NOT NULL,
          context_conditions TEXT NOT NULL,
          stats TEXT NOT NULL,
          embedding TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          evolved_to TEXT,
          bayesian_alpha REAL DEFAULT 1.0,
          bayesian_beta REAL DEFAULT 1.0,
          cooling_started_at INTEGER,
          cooling_failures INTEGER DEFAULT 0
        )
      `);

      // Copy data from old table
      this.db.exec(`
        INSERT INTO instincts (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, embedding, created_at, updated_at, evolved_to, bayesian_alpha, bayesian_beta, cooling_started_at, cooling_failures)
        SELECT id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, embedding, created_at, updated_at, evolved_to,
               COALESCE(bayesian_alpha, 1.0), COALESCE(bayesian_beta, 1.0), cooling_started_at, COALESCE(cooling_failures, 0)
        FROM instincts_old
      `);

      // Recreate indexes
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_instincts_status_confidence ON instincts(status, confidence DESC)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_instincts_type_status ON instincts(type, status)");

      // Recreate junction table with foreign key reference
      this.db.exec("DROP TABLE IF EXISTS trajectory_instincts");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS trajectory_instincts (
          trajectory_id TEXT NOT NULL,
          instinct_id TEXT NOT NULL,
          PRIMARY KEY (trajectory_id, instinct_id),
          FOREIGN KEY (trajectory_id) REFERENCES trajectories(id) ON DELETE CASCADE,
          FOREIGN KEY (instinct_id) REFERENCES instincts(id) ON DELETE CASCADE
        ) WITHOUT ROWID
      `);

      // Drop old table
      this.db.exec("DROP TABLE instincts_old");

      this.db.exec("COMMIT");
      // Re-enable FK checks and legacy alter table
      this.db.pragma("legacy_alter_table = OFF");
      this.db.pragma("foreign_keys = ON");
    } catch (err) {
      this.db.exec("ROLLBACK");
      this.db.pragma("legacy_alter_table = OFF");
      this.db.pragma("foreign_keys = ON");
      throw err;
    }
  }

  /**
   * Migrate the CHECK constraint on instincts.type to include 'tool_chain'.
   * Uses table recreation since SQLite cannot ALTER CHECK constraints.
   * Idempotent -- only runs if 'tool_chain' is not already valid.
   */
  private migrateTypeConstraint(): void {
    if (!this.db) return;

    // Check if 'tool_chain' is already accepted
    try {
      this.db.prepare("INSERT INTO instincts (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "__check_tool_chain__", "__test__", "tool_chain", "proposed", 0.5, "__test__", "__test__", "[]", "{}", 0, 0
      );
      // If we get here, 'tool_chain' is already in CHECK -- delete test row and return
      this.db.prepare("DELETE FROM instincts WHERE id = ?").run("__check_tool_chain__");
      return;
    } catch {
      // 'tool_chain' not valid -- proceed with migration
    }

    this.db.pragma("foreign_keys = OFF");
    this.db.pragma("legacy_alter_table = ON");

    const migrate = this.db.transaction(() => {
      this.db!.prepare("ALTER TABLE instincts RENAME TO instincts_old").run();

      this.db!.prepare(`
        CREATE TABLE instincts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('error_fix', 'tool_usage', 'correction', 'verification', 'optimization', 'tool_chain')),
          status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'active', 'deprecated', 'evolved', 'permanent')),
          confidence REAL NOT NULL DEFAULT 0.0 CHECK(confidence >= 0.0 AND confidence <= 1.0),
          trigger_pattern TEXT NOT NULL,
          action TEXT NOT NULL,
          context_conditions TEXT NOT NULL,
          stats TEXT NOT NULL,
          embedding TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          evolved_to TEXT,
          bayesian_alpha REAL DEFAULT 1.0,
          bayesian_beta REAL DEFAULT 1.0,
          cooling_started_at INTEGER,
          cooling_failures INTEGER DEFAULT 0
        )
      `).run();

      this.db!.prepare(`
        INSERT INTO instincts (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, embedding, created_at, updated_at, evolved_to, bayesian_alpha, bayesian_beta, cooling_started_at, cooling_failures)
        SELECT id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, embedding, created_at, updated_at, evolved_to,
               COALESCE(bayesian_alpha, 1.0), COALESCE(bayesian_beta, 1.0), cooling_started_at, COALESCE(cooling_failures, 0)
        FROM instincts_old
      `).run();

      // Recreate indexes
      this.db!.prepare("CREATE INDEX IF NOT EXISTS idx_instincts_status_confidence ON instincts(status, confidence DESC)").run();
      this.db!.prepare("CREATE INDEX IF NOT EXISTS idx_instincts_type_status ON instincts(type, status)").run();

      // Recreate junction table with foreign key reference
      this.db!.prepare("DROP TABLE IF EXISTS trajectory_instincts").run();
      this.db!.prepare(`
        CREATE TABLE IF NOT EXISTS trajectory_instincts (
          trajectory_id TEXT NOT NULL,
          instinct_id TEXT NOT NULL,
          PRIMARY KEY (trajectory_id, instinct_id),
          FOREIGN KEY (trajectory_id) REFERENCES trajectories(id) ON DELETE CASCADE,
          FOREIGN KEY (instinct_id) REFERENCES instincts(id) ON DELETE CASCADE
        ) WITHOUT ROWID
      `).run();

      this.db!.prepare("DROP TABLE instincts_old").run();
    });

    try {
      migrate();
    } finally {
      this.db.pragma("legacy_alter_table = OFF");
      this.db.pragma("foreign_keys = ON");
    }
  }

  /** Get the underlying database instance (for migration runner access) */
  getDatabase(): Database.Database | null {
    return this.db;
  }

  /** Close the database connection */
  close(): void {
    this.stopBatchFlushTimer();
    this.flushBatches(); // Flush remaining batches
    
    // Clear statement cache (better-sqlite3 doesn't require finalize for prepared statements)
    this.statements.clear();
    
    this.db?.close();
    this.db = null;
  }

  // ─── Prepared Statement Management ─────────────────────────────────────────────

  private prepareStatements(): void {
    if (!this.db) return;
    
    // Commonly used statements
    const stmts = {
      insertInstinct: `
        INSERT INTO instincts
        (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, embedding, created_at, updated_at, evolved_to, bayesian_alpha, bayesian_beta, cooling_started_at, cooling_failures, origin_session_id, origin_boot_count, cross_session_hit_count, migrated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      updateInstinct: `
        UPDATE instincts SET
          name = ?, type = ?, status = ?, confidence = ?, trigger_pattern = ?,
          action = ?, context_conditions = ?, stats = ?, updated_at = ?, evolved_to = ?,
          bayesian_alpha = ?, bayesian_beta = ?, cooling_started_at = ?, cooling_failures = ?,
          origin_session_id = ?, origin_boot_count = ?, cross_session_hit_count = ?, migrated_at = ?
        WHERE id = ?
      `,
      getInstinct: `SELECT * FROM instincts WHERE id = ?`,
      listInstincts: `SELECT * FROM instincts WHERE status = ? ORDER BY confidence DESC`,
      insertTrajectory: `
        INSERT INTO trajectories 
        (id, session_id, task_description, steps, outcome, applied_instinct_ids, created_at, processed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      insertJunction: `INSERT OR IGNORE INTO trajectory_instincts (trajectory_id, instinct_id) VALUES (?, ?)`,
      getUnprocessedTrajectories: `SELECT * FROM trajectories WHERE processed = 0 ORDER BY created_at ASC LIMIT ?`,
      upsertErrorPattern: `
        INSERT INTO error_patterns 
        (id, name, category, code_pattern, message_pattern, file_patterns, occurrence_count, solution_instinct_id, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_pattern) DO UPDATE SET
          occurrence_count = occurrence_count + 1,
          last_seen = excluded.last_seen
      `,
      insertSolution: `
        INSERT INTO solutions 
        (id, error_pattern_id, description, action, success_count, total_attempts, success_rate, created_at, last_used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      updateSolutionStats: `
        UPDATE solutions SET
          success_count = success_count + ?,
          total_attempts = total_attempts + 1,
          success_rate = (success_count + ?) * 1.0 / (total_attempts + 1),
          last_used = ?
        WHERE id = ?
      `,
      insertObservation: `
        INSERT INTO observations 
        (id, type, session_id, tool_name, input, output, success, error_details, correction, timestamp, processed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      getUnprocessedObservations: `SELECT * FROM observations WHERE processed = 0 ORDER BY timestamp ASC LIMIT ?`,
      insertVerdict: `
        INSERT INTO verdicts 
        (id, trajectory_id, judge_type, score, dimensions, feedback, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      // Note: markTrajectoriesProcessed and markObservationsProcessed are built dynamically
      // at runtime due to variable placeholder counts, so they're not cached here
    };
    
    for (const [name, sql] of Object.entries(stmts)) {
      this.statements.set(name, this.db.prepare(sql));
    }
  }

  private getStatement(name: string): Database.Statement {
    const stmt = this.statements.get(name);
    if (!stmt) throw new Error(`Statement not found: ${name}`);
    return stmt;
  }

  // ─── Batch Operations ──────────────────────────────────────────────────────────

  private startBatchFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flushBatches();
    }, 5000); // Flush every 5 seconds
  }

  private stopBatchFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flushBatches(): void {
    this.flushObservationBatch();
    this.flushTrajectoryBatch();
  }

  /** Flush pending batches immediately - useful for testing */
  flush(): void {
    this.flushBatches();
  }

  private flushObservationBatch(): void {
    if (this.observationBuffer.length === 0 || !this.db) return;
    
    const insert = this.getStatement('insertObservation');
    const insertMany = this.db.transaction((items: typeof this.observationBuffer) => {
      for (const item of items) {
        insert.run(
          item.id,
          item.type,
          item.sessionId,
          item.toolName ?? null,
          item.input ? JSON.stringify(item.input) : null,
          item.output ?? null,
          item.success !== undefined ? (item.success ? 1 : 0) : null,
          item.errorDetails ? JSON.stringify(item.errorDetails) : null,
          item.correction ?? null,
          item.timestamp,
          item.processed ? 1 : 0
        );
      }
    });
    
    insertMany(this.observationBuffer);
    this.observationBuffer = [];
  }

  private flushTrajectoryBatch(): void {
    if (this.trajectoryBuffer.length === 0 || !this.db) return;
    
    const insert = this.getStatement('insertTrajectory');
    const insertJunction = this.getStatement('insertJunction');
    
    const insertMany = this.db.transaction((items: typeof this.trajectoryBuffer) => {
      for (const item of items) {
        insert.run(
          item.id,
          item.sessionId,
          item.taskDescription,
          JSON.stringify(item.steps),
          JSON.stringify(item.outcome),
          JSON.stringify(item.appliedInstinctIds),
          item.createdAt,
          item.processed ? 1 : 0
        );
        
        for (const instinctId of item.appliedInstinctIds) {
          insertJunction.run(item.id, instinctId);
        }
      }
    });
    
    insertMany(this.trajectoryBuffer);
    this.trajectoryBuffer = [];
  }

  // ─── Instinct Operations ─────────────────────────────────────────────────────

  /** Create a new instinct, optionally scoped to a project path */
  createInstinct(instinct: Instinct, projectPath?: string): void {
    this.ensureConnection();
    const stmt = this.getStatement('insertInstinct');

    stmt.run(
      instinct.id,
      instinct.name,
      instinct.type,
      instinct.status,
      instinct.confidence,
      instinct.triggerPattern,
      instinct.action,
      JSON.stringify(instinct.contextConditions),
      JSON.stringify(instinct.stats),
      instinct.embedding ? JSON.stringify(instinct.embedding) : null,
      instinct.createdAt,
      instinct.updatedAt,
      instinct.evolvedTo ?? null,
      instinct.bayesianAlpha ?? null,
      instinct.bayesianBeta ?? null,
      instinct.coolingStartedAt ?? null,
      instinct.coolingFailures ?? 0,
      instinct.originSessionId ?? null,
      instinct.originBootCount ?? null,
      instinct.crossSessionHitCount ?? 0,
      instinct.migratedAt ?? null
    );

    // Insert scope row when projectPath is provided
    if (projectPath) {
      this.db!.prepare(
        "INSERT OR IGNORE INTO instinct_scopes (instinct_id, project_path, created_at) VALUES (?, ?, ?)"
      ).run(instinct.id, projectPath, Date.now());
    }
  }

  /** Get an instinct by ID */
  getInstinct(id: string): Instinct | null {
    this.ensureConnection();
    const stmt = this.getStatement('getInstinct');
    const row = stmt.get(id) as InstinctRow | undefined;
    return row ? this.rowToInstinct(row) : null;
  }

  /** Update an existing instinct */
  updateInstinct(instinct: Instinct): void {
    this.ensureConnection();
    const stmt = this.getStatement('updateInstinct');

    stmt.run(
      instinct.name,
      instinct.type,
      instinct.status,
      instinct.confidence,
      instinct.triggerPattern,
      instinct.action,
      JSON.stringify(instinct.contextConditions),
      JSON.stringify(instinct.stats),
      Date.now() as TimestampMs,
      instinct.evolvedTo ?? null,
      instinct.bayesianAlpha ?? null,
      instinct.bayesianBeta ?? null,
      instinct.coolingStartedAt ?? null,
      instinct.coolingFailures ?? 0,
      instinct.originSessionId ?? null,
      instinct.originBootCount ?? null,
      instinct.crossSessionHitCount ?? 0,
      instinct.migratedAt ?? null,
      instinct.id
    );
  }

  /** Get all instincts matching a status filter (optimized with index) */
  getInstincts(options: { status?: Instinct["status"]; type?: Instinct["type"]; minConfidence?: number } = {}): Instinct[] {
    this.ensureConnection();
    
    // Build optimized query
    let sql = "SELECT * FROM instincts WHERE 1=1";
    const params: (string | number)[] = [];
    
    if (options.status) {
      sql += " AND status = ?";
      params.push(options.status);
    }
    if (options.type) {
      sql += " AND type = ?";
      params.push(options.type);
    }
    if (options.minConfidence !== undefined) {
      sql += " AND confidence >= ?";
      params.push(options.minConfidence);
    }
    
    sql += " ORDER BY confidence DESC";
    
    const stmt = this.db!.prepare(sql);
    const rows = stmt.all(...params) as InstinctRow[];
    return rows.map(r => this.rowToInstinct(r));
  }

  /** Delete an instinct */
  deleteInstinct(id: string): void {
    this.ensureConnection();
    this.db!.prepare("DELETE FROM instincts WHERE id = ?").run(id);
  }

  /** Update the embedding vector for an instinct (for semantic search) */
  updateInstinctEmbedding(id: string, embedding: number[]): void {
    this.ensureConnection();
    this.db!.prepare("UPDATE instincts SET embedding = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(embedding), Date.now(), id);
  }

  // ─── Cross-Session Scope Operations ──────────────────────────────────────────

  /**
   * Get instincts filtered by project scope, age, and status.
   * Does NOT modify getInstincts -- this is an independent retrieval path.
   */
  getInstinctsForScope(options: {
    projectPath: string;
    scopeFilter: 'project-only' | 'project+universal' | 'all';
    maxAgeDays?: number;
    status?: InstinctStatus[];
    minConfidence?: number;
    eventBus?: IEventBus;
  }): Instinct[] {
    this.ensureConnection();

    const {
      projectPath,
      scopeFilter,
      maxAgeDays,
      status = ['active', 'proposed', 'permanent'],
      minConfidence,
      eventBus,
    } = options;

    // If maxAgeDays and eventBus provided, emit age_expired events for filtered instincts
    if (maxAgeDays !== undefined && eventBus) {
      try {
        const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
        // Find instincts that WOULD be excluded by age (non-permanent, older than cutoff)
        let expiredSql = `SELECT DISTINCT i.* FROM instincts i
          INNER JOIN instinct_scopes s ON i.id = s.instinct_id
          WHERE i.status != 'permanent' AND i.created_at < ?`;
        const expiredParams: (string | number)[] = [cutoff];

        // Apply scope filter to expired query too
        if (scopeFilter === 'project-only') {
          expiredSql += " AND s.project_path = ?";
          expiredParams.push(projectPath);
        } else if (scopeFilter === 'project+universal') {
          expiredSql += " AND (s.project_path = ? OR s.project_path = '*')";
          expiredParams.push(projectPath);
        }
        // 'all' -- no scope filter on expired query

        // Status filter
        const statusPlaceholders = status.map(() => "?").join(",");
        expiredSql += ` AND i.status IN (${statusPlaceholders})`;
        expiredParams.push(...status);

        const expiredRows = this.db!.prepare(expiredSql).all(...expiredParams) as InstinctRow[];
        for (const row of expiredRows) {
          const ageDays = Math.floor((Date.now() - row.created_at) / 86400000);
          eventBus.emit("instinct:age_expired", {
            instinctId: row.id as InstinctId,
            ageDays,
            maxAgeDays,
            timestamp: Date.now(),
          });
        }
      } catch {
        // Never block retrieval due to event emission failure
      }
    }

    // Build the main retrieval query
    let sql = "SELECT DISTINCT i.* FROM instincts i INNER JOIN instinct_scopes s ON i.id = s.instinct_id WHERE 1=1";
    const params: (string | number)[] = [];

    // Scope filter
    if (scopeFilter === 'project-only') {
      sql += " AND s.project_path = ?";
      params.push(projectPath);
    } else if (scopeFilter === 'project+universal') {
      sql += " AND (s.project_path = ? OR s.project_path = '*')";
      params.push(projectPath);
    }
    // 'all' -- no scope filter (still requires JOIN to ensure at least one scope row)

    // Age filter with permanent exemption
    if (maxAgeDays !== undefined) {
      const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
      sql += " AND (i.created_at >= ? OR i.status = 'permanent')";
      params.push(cutoff);
    }

    // Status filter
    const statusPlaceholders = status.map(() => "?").join(",");
    sql += ` AND i.status IN (${statusPlaceholders})`;
    params.push(...status);

    // Confidence filter
    if (minConfidence !== undefined) {
      sql += " AND i.confidence >= ?";
      params.push(minConfidence);
    }

    sql += " ORDER BY i.confidence DESC";

    const rows = this.db!.prepare(sql).all(...params) as InstinctRow[];
    return rows.map(r => this.rowToInstinct(r));
  }

  /**
   * Add a scope association for an instinct.
   * Uses INSERT OR IGNORE for idempotency.
   */
  addInstinctScope(instinctId: string, projectPath: string): void {
    this.ensureConnection();
    this.db!.prepare(
      "INSERT OR IGNORE INTO instinct_scopes (instinct_id, project_path, created_at) VALUES (?, ?, ?)"
    ).run(instinctId, projectPath, Date.now());
  }

  /**
   * Get count of distinct non-universal projects for an instinct.
   */
  getInstinctScopeCount(instinctId: string): number {
    this.ensureConnection();
    const row = this.db!.prepare(
      "SELECT COUNT(DISTINCT project_path) as cnt FROM instinct_scopes WHERE instinct_id = ? AND project_path != '*'"
    ).get(instinctId) as { cnt: number };
    return row.cnt;
  }

  /**
   * Increment cross-session hit count for an instinct.
   * Idempotent per session: tracks last counted session in-memory.
   * Returns the new count.
   */
  incrementCrossSessionHitCount(instinctId: string, sessionId: string): number {
    this.ensureConnection();

    // Check if already counted for this session
    if (this.lastCountedSession.get(instinctId) === sessionId) {
      const row = this.db!.prepare("SELECT cross_session_hit_count FROM instincts WHERE id = ?").get(instinctId) as { cross_session_hit_count: number } | undefined;
      return row?.cross_session_hit_count ?? 0;
    }

    // Increment
    this.db!.prepare(
      "UPDATE instincts SET cross_session_hit_count = COALESCE(cross_session_hit_count, 0) + 1 WHERE id = ?"
    ).run(instinctId);

    this.lastCountedSession.set(instinctId, sessionId);

    const row = this.db!.prepare("SELECT cross_session_hit_count FROM instincts WHERE id = ?").get(instinctId) as { cross_session_hit_count: number } | undefined;
    return row?.cross_session_hit_count ?? 0;
  }

  /**
   * Merge two instincts: winner keeps its data, loser's scopes transfer, loser is hard-deleted.
   * Winner keeps its own name/pattern/alpha/beta per locked decision.
   */
  mergeInstincts(winnerId: string, loserId: string): void {
    this.ensureConnection();

    const merge = this.db!.transaction(() => {
      // Transfer loser's scopes to winner (INSERT OR IGNORE avoids duplicates)
      this.db!.prepare(
        "INSERT OR IGNORE INTO instinct_scopes (instinct_id, project_path, created_at) SELECT ?, project_path, created_at FROM instinct_scopes WHERE instinct_id = ?"
      ).run(winnerId, loserId);

      // Hard-delete loser (CASCADE will clean up loser's scope rows)
      this.db!.prepare("DELETE FROM instincts WHERE id = ?").run(loserId);
    });

    merge();
  }

  // ─── Trajectory Operations ───────────────────────────────────────────────────

  /** Create a new trajectory (batched for performance) */
  createTrajectory(trajectory: Trajectory): void {
    this.ensureConnection();
    
    this.trajectoryBuffer.push(trajectory);
    
    if (this.trajectoryBuffer.length >= this.BATCH_SIZE) {
      this.flushTrajectoryBatch();
    }
  }

  /** Create a trajectory immediately (synchronous) - useful for testing */
  createTrajectoryImmediate(trajectory: Trajectory): void {
    this.ensureConnection();
    const insert = this.getStatement('insertTrajectory');
    const insertJunction = this.getStatement('insertJunction');
    
    insert.run(
      trajectory.id,
      trajectory.sessionId,
      trajectory.taskDescription,
      JSON.stringify(trajectory.steps),
      JSON.stringify(trajectory.outcome),
      JSON.stringify(trajectory.appliedInstinctIds),
      trajectory.createdAt,
      trajectory.processed ? 1 : 0
    );
    
    for (const instinctId of trajectory.appliedInstinctIds) {
      insertJunction.run(trajectory.id, instinctId);
    }
  }

  /** Get trajectory by ID */
  getTrajectory(id: string): Trajectory | null {
    this.ensureConnection();
    const row = this.db!.prepare("SELECT * FROM trajectories WHERE id = ?").get(id) as TrajectoryRow | undefined;
    return row ? this.rowToTrajectory(row) : null;
  }

  /** Get unprocessed trajectories for batch processing (uses optimized index) */
  getUnprocessedTrajectories(limit: number = 10): Trajectory[] {
    this.ensureConnection();
    const stmt = this.getStatement('getUnprocessedTrajectories');
    const rows = stmt.all(limit) as TrajectoryRow[];
    return rows.map(r => this.rowToTrajectory(r));
  }

  /**
   * Get trajectories with optional filtering for bulk scanning.
   * Used by chain detection to find recurring tool patterns.
   */
  getTrajectories(options: { since?: number; limit?: number } = {}): Trajectory[] {
    this.ensureConnection();

    let sql = "SELECT * FROM trajectories WHERE 1=1";
    const params: number[] = [];

    if (options.since !== undefined) {
      sql += " AND created_at >= ?";
      params.push(options.since);
    }

    sql += " ORDER BY created_at DESC";

    if (options.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db!.prepare(sql).all(...params) as TrajectoryRow[];
    return rows.map(r => this.rowToTrajectory(r));
  }

  /** Mark trajectories as processed (batched) */
  markTrajectoriesProcessed(ids: string[]): void {
    this.ensureConnection();
    if (ids.length === 0) return;
    
    // Use prepared statement with dynamic placeholders
    const placeholders = ids.map(() => "?").join(",");
    this.db!.prepare(`UPDATE trajectories SET processed = 1 WHERE id IN (${placeholders})`).run(...ids);
  }

  // ─── Error Pattern Operations ────────────────────────────────────────────────

  /** Create or update an error pattern (upsert for atomicity) */
  upsertErrorPattern(pattern: ErrorPattern): void {
    this.ensureConnection();
    
    const stmt = this.getStatement('upsertErrorPattern');
    
    stmt.run(
      pattern.id,
      pattern.name,
      pattern.category,
      pattern.codePattern ?? null,
      pattern.messagePattern,
      JSON.stringify(pattern.filePatterns),
      pattern.occurrenceCount,
      pattern.solutionInstinctId ?? null,
      pattern.firstSeen,
      pattern.lastSeen
    );
  }

  /** Get error patterns by category (uses optimized index) */
  getErrorPatterns(category?: string): ErrorPattern[] {
    this.ensureConnection();
    
    let sql = "SELECT * FROM error_patterns";
    const params: string[] = [];
    
    if (category) {
      sql += " WHERE category = ?";
      params.push(category);
    }
    
    sql += " ORDER BY occurrence_count DESC";
    
    const rows = this.db!.prepare(sql).all(...params) as ErrorPatternRow[];
    return rows.map(r => this.rowToErrorPattern(r));
  }
  
  /** Search error patterns using FTS (if available) */
  searchErrorPatterns(query: string): ErrorPattern[] {
    this.ensureConnection();
    
    try {
      const rows = this.db!.prepare(
        `SELECT p.* FROM error_patterns p
         JOIN error_patterns_fts f ON p.rowid = f.rowid
         WHERE error_patterns_fts MATCH ?
         ORDER BY rank`
      ).all(`"${query.replace(/"/g, '""')}"`) as ErrorPatternRow[];
      return rows.map(r => this.rowToErrorPattern(r));
    } catch {
      // Fallback to LIKE search if FTS fails
      const rows = this.db!.prepare(
        "SELECT * FROM error_patterns WHERE message_pattern LIKE ? ORDER BY occurrence_count DESC"
      ).all(`%${query}%`) as ErrorPatternRow[];
      return rows.map(r => this.rowToErrorPattern(r));
    }
  }

  // ─── Solution Operations ─────────────────────────────────────────────────────

  /** Create a solution */
  createSolution(solution: Solution): void {
    this.ensureConnection();
    const stmt = this.getStatement('insertSolution');
    
    stmt.run(
      solution.id,
      solution.errorPatternId ?? null,
      solution.description,
      solution.action,
      solution.successCount,
      solution.totalAttempts,
      solution.successRate,
      solution.createdAt,
      solution.lastUsed ?? null
    );
  }

  /** Update solution stats (prepared statement) */
  updateSolutionStats(id: string, success: boolean): void {
    this.ensureConnection();
    const stmt = this.getStatement('updateSolutionStats');
    stmt.run(success ? 1 : 0, success ? 1 : 0, Date.now(), id);
  }

  // ─── Observation Operations ──────────────────────────────────────────────────

  /** Record an observation (batched for performance) */
  recordObservation(obs: Observation): void {
    this.ensureConnection();
    
    this.observationBuffer.push(obs);
    
    if (this.observationBuffer.length >= this.BATCH_SIZE) {
      this.flushObservationBatch();
    }
  }

  /** Record an observation immediately (synchronous) - useful for testing */
  recordObservationImmediate(obs: Observation): void {
    this.ensureConnection();
    const insert = this.getStatement('insertObservation');
    insert.run(
      obs.id,
      obs.type,
      obs.sessionId,
      obs.toolName ?? null,
      obs.input ? JSON.stringify(obs.input) : null,
      obs.output ?? null,
      obs.success !== undefined ? (obs.success ? 1 : 0) : null,
      obs.errorDetails ? JSON.stringify(obs.errorDetails) : null,
      obs.correction ?? null,
      obs.timestamp,
      obs.processed ? 1 : 0
    );
  }

  /** Get unprocessed observations (uses optimized index) */
  getUnprocessedObservations(limit: number = 100): Observation[] {
    this.ensureConnection();
    const stmt = this.getStatement('getUnprocessedObservations');
    const rows = stmt.all(limit) as ObservationRow[];
    return rows.map(r => this.rowToObservation(r));
  }

  /** Mark observations as processed (batched) */
  markObservationsProcessed(ids: string[]): void {
    this.ensureConnection();
    if (ids.length === 0) return;
    
    const placeholders = ids.map(() => "?").join(",");
    this.db!.prepare(`UPDATE observations SET processed = 1 WHERE id IN (${placeholders})`).run(...ids);
  }

  // ─── Verdict Operations ──────────────────────────────────────────────────────

  /** Record a verdict */
  recordVerdict(verdict: Verdict): void {
    this.ensureConnection();
    const stmt = this.getStatement('insertVerdict');
    
    stmt.run(
      verdict.id,
      verdict.trajectoryId,
      verdict.judgeType,
      verdict.score,
      JSON.stringify(verdict.dimensions),
      verdict.feedback ?? null,
      verdict.createdAt
    );
  }

  // ─── Lifecycle Log Operations ────────────────────────────────────────────────

  /** Write a lifecycle log entry */
  writeLifecycleLog(entry: {
    instinctId: InstinctId;
    fromStatus: InstinctStatus;
    toStatus: InstinctStatus;
    reason: string;
    confidenceAtTransition: number;
    bayesianAlpha: number;
    bayesianBeta: number;
    observationCount: number;
    timestamp: number;
  }): void {
    this.ensureConnection();
    this.db!.prepare(`
      INSERT INTO instinct_lifecycle_log
      (instinct_id, from_status, to_status, reason, confidence_at_transition, bayesian_alpha, bayesian_beta, observation_count, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.instinctId,
      entry.fromStatus,
      entry.toStatus,
      entry.reason,
      entry.confidenceAtTransition,
      entry.bayesianAlpha,
      entry.bayesianBeta,
      entry.observationCount,
      entry.timestamp
    );
  }

  /** Get lifecycle log entries with optional filters */
  getLifecycleLogs(options?: {
    instinctId?: InstinctId;
    since?: number;
    limit?: number;
  }): Array<{
    instinctId: string;
    fromStatus: string;
    toStatus: string;
    reason: string;
    confidenceAtTransition: number;
    bayesianAlpha: number;
    bayesianBeta: number;
    observationCount: number;
    timestamp: number;
  }> {
    this.ensureConnection();

    let sql = "SELECT * FROM instinct_lifecycle_log WHERE 1=1";
    const params: (string | number)[] = [];

    if (options?.instinctId) {
      sql += " AND instinct_id = ?";
      params.push(options.instinctId);
    }
    if (options?.since) {
      sql += " AND timestamp >= ?";
      params.push(options.since);
    }
    sql += " ORDER BY timestamp DESC";
    if (options?.limit) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db!.prepare(sql).all(...params) as Array<{
      instinct_id: string;
      from_status: string;
      to_status: string;
      reason: string;
      confidence_at_transition: number;
      bayesian_alpha: number;
      bayesian_beta: number;
      observation_count: number;
      timestamp: number;
    }>;

    return rows.map(row => ({
      instinctId: row.instinct_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      confidenceAtTransition: row.confidence_at_transition,
      bayesianAlpha: row.bayesian_alpha,
      bayesianBeta: row.bayesian_beta,
      observationCount: row.observation_count,
      timestamp: row.timestamp,
    }));
  }

  // ─── Weekly Counter Operations ─────────────────────────────────────────────

  /** Increment a weekly counter for the current week */
  incrementWeeklyCounter(eventType: "promoted" | "deprecated" | "cooling_started" | "cooling_recovered"): void {
    this.ensureConnection();
    // Calculate week start (Monday 00:00 UTC)
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
    const weekStartMs = weekStart.getTime();

    this.db!.prepare(`
      INSERT INTO instinct_weekly_counters (week_start, event_type, count)
      VALUES (?, ?, 1)
      ON CONFLICT(week_start, event_type) DO UPDATE SET count = count + 1
    `).run(weekStartMs, eventType);
  }

  /** Get weekly counters for the last N weeks */
  getWeeklyCounters(weeksSince: number = 4): Array<{
    weekStart: number;
    eventType: string;
    count: number;
  }> {
    this.ensureConnection();
    const since = Date.now() - (weeksSince * 7 * 24 * 60 * 60 * 1000);

    const rows = this.db!.prepare(`
      SELECT * FROM instinct_weekly_counters
      WHERE week_start >= ?
      ORDER BY week_start DESC, event_type ASC
    `).all(since) as Array<{
      week_start: number;
      event_type: string;
      count: number;
    }>;

    return rows.map(row => ({
      weekStart: row.week_start,
      eventType: row.event_type,
      count: row.count,
    }));
  }

  // ─── Statistics ──────────────────────────────────────────────────────────────

  /** Get learning statistics (single query for efficiency) */
  getStats(): LearningStats {
    this.ensureConnection();
    
    const stats = this.db!.prepare(`
      SELECT
        (SELECT COUNT(*) FROM instincts) as instinct_count,
        (SELECT COUNT(*) FROM instincts WHERE status = 'active') as active_instinct_count,
        (SELECT COUNT(*) FROM trajectories) as trajectory_count,
        (SELECT COUNT(*) FROM error_patterns) as error_pattern_count,
        (SELECT COUNT(*) FROM observations) as observation_count,
        (SELECT COUNT(*) FROM observations WHERE processed = 0) as unprocessed_observation_count
    `).get() as {
      instinct_count: number;
      active_instinct_count: number;
      trajectory_count: number;
      error_pattern_count: number;
      observation_count: number;
      unprocessed_observation_count: number;
    };
    
    return {
      instinctCount: stats.instinct_count,
      activeInstinctCount: stats.active_instinct_count,
      trajectoryCount: stats.trajectory_count,
      errorPatternCount: stats.error_pattern_count,
      observationCount: stats.observation_count,
      unprocessedObservationCount: stats.unprocessed_observation_count,
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private ensureConnection(): void {
    if (!this.db) {
      throw new Error("LearningStorage not initialized. Call initialize() first.");
    }
  }

  private rowToInstinct(row: InstinctRow): Instinct {
    return {
      id: row.id as InstinctId,
      name: row.name,
      type: row.type as Instinct["type"],
      status: row.status as Instinct["status"],
      confidence: row.confidence,
      triggerPattern: row.trigger_pattern,
      action: row.action,
      contextConditions: JSON.parse(row.context_conditions) as ContextCondition[],
      stats: JSON.parse(row.stats) as InstinctStats,
      createdAt: row.created_at as TimestampMs,
      updatedAt: row.updated_at as TimestampMs,
      evolvedTo: row.evolved_to ? row.evolved_to as InstinctId : undefined,
      sourceTrajectoryIds: [], // Default empty array for missing field
      tags: [], // Default empty array for missing field
      embedding: row.embedding ? JSON.parse(row.embedding) as number[] : undefined,
      bayesianAlpha: row.bayesian_alpha ?? undefined,
      bayesianBeta: row.bayesian_beta ?? undefined,
      coolingStartedAt: row.cooling_started_at ? row.cooling_started_at as TimestampMs : undefined,
      coolingFailures: row.cooling_failures ?? undefined,
      originSessionId: row.origin_session_id ?? undefined,
      originBootCount: row.origin_boot_count ?? undefined,
      crossSessionHitCount: row.cross_session_hit_count ?? 0,
      migratedAt: row.migrated_at ? (row.migrated_at as TimestampMs) : undefined,
    };
  }

  private rowToTrajectory(row: TrajectoryRow): Trajectory {
    return {
      id: row.id as TrajectoryId,
      sessionId: row.session_id as SessionId,
      taskDescription: row.task_description,
      steps: JSON.parse(row.steps) as TrajectoryStep[],
      outcome: JSON.parse(row.outcome) as TrajectoryOutcome,
      appliedInstinctIds: JSON.parse(row.applied_instinct_ids) as InstinctId[],
      createdAt: row.created_at as TimestampMs,
      processed: row.processed === 1,
    };
  }

  private rowToErrorPattern(row: ErrorPatternRow): ErrorPattern {
    return {
      id: row.id as ErrorPatternId,
      name: row.name,
      category: row.category as ErrorCategory,
      codePattern: row.code_pattern ?? undefined,
      messagePattern: row.message_pattern,
      filePatterns: JSON.parse(row.file_patterns) as string[],
      occurrenceCount: row.occurrence_count,
      solutionInstinctId: row.solution_instinct_id ? row.solution_instinct_id as InstinctId : undefined,
      firstSeen: row.first_seen as TimestampMs,
      lastSeen: row.last_seen as TimestampMs,
      isActive: true, // Default value for required field
    };
  }

  private rowToObservation(row: ObservationRow): Observation {
    return {
      id: row.id as ObservationId,
      type: row.type as Observation["type"],
      sessionId: row.session_id as SessionId,
      toolName: row.tool_name ? createBrand(row.tool_name, "ToolName" as const) : undefined,
      input: row.input ? JSON.parse(row.input) as JsonObject : undefined,
      output: row.output ?? undefined,
      success: row.success !== null ? row.success === 1 : undefined,
      errorDetails: row.error_details ? JSON.parse(row.error_details) as ErrorDetails : undefined,
      correction: row.correction ?? undefined,
      timestamp: row.timestamp as TimestampMs,
      processed: row.processed === 1,
    };
  }
}

// ─── Row Types ──────────────────────────────────────────────────────────────────

interface InstinctRow {
  id: string;
  name: string;
  type: string;
  status: string;
  confidence: number;
  trigger_pattern: string;
  action: string;
  context_conditions: string;
  stats: string;
  embedding: string | null;
  created_at: number;
  updated_at: number;
  evolved_to: string | null;
  bayesian_alpha: number | null;
  bayesian_beta: number | null;
  cooling_started_at: number | null;
  cooling_failures: number | null;
  origin_session_id: string | null;
  origin_boot_count: number | null;
  cross_session_hit_count: number | null;
  migrated_at: number | null;
}

interface TrajectoryRow {
  id: string;
  session_id: string;
  task_description: string;
  steps: string;
  outcome: string;
  applied_instinct_ids: string;
  created_at: number;
  processed: number;
}

interface ErrorPatternRow {
  id: string;
  name: string;
  category: string;
  code_pattern: string | null;
  message_pattern: string;
  file_patterns: string;
  occurrence_count: number;
  solution_instinct_id: string | null;
  first_seen: number;
  last_seen: number;
}

interface ObservationRow {
  id: string;
  type: string;
  session_id: string;
  tool_name: string | null;
  input: string | null;
  output: string | null;
  success: number | null;
  error_details: string | null;
  correction: string | null;
  timestamp: number;
  processed: number;
}

// ─── Statistics Interface ───────────────────────────────────────────────────────

export interface LearningStats {
  instinctCount: number;
  activeInstinctCount: number;
  trajectoryCount: number;
  errorPatternCount: number;
  observationCount: number;
  unprocessedObservationCount: number;
}
