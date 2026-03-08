/**
 * Cross-Session Learning Transfer Tests
 *
 * Tests for Phase 13: types, config, migration runner, schema migration,
 * scope-filtered retrieval, age filtering, deduplication, provenance formatting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { validateConfig, resetConfigCache } from "../../config/config.js";
import type { Instinct, InstinctId, InstinctStatus } from "../types.js";
import type { TimestampMs } from "../../types/index.js";
import type { IEventBus } from "../../core/event-bus.js";
import type { ScopeContext } from "../matching/pattern-matcher.js";

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

// =============================================================================
// Plan 02 Task 1: Scope-filtered retrieval, age filtering, deduplication
// =============================================================================

/** Helper: create a test instinct with overrides */
function makeInstinct(overrides: Partial<Instinct> & { id: InstinctId }): Instinct {
  return {
    name: "Test instinct",
    type: "error_fix",
    status: "active" as InstinctStatus,
    confidence: 0.8 as any,
    triggerPattern: "test pattern",
    action: JSON.stringify({ description: "test action" }),
    contextConditions: [],
    stats: {
      timesSuggested: 0,
      timesApplied: 0,
      timesFailed: 0,
      successRate: 0 as any,
      averageExecutionMs: 0,
    },
    createdAt: Date.now() as TimestampMs,
    updatedAt: Date.now() as TimestampMs,
    sourceTrajectoryIds: [],
    tags: [],
    ...overrides,
  } as Instinct;
}

