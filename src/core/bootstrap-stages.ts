import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../config/config.js";
import type * as winston from "winston";
import type { AuthManager } from "../security/auth.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type { IRAGPipeline } from "../rag/rag.interface.js";
import type { CachedEmbeddingProvider } from "../rag/embeddings/embedding-cache.js";
import type { ProviderManager } from "../agents/providers/provider-manager.js";
import type { DashboardServer } from "../dashboard/server.js";
import type { MetricsCollector } from "../dashboard/metrics.js";
import type { RateLimiter } from "../security/rate-limiter.js";
import { resolveRuntimePaths } from "../common/runtime-paths.js";
import { buildBootReport, summarizeBootReport } from "./boot-report.js";
import { MetricsStorage } from "../metrics/metrics-storage.js";
import { MetricsRecorder } from "../metrics/metrics-recorder.js";
import type { BootReport } from "../common/capability-contract.js";
import { createProjectScopeFingerprint, RuntimeArtifactManager } from "../learning/index.js";
import type { LearningPipeline, LearningStorage, PatternMatcher } from "../learning/index.js";
import { TypedEventBus, type IEventBus, type LearningEventMap } from "./event-bus.js";
import type { LearningQueue } from "../learning/pipeline/learning-queue.js";
import type { TaskPlanner } from "../agents/autonomy/task-planner.js";
import type { ErrorRecoveryEngine } from "../agents/autonomy/error-recovery.js";
import { IdentityStateManager } from "../identity/identity-state.js";
import { InstinctRetriever } from "../agents/instinct-retriever.js";
import { TrajectoryReplayRetriever } from "../agents/trajectory-replay-retriever.js";
import type { ScopeContext } from "../learning/matching/pattern-matcher.js";
import { GoalStorage, GoalDecomposer, detectInterruptedTrees } from "../goals/index.js";
import type { GoalExecutorConfig } from "../goals/index.js";
import type { GoalTree } from "../goals/types.js";
import { buildCrashRecoveryContext } from "../identity/crash-recovery.js";
import type { CrashRecoveryContext } from "../identity/crash-recovery.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import { ToolRegistry } from "./tool-registry.js";
import { SoulLoader } from "../agents/soul/index.js";
import { AgentDBAdapter } from "../memory/unified/agentdb-adapter.js";
import { DMPolicy } from "../security/dm-policy.js";
import {
  BackgroundExecutor,
  CommandHandler,
  MessageRouter,
  ProgressReporter,
  TaskManager,
  TaskStorage,
} from "../tasks/index.js";
import type { DaemonEventMap } from "../daemon/daemon-events.js";
import type { Orchestrator } from "../agents/orchestrator.js";
import { AutoUpdater } from "./auto-updater.js";
import type { ChannelActivityRegistry } from "./channel-activity-registry.js";
import { CronTrigger } from "../daemon/triggers/cron-trigger.js";
import { FileWatchTrigger } from "../daemon/triggers/file-watch-trigger.js";
import { ChecklistTrigger } from "../daemon/triggers/checklist-trigger.js";
import { WebhookTrigger } from "../daemon/triggers/webhook-trigger.js";
import { parseHeartbeatFile } from "../daemon/heartbeat-parser.js";
import { AppError } from "../common/errors.js";
import type { ITrigger } from "../daemon/daemon-types.js";
import { TriggerRegistry } from "../daemon/trigger-registry.js";
import { HeartbeatLoop } from "../daemon/heartbeat-loop.js";
import { DaemonStorage } from "../daemon/daemon-storage.js";
import { BudgetTracker } from "../daemon/budget/budget-tracker.js";
import { ApprovalQueue } from "../daemon/security/approval-queue.js";
import { DaemonSecurityPolicy } from "../daemon/security/daemon-security-policy.js";
import { TriggerDeduplicator } from "../daemon/dedup/trigger-deduplicator.js";
import { createAgentId } from "../agents/multi/agent-types.js";
import type { StradaDepsStatus } from "../config/strada-deps.js";
import { collectApiKeys } from "../rag/embeddings/embedding-resolver.js";
import { collectProviderCredentials } from "./provider-config.js";
import type { ITool } from "../agents/tools/tool.interface.js";
import {
  ChainDetector,
  ChainSynthesizer,
  ChainManager,
  ChainValidator,
  type ToolChainConfig,
} from "../learning/chains/index.js";
import { ConfidenceScorer } from "../learning/index.js";
import { WorkspaceLeaseManager } from "../agents/multi/workspace-lease-manager.js";

export interface ProviderInitResult {
  manager: ProviderManager;
  notices: string[];
  healthCheckPassed?: boolean;
}

export interface BootstrapEmbeddingStatus {
  state: "disabled" | "active" | "degraded";
  ragEnabled: boolean;
  configuredProvider: string;
  configuredModel?: string;
  configuredDimensions?: number;
  resolvedProviderName?: string;
  resolutionSource?: string;
  activeDimensions?: number;
  verified: boolean;
  usingHashFallback: boolean;
  notice?: string;
}

export interface EmbeddingResolutionResult {
  cachedProvider?: CachedEmbeddingProvider;
  notice?: string;
  status: BootstrapEmbeddingStatus;
}

export interface RAGResult {
  pipeline?: IRAGPipeline;
  cachedProvider?: CachedEmbeddingProvider;
  notice?: string;
}

export interface LearningResult {
  pipeline?: LearningPipeline;
  storage?: LearningStorage;
  patternMatcher?: PatternMatcher;
  taskPlanner: TaskPlanner;
  errorRecovery: ErrorRecoveryEngine;
  eventBus?: IEventBus<LearningEventMap>;
  learningQueue?: LearningQueue;
  notices: string[];
}

export interface ProviderRuntimeStageResult {
  providerInit: ProviderInitResult;
  memoryManager?: IMemoryManager;
  channel: IChannelAdapter;
  cachedEmbeddingProvider?: CachedEmbeddingProvider;
  embeddingStatus: BootstrapEmbeddingStatus;
  startupNotices: string[];
}

export interface KnowledgeStageResult {
  ragPipeline?: IRAGPipeline;
  learningResult: LearningResult;
  startupNotices: string[];
}

export interface OpsMonitoringStageResult {
  dashboard?: DashboardServer;
  stoppableServers: Array<{ stop(): Promise<void> | void }>;
  rateLimiter?: RateLimiter;
  metricsStorage?: MetricsStorage;
  metricsRecorder?: MetricsRecorder;
}

export interface RuntimeStateStageResult {
  metricsStorage?: MetricsStorage;
  metricsRecorder?: MetricsRecorder;
  identityManager?: IdentityStateManager;
  uptimeInterval?: ReturnType<typeof setInterval>;
  runtimeArtifactManager?: RuntimeArtifactManager;
  instinctRetriever?: InstinctRetriever;
  trajectoryReplayRetriever?: TrajectoryReplayRetriever;
}

export interface GoalContextStageResult {
  goalStorage?: GoalStorage;
  goalDecomposer?: GoalDecomposer;
  interruptedGoalTrees: GoalTree[];
  crashContext: CrashRecoveryContext | null;
  goalExecutorConfig: GoalExecutorConfig;
}

export interface SessionRuntimeStageResult {
  soulLoader: SoulLoader;
  sessionSummarizer?: import("../memory/unified/session-summarizer.js").SessionSummarizer;
  userProfileStore?: import("../memory/unified/user-profile-store.js").UserProfileStore;
  taskExecutionStore?: import("../memory/unified/task-execution-store.js").TaskExecutionStore;
  dmPolicy: DMPolicy;
}

export interface TaskRuntimeStageResult {
  daemonEventBus?: TypedEventBus<DaemonEventMap>;
  taskStorage: TaskStorage;
  backgroundExecutor: BackgroundExecutor;
  taskManager: TaskManager;
  autoUpdater?: AutoUpdater;
  projectScopeFingerprint?: string;
  commandHandler: CommandHandler;
  messageRouter: MessageRouter;
}

