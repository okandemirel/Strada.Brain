/**
 * ProviderAssigner - Capability-based provider scoring and assignment
 *
 * Scores available providers against capability profiles and assigns
 * the best-fit provider per goal node. Supports hard filters (vision,
 * health), soft rules (diversity cap, dependency affinity), and
 * rate-limit deprioritization.
 */

import type {
  CapabilityProfile,
  CapabilityTag,
  ProviderScore,
  TaggedGoalNode,
} from "./supervisor-types.js";

// =============================================================================
// PROVIDER DESCRIPTOR
// =============================================================================

/** Describes a provider's capabilities and health status */
export interface ProviderDescriptor {
  readonly name: string;
  readonly model: string;
  readonly scores: Record<CapabilityTag, number>; // 0-1 per capability
  readonly healthy?: boolean;       // default true
  readonly nearRateLimit?: boolean; // default false
}

// =============================================================================
// CONSTANTS
// =============================================================================

const CAPABILITY_WEIGHT = 0.5;
const PREFERENCE_WEIGHT = 0.4;
const HISTORY_WEIGHT = 0.1;
const DEFAULT_HISTORY_SCORE = 0.5;
const RATE_LIMIT_PENALTY = 0.5;
const DEFAULT_DIVERSITY_CAP = 0.6;
const AFFINITY_THRESHOLD = 0.1; // 10% score difference for dependency affinity

// =============================================================================
// PROVIDER ASSIGNER
// =============================================================================

export class ProviderAssigner {
  private readonly providers: readonly ProviderDescriptor[];
  private readonly historyMap: Map<string, Map<string, number>> = new Map();

  constructor(providers: readonly ProviderDescriptor[]) {
    this.providers = providers;
  }

  // ---------------------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------------------

  /**
   * Score a single provider against a capability profile.
   * Returns -1 if the provider is eliminated by hard filters.
   */
  scoreProvider(provider: ProviderDescriptor, capabilityProfile: CapabilityProfile): number {
    // Hard filter: eliminate providers missing required capabilities
    for (const tag of capabilityProfile.primary) {
      if (provider.scores[tag] === 0) {
        return -1; // eliminated
      }
    }

    // 1. Weighted capability score (60%)
    const capScore =
      capabilityProfile.primary.length > 0
        ? (capabilityProfile.primary.reduce((sum, tag) => sum + provider.scores[tag], 0) /
            capabilityProfile.primary.length) *
          CAPABILITY_WEIGHT
        : 0;

    // 2. Preference score (30%)
    const prefScore = provider.scores[capabilityProfile.preference] * PREFERENCE_WEIGHT;

    // 3. History bonus (10%) - defaults to 0.5 if no history
    const historyScore = this.getSuccessRate(provider.name, capabilityProfile.primary) * HISTORY_WEIGHT;

    let total = capScore + prefScore + historyScore;

    // Rate-limit deprioritization: reduce score by 50%
    if (provider.nearRateLimit) {
      total *= RATE_LIMIT_PENALTY;
    }

    return total;
  }

  /**
   * Assign the best provider to a single node.
   * Returns the node with assignedProvider and assignedModel set.
   */
  assignNode(node: TaggedGoalNode): TaggedGoalNode {
    const ranked = this.getRankedProviders(node);

    if (ranked.length === 0) {
      // No eligible provider — return unassigned
      return node;
    }

    const best = ranked[0]!;
    return {
      ...node,
      assignedProvider: best.providerName,
      assignedModel: best.model,
    };
  }

  /**
   * Assign providers to all nodes with diversity enforcement.
   * diversityCap limits the fraction of nodes any single provider can receive.
   */
  assignNodes(nodes: TaggedGoalNode[], diversityCap: number = DEFAULT_DIVERSITY_CAP): TaggedGoalNode[] {
    if (nodes.length === 0) return [];

    const maxPerProvider = Math.max(1, Math.ceil(nodes.length * diversityCap));

    // Track how many nodes each provider has been assigned
    const assignmentCounts = new Map<string, number>();

    // Pre-compute ranked providers for each node
    const nodeRankings = nodes.map((node) => ({
      node,
      ranked: this.getRankedProviders(node),
    }));

    // Build dependency adjacency for affinity scoring
    const depEdges = this.buildDependencyEdges(nodes);

    const results: TaggedGoalNode[] = [];
    // O(1) lookup map for assigned nodes (kept in sync with results array)
    const assignedMap = new Map<string, TaggedGoalNode>();

    for (const { node, ranked } of nodeRankings) {
      if (ranked.length === 0) {
        results.push(node);
        assignedMap.set(node.id as string, node);
        continue;
      }

      // Find best provider that hasn't exceeded diversity cap
      let assigned = false;

      for (const candidate of ranked) {
        const currentCount = assignmentCounts.get(candidate.providerName) ?? 0;

        if (currentCount >= maxPerProvider) {
          continue; // diversity cap reached for this provider
        }

        // Dependency affinity: if a dependent node was already assigned,
        // prefer the same provider when scores are within threshold
        const affinityProvider = this.getAffinityProvider(node, depEdges, assignedMap);
        if (
          affinityProvider &&
          affinityProvider !== candidate.providerName &&
          ranked.length > 1
        ) {
          // Check if the affinity provider is close enough in score
          const affinityCandidate = ranked.find((r) => r.providerName === affinityProvider);
          if (
            affinityCandidate &&
            candidate.score - affinityCandidate.score <= candidate.score * AFFINITY_THRESHOLD
          ) {
            const affinityCount = assignmentCounts.get(affinityProvider) ?? 0;
            if (affinityCount < maxPerProvider) {
              // Use the affinity provider instead
              const assignedNode = {
                ...node,
                assignedProvider: affinityProvider,
                assignedModel: affinityCandidate.model,
              };
              results.push(assignedNode);
              assignedMap.set(node.id as string, assignedNode);
              assignmentCounts.set(affinityProvider, affinityCount + 1);
              assigned = true;
              break;
            }
          }
        }

        // Normal assignment
        const assignedNode = {
          ...node,
          assignedProvider: candidate.providerName,
          assignedModel: candidate.model,
        };
        results.push(assignedNode);
        assignedMap.set(node.id as string, assignedNode);
        assignmentCounts.set(candidate.providerName, currentCount + 1);
        assigned = true;
        break;
      }

      if (!assigned && ranked.length > 0) {
        // All providers at cap — fall back to best available (allow overflow)
        const best = ranked[0]!;
        const assignedNode = {
          ...node,
          assignedProvider: best.providerName,
          assignedModel: best.model,
        };
        results.push(assignedNode);
        assignedMap.set(node.id as string, assignedNode);
        const count = assignmentCounts.get(best.providerName) ?? 0;
        assignmentCounts.set(best.providerName, count + 1);
      }
    }

    return results;
  }

