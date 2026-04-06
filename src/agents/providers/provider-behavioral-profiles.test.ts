/**
 * Tests for Provider Behavioral Intelligence — Static Baseline Profiles
 *
 * Covers: dimension scores, getBaselineProfile, getBestProviderForDimension,
 * rankProvidersForWorkload, workload dimension weights, edge cases.
 */

import { describe, it, expect } from "vitest";
import {
  BehavioralDimension,
  STATIC_BASELINE_PROFILES,
  WORKLOAD_DIMENSION_WEIGHTS,
  getBaselineProfile,
  getBestProviderForDimension,
  rankProvidersForWorkload,
} from "./provider-behavioral-profiles.js";
import type {
  BehavioralProfile,
  WorkloadType,
  RankedProvider,
} from "./provider-behavioral-profiles.js";

// ---------------------------------------------------------------------------
// Tests: STATIC_BASELINE_PROFILES
// ---------------------------------------------------------------------------

describe("STATIC_BASELINE_PROFILES", () => {
  it("should contain all 12 expected providers", () => {
    const expectedProviders = [
      "claude", "openai", "kimi", "gemini", "deepseek", "qwen",
      "minimax", "mistral", "groq", "together", "fireworks", "ollama",
    ];
    for (const provider of expectedProviders) {
      expect(STATIC_BASELINE_PROFILES.has(provider)).toBe(true);
    }
    expect(STATIC_BASELINE_PROFILES.size).toBe(12);
  });

  it("should have scores for all 12 dimensions per provider", () => {
    const allDimensions = Object.values(BehavioralDimension);
    expect(allDimensions).toHaveLength(12);

    for (const [providerId, profile] of STATIC_BASELINE_PROFILES) {
      for (const dim of allDimensions) {
        expect(
          profile.scores[dim],
        ).toBeDefined();
        // Score should be between 0 and 1
        expect(profile.scores[dim]).toBeGreaterThanOrEqual(0);
        expect(profile.scores[dim]).toBeLessThanOrEqual(1);
      }
    }
  });

  it("should have non-empty bestWorkloads for each provider", () => {
    for (const [providerId, profile] of STATIC_BASELINE_PROFILES) {
      expect(profile.bestWorkloads.length).toBeGreaterThan(0);
    }
  });

  it("should have a valid updatedAt timestamp for each provider", () => {
    for (const [providerId, profile] of STATIC_BASELINE_PROFILES) {
      expect(profile.updatedAt).toBeGreaterThan(0);
    }
  });

  it("profiles should be frozen (immutable)", () => {
    const claude = STATIC_BASELINE_PROFILES.get("claude")!;
    expect(Object.isFrozen(claude)).toBe(true);
    expect(Object.isFrozen(claude.scores)).toBe(true);
    expect(Object.isFrozen(claude.bestWorkloads)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: getBaselineProfile
// ---------------------------------------------------------------------------

describe("getBaselineProfile", () => {
  it("should return the profile for a valid provider", () => {
    const profile = getBaselineProfile("claude");
    expect(profile).toBeDefined();
    expect(profile!.providerId).toBe("claude");
  });

  it("should return undefined for an unknown provider", () => {
    const profile = getBaselineProfile("nonexistent-provider");
    expect(profile).toBeUndefined();
  });

  it("should be case-insensitive", () => {
    const upper = getBaselineProfile("CLAUDE");
    const lower = getBaselineProfile("claude");
    const mixed = getBaselineProfile("Claude");

    expect(upper).toBeDefined();
    expect(lower).toBeDefined();
    expect(mixed).toBeDefined();
    expect(upper).toBe(lower);
    expect(upper).toBe(mixed);
  });

  it("should trim whitespace from provider ID", () => {
    const profile = getBaselineProfile("  openai  ");
    expect(profile).toBeDefined();
    expect(profile!.providerId).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// Tests: getBestProviderForDimension
// ---------------------------------------------------------------------------

describe("getBestProviderForDimension", () => {
  it("should return a string provider ID", () => {
    const best = getBestProviderForDimension(BehavioralDimension.deepPlanning);
    expect(typeof best).toBe("string");
    expect(best!.length).toBeGreaterThan(0);
  });

  it("should return 'claude' for deepPlanning (highest score 0.95)", () => {
    const best = getBestProviderForDimension(BehavioralDimension.deepPlanning);
    expect(best).toBe("claude");
  });

  it("should return 'groq' for fastExecution (highest score 0.95)", () => {
    const best = getBestProviderForDimension(BehavioralDimension.fastExecution);
    expect(best).toBe("groq");
  });

  it("should return 'kimi' for agentSwarm (highest score 0.95)", () => {
    const best = getBestProviderForDimension(BehavioralDimension.agentSwarm);
    expect(best).toBe("kimi");
  });

  it("should return 'qwen' for multilingualStrength (highest score 0.95)", () => {
    const best = getBestProviderForDimension(BehavioralDimension.multilingualStrength);
    expect(best).toBe("qwen");
  });

  it("should work with a custom profile map", () => {
    const custom = new Map<string, BehavioralProfile>([
      [
        "custom-provider",
        {
          providerId: "custom-provider",
          scores: {
            [BehavioralDimension.agentSwarm]: 1.0,
            [BehavioralDimension.deepPlanning]: 0.1,
            [BehavioralDimension.fastExecution]: 0.1,
            [BehavioralDimension.complexReasoning]: 0.1,
            [BehavioralDimension.intentUnderstanding]: 0.1,
            [BehavioralDimension.codeRefactoring]: 0.1,
            [BehavioralDimension.contextManagement]: 0.1,
            [BehavioralDimension.toolCallReliability]: 0.1,
            [BehavioralDimension.structuredOutput]: 0.1,
            [BehavioralDimension.costEfficiency]: 0.1,
            [BehavioralDimension.multilingualStrength]: 0.1,
            [BehavioralDimension.errorRecovery]: 0.1,
          },
          bestWorkloads: ["test"],
          updatedAt: Date.now(),
        },
      ],
    ]);

    const best = getBestProviderForDimension(BehavioralDimension.agentSwarm, custom);
    expect(best).toBe("custom-provider");
  });

  it("should return undefined for an empty profile map", () => {
    const best = getBestProviderForDimension(
      BehavioralDimension.deepPlanning,
      new Map(),
    );
    expect(best).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: WORKLOAD_DIMENSION_WEIGHTS
// ---------------------------------------------------------------------------

describe("WORKLOAD_DIMENSION_WEIGHTS", () => {
  const allWorkloads: WorkloadType[] = [
    "planning",
    "implementation",
    "review",
    "analysis",
    "coordination",
    "debugging",
  ];

  it("should have weights for all 6 workload types", () => {
    for (const workload of allWorkloads) {
      expect(WORKLOAD_DIMENSION_WEIGHTS[workload]).toBeDefined();
      expect(WORKLOAD_DIMENSION_WEIGHTS[workload].length).toBeGreaterThan(0);
    }
  });

  it("should have weights that sum to 1.0 for each workload", () => {
    for (const workload of allWorkloads) {
      const weights = WORKLOAD_DIMENSION_WEIGHTS[workload];
      const sum = weights.reduce((acc, [, w]) => acc + w, 0);
      expect(sum).toBeCloseTo(1.0, 5);
    }
  });

  it("should only reference valid BehavioralDimension values", () => {
    const validDims = new Set(Object.values(BehavioralDimension));
    for (const workload of allWorkloads) {
      for (const [dim] of WORKLOAD_DIMENSION_WEIGHTS[workload]) {
        expect(validDims.has(dim)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: rankProvidersForWorkload
// ---------------------------------------------------------------------------

describe("rankProvidersForWorkload", () => {
  it("should return all 12 providers sorted by composite score", () => {
    const ranked = rankProvidersForWorkload("planning");
    expect(ranked).toHaveLength(12);
    // Verify descending order
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.compositeScore).toBeGreaterThanOrEqual(ranked[i]!.compositeScore);
    }
  });

  it("should return empty array for an invalid workload type", () => {
    const ranked = rankProvidersForWorkload("nonexistent" as any);
    expect(ranked).toEqual([]);
  });

  it("should rank claude first for planning", () => {
    const ranked = rankProvidersForWorkload("planning");
    expect(ranked[0]!.providerId).toBe("claude");
  });

  it("should have composite scores between 0 and 1", () => {
    const allWorkloads: WorkloadType[] = [
      "planning", "implementation", "review",
      "analysis", "coordination", "debugging",
    ];
    for (const workload of allWorkloads) {
      const ranked = rankProvidersForWorkload(workload);
      for (const entry of ranked) {
        expect(entry.compositeScore).toBeGreaterThanOrEqual(0);
        expect(entry.compositeScore).toBeLessThanOrEqual(1);
      }
    }
  });

  it("should round composite scores to 3 decimal places", () => {
    const ranked = rankProvidersForWorkload("implementation");
    for (const entry of ranked) {
      const str = entry.compositeScore.toString();
      const parts = str.split(".");
      if (parts.length > 1) {
        expect(parts[1]!.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it("should return frozen results", () => {
    const ranked = rankProvidersForWorkload("planning");
    expect(Object.isFrozen(ranked)).toBe(true);
  });

  it("should work with a custom profile map", () => {
    const custom = new Map<string, BehavioralProfile>([
      [
        "alpha",
        {
          providerId: "alpha",
          scores: {
            [BehavioralDimension.agentSwarm]: 0.9,
            [BehavioralDimension.deepPlanning]: 0.9,
            [BehavioralDimension.fastExecution]: 0.9,
            [BehavioralDimension.complexReasoning]: 0.9,
            [BehavioralDimension.intentUnderstanding]: 0.9,
            [BehavioralDimension.codeRefactoring]: 0.9,
            [BehavioralDimension.contextManagement]: 0.9,
            [BehavioralDimension.toolCallReliability]: 0.9,
            [BehavioralDimension.structuredOutput]: 0.9,
            [BehavioralDimension.costEfficiency]: 0.9,
            [BehavioralDimension.multilingualStrength]: 0.9,
            [BehavioralDimension.errorRecovery]: 0.9,
          },
          bestWorkloads: ["all"],
          updatedAt: Date.now(),
        },
      ],
      [
        "beta",
        {
          providerId: "beta",
          scores: {
            [BehavioralDimension.agentSwarm]: 0.1,
            [BehavioralDimension.deepPlanning]: 0.1,
            [BehavioralDimension.fastExecution]: 0.1,
            [BehavioralDimension.complexReasoning]: 0.1,
            [BehavioralDimension.intentUnderstanding]: 0.1,
            [BehavioralDimension.codeRefactoring]: 0.1,
            [BehavioralDimension.contextManagement]: 0.1,
            [BehavioralDimension.toolCallReliability]: 0.1,
            [BehavioralDimension.structuredOutput]: 0.1,
            [BehavioralDimension.costEfficiency]: 0.1,
            [BehavioralDimension.multilingualStrength]: 0.1,
            [BehavioralDimension.errorRecovery]: 0.1,
          },
          bestWorkloads: ["none"],
          updatedAt: Date.now(),
        },
      ],
    ]);

    const ranked = rankProvidersForWorkload("planning", custom);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.providerId).toBe("alpha");
    expect(ranked[1]!.providerId).toBe("beta");
    expect(ranked[0]!.compositeScore).toBeGreaterThan(ranked[1]!.compositeScore);
  });

  it("should produce consistent rankings for the same inputs", () => {
    const r1 = rankProvidersForWorkload("debugging");
    const r2 = rankProvidersForWorkload("debugging");

    expect(r1).toEqual(r2);
  });

  it("should differentiate rankings across different workloads", () => {
    const planning = rankProvidersForWorkload("planning");
    const coordination = rankProvidersForWorkload("coordination");

    // Top provider should differ between planning and coordination
    // Planning: claude, Coordination: kimi or openai
    expect(planning[0]!.providerId).not.toBe(coordination[0]!.providerId);
  });
});

// ---------------------------------------------------------------------------
// Tests: BehavioralDimension enum
// ---------------------------------------------------------------------------

describe("BehavioralDimension", () => {
  it("should have exactly 12 dimensions", () => {
    const dims = Object.values(BehavioralDimension);
    expect(dims).toHaveLength(12);
  });

  it("should include all expected dimensions", () => {
    expect(BehavioralDimension.agentSwarm).toBe("agentSwarm");
    expect(BehavioralDimension.deepPlanning).toBe("deepPlanning");
    expect(BehavioralDimension.fastExecution).toBe("fastExecution");
    expect(BehavioralDimension.complexReasoning).toBe("complexReasoning");
    expect(BehavioralDimension.intentUnderstanding).toBe("intentUnderstanding");
    expect(BehavioralDimension.codeRefactoring).toBe("codeRefactoring");
    expect(BehavioralDimension.contextManagement).toBe("contextManagement");
    expect(BehavioralDimension.toolCallReliability).toBe("toolCallReliability");
    expect(BehavioralDimension.structuredOutput).toBe("structuredOutput");
    expect(BehavioralDimension.costEfficiency).toBe("costEfficiency");
    expect(BehavioralDimension.multilingualStrength).toBe("multilingualStrength");
    expect(BehavioralDimension.errorRecovery).toBe("errorRecovery");
  });
});
