import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SlackRateLimiter,
  FileUploadRateLimiter,
  StreamingRateLimiter,
  createDefaultRateLimiter,
} from "../rate-limiter.js";

// Mock logger
vi.mock("../../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("SlackRateLimiter", () => {
  let rateLimiter: SlackRateLimiter;

  beforeEach(() => {
    rateLimiter = new SlackRateLimiter();
  });

  describe("acquire", () => {
    it("should allow request when under limit", async () => {
      await expect(rateLimiter.acquire("chat.postMessage", 1)).resolves.not.toThrow();
    });

    it("should track method tier correctly", () => {
      expect(rateLimiter.getMethodTier("chat.postMessage")).toBe(1);
      expect(rateLimiter.getMethodTier("conversations.info")).toBe(2);
      expect(rateLimiter.getMethodTier("views.open")).toBe(3);
      expect(rateLimiter.getMethodTier("unknown.method")).toBe(4);
    });
  });

  describe("getStatus", () => {
    it("should return status for all tiers", async () => {
      await rateLimiter.acquire("test", 1);
      const status = rateLimiter.getStatus();

      expect(status).toHaveProperty("tier1");
      expect(status).toHaveProperty("tier2");
      expect(status).toHaveProperty("tier3");
      expect(status).toHaveProperty("tier4");
    });

    it("should track used requests", async () => {
      await rateLimiter.acquire("test", 1);
      const status = rateLimiter.getStatus();
      expect(status.tier1.used).toBe(1);
    });
  });

  describe("handleRateLimitResponse", () => {
    it("should calculate wait time with buffer", () => {
      const waitTime = rateLimiter.handleRateLimitResponse(5);
      expect(waitTime).toBe(6000); // 5s + 1s buffer
    });
  });

  describe("reset", () => {
    it("should reset all state", async () => {
      await rateLimiter.acquire("test", 1);
      rateLimiter.reset();
      const status = rateLimiter.getStatus();
      expect(status.tier1.used).toBe(0);
    });
  });

  describe("drain", () => {
    it("should resolve when queue is empty", async () => {
      await expect(rateLimiter.drain()).resolves.not.toThrow();
    });
  });

  describe("custom tiers", () => {
    it("should accept custom tier configuration", () => {
      const customLimiter = new SlackRateLimiter({
        tier1: { requestsPerMinute: 10, burstAllowance: 2 },
      });
      
      expect(customLimiter.getStatus().tier1.limit).toBe(10);
    });
  });
});

describe("FileUploadRateLimiter", () => {
  let rateLimiter: FileUploadRateLimiter;

  beforeEach(() => {
    rateLimiter = new FileUploadRateLimiter(10); // 10 uploads per minute
  });

  describe("acquire", () => {
    it("should allow first request immediately", async () => {
      await expect(rateLimiter.acquire()).resolves.not.toThrow();
    });

    it("should enforce minimum interval", async () => {
      const start = Date.now();
      await rateLimiter.acquire();
      await rateLimiter.acquire();
      const elapsed = Date.now() - start;
      
      // Should wait at least 6 seconds (60000/10)
      expect(elapsed).toBeGreaterThanOrEqual(5000);
    });
  });

  describe("reset", () => {
    it("should reset the limiter", async () => {
      await rateLimiter.acquire();
      rateLimiter.reset();
      
      const start = Date.now();
      await rateLimiter.acquire();
      expect(Date.now() - start).toBeLessThan(100);
    });
  });
});

describe("StreamingRateLimiter", () => {
  let rateLimiter: StreamingRateLimiter;

  beforeEach(() => {
    rateLimiter = new StreamingRateLimiter(10); // 10 updates per second
  });

  describe("shouldUpdate", () => {
    it("should return true initially", () => {
      expect(rateLimiter.shouldUpdate()).toBe(true);
    });

    it("should return false after acquire", async () => {
      await rateLimiter.acquire();
      expect(rateLimiter.shouldUpdate()).toBe(false);
    });
  });

  describe("acquire", () => {
    it("should enforce rate limit", async () => {
      const start = Date.now();
      await rateLimiter.acquire();
      await rateLimiter.acquire();
      const elapsed = Date.now() - start;
      
      // Should wait at least 100ms (1000/10)
      expect(elapsed).toBeGreaterThanOrEqual(50);
    });
  });

  describe("reset", () => {
    it("should reset the limiter", async () => {
      await rateLimiter.acquire();
      rateLimiter.reset();
      expect(rateLimiter.shouldUpdate()).toBe(true);
    });
  });
});

describe("createDefaultRateLimiter", () => {
  it("should create a rate limiter with default settings", () => {
    const limiter = createDefaultRateLimiter();
    expect(limiter).toBeInstanceOf(SlackRateLimiter);
  });
});
