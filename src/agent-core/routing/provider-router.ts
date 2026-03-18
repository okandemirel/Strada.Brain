/**
 * Provider Router
 *
 * Scores each available provider against a TaskClassification using
 * configurable routing presets and live provider intelligence snapshots.
 * Zero overhead when only one provider is available.
 */

import type {
  TaskClassification,
  RoutingPreset,
  RoutingWeights,
  RoutingDecision,
  TaskType,
} from "./routing-types.js";
import { ROUTING_PRESETS } from "./routing-presets.js";
import type { ProviderCapabilities } from "../../agents/providers/provider.interface.js";
import {
  getProviderIntelligenceSnapshot,
  type ModelIntelligenceLookup,
  type ProviderWorkload,
} from "../../agents/providers/provider-knowledge.js";

/* ------------------------------------------------------------------ */
/*  Provider Manager structural interface (avoids hard coupling)      */
/* ------------------------------------------------------------------ */

export interface ProviderManagerRef {
  listAvailable(): Array<{ name: string; label: string; defaultModel: string }>;
  listExecutionCandidates?(identityKey?: string): Array<{
    name: string;
    label: string;
    defaultModel: string;
    capabilities?: ProviderCapabilities | null;
  }>;
  describeAvailable?(): Array<{
    name: string;
    label: string;
    defaultModel: string;
    capabilities: ProviderCapabilities | null;
  }>;
  getProviderCapabilities?(name: string, model?: string): ProviderCapabilities | undefined;
  isAvailable(name: string): boolean;
}

/* ------------------------------------------------------------------ */
/*  TierRouter structural interface (facade — avoids hard coupling)   */
/* ------------------------------------------------------------------ */

/** Structural reference to TierRouter for delegation escalation compatibility */
export interface TierRouterRef {
  resolveProviderConfig(tier: string): { name: string; model: string };
  getEscalationTier(tier: string): string | null;
  getTypeEffectiveTier(type: string, defaultTier: string): string;
}

const MAX_DECISIONS = 100;

type AvailableProvider = {
  name: string;
  label: string;
  defaultModel: string;
  capabilities?: ProviderCapabilities | null;
};

