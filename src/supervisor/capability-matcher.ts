/**
 * Supervisor Brain - Capability Matcher
 *
 * Two-phase capability analysis for GoalNode sub-tasks:
 *   Phase 1: Heuristic first-pass (0ms, $0) using keyword signal dictionaries
 *   Phase 2: Cheap LLM triage for ambiguous nodes only (~$0.001/node)
 *
 * Assigns CapabilityProfile (primary tags + preference + confidence) to each node
 * so the ProviderRouter can select the best provider/model combination.
 */

import type { GoalNode } from "../goals/types.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import type { CapabilityTag, CapabilityProfile, TaggedGoalNode } from "./supervisor-types.js";

// =============================================================================
// SIGNAL DICTIONARIES
// =============================================================================

/** Keywords that indicate vision/image processing capability is needed */
const VISION_SIGNALS: readonly string[] = [
  "image", "photo", "screenshot", "visual", "thumbnail", "upload", "picture", "diagram",
];

/** Keywords that indicate deep reasoning/analysis capability is needed */
const REASONING_SIGNALS: readonly string[] = [
  "analyze", "debug", "investigate", "why", "trace", "evaluate", "compare", "assess",
];

/** Keywords that indicate code generation capability is needed */
const CODEGEN_SIGNALS: readonly string[] = [
  "implement", "create", "build", "write code", "add feature", "refactor", "migrate",
];

/** Keywords that indicate tool use capability is needed */
const TOOL_SIGNALS: readonly string[] = [
  "search", "find files", "run tests", "execute", "deploy", "install",
];

/** Keywords that indicate speed preference */
const SPEED_SIGNALS: readonly string[] = [
  "quick", "fast", "simple check", "lint", "format",
];

/** Keywords that indicate quality preference */
const QUALITY_SIGNALS: readonly string[] = [
  "critical", "production", "security", "review carefully",
];

/** Keywords that indicate cost preference */
const COST_SIGNALS: readonly string[] = [
  "simple", "straightforward", "basic", "trivial",
];

// =============================================================================
// SIGNAL → TAG MAPPING
// =============================================================================

interface SignalMapping {
  readonly signals: readonly string[];
  readonly tag: CapabilityTag;
}

const CAPABILITY_MAPPINGS: readonly SignalMapping[] = [
  { signals: VISION_SIGNALS, tag: "vision" },
  { signals: REASONING_SIGNALS, tag: "reasoning" },
  { signals: CODEGEN_SIGNALS, tag: "code-gen" },
  { signals: TOOL_SIGNALS, tag: "tool-use" },
];

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Count how many signal keywords appear in the given text (case-insensitive).
 * Multi-word signals use substring matching; single-word signals use word boundary matching.
 */
function countMatches(text: string, signals: readonly string[]): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const signal of signals) {
    if (signal.includes(" ")) {
      // Multi-word: simple substring match
      if (lower.includes(signal)) count++;
    } else {
      // Single-word: word boundary match to avoid false positives
      const re = new RegExp(`\\b${signal}\\b`, "i");
      if (re.test(lower)) count++;
    }
  }
  return count;
}

/**
 * Determine the preference from signal matches.
 * Priority: speed > cost > quality (default).
 */
function detectPreference(text: string): "speed" | "cost" | "quality" {
  if (countMatches(text, SPEED_SIGNALS) > 0) return "speed";
  if (countMatches(text, COST_SIGNALS) > 0) return "cost";
  if (countMatches(text, QUALITY_SIGNALS) > 0) return "quality";
  return "quality";
}

// =============================================================================
// DEFAULT PROFILE
// =============================================================================

const DEFAULT_PROFILE: CapabilityProfile = {
  primary: ["code-gen"],
  preference: "quality",
  confidence: 0.3,
  source: "heuristic",
};

// =============================================================================
// CAPABILITY MATCHER
// =============================================================================

export class CapabilityMatcher {
  private readonly triageProvider: IAIProvider | undefined;

