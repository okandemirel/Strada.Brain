/**
 * security-config#6: reviewer, loop-recovery, clarification and progress-
 * assessment calls reached the rate limiter as (input, output, provider) —
 * no model, no cache split. The limiter prices a "-free" model at $0 only when
 * it is told the model, so every such call was billed at the provider's table
 * rate and the daily budget wall refused the user's messages over money nobody
 * paid. The main-turn path (recordProviderUsage) was fixed for this on
 * 2026-09-02; the auxiliary path was left behind.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../utils/logger.js";
import { recordAuxiliaryUsage, type AccountingDeps } from "./accounting.js";
import { RateLimiter } from "../../security/rate-limiter.js";
import { runProgressAssessment } from "../../agents/autonomy/progress-assessment.js";
import {
  resolveLoopRecoveryReview,
  type InterventionDeps,
} from "../../agents/orchestrator-intervention-pipeline.js";

beforeAll(() => {
  try { createLogger("error", join(tmpdir(), "strada-auxiliary-usage-test.log")); } catch { /* already */ }
});

function depsWith(rateLimiter: RateLimiter): AccountingDeps {
  return { rateLimiter, metrics: { recordTokenUsage: vi.fn() } } as unknown as AccountingDeps;
}

const MILLION = { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 };

describe("recordAuxiliaryUsage prices the model that ran", () => {
  it("a -free reviewer costs nothing and does not trip the dollar budget", () => {
    const rateLimiter = new RateLimiter({ dailyBudgetUsd: 1 });
    for (let k = 0; k < 3; k += 1) {
      recordAuxiliaryUsage(depsWith(rateLimiter), "opencode", MILLION, undefined, "grok-code-free");
    }
    expect(rateLimiter.getSnapshot().tokensToday).toBe(6_000_000);
    expect(rateLimiter.getSnapshot().costToday).toBe(0);
    expect(rateLimiter.checkMessageRate("user-1").allowed).toBe(true);
  });

  it("still bills a paid model", () => {
    const rateLimiter = new RateLimiter();
    recordAuxiliaryUsage(depsWith(rateLimiter), "opencode", MILLION, undefined, "some-paid-model");
    expect(rateLimiter.getSnapshot().costToday).toBeGreaterThan(0);
  });

  it("prices the cached share of the prompt as cached, like a model turn", () => {
    const uncached = new RateLimiter();
    const cached = new RateLimiter();
    recordAuxiliaryUsage(depsWith(uncached), "claude", { ...MILLION, outputTokens: 0, totalTokens: 1_000_000 });
    recordAuxiliaryUsage(depsWith(cached), "claude", {
      ...MILLION,
      outputTokens: 0,
      totalTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    });
    expect(cached.getSnapshot().costToday).toBeLessThan(uncached.getSnapshot().costToday);
  });

  it("hands the sink the model and the cache split", () => {
    const sink = vi.fn();
    recordAuxiliaryUsage(
      depsWith(new RateLimiter()),
      "opencode",
      { ...MILLION, cacheReadInputTokens: 10 },
      sink,
      "grok-code-free",
    );
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "opencode", model: "grok-code-free", cacheReadInputTokens: 10 }),
    );
  });
});

describe("the auxiliary callers say which model answered", () => {
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

  it("progress assessment bills the reviewer's model", async () => {
    const record = vi.fn();
    await runProgressAssessment(
      { promptTargets: [] } as never,
      {
        provider: { chat: vi.fn(async () => ({ text: "{}", usage })) },
        providerName: "opencode",
        modelId: "grok-code-free",
      },
      { recordAuxiliaryUsage: record },
    );
    expect(record).toHaveBeenCalledWith("opencode", usage, undefined, "grok-code-free");
  });

  it("loop-recovery review bills the chain member that served, not the one assigned", async () => {
    const record = vi.fn();
    const reviewer = {
      providerName: "opencode",
      modelId: "grok-code-free",
      provider: {
        chat: vi.fn(async () => ({
          text: "{}",
          usage,
          servedBy: { provider: "claude", model: "claude-sonnet-5" },
        })),
      },
    };
    await resolveLoopRecoveryReview(
      {
        chatId: "c",
        identityKey: "i",
        brief: {
          fingerprint: "loop",
          recoveryEpisode: 1,
          requiredActions: [],
          recentToolSummaries: [],
          touchedFiles: [],
          recentUserFacingProgress: [],
          availableDelegations: [],
        } as never,
        strategy: { reviewer } as never,
      },
      { recordAuxiliaryUsage: record } as unknown as InterventionDeps,
    );
    expect(record).toHaveBeenCalledWith("claude", usage, undefined, "claude-sonnet-5");
  });
});
