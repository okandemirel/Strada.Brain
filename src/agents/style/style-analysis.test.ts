import { describe, it, expect, vi } from "vitest";
import type { IAIProvider, ProviderResponse } from "../providers/provider.interface.js";
import { StyleAnalysis } from "./style-analysis.js";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function providerReplying(text: string): IAIProvider {
  const response: ProviderResponse = {
    text,
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
  return {
    name: "stub",
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: false,
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn().mockResolvedValue(response),
  };
}

const PROFILE = (family: string, shading: string) => JSON.stringify({
  family,
  pipeline: family === "pixel" ? "sprite-native" : "realtime-3d",
  palette: ["#334455"],
  shading,
});

// A GDD that names no family keyword, so the keyword fallback cannot land on
// either answer by accident.
const GDD = "A quiet game about tending a lighthouse. The art should feel grounded.";

describe("StyleAnalysis reads the answer, not the reasoning before it (PRV-22)", () => {
  it("ignores a draft object inside a closed <reasoning> block", async () => {
    const reply = `<reasoning>First draft: ${PROFILE("pixel", "flat")} — no, the doc says grounded.</reasoning>\n${PROFILE("realistic", "pbr-realistic")}`;
    const { profile, source } = await new StyleAnalysis(providerReplying(reply)).analyze(GDD);
    expect(source).toBe("llm");
    expect(profile.family).toBe("realistic");
    expect(profile.shading).toBe("pbr-realistic");
  });

  it("does not take an object from a reply that never left its reasoning block", async () => {
    const reply = `<reasoning>Maybe ${PROFILE("pixel", "flat")} fits, let me check the palette`;
    const { source } = await new StyleAnalysis(providerReplying(reply)).analyze(GDD);
    expect(source).toBe("keyword-fallback");
  });

  // STREAMING_ENABLED=false governs every provider call, style analysis included.
  it("with STREAMING_ENABLED=false analyzes through chat(), never chatStream()", async () => {
    const provider = {
      ...providerReplying(PROFILE("realistic", "pbr-realistic")),
      capabilities: { ...providerReplying("").capabilities, streaming: true },
      chatStream: vi.fn(async () => {
        throw new Error("chatStream() must not be called with streaming disabled");
      }),
    };
    const { source } = await new StyleAnalysis(provider, { streamingEnabled: false }).analyze(GDD);
    expect(source).toBe("llm");
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(provider.chatStream).not.toHaveBeenCalled();
  });
});
