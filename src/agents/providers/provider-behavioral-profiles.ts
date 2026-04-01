/**
 * Provider Behavioral Intelligence — Static Baseline Profiles
 *
 * Tier 1 (Static Layer) of the Provider Behavioral Intelligence system.
 * Provides research-backed behavioral dimension scores for all supported
 * providers. These baselines serve as the foundation that the dynamic
 * learning system (Tier 2) adjusts over time based on observed runtime
 * performance.
 *
 * Pure module — no DB access, no side effects, no external imports.
 */

// ---------------------------------------------------------------------------
// Behavioral Dimensions
// ---------------------------------------------------------------------------

/** The 12 behavioral dimensions used to profile AI provider capabilities. */
export enum BehavioralDimension {
  /** Ability to coordinate and operate within multi-agent swarms. */
  agentSwarm = "agentSwarm",
  /** Depth and quality of multi-step planning and decomposition. */
  deepPlanning = "deepPlanning",
  /** Response latency and throughput for time-sensitive tasks. */
  fastExecution = "fastExecution",
  /** Quality of reasoning on complex, multi-constraint problems. */
  complexReasoning = "complexReasoning",
  /** Accuracy in interpreting ambiguous or nuanced user intent. */
  intentUnderstanding = "intentUnderstanding",
  /** Skill at restructuring and improving existing code. */
  codeRefactoring = "codeRefactoring",
  /** Ability to leverage large contexts without quality degradation. */
  contextManagement = "contextManagement",
  /** Reliability of tool/function call formatting and sequencing. */
  toolCallReliability = "toolCallReliability",
  /** Consistency in producing well-formed JSON and structured output. */
  structuredOutput = "structuredOutput",
  /** Cost-effectiveness relative to output quality. */
  costEfficiency = "costEfficiency",
  /** Quality of output across non-English languages. */
  multilingualStrength = "multilingualStrength",
  /** Ability to recover gracefully from errors and retries. */
  errorRecovery = "errorRecovery",
}

// ---------------------------------------------------------------------------
// Profile Interface
// ---------------------------------------------------------------------------

