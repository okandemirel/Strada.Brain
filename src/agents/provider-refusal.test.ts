/**
 * A refusal will refuse again.
 *
 * The non-streaming fallback exists for a streaming glitch — the socket died,
 * the stream went silent — and retrying the same provider without streaming is
 * the right answer to that. It is the wrong answer to a quota 403, which will
 * refuse the second call exactly as it refused the first.
 *
 * Measured 2026-08-21, run 31: six Kimi calls in twenty-five seconds, six 403s,
 * alternating streaming and non-streaming, with the quota exhausted before the
 * run began. Every second call asked a provider that had just said no whether
 * it still meant it, and nothing marked it down in between, so the chain kept
 * choosing it.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { Orchestrator } from "./orchestrator.js";

function refuses(error: unknown): boolean {
  const probe = Object.create(Orchestrator.prototype) as {
    isProviderRefusal(e: unknown): boolean;
  };
  return probe.isProviderRefusal(error);
}

describe("telling a refusal from a glitch", () => {
  it("treats the quota 403 that ended run 31 as a refusal", () => {
    const kimi = new Error(
      'Kimi (Moonshot) API error 403: {"error":{"message":"You\'ve reached your usage limit ' +
        'for this billing cycle. Your quota will be refreshed in the next cycle."}}',
    );

    expect(refuses(kimi)).toBe(true);
  });

  it("treats an auth failure and a rate limit the same way", () => {
    expect(refuses(new Error("API error 401: invalid api key"))).toBe(true);
    expect(refuses(new Error("API error 429: too many requests"))).toBe(true);
  });

  it("does not treat a dropped stream as a refusal", () => {
    // These are exactly what the non-streaming retry is for.
    expect(refuses(new Error("terminated"))).toBe(false);
    expect(refuses(new Error("socket hang up"))).toBe(false);
    expect(refuses(new Error("fetch failed"))).toBe(false);
    expect(refuses(new Error("Provider sent no response within 30000ms"))).toBe(false);
  });

  it("does not mistake our own vocabulary for the provider's refusal", () => {
    // These carry quota words — limit, usage, exceeded — and none of them is a
    // provider saying no. Without the refusal-wording requirement the quota
    // branch would fire on every one.
    expect(refuses(new Error("context limit reached, compacting the transcript"))).toBe(false);
    expect(refuses(new Error("token usage 41200 of 120000 for this cycle"))).toBe(false);
    expect(refuses(new Error("step limit exceeded, replanning"))).toBe(false);
  });

  it("actually consults this from the streaming path", () => {
    // The predicate above is proved; without this, routing a refusal back into
    // the non-streaming retry would waste the second call and fail nothing.
    const source = readFileSync("src/agents/orchestrator.ts", "utf8");
    const window = source.slice(source.indexOf('getLogger().error("Silent stream error"'));
    const decision = window.slice(0, window.indexOf("silentStreamFallback"));

    expect(decision, "a streaming error no longer asks whether it was a refusal")
      .toContain("this.isProviderRefusal(err)");
    // And it has to mark the provider down, or the chain keeps choosing it.
    expect(decision).toContain("recordProviderHealthFailure");
  });

  it("says nothing about a missing error", () => {
    expect(refuses(undefined)).toBe(false);
    expect(refuses(null)).toBe(false);
  });
});
