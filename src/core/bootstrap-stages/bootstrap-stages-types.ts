import type { Config } from "../../config/config.js";
import type * as winston from "winston";
import type { AuthManager } from "../../security/auth.js";
import type { IChannelAdapter } from "../../channels/channel.interface.js";
import type { IMemoryManager } from "../../memory/memory.interface.js";
import type { IRAGPipeline } from "../../rag/rag.interface.js";
import type { CachedEmbeddingProvider } from "../../rag/embeddings/embedding-cache.js";
import type { ProviderManager } from "../../agents/providers/provider-manager.js";
import type { DashboardServer } from "../../dashboard/server.js";
import type { MetricsCollector } from "../../dashboard/metrics.js";
import type { RateLimiter } from "../../security/rate-limiter.js";
import { MetricsStorage } from "../../metrics/metrics-storage.js";
import { MetricsRecorder } from "../../metrics/metrics-recorder.js";
import type { LearningPipeline, LearningStorage, PatternMatcher } from "../../learning/index.js";
import { TypedEventBus, type IEventBus, type LearningEventMap } from "../event-bus.js";
import type { LearningQueue } from "../../learning/pipeline/learning-queue.js";
import type { TaskPlanner } from "../../agents/autonomy/task-planner.js";
import type { ErrorRecoveryEngine } from "../../agents/autonomy/error-recovery.js";
import type { InterventionEngine } from "../../learning/intervention/intervention-engine.js";
import { IdentityStateManager } from "../../identity/identity-state.js";
import { InstinctRetriever } from "../../agents/instinct-retriever.js";
import { TrajectoryReplayRetriever } from "../../agents/trajectory-replay-retriever.js";
import type { RuntimeArtifactManager } from "../../learning/index.js";
import type { ScopeContext } from "../../learning/matching/pattern-matcher.js";
import { GoalStorage, GoalDecomposer } from "../../goals/index.js";
import type { GoalExecutorConfig } from "../../goals/index.js";
import type { GoalTree } from "../../goals/types.js";
import type { CrashRecoveryContext } from "../../identity/crash-recovery.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import { ToolRegistry } from "../tool-registry.js";
import { SoulLoader } from "../../agents/soul/index.js";
import { AgentDBAdapter } from "../../memory/unified/agentdb-adapter.js";
import { DMPolicy } from "../../security/dm-policy.js";
import {
  BackgroundExecutor,
  CommandHandler,
  MessageRouter,
  ProgressReporter,
  TaskManager,
  TaskStorage,
} from "../../tasks/index.js";
import type { DaemonEventMap } from "../../daemon/daemon-events.js";
import { AutoUpdater } from "../auto-updater.js";
import type { ChannelActivityRegistry } from "../channel-activity-registry.js";
import { FileWatchTrigger } from "../../daemon/triggers/file-watch-trigger.js";
import { ChecklistTrigger } from "../../daemon/triggers/checklist-trigger.js";
import { WebhookTrigger } from "../../daemon/triggers/webhook-trigger.js";
import { parseHeartbeatFile } from "../../daemon/heartbeat-parser.js";
import type { ITrigger } from "../../daemon/daemon-types.js";
import { TriggerRegistry } from "../../daemon/trigger-registry.js";
import { HeartbeatLoop } from "../../daemon/heartbeat-loop.js";
import { DaemonStorage } from "../../daemon/daemon-storage.js";
import { BudgetTracker } from "../../daemon/budget/budget-tracker.js";
import { ApprovalQueue } from "../../daemon/security/approval-queue.js";
import { DaemonSecurityPolicy } from "../../daemon/security/daemon-security-policy.js";
import { TriggerDeduplicator } from "../../daemon/dedup/trigger-deduplicator.js";
import type { ITool } from "../../agents/tools/tool.interface.js";
import {
  ChainDetector,
  ChainSynthesizer,
  ChainManager,
  ChainValidator,
  type ToolChainConfig,
} from "../../learning/chains/index.js";

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
  interventionEngine?: InterventionEngine;
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
  sessionSummarizer?: import("../../memory/unified/session-summarizer.js").SessionSummarizer;
  userProfileStore?: import("../../memory/unified/user-profile-store.js").UserProfileStore;
  taskExecutionStore?: import("../../memory/unified/task-execution-store.js").TaskExecutionStore;
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
  agentManager?: import("../../agents/multi/agent-manager.js").AgentManager;
  agentBudgetTracker?: import("../../agents/multi/agent-budget-tracker.js").AgentBudgetTracker;
  delegationManager?: import("../../agents/multi/delegation/delegation-manager.js").DelegationManager;
}

export interface MemoryConsolidationStageResult {
  consolidationEngine?: import("../../daemon/daemon-cli.js").DaemonContext["consolidationEngine"];
}

export interface DeploymentStageResult {
  deploymentExecutor?: import("../../daemon/daemon-cli.js").DaemonContext["deploymentExecutor"];
  readinessChecker?: import("../../daemon/daemon-cli.js").DaemonContext["readinessChecker"];
  deployTrigger?: import("../../daemon/daemon-cli.js").DaemonContext["deployTrigger"];
}

export interface RuntimeIntelligenceStageResult {
  modelIntelligence?: import("../../agents/providers/model-intelligence.js").ModelIntelligenceService;
  providerRouter?: import("../../agent-core/routing/provider-router.js").ProviderRouter;
  consensusManager?: import("../../agent-core/routing/consensus-manager.js").ConsensusManager;
  confidenceEstimator?: import("../../agent-core/routing/confidence-estimator.js").ConfidenceEstimator;
}

