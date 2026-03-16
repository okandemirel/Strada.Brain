/**
 * Provider Router
 *
 * Scores each available provider against a TaskClassification using
 * configurable routing presets and PROVIDER_KNOWLEDGE metadata.
 * Zero overhead when only one provider is available.
 */

import type {
  TaskClassification,
  RoutingPreset,
  RoutingWeights,
  RoutingDecision,
} from "./routing-types.js";
import { ROUTING_PRESETS } from "./routing-presets.js";
import { PROVIDER_KNOWLEDGE } from "../../agents/providers/provider-knowledge.js";

/* ------------------------------------------------------------------ */
/*  Provider Manager structural interface (avoids hard coupling)      */
/* ------------------------------------------------------------------ */

export interface ProviderManagerRef {
  listAvailable(): Array<{ name: string; label: string; defaultModel: string }>;
  isAvailable(name: string): boolean;
}

/* ------------------------------------------------------------------ */
/*  Cost & Speed tiers (0 = cheapest/fastest)                         */
/* ------------------------------------------------------------------ */

const COST_TIER: Record<string, number> = {
  ollama: 0,
  groq: 1,
  kimi: 2,
  deepseek: 2,
  qwen: 2,
  mistral: 3,
  together: 3,
  fireworks: 3,
  minimax: 3,
  openai: 4,
  gemini: 4,
  claude: 5,
};

const SPEED_TIER: Record<string, number> = {
  groq: 0,
  ollama: 1,
  kimi: 2,
  fireworks: 2,
  together: 2,
  deepseek: 3,
  qwen: 3,
  mistral: 3,
  minimax: 3,
  openai: 4,
  gemini: 4,
  claude: 4,
};

const MAX_COST_TIER = 5;
const MAX_SPEED_TIER = 4;
const MAX_DECISIONS = 100;

/* ------------------------------------------------------------------ */
/*  Capability keyword sets matched against provider strengths        */
/* ------------------------------------------------------------------ */

