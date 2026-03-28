import type * as winston from "winston";
import type { Config } from "../../config/config.js";
import type { IChannelAdapter } from "../../channels/channel.interface.js";
import type { IMemoryManager } from "../../memory/memory.interface.js";
import type { IRAGPipeline } from "../../rag/rag.interface.js";
import type { CachedEmbeddingProvider } from "../../rag/embeddings/embedding-cache.js";
import type { ProviderManager } from "../../agents/providers/provider-manager.js";
import type { DashboardServer } from "../../dashboard/server.js";
import type { MetricsCollector } from "../../dashboard/metrics.js";
import type { RateLimiter } from "../../security/rate-limiter.js";
import type { IEventBus, LearningEventMap } from "../event-bus.js";
import { IdentityStateManager } from "../../identity/identity-state.js";
import { InstinctRetriever } from "../../agents/instinct-retriever.js";
import { GoalDecomposer } from "../../goals/index.js";
import { ToolRegistry } from "../tool-registry.js";
import { SoulLoader } from "../../agents/soul/index.js";
import { AgentDBAdapter } from "../../memory/unified/agentdb-adapter.js";
import { DMPolicy } from "../../security/dm-policy.js";
import { TaskManager } from "../../tasks/index.js";
import type { DaemonEventMap } from "../../daemon/daemon-events.js";
import type { Orchestrator } from "../../agents/orchestrator.js";
import { HeartbeatLoop } from "../../daemon/heartbeat-loop.js";
import { DaemonStorage } from "../../daemon/daemon-storage.js";
import { ApprovalQueue } from "../../daemon/security/approval-queue.js";
import { TriggerRegistry } from "../../daemon/trigger-registry.js";
import { MetricsRecorder } from "../../metrics/metrics-recorder.js";
import { createAgentId } from "../../agents/multi/agent-types.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";
import { collectApiKeys } from "../../rag/embeddings/embedding-resolver.js";
import { collectProviderCredentials } from "../provider-config.js";
import { WorkspaceLeaseManager } from "../../agents/multi/workspace-lease-manager.js";
import type { SupervisorBrain } from "../../supervisor/supervisor-brain.js";
import type {
  MultiAgentDelegationStageDeps,
  MultiAgentDelegationStageResult,
  MemoryConsolidationStageDeps,
  MemoryConsolidationStageResult,
  DeploymentStageDeps,
  DeploymentStageResult,
} from "./bootstrap-stages-types.js";