export interface ToolChainStageResult {
  chainManager?: ChainManager;
}

export type DeploymentExecutorContract = NonNullable<DeploymentStageResult["deploymentExecutor"]>;
export type DeploymentReadinessCheckerContract = NonNullable<DeploymentStageResult["readinessChecker"]> & {
  validateScriptPath(scriptPath: string): void;
};
export type DeploymentTriggerContract = NonNullable<DeploymentStageResult["deployTrigger"]>;

export interface ProviderRuntimeStageDeps {
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

export interface KnowledgeStageDeps {
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

export interface OpsMonitoringStageDeps {
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

export interface RuntimeStateStageDeps {
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

export interface GoalContextStageDeps {
  createGoalStorage?: (dbPath: string) => GoalStorage;
  createGoalDecomposer?: (provider: IAIProvider, maxDepth: number) => GoalDecomposer;
  detectInterruptedTrees?: (storage: GoalStorage) => GoalTree[];
  buildCrashRecoveryContext?: (
    wasCrash: boolean,
    identityState: ReturnType<IdentityStateManager["getState"]>,
    interruptedGoalTrees: GoalTree[],
  ) => CrashRecoveryContext | null;
}

export interface ToolRegistryStageDeps {
  getDaemonStatus?: () =>
    | import("../../daemon/daemon-types.js").DaemonStatusSnapshot
    | undefined;
}

export interface SessionRuntimeStageDeps {
  createSoulLoader?: (
    basePath: string,
    options: ConstructorParameters<typeof SoulLoader>[1],
  ) => SoulLoader;
  isAgentDbAdapter?: (memoryManager: IMemoryManager) => memoryManager is AgentDBAdapter;
  createSessionSummarizer?: (
    provider: IAIProvider,
    executionStore: import("../../memory/unified/task-execution-store.js").TaskExecutionStore,
  ) => import("../../memory/unified/session-summarizer.js").SessionSummarizer;
  createDMPolicy?: (channel: IChannelAdapter) => DMPolicy;
}

export interface TaskRuntimeStageDeps {
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
    userProfileStore?: import("../../memory/unified/user-profile-store.js").UserProfileStore;
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
    defaultLanguage: Config["language"],
  ) => ProgressReporter;
}

export interface DaemonTriggerStageDeps {
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

export interface DaemonHeartbeatStageDeps extends DaemonTriggerStageDeps {
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

export interface MultiAgentDelegationStageDeps {
  createAgentRegistry?: (
    db: ReturnType<DaemonStorage["getDatabase"]>,
  ) => import("../../agents/multi/agent-registry.js").AgentRegistry;
  createAgentBudgetTracker?: (
    daemonStorage: DaemonStorage,
  ) => import("../../agents/multi/agent-budget-tracker.js").AgentBudgetTracker;
  createAgentManager?: (
    options: unknown,
  ) => import("../../agents/multi/agent-manager.js").AgentManager;
  createDelegationLog?: (
    db: ReturnType<DaemonStorage["getDatabase"]>,
  ) => import("../../agents/multi/delegation/delegation-log.js").DelegationLog;
  createTierRouter?: (
    tiers: Config["delegation"]["tiers"],
    db: ReturnType<DaemonStorage["getDatabase"]>,
  ) => import("../../agents/multi/delegation/tier-router.js").TierRouter;
  createDelegationManager?: (
    options: unknown,
  ) => import("../../agents/multi/delegation/delegation-manager.js").DelegationManager;
  createDelegationTools?: (
    delegationTypes: Config["delegation"]["types"],
    delegationManager: import("../../agents/multi/delegation/delegation-manager.js").DelegationManager,
    parentAgentId: string,
    depth: number,
    maxDepth: number,
  ) => ITool[];
  defaultDelegationTypes?: Config["delegation"]["types"];
}

export interface MemoryConsolidationStageDeps {
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

export interface DeploymentStageDeps {
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

export interface RuntimeIntelligenceStageDeps {
  createModelIntelligenceService?: (options: {
    refreshHours: number;
    providerSourcesPath: string;
  }) => import("../../agents/providers/model-intelligence.js").ModelIntelligenceService;
  createTrajectoryPhaseSignalRetriever?: (
    learningStorage: LearningStorage,
  ) => import("../../agent-core/routing/trajectory-phase-signal-retriever.js").TrajectoryPhaseSignalRetriever;
  createProviderRouter?: (
    providerManager: ProviderManager,
    preset: Config["routing"]["preset"],
    options: {
      modelIntelligence?: import("../../agents/providers/model-intelligence.js").ModelIntelligenceService;
      trajectoryPhaseSignalRetriever?: import("../../agent-core/routing/trajectory-phase-signal-retriever.js").TrajectoryPhaseSignalRetriever;
    },
  ) => import("../../agent-core/routing/provider-router.js").ProviderRouter;
  createConsensusManager?: (
    config: {
      mode: Config["consensus"]["mode"];
      threshold: number;
      maxProviders: number;
    },
  ) => import("../../agent-core/routing/consensus-manager.js").ConsensusManager;
  createConfidenceEstimator?: () => import("../../agent-core/routing/confidence-estimator.js").ConfidenceEstimator;
}

export interface ToolChainStageDeps {
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

export interface DashboardPostBootStageDeps {
  flattenConfig?: (config: Config) => Record<string, unknown>;
}
