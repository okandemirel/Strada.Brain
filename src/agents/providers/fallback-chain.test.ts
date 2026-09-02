import { describe, it, expect, vi, beforeEach } from "vitest";
import { FallbackChainProvider } from "./fallback-chain.js";
import { createMockProvider } from "../../test-helpers.js";
import { ProviderHealthRegistry } from "./provider-health.js";
import { QuotaExhaustedError } from "../../common/fetch-with-retry.js";
import type { IAIProvider, ConversationMessage, ToolDefinition } from "./provider.interface.js";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

    // The chain now always threads a resilience options object carrying the onBackoff
    // hook (so a provider's 429 retry backoff can reset the first-response timer).
    expect(p1.chat).toHaveBeenCalledWith(
      "system-prompt",
      msgs,
      tools,
      expect.objectContaining({ onBackoff: expect.any(Function) }),
    );
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

  // Unlike a generic gateway ModelError (above, which SHOULD fail over to a sibling),
  // a ChatGPT/Codex SUBSCRIPTION rejecting its pinned model with HTTP 400 is a STATIC
  // config mismatch — the subscription serves a fixed Codex model set, so retrying or
  // failing over re-fails identically. It must be NON-retryable AND must NOT churn the
  // provider's health (recording a cooldown would take an otherwise-healthy provider
  // offline for hours). This is the exact live bug: a churned gpt-5.2 override 400'd
  // the Codex subscription, poisoned OpenAI's health, and — with the only sibling on a
  // weekly-quota cooldown — collapsed the chain to a false "no available provider".
  it("treats a Codex subscription model-rejection (400) as non-retryable WITHOUT churning health", async () => {
    const health = ProviderHealthRegistry.getInstance();
    const recordFailure = vi.spyOn(health, "recordFailure");

    const p1 = { ...createMockProvider(), name: "openai" };
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('OpenAI The configured model "gpt-5.2" is not accepted by the ChatGPT/Codex subscription endpoint (HTTP 400). The \'gpt-5.2\' model is not supported when using Codex with a ChatGPT account. Set the OpenAI model to a Codex-supported one (such as gpt-5.4) or switch OpenAI to API-key mode.'),
    );
    const p2 = { ...createMockProvider({ text: "should-not-reach" }), name: "deepseek" };

    const chain = new FallbackChainProvider([p1, p2]);

    // Non-retryable: rethrows immediately, does NOT hammer the sibling.
    await expect(chain.chat("sys", [], [])).rejects.toThrow(/not accepted by the ChatGPT\/Codex subscription/i);
    expect(p2.chat).not.toHaveBeenCalled();

    // Health not poisoned — the provider stays available for a corrected model.
    expect(recordFailure).not.toHaveBeenCalled();
    expect(health.isAvailable("openai")).toBe(true);
  });

  // Guard: a GENUINE auth 401 stays non-retryable (don't hammer every sibling with a
  // request that will fail identically). Proves the carve-out is scoped to model errors.
  /**
   * This asserted the opposite until 2026-08-23: a genuine auth 401 ended the
   * chain call without trying siblings. Run 55 showed what that costs. A
   * provider whose key had been revoked failed preflight, was reported as
   * failed, and was then tried six more times during the run — each 401 ending
   * the whole call rather than that provider's turn in it, and one of them
   * blocking the task, while a healthy provider sat untried beside it.
   *
   * A rejected credential is about THIS provider's key and says nothing about
   * the sibling. A 400 is different — it is about the request, and the sibling
   * would reject it identically; that case still ends the call, and is asserted
   * in credential-rejected.test.ts. Visibility is not lost: the rejection is
   * logged as an error and preflight already reports it as a startup notice.
   */
  it("fails over past a rejected credential, and benches the provider", async () => {
    const p1 = { ...createMockProvider(), name: "kimi" };
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Kimi API error 401: invalid_authentication: The API key is invalid or expired"),
    );
    const p2 = { ...createMockProvider({ text: "healthy-sibling" }), name: "openai" };

    const chain = new FallbackChainProvider([p1, p2]);

    await expect(chain.chat("sys", [], [])).resolves.toMatchObject({ text: "healthy-sibling" });
    expect(p2.chat).toHaveBeenCalled();
    expect(ProviderHealthRegistry.getInstance().isAvailable("kimi")).toBe(false);
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

  it("does not stack an existing quota cooldown on repeated failures", async () => {
    const health = ProviderHealthRegistry.getInstance();
    // Frozen clock: the cooldown is "now + 8h", so at one instant a repeated
    // quota record must land on the SAME expiry — never 8h on top of 8h.
    // (audited 2026-09-02: a shorter ACTIVE cooldown is replaced, not kept.)
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      // Simulate first quota exhaustion
      health.recordQuotaExhausted("kimi", "403 quota exceeded");
      const firstCooldown = health.getEntry("kimi")!.cooldownUntil;
      expect(firstCooldown).toBe(now + 8 * 60 * 60 * 1000);

      // Simulate second quota exhaustion (must NOT stack the cooldown)
      health.recordQuotaExhausted("kimi", "403 quota exceeded again");
      const secondCooldown = health.getEntry("kimi")!.cooldownUntil;

      expect(secondCooldown).toBe(firstCooldown);
    } finally {
      spy.mockRestore();
    }
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

  it("waits once for the soonest provider to recover when the whole chain is transiently cooled", async () => {
    const health = ProviderHealthRegistry.getInstance();
    const p1 = { ...createMockProvider({ text: "recovered-p1" }), name: "cooled-provider" };
    const chain = new FallbackChainProvider([p1]);

    // Only provider is transiently cooled with an IMMINENT recovery (~80ms ahead, well
    // inside the 60s window). The chain must wait once rather than throw "all in cooldown".
    // 80ms (not lower) + the chain's RECOVERY_WAIT_SLACK_MS keep the wall-vs-monotonic clock
    // jitter that flaked this test on CI comfortably out of range.
    health.recordFailure("cooled-provider", "transient 429");
    health.recordFailure("cooled-provider", "transient 429"); // degraded
    const entry = health.getEntry("cooled-provider")!;
    Object.assign(entry, { cooldownUntil: Date.now() + 80 });
    expect(health.isAvailable("cooled-provider")).toBe(false);
    expect(health.suggestRecoveryWaitMs()).not.toBeNull();

    const result = await chain.chat("sys", [], []);

    // After the bounded wait the cooldown has elapsed → provider is probed + used.
    expect(result.text).toBe("recovered-p1");
    expect((p1.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("fails fast (no bounded wait) when the soonest recovery is beyond the window", async () => {
    const health = ProviderHealthRegistry.getInstance();
    const p1 = { ...createMockProvider(), name: "down-provider" };
    const chain = new FallbackChainProvider([p1]);

    // Down with a cooldown far beyond the recovery window → suggestRecoveryWaitMs() === null.
    for (let i = 0; i < 5; i++) health.recordFailure("down-provider", "err");
    const entry = health.getEntry("down-provider")!;
    Object.assign(entry, { cooldownUntil: Date.now() + 10 * 60_000 }); // 10 min ahead
    expect(health.suggestRecoveryWaitMs()).toBeNull();

    const started = Date.now();
    await expect(chain.chat("sys", [], [])).rejects.toThrow(/cooldown/i);
    expect(Date.now() - started).toBeLessThan(1000); // no bounded wait was taken
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

    it("notifies onModelUnresponsive (provider, model) when an attempt times out", async () => {
      const hang = hangingProvider("hang");
      const p2 = { ...createMockProvider({ text: "ok" }), name: "p2" };
      const onModelUnresponsive = vi.fn();
      const chain = new FallbackChainProvider([hang, p2], {
        attemptTimeoutMs: 50,
        attemptMeta: [{ provider: "opencode", model: "dead-model" }, { provider: "claude", model: "claude-x" }],
        onModelUnresponsive,
      });
      await chain.chat("sys", [], []);
      expect(onModelUnresponsive).toHaveBeenCalledWith("opencode", "dead-model");
    });

    it("notifies onModelResponsive (provider, model) on a successful attempt", async () => {
      const p1 = { ...createMockProvider({ text: "ok" }), name: "p1" };
      const onModelResponsive = vi.fn();
      const chain = new FallbackChainProvider([p1], {
        attemptTimeoutMs: 5000,
        attemptMeta: [{ provider: "opencode", model: "good-model" }],
        onModelResponsive,
      });
      await chain.chat("sys", [], []);
      expect(onModelResponsive).toHaveBeenCalledWith("opencode", "good-model");
    });
  });

  // A deliberate 429 retry backoff is the client waiting ON PURPOSE — it must NOT be
  // counted against the first-response silence budget (which protects against a truly
  // unresponsive endpoint). These tests prove: (1) a transient 429 that backs off
  // LONGER than the budget but then succeeds now COMPLETES instead of dying at the
  // timeout; (2) a 429-driven failure is classified + reported as RATE-LIMITED, not
  // "unresponsive endpoint"; (3) a genuinely-silent endpoint (no 429) STILL times out.
  describe("429 rate-limit coherence + honest classification", () => {
    beforeEach(() => ProviderHealthRegistry.resetInstance());

    /**
     * A provider whose own HTTP retry wrapper hits a 429 and waits on a deliberate
     * backoff (longer than the chain's first-response budget) before finally
     * succeeding. It models that by firing options.onBackoff({status:429}) then
     * resolving after `backoffMs` — the backoff must reset the chain timer so the
     * late success survives.
     */
    function backoffThenSucceedProvider(name: string, backoffMs: number): IAIProvider {
      const p = { ...createMockProvider({ text: "after-429" }), name };
      (p.chat as ReturnType<typeof vi.fn>).mockImplementation(
        (_sp: string, _m: ConversationMessage[], _t: ToolDefinition[], opts?: { onBackoff?: (i: { status: number; delayMs: number }) => void }) =>
          new Promise((resolve) => {
            // Simulate the retry wrapper scheduling a 429 backoff immediately.
            opts?.onBackoff?.({ status: 429, delayMs: backoffMs });
            setTimeout(
              () => resolve({ text: "after-429", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
              backoffMs,
            );
          }),
      );
      return p;
    }

    it("a transient 429-then-success completes within budget instead of aborting at the timeout (coherence)", async () => {
      // backoff (80ms) is LONGER than the 40ms first-response budget; without the
      // markActivity reset this would die with a 90s-style "no response" timeout.
      const provider = backoffThenSucceedProvider("opencode", 80);
      const chain = new FallbackChainProvider([provider], { attemptTimeoutMs: 40 });

      const result = await chain.chat("sys", [], []);
      expect(result.text).toBe("after-429");
      expect(provider.chat).toHaveBeenCalledTimes(1);
    });

    it("classifies a 429 backoff that exceeds the budget as RATE-LIMITED, not unresponsive", async () => {
      // Fires onBackoff(429) then never resolves → the budget (extended by the backoff)
      // elapses while still silent. The terminal error must say rate-limited, NOT
      // "unresponsive endpoint". delayMs is small so the extended deadline fires fast.
      const p = { ...createMockProvider(), name: "opencode" };
      (p.chat as ReturnType<typeof vi.fn>).mockImplementation(
        (_sp: string, _m: ConversationMessage[], _t: ToolDefinition[], opts?: { onBackoff?: (i: { status: number; delayMs: number }) => void }) =>
          new Promise<never>(() => { opts?.onBackoff?.({ status: 429, delayMs: 30 }); }),
      );
      const chain = new FallbackChainProvider([p], { attemptTimeoutMs: 40 });

      await expect(chain.chat("sys", [], [])).rejects.toThrow(/rate-limited \(HTTP 429\)/i);
    });

    it("does NOT mark a rate-limited model unresponsive (no auto-demote for 429)", async () => {
      const p = { ...createMockProvider(), name: "opencode" };
      (p.chat as ReturnType<typeof vi.fn>).mockImplementation(
        (_sp: string, _m: ConversationMessage[], _t: ToolDefinition[], opts?: { onBackoff?: (i: { status: number; delayMs: number }) => void }) =>
          new Promise<never>(() => { opts?.onBackoff?.({ status: 429, delayMs: 30 }); }),
      );
      const onModelUnresponsive = vi.fn();
      const chain = new FallbackChainProvider([p], {
        attemptTimeoutMs: 40,
        attemptMeta: [{ provider: "opencode", model: "qwen" }],
        onModelUnresponsive,
      });

      await expect(chain.chat("sys", [], [])).rejects.toThrow(/rate-limited/i);
      // A throttled model is alive — it must NOT be auto-demoted as unresponsive.
      expect(onModelUnresponsive).not.toHaveBeenCalled();
    });

    it("surfaces a terminal rate-limited message when 429 retries are exhausted by the provider", async () => {
      // Models the provider's retry wrapper exhausting its 429 retries and throwing the
      // honest fetch-with-retry terminal message.
      const p = { ...createMockProvider(), name: "opencode" };
      (p.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("OpenCode (Zen/Go) rate-limited (HTTP 429): too many requests"),
      );
      const chain = new FallbackChainProvider([p], { attemptTimeoutMs: 5000 });

      await expect(chain.chat("sys", [], [])).rejects.toThrow(/rate-limited \(HTTP 429\)/i);
    });

    it("a genuinely-silent endpoint (no 429, no bytes) STILL times out as unresponsive (protection intact)", async () => {
      // No onBackoff is ever fired → the silence budget is never reset → the honest
      // unresponsive-endpoint timeout still fires. This is the guard that the coherence
      // fix did NOT weaken the genuine-timeout protection.
      const silent = { ...createMockProvider(), name: "dead" };
      (silent.chat as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<never>(() => {}));
      const chain = new FallbackChainProvider([silent], { attemptTimeoutMs: 40 });

      await expect(chain.chat("sys", [], [])).rejects.toThrow(/no response within|unresponsive endpoint/i);
    });
  });

  // A HARD QUOTA STOP (a 429 whose Retry-After exceeds the whole retry budget — the
  // provider is out of weekly/quota credit for days) surfaces as a non-retryable
  // QuotaExhaustedError from fetch-with-retry. The chain must cool THAT provider down for
  // a long time AND fail over to the next provider IMMEDIATELY (never abort the chain
  // because one provider is quota-blocked). If it is the only provider, a distinct quota
  // terminal is surfaced. This must NOT be treated as a transient rate-limit.
  describe("hard quota stop (429 with days-out Retry-After)", () => {
    beforeEach(() => ProviderHealthRegistry.resetInstance());

    /** Rejects with the non-retryable QuotaExhaustedError fetch-with-retry throws. */
    function quotaExhaustedProvider(name: string): IAIProvider {
      const p = { ...createMockProvider(), name };
      (p.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new QuotaExhaustedError(
          name,
          279_094_000, // ~3.23 days
          `${name} usage quota exhausted (resets in ~3d): Weekly usage limit reached. Resets in 3 days.`,
        ),
      );
      return p;
    }

    it("cools the quota-blocked provider down and IMMEDIATELY tries the next provider", async () => {
      const a = quotaExhaustedProvider("opencode");
      const b = { ...createMockProvider({ text: "from-b" }), name: "openai" };
      const chain = new FallbackChainProvider([a, b]);
      const health = ProviderHealthRegistry.getInstance();
      const recordHardStop = vi.spyOn(health, "recordQuotaHardStop");

      const result = await chain.chat("sys", [], []);
      expect(result.text).toBe("from-b");
      expect(a.chat).toHaveBeenCalledTimes(1);
      expect(b.chat).toHaveBeenCalledTimes(1);
      // A was cooled down via the hard-stop path (long cooldown ≈ Retry-After), so it is
      // skipped for the rest of the session.
      expect(recordHardStop).toHaveBeenCalledWith("opencode", 279_094_000, expect.any(String));
      expect(health.isAvailable("opencode")).toBe(false);
      expect(health.isAvailable("openai")).toBe(true);
    });

    it("does NOT auto-demote the quota-blocked provider as unresponsive (it answered, with a 429)", async () => {
      const a = quotaExhaustedProvider("opencode");
      const b = { ...createMockProvider({ text: "from-b" }), name: "openai" };
      const onModelUnresponsive = vi.fn();
      const chain = new FallbackChainProvider([a, b], {
        attemptMeta: [{ provider: "opencode", model: "deepseek" }, { provider: "openai", model: "gpt" }],
        onModelUnresponsive,
      });

      await chain.chat("sys", [], []);
      expect(onModelUnresponsive).not.toHaveBeenCalled();
    });

    it("surfaces a distinct quota terminal when the quota-blocked provider is the only one", async () => {
      const a = quotaExhaustedProvider("opencode");
      const chain = new FallbackChainProvider([a]);

      // Distinct, accurate wording — NOT "rate-limited", NOT "unresponsive endpoint".
      await expect(chain.chat("sys", [], [])).rejects.toThrow(/usage quota exhausted.*no available provider/i);
    });

    it("classifies a flattened (plain-Error) quota message as a hard stop too", async () => {
      // Robustness: if a wrapper ever flattens QuotaExhaustedError to a plain Error, the
      // distinct phrase still routes it to the long cooldown + failover (not a transient).
      const a = { ...createMockProvider(), name: "opencode" };
      (a.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("OpenCode (Zen/Go) usage quota exhausted (resets in ~3d)"),
      );
      const b = { ...createMockProvider({ text: "from-b" }), name: "openai" };
      const chain = new FallbackChainProvider([a, b]);
      const health = ProviderHealthRegistry.getInstance();
      const recordHardStop = vi.spyOn(health, "recordQuotaHardStop");

      const result = await chain.chat("sys", [], []);
      expect(result.text).toBe("from-b");
      // NaN retryAfterMs (no structured field on a plain Error) → registry falls back to
      // the default long quota cooldown.
      expect(recordHardStop).toHaveBeenCalledWith("opencode", Number.NaN, expect.any(String));
      expect(health.isAvailable("opencode")).toBe(false);
    });
  });
});

describe("FallbackChainProvider mid-stream failure handling", () => {
  beforeEach(() => {
    ProviderHealthRegistry.resetInstance();
  });

  function streamingProvider(
    name: string,
    behavior: (onChunk: (c: string) => void) => Promise<ProviderResponse>,
  ): IAIProvider {
    return {
      ...createMockProvider(),
      name,
      capabilities: { ...createMockProvider().capabilities, streaming: true },
      chatStream: vi.fn(async (_sp: string, _m: ConversationMessage[], _t: ToolDefinition[], onChunk: (c: string) => void) => behavior(onChunk)),
    } as IAIProvider;
  }

  it("does NOT append the fallback's full text after a partial stream was delivered", async () => {
    // Measured 2026-08-23: provider A streamed half its answer, then died with a 500;
    // the chain fell over and B's COMPLETE answer was appended to A's truncated one —
    // the consumer read a corrupted interleaved response. The chain must instead
    // rethrow so the run-level retry re-executes the whole turn cleanly.
    const broken = streamingProvider("broken", async (onChunk) => {
      onChunk("partial ans");
      throw new Error("HTTP 500 upstream connect error");
    });
    const healthy = createMockProvider({ text: "complete answer" });
    const chain = new FallbackChainProvider([broken, healthy]);

    const chunks: string[] = [];
    await expect(chain.chatStream("sys", [], [], (c) => { chunks.push(c); }))
      .rejects.toThrow(/upstream connect error/);
    expect(chunks).toEqual(["partial ans"]);
    expect(healthy.chat).not.toHaveBeenCalled();
  });

  it("still fails over when NOTHING was delivered yet (first-response failure)", async () => {
    const silent = streamingProvider("silent", async () => {
      throw new Error("HTTP 503 temporarily unavailable");
    });
    const healthy = createMockProvider({ text: "from-fallback" });
    const chain = new FallbackChainProvider([silent, healthy]);

    const chunks: string[] = [];
    const result = await chain.chatStream("sys", [], [], (c) => { chunks.push(c); });
    expect(result.text).toBe("from-fallback");
    expect(chunks).toEqual([]);
  });

  it("records the failed provider's health before refusing to fail over", async () => {
    const broken = streamingProvider("broken", async (onChunk) => {
      onChunk("half");
      throw new Error("stream reset by peer");
    });
    const chain = new FallbackChainProvider([broken]);
    const health = ProviderHealthRegistry.getInstance();
    const recordFailure = vi.spyOn(health, "recordFailure");

    await expect(chain.chatStream("sys", [], [], () => {})).rejects.toThrow(/stream reset by peer/);
    expect(recordFailure).toHaveBeenCalledWith("broken", expect.stringContaining("stream reset"));
  });
});

// audited 2026-09-02: the recovery probe recorded EVERY probe error through the
// generic recordFailure(), so an 8h quota / credential bench that had just expired
// was replaced by a 30s-degraded → ≤10min escalating cooldown, and the dead
// provider was re-probed every cooldown expiry for the rest of the block. A probe
// failure must land on the same cooldown class a real attempt would.
describe("FallbackChainProvider — recovery probe failures keep their cooldown class", () => {
  beforeEach(() => {
    ProviderHealthRegistry.resetInstance();
  });

  function recoveringChain(probeError: Error): { chain: FallbackChainProvider; p1: IAIProvider; p2: IAIProvider } {
    const p1 = { ...createMockProvider(), name: "quota-dead" };
    (p1.chat as ReturnType<typeof vi.fn>).mockRejectedValue(probeError);
    const p2 = { ...createMockProvider({ text: "from-p2" }), name: "healthy-backup" };
    const chain = new FallbackChainProvider([p1, p2]);
    const health = ProviderHealthRegistry.getInstance();
    // The provider was benched for quota; the bench has just expired → isRecovering.
    health.recordQuotaExhausted("quota-dead", "HTTP 403: quota exceeded");
    Object.assign(health.getEntry("quota-dead")!, { cooldownUntil: Date.now() - 1000 });
    expect(health.isRecovering("quota-dead")).toBe(true);
    return { chain, p1, p2 };
  }

  it("a probe answered with 403 quota re-benches the provider for the quota cooldown (8h), not 30s", async () => {
    const { chain, p1, p2 } = recoveringChain(
      new Error("HTTP 403: quota exceeded for this billing cycle"),
    );
    const result = await chain.chat("sys", [], []);
    expect(result.text).toBe("from-p2");
    expect(p1.chat).toHaveBeenCalledTimes(1); // the probe only
    expect(p2.chat).toHaveBeenCalledTimes(1);

    const entry = ProviderHealthRegistry.getInstance().getEntry("quota-dead")!;
    expect(entry.status).toBe("down");
    expect(entry.cooldownUntil - Date.now()).toBeGreaterThan(7 * 60 * 60 * 1000);
  });

  it("a probe answered with 401 benches the provider for the session (credential class)", async () => {
    const { chain } = recoveringChain(new Error("HTTP 401: invalid_api_key"));
    await chain.chat("sys", [], []);
    const entry = ProviderHealthRegistry.getInstance().getEntry("quota-dead")!;
    expect(entry.status).toBe("down");
    expect(entry.cooldownUntil - Date.now()).toBeGreaterThan(7 * 60 * 60 * 1000);
  });

  it("a probe answered with 429 gets the overload cooldown (minutes), not the 30s degraded one", async () => {
    const { chain } = recoveringChain(new Error("rate-limited (HTTP 429)"));
    await chain.chat("sys", [], []);
    const entry = ProviderHealthRegistry.getInstance().getEntry("quota-dead")!;
    expect(entry.status).toBe("down");
    expect(entry.cooldownUntil - Date.now()).toBeGreaterThan(4 * 60 * 1000);
  });

  it("a probe that fails on a hard quota stop honors the provider's Retry-After", async () => {
    const { chain } = recoveringChain(
      new QuotaExhaustedError("quota-dead", 3 * 24 * 60 * 60 * 1000, "usage quota exhausted; resets in ~3d"),
    );
    await chain.chat("sys", [], []);
    const entry = ProviderHealthRegistry.getInstance().getEntry("quota-dead")!;
    expect(entry.status).toBe("down");
    expect(entry.cooldownUntil - Date.now()).toBeGreaterThan(2 * 24 * 60 * 60 * 1000);
  });
});
