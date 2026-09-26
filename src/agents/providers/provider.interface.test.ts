/**
 * streamOrChatText is the one-shot call behind goal decomposition, campaign planning,
 * style analysis, supervisor verification, review and synthesis. STREAMING_ENABLED=false
 * reached only the orchestrator's model turns, so these kept opening provider streams.
 */
import { describe, expect, it, vi } from "vitest";
import { streamOrChatText, type IStreamingProvider, type ProviderResponse } from "./provider.interface.js";

function streamingProvider(): IStreamingProvider {
  const response: ProviderResponse = {
    text: "answer",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
  return {
    name: "stub",
    capabilities: {
      maxTokens: 4096,
      streaming: true,
      structuredStreaming: false,
      toolCalling: false,
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn().mockResolvedValue(response),
    chatStream: vi.fn().mockResolvedValue(response),
  };
}

describe("streamOrChatText and STREAMING_ENABLED", () => {
  it("streams when the provider can and nothing turned streaming off", async () => {
    const provider = streamingProvider();
    await streamOrChatText(provider, "sys", "hi");
    await streamOrChatText(provider, "sys", "hi", undefined, { streaming: true });
    expect(provider.chatStream).toHaveBeenCalledTimes(2);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("calls chat(), never chatStream(), when streaming is off — with the caller's options", async () => {
    const provider = streamingProvider();
    const signal = new AbortController().signal;
    const response = await streamOrChatText(provider, "sys", "hi", { maxTokens: 123, signal }, { streaming: false });
    expect(response.text).toBe("answer");
    expect(provider.chatStream).not.toHaveBeenCalled();
    expect(provider.chat).toHaveBeenCalledWith("sys", [{ role: "user", content: "hi" }], [], { maxTokens: 123, signal });
  });
});
