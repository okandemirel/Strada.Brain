import type * as winston from "winston";
import type { Config } from "../../config/config.js";
import type { ProviderManager } from "../../agents/providers/provider-manager.js";
import type { GoalDecomposer } from "../../goals/index.js";
import type { CapabilityTag } from "../../supervisor/supervisor-types.js";
import { CapabilityMatcher } from "../../supervisor/capability-matcher.js";
import { ProviderAssigner } from "../../supervisor/provider-assigner.js";
import type { ProviderDescriptor as SupervisorProviderDescriptor } from "../../supervisor/provider-assigner.js";
import { SupervisorBrain } from "../../supervisor/supervisor-brain.js";
import { createSupervisorNodeVerifier } from "../../supervisor/supervisor-verification.js";
import { ProviderHealthRegistry } from "../../agents/providers/provider-health.js";
import { getBaselineProfile, STATIC_BASELINE_PROFILES, BehavioralDimension } from "../../agents/providers/provider-behavioral-profiles.js";

// =============================================================================
// STAGE RESULT
// =============================================================================

export interface SupervisorStageResult {
  supervisorBrain?: SupervisorBrain;
}

// =============================================================================
// STAGE DEPS (for testability)
// =============================================================================

export interface SupervisorStageDeps {
  createCapabilityMatcher?: (triageProvider?: import("../../agents/providers/provider.interface.js").IAIProvider) => CapabilityMatcher;
  createProviderAssigner?: (descriptors: readonly SupervisorProviderDescriptor[]) => ProviderAssigner;
  createSupervisorBrain?: (options: ConstructorParameters<typeof SupervisorBrain>[0]) => SupervisorBrain;
  buildProviderDescriptors?: (providerManager: ProviderManager) => SupervisorProviderDescriptor[];
}

// =============================================================================
// PROVIDER DESCRIPTOR BUILDER
// =============================================================================

/** Baseline capability scores for a generic provider */
const BASELINE_SCORES: Record<CapabilityTag, number> = {
  "reasoning": 0.5,
  "vision": 0.0,
  "code-gen": 0.5,
  "tool-use": 0.5,
  "long-context": 0.5,
  "speed": 0.5,
  "cost": 0.5,
  "quality": 0.5,
  "creative": 0.5,
};

/**
 * Build supervisor-compatible provider descriptors from available providers.
 *
 * Maps ProviderManager's capability info into the ProviderAssigner's scoring
 * format.  Uses provider capabilities (vision, thinking, context window) to
 * adjust scores above the baseline when available.
 */
export function buildProviderDescriptors(providerManager: ProviderManager): SupervisorProviderDescriptor[] {
  // (behavioral profiles imported at module scope below)
  const available = providerManager.listAvailable();
  return available.map((entry) => {
    const capabilities = providerManager.getProviderCapabilities(entry.name, entry.defaultModel);
    const scores: Record<CapabilityTag, number> = { ...BASELINE_SCORES };

    if (capabilities) {
      // Vision capability
      if (capabilities.vision) {
        scores["vision"] = 0.9;
      }

      // Tool calling
      if (capabilities.toolCalling) {
        scores["tool-use"] = 0.8;
      }

      // Extended thinking / reasoning
      if (capabilities.thinkingSupported) {
        scores["reasoning"] = 0.85;
        scores["quality"] = 0.8;
      }

      // Large context window
      if (capabilities.contextWindow && capabilities.contextWindow >= 128_000) {
        scores["long-context"] = 0.9;
      } else if (capabilities.contextWindow && capabilities.contextWindow >= 32_000) {
        scores["long-context"] = 0.7;
      }

      // Code generation: providers with tool calling tend to be better at code
      if (capabilities.toolCalling) {
        scores["code-gen"] = 0.7;
      }
    }

    // BEHAVIORAL PROFILES: the binary flags above say what a provider CAN do,
    // not what it is GOOD at — every tool-calling model scored identically, so
    // the supervisor distributed nodes by availability rather than strength.
    // The 12-dimension profiles (claude: planning/review, openai:
    // implementation/debugging, …) already exist for the router; map them onto
    // the supervisor's tags so the hardest node goes to the strongest model.
    const behavioral = STATIC_BASELINE_PROFILES.get(entry.name.toLowerCase());
    if (behavioral) {
      const d = behavioral.scores;
      const lift = (tag: CapabilityTag, value: number): void => {
        scores[tag] = Math.max(scores[tag], value);
      };
      lift("reasoning", (d[BehavioralDimension.complexReasoning] + d[BehavioralDimension.deepPlanning]) / 2);
      lift("code-gen", (d[BehavioralDimension.codeRefactoring] + d[BehavioralDimension.fastExecution]) / 2);
      lift("tool-use", d[BehavioralDimension.toolCallReliability]);
      lift("speed", d[BehavioralDimension.fastExecution]);
      lift("cost", d[BehavioralDimension.costEfficiency]);
      lift("long-context", d[BehavioralDimension.contextManagement]);
      lift("quality", (d[BehavioralDimension.deepPlanning] + d[BehavioralDimension.errorRecovery]) / 2);
      lift("creative", d[BehavioralDimension.intentUnderstanding]);
    }

    return {
      name: entry.name,
      model: entry.defaultModel,
      scores,
    };
  });
}