export interface DaemonTriggerStageResult {
  heartbeatPath: string;
  webhookTriggers: Map<string, WebhookTrigger>;
}

export interface DaemonHeartbeatStageResult {
  daemonStorage: DaemonStorage;
  triggerRegistry: TriggerRegistry;
  budgetTracker: BudgetTracker;
  approvalQueue: ApprovalQueue;
  securityPolicy: DaemonSecurityPolicy;
  heartbeatLoop: HeartbeatLoop;
  webhookTriggers: Map<string, WebhookTrigger>;
}

export interface MultiAgentDelegationStageResult {
  agentManager?: import("../agents/multi/agent-manager.js").AgentManager;
  agentBudgetTracker?: import("../agents/multi/agent-budget-tracker.js").AgentBudgetTracker;
  delegationManager?: import("../agents/multi/delegation/delegation-manager.js").DelegationManager;
}

export interface MemoryConsolidationStageResult {
  consolidationEngine?: import("../daemon/daemon-cli.js").DaemonContext["consolidationEngine"];
}

export interface DeploymentStageResult {
  deploymentExecutor?: import("../daemon/daemon-cli.js").DaemonContext["deploymentExecutor"];
  readinessChecker?: import("../daemon/daemon-cli.js").DaemonContext["readinessChecker"];
  deployTrigger?: import("../daemon/daemon-cli.js").DaemonContext["deployTrigger"];
}

export interface RuntimeIntelligenceStageResult {
  modelIntelligence?: import("../agents/providers/model-intelligence.js").ModelIntelligenceService;
  providerRouter?: import("../agent-core/routing/provider-router.js").ProviderRouter;
  consensusManager?: import("../agent-core/routing/consensus-manager.js").ConsensusManager;
  confidenceEstimator?: import("../agent-core/routing/confidence-estimator.js").ConfidenceEstimator;
}

export interface ToolChainStageResult {
  chainManager?: ChainManager;
}

type DeploymentExecutorContract = NonNullable<DeploymentStageResult["deploymentExecutor"]>;
type DeploymentReadinessCheckerContract = NonNullable<DeploymentStageResult["readinessChecker"]> & {
  validateScriptPath(scriptPath: string): void;
};
type DeploymentTriggerContract = NonNullable<DeploymentStageResult["deployTrigger"]>;

interface ProviderRuntimeStageDeps {
  initializeAuth: (config: Config, channelType: string, logger: winston.Logger) => AuthManager;
  resolveAndCacheEmbeddings: (
    config: Config,
    logger: winston.Logger,
  ) => Promise<EmbeddingResolutionResult>;
  initializeAIProvider: (
    config: Config,
    logger: winston.Logger,
  ) => Promise<ProviderInitResult>;
  initializeMemory: (
    config: Config,
    logger: winston.Logger,
    embeddingProvider?: CachedEmbeddingProvider,
  ) => Promise<IMemoryManager | undefined>;
  initializeChannel: (
    channelType: string,
    config: Config,
    auth: AuthManager,
    logger: winston.Logger,
  ) => Promise<IChannelAdapter>;
  isTransientEmbeddingVerificationError: (error: unknown) => boolean;
}

interface KnowledgeStageDeps {
  initializeRAG: (
    config: Config,
    logger: winston.Logger,
    cachedProvider?: CachedEmbeddingProvider,
  ) => Promise<RAGResult>;
  initializeLearning: (
    config: Config,
    logger: winston.Logger,
    embeddingProvider?: CachedEmbeddingProvider,
  ) => Promise<LearningResult>;
}

interface OpsMonitoringStageDeps {
  initializeDashboard: (
    config: Config,
    metrics: MetricsCollector,
    memoryManager: IMemoryManager | undefined,
    logger: winston.Logger,
  ) => Promise<DashboardServer | undefined>;
  initializeRateLimiter: (
    config: Config,
    logger: winston.Logger,
  ) => RateLimiter | undefined;
}

interface RuntimeStateStageDeps {
  createMetricsStorage?: (dbPath: string) => MetricsStorage;
  createMetricsRecorder?: (storage: MetricsStorage) => MetricsRecorder;
  createIdentityManager?: (dbPath: string, agentName: string) => IdentityStateManager;
  createRuntimeArtifactManager?: (storage: LearningStorage) => RuntimeArtifactManager;
  createInstinctRetriever?: (
    patternMatcher: PatternMatcher,
    options: {
      scopeContext: ScopeContext;
      storage?: LearningStorage;
      metricsRecorder?: MetricsRecorder;
    },
  ) => InstinctRetriever;
  createTrajectoryReplayRetriever?: (storage: LearningStorage) => TrajectoryReplayRetriever;
}

interface GoalContextStageDeps {
  createGoalStorage?: (dbPath: string) => GoalStorage;
  createGoalDecomposer?: (provider: IAIProvider, maxDepth: number) => GoalDecomposer;
  detectInterruptedTrees?: (storage: GoalStorage) => GoalTree[];
  buildCrashRecoveryContext?: (
    wasCrash: boolean,
    identityState: ReturnType<IdentityStateManager["getState"]>,
    interruptedGoalTrees: GoalTree[],
  ) => CrashRecoveryContext | null;
}

interface ToolRegistryStageDeps {
  getDaemonStatus?: () =>
    | import("../daemon/daemon-types.js").DaemonStatusSnapshot
    | undefined;
}

interface SessionRuntimeStageDeps {
  createSoulLoader?: (
    basePath: string,
    options: ConstructorParameters<typeof SoulLoader>[1],
  ) => SoulLoader;
  isAgentDbAdapter?: (memoryManager: IMemoryManager) => memoryManager is AgentDBAdapter;
  createSessionSummarizer?: (
    provider: IAIProvider,
    executionStore: import("../memory/unified/task-execution-store.js").TaskExecutionStore,
  ) => import("../memory/unified/session-summarizer.js").SessionSummarizer;
  createDMPolicy?: (channel: IChannelAdapter) => DMPolicy;
}

interface TaskRuntimeStageDeps {
  createTaskStorage?: (dbPath: string) => TaskStorage;
  createDaemonEventBus?: () => TypedEventBus<DaemonEventMap>;
  createBackgroundExecutor?: (
    options: ConstructorParameters<typeof BackgroundExecutor>[0],
  ) => BackgroundExecutor;
  createTaskManager?: (
    taskStorage: TaskStorage,
    backgroundExecutor: BackgroundExecutor,
  ) => TaskManager;
  createAutoUpdater?: (
    config: Config,
    activityRegistry: ChannelActivityRegistry,
    backgroundExecutor: BackgroundExecutor,
  ) => AutoUpdater;
  createProjectScopeFingerprint?: (projectPath: string) => string;
  createCommandHandler?: (params: {
    taskManager: TaskManager;
    channel: IChannelAdapter;
    providerManager: ProviderManager;
    dmPolicy: DMPolicy;
    userProfileStore?: import("../memory/unified/user-profile-store.js").UserProfileStore;
    soulLoader: SoulLoader;
    runtimeArtifactManager?: RuntimeArtifactManager;
    projectScopeFingerprint?: string;
    autonomousDefaultEnabled: boolean;
    autonomousDefaultHours: number;
  }) => CommandHandler;
  createMessageRouter?: (params: {
    taskManager: TaskManager;
    commandHandler: CommandHandler;
    channel: IChannelAdapter;
    startupNotices: string[];
    burstWindowMs: number;
    maxBurstMessages: number;
  }) => MessageRouter;
  createProgressReporter?: (
    channel: IChannelAdapter,
    taskManager: TaskManager,
    interaction: Config["interaction"],
  ) => ProgressReporter;
}

