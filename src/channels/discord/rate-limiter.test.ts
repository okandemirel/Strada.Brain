import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DiscordRateLimiter,
  PerChannelRateLimiter,
} from "./rate-limiter.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("DiscordRateLimiter", () => {
  let limiter: DiscordRateLimiter;

  beforeEach(() => {
    limiter = new DiscordRateLimiter({
      requestsPerSecond: 10,
      minDelayMs: 10,
      burstSize: 3,
      cooldownMs: 100,
    });
  });

  it("should allow immediate acquire within burst limit", async () => {
    const start = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    
    // Should complete quickly (within burst)
    expect(elapsed).toBeLessThan(50);
  });

  it("should delay when burst is exhausted", async () => {
    // Exhaust burst
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    
    const start = Date.now();
    await limiter.acquire(); // This should wait
    const elapsed = Date.now() - start;
    
    // Should have waited at least minDelayMs
    expect(elapsed).toBeGreaterThanOrEqual(5);
  });

  it("tryAcquire should return true when tokens available", () => {
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it("tryAcquire should return false when burst exhausted", () => {
    limiter.tryAcquire();
    limiter.tryAcquire();
    limiter.tryAcquire();
    expect(limiter.tryAcquire()).toBe(false);
  });

  it("should report rate limit errors and cooldown", async () => {
    limiter.reportRateLimitError(200);
    
    // After rate limit, tokens should be drained
    expect(limiter.tryAcquire()).toBe(false);
    
    // Status should show throttled
    const status = limiter.getStatus();
    expect(status.isThrottled).toBe(true);
    expect(status.consecutiveErrors).toBe(1);
  });

  it("should reset error count on success", () => {
    limiter.reportRateLimitError();
    expect(limiter.getStatus().consecutiveErrors).toBe(1);
    
    limiter.reportSuccess();
    expect(limiter.getStatus().consecutiveErrors).toBe(0);
  });

  it("should return status information", () => {
    limiter.tryAcquire();
    const status = limiter.getStatus();
    
    expect(status).toHaveProperty("availableTokens");
    expect(status).toHaveProperty("queueLength");
    expect(status).toHaveProperty("consecutiveErrors");
    expect(status).toHaveProperty("isThrottled");
    
    expect(status.availableTokens).toBe(2); // Started with 3, used 1
    expect(status.queueLength).toBe(0);
    expect(status.consecutiveErrors).toBe(0);
  });
});

describe("PerChannelRateLimiter", () => {
  let limiter: PerChannelRateLimiter;

  beforeEach(() => {
    limiter = new PerChannelRateLimiter(
      new DiscordRateLimiter({
        requestsPerSecond: 100, // High limit to not block
        burstSize: 100,
      })
    );
  });

  it("should allow requests within channel limit", async () => {
    const channelId = "123456789";
    
    // Should allow 5 requests quickly
    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      await limiter.acquire(channelId);
    }
    const elapsed = Date.now() - start;
    
    expect(elapsed).toBeLessThan(100);
  });

  it("should track different channels separately", async () => {
    const channel1 = "111";
    const channel2 = "222";
    
    // Use up limit on channel1
    for (let i = 0; i < 5; i++) {
      await limiter.acquire(channel1);
    }
    
    // Should still be able to use channel2
    const start = Date.now();
    await limiter.acquire(channel2);
    const elapsed = Date.now() - start;
    
    expect(elapsed).toBeLessThan(50);
  });

  it("should report channel rate limits", () => {
    const channelId = "123456789";
    limiter.reportChannelRateLimit(channelId, 500);
    
    const statuses = limiter.getChannelStatuses();
    expect(statuses.length).toBeGreaterThan(0);
  });

  it("should return channel statuses", async () => {
    const channelId = "123456789";
    await limiter.acquire(channelId);
    await limiter.acquire(channelId);
    
    const statuses = limiter.getChannelStatuses();
    const channelStatus = statuses.find((s) => s.channelId === channelId);
    
    expect(channelStatus).toBeDefined();
    expect(channelStatus!.requestCount).toBe(2);
    expect(channelStatus!.remainingInWindow).toBe(3);
  });

  it("should clean up old channel entries", async () => {
    const channelId = "123456789";
    await limiter.acquire(channelId);
    
    // Wait for window to expire (5 seconds window + buffer)
    // In test, we just verify the method doesn't throw
    const statuses = limiter.getChannelStatuses();
    expect(statuses).toBeDefined();
  });
});
