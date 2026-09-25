import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RateLimiter, estimateCost, applyStoredRateLimitOverrides } from "./rate-limiter.js";
import { DaemonStorage } from "../daemon/daemon-storage.js";
import { UnifiedBudgetManager } from "../budget/unified-budget-manager.js";

vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-03-01T12:00:00Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("message rate limiting", () => {
    it("allows messages within per-minute limit", () => {
      const limiter = new RateLimiter({ messagesPerMinute: 3 });
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
      expect(limiter.checkMessageRate("user1").allowed).toBe(false);
    });

    it("resets per-minute limit after 60 seconds", () => {
      const limiter = new RateLimiter({ messagesPerMinute: 2 });
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
      expect(limiter.checkMessageRate("user1").allowed).toBe(false);

      vi.advanceTimersByTime(61_000);
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
    });

    it("provides retryAfterMs for minute limit", () => {
      const limiter = new RateLimiter({ messagesPerMinute: 1 });
      limiter.checkMessageRate("user1");
      const result = limiter.checkMessageRate("user1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
    });

    it("allows messages within per-hour limit", () => {
      const limiter = new RateLimiter({ messagesPerHour: 2 });
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
      expect(limiter.checkMessageRate("user1").allowed).toBe(false);
    });

    it("provides retryAfterMs for hour limit", () => {
      const limiter = new RateLimiter({ messagesPerHour: 1 });
      limiter.checkMessageRate("user1");
      const result = limiter.checkMessageRate("user1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it("tracks users independently", () => {
      const limiter = new RateLimiter({ messagesPerMinute: 1 });
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
      expect(limiter.checkMessageRate("user2").allowed).toBe(true);
      expect(limiter.checkMessageRate("user1").allowed).toBe(false);
      expect(limiter.checkMessageRate("user2").allowed).toBe(false);
    });

    it("allows unlimited when limit is 0", () => {
      const limiter = new RateLimiter({ messagesPerMinute: 0 });
      for (let i = 0; i < 100; i++) {
        expect(limiter.checkMessageRate("user1").allowed).toBe(true);
      }
    });
  });

  describe("token quota", () => {
    it("blocks when daily token quota is exceeded", () => {
      const limiter = new RateLimiter({ tokensPerDay: 1000 });
      limiter.recordTokenUsage(600, 500, "claude");
      const result = limiter.checkMessageRate("user1");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Daily token quota exceeded");
    });

    it("prices the cached share of the prompt like the ledger (audit 03.2 / D21)", () => {
      const plain = new RateLimiter({ tokensPerDay: 10_000_000 });
      plain.recordTokenUsage(1_000_000, 0, "claude", "claude-sonnet-5");
      const cached = new RateLimiter({ tokensPerDay: 10_000_000 });
      cached.recordTokenUsage(1_000_000, 0, "claude", "claude-sonnet-5", { cacheReadInputTokens: 1_000_000 });
      expect(plain.getSnapshot().costToday).toBeGreaterThan(0);
      expect(cached.getSnapshot().costToday).toBeCloseTo(plain.getSnapshot().costToday * 0.1, 6);
    });

    it("allows when under daily token quota", () => {
      const limiter = new RateLimiter({ tokensPerDay: 10000 });
      limiter.recordTokenUsage(100, 200, "claude");
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
    });

    it("resets daily quota at midnight UTC", () => {
      const limiter = new RateLimiter({ tokensPerDay: 1000 });
      limiter.recordTokenUsage(600, 500, "claude");
      expect(limiter.checkMessageRate("user1").allowed).toBe(false);

      // Advance to next day
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
    });
  });

  describe("budget limits", () => {
    it("blocks when daily budget is exceeded", () => {
      const limiter = new RateLimiter({ dailyBudgetUsd: 0.01 });
      // Claude: $3/M input + $15/M output
      // 10000 input = $0.03, 1000 output = $0.015 → total $0.045
      limiter.recordTokenUsage(10000, 1000, "claude");
      const result = limiter.checkMessageRate("user1");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Daily budget exceeded");
    });

    it("blocks when monthly budget is exceeded", () => {
      const limiter = new RateLimiter({ monthlyBudgetUsd: 0.01 });
      limiter.recordTokenUsage(10000, 1000, "claude");
      const result = limiter.checkMessageRate("user1");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Monthly budget exceeded");
    });

    it("resets monthly budget at month start", () => {
      const limiter = new RateLimiter({ monthlyBudgetUsd: 0.01 });
      limiter.recordTokenUsage(10000, 1000, "claude");
      expect(limiter.checkMessageRate("user1").allowed).toBe(false);

      // Advance to next month (32 days to be safe)
      vi.advanceTimersByTime(32 * 24 * 60 * 60 * 1000);
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
    });

    it("ollama has zero cost", () => {
      const limiter = new RateLimiter({ dailyBudgetUsd: 0.001 });
      limiter.recordTokenUsage(1_000_000, 1_000_000, "ollama");
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
    });
  });

  describe("getSnapshot", () => {
    it("returns accurate quota snapshot", () => {
      const limiter = new RateLimiter({ messagesPerMinute: 10 });
      limiter.checkMessageRate("user1");
      limiter.checkMessageRate("user2");
      limiter.recordTokenUsage(100, 200, "claude");

      const snap = limiter.getSnapshot();
      expect(snap.tokensToday).toBe(300);
      expect(snap.costToday).toBeGreaterThan(0);
      expect(snap.messagesToday).toBe(2);
      expect(snap.activeUsers).toBe(2);
    });

    it("reflects cost this month", () => {
      const limiter = new RateLimiter();
      limiter.recordTokenUsage(1000, 500, "openai");
      const snap = limiter.getSnapshot();
      expect(snap.costThisMonth).toBeGreaterThan(0);
    });
  });

  describe("bucket eviction", () => {
    it("evicts a drained user bucket on a rejected check (no UTC rollover wait)", () => {
      // tokensPerDay is already exceeded, so every checkMessageRate is rejected
      // before the allow-path re-registers the bucket. The drained bucket from
      // the first (pre-quota) message must be evicted immediately.
      const limiter = new RateLimiter({ messagesPerHour: 10, tokensPerDay: 1000 });
      expect(limiter.checkMessageRate("user1").allowed).toBe(true);
      expect(limiter.getSnapshot().activeUsers).toBe(1);

      // Exceed the daily token quota, then let the per-user window drain.
      limiter.recordTokenUsage(600, 500, "claude");
      vi.advanceTimersByTime(3_600_001);

      // This check prunes user1's now-empty timestamps, then is rejected by the
      // token quota — so the bucket is not re-added and gets evicted.
      expect(limiter.checkMessageRate("user1").allowed).toBe(false);
      expect(limiter.getSnapshot().activeUsers).toBe(0);
    });

    it("keeps running daily token aggregate accurate across many records", () => {
      const limiter = new RateLimiter();
      for (let i = 0; i < 50; i++) {
        limiter.recordTokenUsage(100, 200, "claude");
      }
      expect(limiter.getSnapshot().tokensToday).toBe(50 * 300);
    });
  });
});

