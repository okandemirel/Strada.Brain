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
// ROUND 13 #18: the restore's exclusion is a protocol, and an OPENER is the
// other side of it. See the call in initialize().
import { assertNoMaintenanceExclusion } from "../../core/database-backup.js";
import { resolveStradaHome } from "../../common/runtime-paths.js";
import type {
  EvolutionProposal,
  Instinct,
  InstinctId,
  InstinctStatus,
  RuntimeArtifact,
  RuntimeArtifactId,
  RuntimeArtifactOwnerScope,
  RuntimeArtifactStats,
  Trajectory,
  TrajectoryId,
  TrajectoryReplayCandidate,
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
  TrustLevel,
} from "../types.js";
import { MS_PER_DAY } from "../types.js";
import type { ChatId, SessionId, TimestampMs, JsonObject } from "../../types/index.js";
import { createBrand } from "../../types/index.js";
import type { IEventBus } from "../../core/event-bus.js";
import { sanitizeSecrets } from "../../security/secret-sanitizer.js";
import { stringifyRedacted } from "../../security/secret-patterns.js";
import { getLoggerSafe } from "../../utils/logger.js";

/**
 * item 3.1 (audit 04.4 / D42): scope_type/user_id live on instinct_scopes, not on
 * instincts, so every read that returns an Instinct has to fetch them — otherwise
 * a user-scoped instinct comes back looking like an unowned project rule.
 * Narrowest scope wins ('user' before 'project' before 'global'); 'session_hit'
 * rows are cross-session dedup markers, not scopes. Correlated subqueries (not a
 * JOIN) so `SELECT DISTINCT i.*` still returns one row per instinct.
 */
const NARROWEST_SCOPE_ORDER = `ORDER BY CASE COALESCE(s2.scope_type, 'project')
      WHEN 'user' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, s2.project_path`;

/**
 * Round 10 #3: rows in instinct_scopes that are NOT scopes. 'session_hit' is a
 * cross-session dedup marker keyed by session id (incrementCrossSessionHitCount).
 * Such a row carries no scope_type of its own beyond the marker and no owner, so
 * letting it take part in a scope or ownership decision is how a private
 * instinct escaped: one bookkeeping row satisfied the per-row owner clause and
 * Alice's rule came back for Bob. ONE list, used by every clause below.
 */
const BOOKKEEPING_SCOPE_TYPES = ['session_hit'] as const;
const BOOKKEEPING_SCOPE_SQL_LIST = BOOKKEEPING_SCOPE_TYPES.map((t) => `'${t}'`).join(', ');
/** Bookkeeping exclusion for the aliased scope row `s` of the main query. */
const NOT_BOOKKEEPING_S = `COALESCE(s.scope_type, 'project') NOT IN (${BOOKKEEPING_SCOPE_SQL_LIST})`;
/** Bookkeeping exclusion for the correlated subquery alias `s2`. */
const NOT_BOOKKEEPING_S2 = `COALESCE(s2.scope_type, 'project') NOT IN (${BOOKKEEPING_SCOPE_SQL_LIST})`;

/**
 * The instinct's OWN scope type and owner — the narrowest real (non-bookkeeping)
 * scope row it has. Round 10 #3: ownership is a property of the instinct, so
 * every ownership decision reads these, never the row the query happened to join.
 */
const EFFECTIVE_SCOPE_TYPE_SQL = `(SELECT COALESCE(s2.scope_type, 'project') FROM instinct_scopes s2
      WHERE s2.instinct_id = i.id AND ${NOT_BOOKKEEPING_S2}
      ${NARROWEST_SCOPE_ORDER} LIMIT 1)`;
/**
 * Round 11 #6 — ONLY A PRIVATE ROW ESTABLISHES PRIVATE OWNERSHIP, AND ONLY WHEN
 * IT IS THE ONLY ANSWER.
 *
 * The owner used to be "the user_id on whichever row sorted first", over every
 * non-bookkeeping row. Two things were wrong with that. A `project` row that
 * happens to carry a user_id (createInstinct writes the field whatever the
 * scope) is a project association, not an ownership record. And an instinct with
 * private rows for two different people has NO owner — it has a conflict, and
 * naming one of them makes the rule vanish for the other while it keeps working
 * for the winner. So: private rows only, and NULL unless exactly one identity
 * appears among them. NULL for a 'user'-scoped instinct means it reaches nobody
 * ({@link ownershipClause}) and {@link LearningStorage.quarantineOwnerlessPrivateInstincts}
 * holds it out explicitly.
 */
const PRIVATE_OWNER_ROWS_SQL = `FROM instinct_scopes s2
      WHERE s2.instinct_id = i.id AND COALESCE(s2.scope_type, 'project') = 'user'
        AND s2.user_id IS NOT NULL`;
const EFFECTIVE_OWNER_SQL = `(SELECT CASE WHEN COUNT(DISTINCT s2.user_id) = 1 THEN MIN(s2.user_id) END
      ${PRIVATE_OWNER_ROWS_SQL})`;

const NARROWEST_SCOPE_SUBQUERIES = `
    ${EFFECTIVE_SCOPE_TYPE_SQL} AS scope_type,
    ${EFFECTIVE_OWNER_SQL} AS user_id`;

/**
 * Round 10 #3 — the ownership clause, at the instinct level.
 *
 * A private ('user') instinct is a candidate ONLY for the identity that owns it.
 * A private instinct whose owner was never recorded (`user_id IS NULL`, written
 * before the owner was carried in) belongs to NOBODY, so it reaches nobody: the
 * Wave 3 reading — "keep it reachable or learning goes dark" — made one person's
 * correction everybody's rule. {@link LearningStorage.quarantineOwnerlessPrivateInstincts}
 * recovers such an owner where it can and quarantines the rest.
 *
 * Project- and global-scoped rows are untouched by this clause in both branches.
 */
function ownershipClause(userId: string | undefined): { sql: string; params: string[] } {
  if (userId === undefined) {
    return { sql: ` AND COALESCE(${EFFECTIVE_SCOPE_TYPE_SQL}, 'project') != 'user'`, params: [] };
  }
  // Round 11 #6: `= ?` against the SINGLE private owner. When the private rows
  // disagree (or name nobody) EFFECTIVE_OWNER_SQL is NULL, `NULL = ?` is NULL,
  // and the instinct reaches nobody rather than whoever sorted first.
  return {
    sql: ` AND (COALESCE(${EFFECTIVE_SCOPE_TYPE_SQL}, 'project') != 'user' OR ${EFFECTIVE_OWNER_SQL} = ?)`,
    params: [userId],
  };
}

/**
 * Read a stored JSON id list, answering `[]` for anything that is not one
 * (round 12 #6).
 *
 * Provenance is the one column a corrupt value must not be fatal in, in EITHER
 * direction. An unreadable `source_instinct_ids` used to throw out of
 * `rowToRuntimeArtifact`, so the row that most needs a human decision was the
 * one no audit read could list; and it must not read as "public learning"
 * either — the empty list this returns is what
 * {@link LearningStorage.deriveRuntimeArtifactOwnership} answers 'unknown' for.
 */
function parseIdListOrEmpty(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

// ─── Database Schema ────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
-- Core instincts table
CREATE TABLE IF NOT EXISTS instincts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('error_fix', 'tool_usage', 'correction', 'verification', 'optimization', 'tool_chain')),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'active', 'deprecated', 'evolved', 'permanent', 'quarantined')),
  confidence REAL NOT NULL DEFAULT 0.0 CHECK(confidence >= 0.0 AND confidence <= 1.0),
  trigger_pattern TEXT NOT NULL,
  action TEXT NOT NULL,
  context_conditions TEXT NOT NULL, -- JSON array
  stats TEXT NOT NULL, -- JSON object
  embedding TEXT, -- JSON-serialized float array for semantic search
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  evolved_to TEXT,
  source_trajectory_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  tags TEXT NOT NULL DEFAULT '[]', -- JSON array
  bayesian_alpha REAL DEFAULT 1.0,
  bayesian_beta REAL DEFAULT 1.0,
  cooling_started_at INTEGER,
  cooling_failures INTEGER DEFAULT 0
);

-- Trajectories table (experience replay)
CREATE TABLE IF NOT EXISTS trajectories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  chat_id TEXT,
  task_run_id TEXT,
  -- ORC-9: the owner replay retrieval is scoped to. NULL on legacy rows.
  user_id TEXT,
  project_id TEXT,
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
  judge_type TEXT NOT NULL CHECK(judge_type IN ('human', 'automated', 'self', 'hybrid')),
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
  target_type TEXT NOT NULL CHECK(target_type IN ('skill', 'command', 'agent', 'workflow', 'knowledge_patch')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  confidence REAL NOT NULL,
  implementation TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'implemented', 'cancelled')),
  proposed_at INTEGER NOT NULL,
  decided_at INTEGER,
  affected_trajectory_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  FOREIGN KEY (instinct_id) REFERENCES instincts(id) ON DELETE CASCADE
);