interface DaemonTriggerStageDeps {
  readFile?: (path: string, encoding: "utf-8") => string;
  parseHeartbeatFile?: typeof parseHeartbeatFile;
  createCronTrigger?: (
    meta: { name: string; description: string; type: "cron"; cooldownSeconds?: number },
    cron: string,
    timezone?: string,
  ) => ITrigger;
  createFileWatchTrigger?: (
    config: ConstructorParameters<typeof FileWatchTrigger>[0],
  ) => ITrigger;
  createChecklistTrigger?: (
    definition: ConstructorParameters<typeof ChecklistTrigger>[0],
    timezone?: string,
  ) => ITrigger;
  createWebhookTrigger?: (name: string, action: string) => WebhookTrigger;
}

interface DaemonHeartbeatStageDeps extends DaemonTriggerStageDeps {
  createDaemonStorage?: (dbPath: string) => DaemonStorage;
  createTriggerRegistry?: () => TriggerRegistry;
  createBudgetTracker?: (
    daemonStorage: DaemonStorage,
    config: Config["daemon"]["budget"],
  ) => BudgetTracker;
  createApprovalQueue?: (
    daemonStorage: DaemonStorage,
    timeoutMinutes: number,
    eventBus?: IEventBus<DaemonEventMap>,
  ) => ApprovalQueue;
  createSecurityPolicy?: (
    metadataLookup: (name: string) => { readOnly: boolean } | undefined,
    approvalQueue: ApprovalQueue,
    autoApproveTools: Set<string>,
  ) => DaemonSecurityPolicy;
  createTriggerDeduplicator?: (dedupWindowMs: number) => TriggerDeduplicator;
  createHeartbeatLoop?: (
    triggerRegistry: TriggerRegistry,
    taskManager: TaskManager,
    budgetTracker: BudgetTracker,
    securityPolicy: DaemonSecurityPolicy,
    approvalQueue: ApprovalQueue,
    daemonStorage: DaemonStorage,
    identityManager: IdentityStateManager | undefined,
    daemonEventBus: IEventBus<DaemonEventMap>,
    daemonConfig: Config["daemon"],
    logger: winston.Logger,
    deduplicator: TriggerDeduplicator,
  ) => HeartbeatLoop;
}

interface MultiAgentDelegationStageDeps {
  createAgentRegistry?: (
    db: ReturnType<DaemonStorage["getDatabase"]>,
  ) => import("../agents/multi/agent-registry.js").AgentRegistry;
  createAgentBudgetTracker?: (
    daemonStorage: DaemonStorage,
  ) => import("../agents/multi/agent-budget-tracker.js").AgentBudgetTracker;
  createAgentManager?: (
    options: unknown,
  ) => import("../agents/multi/agent-manager.js").AgentManager;
  createDelegationLog?: (
    db: ReturnType<DaemonStorage["getDatabase"]>,
  ) => import("../agents/multi/delegation/delegation-log.js").DelegationLog;
  createTierRouter?: (
    tiers: Config["delegation"]["tiers"],
    db: ReturnType<DaemonStorage["getDatabase"]>,
  ) => import("../agents/multi/delegation/tier-router.js").TierRouter;
  createDelegationManager?: (
    options: unknown,
  ) => import("../agents/multi/delegation/delegation-manager.js").DelegationManager;
  createDelegationTools?: (
    delegationTypes: Config["delegation"]["types"],
    delegationManager: import("../agents/multi/delegation/delegation-manager.js").DelegationManager,
    parentAgentId: string,
    depth: number,
    maxDepth: number,
  ) => ITool[];
  defaultDelegationTypes?: Config["delegation"]["types"];
}

interface MemoryConsolidationStageDeps {
  isAgentDbAdapter?: (memoryManager: IMemoryManager) => boolean;
  getConsolidationInternals?: (memoryManager: IMemoryManager) => {
    sqliteDb?: unknown;
    entries: unknown[];
    hnswStore?: unknown;
  };
  createMemoryConsolidationEngine?: (
    options: unknown,
  ) => NonNullable<MemoryConsolidationStageResult["consolidationEngine"]>;
}

interface DeploymentStageDeps {
  createReadinessChecker?: (
    deploymentConfig: Config["deployment"],
    projectPath: string,
    logger: winston.Logger,
  ) => DeploymentReadinessCheckerContract;
  createDeploymentExecutor?: (
    deploymentConfig: Config["deployment"],
    projectPath: string,
    logger: winston.Logger,
    db: ReturnType<DaemonStorage["getDatabase"]>,
  ) => DeploymentExecutorContract;
  createDeployCircuitBreaker?: (
    failureThreshold: number,
    baseCooldownMs: number,
    maxCooldownMs: number,
  ) => unknown;
  createDeployTrigger?: (
    readinessChecker: DeploymentReadinessCheckerContract,
    approvalQueue: ApprovalQueue,
    circuitBreaker: unknown,
    deploymentExecutor: DeploymentExecutorContract,
    deploymentConfig: Config["deployment"],
    logger: winston.Logger,
  ) => DeploymentTriggerContract;
  registerDeployApprovalBridge?: (
    eventBus: IEventBus<DaemonEventMap>,
    approvalQueue: ApprovalQueue,
    deployTrigger: DeploymentTriggerContract,
    logger: winston.Logger,
  ) => unknown;
}

interface RuntimeIntelligenceStageDeps {
  createModelIntelligenceService?: (options: {
    refreshHours: number;
    providerSourcesPath: string;
  }) => import("../agents/providers/model-intelligence.js").ModelIntelligenceService;
  createTrajectoryPhaseSignalRetriever?: (
    learningStorage: LearningStorage,
  ) => import("../agent-core/routing/trajectory-phase-signal-retriever.js").TrajectoryPhaseSignalRetriever;
  createProviderRouter?: (
    providerManager: ProviderManager,
    preset: Config["routing"]["preset"],
    options: {
      modelIntelligence?: import("../agents/providers/model-intelligence.js").ModelIntelligenceService;
      trajectoryPhaseSignalRetriever?: import("../agent-core/routing/trajectory-phase-signal-retriever.js").TrajectoryPhaseSignalRetriever;
    },
  ) => import("../agent-core/routing/provider-router.js").ProviderRouter;
  createConsensusManager?: (
    config: {
      mode: Config["consensus"]["mode"];
      threshold: number;
      maxProviders: number;
    },
  ) => import("../agent-core/routing/consensus-manager.js").ConsensusManager;
  createConfidenceEstimator?: () => import("../agent-core/routing/confidence-estimator.js").ConfidenceEstimator;
}

interface ToolChainStageDeps {
  createChainDetector?: (
    learningStorage: LearningStorage,
    chainConfig: ToolChainConfig,
  ) => ChainDetector;
  createChainSynthesizer?: (
    learningStorage: LearningStorage,
    toolRegistry: ToolRegistry,
    learningEventBus: IEventBus<LearningEventMap>,
    chainConfig: ToolChainConfig,
  ) => ChainSynthesizer;
  createChainValidator?: (
    deps: ConstructorParameters<typeof ChainValidator>[0],
  ) => ChainValidator;
  createChainManager?: (
    detector: ChainDetector,
    synthesizer: ChainSynthesizer,
    toolRegistry: ToolRegistry,
    learningStorage: LearningStorage,
    orchestrator: ConstructorParameters<typeof ChainManager>[4],
    learningEventBus: IEventBus<LearningEventMap>,
    chainConfig: ToolChainConfig,
    chainValidator: ChainValidator,
  ) => ChainManager;
}

interface DashboardPostBootStageDeps {
  flattenConfig?: (config: Config) => Record<string, unknown>;
}