describe("estimateCost", () => {
  it("calculates Claude cost correctly", () => {
    // 1M input tokens at $3 + 1M output tokens at $15 = $18
    const cost = estimateCost(1_000_000, 1_000_000, "claude");
    expect(cost).toBeCloseTo(18.0, 1);
  });

  it("calculates OpenAI cost correctly", () => {
    const cost = estimateCost(1_000_000, 1_000_000, "openai");
    expect(cost).toBeCloseTo(12.5, 1);
  });

  it("uses default cost for unknown provider", () => {
    const cost = estimateCost(1_000_000, 1_000_000, "unknown_provider");
    expect(cost).toBeCloseTo(12.0, 1);
  });

  it("returns zero for ollama", () => {
    expect(estimateCost(1_000_000, 1_000_000, "ollama")).toBe(0);
  });

  it("handles zero tokens", () => {
    expect(estimateCost(0, 0, "claude")).toBe(0);
  });
});

describe("free-tier model pricing (audited 2026-09-02)", () => {
  it("prices a '-free' model at $0 instead of its provider's table rate", () => {
    // The live daemon billed hundreds of dollars against models literally named
    // "-free" because recordTokenUsage never passed the model id to estimateCost.
    const limiter = new RateLimiter();
    limiter.recordTokenUsage(1_000_000, 1_000_000, "opencode", "grok-code-free");

    const snap = limiter.getSnapshot();
    expect(snap.costToday).toBe(0);
    expect(snap.costThisMonth).toBe(0);
    // The tokens are still counted — only the price is zero.
    expect(snap.tokensToday).toBe(2_000_000);
  });

  it("still prices a PAID model on the same provider at the table rate", () => {
    const limiter = new RateLimiter();
    limiter.recordTokenUsage(1_000_000, 1_000_000, "opencode", "qwen3.6-plus");
    expect(limiter.getSnapshot().costToday).toBeCloseTo(3.6, 5);
  });

  it("does not spend the daily budget wall on a free model", () => {
    const limiter = new RateLimiter({ dailyBudgetUsd: 0.001 });
    limiter.recordTokenUsage(1_000_000, 1_000_000, "openrouter", "z-ai/glm-4.7:free");
    expect(limiter.checkMessageRate("user1").allowed).toBe(true);
  });

  it("keeps the provider table rate when no model id is known", () => {
    const limiter = new RateLimiter();
    limiter.recordTokenUsage(1_000_000, 0, "claude");
    expect(limiter.getSnapshot().costToday).toBeCloseTo(3.0, 5);
  });
});

