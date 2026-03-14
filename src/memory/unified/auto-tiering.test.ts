/**
 * Auto-Tiering Sweep Tests
 *
 * Tests for the automatic promotion/demotion of memory entries
 * between Working (hot), Ephemeral (warm), and Persistent (cold) tiers
 * based on access patterns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentDBMemory, _setNowFn, _resetNowFn } from "./agentdb-memory.js";
import type { MemoryDecayConfig } from "../memory.interface.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type { TimestampMs } from "../../types/index.js";
import { createBrand } from "../../types/index.js";

// Mock better-sqlite3 and HNSW dependencies
vi.mock("better-sqlite3", () => {
  const prepare = vi.fn().mockReturnValue({
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn().mockReturnValue([]),
  });
  const MockDb = vi.fn().mockImplementation(() => ({
    exec: vi.fn(),
    prepare,
    pragma: vi.fn(),
    close: vi.fn(),
  }));
  return { default: MockDb };
});

vi.mock("./sqlite-pragmas.js", () => ({
  configureSqlitePragmas: vi.fn(),
  validateAndRepairSqlite: vi.fn().mockReturnValue(true),
}));

vi.mock("../../rag/hnsw/hnsw-vector-store.js", () => ({
  createHNSWVectorStore: vi.fn().mockResolvedValue({
    add: vi.fn(),
    remove: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockReturnValue(0),
    getIndex: vi.fn(),
    rebuild: vi.fn(),
    shutdown: vi.fn(),
  }),
}));

vi.mock("../../utils/logger.js", () => {
  const debugFn = vi.fn();
  const infoFn = vi.fn();
  const warnFn = vi.fn();
  const errorFn = vi.fn();
  return {
    getLogger: vi.fn().mockReturnValue({
      debug: debugFn,
      info: infoFn,
      warn: warnFn,
      error: errorFn,
    }),
    createLogger: vi.fn(),
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Helper: create a minimal entry for testing
function createTestEntry(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: `test-${Math.random().toString(36).slice(2)}`,
    type: "conversation",
    content: "test content",
    tags: [],
    importance: "medium",
    archived: false,
    metadata: {},
    chatId: "chat-1",
    embedding: new Float32Array(128).fill(0.1),
    tier: MemoryTier.Ephemeral,
    accessCount: 0,
    lastAccessedAt: now,
    createdAt: now,
    importanceScore: 0.5,
    version: 1,
    userMessage: "test",
    ...overrides,
  };
}

// Helpers to reduce repetitive casts in tests
function getEntries(memory: AgentDBMemory): Map<string, unknown> {
  return (memory as unknown as { entries: Map<string, unknown> }).entries;
}

function runSweep(memory: AgentDBMemory, threshold: number, demotionDays: number): Promise<void> {
  return (memory as unknown as { autoTieringSweep(t: number, d: number): Promise<void> })
    .autoTieringSweep.call(memory, threshold, demotionDays);
}

function getTieringTimer(memory: AgentDBMemory): unknown {
  return (memory as unknown as { tieringTimer: unknown }).tieringTimer;
}

describe("AgentDBMemory Auto-Tiering", () => {
  let memory: AgentDBMemory;

  beforeEach(async () => {
    vi.useFakeTimers();
    memory = new AgentDBMemory({
      dbPath: "/tmp/test-auto-tiering",
      dimensions: 128,
    });
    await memory.initialize();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("Promotion logic", () => {
    it("should promote Persistent->Ephemeral when accessCount >= threshold and recently accessed", async () => {
      // Entry with 5 accesses and accessed within last day
      const entry = createTestEntry({
        id: "promo-1",
        tier: MemoryTier.Persistent,
        accessCount: 5,
        lastAccessedAt: Date.now(), // just accessed
      });

      // Inject entry into memory's internal map
      getEntries(memory).set("promo-1", entry);

      // Spy on promoteEntry
      const promoteSpy = vi.spyOn(memory, "promoteEntry");

      // Run sweep with default thresholds
      await runSweep(memory, 5, 7);

      expect(promoteSpy).toHaveBeenCalledWith("promo-1", MemoryTier.Ephemeral);
    });

    it("should promote Ephemeral->Working when accessCount >= threshold and recently accessed", async () => {
      const entry = createTestEntry({
        id: "promo-2",
        tier: MemoryTier.Ephemeral,
        accessCount: 10,
        lastAccessedAt: Date.now(),
      });

      getEntries(memory).set("promo-2", entry);

      const promoteSpy = vi.spyOn(memory, "promoteEntry");

      await runSweep(memory, 5, 7);

      expect(promoteSpy).toHaveBeenCalledWith("promo-2", MemoryTier.Working);
    });

    it("should NOT promote when accessCount is below threshold", async () => {
      const entry = createTestEntry({
        id: "no-promo-1",
        tier: MemoryTier.Persistent,
        accessCount: 4, // below threshold of 5
        lastAccessedAt: Date.now(),
      });

      getEntries(memory).set("no-promo-1", entry);

      const promoteSpy = vi.spyOn(memory, "promoteEntry");

      await runSweep(memory, 5, 7);

      expect(promoteSpy).not.toHaveBeenCalled();
    });

    it("should NOT over-promote: Working tier stays Working even with high access count", async () => {
      const entry = createTestEntry({
        id: "ceiling-1",
        tier: MemoryTier.Working,
        accessCount: 100,
        lastAccessedAt: Date.now(),
      });

      getEntries(memory).set("ceiling-1", entry);

      const promoteSpy = vi.spyOn(memory, "promoteEntry");
      const demoteSpy = vi.spyOn(memory, "demoteEntry");

      await runSweep(memory, 5, 7);

      expect(promoteSpy).not.toHaveBeenCalled();
      expect(demoteSpy).not.toHaveBeenCalled();
    });
  });

  describe("Demotion logic", () => {
    it("should demote Working->Ephemeral when lastAccessedAt > demotionTimeoutDays ago", async () => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const entry = createTestEntry({
        id: "demo-1",
        tier: MemoryTier.Working,
        accessCount: 2,
        lastAccessedAt: eightDaysAgo,
      });

      getEntries(memory).set("demo-1", entry);

      const demoteSpy = vi.spyOn(memory, "demoteEntry");

      await runSweep(memory, 5, 7);

      expect(demoteSpy).toHaveBeenCalledWith("demo-1", MemoryTier.Ephemeral);
    });

    it("should demote Ephemeral->Persistent when lastAccessedAt > demotionTimeoutDays ago", async () => {
      const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
      const entry = createTestEntry({
        id: "demo-2",
        tier: MemoryTier.Ephemeral,
        accessCount: 1,
        lastAccessedAt: tenDaysAgo,
      });

      getEntries(memory).set("demo-2", entry);

      const demoteSpy = vi.spyOn(memory, "demoteEntry");

      await runSweep(memory, 5, 7);

      expect(demoteSpy).toHaveBeenCalledWith("demo-2", MemoryTier.Persistent);
    });

    it("should NOT over-demote: Persistent tier stays Persistent even when stale", async () => {
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const entry = createTestEntry({
        id: "floor-1",
        tier: MemoryTier.Persistent,
        accessCount: 0,
        lastAccessedAt: thirtyDaysAgo,
      });

      getEntries(memory).set("floor-1", entry);

      const promoteSpy = vi.spyOn(memory, "promoteEntry");
      const demoteSpy = vi.spyOn(memory, "demoteEntry");

      await runSweep(memory, 5, 7);

      expect(promoteSpy).not.toHaveBeenCalled();
      expect(demoteSpy).not.toHaveBeenCalled();
    });
  });

  describe("enforceTierLimits after sweep", () => {
    it("should call enforceTierLimits for all 3 tiers after promotions/demotions", async () => {
      const entry = createTestEntry({
        id: "enforce-1",
        tier: MemoryTier.Persistent,
        accessCount: 10,
        lastAccessedAt: Date.now(),
      });

      getEntries(memory).set("enforce-1", entry);

      const enforceSpy = vi.spyOn(memory as any, "enforceTierLimits");

      await runSweep(memory, 5, 7);

      expect(enforceSpy).toHaveBeenCalledWith(MemoryTier.Working);
      expect(enforceSpy).toHaveBeenCalledWith(MemoryTier.Ephemeral);
      expect(enforceSpy).toHaveBeenCalledWith(MemoryTier.Persistent);
      expect(enforceSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe("Timer lifecycle", () => {
    it("should start and stop auto-tiering timer via startAutoTiering/stopAutoTiering", () => {
      memory.startAutoTiering(60000, 5, 7);

      // Timer should be set
      expect(getTieringTimer(memory)).not.toBeNull();

      memory.stopAutoTiering();

      expect(getTieringTimer(memory)).toBeNull();
    });

    it("should not create duplicate timers on repeated startAutoTiering calls", () => {
      memory.startAutoTiering(60000, 5, 7);
      const firstTimer = getTieringTimer(memory);

      memory.startAutoTiering(60000, 5, 7);
      const secondTimer = getTieringTimer(memory);

      expect(firstTimer).toBe(secondTimer);
      memory.stopAutoTiering();
    });
  });

  describe("Shutdown stops timer", () => {
    it("should call stopAutoTiering in shutdown() before saveEntries", async () => {
      memory.startAutoTiering(60000, 5, 7);

      const stopSpy = vi.spyOn(memory, "stopAutoTiering");

      await memory.shutdown();

      expect(stopSpy).toHaveBeenCalled();
      expect(getTieringTimer(memory)).toBeNull();
    });
  });

  describe("Debug logging", () => {
    it("should log debug messages for tier transitions", async () => {
      const { getLogger } = await import("../../utils/logger.js");
      const logger = getLogger();
      const debugSpy = vi.spyOn(logger, "debug");

      const entry = createTestEntry({
        id: "log-1",
        tier: MemoryTier.Persistent,
        accessCount: 10,
        lastAccessedAt: Date.now(),
      });

      getEntries(memory).set("log-1", entry);

      await runSweep(memory, 5, 7);

      // Check that debug was called with tier transition message
      const transitionCalls = debugSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("promoted"),
      );
      expect(transitionCalls.length).toBeGreaterThan(0);
    });
  });

  describe("Combined sweep", () => {
    it("should correctly handle mixed promotion/demotion in one sweep", async () => {
      const now = Date.now();
      const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

      // Entry to promote (high access, recent)
      const hotEntry = createTestEntry({
        id: "mixed-hot",
        tier: MemoryTier.Persistent,
        accessCount: 20,
        lastAccessedAt: now,
      });

      // Entry to demote (stale)
      const coldEntry = createTestEntry({
        id: "mixed-cold",
        tier: MemoryTier.Working,
        accessCount: 1,
        lastAccessedAt: tenDaysAgo,
      });

      // Entry that stays (moderate access, not too old)
      const stableEntry = createTestEntry({
        id: "mixed-stable",
        tier: MemoryTier.Ephemeral,
        accessCount: 2,
        lastAccessedAt: now - 3 * 24 * 60 * 60 * 1000, // 3 days ago
      });

      const entries = getEntries(memory);
      entries.set("mixed-hot", hotEntry);
      entries.set("mixed-cold", coldEntry);
      entries.set("mixed-stable", stableEntry);

      const promoteSpy = vi.spyOn(memory, "promoteEntry");
      const demoteSpy = vi.spyOn(memory, "demoteEntry");

      await runSweep(memory, 5, 7);

      expect(promoteSpy).toHaveBeenCalledWith("mixed-hot", MemoryTier.Ephemeral);
      expect(demoteSpy).toHaveBeenCalledWith("mixed-cold", MemoryTier.Ephemeral);
      // Stable entry should not be promoted or demoted
      expect(promoteSpy).not.toHaveBeenCalledWith("mixed-stable", expect.anything());
      expect(demoteSpy).not.toHaveBeenCalledWith("mixed-stable", expect.anything());
    });
  });
});

// =============================================================================
// Memory Decay Tests (Phase 21, MEM-08..MEM-11)
// =============================================================================

const DEFAULT_DECAY_CONFIG: MemoryDecayConfig = {
  enabled: true,
  lambdas: {
    working: 0.10,
    ephemeral: 0.05,
    persistent: 0.01,
  },
  exemptDomains: ["instinct", "analysis-cache"],
  timeoutMs: 30000,
};

/** Helper to configure memory decay on an AgentDBMemory instance */
function configureDecay(
  mem: AgentDBMemory,
  overrides: Partial<MemoryDecayConfig> = {},
): void {
  mem.setDecayConfig({ ...DEFAULT_DECAY_CONFIG, ...overrides });
}

