import { describe, it, expect, vi, beforeEach } from "vitest";
import { FallbackChainProvider } from "./fallback-chain.js";
import { createMockProvider } from "../../test-helpers.js";
import { ProviderHealthRegistry } from "./provider-health.js";
import type { IAIProvider, ConversationMessage, ToolDefinition } from "./provider.interface.js";

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

  // Audit #6: a benign CONTROL-PLANE cancel (the external/un-composed signal aborted —
  // user cancel / task wind-down) is NOT a provider outage. The chain must NOT poison
  // provider health and must NOT fall over to the next provider (which would fail
  // identically on the same aborted signal and surface a false "All providers failed").
  // It must propagate the cancel. A watchdog stall (externalSignal NOT aborted) still
  // records the failure and falls over — that path is unchanged.
  it("does not poison health or fall over when the external signal is aborted (benign cancel)", async () => {
    const controller = new AbortController();
    controller.abort(); // control-plane cancel

    const p1 = { ...createMockProvider(), name: "p1" };
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("This operation was aborted"));
    const p2 = { ...createMockProvider({ text: "should-not-reach" }), name: "p2" };

    const chain = new FallbackChainProvider([p1, p2]);
    const health = ProviderHealthRegistry.getInstance();
    const recordFailure = vi.spyOn(health, "recordFailure");

    await expect(
      chain.chat("sys", [], [], { signal: controller.signal, externalSignal: controller.signal }),
    ).rejects.toThrow();

    expect(p1.chat).toHaveBeenCalledTimes(1);
    expect(p2.chat).not.toHaveBeenCalled();      // no failover on a benign cancel
    expect(recordFailure).not.toHaveBeenCalled(); // health not poisoned
  });

  // Counterpart guard: a watchdog stall (no external cancel) MUST still fall over +
  // record failure — proving the fix keys on the external signal, not the message text.
  it("still falls over and records failure on a stall when the external signal is NOT aborted", async () => {
    const p1 = { ...createMockProvider(), name: "p1" };
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Streaming stalled after 60000ms"));
    const p2 = { ...createMockProvider({ text: "fallback-response" }), name: "p2" };

    const chain = new FallbackChainProvider([p1, p2]);
    const health = ProviderHealthRegistry.getInstance();
    const recordFailure = vi.spyOn(health, "recordFailure");

    const result = await chain.chat("sys", [], [], { signal: new AbortController().signal });

    expect(result.text).toBe("fallback-response");
    expect(p2.chat).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith("p1", expect.stringContaining("stalled"));
  });

  // Audit #1/#2: a resolved-but-empty response must NOT short-circuit the chain as
  // a success — a silently-empty provider should fail over to the next healthy one.
  it("falls over to the next provider when a provider returns an empty response", async () => {
    const p1 = { ...createMockProvider(), name: "empty-provider" };
    (p1.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: "",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, // non-zero tokens: detection is by content, not the token heuristic
    });
    const p2 = { ...createMockProvider({ text: "real-answer" }), name: "real-provider" };

    const chain = new FallbackChainProvider([p1, p2]);
    const result = await chain.chat("sys", [], []);

    expect(result.text).toBe("real-answer");
    expect(p1.chat).toHaveBeenCalledTimes(1);
    expect(p2.chat).toHaveBeenCalledTimes(1);
  });

  // A response WITH tool calls (even with empty text) is NOT empty — it must be returned, not failed over.
  it("returns a tool-call response with empty text without failing over", async () => {
    const p1 = {
      ...createMockProvider(),
      name: "toolcall-provider",
    };
    (p1.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: "",
      toolCalls: [{ id: "t1", name: "do_thing", input: {} }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const p2 = { ...createMockProvider({ text: "should-not-reach" }), name: "p2" };

    const chain = new FallbackChainProvider([p1, p2]);
    const result = await chain.chat("sys", [], []);

    expect(result.toolCalls).toHaveLength(1);
    expect(p2.chat).not.toHaveBeenCalled();
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

  // A "model not supported" / ModelError (some OpenAI-compatible gateways — e.g.
  // OpenCode/Zen — return it under a 401 status) is a per-provider config mismatch,
  // NOT an auth failure. It must be RETRYABLE so a healthy sibling provider is tried,
  // instead of collapsing the whole chain to "All providers failed" (live 09:45 bug).
  it("falls over on a 'model not supported' / ModelError (even with 401) instead of treating it as fatal", async () => {
    const p1 = { ...createMockProvider(), name: "opencode" };
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('OpenCode (Zen/Go) API error 401: {"type":"error","error":{"type":"ModelError","message":"Model opencode/stale-model-xyz is not supported"}}'),
    );
    const p2 = { ...createMockProvider({ text: "openai-ok" }), name: "openai" };

    const chain = new FallbackChainProvider([p1, p2]);
    const result = await chain.chat("sys", [], []);

    expect(result.text).toBe("openai-ok"); // failed over to the healthy sibling
    expect(p1.chat).toHaveBeenCalledTimes(1);
    expect(p2.chat).toHaveBeenCalledTimes(1);
  });

  // Guard: a GENUINE auth 401 stays non-retryable (don't hammer every sibling with a
  // request that will fail identically). Proves the carve-out is scoped to model errors.
  it("still treats a genuine auth 401 as non-retryable (rethrows without trying siblings)", async () => {
    const p1 = { ...createMockProvider(), name: "kimi" };
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Kimi API error 401: invalid_authentication: The API key is invalid or expired"),
    );
    const p2 = { ...createMockProvider({ text: "should-not-reach" }), name: "openai" };

    const chain = new FallbackChainProvider([p1, p2]);

    await expect(chain.chat("sys", [], [])).rejects.toThrow();
    expect(p2.chat).not.toHaveBeenCalled();
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

  describe("reasoning-timeout detection", () => {
    // Helper to build a mock provider with thinkingSupported set
    function createThinkingProvider(name: string, supportsThinking: boolean): ReturnType<typeof createMockProvider> & { name: string } {
      const base = createMockProvider();
      return {
        ...base,
        name,
        capabilities: {
          ...base.capabilities,
          thinkingSupported: supportsThinking,
        },
      };
    }

    // Case 1: abort + thinkingSupported + single provider → disableThinking called once
    it("abort + thinkingSupported + single provider: disables thinking exactly once", async () => {
      const p1 = createThinkingProvider("kimi-single", true);
      (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("upstream proxy abort: request timed out")
      );

      const chain = new FallbackChainProvider([p1]);
      const health = ProviderHealthRegistry.getInstance();
      const disableThinking = vi.spyOn(health, "disableThinking");

      // Single provider + reasoning timeout → throws "timed out during reasoning" error
      await expect(chain.chat("sys", [], [])).rejects.toThrow("timed out during reasoning");

      expect(disableThinking).toHaveBeenCalledWith("kimi-single");
      expect(disableThinking).toHaveBeenCalledTimes(1);
    });

    // Case 2: abort + "cancel" present → NOT a reasoning timeout; disableThinking NOT called
    it("abort + cancel in message: not classified as reasoning timeout", async () => {
      const p1 = createThinkingProvider("kimi-cancel", true);
      (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("request abort: cancel")
      );

      const chain = new FallbackChainProvider([p1]);
      const health = ProviderHealthRegistry.getInstance();
      const disableThinking = vi.spyOn(health, "disableThinking");

      await expect(chain.chat("sys", [], [])).rejects.toThrow();

      expect(disableThinking).not.toHaveBeenCalled();
    });

    // Case 3: abort + "task.interrupted" present → NOT classified; disableThinking NOT called
    it("abort + task.interrupted in message: not classified as reasoning timeout", async () => {
      const p1 = createThinkingProvider("kimi-interrupted", true);
      (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("task.interrupted abort signal received")
      );

      const chain = new FallbackChainProvider([p1]);
      const health = ProviderHealthRegistry.getInstance();
      const disableThinking = vi.spyOn(health, "disableThinking");

      await expect(chain.chat("sys", [], [])).rejects.toThrow();

      expect(disableThinking).not.toHaveBeenCalled();
    });

    // Case 4: abort + multi-provider → warning may log but disableThinking NOT called (single-provider guard)
    it("abort + multi-provider: warning may log but disableThinking is NOT called", async () => {
      const p1 = createThinkingProvider("kimi-multi", true);
      (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("upstream proxy abort: request timed out")
      );
      const p2 = { ...createMockProvider({ text: "fallback-ok" }), name: "openai-backup" };

      const chain = new FallbackChainProvider([p1, p2]);
      const health = ProviderHealthRegistry.getInstance();
      const disableThinking = vi.spyOn(health, "disableThinking");

      // Multi-provider: falls through to p2 successfully, no disableThinking
      const result = await chain.chat("sys", [], []);

      expect(result.text).toBe("fallback-ok");
      expect(disableThinking).not.toHaveBeenCalled();
    });

    // Case 5: abort + thinkingSupported: false → NOT classified; disableThinking NOT called
    it("abort + thinkingSupported false: not classified as reasoning timeout", async () => {
      const p1 = createThinkingProvider("openai-no-thinking", false);
      (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("upstream proxy abort: request timed out")
      );

      const chain = new FallbackChainProvider([p1]);
      const health = ProviderHealthRegistry.getInstance();
      const disableThinking = vi.spyOn(health, "disableThinking");

      await expect(chain.chat("sys", [], [])).rejects.toThrow();

      expect(disableThinking).not.toHaveBeenCalled();
    });

    // Case 6: already disabled (idempotence) → disableThinking NOT called again
    it("abort + already disabled: disableThinking is idempotent (not called again)", async () => {
      const p1 = createThinkingProvider("kimi-idempotent", true);
      (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("upstream proxy abort: request timed out")
      );

      const chain = new FallbackChainProvider([p1]);
      const health = ProviderHealthRegistry.getInstance();

      // Pre-disable thinking so isThinkingDisabled returns true
      health.disableThinking("kimi-idempotent");

      const disableThinking = vi.spyOn(health, "disableThinking");

      await expect(chain.chat("sys", [], [])).rejects.toThrow();

      // disableThinking must NOT have been called by the chain (already disabled guard)
      expect(disableThinking).not.toHaveBeenCalled();
    });
  });

  // A provider that accepts the connection but never responds (token-less stream /
  // unresponsive endpoint) used to hang indefinitely: no throw → no recordFailure →
  // no failover. The per-attempt first-response timeout converts that into a
  // retryable failure so the chain fails over (or fails fast for a single provider).
  describe("first-response timeout (silent-hang guard)", () => {
    beforeEach(() => ProviderHealthRegistry.resetInstance());

    function hangingProvider(name: string): IAIProvider {
      const p = { ...createMockProvider(), name };
      (p.chat as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<never>(() => {}));
      return p;
    }

    it("times out an unresponsive attempt and fails over to a healthy provider", async () => {
      const hang = hangingProvider("hang");
      const p2 = { ...createMockProvider({ text: "recovered" }), name: "p2" };
      const chain = new FallbackChainProvider([hang, p2], { attemptTimeoutMs: 50 });

      const result = await chain.chat("sys", [], []);
      expect(result.text).toBe("recovered");
      expect(hang.chat).toHaveBeenCalledTimes(1);
      expect(p2.chat).toHaveBeenCalledTimes(1);
    });

    it("a single unresponsive provider fails fast instead of hanging forever", async () => {
      const chain = new FallbackChainProvider([hangingProvider("hang")], { attemptTimeoutMs: 50 });
      await expect(chain.chat("sys", [], [])).rejects.toThrow(/no response within/i);
    });

    it("counts a timed-out attempt as a provider failure (trips the circuit breaker)", async () => {
      const hang = hangingProvider("hang");
      const p2 = { ...createMockProvider({ text: "ok" }), name: "p2" };
      const chain = new FallbackChainProvider([hang, p2], { attemptTimeoutMs: 50 });
      const recordFailure = vi.spyOn(ProviderHealthRegistry.getInstance(), "recordFailure");

      await chain.chat("sys", [], []);
      expect(recordFailure).toHaveBeenCalledWith("hang", expect.stringMatching(/no response within/i));
    });

    it("does not time out when attemptTimeoutMs is 0 (disabled — back-compat)", async () => {
      const slow = { ...createMockProvider(), name: "slow" };
      (slow.chat as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((r) => setTimeout(() => r({ text: "slow-ok", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }), 80)),
      );
      const chain = new FallbackChainProvider([slow], { attemptTimeoutMs: 0 });
      const result = await chain.chat("sys", [], []);
      expect(result.text).toBe("slow-ok");
    });

    it("does NOT kill a streaming provider after its first chunk (long healthy stream)", async () => {
      const streamer: IAIProvider = {
        ...createMockProvider(),
        name: "streamer",
        capabilities: { ...createMockProvider().capabilities, streaming: true },
        chatStream: vi.fn(async (_sp: string, _m: ConversationMessage[], _t: ToolDefinition[], onChunk: (c: string) => void) => {
          onChunk("hi");                                   // first chunk fast → clears the 40ms timer
          await new Promise((r) => setTimeout(r, 120));    // then a 120ms pause (> attemptTimeoutMs)
          return { text: "complete", toolCalls: [], stopReason: "end_turn" as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        }),
      } as IAIProvider;
      const chain = new FallbackChainProvider([streamer], { attemptTimeoutMs: 40 });

      const chunks: string[] = [];
      const result = await chain.chatStream("sys", [], [], (c) => { chunks.push(c); });
      expect(result.text).toBe("complete");                // not timed out despite 120ms > 40ms
      expect(chunks).toContain("hi");
    });
  });
});
