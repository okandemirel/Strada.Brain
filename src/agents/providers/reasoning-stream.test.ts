/**
 * A model that is thinking is not a provider that is dead.
 *
 * Measured 2026-08-21: deepseek-v4-flash on OpenCode streamed 691
 * reasoning_content deltas and no content. The base provider read only
 * `content`, so the stream looked silent; the provider was declared to have
 * "returned an empty response"; the chain failed over to one that was out of
 * quota; and the task blocked sixty seconds after the run started. The model
 * was working the whole time, and with a large enough token budget it returned
 * 2293 characters of valid JSON.
 */

import { describe, expect, it } from "vitest";

import { OpenAIProvider } from "./openai.js";

function extract(delta: unknown): string | undefined {
  const provider = Object.create(OpenAIProvider.prototype) as {
    extractStreamReasoning(d: Record<string, unknown> | undefined): string | undefined;
  };
  return provider.extractStreamReasoning(delta as Record<string, unknown>);
}

describe("reasoning deltas on an OpenAI-compatible stream", () => {
  it("reads reasoning_content, which DeepSeek and Kimi both send", () => {
    expect(extract({ reasoning_content: "We need answer JSON" })).toBe("We need answer JSON");
  });

  it("reads the shorter `reasoning` spelling too", () => {
    expect(extract({ reasoning: "thinking" })).toBe("thinking");
  });

  it("treats an empty string as no reasoning, not as reasoning", () => {
    // The first delta of this stream carries content:"" and reasoning_content:null.
    expect(extract({ content: "", reasoning_content: "" })).toBeUndefined();
    expect(extract({ content: "", reasoning_content: null })).toBeUndefined();
  });

  it("says nothing about a delta that carries only content", () => {
    expect(extract({ content: '{"nodes":[]}' })).toBeUndefined();
  });

  it("survives a chunk with no delta at all", () => {
    expect(extract(undefined)).toBeUndefined();
  });
});
