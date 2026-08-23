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
import { ProviderHealthRegistry } from "./provider-health.js";

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

      // Two budgets plus the pause between them: a lone provider that goes
      // silent is asked once more before the chain gives up, so the failure
      // arrives after 300s + 2s + 300s, not after the first 300s.
      await vi.advanceTimersByTimeAsync(700_000);
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


/**
 * The probe that is the only way out of cooldown.
 *
 * It was a flat 15s. Measured 2026-08-23 on run 54: OpenCode's queue returns
 * first bytes between 2.7s and 70s, it declares 300s for that reason, and the
 * probe timed out at 15s. Every provider went to cooldown, the probe could never
 * clear it, and the task died with "All providers are in cooldown. Try again
 * later." — a state nothing could leave.
 */
describe("the recovery probe's budget", () => {
  const probeBudget = (chain: FallbackChainProvider, provider: IAIProvider): number =>
    (chain as unknown as { probeBudgetFor: (p: IAIProvider) => number })
      .probeBudgetFor(provider);

  it("believes what the provider said it needs", () => {
    const chain = new FallbackChainProvider([silentProvider()], { attemptTimeoutMs: 90_000 });

    expect(probeBudget(chain, silentProvider(300_000))).toBe(300_000);
  });

  it("is never stricter than the call it gates", () => {
    // A probe that gives less time than the request would get calls a slow
    // provider dead, and there is no other route back.
    const chain = new FallbackChainProvider([silentProvider()], { attemptTimeoutMs: 90_000 });
    const declared = 300_000;

    expect(probeBudget(chain, silentProvider(declared))).toBeGreaterThanOrEqual(declared);
  });

  it("keeps the historical 15s for a provider that declared nothing", () => {
    const chain = new FallbackChainProvider([silentProvider()], { attemptTimeoutMs: 90_000 });

    expect(probeBudget(chain, silentProvider())).toBe(15_000);
  });

  it("falls back rather than trusting a nonsense declaration", () => {
    const chain = new FallbackChainProvider([silentProvider()], { attemptTimeoutMs: 90_000 });

    for (const nonsense of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(probeBudget(chain, silentProvider(nonsense))).toBe(15_000);
    }
  });
});


/**
 * The probe budget, exercised where it is actually used.
 *
 * The tests above check the number; this checks that the number reaches the
 * AbortSignal. Reverting the call site to its hardcoded 15s left every one of
 * them green — a correct helper that nothing called.
 */
describe("the probe as it actually runs", () => {
  /**
   * Real timers, small numbers.
   *
   * The first attempt at this test used fake timers, and vitest's fake timers do
   * not drive AbortSignal.timeout — so it passed with the budget wired in AND
   * with the hardcoded 15s put back. A test that cannot fail is not evidence.
   * Timing the rejection is crude but it does fail: at 15s the call cannot come
   * back inside this test's deadline.
   */
  const neverAnswers = (declared?: number) =>
    ({
      name: "Slow",
      capabilities: {
        maxTokens: 100, streaming: false, toolCalling: false, vision: false,
        systemPrompt: true, contextWindow: 1000,
        ...(declared === undefined ? {} : { firstResponseTimeoutMs: declared }),
      },
      // Honours the abort, as a real provider does. A mock that ignores it hangs
      // whatever the deadline is, and the deadline is the thing under test.
      chat: vi.fn((_s: string, _m: unknown, _t: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted due to timeout")),
          );
        }),
      ),
      isAvailable: () => Promise.resolve(true),
    }) as unknown as IAIProvider;

  /**
   * Unhealthy AND past its cooldown — both halves are required, and only that
   * combination makes the chain probe rather than skip.
   *
   * The cooldown is minutes long and there is no public way to shorten it, so
   * the entry is expired directly. Without this the loop skips the provider as
   * unavailable, no probe runs at all, and a test aimed at the probe measures
   * nothing — which is how the first version of this passed with the hardcoded
   * timeout restored.
   */
  const stageRecovering = (name: string) => {
    ProviderHealthRegistry.resetInstance();
    const health = ProviderHealthRegistry.getInstance();
    // Enough failures to leave "healthy": one is tolerated, and a tolerated
    // failure is not a provider in recovery.
    for (let i = 0; i < 5; i += 1) health.recordFailure(name, "earlier outage");
    const entries = (health as unknown as {
      entries: Map<string, { cooldownUntil: number }>;
    }).entries;
    for (const entry of entries.values()) entry.cooldownUntil = Date.now() - 1;
    expect(health.isRecovering(name)).toBe(true);
  };

  it("aborts the probe on the provider's own deadline, not a hardcoded one", async () => {
    stageRecovering("Slow");
    const chain = new FallbackChainProvider([neverAnswers(200)], { attemptTimeoutMs: 600_000 });

    const startedAt = Date.now();
    await expect(chain.chat("sys", [{ role: "user", content: "hi" }], [])).rejects.toThrow();

    // Under the old hardcoded 15s this cannot return in time at all.
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    ProviderHealthRegistry.resetInstance();
  }, 5_000);
});
