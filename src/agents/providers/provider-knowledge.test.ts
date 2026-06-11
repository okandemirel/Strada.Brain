import { describe, expect, it } from "vitest";
import {
  buildProviderIntelligence,
  formatContextWindow,
  getProviderIntelligenceSnapshot,
  getRecommendedMaxMessages,
  type ModelIntelligenceLookup,
  type ProviderWorkload,
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

describe("workload score characterization", () => {
  // One fixed capability snapshot shared by every provider so that the
  // feature-flag component is identical across rows — any per-provider
  // difference comes purely from the behavioral baseline profile.
  const FIXED_CAPS = {
    contextWindow: 200_000,
    supportsVision: true,
    supportsThinking: true,
    supportsToolCalling: true,
    supportsStreaming: true,
    specialFeatures: [] as string[],
  };

  const ALL_WORKLOADS: readonly ProviderWorkload[] = [
    "planning",
    "implementation",
    "review",
    "analysis",
    "debugging",
    "documentation",
    "coordination",
  ];

  function scoresFor(providerName: string): Record<ProviderWorkload, number> {
    return getProviderIntelligenceSnapshot(providerName, undefined, undefined, FIXED_CAPS, providerName)
      .workloadScores;
  }

  // Captured by running the current code (blend: 0.4*featureFlag + 0.6*behavioral
  // for known providers; documentation has no behavioral mapping so it stays
  // pure feature-flag for everyone).
  const EXPECTED_KNOWN: Record<string, Record<ProviderWorkload, number>> = {
    claude: { planning: 0.8503, implementation: 0.8153, review: 0.8660, analysis: 0.7786, debugging: 0.8241, documentation: 0.7267, coordination: 0.7580 },
    openai: { planning: 0.7924, implementation: 0.8441, review: 0.8288, analysis: 0.7492, debugging: 0.8172, documentation: 0.7267, coordination: 0.7925 },
    kimi: { planning: 0.6979, implementation: 0.6767, review: 0.7097, analysis: 0.7267, debugging: 0.6687, documentation: 0.7267, coordination: 0.7175 },
    gemini: { planning: 0.8119, implementation: 0.7859, review: 0.8372, analysis: 0.7627, debugging: 0.7980, documentation: 0.7267, coordination: 0.7277 },
    deepseek: { planning: 0.7459, implementation: 0.6647, review: 0.7427, analysis: 0.7417, debugging: 0.6942, documentation: 0.7267, coordination: 0.6380 },
    qwen: { planning: 0.7564, implementation: 0.7547, review: 0.7862, analysis: 0.7702, debugging: 0.7527, documentation: 0.7267, coordination: 0.7775 },
    minimax: { planning: 0.7444, implementation: 0.7517, review: 0.7622, analysis: 0.6922, debugging: 0.7692, documentation: 0.7267, coordination: 0.7445 },
    mistral: { planning: 0.7264, implementation: 0.7787, review: 0.7652, analysis: 0.7453, debugging: 0.7497, documentation: 0.7267, coordination: 0.7403 },
    groq: { planning: 0.6379, implementation: 0.6422, review: 0.6512, analysis: 0.6412, debugging: 0.5847, documentation: 0.7267, coordination: 0.6560 },
    together: { planning: 0.6619, implementation: 0.7172, review: 0.6902, analysis: 0.6892, debugging: 0.6822, documentation: 0.7267, coordination: 0.7415 },
    fireworks: { planning: 0.6319, implementation: 0.7490, review: 0.6602, analysis: 0.6652, debugging: 0.6672, documentation: 0.7267, coordination: 0.7460 },
    ollama: { planning: 0.5704, implementation: 0.6212, review: 0.5912, analysis: 0.6052, debugging: 0.5712, documentation: 0.7267, coordination: 0.6305 },
  };

  // Unknown provider: pure feature-flag scores (no behavioral profile exists).
  const EXPECTED_UNKNOWN: Record<ProviderWorkload, number> = {
    planning: 0.7209,
    implementation: 0.7767,
    review: 0.7767,
    analysis: 0.6767,
    debugging: 0.7267,
    documentation: 0.7267,
    coordination: 0.7925,
  };

  for (const [provider, expected] of Object.entries(EXPECTED_KNOWN)) {
    it(`pins workload scores for known provider "${provider}"`, () => {
      const scores = scoresFor(provider);
      for (const workload of ALL_WORKLOADS) {
        expect(scores[workload], `${provider}/${workload}`).toBeCloseTo(expected[workload], 3);
      }
    });
  }

  it("pins pure feature-flag scores for an unknown provider", () => {
    const scores = scoresFor("someprovider");
    for (const workload of ALL_WORKLOADS) {
      expect(scores[workload], `someprovider/${workload}`).toBeCloseTo(EXPECTED_UNKNOWN[workload], 3);
    }
  });

  it("keeps every workload score within [0, 1]", () => {
    for (const provider of [...Object.keys(EXPECTED_KNOWN), "someprovider"]) {
      const scores = scoresFor(provider);
      for (const workload of ALL_WORKLOADS) {
        expect(scores[workload], `${provider}/${workload}`).toBeGreaterThanOrEqual(0);
        expect(scores[workload], `${provider}/${workload}`).toBeLessThanOrEqual(1);
      }
    }
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
