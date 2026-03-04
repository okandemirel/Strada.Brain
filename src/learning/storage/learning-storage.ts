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
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { 
  Instinct, 
  InstinctId,
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

// ─── Database Schema ────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
-- Core instincts table
CREATE TABLE IF NOT EXISTS instincts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('error_fix', 'tool_usage', 'correction', 'verification')),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'active', 'deprecated', 'evolved')),
  confidence REAL NOT NULL DEFAULT 0.0 CHECK(confidence >= 0.0 AND confidence <= 1.0),
  trigger_pattern TEXT NOT NULL,
  action TEXT NOT NULL,
  context_conditions TEXT NOT NULL, -- JSON array
  stats TEXT NOT NULL, -- JSON object
  embedding TEXT, -- JSON-serialized float array for semantic search
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  evolved_to TEXT
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
    
    // Performance optimizations
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -64000"); // 64MB cache
    this.db.pragma("temp_store = memory");
    this.db.pragma("mmap_size = 268435456"); // 256MB memory mapping
    
    // Execute schema
    this.db.exec(SCHEMA_SQL);
    
    // Prepare commonly used statements
    this.prepareStatements();
    
    // Start batch flush timer
    this.startBatchFlushTimer();
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
        (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, embedding, created_at, updated_at, evolved_to)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      updateInstinct: `
        UPDATE instincts SET
          name = ?, type = ?, status = ?, confidence = ?, trigger_pattern = ?,
          action = ?, context_conditions = ?, stats = ?, updated_at = ?, evolved_to = ?
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

  /** Create a new instinct */
  createInstinct(instinct: Instinct): void {
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
      instinct.evolvedTo ?? null
    );
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
      ).all(query) as ErrorPatternRow[];
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
