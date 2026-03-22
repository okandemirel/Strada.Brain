import { join } from "node:path";
import type * as winston from "winston";
import type { Config } from "../../config/config.js";
import type { IMemoryManager } from "../../memory/memory.interface.js";
import type { IRAGPipeline } from "../../rag/rag.interface.js";
import type { MetricsCollector } from "../../dashboard/metrics.js";
import type { LearningStorage, LearningPipeline } from "../../learning/index.js";
import { IdentityStateManager } from "../../identity/identity-state.js";
import { GoalStorage, GoalDecomposer, detectInterruptedTrees } from "../../goals/index.js";
import type { GoalTree } from "../../goals/types.js";
import { buildCrashRecoveryContext } from "../../identity/crash-recovery.js";
import type { CrashRecoveryContext } from "../../identity/crash-recovery.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import { ToolRegistry } from "../tool-registry.js";
import type { ProviderManager } from "../../agents/providers/provider-manager.js";
import type { IEventBus, LearningEventMap } from "../event-bus.js";
import type { LearningQueue } from "../../learning/pipeline/learning-queue.js";
import { MetricsStorage } from "../../metrics/metrics-storage.js";
import { ConfidenceScorer } from "../../learning/index.js";
import {
  ChainDetector,
  ChainSynthesizer,
  ChainManager,
  ChainValidator,
  type ToolChainConfig,
} from "../../learning/chains/index.js";
import type {
  GoalContextStageDeps,
  GoalContextStageResult,
  ToolRegistryStageDeps,
  ToolChainStageDeps,
  ToolChainStageResult,
} from "./bootstrap-stages-types.js";