// =============================================================================
// ITEM 2.7 — the limiter must be tellable, and a stored override must be in
// force from construction (a restart used to forget what the dashboard saved).
// =============================================================================

describe("updateConfig + stored overrides (item 2.7)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-03-01T12:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("updateConfig changes what checkMessageRate enforces, right away", () => {
    const limiter = new RateLimiter({ messagesPerMinute: 0 });
    limiter.updateConfig({ messagesPerMinute: 2 });
    expect(limiter.checkMessageRate("u").allowed).toBe(true);
    expect(limiter.checkMessageRate("u").allowed).toBe(true);
    expect(limiter.checkMessageRate("u").allowed).toBe(false);
  });

  it("updateConfig touches only the fields it is given", () => {
    const limiter = new RateLimiter({ messagesPerMinute: 4, messagesPerHour: 40, tokensPerDay: 400, dailyBudgetUsd: 5 });
    limiter.updateConfig({ messagesPerHour: 7 });
    expect(limiter.getConfig()).toEqual({
      messagesPerMinute: 4,
      messagesPerHour: 7,
      tokensPerDay: 400,
      dailyBudgetUsd: 5,
      monthlyBudgetUsd: 0,
    });
  });

  it("updateConfig refuses an invalid number and keeps the running config", () => {
    const limiter = new RateLimiter({ messagesPerMinute: 4 });
    expect(() => limiter.updateConfig({ messagesPerMinute: -1 })).toThrow(/messagesPerMinute/);
    expect(() => limiter.updateConfig({ tokensPerDay: Number.NaN })).toThrow(/tokensPerDay/);
    expect(limiter.getConfig().messagesPerMinute).toBe(4);
  });

  it("a stored override is in force on a freshly constructed limiter", () => {
    // The daemon restarts: config says 60/minute, the dashboard stored 2.
    const stored = new Map<string, string>([["rate_limit_messages_per_minute::global", "2"]]);
    const limiter = new RateLimiter({ messagesPerMinute: 60 });
    const applied = applyStoredRateLimitOverrides(limiter, {
      getSettingsOverride: (key, scope = "global") => stored.get(`${key}::${scope}`),
    });
    expect(applied).toEqual({ messagesPerMinute: 2 });
    expect(limiter.checkMessageRate("u").allowed).toBe(true);
    expect(limiter.checkMessageRate("u").allowed).toBe(true);
    expect(limiter.checkMessageRate("u").allowed).toBe(false);
  });

  it("GUARD: no stored override leaves the configured limits exactly as they are", () => {
    const limiter = new RateLimiter({ messagesPerMinute: 3, tokensPerDay: 99 });
    const applied = applyStoredRateLimitOverrides(limiter, { getSettingsOverride: () => undefined });
    expect(applied).toEqual({});
    expect(limiter.getConfig()).toMatchObject({ messagesPerMinute: 3, tokensPerDay: 99 });
  });

  it("GUARD: a corrupt stored value is ignored, not enforced", () => {
    const stored = new Map<string, string>([
      ["rate_limit_messages_per_minute::global", "not-a-number"],
      ["rate_limit_tokens_per_day::global", "500"],
    ]);
    const limiter = new RateLimiter({ messagesPerMinute: 3, tokensPerDay: 99 });
    const applied = applyStoredRateLimitOverrides(limiter, {
      getSettingsOverride: (key, scope = "global") => stored.get(`${key}::${scope}`),
    });
    expect(applied).toEqual({ tokensPerDay: 500 });
    expect(limiter.getConfig()).toMatchObject({ messagesPerMinute: 3, tokensPerDay: 500 });
  });
});

