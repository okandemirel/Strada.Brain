import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter, estimateCost } from "./rate-limiter.js";

vi.mock("../utils/logger.js", () => ({
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
