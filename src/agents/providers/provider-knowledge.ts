/**
 * Provider Intelligence
 *
 * Builds provider snapshots from runtime capabilities and model-intelligence
 * data. The decision path intentionally avoids provider-specific hardcoded
 * strengths or role tables.
 */

import type { ProviderCapabilities } from "./provider.interface.js";

export type ProviderWorkload =
  | "planning"
  | "implementation"
  | "review"
  | "analysis"
  | "debugging"
  | "documentation"
  | "coordination";

export interface ModelCapabilitySnapshot {
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly inputPricePerMillion?: number;
  readonly outputPricePerMillion?: number;
  readonly supportsVision: boolean;
  readonly supportsThinking: boolean;
  readonly supportsToolCalling: boolean;
  readonly supportsStreaming: boolean;
}

export interface ModelIntelligenceLookup {
  getModelInfo(modelId: string): ModelCapabilitySnapshot | undefined;
}

export interface ProviderCapabilitySnapshot {
  readonly contextWindow?: number;
  readonly supportsVision?: boolean;
  readonly supportsThinking?: boolean;
  readonly supportsToolCalling?: boolean;
  readonly supportsStreaming?: boolean;
  readonly specialFeatures?: readonly string[];
}

export interface ProviderIntelligenceSnapshot {
  readonly providerName: string;
  readonly providerLabel: string;
  readonly modelId?: string;
  readonly contextWindow: number;
  readonly maxMessages: number;
  readonly strengths: string[];
  readonly limitations: string[];
  readonly behavioralHints: string[];
  readonly featureTags: string[];
  readonly workloadScores: Record<ProviderWorkload, number>;
  readonly economics: {
    readonly inputPricePerMillion?: number;
    readonly outputPricePerMillion?: number;
  };
  readonly capabilities: {
    readonly supportsVision: boolean;
    readonly supportsThinking: boolean;
    readonly supportsToolCalling: boolean;
    readonly supportsStreaming: boolean;
  };
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_MESSAGES = 40;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeContextWindow(tokens: number): number {
  return clamp(Math.log10(Math.max(tokens, 4_000)) / Math.log10(1_000_000));
}

function normalizeFeatureName(feature: string): string {
  return feature.toLowerCase().replace(/_/g, "-");
}

function readVisionSupport(
  providerCapabilities?: ProviderCapabilities | ProviderCapabilitySnapshot,
): boolean | undefined {
  if (!providerCapabilities) {
    return undefined;
  }
  return "vision" in providerCapabilities
    ? providerCapabilities.vision
    : providerCapabilities.supportsVision;
}

function readThinkingSupport(
  providerCapabilities?: ProviderCapabilities | ProviderCapabilitySnapshot,
): boolean | undefined {
  if (!providerCapabilities) {
    return undefined;
  }
  if ("thinkingSupported" in providerCapabilities) {
    return providerCapabilities.thinkingSupported;
  }
  if ("supportsThinking" in providerCapabilities) {
    return providerCapabilities.supportsThinking;
  }
  return undefined;
}

function readToolCallingSupport(
  providerCapabilities?: ProviderCapabilities | ProviderCapabilitySnapshot,
): boolean | undefined {
  if (!providerCapabilities) {
    return undefined;
  }
  if ("toolCalling" in providerCapabilities) {
    return providerCapabilities.toolCalling;
  }
  if ("supportsToolCalling" in providerCapabilities) {
    return providerCapabilities.supportsToolCalling;
  }
  return undefined;
}

function readStreamingSupport(
  providerCapabilities?: ProviderCapabilities | ProviderCapabilitySnapshot,
): boolean | undefined {
  if (!providerCapabilities) {
    return undefined;
  }
  if ("streaming" in providerCapabilities) {
    return providerCapabilities.streaming;
  }
  if ("supportsStreaming" in providerCapabilities) {
    return providerCapabilities.supportsStreaming;
  }
  return undefined;
}

function hasAnyFeature(features: ReadonlySet<string>, tags: readonly string[]): boolean {
  return tags.some((tag) => features.has(tag));
}

function formatPrice(value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function resolveMaxMessages(contextWindow: number): number {
  if (contextWindow >= 1_000_000) {
    return 80;
  }
  if (contextWindow >= 250_000) {
    return 60;
  }
  if (contextWindow <= 16_000) {
    return 20;
  }
  return DEFAULT_MAX_MESSAGES;
}

function buildFeatureTags(
  providerCapabilities?: ProviderCapabilities | ProviderCapabilitySnapshot,
  modelInfo?: ModelCapabilitySnapshot,
  contextWindow?: number,
): string[] {
  const tags = new Set<string>();

  for (const feature of providerCapabilities?.specialFeatures ?? []) {
    tags.add(normalizeFeatureName(feature));
  }

  if (contextWindow !== undefined && contextWindow >= 250_000) {
    tags.add("long-context");
  }

  if ((modelInfo?.supportsVision ?? readVisionSupport(providerCapabilities)) === true) {
    tags.add("multimodal");
  }

  if ((modelInfo?.supportsThinking ?? readThinkingSupport(providerCapabilities)) === true) {
    tags.add("reasoning");
  }

  if ((modelInfo?.supportsToolCalling ?? readToolCallingSupport(providerCapabilities)) === true) {
    tags.add("tool-calling");
  }

  if ((modelInfo?.supportsStreaming ?? readStreamingSupport(providerCapabilities)) === true) {
    tags.add("streaming");
  }

  return [...tags];
}

function buildStrengths(
  contextWindow: number,
  capabilities: ProviderIntelligenceSnapshot["capabilities"],
  features: readonly string[],
): string[] {
  const strengths: string[] = [];
  const tags = new Set(features);

  if (contextWindow >= 250_000) strengths.push("Long context window");
  if (capabilities.supportsThinking) strengths.push("Reasoning support");
  if (capabilities.supportsToolCalling) strengths.push("Native tool calling");
  if (capabilities.supportsVision) strengths.push("Multimodal input");
  if (hasAnyFeature(tags, ["grounding", "search", "web-search"])) strengths.push("Grounding/search support");
  if (hasAnyFeature(tags, ["fast-inference", "latency-sensitive"])) strengths.push("Latency-optimized inference");
  if (hasAnyFeature(tags, ["local-inference", "privacy", "offline"])) strengths.push("Local/offline execution");
  if (hasAnyFeature(tags, ["json-mode", "function-calling"])) strengths.push("Structured output support");

  if (strengths.length === 0) {
    strengths.push("General-purpose inference");
  }

  return strengths;
}

function buildLimitations(
  contextWindow: number,
  capabilities: ProviderIntelligenceSnapshot["capabilities"],
  features: readonly string[],
): string[] {
  const limitations: string[] = [];
  const tags = new Set(features);

  if (contextWindow < 32_000) limitations.push("Smaller context window");
  if (!capabilities.supportsThinking) limitations.push("No explicit reasoning channel");
  if (!capabilities.supportsVision) limitations.push("No multimodal input");
  if (!capabilities.supportsToolCalling) limitations.push("No native tool calling");
  if (!hasAnyFeature(tags, ["grounding", "search", "web-search"])) limitations.push("No live search/grounding hints");

  return limitations;
}

function buildBehavioralHints(
  capabilities: ProviderIntelligenceSnapshot["capabilities"],
  features: readonly string[],
): string[] {
  const hints: string[] = [];
  const tags = new Set(features);

  if (capabilities.supportsToolCalling) {
    hints.push("Prefer structured tool calls when available");
  }
  if (hasAnyFeature(tags, ["grounding", "search", "web-search"])) {
    hints.push("Use grounding or search for time-sensitive factual tasks");
  }
  if (hasAnyFeature(tags, ["prompt-caching", "context-caching"])) {
    hints.push("Keep stable system prompts to benefit from caching");
  }
  if (hasAnyFeature(tags, ["adaptive-thinking", "thinking-level", "reasoning", "reasoning-details"])) {
    hints.push("Escalate reasoning depth only for complex tasks");
  }
  if (hasAnyFeature(tags, ["code-execution", "coding", "code-generation"])) {
    hints.push("Pair coding output with execution or verification tools");
  }
  if (hasAnyFeature(tags, ["local-inference", "privacy", "offline"])) {
    hints.push("Prefer concise prompts to stay within local model budgets");
  }

  return hints;
}

function getCheapnessScore(
  inputPricePerMillion: number | undefined,
  outputPricePerMillion: number | undefined,
  features: ReadonlySet<string>,
): number {
  if (hasAnyFeature(features, ["local-inference", "privacy", "offline"])) {
    return 1;
  }

  const totalPrice = (inputPricePerMillion ?? 0) + (outputPricePerMillion ?? 0);
  if (inputPricePerMillion !== undefined || outputPricePerMillion !== undefined) {
    if (totalPrice <= 1) return 1;
    if (totalPrice <= 4) return 0.82;
    if (totalPrice <= 10) return 0.62;
    if (totalPrice <= 20) return 0.38;
    return 0.2;
  }

  return 0.5;
}

function getSpeedScore(features: ReadonlySet<string>): number {
  return hasAnyFeature(features, ["fast-inference", "latency-sensitive"]) ? 1 : 0.55;
}

function deriveWorkloadScores(snapshot: {
  contextWindow: number;
  featureTags: readonly string[];
  capabilities: ProviderIntelligenceSnapshot["capabilities"];
  economics: ProviderIntelligenceSnapshot["economics"];
}): Record<ProviderWorkload, number> {
  const features = new Set(snapshot.featureTags.map((tag) => tag.toLowerCase()));
  const context = normalizeContextWindow(snapshot.contextWindow);
  const thinking = snapshot.capabilities.supportsThinking ? 1 : 0.45;
  const toolCalling = snapshot.capabilities.supportsToolCalling ? 1 : 0.25;
  const vision = snapshot.capabilities.supportsVision ? 1 : 0;
  const streaming = snapshot.capabilities.supportsStreaming ? 1 : 0.35;
  const search = hasAnyFeature(features, ["search", "grounding", "web-search"]) ? 1 : 0;
  const coding = hasAnyFeature(features, ["coding", "code-generation", "code-execution"]) ? 1 : 0;
  const reviewer = hasAnyFeature(features, ["prompt-caching", "context-caching", "json-mode"]) ? 1 : 0;
  const multilingual = features.has("multilingual") ? 1 : 0;
  const cheapness = getCheapnessScore(
    snapshot.economics.inputPricePerMillion,
    snapshot.economics.outputPricePerMillion,
    features,
  );
  const speed = getSpeedScore(features);

  return {
    planning: clamp(0.35 * thinking + 0.25 * context + 0.15 * toolCalling + 0.15 * search + 0.10 * reviewer),
    implementation: clamp(0.35 * toolCalling + 0.20 * context + 0.20 * coding + 0.15 * thinking + 0.10 * streaming),
    review: clamp(0.30 * thinking + 0.20 * toolCalling + 0.20 * context + 0.20 * reviewer + 0.10 * streaming),
    analysis: clamp(0.25 * thinking + 0.20 * context + 0.20 * search + 0.15 * vision + 0.10 * streaming + 0.10 * reviewer),
    debugging: clamp(0.30 * thinking + 0.25 * toolCalling + 0.20 * context + 0.15 * coding + 0.10 * search),
    documentation: clamp(0.25 * thinking + 0.20 * context + 0.20 * streaming + 0.20 * cheapness + 0.15 * multilingual),
    coordination: clamp(0.25 * streaming + 0.20 * speed + 0.20 * toolCalling + 0.20 * cheapness + 0.15 * context),
  };
}

/**
 * Format a context window size (in tokens) as a human-readable string.
 * Example: 1_000_000 -> "1000K"
 */
export function formatContextWindow(tokens: number): string {
  return `${(tokens / 1000).toFixed(0)}K`;
}

export function getProviderIntelligenceSnapshot(
  providerName: string,
  modelId?: string,
  modelIntelligence?: ModelIntelligenceLookup,
  providerCapabilities?: ProviderCapabilities | ProviderCapabilitySnapshot,
  providerLabel?: string,
): ProviderIntelligenceSnapshot {
  const modelInfo = modelId ? modelIntelligence?.getModelInfo(modelId) : undefined;
  const contextWindow =
    modelInfo?.contextWindow ??
    providerCapabilities?.contextWindow ??
    DEFAULT_CONTEXT_WINDOW;
  const capabilities = {
    supportsVision:
      modelInfo?.supportsVision ??
      readVisionSupport(providerCapabilities) ??
      false,
    supportsThinking:
      modelInfo?.supportsThinking ??
      readThinkingSupport(providerCapabilities) ??
      false,
    supportsToolCalling:
      modelInfo?.supportsToolCalling ??
      readToolCallingSupport(providerCapabilities) ??
      false,
    supportsStreaming:
      modelInfo?.supportsStreaming ??
      readStreamingSupport(providerCapabilities) ??
      true,
  } as const;
  const featureTags = buildFeatureTags(providerCapabilities, modelInfo, contextWindow);
  const economics = {
    inputPricePerMillion: modelInfo?.inputPricePerMillion,
    outputPricePerMillion: modelInfo?.outputPricePerMillion,
  };

  const snapshot: ProviderIntelligenceSnapshot = {
    providerName,
    providerLabel: providerLabel ?? providerName,
    modelId,
    contextWindow,
    maxMessages: resolveMaxMessages(contextWindow),
    strengths: buildStrengths(contextWindow, capabilities, featureTags),
    limitations: buildLimitations(contextWindow, capabilities, featureTags),
    behavioralHints: buildBehavioralHints(capabilities, featureTags),
    featureTags,
    workloadScores: {
      planning: 0,
      implementation: 0,
      review: 0,
      analysis: 0,
      debugging: 0,
      documentation: 0,
      coordination: 0,
    },
    economics,
    capabilities,
  };

  return {
    ...snapshot,
    workloadScores: deriveWorkloadScores(snapshot),
  };
}

function getTopWorkloads(
  workloadScores: Record<ProviderWorkload, number>,
  max = 3,
): string[] {
  return (Object.entries(workloadScores) as Array<[ProviderWorkload, number]>)
    .sort(([, left], [, right]) => right - left)
    .slice(0, max)
    .map(([workload, score]) => `${workload} (${score.toFixed(2)})`);
}

/**
 * Build a provider intelligence section for the system prompt.
 * Returns a string to inject into the system prompt.
 */
export function buildProviderIntelligence(
  providerName: string,
  modelId?: string,
  modelIntelligence?: ModelIntelligenceLookup,
  providerCapabilities?: ProviderCapabilities | ProviderCapabilitySnapshot,
  providerLabel?: string,
): string {
  const snapshot = getProviderIntelligenceSnapshot(
    providerName,
    modelId,
    modelIntelligence,
    providerCapabilities,
    providerLabel,
  );

  const lines: string[] = [
    "\n## Current Provider Intelligence",
    `Provider: ${snapshot.providerLabel}`,
    `Model: ${snapshot.modelId ?? "default"}`,
    `Context Window: ${formatContextWindow(snapshot.contextWindow)} tokens`,
    `Recommended Max Messages: ${snapshot.maxMessages}`,
    `Top Roles: ${getTopWorkloads(snapshot.workloadScores).join(", ")}`,
    `Feature Tags: ${snapshot.featureTags.join(", ") || "none"}`,
    `Capabilities: thinking=${snapshot.capabilities.supportsThinking ? "yes" : "no"}, tool_calling=${snapshot.capabilities.supportsToolCalling ? "yes" : "no"}, vision=${snapshot.capabilities.supportsVision ? "yes" : "no"}, streaming=${snapshot.capabilities.supportsStreaming ? "yes" : "no"}`,
  ];

  const inputPrice = formatPrice(snapshot.economics.inputPricePerMillion);
  const outputPrice = formatPrice(snapshot.economics.outputPricePerMillion);
  if (inputPrice !== undefined || outputPrice !== undefined) {
    lines.push(`Pricing (per 1M tokens): input=${inputPrice ?? "unknown"}, output=${outputPrice ?? "unknown"}`);
  }

  if (snapshot.strengths.length > 0) {
    lines.push(`Strengths: ${snapshot.strengths.join(", ")}`);
  }

  if (snapshot.limitations.length > 0) {
    lines.push(`Limitations: ${snapshot.limitations.join(", ")}`);
  }

  if (snapshot.behavioralHints.length > 0) {
    lines.push(`Hints: ${snapshot.behavioralHints.join(". ")}`);
  }

  return lines.join("\n");
}

/**
 * Get recommended max messages for conversation trimming based on provider.
 */
export function getRecommendedMaxMessages(
  providerName: string,
  modelId?: string,
  modelIntelligence?: ModelIntelligenceLookup,
  providerCapabilities?: ProviderCapabilities | ProviderCapabilitySnapshot,
  providerLabel?: string,
): number {
  return getProviderIntelligenceSnapshot(
    providerName,
    modelId,
    modelIntelligence,
    providerCapabilities,
    providerLabel,
  ).maxMessages;
}
