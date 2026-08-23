/**
 * A first-response budget that belongs to the provider, not the chain.
 *
 * The chain's 90s budget catches an endpoint that has stopped answering, and it
 * is the right shape: the first chunk disarms it permanently, so it costs
 * nothing once an answer starts. It is the wrong size for a queued free tier,
 * where the silence is the queue and not a fault. Measured 2026-08-23 against
 * opencode.ai/zen/go with ox-alpha-free, five identical three-word requests
 * returned their first byte at 4.1s, 11.9s, 26.3s, 64s and 70s — and two runs
 * died at 90s on requests carrying far more prefill than three words.
 *
 * One chain-wide number cannot serve that endpoint and a two-second one at the
 * same time, so the provider declares its own and the chain honours it.
 */

import { describe, expect, it, vi } from "vitest";
import { FallbackChainProvider } from "./fallback-chain.js";
import type { IAIProvider } from "./provider.interface.js";

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => mockLogger,
  getLoggerSafe: () => mockLogger,
}));

/** A provider that never answers, so only the budget decides when it fails. */
const silentProvider = (firstResponseTimeoutMs?: number): IAIProvider =>
  ({
    name: "Silent",
    capabilities: {
      maxTokens: 100,
      streaming: false,
      toolCalling: false,
      vision: false,
      systemPrompt: true,
      contextWindow: 1000,
      ...(firstResponseTimeoutMs === undefined ? {} : { firstResponseTimeoutMs }),
    },
    chat: () => new Promise(() => {}),
    isAvailable: () => Promise.resolve(true),
  }) as unknown as IAIProvider;

const budgetFor = (chain: FallbackChainProvider, provider: IAIProvider): number =>
  (chain as unknown as { firstResponseBudgetFor: (p: IAIProvider) => number })
    .firstResponseBudgetFor(provider);

const chainWith = (attemptTimeoutMs: number) =>
  new FallbackChainProvider([silentProvider()], { attemptTimeoutMs });

describe("whose budget applies", () => {
  it("uses the chain's when the provider declares none", () => {
    expect(budgetFor(chainWith(90_000), silentProvider())).toBe(90_000);
  });

  it("uses the provider's when it declares one", () => {
    expect(budgetFor(chainWith(90_000), silentProvider(300_000))).toBe(300_000);
  });

  it("lets a provider ask for LESS, not only more", () => {
    // The point is that the chain's number is wrong for this endpoint — which
    // is a claim that can point either way.
    expect(budgetFor(chainWith(90_000), silentProvider(5_000))).toBe(5_000);
  });
});

describe("a declaration that cannot be honoured", () => {
  it("falls back to the chain rather than disabling the protection", () => {
    for (const nonsense of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(budgetFor(chainWith(90_000), silentProvider(nonsense))).toBe(90_000);
    }
  });

  it("survives a provider with no capabilities at all", () => {
    const bare = { name: "Bare" } as unknown as IAIProvider;

    expect(budgetFor(chainWith(90_000), bare)).toBe(90_000);
  });
});

describe("the budget the error message quotes", () => {
  it("is the provider's, so the number reported is the one that ran out", async () => {
    vi.useFakeTimers();
    try {
      const provider = silentProvider(300_000);
      const chain = new FallbackChainProvider([provider], { attemptTimeoutMs: 90_000 });

      const call = chain.chat("sys", [{ role: "user", content: "hi" }], []);
      const settled = call.then(
        () => "resolved",
        (e: Error) => e.message,
      );

      // Past the chain's budget: a provider-declared budget must still be running.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");

      await vi.advanceTimersByTimeAsync(200_000);
      expect(await settled).toContain("300000ms");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The provider that needed this. Measured numbers are in the source comment;
 * what matters here is that the declaration exists, is longer than the chain's
 * 90s, and can be traded back for faster failover without a code change.
 */
describe("what OpenCode declares", () => {
  const load = async (override?: string) => {
    vi.resetModules();
    const previous = process.env["OPENCODE_FIRST_RESPONSE_TIMEOUT_MS"];
    if (override === undefined) delete process.env["OPENCODE_FIRST_RESPONSE_TIMEOUT_MS"];
    else process.env["OPENCODE_FIRST_RESPONSE_TIMEOUT_MS"] = override;
    const { OpencodeProvider } = await import("./opencode.js");
    const value = new OpencodeProvider("key").capabilities.firstResponseTimeoutMs;
    if (previous === undefined) delete process.env["OPENCODE_FIRST_RESPONSE_TIMEOUT_MS"];
    else process.env["OPENCODE_FIRST_RESPONSE_TIMEOUT_MS"] = previous;
    return value;
  };

  it("asks for more than the chain's 90s, because its queue exceeds it", async () => {
    const declared = await load();

    expect(declared).toBeGreaterThan(90_000);
  });

  it("can be traded back for faster failover", async () => {
    expect(await load("20000")).toBe(20_000);
  });

  it("keeps the measured default when the override is nonsense", async () => {
    // An env typo must not silently disable the protection or shrink it to zero.
    for (const bad of ["", "   ", "abc", "0", "-5"]) {
      expect(await load(bad)).toBe(await load());
    }
  });
});
