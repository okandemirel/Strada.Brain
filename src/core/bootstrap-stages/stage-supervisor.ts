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
function buildProviderDescriptors(providerManager: ProviderManager): SupervisorProviderDescriptor[] {
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

    return {
      name: entry.name,
      model: entry.defaultModel,
      scores,
    };
  });
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
  },
  deps: SupervisorStageDeps = {},
): SupervisorStageResult {
  if (!params.config.supervisor.enabled) {
    params.logger.debug("Supervisor Brain disabled by configuration");
    return { supervisorBrain: undefined };
  }

  if (!params.goalDecomposer) {
    params.logger.warn("Supervisor Brain requires GoalDecomposer but none available; skipping");
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
    const providerAssigner = deps.createProviderAssigner?.(descriptors)
      ?? new ProviderAssigner(descriptors);
    const verifyNode = createSupervisorNodeVerifier(params.providerManager);

    // 5. Inject runtime context into the decomposer so it can make
    //    cost-aware, provider-aware decisions about goal granularity
    //    (OpenClaw-inspired: match decomposition to available resources).
    params.goalDecomposer.setDecompositionContext({
      providerCount: descriptors.length,
      maxTotalNodes: descriptors.length <= 1 ? 8 : 12,
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
    params.logger.warn("Supervisor Brain initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { supervisorBrain: undefined };
  }
}