  /**
   * Return ranked provider alternatives for a node, sorted descending by score.
   * Excludes unhealthy and eliminated (score === -1) providers.
   */
  getRankedProviders(node: TaggedGoalNode): ProviderScore[] {
    const candidates = this.getHealthyProviders();
    const scored: ProviderScore[] = [];

    for (const provider of candidates) {
      const profile = node.capabilityProfile;
      const totalScore = this.scoreProvider(provider, profile);

      if (totalScore < 0) {
        continue; // eliminated by hard filter
      }

      // Compute breakdown for transparency
      const capScore =
        profile.primary.length > 0
          ? profile.primary.reduce((sum, tag) => sum + provider.scores[tag], 0) /
            profile.primary.length
          : 0;
      const prefScore = provider.scores[profile.preference];
      const historyScore = this.getSuccessRate(provider.name, profile.primary);

      scored.push({
        providerName: provider.name,
        model: provider.model,
        score: totalScore,
        breakdown: {
          capabilityScore: capScore,
          preferenceScore: prefScore,
          historyScore,
        },
      });
    }

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    return scored;
  }

  // ---------------------------------------------------------------------------
  // HISTORY TRACKING (optional enrichment)
  // ---------------------------------------------------------------------------

  /**
   * Record a success/failure for a provider on given capability tags.
   * Used to build the history bonus over time.
   */
  recordOutcome(providerName: string, tags: CapabilityTag[], success: boolean): void {
    if (!this.historyMap.has(providerName)) {
      this.historyMap.set(providerName, new Map());
    }
    const providerHistory = this.historyMap.get(providerName)!;

    for (const tag of tags) {
      const key = tag;
      const current = providerHistory.get(key) ?? DEFAULT_HISTORY_SCORE;
      // Exponential moving average
      const update = success ? 1 : 0;
      const alpha = 0.3;
      providerHistory.set(key, current * (1 - alpha) + update * alpha);
    }
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  /** Filter to only healthy providers */
  private getHealthyProviders(): ProviderDescriptor[] {
    return this.providers.filter((p) => p.healthy !== false);
  }

  /** Get success rate for a provider across given tags */
  private getSuccessRate(providerName: string, tags: CapabilityTag[]): number {
    const providerHistory = this.historyMap.get(providerName);
    if (!providerHistory || tags.length === 0) {
      return DEFAULT_HISTORY_SCORE;
    }

    let sum = 0;
    let count = 0;
    for (const tag of tags) {
      const rate = providerHistory.get(tag);
      if (rate !== undefined) {
        sum += rate;
        count++;
      }
    }

    return count > 0 ? sum / count : DEFAULT_HISTORY_SCORE;
  }

  /** Build a set of dependency edges from nodes */
  private buildDependencyEdges(nodes: TaggedGoalNode[]): Map<string, string[]> {
    const edges = new Map<string, string[]>();
    for (const node of nodes) {
      if (node.dependsOn.length > 0) {
        edges.set(node.id, node.dependsOn.map(String));
      }
    }
    return edges;
  }

  /** Find provider of a dependency that was already assigned */
  private getAffinityProvider(
    node: TaggedGoalNode,
    depEdges: Map<string, string[]>,
    assignedMap: Map<string, TaggedGoalNode>,
  ): string | undefined {
    const deps = depEdges.get(node.id);
    if (!deps || deps.length === 0) return undefined;

    // Find first assigned dependency via O(1) Map lookup
    for (const depId of deps) {
      const depNode = assignedMap.get(depId);
      if (depNode?.assignedProvider) {
        return depNode.assignedProvider;
      }
    }

    return undefined;
  }
}