  constructor(triageProvider?: IAIProvider) {
    this.triageProvider = triageProvider;
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Heuristic First-Pass
  // ---------------------------------------------------------------------------

  /**
   * Synchronous heuristic matching using keyword signal dictionaries.
   *
   * Confidence thresholds:
   *   - total matchCount >= 2 or any single category >= 2 -> 0.9 (finalized)
   *   - total matchCount == 1 -> 0.7 (tag added, LLM can verify)
   *   - total matchCount == 0 -> 0.3 (sent to LLM triage)
   *
   * Default fallback: if no primary tags, assign ["code-gen"].
   * Default preference: "quality" unless speed/cost signals detected.
   */
  matchHeuristic(node: GoalNode): CapabilityProfile {
    const text = node.task;
    const primary: CapabilityTag[] = [];
    let totalMatchCount = 0;

    for (const mapping of CAPABILITY_MAPPINGS) {
      const count = countMatches(text, mapping.signals);
      if (count > 0) {
        primary.push(mapping.tag);
        totalMatchCount += count;
      }
    }

    // Default fallback: no primary tags -> code-gen
    if (primary.length === 0) {
      return {
        ...DEFAULT_PROFILE,
        preference: detectPreference(text),
      };
    }

    // Confidence based on total match count
    const confidence = totalMatchCount >= 2 ? 0.9 : 0.7;

    return {
      primary,
      preference: detectPreference(text),
      confidence,
      source: "heuristic",
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 2: LLM Triage (ambiguous nodes only)
  // ---------------------------------------------------------------------------

  /**
   * Batch LLM triage for ambiguous nodes.
   * Sends all ambiguous tasks in a single prompt requesting structured JSON.
   * Falls back to default profile if no provider or on failure.
   */
  async matchWithTriage(nodes: GoalNode[]): Promise<CapabilityProfile[]> {
    if (!this.triageProvider || nodes.length === 0) {
      return nodes.map(() => ({ ...DEFAULT_PROFILE }));
    }

    const systemPrompt = [
      "You are a capability tagger for an AI task router.",
      "For each task, determine which capabilities are needed and the preference.",
      "Capabilities: reasoning, vision, code-gen, tool-use, long-context, speed, cost, quality, creative.",
      "Preferences: speed, cost, quality.",
      "Respond with a JSON array, one entry per task, each with:",
      '  {"capabilities": ["..."], "preference": "speed|cost|quality"}',
      "Return ONLY the JSON array, no markdown fences or extra text.",
    ].join("\n");

    const taskList = nodes
      .map((n, i) => `${i + 1}. ${n.task}`)
      .join("\n");

    try {
      const response = await this.triageProvider.chat(
        systemPrompt,
        [{ role: "user", content: `Classify these tasks:\n${taskList}` }],
        [],
      );

      const text = response.text.trim();
      // Strip markdown fences if present
      const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
      const cleaned = fenceMatch?.[1]?.trim() ?? text;

      const parsed = JSON.parse(cleaned) as Array<{
        capabilities: string[];
        preference: string;
      }>;

      return nodes.map((_, i) => {
        const entry = parsed[i];
        if (!entry) return { ...DEFAULT_PROFILE, source: "llm-triage" as const };

        const validTags = (entry.capabilities ?? []).filter(
          (c): c is CapabilityTag =>
            [
              "reasoning", "vision", "code-gen", "tool-use",
              "long-context", "speed", "cost", "quality", "creative",
            ].includes(c),
        );

        const pref = (["speed", "cost", "quality"] as const).includes(
          entry.preference as any,
        )
          ? (entry.preference as "speed" | "cost" | "quality")
          : "quality";

        return {
          primary: validTags.length > 0 ? validTags : ["code-gen" as CapabilityTag],
          preference: pref,
          confidence: 0.85,
          source: "llm-triage" as const,
        };
      });
    } catch {
      // LLM call failed — fall back to defaults
      return nodes.map(() => ({ ...DEFAULT_PROFILE, source: "llm-triage" as const }));
    }
  }

  // ---------------------------------------------------------------------------
  // Full Pipeline: Heuristic + Triage
  // ---------------------------------------------------------------------------

  /**
   * Process an array of GoalNodes through the full two-phase pipeline:
   *   1. Heuristic pass on all nodes
   *   2. LLM triage only for nodes with confidence < 0.7
   *   3. Merge results into TaggedGoalNodes
   */
  async matchNodes(nodes: GoalNode[]): Promise<TaggedGoalNode[]> {
    // Phase 1: heuristic pass
    const heuristicProfiles = nodes.map((n) => this.matchHeuristic(n));

    // Identify ambiguous nodes (confidence < 0.7)
    const ambiguousIndices: number[] = [];
    const ambiguousNodes: GoalNode[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const profile = heuristicProfiles[i];
      const node = nodes[i];
      if (profile && node && profile.confidence < 0.7) {
        ambiguousIndices.push(i);
        ambiguousNodes.push(node);
      }
    }

    // Phase 2: LLM triage for ambiguous nodes
    let triageProfiles: CapabilityProfile[] = [];
    if (ambiguousNodes.length > 0) {
      triageProfiles = await this.matchWithTriage(ambiguousNodes);
    }

    // Merge: use triage result for ambiguous nodes, heuristic for the rest
    const finalProfiles = [...heuristicProfiles];
    for (let j = 0; j < ambiguousIndices.length; j++) {
      const idx = ambiguousIndices[j]!;
      const triageProfile = triageProfiles[j];
      if (triageProfile) {
        finalProfiles[idx] = {
          ...triageProfile,
          source: triageProfile.source === "llm-triage" ? "llm-triage" : "hybrid",
        };
      }
    }

    // Build TaggedGoalNodes
    return nodes.map((node, i) => ({
      ...node,
      capabilityProfile: finalProfiles[i],
    })) as TaggedGoalNode[];
  }
}
