import { describe, it, expect, vi, beforeEach } from "vitest";

const loggerSpies = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock("../../utils/logger.js", () => ({ getLoggerSafe: () => loggerSpies, getLogger: () => loggerSpies }));

import { logProviderCall, describeThrown, medianTurnMs, noteTurnDuration, resetTurnPace } from "./provider-call-log.js";

describe("logProviderCall", () => {
  beforeEach(() => loggerSpies.info.mockClear());

  // Measured 2026-09-07 20:47: 24 tool calls in a sprint, one "Provider call"
  // line — the agent loop calls a pinned member directly, past the chain.
  it("writes one 'Provider call' line with who answered, how long, and what it cost", () => {
    logProviderCall("turn", { name: "chain" }, Date.now() - 1500, {
      response: {
        text: "x",
        toolCalls: [{ id: "1", name: "file_read", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 11000, outputTokens: 300 },
        servedBy: { provider: "OpenCode (Zen/Go)", model: "nemotron-3.5-lightning-free" },
      } as never,
    }, { chatId: "cli-local" });
    const [message, fields] = loggerSpies.info.mock.calls[0]!;
    expect(message).toBe("Provider call");
    expect(fields).toMatchObject({ label: "turn", provider: "OpenCode (Zen/Go)", model: "nemotron-3.5-lightning-free", inputTokens: 11000, outputTokens: 300, stopReason: "tool_use", toolCalls: 1, chatId: "cli-local" });
    expect((fields as { ms: number }).ms).toBeGreaterThanOrEqual(1500);
  });

  it("writes 'Provider call failed' with the error when the call threw", () => {
    logProviderCall("turn", { name: "opencode" }, Date.now(), { error: new Error("sent no response within 300000ms") });
    const [message, fields] = loggerSpies.info.mock.calls[0]!;
    expect(message).toBe("Provider call failed");
    expect(fields).toMatchObject({ label: "turn", provider: "opencode", error: "sent no response within 300000ms" });
  });
});

describe("toolDefinitionChars", () => {
  it("is the serialized size of the tool schemas the request carries, 0 when there are none", async () => {
    const { toolDefinitionChars } = await import("./provider-call-log.js");
    expect(toolDefinitionChars(undefined)).toBe(0);
    expect(toolDefinitionChars([])).toBe(0);
    const tools = [{ name: "a", description: "x", parameters: { type: "object" } }];
    expect(toolDefinitionChars(tools)).toBe(JSON.stringify(tools).length);
  });

  // Measured 2026-09-08 14:45:56: two 17-minute calls ended with
  // error:"[object Object]" — the cancel token's reason object, stringified.
  it("names a thrown cancel-reason object instead of printing [object Object]", () => {
    logProviderCall("turn", { name: "opencode" }, Date.now(), { error: { kind: "hard-timeout", scope: "call" } });
    const [message, fields] = loggerSpies.info.mock.calls[0]!;
    expect(message).toBe("Provider call failed");
    expect((fields as { error: string }).error).toBe('{"kind":"hard-timeout","scope":"call"}');
    expect(describeThrown(new Error("boom"))).toBe("boom");
    expect(describeThrown("plain")).toBe("plain");
    expect(describeThrown(undefined)).toBe("undefined");
  });

  it("keeps a median of recent answered TURN durations for the node budget (failures and other labels do not count)", () => {
    resetTurnPace();
    expect(medianTurnMs()).toBeUndefined();
    const ok = { text: "x", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } as never;
    logProviderCall("turn", { name: "p" }, Date.now() - 100_000, { response: ok });
    logProviderCall("turn", { name: "p" }, Date.now() - 160_000, { response: ok });
    logProviderCall("turn", { name: "p" }, Date.now() - 200_000, { response: ok });
    logProviderCall("streaming", { name: "p" }, Date.now() - 900_000, { response: ok });
    logProviderCall("turn", { name: "p" }, Date.now() - 900_000, { error: new Error("boom") });
    const median = medianTurnMs()!;
    expect(median).toBeGreaterThanOrEqual(160_000);
    expect(median).toBeLessThan(165_000);
    for (let i = 0; i < 25; i++) noteTurnDuration(1_000);
    expect(medianTurnMs()).toBe(1_000); // rolling window forgets the old pace
    resetTurnPace();
  });
});
