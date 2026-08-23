/**
 * A chain of one that blinked is not a chain that failed.
 *
 * Falling over is the right answer to a provider going silent — when there is
 * somewhere to fall to. With one live provider there is nowhere, and the call
 * simply dies under a message ("All providers failed") that describes an outage
 * that did not happen.
 *
 * Measured 2026-08-23 on run 52: the only live provider stayed silent past its
 * whole 300s budget once, while direct requests to the same endpoint minutes
 * either side returned their first byte in 2.7s, 7.9s and 16s. The condition was
 * a queue spike that had already passed by the time the task was told it was
 * fatal. This is the same shape as the empty-response retry next to it, aimed at
 * silence instead of at an empty answer.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { FallbackChainProvider } from "./fallback-chain.js";
import { ProviderHealthRegistry } from "./provider-health.js";
import type { IAIProvider } from "./provider.interface.js";

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => mockLogger,
  getLoggerSafe: () => mockLogger,
}));

const answer = { text: "ok", toolCalls: [] };

/** A provider whose chat() outcomes are scripted, one per call. */
function scripted(name: string, outcomes: Array<"stall" | "ok" | "429" | "boom">) {
  let call = 0;
  const provider = {
    name,
    capabilities: {
      maxTokens: 100, streaming: false, toolCalling: false, vision: false,
      systemPrompt: true, contextWindow: 1000,
    },
    chat: vi.fn(() => {
      const outcome = outcomes[Math.min(call, outcomes.length - 1)];
      call += 1;
      if (outcome === "ok") return Promise.resolve({ ...answer });
      // A real stall is not an error the provider throws — it is the provider
      // never answering, and the CHAIN's own budget timer turning that silence
      // into a FirstResponseTimeoutError. Rejecting here would test a code path
      // that cannot occur.
      if (outcome === "stall") return new Promise(() => {});
      if (outcome === "429") return Promise.reject(new Error(`Provider "${name}" rate-limited (HTTP 429)`));
      return Promise.reject(new Error("upstream exploded"));
    }),
    isAvailable: () => Promise.resolve(true),
  } as unknown as IAIProvider;
  return { provider, calls: () => call };
}

const chat = (chain: FallbackChainProvider) =>
  chain.chat("sys", [{ role: "user", content: "hi" }], []);

beforeEach(() => {
  vi.clearAllMocks();
  ProviderHealthRegistry.resetInstance();
});

describe("the only live provider goes silent", () => {
  it("is asked once more, and the answer stands", async () => {
    const only = scripted("Only", ["stall", "ok"]);
    const chain = new FallbackChainProvider([only.provider], { attemptTimeoutMs: 1_000 });

    await expect(chat(chain)).resolves.toMatchObject({ text: "ok" });
    expect(only.calls()).toBe(2);
  });

  it("gives up when it is silent twice — that is not a blink", async () => {
    const only = scripted("Only", ["stall", "stall"]);
    const chain = new FallbackChainProvider([only.provider], { attemptTimeoutMs: 1_000 });

    await expect(chat(chain)).rejects.toThrow(/no response within/u);
    expect(only.calls()).toBe(2);
  });

  it("says so, rather than retrying silently", async () => {
    const only = scripted("Only", ["stall", "ok"]);
    await chat(new FallbackChainProvider([only.provider], { attemptTimeoutMs: 1_000 }));

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("only live provider went silent"),
      expect.objectContaining({ provider: "Only" }),
    );
  });
});

describe("when there is somewhere to fall to", () => {
  it("falls over instead of asking the same silent provider again", async () => {
    const first = scripted("First", ["stall"]);
    const second = scripted("Second", ["ok"]);
    const chain = new FallbackChainProvider([first.provider, second.provider], {
      attemptTimeoutMs: 1_000,
    });

    await expect(chat(chain)).resolves.toMatchObject({ text: "ok" });
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(1);
  });

  it("still retries the LAST provider, which has nowhere left to fall to", async () => {
    const first = scripted("First", ["boom"]);
    const last = scripted("Last", ["stall", "ok"]);
    const chain = new FallbackChainProvider([first.provider, last.provider], {
      attemptTimeoutMs: 1_000,
    });

    await expect(chat(chain)).resolves.toMatchObject({ text: "ok" });
    expect(last.calls()).toBe(2);
  });
});

describe("failures that are not silence", () => {
  it("does not re-ask a provider that answered with a 429", async () => {
    const only = scripted("Only", ["429", "ok"]);
    const chain = new FallbackChainProvider([only.provider], { attemptTimeoutMs: 1_000 });

    await expect(chat(chain)).rejects.toThrow();
    expect(only.calls()).toBe(1);
  });

  it("does not re-ask a provider that threw outright", async () => {
    const only = scripted("Only", ["boom", "ok"]);
    const chain = new FallbackChainProvider([only.provider], { attemptTimeoutMs: 1_000 });

    await expect(chat(chain)).rejects.toThrow();
    expect(only.calls()).toBe(1);
  });

  it("does not re-ask a call the caller cancelled mid-stall", async () => {
    // The cancel arrives while the provider is silent, which is exactly when
    // the retry would otherwise fire. A user pressing stop must not buy the
    // task another full budget.
    const only = scripted("Only", ["stall", "ok"]);
    const chain = new FallbackChainProvider([only.provider], { attemptTimeoutMs: 2_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);

    await expect(
      chain.chat("sys", [{ role: "user", content: "hi" }], [], { externalSignal: controller.signal }),
    ).rejects.toThrow();
    expect(only.calls()).toBe(1);
    // And it is not RECORDED as a provider going silent. The sleep would refuse
    // the retry on its own, but only after this line had already blamed the
    // endpoint for a silence the user caused — and provider health is judged
    // from these.
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("only live provider went silent"),
      expect.anything(),
    );
  });
});
