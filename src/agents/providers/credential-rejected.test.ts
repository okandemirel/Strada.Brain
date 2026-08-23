/**
 * A key the provider refused, costing one attempt instead of every attempt.
 *
 * Measured 2026-08-23 on run 55: a provider whose key had been revoked failed
 * preflight and was reported as failed — then was tried six more times during
 * the run. Each 401 was classified "non-retryable", which ended the whole chain
 * call rather than that provider's turn in it, and one of them blocked the task.
 * Nothing recorded the provider as unusable, so every call rediscovered it.
 *
 * A 401 is about this provider's credential and says nothing about the sibling
 * beside it. A 400 is about the request, and the sibling would reject it
 * identically — that distinction is the whole fix.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FallbackChainProvider } from "./fallback-chain.js";
import { ProviderHealthRegistry } from "./provider-health.js";
import type { IAIProvider } from "./provider.interface.js";

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => mockLogger,
  getLoggerSafe: () => mockLogger,
}));

const UNAUTHORIZED =
  'Kimi (Moonshot) API error 401: {"error":{"message":"The API Key appears to be invalid or may have expired."}}';

function provider(name: string, outcome: "ok" | string) {
  const chat = vi.fn(() =>
    outcome === "ok"
      ? Promise.resolve({ text: "ok", toolCalls: [] })
      : Promise.reject(new Error(outcome)),
  );
  return {
    provider: {
      name,
      capabilities: {
        maxTokens: 100, streaming: false, toolCalling: false, vision: false,
        systemPrompt: true, contextWindow: 1000,
      },
      chat,
      isAvailable: () => Promise.resolve(true),
    } as unknown as IAIProvider,
    chat,
  };
}

const ask = (chain: FallbackChainProvider) =>
  chain.chat("sys", [{ role: "user", content: "hi" }], []);

beforeEach(() => {
  vi.clearAllMocks();
  ProviderHealthRegistry.resetInstance();
});

describe("a provider whose credential was refused", () => {
  it("does not end the call — the sibling still gets its turn", async () => {
    const bad = provider("Revoked", UNAUTHORIZED);
    const good = provider("Healthy", "ok");
    const chain = new FallbackChainProvider([bad.provider, good.provider], {
      attemptTimeoutMs: 5_000,
    });

    await expect(ask(chain)).resolves.toMatchObject({ text: "ok" });
    expect(good.chat).toHaveBeenCalledTimes(1);
  });

  it("is benched, so the next call never asks it again", async () => {
    const bad = provider("Revoked", UNAUTHORIZED);
    const good = provider("Healthy", "ok");
    const chain = new FallbackChainProvider([bad.provider, good.provider], {
      attemptTimeoutMs: 5_000,
    });

    await ask(chain);
    await ask(chain);
    await ask(chain);

    // Asked once, ever. Before this it was asked on every single call.
    expect(bad.chat).toHaveBeenCalledTimes(1);
    expect(ProviderHealthRegistry.getInstance().isAvailable("Revoked")).toBe(false);
  });

  it("says what happened and which provider it was", async () => {
    const bad = provider("Revoked", UNAUTHORIZED);
    const good = provider("Healthy", "ok");
    await ask(new FallbackChainProvider([bad.provider, good.provider], { attemptTimeoutMs: 5_000 }));

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("credential rejected"),
      expect.objectContaining({ provider: "Revoked" }),
    );
  });

  it("still fails the call when it was the only provider", async () => {
    const bad = provider("Revoked", UNAUTHORIZED);
    const chain = new FallbackChainProvider([bad.provider], { attemptTimeoutMs: 5_000 });

    await expect(ask(chain)).rejects.toThrow();
  });

  it("treats a permission 403 the same way", async () => {
    const bad = provider("Revoked", "API error 403: forbidden");
    const good = provider("Healthy", "ok");
    const chain = new FallbackChainProvider([bad.provider, good.provider], {
      attemptTimeoutMs: 5_000,
    });

    await expect(ask(chain)).resolves.toMatchObject({ text: "ok" });
    expect(ProviderHealthRegistry.getInstance().isAvailable("Revoked")).toBe(false);
  });
});

describe("failures that are about the request, not the key", () => {
  it("still ends the call on a 400 — the sibling would reject it identically", async () => {
    const bad = provider("First", "API error 400: invalid_request_error — messages is required");
    const good = provider("Healthy", "ok");
    const chain = new FallbackChainProvider([bad.provider, good.provider], {
      attemptTimeoutMs: 5_000,
    });

    await expect(ask(chain)).rejects.toThrow(/400/u);
    expect(good.chat).not.toHaveBeenCalled();
  });

  it("does not bench a provider over a quota 403, which is about the clock", async () => {
    const limited = provider("Limited", "API error 403: quota exceeded for this billing period");
    const good = provider("Healthy", "ok");
    const chain = new FallbackChainProvider([limited.provider, good.provider], {
      attemptTimeoutMs: 5_000,
    });

    await expect(ask(chain)).resolves.toMatchObject({ text: "ok" });
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      expect.stringContaining("credential rejected"),
      expect.anything(),
    );
  });
});