// =============================================================================
// PROVIDER BEHAVIORAL SUMMARY
// =============================================================================

/**
 * Build a language-agnostic summary of the primary provider's behavioral
 * strengths and weaknesses from its baseline profile.  Returns undefined if
 * no profile is available (graceful degradation).
 *
 * Format: "Primary provider: kimi. Strengths: agent swarm (0.95), cost
 * efficiency (0.95). Weaknesses: fast execution (0.45), tool reliability (0.50)."
 */
function buildProviderStrengthsSummary(providerName: string | undefined): string | undefined {
  if (!providerName) return undefined;
  try {
    const profile = getBaselineProfile(providerName);
    if (!profile?.scores) return undefined;

    const entries = Object.entries(profile.scores) as Array<[string, number]>;
    if (entries.length === 0) return undefined;

    // Sort descending by score
    const sorted = [...entries].sort(([, a], [, b]) => b - a);
    const top3 = sorted.slice(0, 3);
    const bottom3 = sorted.slice(-3).reverse(); // worst first

    const fmtDim = ([dim, score]: [string, number]): string =>
      `${dim} (${score.toFixed(2)})`;

    const strengths = top3.map(fmtDim).join(", ");
    const weaknesses = bottom3.map(fmtDim).join(", ");

    return `Primary provider: ${providerName}. Strengths: ${strengths}. Weaknesses: ${weaknesses}.`;
  } catch {
    // Profile module may not be loaded yet or provider unknown — degrade gracefully
    return undefined;
  }
}

// =============================================================================
// STAGE FUNCTION
// =============================================================================

/**
 * Initialize the Supervisor Brain stage.
 *
 * Creates the CapabilityMatcher, ProviderAssigner, and SupervisorBrain
 * when supervisor mode is enabled.  The GoalDecomposer is passed in from
 * the goal context stage (not created here).
 */