const TASK_TYPE_TO_WORKLOAD: Record<TaskType, ProviderWorkload> = {
  planning: "planning",
  "code-generation": "implementation",
  "code-review": "review",
  "simple-question": "coordination",
  analysis: "analysis",
  refactoring: "implementation",
  "destructive-operation": "debugging",
  debugging: "debugging",
};

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export class ProviderRouter {
  private weights: RoutingWeights;
  private presetName: string;
  private readonly decisions: RoutingDecision[] = [];
  private lastExecutingProvider: string | undefined;
  private readonly modelIntelligence?: ModelIntelligenceLookup;

  /** Optional TierRouter for delegation escalation compatibility */
  private tierRouter?: TierRouterRef;

  constructor(
    private readonly providerManager: ProviderManagerRef,
    preset: RoutingPreset = "balanced",
    options: {
      modelIntelligence?: ModelIntelligenceLookup;
    } = {},
  ) {
    this.weights = ROUTING_PRESETS[preset];
    this.presetName = preset;
    this.modelIntelligence = options.modelIntelligence;
  }

  /**
   * Attach a TierRouter instance for delegation-aware tier resolution.
   * Non-breaking: DelegationManager still uses TierRouter directly.
   */
  setTierRouter(router: TierRouterRef): void {
    this.tierRouter = router;
  }

  /**
   * Resolve provider for a delegation tier (delegates to TierRouter if available).
   * Returns null when no TierRouter is wired, allowing callers to fall back.
   */
  resolveForTier(tier: string): { name: string; model: string } | null {
    return this.tierRouter?.resolveProviderConfig(tier) ?? null;
  }

  /**
   * Get the next-higher escalation tier (delegates to TierRouter).
   * Returns null when no TierRouter is wired or tier is at the top of the chain.
   */
  getEscalationTier(tier: string): string | null {
    return this.tierRouter?.getEscalationTier(tier) ?? null;
  }

  /**
   * Get the effective tier for a delegation type, considering overrides.
   * Returns the defaultTier when no TierRouter is wired.
   */
  getTypeEffectiveTier(type: string, defaultTier: string): string {
    return this.tierRouter?.getTypeEffectiveTier(type, defaultTier) ?? defaultTier;
  }

  /**
   * Select the best provider for a task.
   * If `phase` is "reflecting", diversity weight is boosted to prefer
   * a different provider than the last executing one.
   */
  resolve(
    task: TaskClassification,
    phase?: string,
    options: {
      identityKey?: string;
      allowedProviderNames?: readonly string[];
    } = {},
  ): RoutingDecision {
    const available = this.getAvailableProviders(options);

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
      const score = this.scoreProvider(entry, task, weights, available);
      if (score > bestScore) {
        bestScore = score;
        bestProvider = entry.name;
        bestReason = this.buildReason(entry, task, weights);
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
    entry: AvailableProvider,
    task: TaskClassification,
    weights: RoutingWeights,
    available: readonly AvailableProvider[],
  ): number {
    const cost = this.costScore(entry, available);
    const capability = this.capabilityScore(entry, task);
    const speed = this.speedScore(entry);
    const diversity = this.diversityScore(entry.name);

    return (
      weights.costWeight * cost +
      weights.capabilityWeight * capability +
      weights.speedWeight * speed +
      weights.diversityWeight * diversity
    );
  }

  private getAvailableProviders(options: {
    identityKey?: string;
    allowedProviderNames?: readonly string[];
  }): AvailableProvider[] {
    const allowedNames = options.allowedProviderNames
      ? new Set(options.allowedProviderNames.map((name) => name.trim().toLowerCase()).filter(Boolean))
      : null;

    const base =
      this.providerManager.listExecutionCandidates?.(options.identityKey)?.map((entry) => ({
        ...entry,
        capabilities: entry.capabilities ?? this.providerManager.getProviderCapabilities?.(entry.name, entry.defaultModel) ?? null,
      }))
      ?? this.getDefaultAvailableProviders();

    if (!allowedNames) {
      return base;
    }

    const filtered = base.filter((entry) => allowedNames.has(entry.name.trim().toLowerCase()));
    return filtered.length > 0 ? filtered : base;
  }

  private getDefaultAvailableProviders(): AvailableProvider[] {
    if (this.providerManager.describeAvailable) {
      return this.providerManager.describeAvailable();
    }
    return this.providerManager.listAvailable().map((entry) => ({
      ...entry,
      capabilities: this.providerManager.getProviderCapabilities?.(entry.name, entry.defaultModel) ?? null,
    }));
  }

  private getSnapshot(entry: AvailableProvider) {
    return getProviderIntelligenceSnapshot(
      entry.name,
      entry.defaultModel,
      this.modelIntelligence,
      entry.capabilities ?? this.providerManager.getProviderCapabilities?.(entry.name, entry.defaultModel),
      entry.label,
    );
  }

  private normalizeContextWindow(tokens: number): number {
    return Math.min(Math.log10(Math.max(tokens, 4_000)) / Math.log10(1_000_000), 1.0);
  }

  private getWorkload(taskType: TaskType): ProviderWorkload {
    return TASK_TYPE_TO_WORKLOAD[taskType];
  }

  private getFeatureFit(entry: AvailableProvider, task: TaskClassification): number {
    const snapshot = this.getSnapshot(entry);
    if (!snapshot) {
      return 0.3;
    }

    const features = new Set(snapshot.featureTags.map((tag) => tag.toLowerCase()));
    const search = features.has("search") || features.has("grounding") || features.has("web-search") ? 1 : 0;
    const coding = features.has("coding") || features.has("implementation") || features.has("agentic-coding") || features.has("code-execution") ? 1 : 0;
    const reviewer = features.has("reviewer") || features.has("prompt-caching") || features.has("context-caching") ? 1 : 0;
    const speed = features.has("fast-inference") || features.has("latency-sensitive") ? 1 : 0.5;
    const cheapness = this.costScore(entry, [entry]);

    switch (task.type) {
      case "planning":
        return (Number(snapshot.capabilities.supportsThinking) + search + reviewer) / 3;
      case "code-generation":
      case "refactoring":
        return (Number(snapshot.capabilities.supportsToolCalling) + coding + speed) / 3;
      case "code-review":
        return (Number(snapshot.capabilities.supportsThinking) + reviewer + Number(snapshot.capabilities.supportsToolCalling)) / 3;
      case "analysis":
        return (search + Number(snapshot.capabilities.supportsVision) + Number(snapshot.capabilities.supportsThinking)) / 3;
      case "debugging":
      case "destructive-operation":
        return (Number(snapshot.capabilities.supportsThinking) + Number(snapshot.capabilities.supportsToolCalling) + coding) / 3;
      case "simple-question":
        return (speed + cheapness + Number(snapshot.capabilities.supportsStreaming)) / 3;
      default:
        return 0.5;
    }
  }

  /** Inverse cost: cheaper → higher score (0..1). Uses live model pricing when available. */
  private costScore(entry: AvailableProvider, available: readonly AvailableProvider[]): number {
    const priced = available
      .map((provider) => this.getSnapshot(provider)?.economics)
      .map((economics) =>
        economics && (economics.inputPricePerMillion !== undefined || economics.outputPricePerMillion !== undefined)
          ? (economics.inputPricePerMillion ?? 0) + (economics.outputPricePerMillion ?? 0)
          : undefined,
      )
      .filter((price): price is number => price !== undefined);

    const snapshot = this.getSnapshot(entry);
    const totalPrice =
      snapshot && (snapshot.economics.inputPricePerMillion !== undefined || snapshot.economics.outputPricePerMillion !== undefined)
        ? (snapshot.economics.inputPricePerMillion ?? 0) + (snapshot.economics.outputPricePerMillion ?? 0)
        : undefined;

    if (totalPrice !== undefined && priced.length >= 2) {
      const min = Math.min(...priced);
      const max = Math.max(...priced);
      if (min === max) {
        return 1;
      }
      return Math.max(0, 1 - (totalPrice - min) / (max - min));
    }

    const features = new Set(snapshot.featureTags.map((tag) => tag.toLowerCase()));
    if (features.has("local-inference") || features.has("privacy") || features.has("offline")) {
      return 1;
    }
    if (features.has("cost-efficient") || features.has("cost-aware")) {
      return 0.8;
    }
    return 0.5;
  }

  /** Capability: workload fit + context window + task-specific feature fit. */
  private capabilityScore(
    entry: AvailableProvider,
    task: TaskClassification,
  ): number {
    const snapshot = this.getSnapshot(entry);
    if (!snapshot) return 0.3;

    const workload = this.getWorkload(task.type);
    const workloadScore = snapshot.workloadScores[workload] ?? 0.4;
    const contextScore = this.normalizeContextWindow(snapshot.contextWindow);
    const featureFit = this.getFeatureFit(entry, task);

    return workloadScore * 0.6 + contextScore * 0.25 + featureFit * 0.15;
  }

  /** Inverse speed tier: faster → higher score (0..1). */
  private speedScore(entry: AvailableProvider): number {
    const snapshot = this.getSnapshot(entry);
    if (snapshot.featureTags.some((tag) => tag === "fast-inference" || tag === "latency-sensitive")) {
      return 1;
    }
    if (snapshot.featureTags.includes("local-inference")) {
      return 0.35;
    }
    return 0.5;
  }

  /** Diversity: bonus for using a different provider than the last one. */
  private diversityScore(name: string): number {
    if (!this.lastExecutingProvider) return 0.5;
    return name === this.lastExecutingProvider ? 0.0 : 1.0;
  }

  private buildReason(
    entry: AvailableProvider,
    task: TaskClassification,
    weights: RoutingWeights,
  ): string {
    const snapshot = this.getSnapshot(entry);
    const parts: string[] = [];
    if (weights.costWeight > 0.3) parts.push("cost-effective");
    if (weights.capabilityWeight > 0.3) parts.push("high-capability");
    if (weights.speedWeight > 0.15) parts.push("fast");
    if (weights.diversityWeight > 0.2) parts.push("diverse");
    const qualifier = parts.length > 0 ? parts.join("+") : "balanced";
    if (!snapshot) {
      return `${qualifier} choice for ${task.type} (${task.complexity})`;
    }

    const workload = this.getWorkload(task.type);
    const topFeatures = snapshot.featureTags.slice(0, 2).join(", ");
    return `${qualifier} choice for ${task.type} (${task.complexity}); ${workload} fit ${snapshot.workloadScores[workload].toFixed(2)}${topFeatures ? ` via ${topFeatures}` : ""}`;
  }

  private recordDecision(decision: RoutingDecision): void {
    this.decisions.push(decision);
    if (this.decisions.length > MAX_DECISIONS) {
      this.decisions.shift();
    }
  }
}