describe("spend caps survive a restart (SEC-21)", () => {
  // The durable ledger the limiter seeds from: the same daemon.db the budget
  // manager books every task's cost into.
  let dir: string;
  const open = () => {
    const storage = new DaemonStorage(join(dir, "daemon.db"));
    storage.initialize();
    storage.migrateBudgetSource();
    return { storage, ledger: new UnifiedBudgetManager(storage, { emit: () => {} }, {}) };
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-03-10T12:00:00Z"), toFake: ["Date"] });
    dir = mkdtempSync(join(tmpdir(), "rate-limiter-ledger-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a restart with today's spend already recorded keeps the daily cap blocking", () => {
    const before = open();
    before.ledger.recordCost(1.5, "chat", { model: "claude-sonnet" });
    before.storage.close();

    // New process: nothing in memory, only what the ledger kept.
    const after = open();
    const limiter = new RateLimiter({ dailyBudgetUsd: 1 }, { spendLedger: after.ledger });
    const result = limiter.checkMessageRate("u");
    after.storage.close();

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Daily budget exceeded/);
  });

  it("spend from earlier this month keeps the monthly cap blocking, but not today's", () => {
    const before = open();
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
    before.ledger.recordCost(30, "agent", { agentId: "a1" });
    vi.setSystemTime(new Date("2026-02-27T09:00:00Z")); // last month: not counted
    before.ledger.recordCost(500, "chat", {});
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));
    before.storage.close();

    const after = open();
    const limiter = new RateLimiter({ dailyBudgetUsd: 10, monthlyBudgetUsd: 25 }, { spendLedger: after.ledger });
    const snapshot = limiter.getSnapshot();
    const result = limiter.checkMessageRate("u");
    after.storage.close();

    expect(snapshot.costToday).toBe(0);
    expect(snapshot.costThisMonth).toBeCloseTo(30, 6);
    expect(result.reason).toMatch(/Monthly budget exceeded/);
  });

  it("seeding never lowers what this process already counted", () => {
    const limiter = new RateLimiter({ dailyBudgetUsd: 100 });
    limiter.recordTokenUsage(1_000_000, 0, "claude", "claude-sonnet-4-6");
    const counted = limiter.getSnapshot().costToday;
    expect(counted).toBeGreaterThan(0);
    limiter.seedSpend({ recordedSpendSince: () => counted / 2 });
    expect(limiter.getSnapshot().costToday).toBe(counted);
  });

  it("an unreadable ledger leaves the counters alone instead of failing startup", () => {
    const limiter = new RateLimiter({ dailyBudgetUsd: 1 });
    expect(() =>
      limiter.seedSpend({
        recordedSpendSince: () => {
          throw new Error("database is locked");
        },
      }),
    ).not.toThrow();
    expect(limiter.getSnapshot().costToday).toBe(0);
    expect(limiter.checkMessageRate("u").allowed).toBe(true);
  });
});
