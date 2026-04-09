import { describe, it, expect, vi, beforeEach } from "vitest";
import { FallbackChainProvider } from "./fallback-chain.js";
import { createMockProvider } from "../../test-helpers.js";
import { ProviderHealthRegistry } from "./provider-health.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("FallbackChainProvider", () => {
  beforeEach(() => {
    ProviderHealthRegistry.resetInstance();
  });
  it("throws when given empty provider list", () => {
    expect(() => new FallbackChainProvider([])).toThrow(
      "at least one provider"
    );
  });

  it("uses first provider when it succeeds", async () => {
    const p1 = createMockProvider({ text: "from-p1" });
    const p2 = createMockProvider({ text: "from-p2" });
    const chain = new FallbackChainProvider([p1, p2]);

    const result = await chain.chat("sys", [], []);
    expect(result.text).toBe("from-p1");
    expect(p1.chat).toHaveBeenCalledTimes(1);
    expect(p2.chat).not.toHaveBeenCalled();
  });

  it("falls through to second provider on failure", async () => {
    const p1 = createMockProvider();
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API down"));
    const p2 = createMockProvider({ text: "fallback-response" });

    const chain = new FallbackChainProvider([p1, p2]);
    const result = await chain.chat("sys", [], []);

    expect(result.text).toBe("fallback-response");
    expect(p1.chat).toHaveBeenCalledTimes(1);
    expect(p2.chat).toHaveBeenCalledTimes(1);
  });

  it("tries all providers and throws when all fail", async () => {
    const p1 = { ...createMockProvider(), name: "provider-1" };
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("P1 down"));
    const p2 = { ...createMockProvider(), name: "provider-2" };
    (p2.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("P2 down"));
    const p3 = { ...createMockProvider(), name: "provider-3" };
    (p3.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("P3 down"));

    const chain = new FallbackChainProvider([p1, p2, p3]);
    await expect(chain.chat("sys", [], [])).rejects.toThrow("All providers failed");

    expect(p1.chat).toHaveBeenCalledTimes(1);
    expect(p2.chat).toHaveBeenCalledTimes(1);
    expect(p3.chat).toHaveBeenCalledTimes(1);
  });

  it("names itself with provider chain", () => {
    const p1 = createMockProvider();
    const p2 = createMockProvider();
    const chain = new FallbackChainProvider([p1, p2]);

    expect(chain.name).toBe("chain(mock-provider→mock-provider)");
  });

  it("passes all arguments to providers", async () => {
    const p1 = createMockProvider();
    const chain = new FallbackChainProvider([p1]);

    const msgs = [{ role: "user" as const, content: "test" }];
    const tools = [{ name: "t", description: "d", input_schema: {} }];

    await chain.chat("system-prompt", msgs, tools);

    expect(p1.chat).toHaveBeenCalledWith("system-prompt", msgs, tools, undefined);
  });

  it("reports healthy when a fallback provider passes healthCheck", async () => {
    const p1 = createMockProvider();
    const p2 = createMockProvider();
    p1.healthCheck = vi.fn().mockResolvedValue(false);
    p2.healthCheck = vi.fn().mockResolvedValue(true);

    const chain = new FallbackChainProvider([p1, p2]);

    await expect(chain.healthCheck()).resolves.toBe(true);
  });

  it("falls through on reasoning_content 400 error instead of rethrowing", async () => {
    const p1 = createMockProvider();
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("400 Bad Request: reasoning_content is not allowed for this model")
    );
    const p2 = createMockProvider({ text: "fallback-ok" });

    const chain = new FallbackChainProvider([p1, p2]);
    const result = await chain.chat("sys", [], []);

    expect(result.text).toBe("fallback-ok");
    expect(p1.chat).toHaveBeenCalledTimes(1);
    expect(p2.chat).toHaveBeenCalledTimes(1);
  });

  it("falls back to a later provider for listModels", async () => {
    const p1 = createMockProvider();
    const p2 = createMockProvider();
    p1.listModels = vi.fn().mockRejectedValue(new Error("provider offline"));
    p2.listModels = vi.fn().mockResolvedValue(["kimi-for-coding"]);

    const chain = new FallbackChainProvider([p1, p2]);

    await expect(chain.listModels()).resolves.toEqual(["kimi-for-coding"]);
  });

  it("applies long cooldown for 403 quota errors and skips the provider on subsequent calls", async () => {
    const p1 = { ...createMockProvider(), name: "kimi" };
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Kimi API error 403: You've reached your usage limit for this billing cycle")
    );
    const p2 = { ...createMockProvider({ text: "openai-ok" }), name: "openai" };

    const chain = new FallbackChainProvider([p1, p2]);

    // First call: Kimi fails with quota 403, falls back to OpenAI
    const result1 = await chain.chat("sys", [], []);
    expect(result1.text).toBe("openai-ok");
    expect(p1.chat).toHaveBeenCalledTimes(1);

    // Verify Kimi is now marked as down with quota cooldown
    const health = ProviderHealthRegistry.getInstance();
    const entry = health.getEntry("kimi");
    expect(entry?.status).toBe("down");
    expect(entry!.cooldownUntil).toBeGreaterThan(Date.now() + 7 * 60 * 60 * 1000); // at least 7h remaining

    // Second call: Kimi should be SKIPPED entirely (no attempt)
    (p1.chat as ReturnType<typeof vi.fn>).mockClear();
    const result2 = await chain.chat("sys", [], []);
    expect(result2.text).toBe("openai-ok");
    expect(p1.chat).not.toHaveBeenCalled(); // Kimi was skipped
  });

  it("does not extend an existing quota cooldown on repeated failures", async () => {
    const health = ProviderHealthRegistry.getInstance();

    // Simulate first quota exhaustion
    health.recordQuotaExhausted("kimi", "403 quota exceeded");
    const firstCooldown = health.getEntry("kimi")!.cooldownUntil;

    // Simulate second quota exhaustion (should NOT extend the cooldown)
    health.recordQuotaExhausted("kimi", "403 quota exceeded again");
    const secondCooldown = health.getEntry("kimi")!.cooldownUntil;

    expect(secondCooldown).toBe(firstCooldown);
  });

  it("probes recovering provider before sending real traffic", async () => {
    const health = ProviderHealthRegistry.getInstance();

    const p1 = { ...createMockProvider({ text: "from-p1" }), name: "recovering-provider" };
    const chain = new FallbackChainProvider([p1]);

    // Simulate: provider was down, cooldown already expired (in the past)
    health.recordFailure("recovering-provider", "timeout");
    health.recordFailure("recovering-provider", "timeout");
    health.recordFailure("recovering-provider", "timeout");
    health.recordFailure("recovering-provider", "timeout");
    health.recordFailure("recovering-provider", "timeout");

    // Force cooldownUntil into the past so isRecovering returns true
    const entry = health.getEntry("recovering-provider")!;
    Object.assign(entry, { cooldownUntil: Date.now() - 1000 });

    const result = await chain.chat("sys", [], []);

    // Provider.chat should have been called twice: once for probe, once for real call
    expect(p1.chat).toHaveBeenCalledTimes(2);
    // First call is the probe
    expect((p1.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("Reply with OK");
    // Second call is the real one
    expect((p1.chat as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toBe("sys");
    expect(result.text).toBe("from-p1");
  });

  it("skips provider when probe fails", async () => {
    const health = ProviderHealthRegistry.getInstance();

    const p1 = { ...createMockProvider(), name: "broken-provider" };
    let callCount = 0;
    (p1.chat as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Probe call fails
        return Promise.reject(new Error("still broken"));
      }
      return Promise.resolve({ text: "should-not-reach", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
    });

    const p2 = { ...createMockProvider({ text: "from-p2" }), name: "healthy-backup" };

    const chain = new FallbackChainProvider([p1, p2]);

    // Simulate: p1 was down, cooldown expired
    health.recordFailure("broken-provider", "timeout");
    health.recordFailure("broken-provider", "timeout");
    health.recordFailure("broken-provider", "timeout");
    health.recordFailure("broken-provider", "timeout");
    health.recordFailure("broken-provider", "timeout");

    const entry = health.getEntry("broken-provider")!;
    Object.assign(entry, { cooldownUntil: Date.now() - 1000 });

    const result = await chain.chat("sys", [], []);

    // p1 only got the probe call (which failed), not the real call
    expect(p1.chat).toHaveBeenCalledTimes(1);
    // p2 handled the real request
    expect(p2.chat).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("from-p2");
  });

  it("does not probe healthy providers", async () => {
    const p1 = { ...createMockProvider({ text: "from-p1" }), name: "healthy-provider" };
    const chain = new FallbackChainProvider([p1]);

    // No failures recorded — provider is healthy
    const result = await chain.chat("sys", [], []);

    // Only one call (the real one), no probe
    expect(p1.chat).toHaveBeenCalledTimes(1);
    expect((p1.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("sys");
    expect(result.text).toBe("from-p1");
  });

  it("records overloaded for 529 errors with extended cooldown", async () => {
    const p1 = { ...createMockProvider(), name: "overloaded-prov" };
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("MiniMax API error 529: server overloaded")
    );
    const p2 = { ...createMockProvider({ text: "backup-ok" }), name: "backup" };
    const chain = new FallbackChainProvider([p1, p2]);

    const result = await chain.chat("sys", [], []);
    expect(result.text).toBe("backup-ok");

    const health = ProviderHealthRegistry.getInstance();
    const entry = health.getEntry("overloaded-prov");
    expect(entry?.status).toBe("down");
    // Overload cooldown should be at least 5 minutes (300_000ms)
    expect(entry!.cooldownUntil).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
  });

  it("probe success records as probe kind (degraded, not full reset)", async () => {
    const health = ProviderHealthRegistry.getInstance();

    const p1 = { ...createMockProvider({ text: "recovered" }), name: "recovering-prov" };
    const chain = new FallbackChainProvider([p1]);

    // Simulate: provider was down, cooldown expired
    health.recordFailure("recovering-prov", "timeout");
    health.recordFailure("recovering-prov", "timeout");
    health.recordFailure("recovering-prov", "timeout");
    health.recordFailure("recovering-prov", "timeout");
    health.recordFailure("recovering-prov", "timeout");
    const entry = health.getEntry("recovering-prov")!;
    Object.assign(entry, { cooldownUntil: Date.now() - 1000 });

    await chain.chat("sys", [], []);

    // After probe + real success: status should be healthy (real success after probe)
    // The probe sets degraded, then the real request sets healthy
    const afterEntry = health.getEntry("recovering-prov")!;
    expect(afterEntry.status).toBe("healthy");
  });
});
