import { describe, expect, it } from "vitest";
import {
  buildProviderIntelligence,
  formatContextWindow,
  getProviderIntelligenceSnapshot,
  getRecommendedMaxMessages,
  type ModelIntelligenceLookup,
} from "./provider-knowledge.js";

const mockModelIntelligence: ModelIntelligenceLookup = {
  getModelInfo(modelId: string) {
    if (modelId === "gemini-3-flash-preview") {
      return {
        contextWindow: 1_000_000,
        inputPricePerMillion: 0.5,
        outputPricePerMillion: 3,
        supportsVision: true,
        supportsThinking: false,
        supportsToolCalling: true,
        supportsStreaming: true,
      };
    }

    if (modelId === "local-mini") {
      return {
        contextWindow: 8_000,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        supportsVision: false,
        supportsThinking: false,
        supportsToolCalling: true,
        supportsStreaming: true,
      };
    }

    return undefined;
  },
};

describe("formatContextWindow", () => {
  it("formats token counts in K notation", () => {
    expect(formatContextWindow(1_000_000)).toBe("1000K");
    expect(formatContextWindow(128_000)).toBe("128K");
  });
});

describe("getProviderIntelligenceSnapshot", () => {
  it("derives feature tags from provider capabilities and live model intelligence", () => {
    const snapshot = getProviderIntelligenceSnapshot(
      "gemini",
      "gemini-3-flash-preview",
      mockModelIntelligence,
      {
        contextWindow: 1_000_000,
        vision: true,
        thinkingSupported: true,
        toolCalling: true,
        streaming: true,
        specialFeatures: ["grounding", "thinking_level", "code_execution"],
      },
      "Google Gemini",
    );

    expect(snapshot.providerLabel).toBe("Google Gemini");
    expect(snapshot.featureTags).toContain("grounding");
    expect(snapshot.featureTags).toContain("thinking-level");
    expect(snapshot.featureTags).toContain("code-execution");
    expect(snapshot.featureTags).toContain("multimodal");
    expect(snapshot.featureTags).toContain("tool-calling");
    expect(snapshot.maxMessages).toBe(80);
  });

  it("builds generic strengths, limitations, and hints without provider-specific tables", () => {
    const snapshot = getProviderIntelligenceSnapshot(
      "ollama",
      "local-mini",
      mockModelIntelligence,
      {
        contextWindow: 8_000,
        vision: false,
        thinkingSupported: false,
        toolCalling: true,
        streaming: true,
        specialFeatures: ["local_inference", "privacy"],
      },
      "Ollama",
    );

    expect(snapshot.strengths).toContain("Local/offline execution");
    expect(snapshot.limitations).toContain("Smaller context window");
    expect(snapshot.behavioralHints).toContain("Prefer concise prompts to stay within local model budgets");
    expect(snapshot.maxMessages).toBe(20);
  });

  it("derives workload scores from generic capabilities", () => {
    const snapshot = getProviderIntelligenceSnapshot(
      "kimi",
      "kimi-for-coding",
      undefined,
      {
        contextWindow: 262_000,
        thinkingSupported: true,
        toolCalling: true,
        streaming: true,
        specialFeatures: ["coding", "reasoning"],
      },
      "Kimi",
    );

    expect(snapshot.workloadScores.implementation).toBeGreaterThan(snapshot.workloadScores.documentation);
    expect(snapshot.workloadScores.debugging).toBeGreaterThan(0.7);
  });
});

describe("buildProviderIntelligence", () => {
  it("renders a provider intelligence block from runtime snapshots", () => {
    const result = buildProviderIntelligence(
      "gemini",
      "gemini-3-flash-preview",
      mockModelIntelligence,
      {
        contextWindow: 1_000_000,
        vision: true,
        toolCalling: true,
        streaming: true,
        specialFeatures: ["grounding"],
      },
      "Google Gemini",
    );

    expect(result).toContain("## Current Provider Intelligence");
    expect(result).toContain("Provider: Google Gemini");
    expect(result).toContain("Model: gemini-3-flash-preview");
    expect(result).toContain("grounding");
  });
});

describe("getRecommendedMaxMessages", () => {
  it("uses live context windows when available", () => {
    expect(getRecommendedMaxMessages(
      "gemini",
      "gemini-3-flash-preview",
      mockModelIntelligence,
      { contextWindow: 1_000_000, toolCalling: true, streaming: true },
      "Google Gemini",
    )).toBe(80);

    expect(getRecommendedMaxMessages(
      "ollama",
      "local-mini",
      mockModelIntelligence,
      { contextWindow: 8_000, toolCalling: true, streaming: true },
      "Ollama",
    )).toBe(20);
  });

  it("falls back to balanced defaults without external metadata", () => {
    expect(getRecommendedMaxMessages("unknown-provider")).toBe(40);
  });
});