export async function verifyEmbeddingProviderConnection(
  cachedEmbeddingProvider: CachedEmbeddingProvider | undefined,
  embeddingStatus: BootstrapEmbeddingStatus,
  logger: winston.Logger,
  isTransientEmbeddingVerificationError: (error: unknown) => boolean,
): Promise<{
  cachedEmbeddingProvider?: CachedEmbeddingProvider;
  embeddingStatus: BootstrapEmbeddingStatus;
}> {
  if (!cachedEmbeddingProvider) {
    return { cachedEmbeddingProvider, embeddingStatus };
  }

  try {
    await cachedEmbeddingProvider.embed(["test"]);
    logger.info("Embedding provider verified");
    return {
      cachedEmbeddingProvider,
      embeddingStatus: {
        ...embeddingStatus,
        verified: true,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (isTransientEmbeddingVerificationError(error)) {
      const notice =
        `Embedding provider could not be verified at startup (${errorMessage}). ` +
        "Keeping live embeddings enabled and retrying on demand.";
      logger.warn(notice);
      return {
        cachedEmbeddingProvider,
        embeddingStatus: {
          ...embeddingStatus,
          verified: false,
          usingHashFallback: false,
          notice,
        },
      };
    }

    const notice = `Embedding provider unreachable, falling back to hash embeddings: ${errorMessage}`;
    logger.warn(notice);
    return {
      cachedEmbeddingProvider: undefined,
      embeddingStatus: {
        ...embeddingStatus,
        state: "degraded",
        verified: false,
        usingHashFallback: true,
        notice,
      },
    };
  }
}

export async function initializeProviderRuntimeStage(
  params: {
    channelType: string;
    config: Config;
    logger: winston.Logger;
  },
  deps: ProviderRuntimeStageDeps,
): Promise<ProviderRuntimeStageResult> {
  const auth = deps.initializeAuth(params.config, params.channelType, params.logger);
  const embeddingResult = await deps.resolveAndCacheEmbeddings(params.config, params.logger);
  const verifiedEmbedding = await verifyEmbeddingProviderConnection(
    embeddingResult.cachedProvider,
    embeddingResult.status,
    params.logger,
    deps.isTransientEmbeddingVerificationError,
  );

  const [providerInit, memoryManager, channel] = await Promise.all([
    deps.initializeAIProvider(params.config, params.logger),
    deps.initializeMemory(
      params.config,
      params.logger,
      verifiedEmbedding.cachedEmbeddingProvider,
    ),
    deps.initializeChannel(params.channelType, params.config, auth, params.logger),
  ]);

  const startupNotices = [...providerInit.notices];
  if (embeddingResult.notice) {
    startupNotices.push(embeddingResult.notice);
  }

  return {
    providerInit,
    memoryManager,
    channel,
    cachedEmbeddingProvider: verifiedEmbedding.cachedEmbeddingProvider,
    embeddingStatus: verifiedEmbedding.embeddingStatus,
    startupNotices,
  };
}

export async function initializeKnowledgeStage(
  params: {
    config: Config;
    logger: winston.Logger;
    cachedEmbeddingProvider?: CachedEmbeddingProvider;
    startupNotices: string[];
  },
  deps: KnowledgeStageDeps,
): Promise<KnowledgeStageResult> {
  const startupNotices = [...params.startupNotices];
  const ragResult = await deps.initializeRAG(
    params.config,
    params.logger,
    params.cachedEmbeddingProvider,
  );
  if (ragResult.notice) {
    startupNotices.push(ragResult.notice);
  }

  const learningResult = await deps.initializeLearning(
    params.config,
    params.logger,
    params.cachedEmbeddingProvider,
  );
  startupNotices.push(...learningResult.notices);

  return {
    ragPipeline: ragResult.pipeline,
    learningResult,
    startupNotices,
  };
}

export async function initializeOpsMonitoringStage(
  params: {
    config: Config;
    logger: winston.Logger;
    metrics: MetricsCollector;
    memoryManager?: IMemoryManager;
  },
  deps: OpsMonitoringStageDeps,
): Promise<OpsMonitoringStageResult> {
  const dashboard = await deps.initializeDashboard(
    params.config,
    params.metrics,
    params.memoryManager,
    params.logger,
  );

  const stoppableServers: Array<{ stop(): Promise<void> | void }> = [];
  if (params.config.websocketDashboard.enabled) {
    const { WebSocketDashboardServer } = await import("../dashboard/websocket-server.js");
    const wsDashboard = new WebSocketDashboardServer({
      port: params.config.websocketDashboard.port,
      authToken: params.config.websocketDashboard.authToken,
      allowedOrigins: params.config.websocketDashboard.allowedOrigins,
      metrics: params.metrics,
      getMemoryStats: () => params.memoryManager?.getStats(),
    });
    await wsDashboard.start();
    stoppableServers.push(wsDashboard);
    if (!params.config.websocketDashboard.authToken) {
      params.logger.info("WebSocket dashboard enabled without static auth token; using generated same-process auth token");
    }
    params.logger.info("WebSocket dashboard started", { port: params.config.websocketDashboard.port });
  }

  if (params.config.prometheus.enabled) {
    const { PrometheusMetrics } = await import("../dashboard/prometheus.js");
    const prometheus = new PrometheusMetrics(
      params.config.prometheus.port,
      params.metrics,
      () => params.memoryManager?.getStats(),
    );
    await prometheus.start();
    stoppableServers.push(prometheus);
    params.logger.warn("SECURITY: Prometheus metrics endpoint has no authentication — restrict access at network level");
    params.logger.info("Prometheus metrics started", { port: params.config.prometheus.port });
  }

  const rateLimiter = deps.initializeRateLimiter(params.config, params.logger);

  let metricsStorage: MetricsStorage | undefined;
  let metricsRecorder: MetricsRecorder | undefined;
  try {
    const metricsDbPath = join(params.config.memory.dbPath, "learning.db");
    metricsStorage = new MetricsStorage(metricsDbPath);
    metricsStorage.initialize();
    metricsRecorder = new MetricsRecorder(metricsStorage);
    params.logger.info("Metrics storage initialized", { dbPath: metricsDbPath });
  } catch (error) {
    params.logger.warn("Metrics storage initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    dashboard,
    stoppableServers,
    rateLimiter,
    metricsStorage,
    metricsRecorder,
  };
}

export function initializeRuntimeStateStage(
  params: {
    config: Config;
    logger: winston.Logger;
    learningResult: LearningResult;
    metricsStorage?: MetricsStorage;
    metricsRecorder?: MetricsRecorder;
  },
  deps: RuntimeStateStageDeps = {},
): RuntimeStateStageResult {
  let metricsStorage = params.metricsStorage;
  let metricsRecorder = params.metricsRecorder;

  if (!metricsStorage) {
    try {
      const metricsDbPath = join(params.config.memory.dbPath, "learning.db");
      const storage = deps.createMetricsStorage?.(metricsDbPath)
        ?? new MetricsStorage(metricsDbPath);
      storage.initialize();
      metricsStorage = storage;
      metricsRecorder = deps.createMetricsRecorder?.(storage)
        ?? new MetricsRecorder(storage);
      params.logger.info("Metrics storage initialized", { dbPath: metricsDbPath });
    } catch (error) {
      params.logger.warn("Metrics storage initialization failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let identityManager: IdentityStateManager | undefined;
  let uptimeInterval: ReturnType<typeof setInterval> | undefined;
  try {
    const identityDbPath = join(params.config.memory.dbPath, "identity.db");
    identityManager = deps.createIdentityManager?.(identityDbPath, params.config.agentName)
      ?? new IdentityStateManager(identityDbPath, params.config.agentName);
    identityManager.initialize();
    identityManager.recordBoot();
    identityManager.setProjectContext(params.config.unityProjectPath);

    let lastFlushTime = Date.now();
    uptimeInterval = setInterval(() => {
      const now = Date.now();
      identityManager!.updateUptime(now - lastFlushTime);
      identityManager!.flush();
      lastFlushTime = now;
    }, 60000);

    params.logger.info("Identity initialized", {
      bootNumber: identityManager.getState().bootCount,
      wasCrash: identityManager.wasCrash(),
    });
  } catch (error) {
    params.logger.warn("Identity initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const runtimeArtifactManager = params.learningResult.pipeline?.getRuntimeArtifactManager()
    ?? (params.learningResult.storage
      ? (deps.createRuntimeArtifactManager?.(params.learningResult.storage)
        ?? new RuntimeArtifactManager(params.learningResult.storage))
      : undefined);

  let instinctRetriever: InstinctRetriever | undefined;
  let trajectoryReplayRetriever: TrajectoryReplayRetriever | undefined;
  if (params.learningResult.patternMatcher) {
    const scopeContext: ScopeContext = {
      projectPath: params.config.unityProjectPath,
      scopeFilter: params.config.crossSession.scopeFilter,
      maxAgeDays: params.config.crossSession.maxAgeDays,
      recencyBoost: params.config.crossSession.recencyBoost,
      scopeBoost: params.config.crossSession.scopeBoost,
      currentBootCount: identityManager?.getState().bootCount,
      currentSessionId: `boot-${identityManager?.getState().bootCount ?? 0}`,
    };

    instinctRetriever = deps.createInstinctRetriever?.(
      params.learningResult.patternMatcher,
      {
        scopeContext,
        storage: params.learningResult.storage,
        metricsRecorder,
      },
    ) ?? new InstinctRetriever(params.learningResult.patternMatcher, {
      scopeContext,
      storage: params.learningResult.storage,
      metricsRecorder,
    });
  }

  if (params.learningResult.storage) {
    trajectoryReplayRetriever = deps.createTrajectoryReplayRetriever?.(params.learningResult.storage)
      ?? new TrajectoryReplayRetriever(params.learningResult.storage);
  }

  if (params.learningResult.pipeline) {
    params.learningResult.pipeline.setProjectPath(params.config.unityProjectPath);
    params.learningResult.pipeline.setPromotionThreshold(params.config.crossSession.promotionThreshold);
  }

  return {
    metricsStorage,
    metricsRecorder,
    identityManager,
    uptimeInterval,
    runtimeArtifactManager,
    instinctRetriever,
    trajectoryReplayRetriever,
  };
}

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
  getIdentityState?: () => import("../identity/identity-state.js").IdentityState;
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

export async function initializeSessionRuntimeStage(
  params: {
    config: Config;
    logger: winston.Logger;
    memoryManager?: IMemoryManager;
    providerManager: ProviderManager;
    channel: IChannelAdapter;
  },
  deps: SessionRuntimeStageDeps = {},
): Promise<SessionRuntimeStageResult> {
  const runtimePaths = resolveRuntimePaths({ moduleUrl: import.meta.url });
  const soulOverrides: Record<string, string> = {};
  for (const channel of ["telegram", "discord", "slack", "whatsapp", "web"] as const) {
    const envValue = process.env[`SOUL_FILE_${channel.toUpperCase()}`];
    if (envValue) {
      soulOverrides[channel] = envValue;
    }
  }

  const soulBasePath = runtimePaths.configRoot;
  const soulLoader = deps.createSoulLoader?.(soulBasePath, {
    soulFile: process.env.SOUL_FILE ?? "soul.md",
    channelOverrides: Object.keys(soulOverrides).length > 0 ? soulOverrides : undefined,
  }) ?? new SoulLoader(soulBasePath, {
    soulFile: process.env.SOUL_FILE ?? "soul.md",
    channelOverrides: Object.keys(soulOverrides).length > 0 ? soulOverrides : undefined,
  });
  await soulLoader.initialize();

  let sessionSummarizer: import("../memory/unified/session-summarizer.js").SessionSummarizer | undefined;
  let userProfileStore: import("../memory/unified/user-profile-store.js").UserProfileStore | undefined;
  let taskExecutionStore: import("../memory/unified/task-execution-store.js").TaskExecutionStore | undefined;
  const isAgentDbAdapter = deps.isAgentDbAdapter ?? ((memoryManager: IMemoryManager): memoryManager is AgentDBAdapter =>
    memoryManager instanceof AgentDBAdapter);

  if (params.memoryManager) {
    try {
      if (isAgentDbAdapter(params.memoryManager)) {
        const profileStore = params.memoryManager.getUserProfileStore();
        const executionStore = params.memoryManager.getTaskExecutionStore();
        if (profileStore) {
          userProfileStore = profileStore;
        }
        if (executionStore) {
          taskExecutionStore = executionStore;
          sessionSummarizer = deps.createSessionSummarizer?.(
            params.providerManager.getProvider(""),
            executionStore,
          );
          if (!sessionSummarizer) {
            const { SessionSummarizer } = await import("../memory/unified/session-summarizer.js");
            sessionSummarizer = new SessionSummarizer(params.providerManager.getProvider(""), executionStore);
          }
          params.logger.info("SessionSummarizer wired for session-end summarization");
        }
      }
    } catch {
      params.logger.debug("SessionSummarizer wiring skipped");
    }
  }

  return {
    soulLoader,
    sessionSummarizer,
    userProfileStore,
    taskExecutionStore,
    dmPolicy: deps.createDMPolicy?.(params.channel) ?? new DMPolicy(params.channel),
  };
}

export async function initializeTaskRuntimeStage(
  params: {
    daemonMode: boolean;
    config: Config;
    logger: winston.Logger;
    orchestrator: Orchestrator;
    providerManager: ProviderManager;
    channel: IChannelAdapter;
    dmPolicy: DMPolicy;
    userProfileStore?: import("../memory/unified/user-profile-store.js").UserProfileStore;
    soulLoader: SoulLoader;
    runtimeArtifactManager?: RuntimeArtifactManager;
    activityRegistry: ChannelActivityRegistry;
    goalDecomposer?: GoalDecomposer;
    goalStorage?: GoalStorage;
    goalExecutorConfig: GoalExecutorConfig;
    learningEventBus?: IEventBus<LearningEventMap>;
    identityManager?: IdentityStateManager;
    providerRouter?: Parameters<CommandHandler["setProviderRouter"]>[0];
    startupNotices: string[];
  },
  deps: TaskRuntimeStageDeps = {},
): Promise<TaskRuntimeStageResult> {
  const daemonEventBus = params.daemonMode
    ? (deps.createDaemonEventBus?.() ?? new TypedEventBus<DaemonEventMap>())
    : undefined;

  const taskDbPath = join(params.config.memory.dbPath, "tasks.db");
  const taskStorage = deps.createTaskStorage?.(taskDbPath) ?? new TaskStorage(taskDbPath);
  taskStorage.initialize();
  params.logger.info("Task storage initialized", { dbPath: taskDbPath });

  let workspaceLeaseManager: WorkspaceLeaseManager | undefined;
  try {
    workspaceLeaseManager = new WorkspaceLeaseManager({
      projectRoot: params.config.unityProjectPath,
    });
  } catch (error) {
    params.logger.warn("Workspace isolation disabled for background executor", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const backgroundExecutorOptions: ConstructorParameters<typeof BackgroundExecutor>[0] = {
    orchestrator: params.orchestrator,
    concurrencyLimit: params.config.tasks.concurrencyLimit,
    decomposer: params.goalDecomposer,
    goalStorage: params.goalStorage,
    goalExecutorConfig: params.goalExecutorConfig,
    aiProvider: params.providerManager.getProvider(""),
    channel: params.channel,
    daemonEventBus,
    goalConfig: params.config.goal,
    learningEventBus: params.learningEventBus,
    workspaceLeaseManager,
  };
  const backgroundExecutor = deps.createBackgroundExecutor?.(backgroundExecutorOptions)
    ?? new BackgroundExecutor(backgroundExecutorOptions);
  const taskManager = deps.createTaskManager?.(taskStorage, backgroundExecutor)
    ?? new TaskManager(taskStorage, backgroundExecutor);

  backgroundExecutor.setTaskManager(taskManager);
  params.orchestrator.setTaskManager(taskManager);
  taskManager.recoverOnStartup();
  if (params.identityManager) {
    taskManager.on("task:created", () => {
      params.identityManager!.incrementTasks();
    });
  }

  let autoUpdater: AutoUpdater | undefined;
  if (params.config.autoUpdate.enabled) {
    autoUpdater = deps.createAutoUpdater?.(
      params.config,
      params.activityRegistry,
      backgroundExecutor,
    ) ?? new AutoUpdater(params.config, params.activityRegistry, backgroundExecutor);
    autoUpdater.setNotifyFn((msg: string) => {
      const chats = params.activityRegistry.getActiveChatIds();
      for (const { chatId } of chats) {
        params.channel.sendMarkdown(chatId, msg).catch(() => {});
      }
    });
    await autoUpdater.init();
    autoUpdater.scheduleChecks();
  }

  const projectScopeFingerprint = deps.createProjectScopeFingerprint?.(params.config.unityProjectPath)
    ?? createProjectScopeFingerprint(params.config.unityProjectPath);

  const commandHandler = deps.createCommandHandler?.({
    taskManager,
    channel: params.channel,
    providerManager: params.providerManager,
    dmPolicy: params.dmPolicy,
    userProfileStore: params.userProfileStore,
    soulLoader: params.soulLoader,
    runtimeArtifactManager: params.runtimeArtifactManager,
    projectScopeFingerprint,
    autonomousDefaultEnabled: params.config.autonomousDefaultEnabled,
    autonomousDefaultHours: params.config.autonomousDefaultHours,
  }) ?? new CommandHandler(
    taskManager,
    params.channel,
    params.providerManager,
    params.dmPolicy,
    params.userProfileStore,
    params.soulLoader,
    params.runtimeArtifactManager,
    projectScopeFingerprint,
    undefined,
    {
      autonomousDefaultEnabled: params.config.autonomousDefaultEnabled,
      autonomousDefaultHours: params.config.autonomousDefaultHours,
    },
  );
  if (params.providerRouter) {
    commandHandler.setProviderRouter(params.providerRouter);
  }

  const messageRouter = deps.createMessageRouter?.({
    taskManager,
    commandHandler,
    channel: params.channel,
    startupNotices: params.startupNotices,
    burstWindowMs: params.config.tasks.messageBurstWindowMs,
    maxBurstMessages: params.config.tasks.messageBurstMaxMessages,
  }) ?? new MessageRouter(taskManager, commandHandler, params.channel, params.startupNotices, {
    burstWindowMs: params.config.tasks.messageBurstWindowMs,
    maxBurstMessages: params.config.tasks.messageBurstMaxMessages,
  });

  if (deps.createProgressReporter) {
    deps.createProgressReporter(params.channel, taskManager, params.config.interaction);
  } else {
    new ProgressReporter(params.channel, taskManager, params.config.interaction);
  }

  return {
    daemonEventBus,
    taskStorage,
    backgroundExecutor,
    taskManager,
    autoUpdater,
    projectScopeFingerprint,
    commandHandler,
    messageRouter,
  };
}

export function loadDaemonTriggersStage(
  params: {
    daemonConfig: Config["daemon"];
    logger: winston.Logger;
    triggerRegistry: TriggerRegistry;
    projectRoot?: string;
  },
  deps: DaemonTriggerStageDeps = {},
): DaemonTriggerStageResult {
  const projectRoot = params.projectRoot ?? resolveRuntimePaths({ moduleUrl: import.meta.url }).configRoot;
  const heartbeatPath = resolve(projectRoot, params.daemonConfig.heartbeat.heartbeatFile);
  if (!heartbeatPath.startsWith(projectRoot + "/") && heartbeatPath !== projectRoot) {
    throw new AppError("HEARTBEAT file path is outside project root", "DAEMON_CONFIG_ERROR", 400);
  }

  const webhookTriggers = new Map<string, WebhookTrigger>();
  const typeCounts = new Map<string, number>();
  try {
    const content = (deps.readFile ?? readFileSync)(heartbeatPath, "utf-8");
    const triggerDefs = (deps.parseHeartbeatFile ?? parseHeartbeatFile)(content, {
      morningHour: params.daemonConfig.triggers.checklistMorningHour,
      afternoonHour: params.daemonConfig.triggers.checklistAfternoonHour,
      eveningHour: params.daemonConfig.triggers.checklistEveningHour,
    });
    for (const def of triggerDefs) {
      if (def.enabled === false) continue;
      let trigger: ITrigger;
      switch (def.type) {
        case "cron":
          trigger = deps.createCronTrigger?.(
            { name: def.name, description: def.action, type: "cron", cooldownSeconds: def.cooldown },
            def.cron,
            params.daemonConfig.timezone || undefined,
          ) ?? new CronTrigger(
            { name: def.name, description: def.action, type: "cron", cooldownSeconds: def.cooldown },
            def.cron,
            params.daemonConfig.timezone || undefined,
          );
          break;
        case "file-watch": {
          const resolvedWatchPath = resolve(projectRoot, def.path);
          if (!resolvedWatchPath.startsWith(projectRoot + "/") && resolvedWatchPath !== projectRoot) {
            params.logger.warn("File-watch path outside project root, skipping", {
              trigger: def.name,
              path: def.path,
            });
            continue;
          }
          trigger = deps.createFileWatchTrigger?.({
            ...def,
            path: resolvedWatchPath,
            debounce: def.debounce ?? params.daemonConfig.triggers.defaultDebounceMs,
          }) ?? new FileWatchTrigger({
            ...def,
            path: resolvedWatchPath,
            debounce: def.debounce ?? params.daemonConfig.triggers.defaultDebounceMs,
          });
          break;
        }
        case "checklist":
          trigger = deps.createChecklistTrigger?.(
            def,
            params.daemonConfig.timezone || undefined,
          ) ?? new ChecklistTrigger(def, params.daemonConfig.timezone || undefined);
          break;
        case "webhook": {
          const webhookTrigger = deps.createWebhookTrigger?.(def.name, def.action)
            ?? new WebhookTrigger(def.name, def.action);
          webhookTriggers.set(def.name, webhookTrigger);
          trigger = webhookTrigger;
          break;
        }
        default:
          params.logger.warn(`Unknown trigger type '${(def as { type: string }).type}', skipping`);
          continue;
      }
      params.triggerRegistry.register(trigger);
      typeCounts.set(def.type, (typeCounts.get(def.type) ?? 0) + 1);
    }

    params.logger.info("Daemon triggers loaded", {
      total: params.triggerRegistry.count(),
      byType: Object.fromEntries(typeCounts),
      file: heartbeatPath,
    });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      params.logger.warn("HEARTBEAT.md not found", { path: heartbeatPath });
    } else {
      throw err;
    }
  }

  return {
    heartbeatPath,
    webhookTriggers,
  };
}

export function initializeDaemonHeartbeatStage(
  params: {
    config: Config;
    logger: winston.Logger;
    toolRegistry: ToolRegistry;
    backgroundExecutor: BackgroundExecutor;
    taskManager: TaskManager;
    commandHandler: CommandHandler;
    daemonEventBus: IEventBus<DaemonEventMap>;
    identityManager?: IdentityStateManager;
    crashContext: CrashRecoveryContext | null;
  },
  deps: DaemonHeartbeatStageDeps = {},
): DaemonHeartbeatStageResult {
  const daemonConfig = params.config.daemon;
  const daemonDbPath = join(params.config.memory.dbPath, "daemon.db");
  const daemonStorage = deps.createDaemonStorage?.(daemonDbPath) ?? new DaemonStorage(daemonDbPath);
  daemonStorage.initialize();

  const triggerRegistry = deps.createTriggerRegistry?.() ?? new TriggerRegistry();
  const budgetTracker = deps.createBudgetTracker?.(daemonStorage, daemonConfig.budget)
    ?? new BudgetTracker(daemonStorage, daemonConfig.budget);
  params.backgroundExecutor.setDaemonBudgetTracker(budgetTracker);

  const approvalQueue = deps.createApprovalQueue?.(
    daemonStorage,
    daemonConfig.security.approvalTimeoutMin,
    params.daemonEventBus,
  ) ?? new ApprovalQueue(
    daemonStorage,
    daemonConfig.security.approvalTimeoutMin,
    params.daemonEventBus,
  );
  const securityPolicy = deps.createSecurityPolicy?.(
    (name) => params.toolRegistry.getMetadata(name),
    approvalQueue,
    new Set(daemonConfig.security.autoApproveTools),
  ) ?? new DaemonSecurityPolicy(
    (name) => params.toolRegistry.getMetadata(name),
    approvalQueue,
    new Set(daemonConfig.security.autoApproveTools),
  );

  const { webhookTriggers } = loadDaemonTriggersStage({
    daemonConfig,
    logger: params.logger,
    triggerRegistry,
  }, deps);

  const deduplicator = deps.createTriggerDeduplicator?.(daemonConfig.triggers.dedupWindowMs)
    ?? new TriggerDeduplicator(daemonConfig.triggers.dedupWindowMs);
  const heartbeatLoop = deps.createHeartbeatLoop?.(
    triggerRegistry,
    params.taskManager,
    budgetTracker,
    securityPolicy,
    approvalQueue,
    daemonStorage,
    params.identityManager,
    params.daemonEventBus,
    daemonConfig,
    params.logger,
    deduplicator,
  ) ?? new HeartbeatLoop(
    triggerRegistry,
    params.taskManager,
    budgetTracker,
    securityPolicy,
    approvalQueue,
    daemonStorage,
    params.identityManager,
    params.daemonEventBus,
    daemonConfig,
    params.logger,
    deduplicator,
  );

  if (params.crashContext?.wasCrash) {
    const wasDaemonRunning = daemonStorage.getDaemonState("daemon_was_running");
    if (wasDaemonRunning === "true") {
      params.logger.info("Daemon auto-restarting after crash recovery");
    }
  }

  heartbeatLoop.start();
  params.commandHandler.setHeartbeatLoop({
    start: () => heartbeatLoop.start(),
    stop: () => heartbeatLoop.stop(),
    isRunning: () => heartbeatLoop.isRunning(),
    getDaemonStatus: () => heartbeatLoop.getDaemonStatus(),
    getSecurityPolicy: () => securityPolicy,
  });

  return {
    daemonStorage,
    triggerRegistry,
    budgetTracker,
    approvalQueue,
    securityPolicy,
    heartbeatLoop,
    webhookTriggers,
  };
}

export async function initializeMultiAgentDelegationStage(
  params: {
    config: Config;
    logger: winston.Logger;
    daemonMode: boolean;
    daemonStorage: DaemonStorage;
    daemonContext: import("../daemon/daemon-cli.js").DaemonContext;
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
    userProfileStore?: import("../memory/unified/user-profile-store.js").UserProfileStore;
    providerRouter?: { setTierRouter(router: unknown): void };
    dashboard?: Pick<DashboardServer, "registerDelegationServices">;
    stradaDeps: StradaDepsStatus;
  },
  deps: MultiAgentDelegationStageDeps = {},
): Promise<MultiAgentDelegationStageResult> {
  if (!params.config.agent.enabled) {
    return {};
  }

  const { AgentManager } = await import("../agents/multi/agent-manager.js");
  const { AgentRegistry } = await import("../agents/multi/agent-registry.js");
  const { AgentBudgetTracker } = await import("../agents/multi/agent-budget-tracker.js");

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
  } satisfies ConstructorParameters<typeof AgentManager>[0];

  const agentManager = deps.createAgentManager?.(agentManagerOptions)
    ?? new AgentManager(agentManagerOptions);
  params.daemonContext.agentManager = agentManager;
  params.daemonContext.agentBudgetTracker = agentBudgetTracker;

  if (params.daemonMode) {
    agentManager.setBackgroundTaskSubmitter((msg, agent) => {
      params.taskManager.submit(msg.chatId, msg.channelType, msg.text, {
        attachments: msg.attachments,
        conversationId: msg.conversationId,
        orchestrator: agentManager.getLiveOrchestrator(agent.id),
        userId: msg.userId,
      });
    });
  }

  params.logger.info("Multi-agent system initialized", {
    maxConcurrent: params.config.agent.maxConcurrent,
    defaultBudget: params.config.agent.defaultBudgetUsd,
    idleTimeoutMs: params.config.agent.idleTimeoutMs,
  });

  let delegationManager: import("../agents/multi/delegation/delegation-manager.js").DelegationManager | undefined;
  if (params.config.delegation.enabled) {
    const { TierRouter } = await import("../agents/multi/delegation/tier-router.js");
    const { DelegationLog } = await import("../agents/multi/delegation/delegation-log.js");
    const { DelegationManager } = await import("../agents/multi/delegation/delegation-manager.js");
    const { createDelegationTools, DEFAULT_DELEGATION_TYPES } = await import("../agents/multi/delegation/index.js");

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
    daemonContext: import("../daemon/daemon-cli.js").DaemonContext;
  },
  deps: MemoryConsolidationStageDeps = {},
): Promise<MemoryConsolidationStageResult> {
  if (!params.config.memory.consolidation.enabled || !params.memoryManager) {
    return {};
  }

  try {
    const isAgentDbAdapter = deps.isAgentDbAdapter ?? (async (memoryManager: IMemoryManager): Promise<boolean> => {
      const { AgentDBAdapter: AdapterCheck } = await import("../memory/unified/agentdb-adapter.js");
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
      return import("../memory/unified/consolidation-engine.js").then(({ MemoryConsolidationEngine }) =>
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
    daemonContext: import("../daemon/daemon-cli.js").DaemonContext;
  },
  deps: DeploymentStageDeps = {},
): Promise<DeploymentStageResult> {
  if (!params.config.deployment.enabled) {
    return {};
  }

  try {
    const { DeployTrigger } = await import("../daemon/triggers/deploy-trigger.js");
    const { registerDeployApprovalBridge } = await import("../daemon/triggers/deploy-approval-bridge.js");
    const { ReadinessChecker } = await import("../daemon/deployment/readiness-checker.js");
    const { DeploymentExecutor } = await import("../daemon/deployment/deployment-executor.js");
    const { CircuitBreaker: DeployCircuitBreaker } = await import("../daemon/resilience/circuit-breaker.js");

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

export async function initializeRuntimeIntelligenceStage(
  params: {
    config: Config;
    logger: winston.Logger;
    providerManager: ProviderManager;
    learningStorage?: LearningStorage;
  },
  deps: RuntimeIntelligenceStageDeps = {},
): Promise<RuntimeIntelligenceStageResult> {
  let modelIntelligence: import("../agents/providers/model-intelligence.js").ModelIntelligenceService | undefined;
  if (params.config.modelIntelligence.enabled) {
    try {
      const { ModelIntelligenceService } = await import("../agents/providers/model-intelligence.js");
      modelIntelligence = deps.createModelIntelligenceService?.({
        refreshHours: params.config.modelIntelligence.refreshHours,
        providerSourcesPath: params.config.modelIntelligence.providerSourcesPath,
      }) ?? new ModelIntelligenceService({
        refreshHours: params.config.modelIntelligence.refreshHours,
        providerSourcesPath: params.config.modelIntelligence.providerSourcesPath,
      });
      await modelIntelligence.initialize(params.config.modelIntelligence.dbPath, {
        refreshOnInitialize: false,
      });
      params.providerManager.setModelCatalog?.(modelIntelligence);
      params.logger.info("ModelIntelligenceService initialized", {
        dbPath: params.config.modelIntelligence.dbPath,
        refreshHours: params.config.modelIntelligence.refreshHours,
      });
    } catch (error) {
      params.logger.warn("ModelIntelligenceService initialization failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let providerRouter: import("../agent-core/routing/provider-router.js").ProviderRouter | undefined;
  try {
    const { ProviderRouter } = await import("../agent-core/routing/provider-router.js");
    const { TrajectoryPhaseSignalRetriever } = await import("../agent-core/routing/trajectory-phase-signal-retriever.js");
    const trajectoryPhaseSignalRetriever = params.learningStorage
      ? (deps.createTrajectoryPhaseSignalRetriever?.(params.learningStorage)
        ?? new TrajectoryPhaseSignalRetriever(params.learningStorage))
      : undefined;
    providerRouter = deps.createProviderRouter?.(
      params.providerManager,
      params.config.routing.preset,
      {
        modelIntelligence,
        trajectoryPhaseSignalRetriever,
      },
    ) ?? new ProviderRouter(params.providerManager, params.config.routing.preset, {
      modelIntelligence,
      trajectoryPhaseSignalRetriever,
    });
    params.logger.info("ProviderRouter initialized", { preset: params.config.routing.preset });
  } catch {
    // Non-fatal — routing disabled
  }

  let consensusManager: import("../agent-core/routing/consensus-manager.js").ConsensusManager | undefined;
  let confidenceEstimator: import("../agent-core/routing/confidence-estimator.js").ConfidenceEstimator | undefined;
  try {
    const { ConsensusManager } = await import("../agent-core/routing/consensus-manager.js");
    consensusManager = deps.createConsensusManager?.({
      mode: params.config.consensus.mode,
      threshold: params.config.consensus.threshold,
      maxProviders: params.config.consensus.maxProviders,
    }) ?? new ConsensusManager({
      mode: params.config.consensus.mode,
      threshold: params.config.consensus.threshold,
      maxProviders: params.config.consensus.maxProviders,
    });
    const { ConfidenceEstimator } = await import("../agent-core/routing/confidence-estimator.js");
    confidenceEstimator = deps.createConfidenceEstimator?.() ?? new ConfidenceEstimator();
    params.logger.info("ConsensusManager initialized", { mode: params.config.consensus.mode });
  } catch {
    // Non-fatal — consensus disabled
  }

  return {
    modelIntelligence,
    providerRouter,
    consensusManager,
    confidenceEstimator,
  };
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

export function registerDashboardPostBootStage(
  params: {
    dashboard?: Pick<DashboardServer,
      "registerAgentServices"
      | "registerConsolidationDeploymentServices"
      | "registerExtendedServices"
      | "setProviderRouter">;
    agentManager?: import("../agents/multi/agent-manager.js").AgentManager;
    agentBudgetTracker?: import("../agents/multi/agent-budget-tracker.js").AgentBudgetTracker;
    daemonContext?: import("../daemon/daemon-cli.js").DaemonContext;
    toolRegistry: ToolRegistry;
    orchestrator: Orchestrator;
    soulLoader: SoulLoader;
    config: Config;
    providerManager: ProviderManager;
    userProfileStore?: import("../memory/unified/user-profile-store.js").UserProfileStore;
    embeddingStatus: BootstrapEmbeddingStatus;
    stradaDeps: StradaDepsStatus;
    bootReport: BootReport;
    providerRouter?: import("../agent-core/routing/provider-router.js").ProviderRouter;
  },
  deps: DashboardPostBootStageDeps = {},
): void {
  if (!params.dashboard) {
    return;
  }

  if (params.agentManager) {
    params.dashboard.registerAgentServices({
      agentManager: params.agentManager,
      agentBudgetTracker: params.agentBudgetTracker,
    });
  }

  if (params.daemonContext) {
    params.dashboard.registerConsolidationDeploymentServices({
      consolidationEngine: params.daemonContext.consolidationEngine,
      deploymentExecutor: params.daemonContext.deploymentExecutor,
      readinessChecker: params.daemonContext.readinessChecker,
    });
  }

  const flatConfig = deps.flattenConfig?.(params.config) ?? (() => {
    const flat: Record<string, unknown> = {};
    const flatten = (obj: Record<string, unknown>, prefix = "") => {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "function") continue;
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
          flatten(v as Record<string, unknown>, key);
        } else {
          flat[key] = v;
        }
      }
    };
    flatten(params.config as unknown as Record<string, unknown>);
    return flat;
  })();

  params.dashboard.registerExtendedServices({
    toolRegistry: {
      getAllTools: () => params.toolRegistry.getAllTools().map((tool) => {
        const meta = params.toolRegistry.getMetadata(tool.name);
        return {
          name: tool.name,
          description: tool.description,
          type: meta?.category ?? "builtin",
        };
      }),
    },
    orchestratorSessions: params.orchestrator,
    soulLoader: params.soulLoader,
    configSnapshot: () => flatConfig,
    providerManager: {
      listAvailable: () => params.providerManager.listAvailable().map((provider) => ({
        ...provider,
        configured: true,
        models: [provider.defaultModel],
      })),
      listExecutionCandidates: (identityKey?: string) =>
        params.providerManager.listExecutionCandidates(identityKey).map((provider) => ({
          ...provider,
          configured: true,
          models: [provider.defaultModel],
        })),
      listAvailableWithModels: async () => {
        const results = await params.providerManager.listAvailableWithModels();
        return results.map((provider) => ({
          ...provider,
          configured: true,
          activeModel: provider.defaultModel,
        }));
      },
      describeAvailable: () => params.providerManager.describeAvailable(),
      getProviderCapabilities: (name: string, model?: string) =>
        params.providerManager.getProviderCapabilities(name, model),
      getActiveInfo: (chatId: string) => {
        const info = params.providerManager.getActiveInfo(chatId);
        return info ? {
          provider: info.providerName,
          providerName: info.providerName,
          model: info.model,
          isDefault: info.isDefault,
          selectionMode: info.selectionMode,
          executionPolicyNote: info.executionPolicyNote,
        } : null;
      },
      setPreference: async (
        chatId: string,
        provider: string,
        model?: string,
        selectionMode?: "strada-preference-bias" | "strada-hard-pin",
      ) => {
        params.providerManager.setPreference(chatId, provider, model, selectionMode);
      },
      refreshCatalog: async () => params.providerManager.refreshModelCatalog(),
    },
    userProfileStore: params.userProfileStore,
    embeddingStatusProvider: {
      getStatus: () => ({ ...params.embeddingStatus }),
    },
    stradaDeps: params.stradaDeps,
    bootReport: params.bootReport,
  });

  if (params.providerRouter) {
    params.dashboard.setProviderRouter(params.providerRouter);
  }
}

export async function finalizeChannelStartupStage(params: {
  beforeChannelConnect?: (() => Promise<void> | void) | undefined;
  channel: IChannelAdapter;
  logger: winston.Logger;
  config: Config;
  channelType: string;
  daemonMode: boolean;
  providerHealthy?: boolean;
  embeddingStatus: BootstrapEmbeddingStatus;
  deploymentWired: boolean;
  alertingWired: boolean;
  backupWired: boolean;
  startupNotices: string[];
  moduleUrl: string;
}): Promise<BootReport> {
  if (params.beforeChannelConnect) {
    await params.beforeChannelConnect();
  }
  await params.channel.connect();
  params.logger.info("Strada Brain is running!");

  const runtimePaths = resolveRuntimePaths({ moduleUrl: params.moduleUrl });
  const bootReport = buildBootReport({
    config: params.config,
    installRoot: runtimePaths.installRoot,
    channelType: params.channelType,
    channelHealthy: params.channel.isHealthy(),
    daemonMode: params.daemonMode,
    providerHealthy: params.providerHealthy,
    embeddingStatus: params.embeddingStatus,
    deploymentWired: params.deploymentWired,
    alertingWired: params.alertingWired,
    backupWired: params.backupWired,
    startupNotices: params.startupNotices,
  });

  params.logger.info("Boot report", {
    summary: summarizeBootReport(bootReport),
    stages: bootReport.stages.map((stage) => ({
      id: stage.id,
      status: stage.status,
    })),
  });
  if (params.startupNotices.length > 0) {
    params.logger.warn("Startup capability notices", {
      notices: [...new Set(params.startupNotices)],
    });
  }

  return bootReport;
}
