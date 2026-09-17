/**
 * Codex 2026-09-17 #4 on 1f0b5742: the consensus reviewer's spend went to the
 * task callback alone, which skipped the rate limiter and the metrics — and is
 * absent on interactive runs, where the reviewer's turns were then unrecorded.
 * The sink is the same path a model turn's usage takes.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createLogger } from "../../utils/logger.js";

beforeAll(() => { try { createLogger("error", "/tmp/strada-consensus-sink-test.log"); } catch { /* already */ } });
import { consensusUsageSink } from "./accounting.js";
import { RateLimiter } from "../../security/rate-limiter.js";

describe("consensusUsageSink", () => {
  it("feeds the rate limiter and the metrics, and forwards to the task's onUsage", () => {
    const rateLimiter = new RateLimiter();
    const metrics = { recordTokenUsage: vi.fn() };
    const onUsage = vi.fn();
    const sink = consensusUsageSink({ getSupervisorRoutingContext: () => ({ rateLimiter, metrics }) } as never, { onUsage });
    sink({ provider: "claude", model: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 1_000_000 });
    expect(metrics.recordTokenUsage).toHaveBeenCalledWith(1_000_000, 0, "claude");
    expect(rateLimiter.getSnapshot().tokensToday).toBe(1_000_000);
    expect(rateLimiter.getSnapshot().costToday).toBeGreaterThan(0);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude", model: "claude-sonnet-5", inputTokens: 1_000_000 }));
  });

  it("an interactive run (no onUsage) still reaches the limiter and metrics", () => {
    const rateLimiter = new RateLimiter();
    const metrics = { recordTokenUsage: vi.fn() };
    const sink = consensusUsageSink({ getSupervisorRoutingContext: () => ({ rateLimiter, metrics }) } as never, {});
    sink({ provider: "opencode", inputTokens: 500, outputTokens: 50 });
    expect(metrics.recordTokenUsage).toHaveBeenCalledTimes(1);
    expect(rateLimiter.getSnapshot().tokensToday).toBe(550);
  });
});