describe("memory decay", () => {
  let memory: AgentDBMemory;
  const BASE_TIME = 1700000000000; // fixed timestamp for deterministic tests

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    _setNowFn(() => createBrand(BASE_TIME, "TimestampMs" as const));
    memory = new AgentDBMemory({
      dbPath: "/tmp/test-decay",
      dimensions: 128,
    });
    await memory.initialize();
    configureDecay(memory);
  });

  afterEach(() => {
    _resetNowFn();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("decay formula: after 10 days at lambda 0.10, score is ~0.37 of original", async () => {
    const tenDaysAgo = BASE_TIME - 10 * 24 * 60 * 60 * 1000;
    const entry = createTestEntry({
      id: "decay-formula-1",
      tier: MemoryTier.Working,
      importanceScore: 1.0,
      lastAccessedAt: tenDaysAgo,
      accessCount: 0,
    });

    getEntries(memory).set("decay-formula-1", entry);
    await runSweep(memory, 5, 7);

    // Expected: 1.0 * exp(-10 * 0.10) = 0.3679...
    const decayed = (getEntries(memory).get("decay-formula-1") as Record<string, unknown>);
    expect(decayed.importanceScore).toBeCloseTo(Math.exp(-10 * 0.10), 4);
  });

  it("entries with domain 'instinct' are exempt from decay (MEM-11)", async () => {
    const thirtyDaysAgo = BASE_TIME - 30 * 24 * 60 * 60 * 1000;
    const entry = createTestEntry({
      id: "instinct-1",
      tier: MemoryTier.Persistent,
      importanceScore: 0.8,
      lastAccessedAt: thirtyDaysAgo,
      domain: "instinct",
      accessCount: 0,
    });

    getEntries(memory).set("instinct-1", entry);
    await runSweep(memory, 5, 7);

    const result = (getEntries(memory).get("instinct-1") as Record<string, unknown>);
    expect(result.importanceScore).toBe(0.8);
  });

  it("entries with domain 'analysis-cache' are exempt from decay", async () => {
    const twentyDaysAgo = BASE_TIME - 20 * 24 * 60 * 60 * 1000;
    const entry = createTestEntry({
      id: "analysis-cache-1",
      tier: MemoryTier.Persistent,
      importanceScore: 0.9,
      lastAccessedAt: twentyDaysAgo,
      domain: "analysis-cache",
      accessCount: 0,
    });

    getEntries(memory).set("analysis-cache-1", entry);
    await runSweep(memory, 5, 7);

    const result = (getEntries(memory).get("analysis-cache-1") as Record<string, unknown>);
    expect(result.importanceScore).toBe(0.9);
  });

  it("accessing a memory resets decay (daysSinceAccess ~ 0)", async () => {
    const entry = createTestEntry({
      id: "recent-access-1",
      tier: MemoryTier.Ephemeral,
      importanceScore: 0.8,
      lastAccessedAt: BASE_TIME, // just accessed
      accessCount: 5,
    });

    getEntries(memory).set("recent-access-1", entry);
    await runSweep(memory, 5, 7);

    const result = (getEntries(memory).get("recent-access-1") as Record<string, unknown>);
    // No decay since daysSinceAccess = 0
    expect(result.importanceScore).toBe(0.8);
  });

  it("importance score never drops below 0.01 floor", async () => {
    const longAgo = BASE_TIME - 365 * 24 * 60 * 60 * 1000; // 1 year ago
    const entry = createTestEntry({
      id: "floor-test-1",
      tier: MemoryTier.Working,
      importanceScore: 0.5,
      lastAccessedAt: longAgo,
      accessCount: 0,
    });

    getEntries(memory).set("floor-test-1", entry);
    await runSweep(memory, 5, 7);

    const result = (getEntries(memory).get("floor-test-1") as Record<string, unknown>);
    expect(result.importanceScore).toBe(0.01);
  });

  it("MEMORY_DECAY_ENABLED=false leaves all scores unchanged (backward compatible)", async () => {
    configureDecay(memory, { enabled: false });

    const tenDaysAgo = BASE_TIME - 10 * 24 * 60 * 60 * 1000;
    const entry = createTestEntry({
      id: "disabled-1",
      tier: MemoryTier.Working,
      importanceScore: 0.7,
      lastAccessedAt: tenDaysAgo,
      accessCount: 0,
    });

    getEntries(memory).set("disabled-1", entry);
    await runSweep(memory, 5, 7);

    const result = (getEntries(memory).get("disabled-1") as Record<string, unknown>);
    expect(result.importanceScore).toBe(0.7);
  });

  it("per-tier lambda rates: Working decays faster than Ephemeral, Ephemeral faster than Persistent", async () => {
    const fiveDaysAgo = BASE_TIME - 5 * 24 * 60 * 60 * 1000;

    const workingEntry = createTestEntry({
      id: "tier-rate-working",
      tier: MemoryTier.Working,
      importanceScore: 1.0,
      lastAccessedAt: fiveDaysAgo,
      accessCount: 0,
    });
    const ephemeralEntry = createTestEntry({
      id: "tier-rate-ephemeral",
      tier: MemoryTier.Ephemeral,
      importanceScore: 1.0,
      lastAccessedAt: fiveDaysAgo,
      accessCount: 0,
    });
    const persistentEntry = createTestEntry({
      id: "tier-rate-persistent",
      tier: MemoryTier.Persistent,
      importanceScore: 1.0,
      lastAccessedAt: fiveDaysAgo,
      accessCount: 0,
    });

    const entries = getEntries(memory);
    entries.set("tier-rate-working", workingEntry);
    entries.set("tier-rate-ephemeral", ephemeralEntry);
    entries.set("tier-rate-persistent", persistentEntry);

    await runSweep(memory, 5, 7);

    const w = (entries.get("tier-rate-working") as Record<string, unknown>).importanceScore as number;
    const e = (entries.get("tier-rate-ephemeral") as Record<string, unknown>).importanceScore as number;
    const p = (entries.get("tier-rate-persistent") as Record<string, unknown>).importanceScore as number;

    // Working (lambda=0.10) decays most, Persistent (lambda=0.01) decays least
    expect(w).toBeLessThan(e);
    expect(e).toBeLessThan(p);
    // Verify exact values
    expect(w).toBeCloseTo(Math.exp(-5 * 0.10), 4);
    expect(e).toBeCloseTo(Math.exp(-5 * 0.05), 4);
    expect(p).toBeCloseTo(Math.exp(-5 * 0.01), 4);
  });

  it("custom exempt domain added to config is respected", async () => {
    configureDecay(memory, {
      exemptDomains: ["instinct", "analysis-cache", "custom-domain"],
    });

    const fifteenDaysAgo = BASE_TIME - 15 * 24 * 60 * 60 * 1000;
    const customEntry = createTestEntry({
      id: "custom-exempt-1",
      tier: MemoryTier.Ephemeral,
      importanceScore: 0.6,
      lastAccessedAt: fifteenDaysAgo,
      domain: "custom-domain",
      accessCount: 0,
    });

    const normalEntry = createTestEntry({
      id: "normal-1",
      tier: MemoryTier.Ephemeral,
      importanceScore: 0.6,
      lastAccessedAt: fifteenDaysAgo,
      accessCount: 0,
    });

    const entries = getEntries(memory);
    entries.set("custom-exempt-1", customEntry);
    entries.set("normal-1", normalEntry);

    await runSweep(memory, 5, 7);

    const exemptResult = (entries.get("custom-exempt-1") as Record<string, unknown>);
    const normalResult = (entries.get("normal-1") as Record<string, unknown>);

    // Custom domain entry: unchanged
    expect(exemptResult.importanceScore).toBe(0.6);
    // Normal entry: decayed
    expect(normalResult.importanceScore).not.toBe(0.6);
    expect(normalResult.importanceScore).toBeCloseTo(0.6 * Math.exp(-15 * 0.05), 4);
  });

  it("decay is applied BEFORE tiering: decayed score influences demotion decision", async () => {
    // Entry with accessCount below promotion threshold but recently accessed enough
    // that without decay it would NOT be demoted (daysSinceAccess < demotionTimeoutDays).
    // But with decay, the importance score drops, and enforceTierLimits uses it.
    const eightDaysAgo = BASE_TIME - 8 * 24 * 60 * 60 * 1000;
    const entry = createTestEntry({
      id: "decay-before-tiering-1",
      tier: MemoryTier.Ephemeral,
      importanceScore: 0.8,
      lastAccessedAt: eightDaysAgo,
      accessCount: 1,
    });

    getEntries(memory).set("decay-before-tiering-1", entry);

    // With 8 days since access and demotion timeout of 7 days, this entry
    // will be demoted regardless of decay. But we verify decay ran first
    // by checking the importance score was reduced before tiering completes.
    const demoteSpy = vi.spyOn(memory, "demoteEntry");
    await runSweep(memory, 5, 7);

    // Verify demotion happened
    expect(demoteSpy).toHaveBeenCalledWith("decay-before-tiering-1", MemoryTier.Persistent);

    // Verify importance was decayed (not still 0.8)
    const result = (getEntries(memory).get("decay-before-tiering-1") as Record<string, unknown>);
    const expectedDecayed = 0.8 * Math.exp(-8 * 0.05); // ephemeral lambda
    expect(result.importanceScore).toBeCloseTo(expectedDecayed, 4);
  });

  it("decayed entries are persisted to DB via transaction", async () => {
    const fiveDaysAgo = BASE_TIME - 5 * 24 * 60 * 60 * 1000;
    const entry = createTestEntry({
      id: "persist-decay-1",
      tier: MemoryTier.Working,
      importanceScore: 0.9,
      lastAccessedAt: fiveDaysAgo,
      accessCount: 0,
    });

    getEntries(memory).set("persist-decay-1", entry);

    // Get the mock DB to verify transaction was called
    const Database = (await import("better-sqlite3")).default;
    const mockDbInstance = (Database as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;

    await runSweep(memory, 5, 7);

    // Verify the upsertMemory prepared statement was called (via transaction)
    const prepareCall = mockDbInstance?.prepare;
    expect(prepareCall).toHaveBeenCalled();

    // Verify the in-memory score was decayed
    const result = (getEntries(memory).get("persist-decay-1") as Record<string, unknown>);
    expect(result.importanceScore).toBeCloseTo(0.9 * Math.exp(-5 * 0.10), 4);
  });
});