/** A complete behavioral profile for a single AI provider. */
export interface BehavioralProfile {
  /** Provider identifier (matches PROVIDER_PRESETS keys). */
  readonly providerId: string;
  /** Scores for each behavioral dimension, normalized to 0.0-1.0. */
  readonly scores: Readonly<Record<BehavioralDimension, number>>;
  /** Human-readable descriptions of the provider's best workloads. */
  readonly bestWorkloads: readonly string[];
  /** Timestamp (ms since epoch) when this profile was last updated. */
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Workload Types
// ---------------------------------------------------------------------------

/** Workload types supported by the ranking system. */
export type WorkloadType =
  | "planning"
  | "implementation"
  | "review"
  | "analysis"
  | "coordination"
  | "debugging";

// ---------------------------------------------------------------------------
// Workload -> Dimension Weight Mappings
// ---------------------------------------------------------------------------

export type DimensionWeight = readonly [BehavioralDimension, number];

/** Single source of truth for workload→dimension weight mappings. Used by both
 *  `rankProvidersForWorkload` (this module) and `deriveWorkloadScores` (provider-knowledge). */
export const WORKLOAD_DIMENSION_WEIGHTS: Readonly<Record<WorkloadType, readonly DimensionWeight[]>> = {
  planning: [
    [BehavioralDimension.deepPlanning, 0.35],
    [BehavioralDimension.complexReasoning, 0.25],
    [BehavioralDimension.intentUnderstanding, 0.20],
    [BehavioralDimension.contextManagement, 0.20],
  ],
  implementation: [
    [BehavioralDimension.codeRefactoring, 0.30],
    [BehavioralDimension.toolCallReliability, 0.25],
    [BehavioralDimension.fastExecution, 0.20],
    [BehavioralDimension.structuredOutput, 0.15],
    [BehavioralDimension.errorRecovery, 0.10],
  ],
  review: [
    [BehavioralDimension.complexReasoning, 0.30],
    [BehavioralDimension.contextManagement, 0.25],
    [BehavioralDimension.intentUnderstanding, 0.20],
    [BehavioralDimension.codeRefactoring, 0.15],
    [BehavioralDimension.errorRecovery, 0.10],
  ],
  analysis: [
    [BehavioralDimension.complexReasoning, 0.25],
    [BehavioralDimension.contextManagement, 0.20],
    [BehavioralDimension.deepPlanning, 0.20],
    [BehavioralDimension.multilingualStrength, 0.20],
    [BehavioralDimension.costEfficiency, 0.15],
  ],
  coordination: [
    [BehavioralDimension.agentSwarm, 0.30],
    [BehavioralDimension.fastExecution, 0.25],
    [BehavioralDimension.toolCallReliability, 0.20],
    [BehavioralDimension.errorRecovery, 0.15],
    [BehavioralDimension.costEfficiency, 0.10],
  ],
  debugging: [
    [BehavioralDimension.complexReasoning, 0.30],
    [BehavioralDimension.toolCallReliability, 0.25],
    [BehavioralDimension.codeRefactoring, 0.20],
    [BehavioralDimension.errorRecovery, 0.15],
    [BehavioralDimension.contextManagement, 0.10],
  ],
};

// ---------------------------------------------------------------------------
// Helper — Build frozen profiles from compact tuples
// ---------------------------------------------------------------------------

const BASELINE_TIMESTAMP = Date.UTC(2026, 3, 1); // 2026-04-01T00:00:00Z

/** Dimension order used in the compact score tuples below. */
const DIM_ORDER = [
  BehavioralDimension.agentSwarm, BehavioralDimension.deepPlanning,
  BehavioralDimension.fastExecution, BehavioralDimension.complexReasoning,
  BehavioralDimension.intentUnderstanding, BehavioralDimension.codeRefactoring,
  BehavioralDimension.contextManagement, BehavioralDimension.toolCallReliability,
  BehavioralDimension.structuredOutput, BehavioralDimension.costEfficiency,
  BehavioralDimension.multilingualStrength, BehavioralDimension.errorRecovery,
] as const;

type ScoreTuple = readonly [
  number, number, number, number, number, number,
  number, number, number, number, number, number,
];

function buildProfile(
  providerId: string,
  tuple: ScoreTuple,
  bestWorkloads: readonly string[],
): BehavioralProfile {
  const scores = {} as Record<BehavioralDimension, number>;
  for (let i = 0; i < DIM_ORDER.length; i++) {
    scores[DIM_ORDER[i]!] = tuple[i]!;
  }
  return Object.freeze({
    providerId,
    scores: Object.freeze(scores),
    bestWorkloads: Object.freeze([...bestWorkloads]),
    updatedAt: BASELINE_TIMESTAMP,
  });
}

// ---------------------------------------------------------------------------
// Static Baseline Profiles — Research-Backed Scores for All 12 Providers
// ---------------------------------------------------------------------------
// Tuple order: agentSwarm, deepPlanning, fastExecution, complexReasoning,
//   intentUnderstanding, codeRefactoring, contextManagement, toolCallReliability,
//   structuredOutput, costEfficiency, multilingualStrength, errorRecovery

/** Research-backed static baselines for all supported providers. */
export const STATIC_BASELINE_PROFILES: ReadonlyMap<string, BehavioralProfile> = new Map([
  ["claude",    buildProfile("claude",    [0.70, 0.95, 0.70, 0.92, 0.95, 0.93, 0.92, 0.80, 0.88, 0.55, 0.80, 0.90], ["planning", "review", "refactoring"])],
  ["openai",    buildProfile("openai",    [0.65, 0.80, 0.90, 0.88, 0.85, 0.88, 0.85, 0.90, 0.90, 0.65, 0.75, 0.85], ["implementation", "debugging", "coordination"])],
  ["kimi",      buildProfile("kimi",      [0.95, 0.70, 0.45, 0.75, 0.70, 0.75, 0.55, 0.50, 0.80, 0.95, 0.90, 0.50], ["coordination", "analysis (swarm)"])],
  ["gemini",    buildProfile("gemini",    [0.60, 0.85, 0.75, 0.90, 0.80, 0.88, 0.95, 0.75, 0.75, 0.50, 0.80, 0.78], ["analysis", "review"])],
  ["deepseek",  buildProfile("deepseek",  [0.40, 0.80, 0.55, 0.85, 0.65, 0.70, 0.70, 0.50, 0.60, 0.95, 0.65, 0.55], ["analysis (math)", "implementation (budget)"])],
  ["qwen",      buildProfile("qwen",      [0.80, 0.75, 0.70, 0.75, 0.80, 0.80, 0.85, 0.75, 0.65, 0.90, 0.95, 0.75], ["implementation (multilingual)", "analysis"])],
  ["minimax",   buildProfile("minimax",   [0.85, 0.80, 0.45, 0.80, 0.75, 0.80, 0.65, 0.85, 0.75, 0.55, 0.65, 0.80], ["coordination", "planning"])],
  ["mistral",   buildProfile("mistral",   [0.55, 0.70, 0.75, 0.70, 0.75, 0.85, 0.80, 0.80, 0.70, 0.88, 0.92, 0.70], ["implementation", "review (European langs)"])],
  ["groq",      buildProfile("groq",      [0.40, 0.55, 0.95, 0.60, 0.60, 0.55, 0.60, 0.35, 0.50, 0.85, 0.55, 0.35], ["coordination (speed)", "classification"])],
  ["together",  buildProfile("together",  [0.60, 0.60, 0.80, 0.65, 0.60, 0.60, 0.65, 0.70, 0.65, 0.90, 0.75, 0.65], ["implementation (budget)", "analysis"])],
  ["fireworks", buildProfile("fireworks", [0.55, 0.55, 0.90, 0.60, 0.55, 0.55, 0.60, 0.75, 0.92, 0.85, 0.75, 0.60], ["implementation (JSON)", "coordination (speed)"])],
  ["ollama",    buildProfile("ollama",    [0.35, 0.50, 0.70, 0.50, 0.45, 0.55, 0.40, 0.40, 0.45, 0.95, 0.55, 0.45], ["classification", "embeddings", "privacy"])],
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the static baseline profile for a provider.
 * Performs fuzzy matching (lowercase, trimmed) on the provider ID.
 * Returns `undefined` for unknown providers.
 */
export function getBaselineProfile(providerId: string): BehavioralProfile | undefined {
  return STATIC_BASELINE_PROFILES.get(providerId.toLowerCase().trim());
}

/**
 * Returns the provider ID with the highest score for a given behavioral
 * dimension. When multiple providers tie, the first one encountered wins.
 *
 * @param dimension - The behavioral dimension to query.
 * @param profiles  - The profile map to search (defaults to static baselines).
 */
export function getBestProviderForDimension(
  dimension: BehavioralDimension,
  profiles: ReadonlyMap<string, BehavioralProfile> = STATIC_BASELINE_PROFILES,
): string | undefined {
  let bestId: string | undefined;
  let bestScore = -1;

  for (const [id, p] of profiles) {
    const score = p.scores[dimension];
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }

  return bestId;
}

/** A ranked provider entry returned by {@link rankProvidersForWorkload}. */
export interface RankedProvider {
  readonly providerId: string;
  readonly compositeScore: number;
}

/**
 * Ranks all providers by composite score for a given workload type.
 * The composite score is the weighted sum of the relevant behavioral
 * dimensions for that workload. Results are sorted descending (best first).
 *
 * @param workloadType - The workload to rank providers for.
 * @param profiles     - The profile map to rank (defaults to static baselines).
 * @returns Providers sorted by composite score, highest first.
 */
export function rankProvidersForWorkload(
  workloadType: WorkloadType,
  profiles: ReadonlyMap<string, BehavioralProfile> = STATIC_BASELINE_PROFILES,
): readonly RankedProvider[] {
  const weights = WORKLOAD_DIMENSION_WEIGHTS[workloadType];
  if (!weights) {
    return [];
  }

  const ranked: RankedProvider[] = [];

  for (const [id, p] of profiles) {
    let compositeScore = 0;
    for (const [dim, weight] of weights) {
      compositeScore += p.scores[dim] * weight;
    }
    ranked.push({ providerId: id, compositeScore: Math.round(compositeScore * 1000) / 1000 });
  }

  ranked.sort((a, b) => b.compositeScore - a.compositeScore);

  return Object.freeze(ranked);
}
