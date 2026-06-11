import { describe, expect, it } from "vitest";
import {
  buildProviderIntelligence,
  formatContextWindow,
  getProviderIntelligenceSnapshot,
  getRecommendedMaxMessages,
  type ModelIntelligenceLookup,
  type ProviderWorkload,
} from "./provider-knowledge.js";
import { rankProvidersForWorkload } from "./provider-behavioral-profiles.js";

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
    // Uses an unknown provider so the feature-flag heuristics (the fallback
    // path) are exercised; known providers now use behavioral baselines.
    const snapshot = getProviderIntelligenceSnapshot(
      "customprovider",
      "custom-for-coding",
      undefined,
      {
        contextWindow: 262_000,
        thinkingSupported: true,
        toolCalling: true,
        streaming: true,
        specialFeatures: ["coding", "reasoning"],
      },
      "Custom Provider",
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

  // INTENTIONAL DRIFT (plan 011, 2026-06-11): scores moved from
  // 0.4*featureFlag + 0.6*behavioral to pure behavioral for known providers.
  // Examples (before → after, from the pre-refactor characterization run):
  //   claude/planning  0.8503 → 0.9365
  //   gemini/planning  0.8119 → 0.8725
  //   ollama/planning  0.5704 → 0.4700
  // documentation has no behavioral mapping, so it stays pure feature-flag
  // for every provider and is IDENTICAL before/after the refactor (0.7267
  // for this fixed snapshot).
  const EXPECTED_KNOWN: Record<string, Record<ProviderWorkload, number>> = {
    claude: { planning: 0.9365, implementation: 0.8410, review: 0.9255, analysis: 0.8465, debugging: 0.8890, documentation: 0.7267, coordination: 0.7350 },
    openai: { planning: 0.8400, implementation: 0.8890, review: 0.8635, analysis: 0.7975, debugging: 0.8775, documentation: 0.7267, coordination: 0.7925 },
    kimi: { planning: 0.6825, implementation: 0.6100, review: 0.6650, analysis: 0.7600, debugging: 0.6300, documentation: 0.7267, coordination: 0.6675 },
    gemini: { planning: 0.8725, implementation: 0.7920, review: 0.8775, analysis: 0.8200, debugging: 0.8455, documentation: 0.7267, coordination: 0.6845 },
    deepseek: { planning: 0.7625, implementation: 0.5900, review: 0.7200, analysis: 0.7850, debugging: 0.6725, documentation: 0.7267, coordination: 0.5350 },
    qwen: { planning: 0.7800, implementation: 0.7400, review: 0.7925, analysis: 0.8325, debugging: 0.7700, documentation: 0.7267, coordination: 0.7675 },
    minimax: { planning: 0.7600, implementation: 0.7350, review: 0.7525, analysis: 0.7025, debugging: 0.7975, documentation: 0.7267, coordination: 0.7125 },
    mistral: { planning: 0.7300, implementation: 0.7800, review: 0.7575, analysis: 0.7910, debugging: 0.7650, documentation: 0.7267, coordination: 0.7055 },
    groq: { planning: 0.5825, implementation: 0.5525, review: 0.5675, analysis: 0.6175, debugging: 0.4900, documentation: 0.7267, coordination: 0.5650 },
    together: { planning: 0.6225, implementation: 0.6775, review: 0.6325, analysis: 0.6975, debugging: 0.6525, documentation: 0.7267, coordination: 0.7075 },
    fireworks: { planning: 0.5725, implementation: 0.7305, review: 0.5825, analysis: 0.6575, debugging: 0.6275, documentation: 0.7267, coordination: 0.7150 },
    ollama: { planning: 0.4700, implementation: 0.5175, review: 0.4675, analysis: 0.5575, debugging: 0.4675, documentation: 0.7267, coordination: 0.5225 },
  };

  // Unknown provider: pure feature-flag scores (no behavioral profile exists).
  // These values are IDENTICAL before/after the plan-011 refactor — the
  // feature-flag fallback path is unchanged.
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

  describe("score precedence", () => {
    it("uses the behavioral composite for known providers on mapped workloads", () => {
      // Cross-system consistency: claude/planning must equal the
      // rankProvidersForWorkload composite — the point of the unification.
      const claudeComposite = rankProvidersForWorkload("planning")
        .find((entry) => entry.providerId === "claude")?.compositeScore;
      expect(claudeComposite).toBeDefined();
      expect(Math.abs(scoresFor("claude").planning - claudeComposite!)).toBeLessThan(0.001);
    });

    it("keeps the feature-flag score for known providers on unmapped workloads", () => {
      // documentation has no behavioral mapping; with the same fixed
      // capability snapshot every known provider gets the same feature-flag
      // value as an unknown provider.
      const unknownDocumentation = scoresFor("someprovider").documentation;
      for (const provider of Object.keys(EXPECTED_KNOWN)) {
        expect(scoresFor(provider).documentation, `${provider}/documentation`).toBeCloseTo(unknownDocumentation, 6);
      }
    });

    it("uses pure feature-flag scores for unknown providers", () => {
      // Two distinct unknown providers with the same capability snapshot
      // must produce identical scores — nothing provider-specific leaks in.
      const first = scoresFor("someprovider");
      const second = scoresFor("another-unknown-provider");
      for (const workload of ALL_WORKLOADS) {
        expect(second[workload], `another-unknown-provider/${workload}`).toBe(first[workload]);
      }
    });
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