-- Runtime self-improvement artifacts
CREATE TABLE IF NOT EXISTS runtime_artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('skill', 'workflow', 'knowledge_patch')),
  state TEXT NOT NULL CHECK(state IN ('shadow', 'active', 'retired', 'rejected')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  guidance TEXT NOT NULL,
  task_types TEXT NOT NULL, -- JSON array
  task_patterns TEXT NOT NULL, -- JSON array
  project_world_fingerprint TEXT,
  required_tool_names TEXT NOT NULL, -- JSON array
  required_capabilities TEXT NOT NULL, -- JSON array
  source_instinct_ids TEXT NOT NULL, -- JSON array
  source_trajectory_ids TEXT NOT NULL, -- JSON array
  stats TEXT NOT NULL, -- JSON object
  shadow_activated_at INTEGER,
  promoted_at INTEGER,
  rejected_at INTEGER,
  retired_at INTEGER,
  last_state_reason TEXT,
  -- Round 11 #1: who may be shown this guidance. 'unknown' is the column
  -- default so every row written before this existed starts out reaching
  -- NOBODY until resolveRuntimeArtifactOwnership() can establish an owner.
  owner_scope TEXT NOT NULL DEFAULT 'unknown',
  owner_user_id TEXT,
  -- LRN-15: each source instinct's evidence count (applications + failures)
  -- when the artifact was rejected or retired. JSON object; NULL while open.
  source_evidence_at_close TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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
CREATE INDEX IF NOT EXISTS idx_observations_processed_timestamp ON observations(processed, timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_verdicts_trajectory ON verdicts(trajectory_id);
CREATE INDEX IF NOT EXISTS idx_solutions_pattern ON solutions(error_pattern_id);
CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_state_kind ON runtime_artifacts(state, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_updated ON runtime_artifacts(updated_at DESC);

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

/**
 * The age predicate for cross-session retrieval (one `?` = the cutoff). A rule
 * is aged by its LAST USE OR EVIDENCE (updated_at), not by when it was created:
 * keyed on created_at, every seed convention and every heavily used teaching
 * silently dropped out of retrieval on day 91. Seeds (framework conventions,
 * not learned) and permanent rules are exempt.
 */
const AGE_EXEMPT_OR_RECENT =
  "(MAX(i.created_at, i.updated_at) >= ? OR i.status = 'permanent' OR COALESCE(i.seed, 0) = 1)";

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

  /** `i."<col>"` for every instinct column but `embedding`; read after migrations. */
  private instinctColumnsNoEmbedding: string | null = null;

  constructor(dbPath: string = "./data/learning.db") {
    this.dbPath = dbPath;
  }

  /** Initialize the database connection and schema */
  initialize(): void {
    this.instinctColumnsNoEmbedding = null;
    // ROUND 13 #18 — DO NOT OPEN A DATABASE A RESTORE IS REPLACING. The restore
    // probes for attached users, but a probe only describes the instant it ran:
    // a store that opens learning.db while the swap is in flight ends up writing
    // to an inode that is about to be renamed away and deleted, and the restore
    // reports success while the installation is not using restored state.
    //
    // NOT REDUNDANT with the same question inside `configureSqlitePragmas`
    // (586077c4), which is what makes every store in this system join the
    // protocol. That one is asked with the connection already open, and
    // `new Database(path)` CREATES the file — so a refusal there leaves a
    // zero-byte database at a path the restore may be mid-swap on, and SQLite
    // opens a zero-byte file as a valid EMPTY database that passes
    // integrity_check (see `unusableDatabaseSource`). Asked HERE, a refusal
    // touches nothing at all. Measured both ways; maintenance-exclusion.test.ts
    // asserts the file does not appear, so do not drop this as duplication.
    //
    // Only a LIVE holder blocks either way — a lock left by a dead process is the
    // restore's to refuse, never a reason to keep the daemon out of its own store.
    assertNoMaintenanceExclusion(resolveStradaHome(), `open ${this.dbPath}`);
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

    // Round 10 #3: a private instinct that lost its owner reached every caller.
    // Recover the owner where the scope rows still hold it, quarantine the rest.
    // Never fatal — a failed sweep must not take the learning store down with it.
    try {
      this.quarantineOwnerlessPrivateInstincts();
    } catch {
      // Best-effort: the ownership CLAUSE already refuses to serve these rows.
    }

    // Round 11 #1: the same sweep for the OTHER carrier. Every runtime artifact
    // row written before ownership was carried reaches nobody until its owner
    // can be re-derived from the source instincts still on disk.
    try {
      this.quarantineUnownedRuntimeArtifacts();
    } catch {
      // Best-effort: getRuntimeArtifacts' visibility gate already refuses
      // 'unknown' rows, so a failed sweep leaks nothing.
    }

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
    // Note: duplicated in 001-cross-session-provenance.ts (MigrationRunner path).
    // Both paths are needed: migrateSchema runs in initialize() for standalone usage
    // (tests, CLI), while MigrationRunner runs in bootstrap for backfill logic.
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
        // Column already exists — expected after first migration
      }
    }

    const artifactProvenanceColumns = [
      "ALTER TABLE instincts ADD COLUMN source_trajectory_ids TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE instincts ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
    ];
    for (const sql of artifactProvenanceColumns) {
      try {
        this.db.prepare(sql).run();
      } catch {
        // Column already exists — expected after first migration
      }
    }

    const trajectoryColumns = [
      "ALTER TABLE trajectories ADD COLUMN chat_id TEXT",
      "ALTER TABLE trajectories ADD COLUMN task_run_id TEXT",
      // ORC-9: additive and nullable — existing rows keep NULL (no recorded
      // owner) and are not rewritten; replay retrieval shows them to nobody.
      "ALTER TABLE trajectories ADD COLUMN user_id TEXT",
      "ALTER TABLE trajectories ADD COLUMN project_id TEXT",
    ];
    for (const sql of trajectoryColumns) {
      try {
        this.db.prepare(sql).run();
      } catch {
        // Column already exists — expected after first migration
      }
    }
    this.db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_trajectories_task_run_id ON trajectories(task_run_id, created_at DESC)",
    ).run();
    this.db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_trajectories_chat_task_run_id ON trajectories(chat_id, task_run_id, created_at DESC)",
    ).run();
    this.db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_trajectories_owner ON trajectories(user_id, project_id, created_at DESC)",
    ).run();

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

    // Runtime self-improvement: align evolution target CHECK constraint with types.
    try {
      this.db.prepare("ALTER TABLE evolution_proposals ADD COLUMN affected_trajectory_ids TEXT NOT NULL DEFAULT '[]'").run();
    } catch {
      // Column already exists — expected after first migration
    }
    this.migrateEvolutionTargetConstraint();
    this.migrateVerdictJudgeTypeConstraint();

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

    // THE LEDGER'S MISSING HALF (plan 6.4). The lifecycle log says WHEN a
    // rule's status changed; nothing said which RUNS the rule influenced or
    // how those runs ended. Credit was settled from the run's terminal verdict
    // (D40) out of an in-memory map and left no row anywhere, and
    // trajectory_instincts is written with an empty set by every production
    // caller — so "this guidance was applied in 9 runs, the last 4 failed" was
    // unanswerable, and a wrong rule could only be found by noticing it.
    // One row per (run, instinct) settlement, with the confidence it moved.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instinct_credit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instinct_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_run_id TEXT,
        success INTEGER NOT NULL,
        verdict_score REAL NOT NULL,
        source TEXT NOT NULL,
        confidence_before REAL NOT NULL,
        confidence_after REAL NOT NULL,
        status_at TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        -- Round 11 #8: when the run was SHOWN the guidance. The timestamp column
        -- is when the credit SETTLED, which since round 10 #14 is a queue hop later.
        exposed_at INTEGER,
        -- WAS THE GUIDANCE ACTUALLY USED? 0 = shown to the run and NOT applied
        -- (the run was repaired some other way). The 6.3 ablation measured this
        -- gap: a rule recalled on a look-alike trigger costs an attempt, leaves
        -- no negative evidence at all, and so keeps misfiring for ever while
        -- findSuspectGuidance cannot see it. Rows written before this column
        -- were all applications, so they default to 1.
        applied INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_credit_log_instinct ON instinct_credit_log(instinct_id, timestamp DESC);
    `);

    // EVERY EXPOSURE, JUDGED OR NOT (round 14 follow-up to #14).
    //
    // A credit row exists only where something was DECIDED. Since round 13 #24 and
    // round 14 #14 stopped the system inferring application from the wording of a
    // resolution, most exposures are decided by nobody — and the absence of a
    // credit row cannot tell "shown and never judged" from "never shown". So
    // "no misfires found" and "nobody looked" read identically, which is the
    // defect class those two findings were about.
    //
    // One row per (instinct, session, run): the exposure unit the credit ledger
    // already uses. `judged_at` NULL is the recorded absence — the thing a report
    // can count and name. Deliberately NOT a nullable outcome on
    // instinct_credit_log: `ledger.ts` reads that table as evidence
    // (`credits.filter((c) => !c.success)`), so an unjudged row there would be
    // counted as a FAILURE — a recorded absence turning into negative evidence,
    // which is the very thing being fixed.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instinct_exposure_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instinct_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_run_id TEXT NOT NULL DEFAULT '',
        -- When the guidance reached the prompt. EARLIEST wins, exactly as the
        -- in-memory exposure does: a mid-run re-retrieval is the same exposure.
        shown_at INTEGER NOT NULL,
        -- NULL = nothing ever judged this exposure. That is the measurement.
        judged_at INTEGER,
        judged_as TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_exposure_unique
        ON instinct_exposure_log(instinct_id, session_id, task_run_id);
      CREATE INDEX IF NOT EXISTS idx_exposure_shown ON instinct_exposure_log(shown_at DESC);
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

    // Learning Pipeline v2: factor columns on instincts
    const v2FactorColumns = [
      'ALTER TABLE instincts ADD COLUMN factor_recency REAL DEFAULT 0.5',
      'ALTER TABLE instincts ADD COLUMN factor_consistency REAL DEFAULT 0.5',
      'ALTER TABLE instincts ADD COLUMN factor_scope_breadth REAL DEFAULT 0.0',
      'ALTER TABLE instincts ADD COLUMN factor_user_validation REAL DEFAULT 0.5',
      'ALTER TABLE instincts ADD COLUMN factor_cross_session REAL DEFAULT 0.0',
      "ALTER TABLE instincts ADD COLUMN trust_level TEXT DEFAULT 'new'",
      'ALTER TABLE instincts ADD COLUMN seed INTEGER DEFAULT 0',
      "ALTER TABLE instinct_scopes ADD COLUMN scope_type TEXT DEFAULT 'project'",
      'ALTER TABLE instinct_scopes ADD COLUMN user_id TEXT',
      // Round 11 #1: ownership on the artifact. Existing rows get 'unknown' —
      // they reach nobody until resolveRuntimeArtifactOwnership() establishes
      // an owner or quarantines them.
      "ALTER TABLE runtime_artifacts ADD COLUMN owner_scope TEXT NOT NULL DEFAULT 'unknown'",
      'ALTER TABLE runtime_artifacts ADD COLUMN owner_user_id TEXT',
      // LRN-15: the evidence a closed artifact was judged on; NULL on older rows.
      'ALTER TABLE runtime_artifacts ADD COLUMN source_evidence_at_close TEXT',
      // Round 11 #8: WHEN the run was shown the guidance, as distinct from when
      // its credit settled (timestamp). NULL on every row written before this.
      'ALTER TABLE instinct_credit_log ADD COLUMN exposed_at INTEGER',
      // Cost-only misfires: a row written before this column was an
      // application, so existing rows default to 1 and read as applied.
      'ALTER TABLE instinct_credit_log ADD COLUMN applied INTEGER NOT NULL DEFAULT 1',
    ];
    for (const sql of v2FactorColumns) {
      try { this.db.prepare(sql).run(); } catch { /* column already exists */ }
    }

    // Learning Pipeline v2: Migrate CHECK constraint on type to include new types
    this.migrateTypeConstraintV2();

    // Learning Pipeline v2: feedback table
    this.db.prepare(`CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('thumbs_up', 'thumbs_down', 'teaching', 'correction')),
      user_id TEXT,
      instinct_ids TEXT,
      content TEXT,
      scope_type TEXT,
      source TEXT,
      created_at INTEGER NOT NULL
    )`).run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, created_at)").run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback(type, created_at)").run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_feedback_instinct ON feedback(instinct_ids)").run();

    // Learning Pipeline v2: intervention_log table
    this.db.prepare(`CREATE TABLE IF NOT EXISTS intervention_log (
      id TEXT PRIMARY KEY,
      instinct_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tier TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      user_id TEXT,
      created_at INTEGER NOT NULL
    )`).run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_intervention_log_instinct ON intervention_log(instinct_id, created_at)").run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_intervention_log_user ON intervention_log(user_id, created_at)").run();

    // LRN-20: the explicit human signals a learned instinct's trust level is
    // decided from. One row per person, per judged run and per direction, so a
    // toggled reaction is one signal; `id` orders the window deterministically.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instinct_trust_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instinct_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        run_key TEXT NOT NULL,
        signal TEXT NOT NULL CHECK(signal IN ('approval', 'rejection')),
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_signal_once
        ON instinct_trust_signals(instinct_id, user_id, run_key, signal);
      CREATE INDEX IF NOT EXISTS idx_trust_signals_instinct ON instinct_trust_signals(instinct_id, id DESC);
    `);

    // Learning Pipeline v2: scope index
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_instinct_scopes_type_user ON instinct_scopes(scope_type, user_id, project_path)").run();
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
          source_trajectory_ids TEXT NOT NULL DEFAULT '[]',
          tags TEXT NOT NULL DEFAULT '[]',
          bayesian_alpha REAL DEFAULT 1.0,
          bayesian_beta REAL DEFAULT 1.0,
          cooling_started_at INTEGER,
          cooling_failures INTEGER DEFAULT 0,
          origin_session_id TEXT,
          origin_boot_count INTEGER,
          cross_session_hit_count INTEGER DEFAULT 0,
          migrated_at INTEGER
        )
      `);

      // Copy data from old table
      this.db.exec(`
        INSERT INTO instincts (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, embedding, created_at, updated_at, evolved_to, source_trajectory_ids, tags, bayesian_alpha, bayesian_beta, cooling_started_at, cooling_failures, origin_session_id, origin_boot_count, cross_session_hit_count, migrated_at)
        SELECT id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, embedding, created_at, updated_at, evolved_to,
               COALESCE(source_trajectory_ids, '[]'), COALESCE(tags, '[]'),
               COALESCE(bayesian_alpha, 1.0), COALESCE(bayesian_beta, 1.0), cooling_started_at, COALESCE(cooling_failures, 0),
               origin_session_id, origin_boot_count, COALESCE(cross_session_hit_count, 0), migrated_at
        FROM instincts_old
      `);

      // Recreate indexes
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_instincts_status_confidence ON instincts(status, confidence DESC)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_instincts_type_status ON instincts(type, status)");

      this.recreateTrajectoryInstinctsPreservingData();

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
          source_trajectory_ids TEXT NOT NULL DEFAULT '[]',
          tags TEXT NOT NULL DEFAULT '[]',
          bayesian_alpha REAL DEFAULT 1.0,
          bayesian_beta REAL DEFAULT 1.0,
          cooling_started_at INTEGER,
          cooling_failures INTEGER DEFAULT 0,
          origin_session_id TEXT,
          origin_boot_count INTEGER,
          cross_session_hit_count INTEGER DEFAULT 0,
          migrated_at INTEGER
        )
      `).run();

      this.db!.prepare(`
        INSERT INTO instincts (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, embedding, created_at, updated_at, evolved_to, source_trajectory_ids, tags, bayesian_alpha, bayesian_beta, cooling_started_at, cooling_failures, origin_session_id, origin_boot_count, cross_session_hit_count, migrated_at)
        SELECT id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, embedding, created_at, updated_at, evolved_to,
               COALESCE(source_trajectory_ids, '[]'), COALESCE(tags, '[]'),
               COALESCE(bayesian_alpha, 1.0), COALESCE(bayesian_beta, 1.0), cooling_started_at, COALESCE(cooling_failures, 0),
               origin_session_id, origin_boot_count, COALESCE(cross_session_hit_count, 0), migrated_at
        FROM instincts_old
      `).run();

      // Recreate indexes
      this.db!.prepare("CREATE INDEX IF NOT EXISTS idx_instincts_status_confidence ON instincts(status, confidence DESC)").run();
      this.db!.prepare("CREATE INDEX IF NOT EXISTS idx_instincts_type_status ON instincts(type, status)").run();

      this.recreateTrajectoryInstinctsPreservingData();

      this.db!.prepare("DROP TABLE instincts_old").run();
    });

    try {
      migrate();
    } finally {
      this.db.pragma("legacy_alter_table = OFF");
      this.db.pragma("foreign_keys = ON");
    }
  }

  /**
   * Migrate the CHECK constraint on instincts.type to include v2 types:
   * 'error_pattern', 'workflow_pattern', 'user_teaching', 'seed' — and the
   * 'quarantined' status (improvement on audit 04.6: a permanent instinct that
   * keeps being wrong is held out of use instead of applying forever). Both live
   * in the same recreation because this is the LAST status/type migration to
   * run, so the table it writes has every v2 column.
   * Uses table recreation since SQLite cannot ALTER CHECK constraints.
   * Idempotent -- only runs if the new types AND statuses are not already valid.
   */
  private migrateTypeConstraintV2(): void {
    if (!this.db) return;

    // Check if 'error_pattern' (new type) AND 'quarantined' (new status) are
    // both already accepted — one probe row exercises both CHECKs.
    try {
      this.db.prepare("INSERT INTO instincts (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "__check_error_pattern__", "__test__", "error_pattern", "quarantined", 0.5, "__test__", "__test__", "[]", "{}", 0, 0
      );
      // If we get here, new types are already in CHECK -- delete test row and return
      this.db.prepare("DELETE FROM instincts WHERE id = ?").run("__check_error_pattern__");
      return;
    } catch {
      // 'error_pattern' not valid -- proceed with migration
    }

    this.db.pragma("foreign_keys = OFF");
    this.db.pragma("legacy_alter_table = ON");

    const migrate = this.db.transaction(() => {
      this.db!.prepare("ALTER TABLE instincts RENAME TO instincts_old").run();

      this.db!.prepare(`
        CREATE TABLE instincts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('error_fix', 'tool_usage', 'correction', 'verification', 'optimization', 'tool_chain', 'error_pattern', 'workflow_pattern', 'user_teaching', 'seed')),
          status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'active', 'deprecated', 'evolved', 'permanent', 'quarantined')),
          confidence REAL NOT NULL DEFAULT 0.0 CHECK(confidence >= 0.0 AND confidence <= 1.0),
          trigger_pattern TEXT NOT NULL,
          action TEXT NOT NULL,
          context_conditions TEXT NOT NULL,
          stats TEXT NOT NULL,
          embedding TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          evolved_to TEXT,
          source_trajectory_ids TEXT NOT NULL DEFAULT '[]',
          tags TEXT NOT NULL DEFAULT '[]',
          bayesian_alpha REAL DEFAULT 1.0,
          bayesian_beta REAL DEFAULT 1.0,
          cooling_started_at INTEGER,
          cooling_failures INTEGER DEFAULT 0,
          origin_session_id TEXT,
          origin_boot_count INTEGER,
          cross_session_hit_count INTEGER DEFAULT 0,
          migrated_at INTEGER,
          factor_recency REAL DEFAULT 0.5,
          factor_consistency REAL DEFAULT 0.5,
          factor_scope_breadth REAL DEFAULT 0.0,
          factor_user_validation REAL DEFAULT 0.5,
          factor_cross_session REAL DEFAULT 0.0,
          trust_level TEXT DEFAULT 'new',
          seed INTEGER DEFAULT 0
        )
      `).run();

      this.db!.prepare(`
        INSERT INTO instincts (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, embedding, created_at, updated_at, evolved_to, source_trajectory_ids, tags, bayesian_alpha, bayesian_beta, cooling_started_at, cooling_failures, origin_session_id, origin_boot_count, cross_session_hit_count, migrated_at, factor_recency, factor_consistency, factor_scope_breadth, factor_user_validation, factor_cross_session, trust_level, seed)
        SELECT id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, embedding, created_at, updated_at, evolved_to,
               COALESCE(source_trajectory_ids, '[]'), COALESCE(tags, '[]'),
               COALESCE(bayesian_alpha, 1.0), COALESCE(bayesian_beta, 1.0), cooling_started_at, COALESCE(cooling_failures, 0),
               origin_session_id, origin_boot_count, COALESCE(cross_session_hit_count, 0), migrated_at,
               COALESCE(factor_recency, 0.5), COALESCE(factor_consistency, 0.5), COALESCE(factor_scope_breadth, 0.0),
               COALESCE(factor_user_validation, 0.5), COALESCE(factor_cross_session, 0.0),
               COALESCE(trust_level, 'new'), COALESCE(seed, 0)
        FROM instincts_old
      `).run();

      // Recreate indexes
      this.db!.prepare("CREATE INDEX IF NOT EXISTS idx_instincts_status_confidence ON instincts(status, confidence DESC)").run();
      this.db!.prepare("CREATE INDEX IF NOT EXISTS idx_instincts_type_status ON instincts(type, status)").run();

      this.recreateTrajectoryInstinctsPreservingData();

      this.db!.prepare("DROP TABLE instincts_old").run();
    });

    try {
      migrate();
    } finally {
      this.db.pragma("legacy_alter_table = OFF");
      this.db.pragma("foreign_keys = ON");
    }
  }

  /**
   * Migrate the CHECK constraint on evolution_proposals.target_type so runtime
   * artifact targets remain aligned with the TypeScript model.
   */
  private migrateEvolutionTargetConstraint(): void {
    if (!this.db) return;

    try {
      const row = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'evolution_proposals'",
      ).get() as { sql?: string } | undefined;
      const sql = row?.sql ?? "";
      if (sql.includes("workflow") && sql.includes("knowledge_patch") && sql.includes("affected_trajectory_ids")) {
        return;
      }
    } catch {
      // Fall through to migration if sqlite_master inspection fails.
    }

    this.db.pragma("foreign_keys = OFF");
    this.db.pragma("legacy_alter_table = ON");

    const migrate = this.db.transaction(() => {
      this.db!.prepare("ALTER TABLE evolution_proposals RENAME TO evolution_proposals_old").run();

      this.db!.prepare(`
        CREATE TABLE evolution_proposals (
          id TEXT PRIMARY KEY,
          instinct_id TEXT NOT NULL,
          target_type TEXT NOT NULL CHECK(target_type IN ('skill', 'command', 'agent', 'workflow', 'knowledge_patch')),
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          confidence REAL NOT NULL,
          implementation TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'implemented', 'cancelled')),
          proposed_at INTEGER NOT NULL,
          decided_at INTEGER,
          affected_trajectory_ids TEXT NOT NULL DEFAULT '[]',
          FOREIGN KEY (instinct_id) REFERENCES instincts(id) ON DELETE CASCADE
        )
      `).run();

      this.db!.prepare(`
        INSERT INTO evolution_proposals
        (id, instinct_id, target_type, name, description, confidence, implementation, status, proposed_at, decided_at, affected_trajectory_ids)
        SELECT id, instinct_id, target_type, name, description, confidence, implementation, status, proposed_at, decided_at, COALESCE(affected_trajectory_ids, '[]')
        FROM evolution_proposals_old
      `).run();

      this.db!.prepare("DROP TABLE evolution_proposals_old").run();
    });

    try {
      migrate();
    } finally {
      this.db.pragma("legacy_alter_table = OFF");
      this.db.pragma("foreign_keys = ON");
    }
  }

  private recreateTrajectoryInstinctsPreservingData(): void {
    if (!this.db) return;

    this.db.exec(`
      DROP TABLE IF EXISTS temp.trajectory_instincts_backup;
      CREATE TEMP TABLE trajectory_instincts_backup AS
      SELECT trajectory_id, instinct_id
      FROM trajectory_instincts;
    `);

    this.db.exec(`
      DROP TABLE IF EXISTS trajectory_instincts;
      CREATE TABLE trajectory_instincts (
        trajectory_id TEXT NOT NULL,
        instinct_id TEXT NOT NULL,
        PRIMARY KEY (trajectory_id, instinct_id),
        FOREIGN KEY (trajectory_id) REFERENCES trajectories(id) ON DELETE CASCADE,
        FOREIGN KEY (instinct_id) REFERENCES instincts(id) ON DELETE CASCADE
      ) WITHOUT ROWID;
    `);

    this.db.exec(`
      INSERT OR IGNORE INTO trajectory_instincts (trajectory_id, instinct_id)
      SELECT backup.trajectory_id, backup.instinct_id
      FROM trajectory_instincts_backup AS backup
      INNER JOIN trajectories ON trajectories.id = backup.trajectory_id
      INNER JOIN instincts ON instincts.id = backup.instinct_id;

      DROP TABLE IF EXISTS temp.trajectory_instincts_backup;
    `);
  }

  private migrateVerdictJudgeTypeConstraint(): void {
    if (!this.db) return;
    const row = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='verdicts'",
    ).get() as { sql?: string } | undefined;
    if (row?.sql?.includes("'hybrid'")) return;

    const migrate = this.db.transaction(() => {
      this.db!.prepare("ALTER TABLE verdicts RENAME TO verdicts_old").run();
      this.db!.exec(`
        CREATE TABLE verdicts (
          id TEXT PRIMARY KEY,
          trajectory_id TEXT NOT NULL,
          judge_type TEXT NOT NULL CHECK(judge_type IN ('human', 'automated', 'self', 'hybrid')),
          score REAL NOT NULL CHECK(score >= 0.0 AND score <= 1.0),
          dimensions TEXT NOT NULL,
          feedback TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (trajectory_id) REFERENCES trajectories(id) ON DELETE CASCADE
        )
      `);
      this.db!.prepare(`
        INSERT INTO verdicts (id, trajectory_id, judge_type, score, dimensions, feedback, created_at)
        SELECT id, trajectory_id, judge_type, score, dimensions, feedback, created_at
        FROM verdicts_old
      `).run();
      this.db!.prepare("DROP TABLE verdicts_old").run();
      this.db!.prepare("CREATE INDEX IF NOT EXISTS idx_verdicts_trajectory ON verdicts(trajectory_id)").run();
    });
    migrate();
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
        (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, embedding, created_at, updated_at, evolved_to, source_trajectory_ids, tags, bayesian_alpha, bayesian_beta, cooling_started_at, cooling_failures, origin_session_id, origin_boot_count, cross_session_hit_count, migrated_at, factor_recency, factor_consistency, factor_scope_breadth, factor_user_validation, factor_cross_session, trust_level, seed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      updateInstinct: `
        UPDATE instincts SET
          name = ?, type = ?, status = ?, confidence = ?, trigger_pattern = ?,
          action = ?, context_conditions = ?, stats = ?, updated_at = ?, evolved_to = ?,
          source_trajectory_ids = ?, tags = ?, bayesian_alpha = ?, bayesian_beta = ?, cooling_started_at = ?, cooling_failures = ?,
          origin_session_id = ?, origin_boot_count = ?, cross_session_hit_count = ?, migrated_at = ?,
          factor_recency = ?, factor_consistency = ?, factor_scope_breadth = ?, factor_user_validation = ?, factor_cross_session = ?, trust_level = ?, seed = ?
        WHERE id = ?
      `,
      // item 3.1: a single-instinct read carries its scope type and owner.
      getInstinct: `SELECT i.*, ${NARROWEST_SCOPE_SUBQUERIES} FROM instincts i WHERE i.id = ?`,
      listInstincts: `SELECT * FROM instincts WHERE status = ? ORDER BY confidence DESC`,
      insertTrajectory: `
        INSERT INTO trajectories 
        (id, session_id, chat_id, task_run_id, user_id, project_id, task_description, steps, outcome, applied_instinct_ids, created_at, processed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          success_rate = CAST((success_count + ?) AS REAL) / NULLIF(total_attempts + 1, 0),
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
        // Security: scrub provider raw output / tool inputs / correction text
        // before persisting — may contain API keys or prompts with secrets.
        // ID / sessionId / toolName / numeric fields are pass-through.
        insert.run(
          item.id,
          item.type,
          item.sessionId,
          item.toolName ?? null,
          item.input ? stringifyRedacted(item.input) : null,
          item.output ? sanitizeSecrets(item.output) : null,
          item.success !== undefined ? (item.success ? 1 : 0) : null,
          item.errorDetails ? stringifyRedacted(item.errorDetails) : null,
          item.correction ? sanitizeSecrets(item.correction) : null,
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
        // Security: task descriptions, step payloads, and outcomes carry
        // user prompts + provider output — sanitize before DB insert.
        // IDs and numeric fields pass through.
        insert.run(
          item.id,
          item.sessionId,
          item.chatId ?? null,
          item.taskRunId ?? null,
          item.userId ?? null,
          item.projectId ?? null,
          sanitizeSecrets(item.taskDescription),
          stringifyRedacted(item.steps),
          stringifyRedacted(item.outcome),
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
      JSON.stringify(instinct.sourceTrajectoryIds ?? []),
      JSON.stringify(instinct.tags ?? []),
      instinct.bayesianAlpha ?? null,
      instinct.bayesianBeta ?? null,
      instinct.coolingStartedAt ?? null,
      instinct.coolingFailures ?? 0,
      instinct.originSessionId ?? null,
      instinct.originBootCount ?? null,
      instinct.crossSessionHitCount ?? 0,
      instinct.migratedAt ?? null,
      instinct.factorRecency ?? 0.5,
      instinct.factorConsistency ?? 0.5,
      instinct.factorScopeBreadth ?? 0.0,
      instinct.factorUserValidation ?? 0.5,
      instinct.factorCrossSession ?? 0.0,
      instinct.trustLevel ?? 'new',
      instinct.seed ? 1 : 0,
    );

    // Insert scope row when projectPath is provided. item 3.1: the instinct's
    // own scopeType/userId go into the row — a 'user' instinct stored as a
    // project row is exactly the leak this closes.
    if (projectPath) {
      this.db!.prepare(
        "INSERT OR IGNORE INTO instinct_scopes (instinct_id, project_path, created_at, scope_type, user_id) VALUES (?, ?, ?, ?, ?)"
      ).run(
        instinct.id,
        projectPath,
        Date.now(),
        instinct.scopeType ?? 'project',
        instinct.userId ?? null,
      );
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
      JSON.stringify(instinct.sourceTrajectoryIds ?? []),
      JSON.stringify(instinct.tags ?? []),
      instinct.bayesianAlpha ?? null,
      instinct.bayesianBeta ?? null,
      instinct.coolingStartedAt ?? null,
      instinct.coolingFailures ?? 0,
      instinct.originSessionId ?? null,
      instinct.originBootCount ?? null,
      instinct.crossSessionHitCount ?? 0,
      instinct.migratedAt ?? null,
      instinct.factorRecency ?? 0.5,
      instinct.factorConsistency ?? 0.5,
      instinct.factorScopeBreadth ?? 0.0,
      instinct.factorUserValidation ?? 0.5,
      instinct.factorCrossSession ?? 0.0,
      instinct.trustLevel ?? 'new',
      instinct.seed ? 1 : 0,
      instinct.id
    );
  }

  /**
   * Get all instincts matching a status filter (optimized with index).
   *
   * `visibleTo` applies the ownership clause (round 10 #3) for the identity a
   * retrieval is FOR: another user's private instinct is not returned. Omitted,
   * every row is returned — for bookkeeping callers (creation-side duplicate
   * checks), never for text that reaches a prompt.
   *
   * `withEmbedding: false` leaves the vector out (see {@link instinctColumns}).
   */
  getInstincts(options: {
    status?: Instinct["status"];
    type?: Instinct["type"];
    minConfidence?: number;
    visibleTo?: { readonly userId?: string };
    withEmbedding?: boolean;
  } = {}): Instinct[] {
    this.ensureConnection();
    
    // Build optimized query. Round 10 #12: the scope/owner subqueries travel
    // with every row here too — the creation-side duplicate check reads this
    // path, and without them every candidate looked unowned, so one person's
    // private rule blocked everybody else's identical learning.
    let sql = `SELECT ${this.instinctColumns(options.withEmbedding)}, ${NARROWEST_SCOPE_SUBQUERIES} FROM instincts i WHERE 1=1`;
    const params: (string | number)[] = [];
    
    if (options.status) {
      sql += " AND i.status = ?";
      params.push(options.status);
    }
    if (options.type) {
      sql += " AND i.type = ?";
      params.push(options.type);
    }
    if (options.minConfidence !== undefined) {
      sql += " AND i.confidence >= ?";
      params.push(options.minConfidence);
    }
    if (options.visibleTo) {
      const { sql: ownerSql, params: ownerParams } = ownershipClause(options.visibleTo.userId);
      sql += ownerSql;
      params.push(...ownerParams);
    }
    
    sql += " ORDER BY i.confidence DESC";
    
    const stmt = this.db!.prepare(sql);
    const rows = stmt.all(...params) as InstinctRow[];
    return rows.map(r => this.rowToInstinct(r));
  }

  /**
   * Mark an instinct as seen now: the same rule was just learned again. Its
   * age is counted from its last use or evidence, so a rule that is re-learned
   * becomes retrievable again instead of blocking its own re-creation.
   */
  touchInstinct(id: string, at: number = Date.now()): void {
    this.ensureConnection();
    this.db!.prepare("UPDATE instincts SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(at, id);
  }

  /**
   * The instinct columns a read selects (LRN-1). A candidate scan that never
   * compares vectors should not copy and JSON-parse one per row: on the
   * per-message and per-tool-error paths that was most of a retrieval's cost.
   * Leaving it out is safe to write back: updateInstinct never touches it.
   */
  private instinctColumns(withEmbedding: boolean = true): string {
    if (withEmbedding) return "i.*";
    if (this.instinctColumnsNoEmbedding === null) {
      const columns = this.db!.prepare("PRAGMA table_info(instincts)").all() as Array<{ name: string }>;
      this.instinctColumnsNoEmbedding = columns
        .filter((c) => c.name !== "embedding")
        .map((c) => `i."${c.name}"`)
        .join(", ");
    }
    return this.instinctColumnsNoEmbedding;
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
   *
   * `userId` (item 3.1 / audit 04.4 / D42) is the identity the retrieval happens
   * for. A scope row of type 'user' that names an owner is returned ONLY to that
   * owner; a 'user' row that names nobody (written before this fix) stays
   * reachable, and project/global rows are unaffected.
   *
   * `withEmbedding: false` leaves the vector out (see {@link instinctColumns}).
   */
  getInstinctsForScope(options: {
    projectPath: string;
    scopeFilter: 'project-only' | 'project+universal' | 'all';
    maxAgeDays?: number;
    status?: InstinctStatus[];
    minConfidence?: number;
    userId?: string;
    eventBus?: IEventBus;
    withEmbedding?: boolean;
  }): Instinct[] {
    this.ensureConnection();

    const {
      projectPath,
      scopeFilter,
      maxAgeDays,
      status = ['active', 'proposed', 'permanent'],
      minConfidence,
      userId,
      eventBus,
    } = options;

    // The owner clause (round 10 #3): decided from the INSTINCT's own narrowest
    // real scope row, not from whichever row this query joined — a bookkeeping
    // 'session_hit' row used to satisfy it and hand another owner's private
    // instinct over — and an ownerless private row is nobody's, so nobody's
    // candidate.
    const { sql: ownerSql, params: ownerParams } = ownershipClause(userId);

    // If maxAgeDays and eventBus provided, emit age_expired events for filtered instincts
    if (maxAgeDays !== undefined && eventBus) {
      try {
        const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
        // Find instincts that WOULD be excluded by age (see AGE_EXEMPT_OR_RECENT)
        let expiredSql = `SELECT DISTINCT i.* FROM instincts i
          INNER JOIN instinct_scopes s ON i.id = s.instinct_id
          WHERE NOT ${AGE_EXEMPT_OR_RECENT} AND ${NOT_BOOKKEEPING_S}`;
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

        // Owner filter (item 3.1) — the age-expiry notice must not name another
        // user's private instinct either.
        expiredSql += ownerSql;
        expiredParams.push(...ownerParams);

        // Status filter
        const statusPlaceholders = status.map(() => "?").join(",");
        expiredSql += ` AND i.status IN (${statusPlaceholders})`;
        expiredParams.push(...status);

        const expiredRows = this.db!.prepare(expiredSql).all(...expiredParams) as InstinctRow[];
        for (const row of expiredRows) {
          const ageDays = Math.floor((Date.now() - Math.max(row.created_at, row.updated_at)) / MS_PER_DAY);
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

    // Build the main retrieval query. The scope row's type/owner travel with the
    // instinct (item 3.1) so the caller sees what it is scoped to.
    // `AND ${NOT_BOOKKEEPING_S}`: a session_hit marker is not a scope, so it can
    // neither admit an instinct into a scope nor speak for its ownership (#3).
    let sql = `SELECT DISTINCT ${this.instinctColumns(options.withEmbedding)}, ${NARROWEST_SCOPE_SUBQUERIES} FROM instincts i INNER JOIN instinct_scopes s ON i.id = s.instinct_id WHERE ${NOT_BOOKKEEPING_S}`;
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

    // Owner filter (item 3.1)
    sql += ownerSql;
    params.push(...ownerParams);

    // Age filter (see AGE_EXEMPT_OR_RECENT)
    if (maxAgeDays !== undefined) {
      const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
      sql += ` AND ${AGE_EXEMPT_OR_RECENT}`;
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
   * ROUND 10 #3 — RECOVER OR QUARANTINE EVERY OWNERLESS PRIVATE INSTINCT.
   *
   * A row with `scope_type='user'` and `user_id IS NULL` is a private rule that
   * lost its owner (written before the owner was carried through teachExplicit /
   * mergeInstincts). It used to be returned to EVERY caller, which is the leak:
   * one person's correction became everybody's rule. It cannot simply be
   * deleted — it is somebody's learning — so:
   *
   *  - if the instinct's PRIVATE scope rows name exactly ONE identity, that
   *    owner is written onto the ownerless rows and the instinct keeps working,
   *    for that person only (round 11 #6: one identity, and only from a private
   *    row — a project/bookkeeping association is not an ownership record);
   *  - otherwise — no private owner recorded anywhere, or private rows naming
   *    DIFFERENT people — the instinct is QUARANTINED: held out of retrieval and
   *    suggestion (the same status a permanent teaching that kept being wrong
   *    gets), still present to be audited or re-owned by hand.
   *
   * Idempotent — safe on every boot. Returns what it did, so a caller never
   * mistakes a no-op for a sweep.
   */
  quarantineOwnerlessPrivateInstincts(): { ownerRecovered: number; quarantined: number } {
    this.ensureConnection();

    const ownerless = this.db!.prepare(`
      SELECT DISTINCT i.id AS id FROM instincts i
      INNER JOIN instinct_scopes s ON i.id = s.instinct_id
      WHERE COALESCE(s.scope_type, 'project') = 'user' AND s.user_id IS NULL
        AND i.status NOT IN ('quarantined', 'deprecated', 'evolved')
    `).all() as Array<{ id: string }>;

    let ownerRecovered = 0;
    let quarantined = 0;

    // ROUND 11 #6: a UNIQUE, AUTHORITATIVE owner, or none.
    //
    // This used to be `SELECT user_id ... WHERE user_id IS NOT NULL AND NOT
    // bookkeeping ORDER BY created_at LIMIT 1` — the first non-null owner on any
    // kind of row, adopted without ever asking whether it was the only one. An
    // instinct with private rows for Alice and Bob was therefore ADOPTED by
    // whichever sorted first: it stayed active for that person and silently
    // vanished for the other. And a 'project' row carrying a user_id (createInstinct
    // writes the field whatever the scope) established private ownership, which
    // a project association has no authority to do.
    //
    // So: private rows only, and a count, not a pick. Two owners is a conflict
    // to be quarantined and re-owned by hand, not a coin toss.
    const recoverOwner = this.db!.prepare(`
      SELECT COUNT(DISTINCT s2.user_id) AS owner_count, MIN(s2.user_id) AS user_id
      FROM instinct_scopes s2
      WHERE s2.instinct_id = ? AND COALESCE(s2.scope_type, 'project') = 'user'
        AND s2.user_id IS NOT NULL
    `);
    const adoptOwner = this.db!.prepare(
      "UPDATE instinct_scopes SET user_id = ? WHERE instinct_id = ? AND COALESCE(scope_type, 'project') = 'user' AND user_id IS NULL"
    );
    const quarantine = this.db!.prepare(
      "UPDATE instincts SET status = 'quarantined', updated_at = ? WHERE id = ?"
    );

    for (const { id } of ownerless) {
      const recovered = recoverOwner.get(id) as { owner_count: number; user_id: string | null } | undefined;
      if (recovered?.owner_count === 1 && recovered.user_id) {
        adoptOwner.run(recovered.user_id, id);
        ownerRecovered++;
      } else {
        // No private owner at all, or more than one: ambiguous ownership is not
        // an owner. Held out of retrieval, still on disk to be audited.
        quarantine.run(Date.now(), id);
        quarantined++;
      }
    }

    return { ownerRecovered, quarantined };
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
      // Exclude scope_type='session_hit' rows — those are cross-session dedup
      // markers (keyed by session id, not project) written by
      // incrementCrossSessionHitCount. Counting them inflates the project count
      // and falsely promotes the instinct to universal scope.
      "SELECT COUNT(DISTINCT project_path) as cnt FROM instinct_scopes WHERE instinct_id = ? AND project_path != '*' AND scope_type != 'session_hit'"
    ).get(instinctId) as { cnt: number };
    return row.cnt;
  }

  /**
   * Increment cross-session hit count for an instinct.
   * Idempotent per session: checks both in-memory cache and database
   * to prevent double-counting even after restart.
   */
  incrementCrossSessionHitCount(instinctId: string, sessionId: string): void {
    this.ensureConnection();

    // Fast path: in-memory dedup (avoids DB round-trip within same process)
    if (this.lastCountedSession.get(instinctId) === sessionId) {
      return;
    }

    // Durable dedup: check if this session was already counted in the database.
    // Uses instinct_scopes with scope_type='session_hit' to persist dedup state.
    const existing = this.db!.prepare(
      "SELECT 1 FROM instinct_scopes WHERE instinct_id = ? AND project_path = ? AND scope_type = 'session_hit'"
    ).get(instinctId, sessionId);
    if (existing) {
      // Already counted for this session — update in-memory cache and return
      this.lastCountedSession.set(instinctId, sessionId);
      return;
    }

    this.db!.prepare(
      "UPDATE instincts SET cross_session_hit_count = COALESCE(cross_session_hit_count, 0) + 1 WHERE id = ?"
    ).run(instinctId);

    // Persist dedup marker to instinct_scopes
    this.db!.prepare(
      "INSERT OR IGNORE INTO instinct_scopes (instinct_id, project_path, created_at, scope_type) VALUES (?, ?, ?, 'session_hit')"
    ).run(instinctId, sessionId, Date.now());

    this.lastCountedSession.set(instinctId, sessionId);
  }

  /**
   * Merge two instincts: winner keeps its data, loser's scopes transfer, loser
   * is SOFT-RETIRED (status 'deprecated', evolved_to = the winner).
   * Winner keeps its own name/pattern/alpha/beta per locked decision.
   *
   * D43 (audit 04.5): the loser used to be DELETED. A merge is decided by a
   * similarity heuristic, and the row it destroyed carried a solution, its stats
   * and its provenance — unrecoverable. 'deprecated' is the existing retired
   * state: out of every retrieval path, still readable, and still evictable by
   * the explicit maxInstincts sweep.
   *
   * A merge CARRIES the loser's scope, it never widens it (item 3.1 / audit 04.4
   * / D42): the transfer used to copy project_path only, so a row that said
   * "alice's private rule in this project" arrived as "this project's rule,
   * owner nobody" and one person's correction became everybody's. The
   * OR IGNORE keeps the winner's own row on a conflict, so the merge can never
   * widen either side.
   */
  mergeInstincts(winnerId: string, loserId: string): void {
    this.ensureConnection();

    // The loser's own numbers, read BEFORE the update, so the ledger row says
    // what it was worth when it was superseded.
    const loser = this.getInstinct(loserId as InstinctId);
    const now = Date.now();

    const merge = this.db!.transaction(() => {
      // Transfer loser's scopes to winner (INSERT OR IGNORE avoids duplicates)
      this.db!.prepare(
        "INSERT OR IGNORE INTO instinct_scopes (instinct_id, project_path, created_at, scope_type, user_id) SELECT ?, project_path, created_at, scope_type, user_id FROM instinct_scopes WHERE instinct_id = ?"
      ).run(winnerId, loserId);

      // Soft-retire the loser, naming the successor that superseded it (D43).
      this.db!.prepare(
        "UPDATE instincts SET status = 'deprecated', evolved_to = ?, updated_at = ? WHERE id = ?"
      ).run(winnerId, now, loserId);

      // …AND SAY SO IN THE LIFECYCLE LOG (plan 6.4). Promotion, cooling,
      // deprecation and quarantine all logged their transition; a supersede
      // logged nothing, so the one status change a reader is most likely to
      // ask about ("why is this deprecated? I never retired it") had no entry
      // and the ledger's timeline simply skipped it.
      if (loser) {
        this.db!.prepare(`
          INSERT INTO instinct_lifecycle_log
          (instinct_id, from_status, to_status, reason, confidence_at_transition, bayesian_alpha, bayesian_beta, observation_count, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          loserId,
          loser.status,
          "deprecated",
          `Superseded by ${winnerId}: merged as a duplicate and soft-retired`,
          loser.confidence,
          loser.bayesianAlpha ?? 1,
          loser.bayesianBeta ?? 1,
          (loser.stats?.timesApplied ?? 0) + (loser.stats?.timesFailed ?? 0),
          now,
        );
      }
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

    // Security: sanitize free-form trajectory text (task + steps + outcome)
    // before writing; IDs pass through.
    insert.run(
      trajectory.id,
      trajectory.sessionId,
      trajectory.chatId ?? null,
      trajectory.taskRunId ?? null,
      trajectory.userId ?? null,
      trajectory.projectId ?? null,
      sanitizeSecrets(trajectory.taskDescription),
      stringifyRedacted(trajectory.steps),
      stringifyRedacted(trajectory.outcome),
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
    return row ? this.parseRows([row], (r) => this.rowToTrajectory(r), "trajectory").items[0] ?? null : null;
  }

  getLatestTrajectoryVerdictScores(trajectoryIds: readonly string[]): Map<string, {
    score: number;
    createdAt: number;
  }> {
    this.ensureConnection();
    if (trajectoryIds.length === 0) {
      return new Map();
    }

    const placeholders = trajectoryIds.map(() => "?").join(",");
    const rows = this.db!.prepare(`
      SELECT
        trajectory_id,
        judge_type,
        score,
        created_at,
        rowid
      FROM verdicts
      WHERE trajectory_id IN (${placeholders})
      ORDER BY
        trajectory_id ASC,
        CASE judge_type
          WHEN 'human' THEN 3
          WHEN 'hybrid' THEN 2
          WHEN 'automated' THEN 1
          WHEN 'self' THEN 0
          ELSE 0
        END DESC,
        created_at DESC,
        rowid DESC
    `).all(...trajectoryIds) as Array<{
      trajectory_id: string;
      judge_type: string;
      score: number;
      created_at: number;
      rowid: number;
    }>;

    const scores = new Map<string, {
      score: number;
      createdAt: number;
    }>();
    for (const row of rows) {
      if (!scores.has(row.trajectory_id)) {
        scores.set(row.trajectory_id, {
          score: row.score,
          createdAt: row.created_at,
        });
      }
    }
    return scores;
  }

  getTrajectoryByTaskRun(taskRunId: string, chatId?: string): Trajectory | null {
    this.ensureConnection();
    const row = chatId
      ? this.db!.prepare(
        "SELECT * FROM trajectories WHERE task_run_id = ? AND chat_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get(taskRunId, chatId) as TrajectoryRow | undefined
      : this.db!.prepare(
        "SELECT * FROM trajectories WHERE task_run_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get(taskRunId) as TrajectoryRow | undefined;
    return row ? this.parseRows([row], (r) => this.rowToTrajectory(r), "trajectory").items[0] ?? null : null;
  }

  /** Get unprocessed trajectories for batch processing (uses optimized index) */
  getUnprocessedTrajectories(limit: number = 10): Trajectory[] {
    this.ensureConnection();
    const stmt = this.getStatement('getUnprocessedTrajectories');
    const rows = stmt.all(limit) as TrajectoryRow[];
    const { items, badIds } = this.parseRows(rows, (r) => this.rowToTrajectory(r), "trajectory");
    // Quarantine: an unreadable row is marked processed (and kept on disk) so
    // the oldest-first batch moves past it instead of failing on it forever.
    this.markTrajectoriesProcessed(badIds);
    return items;
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
    return this.parseRows(rows, (r) => this.rowToTrajectory(r), "trajectory").items;
  }

  /**
   * ORC-9 — replay candidates recorded by ONE owner, newest first.
   *
   * Replay retrieval puts a prior task's description and verifier notes into a
   * system prompt, so it reads only what `userId` recorded in `projectId`
   * (`IS`, so "no project" matches only "no project"). A row with no recorded
   * owner — every row written before the columns existed — reaches nobody, the
   * rule an ownerless private instinct and an 'unknown' runtime artifact follow.
   * The gate is in SQL so another person's rows cannot eat the LIMIT, and
   * `steps` (the bulk of a row, unused by replay scoring) is not read.
   */
  getReplayTrajectoriesForOwner(options: {
    userId: string;
    projectId?: string;
    limit: number;
  }): TrajectoryReplayCandidate[] {
    this.ensureConnection();
    if (!options.userId.trim()) return [];
    const rows = this.db!.prepare(
      `SELECT id, task_description, outcome, created_at FROM trajectories
       WHERE user_id = ? AND project_id IS ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(options.userId, options.projectId ?? null, options.limit) as TrajectoryReplayRow[];
    return this.parseRows(
      rows,
      (r): TrajectoryReplayCandidate => ({
        id: r.id as TrajectoryId,
        taskDescription: r.task_description,
        outcome: JSON.parse(r.outcome) as TrajectoryOutcome,
        createdAt: r.created_at as TimestampMs,
      }),
      "trajectory",
    ).items;
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
    // Security: sanitize tool input/output/correction/errorDetails before insert.
    insert.run(
      obs.id,
      obs.type,
      obs.sessionId,
      obs.toolName ?? null,
      obs.input ? stringifyRedacted(obs.input) : null,
      obs.output ? sanitizeSecrets(obs.output) : null,
      obs.success !== undefined ? (obs.success ? 1 : 0) : null,
      obs.errorDetails ? stringifyRedacted(obs.errorDetails) : null,
      obs.correction ? sanitizeSecrets(obs.correction) : null,
      obs.timestamp,
      obs.processed ? 1 : 0
    );
  }

  /** Get unprocessed observations (uses optimized index) */
  getUnprocessedObservations(limit: number = 100): Observation[] {
    this.ensureConnection();
    const stmt = this.getStatement('getUnprocessedObservations');
    const rows = stmt.all(limit) as ObservationRow[];
    const { items, badIds } = this.parseRows(rows, (r) => this.rowToObservation(r), "observation");
    // Quarantine, as for trajectories: never let one row stall the batch.
    this.markObservationsProcessed(badIds);
    return items;
  }

  /** Mark observations as processed (batched) */
  markObservationsProcessed(ids: string[]): void {
    this.ensureConnection();
    if (ids.length === 0) return;
    
    const placeholders = ids.map(() => "?").join(",");
    this.db!.prepare(`UPDATE observations SET processed = 1 WHERE id IN (${placeholders})`).run(...ids);
  }

  /**
   * Delete processed observations with a timestamp before `olderThanMs`.
   * Unprocessed rows are never touched. Returns the number of rows deleted.
   * audited 2026-09-02: this was the only table with no retention path.
   */
  pruneProcessedObservations(olderThanMs: number): number {
    this.ensureConnection();
    this.flush();
    const result = this.db!.prepare(
      "DELETE FROM observations WHERE processed = 1 AND timestamp < ?",
    ).run(olderThanMs);
    return result.changes;
  }

  // ─── Verdict Operations ──────────────────────────────────────────────────────

  /** Record a verdict */
  recordVerdict(verdict: Verdict): void {
    this.ensureConnection();
    const stmt = this.getStatement('insertVerdict');

    // Security: verdict feedback is free-form judge text — sanitize before insert.
    // dimensions is a structured numeric map but JSON-stringified value might still
    // contain quoted text; sanitize the serialized form.
    stmt.run(
      verdict.id,
      verdict.trajectoryId,
      verdict.judgeType,
      verdict.score,
      stringifyRedacted(verdict.dimensions),
      verdict.feedback ? sanitizeSecrets(verdict.feedback) : null,
      verdict.createdAt
    );
  }

  // ─── Evolution Proposal Operations ──────────────────────────────────────────

  createEvolutionProposal(proposal: EvolutionProposal): void {
    this.ensureConnection();
    this.db!.prepare(`
      INSERT OR REPLACE INTO evolution_proposals
      (id, instinct_id, target_type, name, description, confidence, implementation, status, proposed_at, decided_at, affected_trajectory_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.id,
      proposal.instinctId,
      proposal.targetType,
      proposal.name,
      proposal.description,
      proposal.confidence,
      proposal.implementation ?? null,
      proposal.status,
      proposal.proposedAt,
      proposal.decidedAt ?? null,
      JSON.stringify(proposal.affectedTrajectoryIds ?? []),
    );
  }

  getEvolutionProposals(options: {
    instinctId?: string;
    status?: EvolutionProposal["status"];
    limit?: number;
  } = {}): EvolutionProposal[] {
    this.ensureConnection();

    let sql = "SELECT * FROM evolution_proposals WHERE 1=1";
    const params: Array<string | number> = [];

    if (options.instinctId) {
      sql += " AND instinct_id = ?";
      params.push(options.instinctId);
    }
    if (options.status) {
      sql += " AND status = ?";
      params.push(options.status);
    }

    sql += " ORDER BY proposed_at DESC";
    if (options.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db!.prepare(sql).all(...params) as EvolutionProposalRow[];
    return rows.map((row) => this.rowToEvolutionProposal(row));
  }

  // ─── Runtime Artifact Operations ────────────────────────────────────────────

  upsertRuntimeArtifact(artifact: RuntimeArtifact): void {
    this.ensureConnection();
    // Round 11 #1: ownership is never left to the column default on a live
    // write. The caller may state it (materializeShadowArtifact does, from the
    // instinct it holds); otherwise it is derived from the source instincts.
    const ownership: { scope: RuntimeArtifactOwnerScope; ownerUserId?: string } =
      artifact.ownerScope !== undefined
        ? {
            scope: artifact.ownerScope,
            ...(artifact.ownerUserId ? { ownerUserId: artifact.ownerUserId } : {}),
          }
        : this.deriveRuntimeArtifactOwnership(artifact.sourceInstinctIds.map(String), false);
    this.db!.prepare(`
      INSERT INTO runtime_artifacts
      (id, kind, state, name, description, guidance, task_types, task_patterns, project_world_fingerprint,
       required_tool_names, required_capabilities, source_instinct_ids, source_trajectory_ids, stats,
       shadow_activated_at, promoted_at, rejected_at, retired_at, last_state_reason, owner_scope, owner_user_id,
       source_evidence_at_close, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        state = excluded.state,
        name = excluded.name,
        description = excluded.description,
        guidance = excluded.guidance,
        task_types = excluded.task_types,
        task_patterns = excluded.task_patterns,
        project_world_fingerprint = excluded.project_world_fingerprint,
        required_tool_names = excluded.required_tool_names,
        required_capabilities = excluded.required_capabilities,
        source_instinct_ids = excluded.source_instinct_ids,
        source_trajectory_ids = excluded.source_trajectory_ids,
        stats = excluded.stats,
        shadow_activated_at = excluded.shadow_activated_at,
        promoted_at = excluded.promoted_at,
        rejected_at = excluded.rejected_at,
        retired_at = excluded.retired_at,
        last_state_reason = excluded.last_state_reason,
        owner_scope = excluded.owner_scope,
        owner_user_id = excluded.owner_user_id,
        source_evidence_at_close = excluded.source_evidence_at_close,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      artifact.id,
      artifact.kind,
      artifact.state,
      artifact.name,
      artifact.description,
      artifact.guidance,
      JSON.stringify(artifact.taskTypes),
      JSON.stringify(artifact.taskPatterns),
      artifact.projectWorldFingerprint ?? null,
      JSON.stringify(artifact.requiredToolNames),
      JSON.stringify(artifact.requiredCapabilities),
      JSON.stringify(artifact.sourceInstinctIds),
      JSON.stringify(artifact.sourceTrajectoryIds),
      JSON.stringify(artifact.stats),
      artifact.shadowActivatedAt ?? null,
      artifact.promotedAt ?? null,
      artifact.rejectedAt ?? null,
      artifact.retiredAt ?? null,
      artifact.lastStateReason ?? null,
      ownership.scope,
      ownership.ownerUserId ?? null,
      artifact.sourceEvidenceAtClose ? JSON.stringify(artifact.sourceEvidenceAtClose) : null,
      artifact.createdAt,
      artifact.updatedAt,
    );
  }

  /**
   * ROUND 11 #1 — WHOSE GUIDANCE IS THIS ARTIFACT CARRYING?
   *
   * An artifact is a copy of its source instincts' guidance in another shape, so
   * its reach is theirs. Derived from the source instincts' PRIVATE scope rows
   * (the same authority {@link EFFECTIVE_OWNER_SQL} uses — a project association
   * is not an ownership record):
   *
   *  - any private source, one identity across all of them ⇒ 'user', that owner;
   *  - private sources naming DIFFERENT people, or a private source whose owner
   *    is unrecorded ⇒ 'unknown' (reaches nobody, awaiting a human);
   *  - no private source ⇒ 'public', which is every artifact the system has
   *    generated from project/global learning.
   *
   * ROUND 12 #6 — NO PROVENANCE AT ALL IS NOT EVIDENCE OF PUBLIC LEARNING. An
   * empty source list (and, through the sweep's parse, unreadable JSON or a
   * value that is not a list) named nobody to check, so every branch above was
   * skipped and the row fell through to 'public'. Production never writes an
   * artifact with no source instinct — one is materialized FROM an instinct — so
   * such a list is corruption or a hand-written row: unattributable, therefore
   * 'unknown'. Both callers, because publishing is the irreversible direction.
   *
   * `missingSourceIsUnknown` is the one remaining difference between the two.
   * On a WRITE the caller had the instinct in hand, so a source id that is not
   * in the instincts table is a stale merge reference, not evidence of a private
   * rule. For the LEGACY SWEEP there is no such context: a row whose sources are
   * all gone cannot be attributed to anybody, and guessing 'public' is the leak.
   */
  private deriveRuntimeArtifactOwnership(
    sourceInstinctIds: readonly string[],
    missingSourceIsUnknown: boolean,
  ): { scope: RuntimeArtifactOwnerScope; ownerUserId?: string } {
    const owners = new Set<string>();
    let sawUnownedPrivate = false;
    let sawMissingSource = false;
    /** Round 12 #6: was there any source id to check in the first place? */
    let sawAnySource = false;

    const lookup = this.db!.prepare(`
      SELECT
        (SELECT COUNT(*) FROM instincts WHERE id = ?) AS present,
        (SELECT COUNT(*) FROM instinct_scopes s
          WHERE s.instinct_id = ? AND COALESCE(s.scope_type, 'project') = 'user') AS private_rows,
        (SELECT COUNT(DISTINCT s.user_id) FROM instinct_scopes s
          WHERE s.instinct_id = ? AND COALESCE(s.scope_type, 'project') = 'user'
            AND s.user_id IS NOT NULL) AS owner_count,
        (SELECT MIN(s.user_id) FROM instinct_scopes s
          WHERE s.instinct_id = ? AND COALESCE(s.scope_type, 'project') = 'user'
            AND s.user_id IS NOT NULL) AS owner
    `);

    for (const rawId of sourceInstinctIds) {
      const id = String(rawId).trim();
      if (!id) continue;
      sawAnySource = true;
      const row = lookup.get(id, id, id, id) as {
        present: number;
        private_rows: number;
        owner_count: number;
        owner: string | null;
      };
      if (row.present === 0) {
        sawMissingSource = true;
        continue;
      }
      if (row.private_rows === 0) continue;
      if (row.owner_count === 1 && row.owner) {
        owners.add(row.owner);
      } else {
        // A private source with no owner, or with more than one: unattributable.
        sawUnownedPrivate = true;
      }
    }

    if (sawUnownedPrivate || owners.size > 1) return { scope: "unknown" };
    if (owners.size === 1) return { scope: "user", ownerUserId: [...owners][0]! };
    // Round 12 #6: nothing was named, so nothing was checked — publishing here
    // would be a guess, and the guess reaches everybody.
    if (!sawAnySource) return { scope: "unknown" };
    if (missingSourceIsUnknown && sawMissingSource) return { scope: "unknown" };
    return { scope: "public" };
  }

  /**
   * RESOLVE OR QUARANTINE EVERY RUNTIME ARTIFACT WITH NO RECORDED OWNERSHIP
   * (round 11 #1) — the artifact-side twin of
   * {@link quarantineOwnerlessPrivateInstincts}.
   *
   * Every row written before ownership was carried has `owner_scope='unknown'`
   * (the column default) and therefore reaches nobody. This re-derives ownership
   * from the source instincts still on disk; what cannot be attributed stays
   * 'unknown' and is counted as quarantined, so a caller never mistakes a no-op
   * for a sweep. Idempotent — safe on every boot.
   */
  quarantineUnownedRuntimeArtifacts(): { ownerRecovered: number; madePublic: number; quarantined: number } {
    this.ensureConnection();
    const rows = this.db!.prepare(
      "SELECT id, source_instinct_ids FROM runtime_artifacts WHERE COALESCE(owner_scope, 'unknown') = 'unknown'",
    ).all() as Array<{ id: string; source_instinct_ids: string }>;

    const update = this.db!.prepare(
      "UPDATE runtime_artifacts SET owner_scope = ?, owner_user_id = ? WHERE id = ?",
    );
    let ownerRecovered = 0;
    let madePublic = 0;
    let quarantined = 0;

    for (const row of rows) {
      // Round 12 #6: unreadable JSON, a value that is not a list, and an empty
      // list all arrive here as "no source named", and
      // deriveRuntimeArtifactOwnership answers 'unknown' for that — it is not
      // evidence that the row is public learning.
      const ownership = this.deriveRuntimeArtifactOwnership(
        parseIdListOrEmpty(row.source_instinct_ids),
        true,
      );
      if (ownership.scope === "user" && ownership.ownerUserId) {
        update.run("user", ownership.ownerUserId, row.id);
        ownerRecovered++;
      } else if (ownership.scope === "public") {
        update.run("public", null, row.id);
        madePublic++;
      } else {
        quarantined++;
      }
    }

    return { ownerRecovered, madePublic, quarantined };
  }

  /**
   * TEST SEAM: blank an artifact's recorded ownership, reproducing a row written
   * before {@link RuntimeArtifact.ownerScope} existed. Not used in production.
   */
  debugClearRuntimeArtifactOwnership(artifactId: string): void {
    this.ensureConnection();
    this.db!.prepare(
      "UPDATE runtime_artifacts SET owner_scope = 'unknown', owner_user_id = NULL WHERE id = ?",
    ).run(artifactId);
  }

  getRuntimeArtifact(id: string): RuntimeArtifact | null {
    this.ensureConnection();
    const row = this.db!.prepare("SELECT * FROM runtime_artifacts WHERE id = ?").get(id) as RuntimeArtifactRow | undefined;
    return row ? this.rowToRuntimeArtifact(row) : null;
  }

  getRuntimeArtifactBySourceInstinct(
    instinctId: string,
    kind?: RuntimeArtifact["kind"],
    states?: readonly RuntimeArtifact["state"][],
  ): RuntimeArtifact | null {
    this.ensureConnection();

    const params: Array<string | number> = [];
    let sql = `
      SELECT * FROM runtime_artifacts
      WHERE EXISTS (
        SELECT 1 FROM json_each(source_instinct_ids)
        WHERE json_each.value = ?
      )
    `;
    params.push(instinctId);

    if (kind) {
      sql += " AND kind = ?";
      params.push(kind);
    }
    if (states && states.length > 0) {
      sql += ` AND state IN (${states.map(() => "?").join(",")})`;
      params.push(...states);
    }

    sql += " ORDER BY updated_at DESC LIMIT 1";
    const row = this.db!.prepare(sql).get(...params) as RuntimeArtifactRow | undefined;
    return row ? this.rowToRuntimeArtifact(row) : null;
  }

  getRuntimeArtifacts(options: {
    states?: readonly RuntimeArtifact["state"][];
    kinds?: readonly RuntimeArtifact["kind"][];
    limit?: number;
    /**
     * ROUND 11 #1 — WHOSE PROMPT IS THIS FOR?
     *
     * Present ⇒ the ownership gate applies: 'public' artifacts always, a 'user'
     * artifact only for `userId`, and an 'unknown' one (ownership could not be
     * established) for nobody. Omitted ⇒ no gate, for auditing and reporting
     * surfaces that must see every row. The gate is in SQL on purpose: filtering
     * after a LIMIT would let another person's artifacts eat the candidate list.
     */
    visibility?: { userId?: string };
  } = {}): RuntimeArtifact[] {
    this.ensureConnection();

    let sql = "SELECT * FROM runtime_artifacts WHERE 1=1";
    const params: Array<string | number> = [];

    if (options.visibility) {
      const userId = options.visibility.userId?.trim();
      if (userId) {
        sql += " AND (COALESCE(owner_scope, 'unknown') = 'public'"
          + " OR (COALESCE(owner_scope, 'unknown') = 'user' AND owner_user_id = ?))";
        params.push(userId);
      } else {
        sql += " AND COALESCE(owner_scope, 'unknown') = 'public'";
      }
    }

    if (options.states && options.states.length > 0) {
      sql += ` AND state IN (${options.states.map(() => "?").join(",")})`;
      params.push(...options.states);
    }
    if (options.kinds && options.kinds.length > 0) {
      sql += ` AND kind IN (${options.kinds.map(() => "?").join(",")})`;
      params.push(...options.kinds);
    }

    sql += " ORDER BY updated_at DESC";
    if (options.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db!.prepare(sql).all(...params) as RuntimeArtifactRow[];
    return rows.map((row) => this.rowToRuntimeArtifact(row));
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

  // ─── Credit Ledger Operations (plan 6.4) ───────────────────────────────────

  /**
   * One run's settled credit for one instinct.
   *
   * `source` is the honest part: "terminal" means the run's own terminal
   * verdict decided this, "observed" means the caller knew no terminal verdict
   * and the worst evidence seen during the run was used instead. A reader must
   * never have to guess which.
   */
  recordInstinctCredit(entry: {
    instinctId: string;
    sessionId: string;
    taskRunId?: string;
    success: boolean;
    verdictScore: number;
    source: "terminal" | "observed";
    confidenceBefore: number;
    confidenceAfter: number;
    statusAt: string;
    timestamp: number;
    /**
     * ROUND 11 #8 — WHEN THE RUN WAS SHOWN THE GUIDANCE, which is not when the
     * credit settled. Since round 10 #14 the settlement rides a serial queue
     * behind the run's own events, so `timestamp` can be well after the
     * exposure — and the ledger read that gap as "a run applied the rule after
     * it was retired". Omitted ⇒ unrecorded, and the ledger says so rather than
     * assuming either answer.
     */
    exposedAt?: number;
    /**
     * FALSE = the run was SHOWN this guidance and did not apply it (it was
     * repaired another way). Weak evidence against the rule's trigger, and
     * the only record a cost-only misfire leaves. Omitted ⇒ an application.
     */
    applied?: boolean;
  }): void {
    this.ensureConnection();
    this.db!.prepare(`
      INSERT INTO instinct_credit_log
      (instinct_id, session_id, task_run_id, success, verdict_score, source,
       confidence_before, confidence_after, status_at, timestamp, exposed_at, applied)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.instinctId,
      entry.sessionId,
      entry.taskRunId ?? null,
      entry.success ? 1 : 0,
      entry.verdictScore,
      entry.source,
      entry.confidenceBefore,
      entry.confidenceAfter,
      entry.statusAt,
      entry.timestamp,
      entry.exposedAt ?? null,
      entry.applied === false ? 0 : 1,
    );
  }

  /**
   * "This guidance reached a prompt" — recorded whether or not anyone ever judges
   * it (round 14 follow-up to #14).
   *
   * One row per (instinct, session, run). Repeats of the same exposure keep the
   * EARLIEST `shown_at`, because that is what "when it was shown" means everywhere
   * else in this system, and they never reset a judgement already recorded.
   */
  recordInstinctExposure(entry: {
    instinctId: string;
    sessionId: string;
    taskRunId?: string;
    shownAt: number;
  }): void {
    this.ensureConnection();
    this.db!.prepare(`
      INSERT INTO instinct_exposure_log (instinct_id, session_id, task_run_id, shown_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(instinct_id, session_id, task_run_id)
        DO UPDATE SET shown_at = MIN(shown_at, excluded.shown_at)
    `).run(entry.instinctId, entry.sessionId, entry.taskRunId?.trim() ?? "", entry.shownAt);
  }

  /**
   * Something decided what this exposure meant. Only the FIRST judgement counts —
   * a run's outcome is decided once, and a second writer must not overwrite what
   * the first recorded.
   *
   * Returns whether a row moved, so a caller never mistakes "no such exposure" for
   * "judged". An exposure nobody recorded is not invented here: the producer of
   * the exposure is {@link recordInstinctExposure}, and a judgement with no
   * exposure behind it means the guidance reached the prompt through a path that
   * does not report exposures — which must read as unmeasured, not as judged.
   */
  markInstinctExposureJudged(entry: {
    instinctId: string;
    sessionId: string;
    taskRunId?: string;
    judgedAs: "credited" | "not-applied";
    judgedAt?: number;
  }): boolean {
    this.ensureConnection();
    const info = this.db!.prepare(`
      UPDATE instinct_exposure_log SET judged_at = ?, judged_as = ?
      WHERE instinct_id = ? AND session_id = ? AND task_run_id = ? AND judged_at IS NULL
    `).run(
      entry.judgedAt ?? Date.now(),
      entry.judgedAs,
      entry.instinctId,
      entry.sessionId,
      entry.taskRunId?.trim() ?? "",
    );
    return info.changes > 0;
  }

  /**
   * How many exposures were recorded in a window, and how many of them anything
   * judged — per instinct. The denominator of "are we measuring our own guidance".
   */
  getExposureCoverage(options?: { since?: number; until?: number; instinctId?: string }): Array<{
    instinctId: string;
    shown: number;
    judged: number;
    firstShownAt: number;
    lastShownAt: number;
  }> {
    this.ensureConnection();
    let sql = `
      SELECT instinct_id,
             COUNT(*) AS shown,
             SUM(CASE WHEN judged_at IS NULL THEN 0 ELSE 1 END) AS judged,
             MIN(shown_at) AS first_shown_at,
             MAX(shown_at) AS last_shown_at
      FROM instinct_exposure_log WHERE 1=1`;
    const params: (string | number)[] = [];
    if (options?.since !== undefined) {
      sql += " AND shown_at >= ?";
      params.push(options.since);
    }
    if (options?.until !== undefined) {
      sql += " AND shown_at <= ?";
      params.push(options.until);
    }
    if (options?.instinctId) {
      sql += " AND instinct_id = ?";
      params.push(options.instinctId);
    }
    sql += " GROUP BY instinct_id ORDER BY (COUNT(*) - SUM(CASE WHEN judged_at IS NULL THEN 0 ELSE 1 END)) DESC";
    const rows = this.db!.prepare(sql).all(...params) as Array<{
      instinct_id: string;
      shown: number;
      judged: number;
      first_shown_at: number;
      last_shown_at: number;
    }>;
    return rows.map((r) => ({
      instinctId: r.instinct_id,
      shown: r.shown,
      judged: r.judged ?? 0,
      firstShownAt: r.first_shown_at,
      lastShownAt: r.last_shown_at,
    }));
  }

  /** Drop exposure rows older than a cutoff; returns how many went. */
  pruneInstinctExposures(olderThanMs: number): number {
    this.ensureConnection();
    const info = this.db!.prepare("DELETE FROM instinct_exposure_log WHERE shown_at < ?").run(olderThanMs);
    return info.changes;
  }

  /** The runs one instinct influenced, newest first. */
  getInstinctCredits(options?: { instinctId?: string; since?: number; limit?: number }): InstinctCreditRecord[] {
    this.ensureConnection();
    let sql = "SELECT * FROM instinct_credit_log WHERE 1=1";
    const params: (string | number)[] = [];
    if (options?.instinctId) {
      sql += " AND instinct_id = ?";
      params.push(options.instinctId);
    }
    if (options?.since !== undefined) {
      sql += " AND timestamp >= ?";
      params.push(options.since);
    }
    sql += " ORDER BY timestamp DESC, id DESC";
    if (options?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    const rows = this.db!.prepare(sql).all(...params) as Array<{
      instinct_id: string;
      session_id: string;
      task_run_id: string | null;
      success: number;
      verdict_score: number;
      source: string;
      confidence_before: number;
      confidence_after: number;
      status_at: string;
      timestamp: number;
      exposed_at: number | null;
      applied: number | null;
    }>;
    return rows.map((row) => ({
      instinctId: row.instinct_id,
      sessionId: row.session_id,
      ...(row.task_run_id === null ? {} : { taskRunId: row.task_run_id }),
      success: row.success === 1,
      verdictScore: row.verdict_score,
      source: row.source === "terminal" ? "terminal" : "observed",
      confidenceBefore: row.confidence_before,
      confidenceAfter: row.confidence_after,
      statusAt: row.status_at,
      timestamp: row.timestamp,
      ...(row.exposed_at === null ? {} : { exposedAt: row.exposed_at }),
      // NULL only on a row from a database this column was added to: those were
      // all applications, so absence reads as applied, never as a misfire.
      applied: row.applied === null ? true : row.applied === 1,
    }));
  }

  /**
   * ROUND 11 #8 — RUNS THAT WERE SHOWN THE GUIDANCE AFTER A MOMENT, split by
   * what the ledger actually knows.
   *
   * `exposedAfter` is the real leak: the run saw the rule after it was retired.
   * `settledAfterExposedBefore` is the ordinary consequence of queued settlement
   * — exposure first, credit afterwards — and is not a leak. `exposureUnknown`
   * is every row written before the exposure time was recorded: it cannot be
   * placed on either side, and is reported as unknown rather than counted as
   * one of them.
   */
  countInstinctCreditsAcross(instinctId: string, at: number): {
    exposedAfter: number;
    settledAfterExposedBefore: number;
    exposureUnknown: number;
  } {
    this.ensureConnection();
    const row = this.db!.prepare(`
      SELECT
        SUM(CASE WHEN exposed_at IS NOT NULL AND exposed_at > ? THEN 1 ELSE 0 END) AS exposed_after,
        SUM(CASE WHEN exposed_at IS NOT NULL AND exposed_at <= ? AND timestamp > ? THEN 1 ELSE 0 END) AS settled_after,
        SUM(CASE WHEN exposed_at IS NULL AND timestamp > ? THEN 1 ELSE 0 END) AS unknown_exposure
      FROM instinct_credit_log WHERE instinct_id = ?
    `).get(at, at, at, at, instinctId) as {
      exposed_after: number | null;
      settled_after: number | null;
      unknown_exposure: number | null;
    };
    return {
      exposedAfter: row.exposed_after ?? 0,
      settledAfterExposedBefore: row.settled_after ?? 0,
      exposureUnknown: row.unknown_exposure ?? 0,
    };
  }

  /** Drop credit rows older than a cutoff; returns how many went. */
  pruneInstinctCredits(olderThanMs: number): number {
    this.ensureConnection();
    const info = this.db!.prepare("DELETE FROM instinct_credit_log WHERE timestamp < ?").run(olderThanMs);
    return info.changes;
  }

  /** Drop intervention-log rows older than a cutoff; returns how many went. */
  pruneInterventionLog(olderThanMs: number): number {
    this.ensureConnection();
    const info = this.db!.prepare("DELETE FROM intervention_log WHERE created_at < ?").run(olderThanMs);
    return info.changes;
  }

  /** Drop human trust signals older than a cutoff (LRN-20); returns how many went. */
  pruneTrustSignals(olderThanMs: number): number {
    this.ensureConnection();
    const info = this.db!.prepare("DELETE FROM instinct_trust_signals WHERE created_at < ?").run(olderThanMs);
    return info.changes;
  }

  /**
   * Record one explicit human signal about an instinct (LRN-20). Returns false
   * when this person already gave this signal for this run: a repeated or
   * toggled reaction is one signal. Only the newest `keep` rows per instinct
   * are retained.
   */
  recordTrustSignal(entry: {
    instinctId: string;
    userId: string;
    runKey: string;
    signal: "approval" | "rejection";
    createdAt: number;
    keep: number;
  }): boolean {
    this.ensureConnection();
    const info = this.db!.prepare(`
      INSERT OR IGNORE INTO instinct_trust_signals (instinct_id, user_id, run_key, signal, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(entry.instinctId, entry.userId, entry.runKey, entry.signal, entry.createdAt);
    if (info.changes === 0) return false;
    this.db!.prepare(`
      DELETE FROM instinct_trust_signals WHERE instinct_id = ? AND id NOT IN (
        SELECT id FROM instinct_trust_signals WHERE instinct_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(entry.instinctId, entry.instinctId, entry.keep);
    return true;
  }

  /** An instinct's most recent human trust signals, newest first (LRN-20). */
  getTrustSignals(instinctId: string, limit: number): Array<"approval" | "rejection"> {
    this.ensureConnection();
    const rows = this.db!.prepare(
      "SELECT signal FROM instinct_trust_signals WHERE instinct_id = ? ORDER BY id DESC LIMIT ?",
    ).all(instinctId, limit) as Array<{ signal: string }>;
    return rows.map((row) => (row.signal === "approval" ? "approval" : "rejection"));
  }

  /**
   * Set only an instinct's trust level (LRN-20). A narrow write, so it cannot
   * overwrite confidence or status that another path moved since the read.
   */
  updateInstinctTrustLevel(instinctId: string, trustLevel: TrustLevel): void {
    this.ensureConnection();
    this.db!.prepare("UPDATE instincts SET trust_level = ? WHERE id = ?").run(trustLevel, instinctId);
  }

  /**
   * Drop PROCESSED trajectories older than a cutoff, with their verdicts and
   * instinct links (deleted explicitly: foreign keys are not enforced on every
   * connection). Unprocessed trajectories are kept whatever their age.
   * Returns how many trajectories went.
   */
  pruneProcessedTrajectories(olderThanMs: number): number {
    this.ensureConnection();
    this.flush();
    const old = "SELECT id FROM trajectories WHERE processed = 1 AND created_at < ?";
    return this.db!.transaction(() => {
      this.db!.prepare(`DELETE FROM verdicts WHERE trajectory_id IN (${old})`).run(olderThanMs);
      this.db!.prepare(`DELETE FROM trajectory_instincts WHERE trajectory_id IN (${old})`).run(olderThanMs);
      return this.db!.prepare("DELETE FROM trajectories WHERE processed = 1 AND created_at < ?").run(olderThanMs).changes;
    })();
  }

  /**
   * Drop cross-session dedup markers ('session_hit' rows) older than a cutoff.
   * A marker only has to outlive its session; one is written per instinct per
   * session. Returns how many went.
   */
  pruneSessionHitMarkers(olderThanMs: number): number {
    this.ensureConnection();
    const info = this.db!.prepare(
      "DELETE FROM instinct_scopes WHERE scope_type = 'session_hit' AND created_at < ?",
    ).run(olderThanMs);
    return info.changes;
  }

  /**
   * Each instinct's evidence count: applications plus failures, the number the
   * lifecycle's observation minimums read. Unknown ids are left out.
   */
  instinctEvidenceCounts(instinctIds: readonly string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const id of instinctIds) {
      const instinct = this.getInstinct(id);
      if (instinct) counts[id] = (instinct.stats?.timesApplied ?? 0) + (instinct.stats?.timesFailed ?? 0);
    }
    return counts;
  }

  /** Every runtime artifact generated FROM this instinct, whatever its state. */
  getRuntimeArtifactsBySourceInstinct(instinctId: string): RuntimeArtifact[] {
    this.ensureConnection();
    const rows = this.db!.prepare(`
      SELECT * FROM runtime_artifacts
      WHERE EXISTS (SELECT 1 FROM json_each(source_instinct_ids) WHERE json_each.value = ?)
      ORDER BY updated_at DESC
    `).all(instinctId) as RuntimeArtifactRow[];
    return rows.map((row) => this.rowToRuntimeArtifact(row));
  }

  /**
   * RETIRE A PIECE OF GUIDANCE, AND MAKE THE RETIREMENT VISIBLE (plan 6.4).
   *
   * The plan's measure for the ledger is how long it takes wrong guidance to
   * stop having an effect, so this is one atomic action that ends every effect
   * it can and leaves the record a reader needs:
   *   - the instinct's status becomes 'deprecated' (or 'quarantined' for one
   *     that must never come back), which is what the retriever and the
   *     scope query already exclude;
   *   - every runtime artifact GENERATED from it is retired too — a rule
   *     retired while its generated skill stayed active kept having an effect;
   *   - a lifecycle-log row names the actor and the reason, so afterwards the
   *     ledger can say when and why it stopped.
   *
   * Never silent: an unknown id, or one already retired, is reported as such
   * rather than answered with a cheerful no-op.
   */
  retireInstinct(
    instinctId: string,
    opts: { reason: string; actor: string; quarantine?: boolean; now?: number },
  ): {
    ok: boolean;
    detail: string;
    from?: InstinctStatus;
    to?: InstinctStatus;
    retiredArtifacts: string[];
  } {
    this.ensureConnection();
    const instinct = this.getInstinct(instinctId as InstinctId);
    if (!instinct) {
      return { ok: false, detail: `no instinct with id ${instinctId}`, retiredArtifacts: [] };
    }
    const to: InstinctStatus = opts.quarantine === true ? "quarantined" : "deprecated";
    if (instinct.status === to) {
      return {
        ok: false,
        detail: `${instinctId} is already ${to} — nothing changed`,
        from: instinct.status,
        to,
        retiredArtifacts: [],
      };
    }
    const now = opts.now ?? Date.now();
    const reason = `Retired by ${opts.actor}: ${opts.reason}`.slice(0, 500);
    const artifacts = this.getRuntimeArtifactsBySourceInstinct(instinctId).filter(
      (a) => a.state === "active" || a.state === "shadow",
    );
    const run = this.db!.transaction(() => {
      this.db!.prepare("UPDATE instincts SET status = ?, updated_at = ? WHERE id = ?").run(to, now, instinctId);
      for (const artifact of artifacts) {
        this.db!.prepare(
          "UPDATE runtime_artifacts SET state = 'retired', retired_at = ?, last_state_reason = ?, source_evidence_at_close = ?, updated_at = ? WHERE id = ?",
        ).run(
          now,
          `source instinct retired: ${reason}`.slice(0, 500),
          JSON.stringify(this.instinctEvidenceCounts(artifact.sourceInstinctIds)),
          now,
          artifact.id,
        );
      }
      this.db!.prepare(`
        INSERT INTO instinct_lifecycle_log
        (instinct_id, from_status, to_status, reason, confidence_at_transition, bayesian_alpha, bayesian_beta, observation_count, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        instinctId,
        instinct.status,
        to,
        reason,
        instinct.confidence,
        instinct.bayesianAlpha ?? 1,
        instinct.bayesianBeta ?? 1,
        (instinct.stats?.timesApplied ?? 0) + (instinct.stats?.timesFailed ?? 0),
        now,
      );
    });
    run();
    return {
      ok: true,
      detail:
        `${instinctId}: ${instinct.status} → ${to}` +
        (artifacts.length > 0 ? `, and ${artifacts.length} generated artifact(s) retired with it` : ""),
      from: instinct.status,
      to,
      retiredArtifacts: artifacts.map((a) => String(a.id)),
    };
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

  // ─── Learning Pipeline v2 Operations ────────────────────────────────────────

  /** Whitelist of valid factor column names to prevent SQL injection */
  private static readonly FACTOR_COLUMNS = [
    'factor_recency',
    'factor_consistency',
    'factor_scope_breadth',
    'factor_user_validation',
    'factor_cross_session',
  ] as const;

  /** Store a feedback record */
  storeFeedback(record: {
    id: string;
    type: 'thumbs_up' | 'thumbs_down' | 'teaching' | 'correction';
    userId?: string;
    instinctIds?: string;
    content?: string;
    scopeType?: string;
    source?: string;
    createdAt: number;
  }): void {
    this.ensureConnection();
    this.db!.prepare(`
      INSERT INTO feedback (id, type, user_id, instinct_ids, content, scope_type, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.type,
      record.userId ?? null,
      record.instinctIds ?? null,
      record.content ?? null,
      record.scopeType ?? null,
      record.source ?? null,
      record.createdAt,
    );
  }

  /**
   * Whether `userId` has already reacted `type` to `instinctId`: a person's
   * reaction is evidence once per rule and direction, across restarts.
   */
  hasReactionFrom(userId: string, instinctId: string, type: 'thumbs_up' | 'thumbs_down'): boolean {
    this.ensureConnection();
    const escaped = instinctId.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const rows = this.db!.prepare(
      "SELECT instinct_ids FROM feedback WHERE user_id = ? AND type = ? AND instinct_ids LIKE ? ESCAPE '\\'"
    ).all(userId, type, `%${escaped}%`) as Array<{ instinct_ids: string | null }>;
    return rows.some((row) => {
      try {
        const ids: unknown = JSON.parse(row.instinct_ids ?? "[]");
        return Array.isArray(ids) && ids.includes(instinctId);
      } catch {
        return false;
      }
    });
  }

  /** Get feedback records that reference a given instinct ID */
  getFeedbackByInstinct(instinctId: string): Array<{
    id: string;
    type: string;
    userId: string | null;
    instinctIds: string | null;
    content: string | null;
    scopeType: string | null;
    source: string | null;
    createdAt: number;
  }> {
    this.ensureConnection();
    const escaped = instinctId.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const rows = this.db!.prepare(
      "SELECT * FROM feedback WHERE instinct_ids LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 100"
    ).all(`%${escaped}%`) as Array<{
      id: string;
      type: string;
      user_id: string | null;
      instinct_ids: string | null;
      content: string | null;
      scope_type: string | null;
      source: string | null;
      created_at: number;
    }>;
    return rows.map(row => ({
      id: row.id,
      type: row.type,
      userId: row.user_id,
      instinctIds: row.instinct_ids,
      content: row.content,
      scopeType: row.scope_type,
      source: row.source,
      createdAt: row.created_at,
    }));
  }

  /** Log an intervention event */
  logIntervention(entry: {
    id: string;
    instinctId: string;
    toolName: string;
    tier: string;
    actionTaken: string;
    userId?: string;
    createdAt: number;
  }): void {
    this.ensureConnection();
    this.db!.prepare(`
      INSERT INTO intervention_log (id, instinct_id, tool_name, tier, action_taken, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.instinctId,
      entry.toolName,
      entry.tier,
      entry.actionTaken,
      entry.userId ?? null,
      entry.createdAt,
    );
  }

  /** Get intervention log entries, optionally filtered by instinct */
  getInterventionLogs(instinctId?: string, limit: number = 100): Array<{
    id: string;
    instinctId: string;
    toolName: string;
    tier: string;
    actionTaken: string;
    userId: string | null;
    createdAt: number;
  }> {
    this.ensureConnection();
    let sql = "SELECT * FROM intervention_log";
    const params: (string | number)[] = [];

    if (instinctId) {
      sql += " WHERE instinct_id = ?";
      params.push(instinctId);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = this.db!.prepare(sql).all(...params) as Array<{
      id: string;
      instinct_id: string;
      tool_name: string;
      tier: string;
      action_taken: string;
      user_id: string | null;
      created_at: number;
    }>;
    return rows.map(row => ({
      id: row.id,
      instinctId: row.instinct_id,
      toolName: row.tool_name,
      tier: row.tier,
      actionTaken: row.action_taken,
      userId: row.user_id,
      createdAt: row.created_at,
    }));
  }

  /** Add an instinct scope with extended v2 fields (scope_type, user_id) */
  addInstinctScopeV2(instinctId: string, projectPath: string, scopeType: string = 'project', userId?: string): void {
    this.ensureConnection();
    this.db!.prepare(
      "INSERT OR IGNORE INTO instinct_scopes (instinct_id, project_path, created_at, scope_type, user_id) VALUES (?, ?, ?, ?, ?)"
    ).run(instinctId, projectPath, Date.now(), scopeType, userId ?? null);
  }

  /** Get all scopes for an instinct */
  getInstinctScopes(instinctId: string): Array<{
    instinctId: string;
    projectPath: string;
    scopeType: string | null;
    userId: string | null;
    createdAt: number;
  }> {
    this.ensureConnection();
    const rows = this.db!.prepare(
      "SELECT * FROM instinct_scopes WHERE instinct_id = ?"
    ).all(instinctId) as Array<{
      instinct_id: string;
      project_path: string;
      scope_type: string | null;
      user_id: string | null;
      created_at: number;
    }>;
    return rows.map(row => ({
      instinctId: row.instinct_id,
      projectPath: row.project_path,
      scopeType: row.scope_type,
      userId: row.user_id,
      createdAt: row.created_at,
    }));
  }

  /** Update a specific factor column on an instinct (validates against whitelist) */
  updateInstinctFactor(instinctId: string, factor: string, value: number): void {
    this.ensureConnection();
    if (!(LearningStorage.FACTOR_COLUMNS as readonly string[]).includes(factor)) {
      throw new Error(`Invalid factor: ${factor}`);
    }
    this.db!.prepare(`UPDATE instincts SET ${factor} = MIN(MAX(COALESCE(${factor}, 0.5) + ?, 0.0), 1.0) WHERE id = ?`).run(value, instinctId);
  }

  /** Get instincts by scope (joins instincts with instinct_scopes) */
  getInstinctsByScope(scopeType: string, userId?: string, projectPath?: string): Instinct[] {
    this.ensureConnection();
    let sql = `SELECT DISTINCT i.*, ${NARROWEST_SCOPE_SUBQUERIES} FROM instincts i INNER JOIN instinct_scopes s ON i.id = s.instinct_id WHERE s.scope_type = ?`;
    const params: (string | number)[] = [scopeType];

    if (userId) {
      sql += " AND s.user_id = ?";
      params.push(userId);
    }
    if (projectPath) {
      sql += " AND s.project_path = ?";
      params.push(projectPath);
    }

    sql += " ORDER BY i.confidence DESC LIMIT 500";

    const rows = this.db!.prepare(sql).all(...params) as InstinctRow[];
    return rows.map(r => this.rowToInstinct(r));
  }

  /** Count total instincts */
  countInstincts(): number {
    this.ensureConnection();
    const row = this.db!.prepare("SELECT COUNT(*) as cnt FROM instincts").get() as { cnt: number };
    return row.cnt;
  }

  /** Delete the lowest-confidence instincts with a given status */
  /** `keepId` (the instinct just created) is never among those deleted. */
  deleteLowestConfidenceInstincts(status: string, count: number, keepId?: string): void {
    const VALID_STATUSES = ['proposed', 'active', 'permanent', 'deprecated', 'evolved'];
    if (!VALID_STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
    if (count <= 0) return;
    this.ensureConnection();
    this.db!.prepare(`
      DELETE FROM instincts WHERE id IN (
        SELECT id FROM instincts WHERE status = ? AND id != ? ORDER BY confidence ASC LIMIT ?
      )
    `).run(status, keepId ?? "", count);
  }

  /** Get an instinct by its trigger pattern, optionally filtered by scope type */
  getInstinctByPattern(pattern: string, scopeType?: string): Instinct | null {
    this.ensureConnection();

    if (scopeType) {
      const row = this.db!.prepare(`
        SELECT DISTINCT i.*, ${NARROWEST_SCOPE_SUBQUERIES} FROM instincts i
        INNER JOIN instinct_scopes s ON i.id = s.instinct_id
        WHERE i.trigger_pattern = ? AND s.scope_type = ?
        LIMIT 1
      `).get(pattern, scopeType) as InstinctRow | undefined;
      return row ? this.rowToInstinct(row) : null;
    }

    const row = this.db!.prepare(
      "SELECT * FROM instincts WHERE trigger_pattern = ? LIMIT 1"
    ).get(pattern) as InstinctRow | undefined;
    return row ? this.rowToInstinct(row) : null;
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
        (SELECT COUNT(*) FROM observations WHERE processed = 0) as unprocessed_observation_count,
        (SELECT COUNT(*) FROM runtime_artifacts) as runtime_artifact_count,
        (SELECT COUNT(*) FROM runtime_artifacts WHERE state = 'active') as active_runtime_artifact_count
    `).get() as {
      instinct_count: number;
      active_instinct_count: number;
      trajectory_count: number;
      error_pattern_count: number;
      observation_count: number;
      unprocessed_observation_count: number;
      runtime_artifact_count: number;
      active_runtime_artifact_count: number;
    };
    
    return {
      instinctCount: stats.instinct_count,
      activeInstinctCount: stats.active_instinct_count,
      trajectoryCount: stats.trajectory_count,
      errorPatternCount: stats.error_pattern_count,
      observationCount: stats.observation_count,
      unprocessedObservationCount: stats.unprocessed_observation_count,
      runtimeArtifactCount: stats.runtime_artifact_count,
      activeRuntimeArtifactCount: stats.active_runtime_artifact_count,
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
      sourceTrajectoryIds: row.source_trajectory_ids
        ? JSON.parse(row.source_trajectory_ids) as TrajectoryId[]
        : [],
      tags: row.tags ? JSON.parse(row.tags) as string[] : [],
      embedding: row.embedding ? JSON.parse(row.embedding) as number[] : undefined,
      bayesianAlpha: row.bayesian_alpha ?? undefined,
      bayesianBeta: row.bayesian_beta ?? undefined,
      coolingStartedAt: row.cooling_started_at ? row.cooling_started_at as TimestampMs : undefined,
      coolingFailures: row.cooling_failures ?? undefined,
      originSessionId: row.origin_session_id ?? undefined,
      originBootCount: row.origin_boot_count ?? undefined,
      crossSessionHitCount: row.cross_session_hit_count ?? 0,
      migratedAt: row.migrated_at ? (row.migrated_at as TimestampMs) : undefined,
      factorRecency: row.factor_recency ?? undefined,
      factorConsistency: row.factor_consistency ?? undefined,
      factorScopeBreadth: row.factor_scope_breadth ?? undefined,
      factorUserValidation: row.factor_user_validation ?? undefined,
      factorCrossSession: row.factor_cross_session ?? undefined,
      trustLevel: (row.trust_level as TrustLevel) ?? undefined,
      seed: row.seed ? true : undefined,
      // item 3.1: the scope row's type and owner, when the query selected them.
      // Without this every instinct read back looked unscoped and unowned.
      scopeType: (row.scope_type as Instinct["scopeType"]) ?? undefined,
      userId: row.user_id ?? undefined,
    };
  }

  /**
   * Map rows, skipping any whose stored JSON cannot be parsed. Rows written
   * before storage stopped truncating serialized JSON can be damaged (SEC-3);
   * a single one used to make the whole read throw.
   */
  private parseRows<R extends { id: string }, T>(
    rows: R[],
    parse: (row: R) => T,
    kind: string,
  ): { items: T[]; badIds: string[] } {
    const items: T[] = [];
    const badIds: string[] = [];
    let firstError: unknown;
    for (const row of rows) {
      try {
        items.push(parse(row));
      } catch (error) {
        badIds.push(row.id);
        firstError ??= error;
      }
    }
    if (badIds.length > 0) {
      getLoggerSafe().warn(`[LearningStorage] Skipped ${badIds.length} unreadable ${kind} row(s)`, {
        ids: badIds.slice(0, 10),
        error: firstError instanceof Error ? firstError.message : String(firstError),
      });
    }
    return { items, badIds };
  }

  private rowToTrajectory(row: TrajectoryRow): Trajectory {
    return {
      id: row.id as TrajectoryId,
      sessionId: row.session_id as SessionId,
      chatId: row.chat_id ? row.chat_id as ChatId : undefined,
      taskRunId: row.task_run_id ?? undefined,
      userId: row.user_id ?? undefined,
      projectId: row.project_id ?? undefined,
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

  private rowToEvolutionProposal(row: EvolutionProposalRow): EvolutionProposal {
    return {
      id: row.id as EvolutionProposal["id"],
      instinctId: row.instinct_id as InstinctId,
      targetType: row.target_type as EvolutionProposal["targetType"],
      name: row.name,
      description: row.description,
      confidence: row.confidence,
      implementation: row.implementation ?? undefined,
      status: row.status as EvolutionProposal["status"],
      proposedAt: row.proposed_at as TimestampMs,
      decidedAt: row.decided_at ? row.decided_at as TimestampMs : undefined,
      affectedTrajectoryIds: row.affected_trajectory_ids
        ? JSON.parse(row.affected_trajectory_ids) as TrajectoryId[]
        : [],
    };
  }

  private rowToRuntimeArtifact(row: RuntimeArtifactRow): RuntimeArtifact {
    return {
      id: row.id as RuntimeArtifactId,
      kind: row.kind as RuntimeArtifact["kind"],
      state: row.state as RuntimeArtifact["state"],
      name: row.name,
      description: row.description,
      guidance: row.guidance,
      taskTypes: JSON.parse(row.task_types) as RuntimeArtifact["taskTypes"],
      taskPatterns: JSON.parse(row.task_patterns) as string[],
      projectWorldFingerprint: row.project_world_fingerprint ?? undefined,
      requiredToolNames: JSON.parse(row.required_tool_names) as string[],
      requiredCapabilities: JSON.parse(row.required_capabilities) as string[],
      // Round 12 #6: a corrupt provenance list leaves the row auditable (and
      // quarantined) instead of throwing out of every read that touches it.
      sourceInstinctIds: parseIdListOrEmpty(row.source_instinct_ids) as InstinctId[],
      sourceTrajectoryIds: parseIdListOrEmpty(row.source_trajectory_ids) as TrajectoryId[],
      stats: JSON.parse(row.stats) as RuntimeArtifactStats,
      shadowActivatedAt: row.shadow_activated_at ? row.shadow_activated_at as TimestampMs : undefined,
      promotedAt: row.promoted_at ? row.promoted_at as TimestampMs : undefined,
      rejectedAt: row.rejected_at ? row.rejected_at as TimestampMs : undefined,
      retiredAt: row.retired_at ? row.retired_at as TimestampMs : undefined,
      lastStateReason: row.last_state_reason ?? undefined,
      ownerScope: (row.owner_scope ?? "unknown") as RuntimeArtifactOwnerScope,
      ownerUserId: row.owner_user_id ?? undefined,
      sourceEvidenceAtClose: parseEvidenceCounts(row.source_evidence_at_close),
      createdAt: row.created_at as TimestampMs,
      updatedAt: row.updated_at as TimestampMs,
    };
  }

  /** Aggregate health data from SQLite for the /api/learning/health endpoint */
  getHealthAggregates(): {
    instinctSummary: { total: number; active: number; deprecated: number; permanent: number; proposed: number; avgConfidence: number };
    topPerformers: Array<{ id: string; name: string; confidence: number; status: string }>;
    lowPerformers: Array<{ id: string; name: string; confidence: number; status: string }>;
    feedbackCounts: { thumbs_up: number; thumbs_down: number; teaching: number; correction: number } | null;
    recentFeedback: Array<{ id: string; type: string; content: string | null; createdAt: number }>;
  } {
    this.ensureConnection();

    // Instinct summary: COUNT + conditional COUNT + AVG(confidence)
    const summaryRow = this.db!.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'deprecated' THEN 1 ELSE 0 END) as deprecated,
        SUM(CASE WHEN status = 'permanent' THEN 1 ELSE 0 END) as permanent,
        SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END) as proposed,
        AVG(confidence) as avg_confidence
      FROM instincts
    `).get() as { total: number; active: number; deprecated: number; permanent: number; proposed: number; avg_confidence: number | null };

    const instinctSummary = {
      total: summaryRow.total,
      active: summaryRow.active,
      deprecated: summaryRow.deprecated,
      permanent: summaryRow.permanent,
      proposed: summaryRow.proposed,
      avgConfidence: summaryRow.avg_confidence ?? 0,
    };

    // Top 5 performers: highest confidence among active/permanent
    const topRows = this.db!.prepare(`
      SELECT id, name, confidence, status FROM instincts
      WHERE status IN ('active', 'permanent')
      ORDER BY confidence DESC LIMIT 5
    `).all() as Array<{ id: string; name: string; confidence: number; status: string }>;

    // Low 5 performers: lowest confidence among proposed/active
    const lowRows = this.db!.prepare(`
      SELECT id, name, confidence, status FROM instincts
      WHERE status IN ('proposed', 'active')
      ORDER BY confidence ASC LIMIT 5
    `).all() as Array<{ id: string; name: string; confidence: number; status: string }>;

    // Feedback counts — graceful degradation if table does not exist
    let feedbackCounts: { thumbs_up: number; thumbs_down: number; teaching: number; correction: number } | null = null;
    let recentFeedback: Array<{ id: string; type: string; content: string | null; createdAt: number }> = [];

    try {
      const tableCheck = this.db!.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'"
      ).get() as { name: string } | undefined;

      if (tableCheck) {
        const fbRow = this.db!.prepare(`
          SELECT
            SUM(CASE WHEN type = 'thumbs_up' THEN 1 ELSE 0 END) as thumbs_up,
            SUM(CASE WHEN type = 'thumbs_down' THEN 1 ELSE 0 END) as thumbs_down,
            SUM(CASE WHEN type = 'teaching' THEN 1 ELSE 0 END) as teaching,
            SUM(CASE WHEN type = 'correction' THEN 1 ELSE 0 END) as correction
          FROM feedback
        `).get() as { thumbs_up: number; thumbs_down: number; teaching: number; correction: number };

        feedbackCounts = {
          thumbs_up: fbRow.thumbs_up ?? 0,
          thumbs_down: fbRow.thumbs_down ?? 0,
          teaching: fbRow.teaching ?? 0,
          correction: fbRow.correction ?? 0,
        };

        const recentRows = this.db!.prepare(
          "SELECT id, type, content, created_at FROM feedback ORDER BY created_at DESC LIMIT 10"
        ).all() as Array<{ id: string; type: string; content: string | null; created_at: number }>;

        recentFeedback = recentRows.map(r => ({
          id: r.id,
          type: r.type,
          content: r.content,
          createdAt: r.created_at,
        }));
      }
    } catch {
      // Feedback table unavailable — graceful degradation
    }

    return {
      instinctSummary,
      topPerformers: topRows,
      lowPerformers: lowRows,
      feedbackCounts,
      recentFeedback,
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
  source_trajectory_ids: string | null;
  tags: string | null;
  bayesian_alpha: number | null;
  bayesian_beta: number | null;
  cooling_started_at: number | null;
  cooling_failures: number | null;
  origin_session_id: string | null;
  origin_boot_count: number | null;
  cross_session_hit_count: number | null;
  migrated_at: number | null;
  // Learning Pipeline v2 factor columns
  factor_recency: number | null;
  factor_consistency: number | null;
  factor_scope_breadth: number | null;
  factor_user_validation: number | null;
  factor_cross_session: number | null;
  trust_level: string | null;
  seed: number | null;
  /**
   * From instinct_scopes, selected alongside the instinct by the scope-aware
   * queries (item 3.1). Absent (undefined) on queries that read the instincts
   * table alone.
   */
  scope_type?: string | null;
  user_id?: string | null;
}

interface TrajectoryRow {
  id: string;
  session_id: string;
  chat_id: string | null;
  task_run_id: string | null;
  user_id: string | null;
  project_id: string | null;
  task_description: string;
  steps: string;
  outcome: string;
  applied_instinct_ids: string;
  created_at: number;
  processed: number;
}

/** The columns {@link LearningStorage.getReplayTrajectoriesForOwner} reads. */
type TrajectoryReplayRow = Pick<TrajectoryRow, "id" | "task_description" | "outcome" | "created_at">;

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

interface EvolutionProposalRow {
  id: string;
  instinct_id: string;
  target_type: string;
  name: string;
  description: string;
  confidence: number;
  implementation: string | null;
  status: string;
  proposed_at: number;
  decided_at: number | null;
  affected_trajectory_ids: string | null;
}

interface RuntimeArtifactRow {
  id: string;
  kind: string;
  state: string;
  name: string;
  description: string;
  guidance: string;
  task_types: string;
  task_patterns: string;
  project_world_fingerprint: string | null;
  required_tool_names: string;
  required_capabilities: string;
  source_instinct_ids: string;
  source_trajectory_ids: string;
  stats: string;
  shadow_activated_at: number | null;
  promoted_at: number | null;
  rejected_at: number | null;
  retired_at: number | null;
  last_state_reason: string | null;
  owner_scope: string | null;
  owner_user_id: string | null;
  source_evidence_at_close?: string | null;
  created_at: number;
  updated_at: number;
}

/** A stored evidence snapshot; anything unreadable reads as none recorded. */
function parseEvidenceCounts(raw: string | null | undefined): Record<string, number> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const counts: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) counts[id] = value;
    }
    return counts;
  } catch {
    return undefined;
  }
}

// ─── Statistics Interface ───────────────────────────────────────────────────────

export interface LearningStats {
  instinctCount: number;
  activeInstinctCount: number;
  trajectoryCount: number;
  errorPatternCount: number;
  observationCount: number;
  unprocessedObservationCount: number;
  runtimeArtifactCount: number;
  activeRuntimeArtifactCount: number;
}

// ─── Credit Ledger (plan 6.4) ───────────────────────────────────────────────

/**
 * One run's settled credit for one instinct — the durable answer to "which
 * runs did this guidance influence, and how did they end".
 */
export interface InstinctCreditRecord {
  instinctId: string;
  sessionId: string;
  taskRunId?: string;
  success: boolean;
  verdictScore: number;
  /** "terminal" = the run's own terminal verdict; "observed" = in-run evidence. */
  source: "terminal" | "observed";
  confidenceBefore: number;
  confidenceAfter: number;
  /** The instinct's status when the credit settled. */
  statusAt: string;
  /** When the credit SETTLED. */
  timestamp: number;
  /** When the run was SHOWN the guidance (round 11 #8). Absent = unrecorded. */
  exposedAt?: number;
  /**
   * FALSE = shown to the run and not applied — a cost-only misfire. True for
   * every row written before the column existed, because those were all
   * applications.
   */
  applied: boolean;
}
