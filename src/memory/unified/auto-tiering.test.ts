/**
 * Auto-Tiering Sweep Tests
 *
 * Tests for the automatic promotion/demotion of memory entries
 * between Working (hot), Ephemeral (warm), and Persistent (cold) tiers
 * based on access patterns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentDBMemory } from "./agentdb-memory.js";
import { MemoryTier } from "./unified-memory.interface.js";

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

describe("AgentDBMemory Auto-Tiering", () => {
  let memory: AgentDBMemory;

  beforeEach(async () => {
    vi.useFakeTimers();
    memory = new AgentDBMemory({
      dbPath: "/tmp/test-auto-tiering",
      dimensions: 128,
    });
    // Initialize to set up internal state
    await memory.initialize();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
      (memory as unknown as { entries: Map<string, unknown> }).entries.set("promo-1", entry);

      // Spy on promoteEntry
      const promoteSpy = vi.spyOn(memory, "promoteEntry");

      // Run sweep with default thresholds
      await (memory as unknown as { autoTieringSweep(t: number, d: number): Promise<void> })
        .autoTieringSweep.call(memory, 5, 7);

      expect(promoteSpy).toHaveBeenCalledWith("promo-1", MemoryTier.Ephemeral);
    });

    it("should promote Ephemeral->Working when accessCount >= threshold and recently accessed", async () => {
      const entry = createTestEntry({
        id: "promo-2",
        tier: MemoryTier.Ephemeral,
        accessCount: 10,
        lastAccessedAt: Date.now(),
      });

      (memory as unknown as { entries: Map<string, unknown> }).entries.set("promo-2", entry);

      const promoteSpy = vi.spyOn(memory, "promoteEntry");

      await (memory as unknown as { autoTieringSweep(t: number, d: number): Promise<void> })
        .autoTieringSweep.call(memory, 5, 7);

      expect(promoteSpy).toHaveBeenCalledWith("promo-2", MemoryTier.Working);
    });

    it("should NOT promote when accessCount is below threshold", async () => {
      const entry = createTestEntry({
        id: "no-promo-1",
        tier: MemoryTier.Persistent,
        accessCount: 4, // below threshold of 5
        lastAccessedAt: Date.now(),
      });

      (memory as unknown as { entries: Map<string, unknown> }).entries.set("no-promo-1", entry);

      const promoteSpy = vi.spyOn(memory, "promoteEntry");

      await (memory as unknown as { autoTieringSweep(t: number, d: number): Promise<void> })
        .autoTieringSweep.call(memory, 5, 7);

      expect(promoteSpy).not.toHaveBeenCalled();
    });

    it("should NOT over-promote: Working tier stays Working even with high access count", async () => {
      const entry = createTestEntry({
        id: "ceiling-1",
        tier: MemoryTier.Working,
        accessCount: 100,
        lastAccessedAt: Date.now(),
      });

      (memory as unknown as { entries: Map<string, unknown> }).entries.set("ceiling-1", entry);

      const promoteSpy = vi.spyOn(memory, "promoteEntry");
      const demoteSpy = vi.spyOn(memory, "demoteEntry");

      await (memory as unknown as { autoTieringSweep(t: number, d: number): Promise<void> })
        .autoTieringSweep.call(memory, 5, 7);

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

      (memory as unknown as { entries: Map<string, unknown> }).entries.set("demo-1", entry);

      const demoteSpy = vi.spyOn(memory, "demoteEntry");

      await (memory as unknown as { autoTieringSweep(t: number, d: number): Promise<void> })
        .autoTieringSweep.call(memory, 5, 7);

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

      (memory as unknown as { entries: Map<string, unknown> }).entries.set("demo-2", entry);

      const demoteSpy = vi.spyOn(memory, "demoteEntry");

      await (memory as unknown as { autoTieringSweep(t: number, d: number): Promise<void> })
        .autoTieringSweep.call(memory, 5, 7);

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

      (memory as unknown as { entries: Map<string, unknown> }).entries.set("floor-1", entry);

      const promoteSpy = vi.spyOn(memory, "promoteEntry");
      const demoteSpy = vi.spyOn(memory, "demoteEntry");

      await (memory as unknown as { autoTieringSweep(t: number, d: number): Promise<void> })
        .autoTieringSweep.call(memory, 5, 7);

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

      (memory as unknown as { entries: Map<string, unknown> }).entries.set("enforce-1", entry);

      const enforceSpy = vi.spyOn(
        memory as unknown as { enforceTierLimits(tier: MemoryTier): Promise<void> },
        "enforceTierLimits",
      );

      await (memory as unknown as { autoTieringSweep(t: number, d: number): Promise<void> })
        .autoTieringSweep.call(memory, 5, 7);

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
      expect(
        (memory as unknown as { tieringTimer: ReturnType<typeof setInterval> | null }).tieringTimer,
      ).not.toBeNull();

      memory.stopAutoTiering();

      expect(
        (memory as unknown as { tieringTimer: ReturnType<typeof setInterval> | null }).tieringTimer,
      ).toBeNull();
    });

    it("should not create duplicate timers on repeated startAutoTiering calls", () => {
      memory.startAutoTiering(60000, 5, 7);
      const firstTimer = (memory as unknown as { tieringTimer: unknown }).tieringTimer;

      memory.startAutoTiering(60000, 5, 7);
      const secondTimer = (memory as unknown as { tieringTimer: unknown }).tieringTimer;

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
      expect(
        (memory as unknown as { tieringTimer: ReturnType<typeof setInterval> | null }).tieringTimer,
      ).toBeNull();
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

      (memory as unknown as { entries: Map<string, unknown> }).entries.set("log-1", entry);

      await (memory as unknown as { autoTieringSweep(t: number, d: number): Promise<void> })
        .autoTieringSweep.call(memory, 5, 7);

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

      const entries = (memory as unknown as { entries: Map<string, unknown> }).entries;
      entries.set("mixed-hot", hotEntry);
      entries.set("mixed-cold", coldEntry);
      entries.set("mixed-stable", stableEntry);

      const promoteSpy = vi.spyOn(memory, "promoteEntry");
      const demoteSpy = vi.spyOn(memory, "demoteEntry");

      await (memory as unknown as { autoTieringSweep(t: number, d: number): Promise<void> })
        .autoTieringSweep.call(memory, 5, 7);

      expect(promoteSpy).toHaveBeenCalledWith("mixed-hot", MemoryTier.Ephemeral);
      expect(demoteSpy).toHaveBeenCalledWith("mixed-cold", MemoryTier.Ephemeral);
      // Stable entry should not be promoted or demoted
      expect(promoteSpy).not.toHaveBeenCalledWith("mixed-stable", expect.anything());
      expect(demoteSpy).not.toHaveBeenCalledWith("mixed-stable", expect.anything());
    });
  });
});