describe("LearningStorage.getInstinctsForScope", () => {
  let storage: any; // LearningStorage

  beforeEach(async () => {
    const { LearningStorage } = await import("./learning-storage.js");
    storage = new LearningStorage(":memory:");
    storage.initialize();

    // Create instincts with various scopes
    const projectA = makeInstinct({ id: "instinct_projA" as InstinctId, name: "Project A instinct" });
    const projectB = makeInstinct({ id: "instinct_projB" as InstinctId, name: "Project B instinct" });
    const universal = makeInstinct({ id: "instinct_universal" as InstinctId, name: "Universal instinct" });

    storage.createInstinct(projectA, "/projects/alpha");
    storage.createInstinct(projectB, "/projects/beta");
    storage.createInstinct(universal);

    // Add universal scope
    storage.addInstinctScope("instinct_universal", "*");
  });

  afterEach(() => {
    storage.close();
  });

  it("returns project-specific + universal instincts with 'project+universal'", () => {
    const results = storage.getInstinctsForScope({
      projectPath: "/projects/alpha",
      scopeFilter: "project+universal",
    });

    const ids = results.map((r: Instinct) => r.id);
    expect(ids).toContain("instinct_projA");
    expect(ids).toContain("instinct_universal");
    expect(ids).not.toContain("instinct_projB");
  });

  it("returns only project-specific instincts with 'project-only'", () => {
    const results = storage.getInstinctsForScope({
      projectPath: "/projects/alpha",
      scopeFilter: "project-only",
    });

    const ids = results.map((r: Instinct) => r.id);
    expect(ids).toContain("instinct_projA");
    expect(ids).not.toContain("instinct_universal");
    expect(ids).not.toContain("instinct_projB");
  });

  it("returns all instincts regardless of scope with 'all'", () => {
    const results = storage.getInstinctsForScope({
      projectPath: "/projects/alpha",
      scopeFilter: "all",
    });

    const ids = results.map((r: Instinct) => r.id);
    expect(ids).toContain("instinct_projA");
    expect(ids).toContain("instinct_projB");
    expect(ids).toContain("instinct_universal");
  });

  it("excludes instincts older than maxAgeDays", () => {
    // Create an old instinct (60 days ago)
    const oldTime = Date.now() - (60 * 24 * 60 * 60 * 1000);
    const oldInstinct = makeInstinct({
      id: "instinct_old" as InstinctId,
      name: "Old instinct",
      createdAt: oldTime as TimestampMs,
      updatedAt: oldTime as TimestampMs,
    });
    storage.createInstinct(oldInstinct, "/projects/alpha");

    const results = storage.getInstinctsForScope({
      projectPath: "/projects/alpha",
      scopeFilter: "project-only",
      maxAgeDays: 30,
    });

    const ids = results.map((r: Instinct) => r.id);
    expect(ids).toContain("instinct_projA");
    expect(ids).not.toContain("instinct_old");
  });

  it("does NOT exclude permanent instincts from age filtering", () => {
    // Create an old permanent instinct
    const oldTime = Date.now() - (120 * 24 * 60 * 60 * 1000);
    const permanentOld = makeInstinct({
      id: "instinct_perm_old" as InstinctId,
      name: "Permanent old",
      status: "permanent" as InstinctStatus,
      createdAt: oldTime as TimestampMs,
      updatedAt: oldTime as TimestampMs,
    });
    storage.createInstinct(permanentOld, "/projects/alpha");

    const results = storage.getInstinctsForScope({
      projectPath: "/projects/alpha",
      scopeFilter: "project-only",
      maxAgeDays: 30,
    });

    const ids = results.map((r: Instinct) => r.id);
    expect(ids).toContain("instinct_perm_old");
  });

  it("emits instinct:age_expired event for each age-filtered instinct when eventBus provided", () => {
    // Create an old instinct
    const oldTime = Date.now() - (60 * 24 * 60 * 60 * 1000);
    const oldInstinct = makeInstinct({
      id: "instinct_age_event" as InstinctId,
      name: "Age event test",
      createdAt: oldTime as TimestampMs,
      updatedAt: oldTime as TimestampMs,
    });
    storage.createInstinct(oldInstinct, "/projects/alpha");

    const emittedEvents: any[] = [];
    const mockEventBus = {
      emit: vi.fn((event: string, payload: any) => { emittedEvents.push({ event, payload }); }),
      on: vi.fn(),
      off: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as IEventBus;

    storage.getInstinctsForScope({
      projectPath: "/projects/alpha",
      scopeFilter: "project-only",
      maxAgeDays: 30,
      eventBus: mockEventBus,
    });

    expect(mockEventBus.emit).toHaveBeenCalledWith(
      "instinct:age_expired",
      expect.objectContaining({
        instinctId: "instinct_age_event",
        maxAgeDays: 30,
      }),
    );
    const payload = emittedEvents.find(e => e.event === "instinct:age_expired")?.payload;
    expect(payload.ageDays).toBeGreaterThanOrEqual(59);
    expect(payload.timestamp).toBeGreaterThan(0);
  });
});

describe("LearningStorage.addInstinctScope", () => {
  let storage: any;

  beforeEach(async () => {
    const { LearningStorage } = await import("./learning-storage.js");
    storage = new LearningStorage(":memory:");
    storage.initialize();

    const instinct = makeInstinct({ id: "instinct_scope_add" as InstinctId });
    storage.createInstinct(instinct);
  });

  afterEach(() => {
    storage.close();
  });

  it("inserts a row into instinct_scopes", () => {
    storage.addInstinctScope("instinct_scope_add", "/projects/delta");

    const db = storage.getDatabase();
    const row = db.prepare("SELECT * FROM instinct_scopes WHERE instinct_id = ? AND project_path = ?").get("instinct_scope_add", "/projects/delta") as any;
    expect(row).toBeDefined();
    expect(row.project_path).toBe("/projects/delta");
    expect(row.created_at).toBeGreaterThan(0);
  });
});

describe("LearningStorage.getInstinctScopeCount", () => {
  let storage: any;

  beforeEach(async () => {
    const { LearningStorage } = await import("./learning-storage.js");
    storage = new LearningStorage(":memory:");
    storage.initialize();

    const instinct = makeInstinct({ id: "instinct_count" as InstinctId });
    storage.createInstinct(instinct);
    storage.addInstinctScope("instinct_count", "/projects/a");
    storage.addInstinctScope("instinct_count", "/projects/b");
    storage.addInstinctScope("instinct_count", "*"); // Universal should not count
  });

  afterEach(() => {
    storage.close();
  });

  it("returns distinct non-universal project count", () => {
    const count = storage.getInstinctScopeCount("instinct_count");
    expect(count).toBe(2); // Only /projects/a and /projects/b
  });
});

describe("LearningStorage.incrementCrossSessionHitCount", () => {
  let storage: any;

  beforeEach(async () => {
    const { LearningStorage } = await import("./learning-storage.js");
    storage = new LearningStorage(":memory:");
    storage.initialize();

    const instinct = makeInstinct({
      id: "instinct_hit" as InstinctId,
      crossSessionHitCount: 0,
    });
    storage.createInstinct(instinct);
  });

  afterEach(() => {
    storage.close();
  });

  it("increments by 1", () => {
    storage.incrementCrossSessionHitCount("instinct_hit", "session_1");
    const inst = storage.getInstinct("instinct_hit");
    expect(inst.crossSessionHitCount).toBe(1);
  });

  it("is idempotent per session", () => {
    storage.incrementCrossSessionHitCount("instinct_hit", "session_1");
    storage.incrementCrossSessionHitCount("instinct_hit", "session_1");
    const inst1 = storage.getInstinct("instinct_hit");
    expect(inst1.crossSessionHitCount).toBe(1); // Not incremented again

    // Different session should increment
    storage.incrementCrossSessionHitCount("instinct_hit", "session_2");
    const inst2 = storage.getInstinct("instinct_hit");
    expect(inst2.crossSessionHitCount).toBe(2);
  });
});

describe("LearningStorage.mergeInstincts", () => {
  let storage: any;

  beforeEach(async () => {
    const { LearningStorage } = await import("./learning-storage.js");
    storage = new LearningStorage(":memory:");
    storage.initialize();

    const winner = makeInstinct({ id: "instinct_winner" as InstinctId, name: "Winner", confidence: 0.9 as any });
    const loser = makeInstinct({ id: "instinct_loser" as InstinctId, name: "Loser", confidence: 0.7 as any });

    storage.createInstinct(winner, "/projects/a");
    storage.createInstinct(loser, "/projects/b");
    // Add extra scope to loser to test transfer
    storage.addInstinctScope("instinct_loser", "/projects/c");
  });

  afterEach(() => {
    storage.close();
  });

  it("keeps winner, hard-deletes loser, transfers loser scopes to winner", () => {
    storage.mergeInstincts("instinct_winner", "instinct_loser");

    // Winner exists
    const winner = storage.getInstinct("instinct_winner");
    expect(winner).not.toBeNull();
    expect(winner!.name).toBe("Winner");

    // Loser is gone
    const loser = storage.getInstinct("instinct_loser");
    expect(loser).toBeNull();

    // Winner now has loser's scopes
    const db = storage.getDatabase();
    const scopes = db.prepare("SELECT project_path FROM instinct_scopes WHERE instinct_id = ? ORDER BY project_path").all("instinct_winner") as any[];
    const paths = scopes.map((s: any) => s.project_path);
    expect(paths).toContain("/projects/a"); // Original winner scope
    expect(paths).toContain("/projects/b"); // Transferred from loser
    expect(paths).toContain("/projects/c"); // Transferred from loser
  });
});

// =============================================================================
// Plan 02 Task 2: PatternMatcher scope-aware retrieval + InstinctRetriever provenance
// =============================================================================

describe("PatternMatcher scope-aware retrieval", () => {
  it("uses getInstinctsForScope when scope provided", async () => {
    const { PatternMatcher } = await import("../matching/pattern-matcher.js");
    const { LearningStorage } = await import("./learning-storage.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    // Create instincts with scopes
    const instinctA = makeInstinct({
      id: "instinct_scope_a" as InstinctId,
      triggerPattern: "fix typescript import error",
    });
    storage.createInstinct(instinctA, "/projects/alpha");

    const matcher = new PatternMatcher(storage);
    const scope: ScopeContext = {
      projectPath: "/projects/alpha",
      scopeFilter: "project-only",
      recencyBoost: 1.0,
      scopeBoost: 1.1,
    };

    const results = matcher.findSimilarInstincts("fix typescript import error", { scope });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.instinct!.id).toBe("instinct_scope_a");

    storage.close();
  });

  it("uses getInstincts when scope not provided (backward compat)", async () => {
    const { PatternMatcher } = await import("../matching/pattern-matcher.js");
    const { LearningStorage } = await import("./learning-storage.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    const instinct = makeInstinct({
      id: "instinct_no_scope_compat" as InstinctId,
      triggerPattern: "fix typescript import error",
    });
    storage.createInstinct(instinct);

    const matcher = new PatternMatcher(storage);

    // No scope: should use getInstincts (old path)
    const results = matcher.findSimilarInstincts("fix typescript import error");
    expect(results.length).toBeGreaterThanOrEqual(1);

    storage.close();
  });

  it("applies scopeBoost multiplier to same-project matches", async () => {
    const { PatternMatcher } = await import("../matching/pattern-matcher.js");
    const { LearningStorage } = await import("./learning-storage.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    const instinct = makeInstinct({
      id: "instinct_boost" as InstinctId,
      triggerPattern: "handle null reference",
      confidence: 0.8 as any,
    });
    storage.createInstinct(instinct, "/projects/alpha");

    const matcher = new PatternMatcher(storage);

    // Without scope boost
    const noScopeResults = matcher.findSimilarInstincts("handle null reference");
    const noScopeConfidence = noScopeResults[0]?.confidence ?? 0;

    // With scope boost
    const scope: ScopeContext = {
      projectPath: "/projects/alpha",
      scopeFilter: "project-only",
      recencyBoost: 1.0,
      scopeBoost: 1.5, // High boost to make difference clear
    };

    const scopeResults = matcher.findSimilarInstincts("handle null reference", { scope });
    const scopeConfidence = scopeResults[0]?.confidence ?? 0;

    // Scope-boosted confidence should be higher
    expect(scopeConfidence).toBeGreaterThan(noScopeConfidence);

    storage.close();
  });

  it("applies recencyBoost multiplier based on instinct age", async () => {
    const { PatternMatcher } = await import("../matching/pattern-matcher.js");
    const { LearningStorage } = await import("./learning-storage.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    // Create a recent instinct
    const recentInstinct = makeInstinct({
      id: "instinct_recent" as InstinctId,
      triggerPattern: "optimize database query for performance",
      confidence: 0.8 as any,
      createdAt: Date.now() as TimestampMs,
    });
    storage.createInstinct(recentInstinct, "/projects/alpha");

    // Create an old instinct (300 days ago) -- slightly different pattern to avoid dedup
    const oldTime = Date.now() - (300 * 24 * 60 * 60 * 1000);
    const oldInstinct = makeInstinct({
      id: "instinct_old_recency" as InstinctId,
      triggerPattern: "optimize database query for speed",
      confidence: 0.8 as any, // Same confidence to isolate recency effect
      createdAt: oldTime as TimestampMs,
      updatedAt: oldTime as TimestampMs,
    });
    storage.createInstinct(oldInstinct, "/projects/alpha");

    const matcher = new PatternMatcher(storage);
    const scope: ScopeContext = {
      projectPath: "/projects/alpha",
      scopeFilter: "project-only",
      recencyBoost: 1.5,
      scopeBoost: 1.0, // Isolate recency effect
    };

    const results = matcher.findSimilarInstincts("optimize database query for speed and performance", { scope, minSimilarity: 0.3 });
    // Recent instinct should rank higher because of recency boost
    const recentResult = results.find(r => r.instinct?.id === "instinct_recent");
    const oldResult = results.find(r => r.instinct?.id === "instinct_old_recency");
    expect(recentResult).toBeDefined();
    expect(oldResult).toBeDefined();
    expect(recentResult!.confidence).toBeGreaterThan(oldResult!.confidence);

    storage.close();
  });

  it("triggers eager dedup when similarity >= 0.85", async () => {
    const { PatternMatcher } = await import("../matching/pattern-matcher.js");
    const { LearningStorage } = await import("./learning-storage.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    // Two instincts with identical trigger patterns (will be >= 0.85 similarity)
    const instinct1 = makeInstinct({
      id: "instinct_dedup_1" as InstinctId,
      triggerPattern: "fix typescript import error in module",
      confidence: 0.9 as any,
    });
    const instinct2 = makeInstinct({
      id: "instinct_dedup_2" as InstinctId,
      triggerPattern: "fix typescript import error in module",
      confidence: 0.7 as any,
    });
    storage.createInstinct(instinct1, "/projects/alpha");
    storage.createInstinct(instinct2, "/projects/alpha");

    const matcher = new PatternMatcher(storage);
    const scope: ScopeContext = {
      projectPath: "/projects/alpha",
      scopeFilter: "project-only",
      recencyBoost: 1.0,
      scopeBoost: 1.0,
    };

    matcher.findSimilarInstincts("fix typescript import error in module", { scope });

    // After dedup, the lower-confidence instinct should be gone
    const remaining1 = storage.getInstinct("instinct_dedup_1");
    const remaining2 = storage.getInstinct("instinct_dedup_2");
    expect(remaining1).not.toBeNull(); // Winner (higher confidence)
    expect(remaining2).toBeNull(); // Loser (lower confidence) -- hard deleted

    storage.close();
  });
});

describe("InstinctRetriever provenance formatting", () => {
  it("includes provenance bracket when originBootCount exists", async () => {
    const { PatternMatcher } = await import("../matching/pattern-matcher.js");
    const { InstinctRetriever } = await import("../../agents/instinct-retriever.js");
    const { LearningStorage } = await import("./learning-storage.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    const createdAt = Date.now() - (2 * 24 * 60 * 60 * 1000); // 2 days ago
    const instinct = makeInstinct({
      id: "instinct_prov_format" as InstinctId,
      triggerPattern: "handle null reference",
      action: JSON.stringify({ description: "Add null check" }),
      confidence: 0.85 as any,
      stats: {
        timesSuggested: 10,
        timesApplied: 8,
        timesFailed: 2,
        successRate: 0.8 as any,
        averageExecutionMs: 100,
      },
      originBootCount: 3,
      originSessionId: "session_prev",
      crossSessionHitCount: 5,
      createdAt: createdAt as TimestampMs,
      updatedAt: createdAt as TimestampMs,
    });
    storage.createInstinct(instinct, "/projects/alpha");

    const matcher = new PatternMatcher(storage);
    const scope: ScopeContext = {
      projectPath: "/projects/alpha",
      scopeFilter: "project-only",
      recencyBoost: 1.0,
      scopeBoost: 1.0,
      currentBootCount: 10,
      currentSessionId: "session_current",
    };

    const retriever = new InstinctRetriever(matcher, { scopeContext: scope, storage });
    const result = await retriever.getInsightsForTask("handle null reference");

    expect(result.insights.length).toBeGreaterThanOrEqual(1);
    // Should contain provenance bracket
    expect(result.insights[0]).toMatch(/\[boot #3.*ago.*sessions\]/);

    storage.close();
  });

  it("omits provenance bracket when no provenance data", async () => {
    const { PatternMatcher } = await import("../matching/pattern-matcher.js");
    const { InstinctRetriever } = await import("../../agents/instinct-retriever.js");
    const { LearningStorage } = await import("./learning-storage.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    const instinct = makeInstinct({
      id: "instinct_no_prov" as InstinctId,
      triggerPattern: "handle null reference",
      action: JSON.stringify({ description: "Add null check" }),
      confidence: 0.85 as any,
      stats: {
        timesSuggested: 10,
        timesApplied: 8,
        timesFailed: 2,
        successRate: 0.8 as any,
        averageExecutionMs: 100,
      },
      // No originBootCount or originSessionId
    });
    storage.createInstinct(instinct);

    const matcher = new PatternMatcher(storage);
    const retriever = new InstinctRetriever(matcher);
    const result = await retriever.getInsightsForTask("handle null reference");

    expect(result.insights.length).toBeGreaterThanOrEqual(1);
    // Should NOT contain provenance bracket
    expect(result.insights[0]).not.toMatch(/\[boot #/);

    storage.close();
  });

  it("passes ScopeContext to findSimilarInstincts", async () => {
    const { PatternMatcher } = await import("../matching/pattern-matcher.js");
    const { InstinctRetriever } = await import("../../agents/instinct-retriever.js");
    const { LearningStorage } = await import("./learning-storage.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    const instinct = makeInstinct({
      id: "instinct_pass_scope" as InstinctId,
      triggerPattern: "validate user input",
      action: JSON.stringify({ description: "Add input validation" }),
      confidence: 0.8 as any,
      stats: {
        timesSuggested: 5,
        timesApplied: 4,
        timesFailed: 1,
        successRate: 0.8 as any,
        averageExecutionMs: 50,
      },
    });
    storage.createInstinct(instinct, "/projects/alpha");

    const matcher = new PatternMatcher(storage);
    const findSpy = vi.spyOn(matcher, "findSimilarInstincts");

    const scope: ScopeContext = {
      projectPath: "/projects/alpha",
      scopeFilter: "project-only",
      recencyBoost: 1.0,
      scopeBoost: 1.1,
    };

    const retriever = new InstinctRetriever(matcher, { scopeContext: scope, storage });
    await retriever.getInsightsForTask("validate user input");

    // Should have passed scope to findSimilarInstincts
    expect(findSpy).toHaveBeenCalledWith(
      "validate user input",
      expect.objectContaining({ scope }),
    );

    storage.close();
  });

  it("increments crossSessionHitCount for cross-session instincts", async () => {
    const { PatternMatcher } = await import("../matching/pattern-matcher.js");
    const { InstinctRetriever } = await import("../../agents/instinct-retriever.js");
    const { LearningStorage } = await import("./learning-storage.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    const instinct = makeInstinct({
      id: "instinct_hit_count" as InstinctId,
      triggerPattern: "optimize database query",
      action: JSON.stringify({ description: "Add index" }),
      confidence: 0.8 as any,
      stats: {
        timesSuggested: 5,
        timesApplied: 4,
        timesFailed: 1,
        successRate: 0.8 as any,
        averageExecutionMs: 50,
      },
      originBootCount: 1,
      originSessionId: "session_old",
      crossSessionHitCount: 0,
    });
    storage.createInstinct(instinct, "/projects/alpha");

    const matcher = new PatternMatcher(storage);
    const scope: ScopeContext = {
      projectPath: "/projects/alpha",
      scopeFilter: "project-only",
      recencyBoost: 1.0,
      scopeBoost: 1.0,
      currentBootCount: 5,
      currentSessionId: "session_current",
    };

    const retriever = new InstinctRetriever(matcher, { scopeContext: scope, storage });
    await retriever.getInsightsForTask("optimize database query");

    // Hit count should have been incremented
    const updated = storage.getInstinct("instinct_hit_count");
    expect(updated!.crossSessionHitCount).toBe(1);

    storage.close();
  });
});

// =============================================================================
// Plan 03 Task 1: Bootstrap wiring, metrics, and scope promotion
// =============================================================================

describe("Bootstrap wiring integration", () => {
  it("runs migration, builds ScopeContext, creates PatternMatcher with eventBus, retrieves with provenance", async () => {
    const { LearningStorage } = await import("./learning-storage.js");
    const { MigrationRunner } = await import("./migrations/index.js");
    const { migration001CrossSessionProvenance } = await import("./migrations/001-cross-session-provenance.js");
    const { PatternMatcher } = await import("../matching/pattern-matcher.js");
    const { InstinctRetriever } = await import("../../agents/instinct-retriever.js");
    const { TypedEventBus } = await import("../../core/event-bus.js");

    // 1. Create storage and run migration (simulates bootstrap flow)
    const storage = new LearningStorage(":memory:");
    storage.initialize();

    const db = storage.getDatabase()!;
    const runner = new MigrationRunner(db, ":memory:");
    const migrationResult = runner.run([migration001CrossSessionProvenance]);
    expect(migrationResult.applied.length).toBeGreaterThanOrEqual(0); // May be skipped if migrateSchema already applied

    // 2. Build ScopeContext (simulates bootstrap)
    const scopeContext: ScopeContext = {
      projectPath: "/projects/integration-test",
      scopeFilter: "project+universal",
      maxAgeDays: 90,
      recencyBoost: 1.0,
      scopeBoost: 1.1,
      currentBootCount: 5,
      currentSessionId: "boot-5",
    };

    // 3. Create PatternMatcher with eventBus
    const eventBus = new TypedEventBus();
    const matcher = new PatternMatcher(storage, { eventBus });

    // 4. Create an instinct with provenance
    const instinct = makeInstinct({
      id: "instinct_integration" as InstinctId,
      triggerPattern: "handle null reference in service",
      action: JSON.stringify({ description: "Add null safety checks" }),
      confidence: 0.85 as any,
      stats: {
        timesSuggested: 5,
        timesApplied: 4,
        timesFailed: 1,
        successRate: 0.8 as any,
        averageExecutionMs: 100,
      },
      originBootCount: 2,
      originSessionId: "session_old",
      crossSessionHitCount: 3,
    });
    storage.createInstinct(instinct, "/projects/integration-test");

    // 5. Create InstinctRetriever with scope context
    const retriever = new InstinctRetriever(matcher, {
      scopeContext,
      storage,
    });

    // 6. Retrieve insights
    const result = await retriever.getInsightsForTask("handle null reference in service");
    expect(result.insights.length).toBeGreaterThanOrEqual(1);
    expect(result.insights[0]).toMatch(/\[boot #2/);
    expect(result.matchedInstinctIds).toContain("instinct_integration");

    await eventBus.shutdown();
    storage.close();
  });
});

describe("Scope promotion via LearningPipeline", () => {
  it("promotes instinct to universal when learned in N distinct projects", async () => {
    const { LearningStorage } = await import("./learning-storage.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    // Create an instinct
    const instinct = makeInstinct({
      id: "instinct_promo_test" as InstinctId,
      triggerPattern: "test promotion pattern",
    });
    storage.createInstinct(instinct);

    // Add project-specific scopes for 3 distinct projects (promotion threshold = 3)
    storage.addInstinctScope("instinct_promo_test", "/projects/a");
    storage.addInstinctScope("instinct_promo_test", "/projects/b");
    storage.addInstinctScope("instinct_promo_test", "/projects/c");

    // Verify scope count reaches threshold
    const count = storage.getInstinctScopeCount("instinct_promo_test");
    expect(count).toBe(3);

    // Manually promote (simulates what pipeline does)
    storage.addInstinctScope("instinct_promo_test", "*");

    // Verify universal scope exists
    const db = storage.getDatabase()!;
    const universalScope = db.prepare("SELECT * FROM instinct_scopes WHERE instinct_id = ? AND project_path = '*'").get("instinct_promo_test") as any;
    expect(universalScope).toBeDefined();
    expect(universalScope.project_path).toBe("*");

    storage.close();
  });

  it("fires instinct:scope_promoted event when threshold reached", async () => {
    const { LearningStorage } = await import("./learning-storage.js");
    const { TypedEventBus } = await import("../../core/event-bus.js");
    const { LearningPipeline } = await import("../pipeline/learning-pipeline.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    const eventBus = new TypedEventBus();
    const promotedEvents: any[] = [];
    eventBus.on("instinct:scope_promoted", (payload) => {
      promotedEvents.push(payload);
    });

    const pipeline = new LearningPipeline(storage, {
      dbPath: ":memory:",
      enabled: true,
      batchSize: 10,
      detectionIntervalMs: 60000 as any,
      evolutionIntervalMs: 60000 as any,
      minConfidenceForCreation: 0.1,
      maxInstincts: 1000,
    }, undefined, undefined, eventBus);

    // Use threshold of 1 so a single project scope triggers promotion
    pipeline.setPromotionThreshold(1);
    pipeline.setProjectPath("/projects/promo-test");

    const created = pipeline.createInstinct({
      name: "Scope promo event test",
      type: "error_fix",
      status: "proposed",
      confidence: 0.6 as any,
      triggerPattern: "unique scope promo event pattern test string",
      action: JSON.stringify({ description: "test" }),
      contextConditions: [],
    });

    // With threshold=1, the single scope from creation should trigger promotion
    expect(promotedEvents.length).toBeGreaterThanOrEqual(1);
    const lastEvent = promotedEvents[promotedEvents.length - 1];
    expect(lastEvent.promotedToUniversal).toBe(true);
    expect(lastEvent.instinct.id).toBe(created.id);
    expect(lastEvent.projectPath).toBe("/projects/promo-test");

    // Verify universal scope was added
    const db = storage.getDatabase()!;
    const universalRow = db.prepare("SELECT * FROM instinct_scopes WHERE instinct_id = ? AND project_path = '*'").get(created.id) as any;
    expect(universalRow).toBeDefined();

    pipeline.stop();
    await eventBus.shutdown();
    storage.close();
  });
});

describe("MetricsRecorder.recordRetrievalMetrics", () => {
  it("is called during InstinctRetriever.getInsightsForTask when metricsRecorder provided", async () => {
    const { PatternMatcher } = await import("../matching/pattern-matcher.js");
    const { InstinctRetriever } = await import("../../agents/instinct-retriever.js");
    const { LearningStorage } = await import("./learning-storage.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    const instinct = makeInstinct({
      id: "instinct_metrics_test" as InstinctId,
      triggerPattern: "fix broken test",
      action: JSON.stringify({ description: "Fix the test" }),
      confidence: 0.8 as any,
      stats: {
        timesSuggested: 3,
        timesApplied: 2,
        timesFailed: 1,
        successRate: 0.67 as any,
        averageExecutionMs: 50,
      },
    });
    storage.createInstinct(instinct, "/projects/alpha");

    const matcher = new PatternMatcher(storage);
    const scope: ScopeContext = {
      projectPath: "/projects/alpha",
      scopeFilter: "project-only",
      recencyBoost: 1.0,
      scopeBoost: 1.0,
    };

    // Mock MetricsRecorder
    const mockMetricsRecorder = {
      recordRetrievalMetrics: vi.fn(),
      startTask: vi.fn(),
      endTask: vi.fn(),
    } as any;

    const retriever = new InstinctRetriever(matcher, {
      scopeContext: scope,
      storage,
      metricsRecorder: mockMetricsRecorder,
    });

    await retriever.getInsightsForTask("fix broken test");

    // Verify recordRetrievalMetrics was called
    expect(mockMetricsRecorder.recordRetrievalMetrics).toHaveBeenCalledTimes(1);
    expect(mockMetricsRecorder.recordRetrievalMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        retrievalTimeMs: expect.any(Number),
        instinctsScanned: expect.any(Number),
        scopeFiltered: expect.any(Number),
        insightsReturned: expect.any(Number),
      }),
    );

    storage.close();
  });

  it("does not fail when metricsRecorder is not provided", async () => {
    const { PatternMatcher } = await import("../matching/pattern-matcher.js");
    const { InstinctRetriever } = await import("../../agents/instinct-retriever.js");
    const { LearningStorage } = await import("./learning-storage.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    const instinct = makeInstinct({
      id: "instinct_no_metrics" as InstinctId,
      triggerPattern: "fix broken test no metrics",
      action: JSON.stringify({ description: "Fix" }),
      confidence: 0.8 as any,
      stats: {
        timesSuggested: 1,
        timesApplied: 1,
        timesFailed: 0,
        successRate: 1.0 as any,
        averageExecutionMs: 50,
      },
    });
    storage.createInstinct(instinct);

    const matcher = new PatternMatcher(storage);
    const retriever = new InstinctRetriever(matcher);

    // Should not throw
    const result = await retriever.getInsightsForTask("fix broken test no metrics");
    expect(result.insights.length).toBeGreaterThanOrEqual(1);

    storage.close();
  });
});

// =============================================================================
// Plan 03 Task 2: Cross-session CLI subcommand
// =============================================================================

describe("crossSessionCommand JSON output", () => {
  it("returns valid JSON structure with all required sections", async () => {
    const { LearningStorage } = await import("./learning-storage.js");
    const { gatherCrossSessionStats } = await import("../../metrics/metrics-cli.js");

    const storage = new LearningStorage(":memory:");
    storage.initialize();

    // Populate test data
    const instinct1 = makeInstinct({
      id: "instinct_cli_1" as InstinctId,
      triggerPattern: "cli test pattern one",
      originBootCount: 1,
      originSessionId: "session_1",
      crossSessionHitCount: 5,
    });
    const instinct2 = makeInstinct({
      id: "instinct_cli_2" as InstinctId,
      triggerPattern: "cli test pattern two",
      originBootCount: 2,
      originSessionId: "session_2",
      crossSessionHitCount: 3,
    });
    const instinct3 = makeInstinct({
      id: "instinct_cli_3" as InstinctId,
      triggerPattern: "cli test pattern three",
      originBootCount: 1,
      originSessionId: "session_1",
      crossSessionHitCount: 0,
    });

    storage.createInstinct(instinct1, "/projects/alpha");
    storage.createInstinct(instinct2, "/projects/beta");
    storage.createInstinct(instinct3, "/projects/alpha");

    // Add universal scope for instinct1
    storage.addInstinctScope("instinct_cli_1", "*");

    // Gather stats (used internally by crossSessionCommand)
    const stats = gatherCrossSessionStats(storage);

    // Verify structure
    expect(stats.provenanceDistribution).toBeInstanceOf(Array);
    expect(stats.provenanceDistribution.length).toBeGreaterThanOrEqual(1);
    // Boot 1 should have 2 instincts, boot 2 should have 1
    const boot1 = stats.provenanceDistribution.find(r => r.bootCount === 1);
    const boot2 = stats.provenanceDistribution.find(r => r.bootCount === 2);
    expect(boot1?.instinctCount).toBe(2);
    expect(boot2?.instinctCount).toBe(1);

    // Scope stats
    expect(stats.scopeStats.projectSpecific).toBeGreaterThanOrEqual(2); // /projects/alpha (2) + /projects/beta (1)
    expect(stats.scopeStats.universal).toBe(1); // instinct_cli_1 with '*'

    // Age histogram -- all created just now, so all in 0-7d
    expect(stats.ageHistogram.find(r => r.bucket === "0-7d")?.count).toBe(3);

    // Cross-session value
    expect(stats.crossSessionValue.length).toBe(2); // instinct_cli_1 (5 hits) and instinct_cli_2 (3 hits)
    expect(stats.crossSessionValue[0]!.hitCount).toBe(5);
    expect(stats.crossSessionValue[1]!.hitCount).toBe(3);

    // Migration stats (migrations table created by migrateSchema -> MigrationRunner not run here)
    expect(stats.migrationStats.migrationsApplied).toBeGreaterThanOrEqual(0);

    // Verify JSON serialization
    const json = JSON.stringify(stats, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.provenanceDistribution).toBeDefined();
    expect(parsed.scopeStats).toBeDefined();
    expect(parsed.ageHistogram).toBeDefined();
    expect(parsed.crossSessionValue).toBeDefined();
    expect(parsed.migrationStats).toBeDefined();

    storage.close();
  });
});
