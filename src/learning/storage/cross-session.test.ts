/**
 * Cross-Session Learning Transfer Tests
 *
 * Tests for Phase 13 Plan 01: types, config, migration runner, and schema migration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { validateConfig, resetConfigCache } from "../../config/config.js";
import type { Instinct, InstinctId } from "../types.js";
import type { TimestampMs } from "../../types/index.js";

// =============================================================================
// Task 1: Types, Config, and Event Bus contracts
// =============================================================================

describe("CrossSessionConfig", () => {
  beforeEach(() => {
    resetConfigCache();
  });

  it("should parse defaults correctly", () => {
    const result = validateConfig({
      anthropicApiKey: "sk-test-key-000000000000000000000000000000000000000000000000",
      unityProjectPath: process.cwd(),
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;

    const config = result.value;
    expect(config.crossSession).toBeDefined();
    expect(config.crossSession.enabled).toBe(true);
    expect(config.crossSession.maxAgeDays).toBe(90);
    expect(config.crossSession.scopeFilter).toBe("project+universal");
    expect(config.crossSession.recencyBoost).toBe(1.0);
    expect(config.crossSession.scopeBoost).toBe(1.1);
    expect(config.crossSession.promotionThreshold).toBe(3);
  });

  it("should accept STRATA_INSTINCT_MAX_AGE_DAYS env var override", () => {
    const result = validateConfig({
      anthropicApiKey: "sk-test-key-000000000000000000000000000000000000000000000000",
      unityProjectPath: process.cwd(),
      crossSessionMaxAgeDays: "60",
    });

    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;

    expect(result.value.crossSession.maxAgeDays).toBe(60);
  });

  it("should accept STRATA_INSTINCT_SCOPE_FILTER values", () => {
    for (const filter of ["project-only", "project+universal", "all"] as const) {
      resetConfigCache();
      const result = validateConfig({
        anthropicApiKey: "sk-test-key-000000000000000000000000000000000000000000000000",
        unityProjectPath: process.cwd(),
        crossSessionScopeFilter: filter,
      });
      expect(result.kind).toBe("valid");
      if (result.kind !== "valid") continue;
      expect(result.value.crossSession.scopeFilter).toBe(filter);
    }
  });
});

describe("Instinct provenance fields", () => {
  it("should include originSessionId, originBootCount, crossSessionHitCount, migratedAt", () => {
    // Type-level verification: create an Instinct with provenance fields
    const instinct: Instinct = {
      id: "instinct_test_001" as Instinct["id"],
      name: "Test instinct",
      type: "error_fix",
      status: "active",
      confidence: 0.8 as any,
      triggerPattern: "test pattern",
      action: "test action",
      contextConditions: [],
      stats: {
        timesSuggested: 0,
        timesApplied: 0,
        timesFailed: 0,
        successRate: 0 as any,
        averageExecutionMs: 0,
      },
      createdAt: Date.now() as any,
      updatedAt: Date.now() as any,
      sourceTrajectoryIds: [],
      tags: [],
      originSessionId: "session_abc",
      originBootCount: 5,
      crossSessionHitCount: 3,
      migratedAt: Date.now() as any,
    };

    expect(instinct.originSessionId).toBe("session_abc");
    expect(instinct.originBootCount).toBe(5);
    expect(instinct.crossSessionHitCount).toBe(3);
    expect(instinct.migratedAt).toBeDefined();
  });
});

describe("LearningEventMap cross-session events", () => {
  it("should include instinct:scope_promoted, instinct:merged, instinct:age_expired", async () => {
    const { TypedEventBus } = await import("../../core/event-bus.js");
    const bus = new TypedEventBus();

    // Verify these event names are accepted by the typed bus
    const events: string[] = [];

    bus.on("instinct:scope_promoted", (payload) => {
      events.push("scope_promoted");
      expect(payload.instinct).toBeDefined();
      expect(payload.projectPath).toBeDefined();
      expect(payload.promotedToUniversal).toBeDefined();
      expect(payload.distinctProjectCount).toBeDefined();
      expect(payload.timestamp).toBeDefined();
    });

    bus.on("instinct:merged", (payload) => {
      events.push("merged");
      expect(payload.winner).toBeDefined();
      expect(payload.loserId).toBeDefined();
      expect(payload.reason).toBeDefined();
      expect(payload.timestamp).toBeDefined();
    });

    bus.on("instinct:age_expired", (payload) => {
      events.push("age_expired");
      expect(payload.instinctId).toBeDefined();
      expect(payload.ageDays).toBeDefined();
      expect(payload.maxAgeDays).toBeDefined();
      expect(payload.timestamp).toBeDefined();
    });

    // Emit test events
    bus.emit("instinct:scope_promoted", {
      instinct: { id: "instinct_test" } as any,
      projectPath: "/test/project",
      promotedToUniversal: true,
      distinctProjectCount: 3,
      timestamp: Date.now(),
    });

    bus.emit("instinct:merged", {
      winner: { id: "instinct_winner" } as any,
      loserId: "instinct_loser" as any,
      reason: "duplicate pattern",
      timestamp: Date.now(),
    });

    bus.emit("instinct:age_expired", {
      instinctId: "instinct_old" as any,
      ageDays: 100,
      maxAgeDays: 90,
      timestamp: Date.now(),
    });

    await bus.shutdown();

    expect(events).toContain("scope_promoted");
    expect(events).toContain("merged");
    expect(events).toContain("age_expired");
  });
});

// =============================================================================
// Task 2: Migration runner, migration 001, LearningStorage provenance
// =============================================================================

/**
 * Helper: create a minimal instincts base schema (pre-provenance)
 * Mirrors the original SCHEMA_SQL minus provenance columns
 */
function createBaseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instincts (
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
    );
    CREATE INDEX IF NOT EXISTS idx_instincts_status_confidence ON instincts(status, confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_instincts_type_status ON instincts(type, status);
  `);
}

/** Insert a test instinct into the base schema */
function insertTestInstinct(db: Database.Database, id: string, createdAt: number = 1000): void {
  db.prepare(`
    INSERT INTO instincts (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, created_at, updated_at)
    VALUES (?, ?, 'error_fix', 'active', 0.8, 'test pattern', 'test action', '[]', '{}', ?, ?)
  `).run(id, `Test ${id}`, createdAt, createdAt);
}

describe("MigrationRunner", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createBaseSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("should create migrations table if not exists", async () => {
    const { MigrationRunner } = await import("./migrations/index.js");
    const runner = new MigrationRunner(db, ":memory:");
    runner.run([]);

    // Verify migrations table exists
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'").get() as { name: string } | undefined;
    expect(table).toBeDefined();
    expect(table!.name).toBe("migrations");
  });

  it("should skip already-applied migrations (idempotent)", async () => {
    const { MigrationRunner } = await import("./migrations/index.js");
    const runner = new MigrationRunner(db, ":memory:");

    const migration = {
      name: "test-migration",
      up: vi.fn((d: Database.Database) => {
        d.exec("CREATE TABLE IF NOT EXISTS test_table (id TEXT PRIMARY KEY)");
      }),
    };

    // First run
    const result1 = runner.run([migration]);
    expect(result1.applied).toContain("test-migration");
    expect(result1.skipped).toHaveLength(0);
    expect(migration.up).toHaveBeenCalledTimes(1);

    // Second run - should skip
    const result2 = runner.run([migration]);
    expect(result2.applied).toHaveLength(0);
    expect(result2.skipped).toContain("test-migration");
    expect(migration.up).toHaveBeenCalledTimes(1); // Not called again
  });

  it("should apply new migrations in order", async () => {
    const { MigrationRunner } = await import("./migrations/index.js");
    const runner = new MigrationRunner(db, ":memory:");

    const order: string[] = [];
    const migrations = [
      { name: "001-first", up: () => { order.push("first"); } },
      { name: "002-second", up: () => { order.push("second"); } },
      { name: "003-third", up: () => { order.push("third"); } },
    ];

    const result = runner.run(migrations);
    expect(result.applied).toEqual(["001-first", "002-second", "003-third"]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("should auto-backup when unapplied migrations exist (file-based only)", async () => {
    const { MigrationRunner } = await import("./migrations/index.js");
    // For :memory: databases, backup is skipped -- test that it does not throw
    const runner = new MigrationRunner(db, ":memory:");
    const migration = { name: "test", up: () => {} };
    const result = runner.run([migration]);
    expect(result.applied).toContain("test");
  });
});

describe("Migration 001: cross-session-provenance", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createBaseSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("should add provenance columns to instincts", async () => {
    const { migration001CrossSessionProvenance } = await import("./migrations/001-cross-session-provenance.js");
    const { MigrationRunner } = await import("./migrations/index.js");

    const runner = new MigrationRunner(db, ":memory:");
    runner.run([migration001CrossSessionProvenance]);

    // Verify columns exist by inserting a row with them
    db.prepare(`
      INSERT INTO instincts (id, name, type, status, confidence, trigger_pattern, action, context_conditions, stats, created_at, updated_at, origin_session_id, origin_boot_count, cross_session_hit_count, migrated_at)
      VALUES ('instinct_test', 'Test', 'error_fix', 'active', 0.8, 'p', 'a', '[]', '{}', 1000, 1000, 'session_1', 5, 0, 2000)
    `).run();

    const row = db.prepare("SELECT origin_session_id, origin_boot_count, cross_session_hit_count, migrated_at FROM instincts WHERE id = 'instinct_test'").get() as any;
    expect(row.origin_session_id).toBe("session_1");
    expect(row.origin_boot_count).toBe(5);
    expect(row.cross_session_hit_count).toBe(0);
    expect(row.migrated_at).toBe(2000);
  });

  it("should create instinct_scopes table with covering index", async () => {
    const { migration001CrossSessionProvenance } = await import("./migrations/001-cross-session-provenance.js");
    const { MigrationRunner } = await import("./migrations/index.js");

    const runner = new MigrationRunner(db, ":memory:");
    runner.run([migration001CrossSessionProvenance]);

    // Verify table exists
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instinct_scopes'").get() as { name: string } | undefined;
    expect(table).toBeDefined();

    // Verify index exists
    const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_instinct_scopes_path'").get() as { name: string } | undefined;
    expect(index).toBeDefined();
  });

  it("should backfill existing instincts with universal scope", async () => {
    // Insert instincts BEFORE migration
    insertTestInstinct(db, "instinct_old_1", 1000);
    insertTestInstinct(db, "instinct_old_2", 2000);

    const { migration001CrossSessionProvenance } = await import("./migrations/001-cross-session-provenance.js");
    const { MigrationRunner } = await import("./migrations/index.js");

    const runner = new MigrationRunner(db, ":memory:");
    runner.run([migration001CrossSessionProvenance]);

    // Verify scopes backfilled as universal
    const scopes = db.prepare("SELECT * FROM instinct_scopes ORDER BY instinct_id").all() as any[];
    expect(scopes).toHaveLength(2);
    expect(scopes[0].instinct_id).toBe("instinct_old_1");
    expect(scopes[0].project_path).toBe("*");
    expect(scopes[1].instinct_id).toBe("instinct_old_2");
    expect(scopes[1].project_path).toBe("*");

    // Verify migrated_at is set
    const instincts = db.prepare("SELECT migrated_at FROM instincts WHERE migrated_at IS NOT NULL").all() as any[];
    expect(instincts).toHaveLength(2);
  });

  it("should be idempotent -- running twice does not error", async () => {
    const { migration001CrossSessionProvenance } = await import("./migrations/001-cross-session-provenance.js");
    const { MigrationRunner } = await import("./migrations/index.js");

    insertTestInstinct(db, "instinct_idem", 1000);

    const runner = new MigrationRunner(db, ":memory:");

    // First run
    runner.run([migration001CrossSessionProvenance]);
    const scopes1 = db.prepare("SELECT COUNT(*) as cnt FROM instinct_scopes").get() as { cnt: number };

    // Second run -- migration is skipped by runner but let's also test migration.up directly
    migration001CrossSessionProvenance.up(db);

    // Should not duplicate scopes
    const scopes2 = db.prepare("SELECT COUNT(*) as cnt FROM instinct_scopes").get() as { cnt: number };
    expect(scopes2.cnt).toBe(scopes1.cnt);
  });
});

describe("LearningStorage provenance", () => {
  let storage: any; // LearningStorage

  beforeEach(async () => {
    const { LearningStorage } = await import("./learning-storage.js");
    storage = new LearningStorage(":memory:");
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
  });

  it("should expose getDatabase() returning the db instance", () => {
    const db = storage.getDatabase();
    expect(db).toBeDefined();
    expect(db).not.toBeNull();
  });

  it("should write provenance columns in createInstinct", () => {
    const instinct: Instinct = {
      id: "instinct_prov_test" as InstinctId,
      name: "Provenance test",
      type: "error_fix",
      status: "active",
      confidence: 0.8 as any,
      triggerPattern: "test",
      action: "test action",
      contextConditions: [],
      stats: {
        timesSuggested: 0,
        timesApplied: 5,
        timesFailed: 1,
        successRate: 0.83 as any,
        averageExecutionMs: 100,
      },
      createdAt: 5000 as TimestampMs,
      updatedAt: 5000 as TimestampMs,
      sourceTrajectoryIds: [],
      tags: [],
      originSessionId: "session_xyz",
      originBootCount: 10,
      crossSessionHitCount: 7,
      migratedAt: 4000 as TimestampMs,
    };

    storage.createInstinct(instinct);

    const retrieved = storage.getInstinct("instinct_prov_test");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.originSessionId).toBe("session_xyz");
    expect(retrieved!.originBootCount).toBe(10);
    expect(retrieved!.crossSessionHitCount).toBe(7);
    expect(retrieved!.migratedAt).toBe(4000);
  });

  it("should insert instinct_scopes row when projectPath provided", () => {
    const instinct: Instinct = {
      id: "instinct_scope_test" as InstinctId,
      name: "Scope test",
      type: "tool_usage",
      status: "proposed",
      confidence: 0.5 as any,
      triggerPattern: "scope",
      action: "scope action",
      contextConditions: [],
      stats: {
        timesSuggested: 0,
        timesApplied: 0,
        timesFailed: 0,
        successRate: 0 as any,
        averageExecutionMs: 0,
      },
      createdAt: 6000 as TimestampMs,
      updatedAt: 6000 as TimestampMs,
      sourceTrajectoryIds: [],
      tags: [],
    };

    storage.createInstinct(instinct, "/my/project");

    // Verify instinct_scopes row
    const db = storage.getDatabase();
    const scope = db.prepare("SELECT * FROM instinct_scopes WHERE instinct_id = ?").get("instinct_scope_test") as any;
    expect(scope).toBeDefined();
    expect(scope.project_path).toBe("/my/project");
    expect(scope.instinct_id).toBe("instinct_scope_test");
  });

  it("should NOT insert instinct_scopes row when projectPath not provided", () => {
    const instinct: Instinct = {
      id: "instinct_no_scope" as InstinctId,
      name: "No scope test",
      type: "error_fix",
      status: "proposed",
      confidence: 0.5 as any,
      triggerPattern: "no scope",
      action: "action",
      contextConditions: [],
      stats: {
        timesSuggested: 0,
        timesApplied: 0,
        timesFailed: 0,
        successRate: 0 as any,
        averageExecutionMs: 0,
      },
      createdAt: 7000 as TimestampMs,
      updatedAt: 7000 as TimestampMs,
      sourceTrajectoryIds: [],
      tags: [],
    };

    storage.createInstinct(instinct); // No projectPath

    const db = storage.getDatabase();
    const scope = db.prepare("SELECT * FROM instinct_scopes WHERE instinct_id = ?").get("instinct_no_scope") as any;
    expect(scope).toBeUndefined();
  });
});
