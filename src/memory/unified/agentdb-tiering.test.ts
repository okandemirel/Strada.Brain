/**
 * Tests for AgentDB Auto-Tiering & Decay Helpers
 *
 * Covers: importance scoring, tier limit enforcement, auto-tiering sweep,
 * exponential decay, promotion/demotion decisions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryTier } from "./unified-memory.interface.js";
import type { UnifiedMemoryEntry } from "./unified-memory.interface.js";
import type { AgentDBTieringContext } from "./agentdb-tiering.js";
import {
  calculateImportanceScore,
  enforceTierLimits,
  autoTieringSweep,
} from "./agentdb-tiering.js";
import type { NormalizedScore } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("./agentdb-sqlite.js", () => ({
  persistDecayedEntries: vi.fn(),
  removePersistedEntry: vi.fn(),
}));

vi.mock("./agentdb-time.js", () => ({
  getNow: vi.fn(() => Date.now()),
}));

// Re-import the mocked modules to get references for assertions
import { persistDecayedEntries, removePersistedEntry } from "./agentdb-sqlite.js";
import { getNow } from "./agentdb-time.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function makeEntry(
  id: string,
  content: string,
  overrides: Partial<Record<string, unknown>> = {},
): UnifiedMemoryEntry {
  return {
    id: id as any,
    type: "note",
    content,
    createdAt: Date.now() as any,
    lastAccessedAt: Date.now() as any,
    accessCount: 0,
    tags: [],
    importance: "medium",
    archived: false,
    metadata: {},
    chatId: "default" as any,
    embedding: [],
    tier: MemoryTier.Ephemeral,
    importanceScore: 0.5 as NormalizedScore,
    version: 1,
    title: "",
    source: "test",
    ...overrides,
  } as unknown as UnifiedMemoryEntry;
}

function makeTieringCtx(
  entries: Map<string, UnifiedMemoryEntry>,
  overrides: Partial<AgentDBTieringContext> = {},
): AgentDBTieringContext {
  return {
    dbPath: "/tmp/test",
    sqliteDb: null,
    sqliteInitFailed: false,
    sqliteStatements: new Map(),
    entries,
    config: {
      dbPath: "/tmp/test",
      dimensions: 4,
      maxEntriesPerTier: {
        [MemoryTier.Working]: 5,
        [MemoryTier.Ephemeral]: 10,
        [MemoryTier.Persistent]: 20,
      },
      hnswParams: { efConstruction: 50, M: 8, efSearch: 32 },
      quantizationType: "none",
      cacheSize: 100,
      enableAutoTiering: true,
      ephemeralTtlMs: 86400000 as any,
    },
    hnswStore: undefined,
    writeMutex: { withLock: async (fn: any) => fn() },
    decayConfig: null,
    promoteEntry: vi.fn(async () => ({ success: true, value: {} })),
    demoteEntry: vi.fn(async () => ({ success: true, value: {} })),
    ...overrides,
  } as unknown as AgentDBTieringContext;
}

// ---------------------------------------------------------------------------
// Tests: calculateImportanceScore
// ---------------------------------------------------------------------------

describe("calculateImportanceScore", () => {
  it("should return higher base score for Persistent tier", () => {
    const persistent = calculateImportanceScore("hello", MemoryTier.Persistent);
    const working = calculateImportanceScore("hello", MemoryTier.Working);
    expect(persistent).toBeGreaterThan(working);
  });

  it("should return higher base score for Ephemeral than Working", () => {
    const ephemeral = calculateImportanceScore("hello", MemoryTier.Ephemeral);
    const working = calculateImportanceScore("hello", MemoryTier.Working);
    expect(ephemeral).toBeGreaterThan(working);
  });

  it("should increase score for longer content via length factor", () => {
    const short = calculateImportanceScore("hi", MemoryTier.Working);
    const long = calculateImportanceScore("x".repeat(1000), MemoryTier.Working);
    expect(long).toBeGreaterThan(short);
  });

  it("should cap length factor at 0.2", () => {
    const veryLong = calculateImportanceScore("x".repeat(5000), MemoryTier.Working);
    const extremelyLong = calculateImportanceScore("x".repeat(100000), MemoryTier.Working);
    // Both should have max length factor of 0.2, so same score
    expect(veryLong).toBe(extremelyLong);
  });

  it("should boost score when important keywords are present", () => {
    const withKeyword = calculateImportanceScore("this is critical data", MemoryTier.Ephemeral);
    const withoutKeyword = calculateImportanceScore("this is regular data", MemoryTier.Ephemeral);
    expect(withKeyword).toBeGreaterThan(withoutKeyword);
  });

  it("should recognize all important keywords", () => {
    const keywords = ["important", "critical", "key", "main", "essential", "vital"];
    for (const kw of keywords) {
      const score = calculateImportanceScore(`this is ${kw} information`, MemoryTier.Working);
      const baseline = calculateImportanceScore("this is regular information", MemoryTier.Working);
      expect(score).toBeGreaterThan(baseline);
    }
  });

  it("should be case-insensitive for keyword detection", () => {
    const lower = calculateImportanceScore("critical", MemoryTier.Working);
    const upper = calculateImportanceScore("CRITICAL", MemoryTier.Working);
    expect(lower).toBe(upper);
  });

  it("should clamp result to maximum 1.0", () => {
    // Long content + keyword + Persistent tier = maximum possible
    const score = calculateImportanceScore(
      "critical ".repeat(200),
      MemoryTier.Persistent,
    );
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("should return at least the tier base for empty content", () => {
    const score = calculateImportanceScore("", MemoryTier.Working);
    expect(score).toBeGreaterThanOrEqual(0.3);
  });
});

// ---------------------------------------------------------------------------
// Tests: enforceTierLimits
// ---------------------------------------------------------------------------

describe("enforceTierLimits", () => {
  it("should not remove entries when under the limit", async () => {
    const entries = new Map<string, UnifiedMemoryEntry>();
    entries.set("e1", makeEntry("e1", "entry 1", { tier: MemoryTier.Working }));
    entries.set("e2", makeEntry("e2", "entry 2", { tier: MemoryTier.Working }));

    const ctx = makeTieringCtx(entries);
    await enforceTierLimits(ctx, MemoryTier.Working);

    expect(entries.size).toBe(2);
  });

  it("should remove lowest-scoring entries when over the limit", async () => {
    const entries = new Map<string, UnifiedMemoryEntry>();
    // Create 8 Working tier entries (limit is 5)
    for (let i = 0; i < 8; i++) {
      entries.set(`w${i}`, makeEntry(`w${i}`, `working ${i}`, {
        tier: MemoryTier.Working,
        importanceScore: (i * 0.1) as NormalizedScore,
        accessCount: i,
      }));
    }

    const ctx = makeTieringCtx(entries);
    await enforceTierLimits(ctx, MemoryTier.Working);

    const remaining = Array.from(entries.values()).filter(e => e.tier === MemoryTier.Working);
    expect(remaining.length).toBe(5);
  });

  it("should keep higher-scoring entries and remove lower-scoring ones", async () => {
    const entries = new Map<string, UnifiedMemoryEntry>();
    entries.set("low", makeEntry("low", "low", {
      tier: MemoryTier.Working,
      importanceScore: 0.1 as NormalizedScore,
      accessCount: 0,
    }));
    entries.set("high", makeEntry("high", "high", {
      tier: MemoryTier.Working,
      importanceScore: 0.9 as NormalizedScore,
      accessCount: 50,
    }));
    // Fill up to exceed limit of 5
    for (let i = 0; i < 5; i++) {
      entries.set(`fill${i}`, makeEntry(`fill${i}`, `fill ${i}`, {
        tier: MemoryTier.Working,
        importanceScore: 0.5 as NormalizedScore,
        accessCount: 10,
      }));
    }

    const ctx = makeTieringCtx(entries);
    await enforceTierLimits(ctx, MemoryTier.Working);

    expect(entries.has("high")).toBe(true);
    expect(entries.has("low")).toBe(false);
  });

  it("should call HNSW remove when hnswStore is present", async () => {
    const entries = new Map<string, UnifiedMemoryEntry>();
    for (let i = 0; i < 8; i++) {
      entries.set(`hw${i}`, makeEntry(`hw${i}`, `entry ${i}`, {
        tier: MemoryTier.Working,
        importanceScore: (i * 0.1) as NormalizedScore,
        accessCount: i,
      }));
    }

    const mockHnsw = { remove: vi.fn(async () => {}) };
    const ctx = makeTieringCtx(entries, { hnswStore: mockHnsw as any });
    await enforceTierLimits(ctx, MemoryTier.Working);

    expect(mockHnsw.remove).toHaveBeenCalled();
  });

  it("should call removePersistedEntry for evicted entries", async () => {
    const entries = new Map<string, UnifiedMemoryEntry>();
    for (let i = 0; i < 8; i++) {
      entries.set(`p${i}`, makeEntry(`p${i}`, `entry ${i}`, {
        tier: MemoryTier.Working,
        importanceScore: (i * 0.1) as NormalizedScore,
        accessCount: i,
      }));
    }

    const ctx = makeTieringCtx(entries);
    await enforceTierLimits(ctx, MemoryTier.Working);

    // 3 entries should be removed (8 - 5 limit)
    expect(removePersistedEntry).toHaveBeenCalledTimes(3);
  });

  it("should only affect entries in the specified tier", async () => {
    const entries = new Map<string, UnifiedMemoryEntry>();
    for (let i = 0; i < 8; i++) {
      entries.set(`w${i}`, makeEntry(`w${i}`, `working ${i}`, {
        tier: MemoryTier.Working,
        importanceScore: 0.1 as NormalizedScore,
      }));
    }
    entries.set("eph1", makeEntry("eph1", "ephemeral", {
      tier: MemoryTier.Ephemeral,
    }));

    const ctx = makeTieringCtx(entries);
    await enforceTierLimits(ctx, MemoryTier.Working);

    // Ephemeral entry should be untouched
    expect(entries.has("eph1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: autoTieringSweep
// ---------------------------------------------------------------------------

describe("autoTieringSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getNow).mockReturnValue(Date.now() as any);
  });

  it("should promote entries with high access count and recent access", async () => {
    const now = Date.now();
    vi.mocked(getNow).mockReturnValue(now as any);

    const entries = new Map<string, UnifiedMemoryEntry>();
    entries.set("hot", makeEntry("hot", "frequently accessed", {
      tier: MemoryTier.Ephemeral,
      accessCount: 20, // above threshold of 10
      lastAccessedAt: now as any, // just accessed
    }));

    const ctx = makeTieringCtx(entries);
    await autoTieringSweep(ctx, 10, 7);

    // Should promote Ephemeral -> Working
    expect(ctx.promoteEntry).toHaveBeenCalledWith("hot", MemoryTier.Working);
  });

  it("should promote Persistent to Ephemeral when threshold met", async () => {
    const now = Date.now();
    vi.mocked(getNow).mockReturnValue(now as any);

    const entries = new Map<string, UnifiedMemoryEntry>();
    entries.set("rising", makeEntry("rising", "gaining popularity", {
      tier: MemoryTier.Persistent,
      accessCount: 15,
      lastAccessedAt: now as any,
    }));

    const ctx = makeTieringCtx(entries);
    await autoTieringSweep(ctx, 10, 7);

    expect(ctx.promoteEntry).toHaveBeenCalledWith("rising", MemoryTier.Ephemeral);
  });

  it("should demote stale Working entries to Ephemeral", async () => {
    const now = Date.now();
    vi.mocked(getNow).mockReturnValue(now as any);

    const entries = new Map<string, UnifiedMemoryEntry>();
    entries.set("stale", makeEntry("stale", "old working data", {
      tier: MemoryTier.Working,
      accessCount: 1,
      lastAccessedAt: (now - 10 * MS_PER_DAY) as any, // 10 days ago
    }));

    const ctx = makeTieringCtx(entries);
    await autoTieringSweep(ctx, 10, 7);

    expect(ctx.demoteEntry).toHaveBeenCalledWith("stale", MemoryTier.Ephemeral);
  });

  it("should demote stale Ephemeral entries to Persistent", async () => {
    const now = Date.now();
    vi.mocked(getNow).mockReturnValue(now as any);

    const entries = new Map<string, UnifiedMemoryEntry>();
    entries.set("old", makeEntry("old", "forgotten ephemeral", {
      tier: MemoryTier.Ephemeral,
      accessCount: 0,
      lastAccessedAt: (now - 14 * MS_PER_DAY) as any,
    }));

    const ctx = makeTieringCtx(entries);
    await autoTieringSweep(ctx, 10, 7);

    expect(ctx.demoteEntry).toHaveBeenCalledWith("old", MemoryTier.Persistent);
  });

  it("should not change tier for entries that do not meet any threshold", async () => {
    const now = Date.now();
    vi.mocked(getNow).mockReturnValue(now as any);

    const entries = new Map<string, UnifiedMemoryEntry>();
    entries.set("normal", makeEntry("normal", "normal entry", {
      tier: MemoryTier.Ephemeral,
      accessCount: 3,
      lastAccessedAt: (now - 3 * MS_PER_DAY) as any, // 3 days ago, within demotion timeout
    }));

    const ctx = makeTieringCtx(entries);
    await autoTieringSweep(ctx, 10, 7);

    expect(ctx.promoteEntry).not.toHaveBeenCalled();
    expect(ctx.demoteEntry).not.toHaveBeenCalled();
  });

  it("should enforce tier limits after sweep", async () => {
    const now = Date.now();
    vi.mocked(getNow).mockReturnValue(now as any);

    const entries = new Map<string, UnifiedMemoryEntry>();
    const enforceMock = vi.fn(async () => {});
    const ctx = makeTieringCtx(entries, { enforceTierLimitsOverride: enforceMock });

    await autoTieringSweep(ctx, 10, 7);

    // Should enforce limits for all three tiers
    expect(enforceMock).toHaveBeenCalledTimes(3);
    expect(enforceMock).toHaveBeenCalledWith(MemoryTier.Working);
    expect(enforceMock).toHaveBeenCalledWith(MemoryTier.Ephemeral);
    expect(enforceMock).toHaveBeenCalledWith(MemoryTier.Persistent);
  });

  describe("decay pass", () => {
    it("should apply exponential decay to importance scores", async () => {
      const now = Date.now();
      vi.mocked(getNow).mockReturnValue(now as any);

      const entries = new Map<string, UnifiedMemoryEntry>();
      entries.set("decay1", makeEntry("decay1", "decaying entry", {
        tier: MemoryTier.Ephemeral,
        importanceScore: 0.8 as NormalizedScore,
        lastAccessedAt: (now - 5 * MS_PER_DAY) as any,
      }));

      const ctx = makeTieringCtx(entries, {
        decayConfig: {
          enabled: true,
          lambdas: {
            working: 0.1,
            ephemeral: 0.05,
            persistent: 0.01,
          },
          exemptDomains: [],
          timeoutMs: 30000,
        },
      });

      const originalScore = entries.get("decay1")!.importanceScore;
      await autoTieringSweep(ctx, 10, 7);

      const newScore = entries.get("decay1")!.importanceScore;
      expect(newScore).toBeLessThan(originalScore);
      expect(newScore).toBeGreaterThan(0.01); // floor
    });

    it("should use correct lambda for each tier", async () => {
      const now = Date.now();
      vi.mocked(getNow).mockReturnValue(now as any);

      const entries = new Map<string, UnifiedMemoryEntry>();
      entries.set("w1", makeEntry("w1", "working entry", {
        tier: MemoryTier.Working,
        importanceScore: 0.8 as NormalizedScore,
        lastAccessedAt: (now - 3 * MS_PER_DAY) as any,
      }));
      entries.set("p1", makeEntry("p1", "persistent entry", {
        tier: MemoryTier.Persistent,
        importanceScore: 0.8 as NormalizedScore,
        lastAccessedAt: (now - 3 * MS_PER_DAY) as any,
      }));

      const ctx = makeTieringCtx(entries, {
        decayConfig: {
          enabled: true,
          lambdas: {
            working: 0.5,     // fast decay
            ephemeral: 0.1,
            persistent: 0.01, // slow decay
          },
          exemptDomains: [],
          timeoutMs: 30000,
        },
      });

      await autoTieringSweep(ctx, 10, 7);

      const workingScore = entries.get("w1")!.importanceScore;
      const persistentScore = entries.get("p1")!.importanceScore;
      // Working should decay faster
      expect(workingScore).toBeLessThan(persistentScore);
    });

    it("should skip exempt domains in decay", async () => {
      const now = Date.now();
      vi.mocked(getNow).mockReturnValue(now as any);

      const entries = new Map<string, UnifiedMemoryEntry>();
      entries.set("exempt1", makeEntry("exempt1", "exempt entry", {
        tier: MemoryTier.Ephemeral,
        importanceScore: 0.8 as NormalizedScore,
        lastAccessedAt: (now - 30 * MS_PER_DAY) as any,
        domain: "instinct",
      }));

      const ctx = makeTieringCtx(entries, {
        decayConfig: {
          enabled: true,
          lambdas: { working: 0.1, ephemeral: 0.1, persistent: 0.1 },
          exemptDomains: ["instinct"],
          timeoutMs: 30000,
        },
      });

      await autoTieringSweep(ctx, 10, 7);

      // Score should remain unchanged
      expect(entries.get("exempt1")!.importanceScore).toBe(0.8);
    });

    it("should not decay entries accessed just now", async () => {
      const now = Date.now();
      vi.mocked(getNow).mockReturnValue(now as any);

      const entries = new Map<string, UnifiedMemoryEntry>();
      entries.set("fresh", makeEntry("fresh", "just accessed", {
        tier: MemoryTier.Ephemeral,
        importanceScore: 0.8 as NormalizedScore,
        lastAccessedAt: now as any,
      }));

      const ctx = makeTieringCtx(entries, {
        decayConfig: {
          enabled: true,
          lambdas: { working: 0.1, ephemeral: 0.1, persistent: 0.1 },
          exemptDomains: [],
          timeoutMs: 30000,
        },
      });

      await autoTieringSweep(ctx, 10, 7);

      expect(entries.get("fresh")!.importanceScore).toBe(0.8);
    });

    it("should floor decayed scores at 0.01", async () => {
      const now = Date.now();
      vi.mocked(getNow).mockReturnValue(now as any);

      const entries = new Map<string, UnifiedMemoryEntry>();
      entries.set("ancient", makeEntry("ancient", "very old", {
        tier: MemoryTier.Ephemeral,
        importanceScore: 0.1 as NormalizedScore,
        lastAccessedAt: (now - 365 * MS_PER_DAY) as any, // 1 year ago
      }));

      const ctx = makeTieringCtx(entries, {
        decayConfig: {
          enabled: true,
          lambdas: { working: 0.1, ephemeral: 0.1, persistent: 0.1 },
          exemptDomains: [],
          timeoutMs: 30000,
        },
      });

      await autoTieringSweep(ctx, 10, 7);

      expect(entries.get("ancient")!.importanceScore).toBeGreaterThanOrEqual(0.01);
    });

    it("should batch-persist all decayed entries", async () => {
      const now = Date.now();
      vi.mocked(getNow).mockReturnValue(now as any);

      const entries = new Map<string, UnifiedMemoryEntry>();
      for (let i = 0; i < 5; i++) {
        entries.set(`d${i}`, makeEntry(`d${i}`, `decay target ${i}`, {
          tier: MemoryTier.Ephemeral,
          importanceScore: 0.5 as NormalizedScore,
          lastAccessedAt: (now - 5 * MS_PER_DAY) as any,
        }));
      }

      const ctx = makeTieringCtx(entries, {
        decayConfig: {
          enabled: true,
          lambdas: { working: 0.1, ephemeral: 0.1, persistent: 0.1 },
          exemptDomains: [],
          timeoutMs: 30000,
        },
      });

      await autoTieringSweep(ctx, 10, 7);

      expect(persistDecayedEntries).toHaveBeenCalledTimes(1);
      const decayedIds = vi.mocked(persistDecayedEntries).mock.calls[0]![1] as string[];
      expect(decayedIds.length).toBe(5);
    });

    it("should not persist when no scores changed", async () => {
      const now = Date.now();
      vi.mocked(getNow).mockReturnValue(now as any);

      const entries = new Map<string, UnifiedMemoryEntry>();
      entries.set("recent", makeEntry("recent", "just accessed", {
        tier: MemoryTier.Ephemeral,
        importanceScore: 0.5 as NormalizedScore,
        lastAccessedAt: now as any, // just accessed, no decay
      }));

      const ctx = makeTieringCtx(entries, {
        decayConfig: {
          enabled: true,
          lambdas: { working: 0.1, ephemeral: 0.1, persistent: 0.1 },
          exemptDomains: [],
          timeoutMs: 30000,
        },
      });

      await autoTieringSweep(ctx, 10, 7);

      expect(persistDecayedEntries).not.toHaveBeenCalled();
    });

    it("should skip decay when decayConfig is disabled", async () => {
      const now = Date.now();
      vi.mocked(getNow).mockReturnValue(now as any);

      const entries = new Map<string, UnifiedMemoryEntry>();
      entries.set("nodecay", makeEntry("nodecay", "no decay", {
        tier: MemoryTier.Ephemeral,
        importanceScore: 0.5 as NormalizedScore,
        lastAccessedAt: (now - 30 * MS_PER_DAY) as any,
      }));

      const ctx = makeTieringCtx(entries, {
        decayConfig: {
          enabled: false,
          lambdas: { working: 0.1, ephemeral: 0.1, persistent: 0.1 },
          exemptDomains: [],
          timeoutMs: 30000,
        },
      });

      await autoTieringSweep(ctx, 10, 7);

      // Score should remain unchanged
      expect(entries.get("nodecay")!.importanceScore).toBe(0.5);
    });
  });
});