export async function initializeMultiAgentDelegationStage(
  params: {
    config: Config;
    logger: winston.Logger;
    daemonMode: boolean;
    daemonStorage: DaemonStorage;
    daemonContext: import("../../daemon/daemon-cli.js").DaemonContext;
    taskManager: TaskManager;
    orchestrator: Orchestrator;
    learningEventBus?: IEventBus<LearningEventMap>;
    providerManager: ProviderManager;
    toolRegistry: ToolRegistry;
    channel: IChannelAdapter;
    metrics: MetricsCollector;
    ragPipeline?: IRAGPipeline;
    rateLimiter?: RateLimiter;
    instinctRetriever?: InstinctRetriever;
    metricsRecorder?: MetricsRecorder;
    goalDecomposer?: GoalDecomposer;
    identityManager?: IdentityStateManager;
    cachedEmbeddingProvider?: CachedEmbeddingProvider;
    soulLoader: SoulLoader;
    dmPolicy: DMPolicy;
    userProfileStore?: import("../../memory/unified/user-profile-store.js").UserProfileStore;
    providerRouter?: { setTierRouter(router: unknown): void };
    dashboard?: Pick<DashboardServer, "registerDelegationServices">;
    stradaDeps: StradaDepsStatus;
    supervisorBrain?: SupervisorBrain;
  },
  deps: MultiAgentDelegationStageDeps = {},
): Promise<MultiAgentDelegationStageResult> {
  if (!params.config.agent.enabled) {
    return {};
  }

  const { AgentManager } = await import("../../agents/multi/agent-manager.js");
  const { AgentRegistry } = await import("../../agents/multi/agent-registry.js");
  const { AgentBudgetTracker } = await import("../../agents/multi/agent-budget-tracker.js");

  const agentRegistry = deps.createAgentRegistry?.(params.daemonStorage.getDatabase())
    ?? new AgentRegistry(params.daemonStorage.getDatabase());
  agentRegistry.initialize();

  const agentBudgetTracker = deps.createAgentBudgetTracker?.(params.daemonStorage)
    ?? new AgentBudgetTracker(params.daemonStorage);
  agentBudgetTracker.initialize();

  const agentManagerOptions = {
    config: params.config.agent,
    registry: agentRegistry,
    budgetTracker: agentBudgetTracker,
    eventBus: params.learningEventBus as IEventBus<LearningEventMap>,
    providerManager: params.providerManager,
    toolRegistry: params.toolRegistry,
    channel: params.channel,
    projectPath: params.config.unityProjectPath,
    readOnly: params.config.security.readOnlyMode,
    requireConfirmation: params.config.security.requireEditConfirmation,
    metrics: params.metrics,
    ragPipeline: params.ragPipeline,
    rateLimiter: params.rateLimiter,
    streamingEnabled: params.config.streamingEnabled,
    defaultLanguage: params.config.language,
    streamInitialTimeoutMs: params.config.llmStreamInitialTimeoutMs,
    streamStallTimeoutMs: params.config.llmStreamStallTimeoutMs,
    stradaDeps: params.stradaDeps,
    stradaConfig: params.config.strada,
    instinctRetriever: params.instinctRetriever,
    metricsRecorder: params.metricsRecorder,
    goalDecomposer: params.goalDecomposer,
    getIdentityState: params.identityManager ? () => params.identityManager!.getState() : undefined,
    reRetrievalConfig: params.config.reRetrieval,
    embeddingProvider: params.cachedEmbeddingProvider,
    memoryConfig: { dimensions: params.config.memory.unified.dimensions, dbBasePath: params.config.memory.dbPath },
    soulLoader: params.soulLoader,
    dmPolicy: params.dmPolicy,
    userProfileStore: params.userProfileStore,
    messageBurstWindowMs: params.config.tasks.messageBurstWindowMs,
    maxBurstMessages: params.config.tasks.messageBurstMaxMessages,
    supervisorBrain: params.supervisorBrain,
  } satisfies ConstructorParameters<typeof AgentManager>[0];

  const agentManager = deps.createAgentManager?.(agentManagerOptions)
    ?? new AgentManager(agentManagerOptions);
  agentManager.setBackgroundTaskSubmitter((msg, _agent, liveOrchestrator) => {
    params.taskManager.submit(msg.chatId, msg.channelType, msg.text, {
      attachments: msg.attachments,
      conversationId: msg.conversationId,
      userId: msg.userId,
      orchestrator: liveOrchestrator,
    });
  });
  agentManager.setTaskManager?.(params.taskManager);
  params.daemonContext.agentManager = agentManager;
  params.daemonContext.agentBudgetTracker = agentBudgetTracker;

  params.logger.info("Multi-agent system initialized", {
    maxConcurrent: params.config.agent.maxConcurrent,
    defaultBudget: params.config.agent.defaultBudgetUsd,
    idleTimeoutMs: params.config.agent.idleTimeoutMs,
  });

  let delegationManager: import("../../agents/multi/delegation/delegation-manager.js").DelegationManager | undefined;
  if (params.config.delegation.enabled) {
    const { TierRouter } = await import("../../agents/multi/delegation/tier-router.js");
    const { DelegationLog } = await import("../../agents/multi/delegation/delegation-log.js");
    const { DelegationManager } = await import("../../agents/multi/delegation/delegation-manager.js");
    const { createDelegationTools, DEFAULT_DELEGATION_TYPES } = await import("../../agents/multi/delegation/index.js");

    const delegationLog = deps.createDelegationLog?.(params.daemonStorage.getDatabase())
      ?? new DelegationLog(params.daemonStorage.getDatabase());
    const tierRouter = deps.createTierRouter?.(
      params.config.delegation.tiers,
      params.daemonStorage.getDatabase(),
    ) ?? new TierRouter(
      params.config.delegation.tiers,
      params.daemonStorage.getDatabase(),
    );
    const delegationTypes = params.config.delegation.types.length > 0
      ? [...params.config.delegation.types]
      : [...(deps.defaultDelegationTypes ?? DEFAULT_DELEGATION_TYPES)];
    let workspaceLeaseManager: WorkspaceLeaseManager | undefined;
    try {
      workspaceLeaseManager = new WorkspaceLeaseManager({
        projectRoot: params.config.unityProjectPath,
      });
    } catch (error) {
      params.logger.warn("Workspace isolation disabled for delegation manager", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const delegationManagerOptions = {
      config: {
        enabled: true,
        maxDepth: params.config.delegation.maxDepth,
        maxConcurrentPerParent: params.config.delegation.maxConcurrentPerParent,
        tiers: params.config.delegation.tiers,
        types: delegationTypes,
        verbosity: params.config.delegation.verbosity,
      },
      tierRouter,
      delegationLog,
      eventBus: params.learningEventBus as IEventBus<LearningEventMap>,
      budgetTracker: agentBudgetTracker,
      channel: params.channel,
      projectPath: params.config.unityProjectPath,
      readOnly: params.config.security.readOnlyMode,
      defaultLanguage: params.config.language,
      streamInitialTimeoutMs: params.config.llmStreamInitialTimeoutMs,
      streamStallTimeoutMs: params.config.llmStreamStallTimeoutMs,
      stradaDeps: params.stradaDeps,
      stradaConfig: params.config.strada,
      parentTools: params.toolRegistry.getAllTools(),
      apiKeys: collectApiKeys(params.config),
      providerCredentials: collectProviderCredentials(params.config),
      preferencesDbPath: params.config.memory.dbPath,
      verifiedLocalProviders: params.providerManager.isAvailable("ollama") ? ["ollama"] : [],
      workspaceLeaseManager,
      providerRouter: params.providerRouter as ConstructorParameters<typeof DelegationManager>[0]["providerRouter"],
    };
    delegationManager = deps.createDelegationManager?.(delegationManagerOptions)
      ?? new DelegationManager(delegationManagerOptions);

    const createDelegationToolsFn = deps.createDelegationTools ?? createDelegationTools;
    agentManager.setDelegationFactory((parentAgentId, depth) =>
      createDelegationToolsFn(
        delegationTypes,
        delegationManager!,
        parentAgentId,
        depth,
        params.config.delegation.maxDepth,
      ),
    );

    const rootDelegationAgentId = createAgentId();
    const rootDelegationTools = createDelegationToolsFn(
      delegationTypes,
      delegationManager,
      rootDelegationAgentId,
      0,
      params.config.delegation.maxDepth,
    );
    for (const tool of rootDelegationTools) {
      params.orchestrator.addTool(tool);
    }

    if (params.providerRouter) {
      params.providerRouter.setTierRouter(tierRouter);
    }

    params.daemonContext.delegationManager = delegationManager;
    params.daemonContext.delegationLog = delegationLog;
    params.daemonContext.tierRouter = tierRouter;
    if (params.dashboard) {
      params.dashboard.registerDelegationServices(delegationLog, delegationManager);
    }

    params.logger.info("Task delegation enabled", {
      types: delegationTypes.length,
      maxDepth: params.config.delegation.maxDepth,
    });
  }

  return {
    agentManager,
    agentBudgetTracker,
    delegationManager,
  };
}

export async function initializeMemoryConsolidationStage(
  params: {
    config: Config;
    logger: winston.Logger;
    memoryManager?: IMemoryManager;
    cachedEmbeddingProvider?: CachedEmbeddingProvider;
    providerManager: ProviderManager;
    learningEventBus?: IEventBus<LearningEventMap>;
    heartbeatLoop: Pick<HeartbeatLoop, "setConsolidationEngine">;
    daemonContext: import("../../daemon/daemon-cli.js").DaemonContext;
  },
  deps: MemoryConsolidationStageDeps = {},
): Promise<MemoryConsolidationStageResult> {
  if (!params.config.memory.consolidation.enabled || !params.memoryManager) {
    return {};
  }

  try {
    const isAgentDbAdapter = deps.isAgentDbAdapter ?? (async (memoryManager: IMemoryManager): Promise<boolean> => {
      const { AgentDBAdapter: AdapterCheck } = await import("../../memory/unified/agentdb-adapter.js");
      return memoryManager instanceof AdapterCheck;
    });
    if (!(await isAgentDbAdapter(params.memoryManager))) {
      params.logger.debug("Memory consolidation skipped: memory manager is not AgentDBAdapter");
      return {};
    }

    const agentDbMemoryManager = params.memoryManager as AgentDBAdapter;
    const internals = deps.getConsolidationInternals?.(params.memoryManager)
      ?? agentDbMemoryManager.getAgentDBMemory().getConsolidationInternals();
    if (!internals.sqliteDb || !internals.hnswStore) {
      params.logger.warn("Memory consolidation skipped: SQLite DB or HNSW store not available");
      return {};
    }

    const generateEmbedding = async (text: string): Promise<number[]> => {
      if (params.cachedEmbeddingProvider) {
        const batch = await params.cachedEmbeddingProvider.embed([text]);
        return batch.embeddings[0] as number[];
      }
      const { createHash } = await import("node:crypto");
      const hash = createHash("sha256").update(text).digest();
      const dims = params.config.memory.unified.dimensions;
      const vec = new Array<number>(dims);
      for (let i = 0; i < dims; i++) {
        vec[i] = (hash[i % hash.length]! / 128) - 1;
      }
      return vec;
    };

    const summarizeWithLLM = async (texts: string[]): Promise<{ summary: string; cost: number; model: string }> => {
      const provider = params.providerManager.getProvider("");
      const prompt = `Summarize the following related memory entries into a single concise entry that preserves key information:\n\n${texts.map((t, i) => `[${i + 1}] ${t}`).join("\n\n")}`;
      const response = await provider.chat(
        "You are a memory consolidation engine. Produce a concise summary preserving key facts.",
        [{ role: "user", content: prompt }],
        [],
      );
      return {
        summary: response.text,
        cost: 0,
        model: provider.name,
      };
    };

    const engineOptions = {
      sqliteDb: internals.sqliteDb,
      entries: internals.entries,
      hnswStore: internals.hnswStore,
      config: { ...params.config.memory.consolidation, minAgeMs: 3600000 },
      generateEmbedding,
      summarizeWithLLM,
      eventEmitter: params.learningEventBus ?? { emit: () => {} },
      logger: params.logger,
      exemptDomains: params.config.memory.decay.exemptDomains,
    };
    const consolidationEngine = deps.createMemoryConsolidationEngine?.(engineOptions) ?? (() => {
      return import("../../memory/unified/consolidation-engine.js").then(({ MemoryConsolidationEngine }) =>
        new MemoryConsolidationEngine(
          engineOptions as unknown as ConstructorParameters<typeof MemoryConsolidationEngine>[0],
        ),
      );
    })();
    const resolvedEngine = await consolidationEngine;

    params.heartbeatLoop.setConsolidationEngine(resolvedEngine, {
      idleMinutes: params.config.memory.consolidation.idleMinutes,
    });
    params.daemonContext.consolidationEngine = resolvedEngine;

    params.logger.info("Memory consolidation engine initialized", {
      idleMinutes: params.config.memory.consolidation.idleMinutes,
      threshold: params.config.memory.consolidation.threshold,
    });

    return {
      consolidationEngine: resolvedEngine,
    };
  } catch (error) {
    params.logger.warn("Memory consolidation initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export async function initializeDeploymentStage(
  params: {
    config: Config;
    logger: winston.Logger;
    daemonConfig: Config["daemon"];
    daemonStorage: DaemonStorage;
    approvalQueue: ApprovalQueue;
    triggerRegistry: Pick<TriggerRegistry, "register">;
    heartbeatLoop: Pick<HeartbeatLoop, "setDeployTrigger" | "onTaskSettled">;
    daemonEventBus: IEventBus<DaemonEventMap>;
    taskManager: Pick<TaskManager, "on">;
    daemonContext: import("../../daemon/daemon-cli.js").DaemonContext;
  },
  deps: DeploymentStageDeps = {},
): Promise<DeploymentStageResult> {
  if (!params.config.deployment.enabled) {
    return {};
  }

  try {
    const { DeployTrigger } = await import("../../daemon/triggers/deploy-trigger.js");
    const { registerDeployApprovalBridge } = await import("../../daemon/triggers/deploy-approval-bridge.js");
    const { ReadinessChecker } = await import("../../daemon/deployment/readiness-checker.js");
    const { DeploymentExecutor } = await import("../../daemon/deployment/deployment-executor.js");
    const { CircuitBreaker: DeployCircuitBreaker } = await import("../../daemon/resilience/circuit-breaker.js");

    const readinessChecker = deps.createReadinessChecker?.(
      params.config.deployment,
      params.config.unityProjectPath,
      params.logger,
    ) ?? new ReadinessChecker(
      params.config.deployment,
      params.config.unityProjectPath,
      params.logger,
    );
    const deploymentExecutor = deps.createDeploymentExecutor?.(
      params.config.deployment,
      params.config.unityProjectPath,
      params.logger,
      params.daemonStorage.getDatabase(),
    ) ?? new DeploymentExecutor(
      params.config.deployment,
      params.config.unityProjectPath,
      params.logger,
      params.daemonStorage.getDatabase(),
    );
    const deployCircuitBreaker = deps.createDeployCircuitBreaker?.(
      params.daemonConfig.backoff.failureThreshold,
      params.daemonConfig.backoff.baseCooldownMs,
      params.daemonConfig.backoff.maxCooldownMs,
    ) ?? new DeployCircuitBreaker(
      params.daemonConfig.backoff.failureThreshold,
      params.daemonConfig.backoff.baseCooldownMs,
      params.daemonConfig.backoff.maxCooldownMs,
    );
    const deployTrigger = deps.createDeployTrigger?.(
      readinessChecker,
      params.approvalQueue,
      deployCircuitBreaker,
      deploymentExecutor,
      params.config.deployment,
      params.logger,
    ) ?? new DeployTrigger(
      readinessChecker as ConstructorParameters<typeof DeployTrigger>[0],
      params.approvalQueue,
      deployCircuitBreaker as ConstructorParameters<typeof DeployTrigger>[2],
      deploymentExecutor as ConstructorParameters<typeof DeployTrigger>[3],
      params.config.deployment,
      params.logger,
    );

    params.triggerRegistry.register(
      deployTrigger as Parameters<TriggerRegistry["register"]>[0],
    );
    params.heartbeatLoop.setDeployTrigger(deployTrigger);
    (deps.registerDeployApprovalBridge ?? registerDeployApprovalBridge)(
      params.daemonEventBus,
      params.approvalQueue,
      deployTrigger,
      params.logger,
    );
    params.taskManager.on("task:completed", (taskId) => {
      params.heartbeatLoop.onTaskSettled(taskId);
    });
    params.taskManager.on("task:failed", (taskId) => {
      params.heartbeatLoop.onTaskSettled(taskId);
    });

    params.daemonContext.deploymentExecutor = deploymentExecutor;
    params.daemonContext.readinessChecker = readinessChecker;
    params.daemonContext.deployTrigger = deployTrigger;

    if (params.config.deployment.scriptPath) {
      try {
        readinessChecker.validateScriptPath(params.config.deployment.scriptPath);
      } catch {
        params.logger.warn("Deployment script path validation failed at startup (will be re-validated at execution time)", {
          scriptPath: params.config.deployment.scriptPath,
        });
      }
    }

    params.logger.info("Deployment subsystem initialized", {
      testCommand: params.config.deployment.testCommand,
      targetBranch: params.config.deployment.targetBranch,
      scriptPath: params.config.deployment.scriptPath ?? "(not set)",
    });

    return {
      deploymentExecutor,
      readinessChecker,
      deployTrigger,
    };
  } catch (error) {
    params.logger.warn("Deployment initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}