export function initializeGoalContextStage(
  params: {
    config: Config;
    logger: winston.Logger;
    provider: IAIProvider;
    identityManager?: IdentityStateManager;
  },
  deps: GoalContextStageDeps = {},
): GoalContextStageResult {
  let goalStorage: GoalStorage | undefined;
  let goalDecomposer: GoalDecomposer | undefined;
  try {
    const goalsDbPath = join(params.config.memory.dbPath, "goals.db");
    goalStorage = deps.createGoalStorage?.(goalsDbPath) ?? new GoalStorage(goalsDbPath);
    goalStorage.initialize();
    goalStorage.pruneOldTrees();
    goalDecomposer = deps.createGoalDecomposer?.(params.provider, params.config.goalMaxDepth)
      ?? new GoalDecomposer(params.provider, params.config.goalMaxDepth);
    params.logger.info("GoalDecomposer initialized", {
      dbPath: goalsDbPath,
      maxDepth: params.config.goalMaxDepth,
    });
  } catch (error) {
    params.logger.warn("GoalDecomposer initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let interruptedGoalTrees: GoalTree[] = [];
  if (goalStorage) {
    try {
      interruptedGoalTrees = (deps.detectInterruptedTrees ?? detectInterruptedTrees)(goalStorage);
      if (interruptedGoalTrees.length > 0) {
        params.logger.info("Detected interrupted goal trees", { count: interruptedGoalTrees.length });
      }
    } catch (error) {
      params.logger.debug("Interrupted tree detection failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let crashContext: CrashRecoveryContext | null = null;
  if (params.identityManager) {
    crashContext = (deps.buildCrashRecoveryContext ?? buildCrashRecoveryContext)(
      params.identityManager.wasCrash(),
      params.identityManager.getState(),
      interruptedGoalTrees,
    );
    if (crashContext) {
      params.logger.warn("Unclean shutdown detected", {
        downtimeMs: crashContext.downtimeMs,
        interruptedTrees: crashContext.interruptedTrees.length,
        bootCount: crashContext.bootCount,
      });
    }
  }

  return {
    goalStorage,
    goalDecomposer,
    interruptedGoalTrees,
    crashContext,
    goalExecutorConfig: {
      maxRetries: params.config.goalMaxRetries,
      maxFailures: params.config.goalMaxFailures,
      parallelExecution: params.config.goalParallelExecution,
      maxParallel: params.config.goalMaxParallel,
      maxRedecompositions: params.config.goal.maxRedecompositions,
    },
  };
}

export async function initializeToolRegistryStage(params: {
  toolRegistry: ToolRegistry;
  config: Config;
  memoryManager?: IMemoryManager;
  ragPipeline?: IRAGPipeline;
  metrics: MetricsCollector;
  learningStorage?: LearningStorage;
  metricsStorage?: MetricsStorage;
  getIdentityState?: () => import("../../identity/identity-state.js").IdentityState;
}, deps: ToolRegistryStageDeps = {}): Promise<void> {
  await params.toolRegistry.initialize(params.config, {
    memoryManager: params.memoryManager,
    ragPipeline: params.ragPipeline,
    metricsCollector: params.metrics,
    learningStorage: params.learningStorage,
    metricsStorage: params.metricsStorage,
    getIdentityState: params.getIdentityState,
    getDaemonStatus: deps.getDaemonStatus,
  });
}

export async function initializeToolChainStage(
  params: {
    config: Config;
    logger: winston.Logger;
    learningStorage?: LearningStorage;
    learningEventBus?: IEventBus<LearningEventMap>;
    learningQueue?: LearningQueue;
    learningPipeline?: LearningPipeline;
    toolRegistry: ToolRegistry;
    providerManager: ProviderManager;
    orchestrator: ConstructorParameters<typeof ChainManager>[4];
  },
  deps: ToolChainStageDeps = {},
): Promise<ToolChainStageResult> {
  if (!params.config.toolChain.enabled || !params.learningStorage || !params.learningEventBus) {
    return {};
  }

  try {
    const chainConfig: ToolChainConfig = params.config.toolChain;
    const chainDetector = deps.createChainDetector?.(params.learningStorage, chainConfig)
      ?? new ChainDetector(params.learningStorage, chainConfig);
    const chainSynthesizer = deps.createChainSynthesizer?.(
      params.learningStorage,
      params.toolRegistry,
      params.learningEventBus,
      chainConfig,
    ) ?? new ChainSynthesizer(
      params.learningStorage,
      params.toolRegistry,
      params.learningEventBus,
      chainConfig,
    );
    chainSynthesizer.setProvider(params.providerManager.getProvider(""));

    let chainManager: ChainManager | undefined;
    const chainValidator = deps.createChainValidator?.({
      storage: params.learningStorage,
      confidenceScorer: new ConfidenceScorer(),
      eventBus: params.learningEventBus,
      updateInstinctStatus: (instinct) => {
        params.learningPipeline?.updateInstinctStatus(instinct);
      },
      onChainDeprecated: (chainName) => {
        chainManager?.handleChainDeprecated(chainName);
      },
      maxAgeDays: chainConfig.maxAgeDays,
    }) ?? new ChainValidator({
      storage: params.learningStorage,
      confidenceScorer: new ConfidenceScorer(),
      eventBus: params.learningEventBus,
      updateInstinctStatus: (instinct) => {
        params.learningPipeline?.updateInstinctStatus(instinct);
      },
      onChainDeprecated: (chainName) => {
        chainManager?.handleChainDeprecated(chainName);
      },
      maxAgeDays: chainConfig.maxAgeDays,
    });

    chainManager = deps.createChainManager?.(
      chainDetector,
      chainSynthesizer,
      params.toolRegistry,
      params.learningStorage,
      params.orchestrator,
      params.learningEventBus,
      chainConfig,
      chainValidator,
    ) ?? new ChainManager(
      chainDetector,
      chainSynthesizer,
      params.toolRegistry,
      params.learningStorage,
      params.orchestrator,
      params.learningEventBus,
      chainConfig,
      chainValidator,
    );

    await chainManager.start();

    if (params.learningQueue) {
      params.learningEventBus.on("chain:executed", (event) => {
        params.learningQueue!.enqueue(async () => {
          chainValidator.handleChainExecuted(event);
        });
      });
    }

    params.logger.info("Tool chain synthesis initialized");
    return { chainManager };
  } catch (error) {
    params.logger.warn("Tool chain synthesis initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}