const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  planning: ["reasoning", "nuanced", "strong"],
  "code-generation": ["code", "coding", "tool calling", "function calling"],
  "code-review": ["reasoning", "nuanced", "audit"],
  debugging: ["reasoning", "code", "coding"],
  refactoring: ["code", "coding", "tool calling"],
  analysis: ["reasoning", "context", "multimodal", "grounding"],
  "simple-question": ["fast", "general"],
  "destructive-operation": ["tool calling", "function calling"],
};

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export class ProviderRouter {
  private weights: RoutingWeights;
  private presetName: string;
  private readonly decisions: RoutingDecision[] = [];
  private lastExecutingProvider: string | undefined;

  constructor(
    private readonly providerManager: ProviderManagerRef,
    preset: RoutingPreset = "balanced",
  ) {
    this.weights = ROUTING_PRESETS[preset];
    this.presetName = preset;
  }

  /**
   * Select the best provider for a task.
   * If `phase` is "reflecting", diversity weight is boosted to prefer
   * a different provider than the last executing one.
   */
  resolve(
    task: TaskClassification,
    phase?: string,
  ): RoutingDecision {
    const available = this.providerManager.listAvailable();

    // Zero overhead: single provider → return immediately
    if (available.length <= 1) {
      const name = available[0]?.name ?? "unknown";
      const decision: RoutingDecision = {
        provider: name,
        reason: "only available provider",
        task,
        timestamp: Date.now(),
      };
      this.recordDecision(decision);
      return decision;
    }

    // Phase-aware weight adjustment
    let weights = this.weights;
    if (phase === "reflecting") {
      weights = {
        ...weights,
        diversityWeight: Math.min(weights.diversityWeight + 0.4, 1.0),
      };
    }

    let bestProvider = available[0]!.name;
    let bestScore = -Infinity;
    let bestReason = "";

    for (const entry of available) {
      const score = this.scoreProvider(entry.name, task, weights);
      if (score > bestScore) {
        bestScore = score;
        bestProvider = entry.name;
        bestReason = this.buildReason(task, weights);
      }
    }

    const decision: RoutingDecision = {
      provider: bestProvider,
      reason: bestReason,
      task,
      timestamp: Date.now(),
    };

    this.recordDecision(decision);
    this.lastExecutingProvider = bestProvider;
    return decision;
  }

  /**
   * Return the last N routing decisions for diagnostics.
   */
  getRecentDecisions(n: number): RoutingDecision[] {
    return this.decisions.slice(-n);
  }

  /**
   * Change the routing preset at runtime.
   */
  setPreset(preset: RoutingPreset): void {
    this.weights = ROUTING_PRESETS[preset];
    this.presetName = preset;
  }

  /**
   * Get the current preset name (for diagnostics / /routing command).
   */
  getPreset(): string {
    return this.presetName;
  }

  /**
   * Get the current preset weights (for testing / diagnostics).
   */
  getWeights(): RoutingWeights {
    return this.weights;
  }

  /* ---------------------------------------------------------------- */
  /*  Internals                                                       */
  /* ---------------------------------------------------------------- */

  private scoreProvider(
    name: string,
    task: TaskClassification,
    weights: RoutingWeights,
  ): number {
    const cost = this.costScore(name);
    const capability = this.capabilityScore(name, task);
    const speed = this.speedScore(name);
    const diversity = this.diversityScore(name);

    return (
      weights.costWeight * cost +
      weights.capabilityWeight * capability +
      weights.speedWeight * speed +
      weights.diversityWeight * diversity
    );
  }

  /** Inverse cost: cheaper → higher score (0..1). */
  private costScore(name: string): number {
    const tier = COST_TIER[name] ?? 3;
    return Math.max(0, 1 - tier / MAX_COST_TIER);
  }

  /** Capability: context window size (normalized) + keyword match bonus. */
  private capabilityScore(
    name: string,
    task: TaskClassification,
  ): number {
    const knowledge = PROVIDER_KNOWLEDGE[name];
    if (!knowledge) return 0.3;

    // Normalized context window (log-scale relative to 1M)
    const contextScore = Math.min(
      Math.log10(knowledge.contextWindow) / Math.log10(1_000_000),
      1.0,
    );

    // Keyword match bonus
    const keywords = CAPABILITY_KEYWORDS[task.type] ?? [];
    const strengths = knowledge.strengths.map((s) => s.toLowerCase());
    let keywordHits = 0;
    for (const kw of keywords) {
      if (strengths.some((s) => s.includes(kw))) {
        keywordHits++;
      }
    }
    const keywordScore =
      keywords.length > 0 ? keywordHits / keywords.length : 0;

    return contextScore * 0.4 + keywordScore * 0.6;
  }

  /** Inverse speed tier: faster → higher score (0..1). */
  private speedScore(name: string): number {
    const tier = SPEED_TIER[name] ?? 3;
    return Math.max(0, 1 - tier / MAX_SPEED_TIER);
  }

  /** Diversity: bonus for using a different provider than the last one. */
  private diversityScore(name: string): number {
    if (!this.lastExecutingProvider) return 0.5;
    return name === this.lastExecutingProvider ? 0.0 : 1.0;
  }

  private buildReason(
    task: TaskClassification,
    weights: RoutingWeights,
  ): string {
    const parts: string[] = [];
    if (weights.costWeight > 0.3) parts.push("cost-effective");
    if (weights.capabilityWeight > 0.3) parts.push("high-capability");
    if (weights.speedWeight > 0.15) parts.push("fast");
    if (weights.diversityWeight > 0.2) parts.push("diverse");
    const qualifier = parts.length > 0 ? parts.join("+") : "balanced";
    return `${qualifier} choice for ${task.type} (${task.complexity})`;
  }

  private recordDecision(decision: RoutingDecision): void {
    this.decisions.push(decision);
    if (this.decisions.length > MAX_DECISIONS) {
      this.decisions.shift();
    }
  }
}