export function initializeSupervisorStage(
  params: {
    config: Config;
    logger: winston.Logger;
    providerManager: ProviderManager;
    goalDecomposer?: GoalDecomposer;
    /** Live framework API, read from Strada.Core / Modules / MCP themselves.
     *  A getter because the generator is wired asynchronously after this runs. */
    getFrameworkKnowledge?: () => string | null;
    /**
     * Called when the supervisor was ENABLED but could not be built. The
     * notice reaches the boot report and the user's first message; a
     * logger.warn alone left a boot that lost the whole goal-DAG / wave-
     * dispatch path reading "Boot report clean" (audited 2026-09-02).
     */
    onDegraded?: (notice: string) => void;
  },
  deps: SupervisorStageDeps = {},
): SupervisorStageResult {
  if (!params.config.supervisor.enabled) {
    params.logger.debug("Supervisor Brain disabled by configuration");
    return { supervisorBrain: undefined };
  }

  const describeLoss = (cause: string): string =>
    `Supervisor Brain unavailable: ${cause}. Complex tasks and campaign milestones run as a ` +
    "single direct worker this session — no goal DAG, no wave dispatch, no cross-provider " +
    "node verification.";

  if (!params.goalDecomposer) {
    params.logger.warn("Supervisor Brain requires GoalDecomposer but none available; skipping");
    params.onDegraded?.(describeLoss("the GoalDecomposer did not initialize (see the goal-context stage warning)"));
    return { supervisorBrain: undefined };
  }

  try {
    // 1. Resolve optional triage provider for LLM-based capability matching
    const triageProviderName = params.config.supervisor.triageProvider;
    let triageProvider: import("../../agents/providers/provider.interface.js").IAIProvider | undefined;
    try {
      triageProvider = params.providerManager.getProviderByName(triageProviderName) ?? undefined;
    } catch {
      params.logger.warn("Supervisor triage provider not available, using heuristic-only matching", {
        triageProvider: triageProviderName,
      });
    }

    // 2. Create CapabilityMatcher
    const capabilityMatcher = deps.createCapabilityMatcher?.(triageProvider)
      ?? new CapabilityMatcher(triageProvider);

    // 3. Build provider descriptors from available providers
    const descriptors = deps.buildProviderDescriptors?.(params.providerManager)
      ?? buildProviderDescriptors(params.providerManager);

    // 4. Create ProviderAssigner
    // No liveness argument here on purpose: the assigner defaults to the live
    // health registry, so a provider that dies an hour into a run stops being
    // given goals without anything rebuilding these descriptors.
    const providerAssigner = deps.createProviderAssigner?.(descriptors)
      ?? new ProviderAssigner(descriptors);
    const verifyNode = createSupervisorNodeVerifier(params.providerManager);

    // 5. Inject runtime context into the decomposer so it can make
    //    cost-aware, provider-aware decisions about goal granularity
    //    (OpenClaw-inspired: match decomposition to available resources).
    const primaryProvider = descriptors[0]?.name;
    const providerStrengths = buildProviderStrengthsSummary(primaryProvider);
    const contextWindow = primaryProvider
      ? params.providerManager.getProviderCapabilities(primaryProvider, descriptors[0]?.model)?.contextWindow
      : undefined;
    params.goalDecomposer.setDecompositionContext({
      providerCount: descriptors.length,
      // Health-filtered at decomposition time: the static count planned for
      // parallelism while a provider sat in a multi-day quota cooldown.
      liveProviderCount: () => {
        try {
          const live = descriptors.filter((d) =>
            ProviderHealthRegistry.getInstance().isAvailable(d.name),
          ).length;
          return Math.max(1, live);
        } catch {
          return descriptors.length;
        }
      },
      maxTotalNodes: descriptors.length <= 1 ? 8 : 12,
      contextWindow,
      providerStrengths,
      frameworkKnowledge: params.getFrameworkKnowledge,
    });

    // 6. Create SupervisorBrain
    const supervisorBrain = deps.createSupervisorBrain?.({
      config: params.config.supervisor,
      decomposer: params.goalDecomposer,
      capabilityMatcher,
      providerAssigner,
      verifyNode,
    }) ?? new SupervisorBrain({
      config: params.config.supervisor,
      decomposer: params.goalDecomposer,
      capabilityMatcher,
      providerAssigner,
      verifyNode,
    });

    params.logger.info("Supervisor Brain initialized", {
      complexityThreshold: params.config.supervisor.complexityThreshold,
      maxParallelNodes: params.config.supervisor.maxParallelNodes,
      verificationMode: params.config.supervisor.verificationMode,
      availableProviders: descriptors.length,
    });

    return { supervisorBrain };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    params.logger.warn("Supervisor Brain initialization failed", { error: detail });
    params.onDegraded?.(describeLoss(`initialization failed — ${detail}`));
    return { supervisorBrain: undefined };
  }
}
