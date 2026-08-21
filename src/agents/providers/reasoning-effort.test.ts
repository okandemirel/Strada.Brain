/**
 * Asking a reasoning model to think less, where thinking longer only costs time.
 *
 * Measured 2026-08-21 against opencode.ai/zen/go with deepseek-v4-flash on the
 * real goal-decomposition prompt:
 *
 *   default   1595 reasoning chunks -> 2093 chars of answer
 *   low        876                  -> 1285
 *   minimal    497                  -> 1623
 *
 * All three finished with `stop`. More thinking did not buy more answer; it
 * bought latency, and latency is what a streaming stall timeout measures — the
 * thing that killed run 29 sixty seconds after it started.
 */

import { describe, expect, it } from "vitest";

import { OpenAIProvider } from "./openai.js";
import { OpencodeProvider } from "./opencode.js";

function bodyOf(provider: OpenAIProvider): Record<string, unknown> {
  return (provider as unknown as {
    buildRequestBody(m: unknown[], t: unknown): Record<string, unknown>;
  }).buildRequestBody([], undefined);
}

describe("reasoning_effort on the request", () => {
  it("is sent when the provider declares it", () => {
    const body = bodyOf(new OpencodeProvider("k"));

    expect(body["reasoning_effort"]).toBe("low");
  });

  it("is absent when the provider does not — an unknown key is a 400 elsewhere", () => {
    const plain = new OpenAIProvider("k");

    expect(bodyOf(plain)["reasoning_effort"]).toBeUndefined();
  });

  it("can be overridden for a workload that wants the deliberation", () => {
    const previous = process.env["OPENCODE_REASONING_EFFORT"];
    process.env["OPENCODE_REASONING_EFFORT"] = "high";
    try {
      expect(bodyOf(new OpencodeProvider("k"))["reasoning_effort"]).toBe("high");
    } finally {
      if (previous === undefined) delete process.env["OPENCODE_REASONING_EFFORT"];
      else process.env["OPENCODE_REASONING_EFFORT"] = previous;
    }
  });
});
