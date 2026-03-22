/**
 * Application Bootstrap
 *
 * Handles initialization of all services and wires up dependencies.
 * Replaces the monolithic startBrain() function from index.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/config.js";
import { type DurationMs } from "../types/index.js";
import { createLogger } from "../utils/logger.js";
import { AuthManager } from "../security/auth.js";
import { configureAuthManager } from "../security/auth-hardened.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { MetricsCollector } from "../dashboard/metrics.js";
import { CachedEmbeddingProvider } from "../rag/embeddings/embedding-cache.js";
import { RAGPipeline } from "../rag/rag-pipeline.js";
import { FileVectorStore } from "../rag/vector-store.js";
import type { DIContainer } from "./di-container.js";
import { ToolRegistry } from "./tool-registry.js";
import { checkStradaDeps } from "../config/strada-deps.js";
import {
  LEARNING_DEFAULTS,
} from "../common/constants.js";
import {
  finalizeChannelStartupStage,
  initializeGoalContextStage,
  initializeDaemonHeartbeatStage,
  initializeDeploymentStage,
  initializeKnowledgeStage,
  initializeMemoryConsolidationStage,
  initializeMultiAgentDelegationStage,
  initializeOpsMonitoringStage,
  initializeProviderRuntimeStage,
  initializeRuntimeIntelligenceStage,
  initializeRuntimeStateStage,
  initializeSessionRuntimeStage,
  initializeTaskRuntimeStage,
  initializeToolChainStage,
  initializeToolRegistryStage,
  registerDashboardPostBootStage,
  type LearningResult,
  type RAGResult,
} from "./bootstrap-stages.js";
import type * as winston from "winston";

// Learning system imports
import {
  LearningStorage,
  LearningPipeline,
  ErrorLearningHooks,
  PatternMatcher,
  ConfidenceScorer,
} from "../learning/index.js";
import { TypedEventBus, type IEventBus, type LearningEventMap } from "./event-bus.js";
import { LearningQueue } from "../learning/pipeline/learning-queue.js";
import { ErrorRecoveryEngine } from "../agents/autonomy/error-recovery.js";
import { TaskPlanner } from "../agents/autonomy/task-planner.js";
import { buildCapabilityManifest } from "../agents/context/strada-knowledge.js";
import { MigrationRunner } from "../learning/storage/migrations/index.js";
import { migration001CrossSessionProvenance } from "../learning/storage/migrations/001-cross-session-provenance.js";
// Multi-agent type-only imports (Plan 23-03: AGENT-01, AGENT-06, AGENT-07)
import type { AgentManager as AgentManagerType } from "../agents/multi/agent-manager.js";
import type { AgentBudgetTracker as AgentBudgetTrackerType } from "../agents/multi/agent-budget-tracker.js";
// Delegation type-only imports (Plan 24-03: AGENT-03, AGENT-04, AGENT-05)
import type { DelegationManager as DelegationManagerType } from "../agents/multi/delegation/delegation-manager.js";

// Daemon imports
import { HeartbeatLoop } from "../daemon/heartbeat-loop.js";
import { NotificationRouter } from "../daemon/reporting/notification-router.js";
import { DigestReporter } from "../daemon/reporting/digest-reporter.js";

// Workspace / monitor bridge imports
import { createWorkspaceBus, type WorkspaceBus } from "../dashboard/workspace-bus.js";
import { createLearningWorkspaceBridge } from "../dashboard/learning-workspace-bridge.js";
import { createMonitorBridge } from "../dashboard/monitor-bridge.js";

// Auto-update imports
import { ChannelActivityRegistry } from "./channel-activity-registry.js";
import { AutoUpdater } from "./auto-updater.js";
import type { PostSetupBootstrap } from "../common/setup-contract.js";

// Task system imports
import { MessageRouter } from "../tasks/index.js";

import type { IChannelAdapter } from "../channels/channel.interface.js";

// Extracted helpers — imported and re-exported for backward compatibility
import {
  initializeAIProvider as _initializeAIProvider,
  resolveAndCacheEmbeddings as _resolveAndCacheEmbeddings,
  isTransientEmbeddingVerificationError as _isTransientEmbeddingVerificationError,
} from "./bootstrap-providers.js";
import {
  initializeMemory as _initializeMemory,
} from "./bootstrap-memory.js";
import {
  initializeChannel as _initializeChannel,
  initializeDashboard as _initializeDashboard,
  initializeRateLimiter as _initializeRateLimiter,
} from "./bootstrap-channels.js";
import {
  wireMessageHandler as _wireMessageHandler,
  setupCleanup as _setupCleanup,
  createShutdownHandler as _createShutdownHandler,
  generateSessionId as _generateSessionId,
} from "./bootstrap-wiring.js";

// Re-export for backward compatibility (tests and other modules import these from bootstrap.js)
export const initializeAIProvider = _initializeAIProvider;
export const resolveAndCacheEmbeddings = _resolveAndCacheEmbeddings;
export const isTransientEmbeddingVerificationError = _isTransientEmbeddingVerificationError;
export const initializeMemory = _initializeMemory;

// Local aliases for internal use
const initializeChannel = _initializeChannel;
const initializeDashboard = _initializeDashboard;
const initializeRateLimiter = _initializeRateLimiter;
const wireMessageHandler = _wireMessageHandler;
const setupCleanup = _setupCleanup;
const createShutdownHandler = _createShutdownHandler;
const generateSessionId = _generateSessionId;

export interface BootstrapOptions {
  channelType: string;
  config: Config;
  container?: DIContainer;
  daemonMode?: boolean;
  beforeChannelConnect?: (() => Promise<void> | void) | undefined;
  postSetupBootstrap?: PostSetupBootstrap | null;
}

export interface BootstrapResult {
  orchestrator: Orchestrator;
  messageRouter: MessageRouter;
  channel: IChannelAdapter;
  container: DIContainer;
  shutdown: () => Promise<void>;
  heartbeatLoop?: HeartbeatLoop;
  daemonContext?: import("../daemon/daemon-cli.js").DaemonContext;
  agentManager?: AgentManagerType;
  activityRegistry?: ChannelActivityRegistry;
  autoUpdater?: AutoUpdater;
  bootReport?: import("../common/capability-contract.js").BootReport;
  workspaceBus?: WorkspaceBus;
}

const POST_SETUP_BOOTSTRAP_DELAY_MS = 1200;

/**
 * Bootstrap the application with all services
 */
export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const { channelType, config, container: customContainer, beforeChannelConnect } = options;
  const container = customContainer!; // We ensure container exists below

  const logger = createLogger(config.logLevel, config.logFile);
  logger.info("Bootstrapping Strada Brain", {
    channel: channelType,
    projectPath: config.unityProjectPath,
    readOnly: config.security.readOnlyMode,
  });

  configureAuthManager(config.security.systemAuth);

  // Check Strada framework dependencies
  const stradaDeps = checkStradaDeps(config.unityProjectPath, config.strada);
  if (!stradaDeps.coreInstalled) {
    logger.warn("Strada.Core not found in project Packages/", {
      projectPath: config.unityProjectPath,
      searchedNames: ["strada.core", "com.strada.core", "Strada.Core"],
    });
  }
  for (const warning of stradaDeps.warnings) {
    logger.warn(warning);
  }

  // Log Strada.MCP status
  if (stradaDeps.mcpInstalled) {
    logger.info("Strada.MCP found", { path: stradaDeps.mcpPath, version: stradaDeps.mcpVersion });
  } else {
    logger.info("Strada.MCP not found (optional — install for MCP server capabilities)");
  }

  // Drift validation: compare Brain's API knowledge against Core source (fire-and-forget)
  if (stradaDeps.coreInstalled && stradaDeps.corePath) {
    const corePath = stradaDeps.corePath;
    void (async () => {
      try {
        const { StradaCoreExtractor } = await import("../intelligence/strada-core-extractor.js");
        const { validateDrift, formatDriftReport } =
          await import("../intelligence/strada-drift-validator.js");
        const extractor = new StradaCoreExtractor(corePath);
        const snapshot = await extractor.extract();
        const driftReport = validateDrift(snapshot);
        if (driftReport.errors.length > 0) {
          logger.warn("Strada.Core API drift detected", {
            errors: driftReport.errors.length,
            warnings: driftReport.warnings.length,
            driftScore: driftReport.driftScore,
          });
          logger.debug(formatDriftReport(driftReport));
        } else {
          logger.info("Strada.Core API drift check passed", {
            driftScore: driftReport.driftScore,
          });
        }
      } catch (driftError) {
        logger.debug("Drift validation skipped", {
          reason: driftError instanceof Error ? driftError.message : "unknown",
        });
      }
    })();
  }

  const {
    providerInit,
    memoryManager,
    channel,
    cachedEmbeddingProvider,
    embeddingStatus,
    startupNotices: runtimeStageNotices,
  } = await initializeProviderRuntimeStage(
    {
      channelType,
      config,
      logger,
    },
    {
      initializeAuth,
      resolveAndCacheEmbeddings: _resolveAndCacheEmbeddings,
      initializeAIProvider: _initializeAIProvider,
      initializeMemory: _initializeMemory,
      initializeChannel,
      isTransientEmbeddingVerificationError: _isTransientEmbeddingVerificationError,
    },
  );
  const providerManager = providerInit.manager;
  const activityRegistry = new ChannelActivityRegistry();

  const { ragPipeline, learningResult, startupNotices } = await initializeKnowledgeStage(
    {
      config,
      logger,
      cachedEmbeddingProvider,
      startupNotices: runtimeStageNotices,
    },
    {
      initializeRAG,
      initializeLearning,
    },
  );

  // Initialize tools (registry created here, initialized after metricsStorage below)
  const toolRegistry = new ToolRegistry(config.pluginDirs);

  const metrics = new MetricsCollector();
  const { dashboard, stoppableServers, rateLimiter, metricsStorage, metricsRecorder } =
    await initializeOpsMonitoringStage(
      {
        config,
        logger,
        metrics,
        memoryManager,
      },
      {
        initializeDashboard,
        initializeRateLimiter,
      },
    );
  const {
    identityManager,
    uptimeInterval,
    runtimeArtifactManager,
    instinctRetriever,
    trajectoryReplayRetriever,
  } = initializeRuntimeStateStage({
    config,
    logger,
    learningResult,
    metricsStorage,
    metricsRecorder,
  });

  // Initialize tool registry now that all deps are available
  // getDaemonStatus closure captures heartbeatLoop (declared below) via late binding
  let heartbeatLoop: HeartbeatLoop | undefined;
  let digestReporterInstance: DigestReporter | undefined;
  let notificationRouterInstance: NotificationRouter | undefined;
  let daemonContext: import("../daemon/daemon-cli.js").DaemonContext | undefined;
  let agentManager: AgentManagerType | undefined;
  let agentBudgetTrackerOuter: AgentBudgetTrackerType | undefined;
  let delegationManager: DelegationManagerType | undefined;
  await initializeToolRegistryStage(
    {
      toolRegistry,
      config,
      memoryManager,
      ragPipeline,
      metrics,
      learningStorage: learningResult.storage,
      metricsStorage,
      getIdentityState: identityManager ? () => identityManager!.getState() : undefined,
    },
    {
      getDaemonStatus: () => heartbeatLoop?.getDaemonStatus(),
    },
  );

  const { goalStorage, goalDecomposer, interruptedGoalTrees, crashContext, goalExecutorConfig } =
    initializeGoalContextStage({
      config,
      logger,
      provider: providerManager.getProvider(""),
      identityManager,
    });

  const { soulLoader, sessionSummarizer, userProfileStore, taskExecutionStore, dmPolicy } =
    await initializeSessionRuntimeStage({
      config,
      logger,
      memoryManager,
      providerManager,
      channel,
    });

  const { modelIntelligence, providerRouter, consensusManager, confidenceEstimator } =
    await initializeRuntimeIntelligenceStage({
      config,
      logger,
      providerManager,
      learningStorage: learningResult.storage,
    });

  // Initialize orchestrator
  const orchestrator = new Orchestrator({
    providerManager,
    tools: toolRegistry.getAllTools(),
    channel,
    projectPath: config.unityProjectPath,
    readOnly: config.security.readOnlyMode,
    requireConfirmation: config.security.requireEditConfirmation,
    memoryManager,
    metrics,
    ragPipeline,
    rateLimiter,
    streamingEnabled: config.streamingEnabled,
    defaultLanguage: config.language,
    streamInitialTimeoutMs: config.llmStreamInitialTimeoutMs,
    streamStallTimeoutMs: config.llmStreamStallTimeoutMs,
    stradaDeps,
    stradaConfig: config.strada,
    instinctRetriever,
    trajectoryReplayRetriever,
    eventEmitter: learningResult.eventBus,
    metricsRecorder,
    goalDecomposer,
    interruptedGoalTrees,
    getIdentityState: identityManager ? () => identityManager!.getState() : undefined,
    crashRecoveryContext: crashContext ?? undefined,
    reRetrievalConfig: config.reRetrieval,
    embeddingProvider: cachedEmbeddingProvider,
    soulLoader,
    dmPolicy,
    sessionSummarizer,
    userProfileStore,
    autonomousDefaultEnabled: config.autonomousDefaultEnabled,
    autonomousDefaultHours: config.autonomousDefaultHours,
    interactionConfig: config.interaction,
    taskConfig: config.tasks,
    taskExecutionStore,
    runtimeArtifactManager,
    toolMetadataByName: toolRegistry.getMetadataMap(),
    providerRouter,
    modelIntelligence,
    consensusManager,
    confidenceEstimator,
    interventionEngine: learningResult.interventionEngine,
  });

  const { chainManager } = await initializeToolChainStage({
    config,
    logger,
    learningStorage: learningResult.storage,
    learningEventBus: learningResult.eventBus as IEventBus<LearningEventMap> | undefined,
    learningQueue: learningResult.learningQueue,
    learningPipeline: learningResult.pipeline,
    toolRegistry,
    providerManager,
    orchestrator,
  });

  const {
    daemonEventBus,
    taskStorage,
    backgroundExecutor,
    taskManager,
    autoUpdater,
    projectScopeFingerprint,
    commandHandler,
    messageRouter,
  } = await initializeTaskRuntimeStage({
    daemonMode: Boolean(options.daemonMode),
    config,
    logger,
    orchestrator,
    providerManager,
    channel,
    dmPolicy,
    userProfileStore,
    soulLoader,
    runtimeArtifactManager,
    activityRegistry,
    goalDecomposer,
    goalStorage,
    goalExecutorConfig,
    learningEventBus: learningResult.eventBus,
    identityManager,
    providerRouter,
    startupNotices,
  });

  // Register services for deep readiness checks and agent metrics endpoint
  if (dashboard) {
    dashboard.registerServices({
      memoryManager,
      channel,
      metricsStorage,
      learningStorage: learningResult.storage,
      runtimeArtifactManager,
      projectScopeFingerprint,
      goalStorage,
      chainResilienceConfig: config.toolChain.resilience,
    });
  }
  // HeartbeatLoop wired to CommandHandler below after daemon init (late binding)

  // Initialize daemon heartbeat loop (if daemon mode enabled)
  if (options.daemonMode) {
    const daemonConfig = config.daemon;

    if (!daemonConfig.budget.dailyBudgetUsd) {
      const notice =
        "Daemon disabled: STRADA_DAEMON_DAILY_BUDGET is not set, so autonomous background execution is unavailable.";
      startupNotices.push(notice);
      logger.warn(notice);
    } else {
      // daemonEventBus is guaranteed defined when daemonMode is true
      const daemonBus = daemonEventBus!;
      const {
        daemonStorage,
        triggerRegistry,
        budgetTracker: budgetTrackerInstance,
        approvalQueue: approvalQueueInstance,
        heartbeatLoop: activeHeartbeatLoop,
        webhookTriggers,
      } = initializeDaemonHeartbeatStage({
        config,
        logger,
        toolRegistry,
        backgroundExecutor,
        taskManager,
        commandHandler,
        daemonEventBus: daemonBus,
        identityManager,
        crashContext,
      });
      heartbeatLoop = activeHeartbeatLoop;

      // Agent Core: autonomous OODA reasoning loop (Phase 4)
      try {
        const { AgentCore } = await import("../agent-core/agent-core.js");
        const { ObservationEngine } = await import("../agent-core/observation-engine.js");
        const { PriorityScorer } = await import("../agent-core/priority-scorer.js");
        const { TriggerObserver, UserActivityObserver, GitStateObserver } =
          await import("../agent-core/observers/index.js");

        const observationEngine = new ObservationEngine();

        // Register observers that wrap existing infrastructure
        observationEngine.register(new TriggerObserver(triggerRegistry));
        observationEngine.register(new UserActivityObserver(daemonConfig.heartbeat.intervalMs * 5));
        observationEngine.register(new GitStateObserver(config.unityProjectPath));
        // BuildStateObserver needs a SelfVerification reference — skip for now (wired per-task)

        observationEngine.start();

        const priorityScorer = new PriorityScorer(instinctRetriever);
        const agentCoreInstance = new AgentCore(
          observationEngine,
          priorityScorer,
          providerManager.getProvider(""),
          taskManager,
          channel,
          budgetTrackerInstance,
          instinctRetriever,
          undefined, // config — use defaults
          providerRouter,
          providerRouter ? providerManager : undefined,
        );

        heartbeatLoop.setAgentCore(agentCoreInstance);
        logger.info("Agent Core initialized", { observers: observationEngine.getObserverCount() });
      } catch (error) {
        logger.warn("Agent Core initialization failed (non-fatal)", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Create NotificationRouter (RPT-03, RPT-04)
      notificationRouterInstance = new NotificationRouter({
        config: config.notification,
        quietHoursConfig: config.quietHours,
        eventBus: daemonBus,
        storage: daemonStorage,
        channelSender: channel,
        chatId: undefined, // Will be set on first message
      });
      notificationRouterInstance.start();

      // Create DigestReporter (RPT-01)
      digestReporterInstance = new DigestReporter({
        config: config.digest,
        daemonConfig: { timezone: daemonConfig.timezone },
        storage: daemonStorage,
        channelSender: channel,
        chatId: undefined, // Will be set on first message
        channelType,
        eventBus: daemonBus,
        metricsStorage,
        learningStorage: learningResult.storage,
        budgetTracker: budgetTrackerInstance,
        dashboardPort: config.dashboard.port,
        logger,
      });
      digestReporterInstance.start();

      // Build daemon context for CLI commands (Plan 05 + Plan 18-02 reporting + Plan 21-03 decay stats + Plan 22-04 chain resilience)
      daemonContext = {
        heartbeatLoop,
        registry: triggerRegistry,
        budgetTracker: budgetTrackerInstance,
        approvalQueue: approvalQueueInstance,
        storage: daemonStorage,
        config: daemonConfig,
        digestReporter: digestReporterInstance,
        notificationRouter: notificationRouterInstance,
        memoryManager,
        learningStorage: learningResult.storage,
        chainResilienceConfig: config.toolChain.resilience,
      };

      const multiAgentStage = await initializeMultiAgentDelegationStage({
        config,
        logger,
        daemonMode: Boolean(options.daemonMode),
        daemonStorage,
        daemonContext: daemonContext!,
        taskManager,
        orchestrator,
        learningEventBus: learningResult.eventBus,
        providerManager,
        toolRegistry,
        channel,
        metrics,
        ragPipeline,
        rateLimiter,
        instinctRetriever,
        metricsRecorder,
        goalDecomposer,
        identityManager,
        cachedEmbeddingProvider,
        soulLoader,
        dmPolicy,
        userProfileStore,
        providerRouter,
        dashboard,
        stradaDeps,
      });
      agentManager = multiAgentStage.agentManager;
      agentBudgetTrackerOuter = multiAgentStage.agentBudgetTracker;
      delegationManager = multiAgentStage.delegationManager;

      await initializeMemoryConsolidationStage({
        config,
        logger,
        memoryManager,
        cachedEmbeddingProvider,
        providerManager,
        learningEventBus: learningResult.eventBus,
        heartbeatLoop,
        daemonContext: daemonContext!,
      });

      await initializeDeploymentStage({
        config,
        logger,
        daemonConfig,
        daemonStorage,
        approvalQueue: approvalQueueInstance,
        triggerRegistry,
        heartbeatLoop,
        daemonEventBus: daemonEventBus!,
        taskManager,
        daemonContext: daemonContext!,
      });

      // Wire daemon context into dashboard (Plan 05 + Plan 18-03 enrichment)
      if (dashboard) {
        dashboard.setDaemonContext({
          heartbeatLoop,
          registry: triggerRegistry,
          approvalQueue: approvalQueueInstance,
          webhookTriggers,
          webhookSecret: daemonConfig.triggers.webhookSecret,
          webhookRateLimit: daemonConfig.triggers.webhookRateLimit,
          dashboardToken: config.websocketDashboard.authToken,
          identityManager,
          capabilityManifest: buildCapabilityManifest(),
          startupNotices: [...new Set(startupNotices)],
          daemonStorage,
          historyDepth: 10,
          triggerFireRetentionDays: daemonConfig.triggerFireRetentionDays,
          autoUpdater,
        });
      }
    }
  }

  // Wire up message handler
  if (agentManager) {
    // Give AgentManager the command handler so prefix commands bypass LLM
    agentManager.setCommandHandler(commandHandler);

    // Multi-agent mode: route through AgentManager (AGENT-06)
    channel.onMessage(async (msg) => {
      activityRegistry.recordActivity(channelType, msg.chatId);
      // Interrupt consolidation on user activity (MEM-13)
      heartbeatLoop?.onUserActivity();
      if (identityManager) {
        identityManager.recordActivity();
        identityManager.incrementMessages();
        identityManager.incrementTasks();
      }
      let taskRunId: string | undefined;
      if (learningResult.taskPlanner) {
        learningResult.taskPlanner.startTask({
          sessionId: msg.chatId ?? generateSessionId(),
          chatId: msg.chatId,
          taskDescription: msg.text.slice(0, 200),
          learningPipeline: learningResult.pipeline,
        });
        taskRunId = learningResult.taskPlanner.getTaskRunId() ?? undefined;
      }

      let routeError: unknown;
      await orchestrator.withTaskExecutionContext(
        {
          chatId: msg.chatId,
          conversationId: msg.conversationId,
          userId: msg.userId,
          taskRunId,
        },
        async () => {
          try {
            await agentManager!.routeMessage(msg);
          } catch (error) {
            routeError = error;
            throw error;
          } finally {
            if (learningResult.taskPlanner?.isActive()) {
              learningResult.taskPlanner.attachReplayContext(
                await orchestrator.buildTrajectoryReplayContext({
                  chatId: msg.chatId,
                  userId: msg.userId,
                  conversationId: msg.conversationId,
                  channelType: msg.channelType,
                  sinceTimestamp: learningResult.taskPlanner.getTaskStartedAt() ?? undefined,
                  taskRunId,
                }),
              );
              learningResult.taskPlanner.endTask({
                success: routeError === undefined,
                finalOutput: routeError instanceof Error ? routeError.message : undefined,
                hadErrors: routeError !== undefined,
                errorCount: routeError === undefined ? 0 : 1,
              });
            }
          }
        },
      );
    });
  } else {
    // v2.0 single-agent mode: unchanged path (AGENT-07)
    wireMessageHandler(
      channel,
      messageRouter,
      orchestrator,
      learningResult.taskPlanner,
      learningResult.pipeline,
      identityManager,
      heartbeatLoop,
      activityRegistry,
      channelType,
    );
  }

  // Wire feedback reactions from channel adapters to the learning event bus
  if (learningResult.eventBus) {
    const feedbackBus = learningResult.eventBus;
    const feedbackCallback = (
      type: "thumbs_up" | "thumbs_down",
      instinctIds: string[],
      userId?: string,
      source?: "reaction" | "button",
    ) => {
      feedbackBus.emit("feedback:reaction", {
        type,
        instinctIds,
        userId,
        source: source ?? "reaction",
        channel: channelType,
        timestamp: Date.now(),
      });
    };
    if ("setFeedbackHandler" in channel && typeof channel.setFeedbackHandler === "function") {
      (channel as { setFeedbackHandler: (cb: typeof feedbackCallback) => void }).setFeedbackHandler(feedbackCallback);
    }
  }

  const postSetupBootstrap = options.postSetupBootstrap;
  if (postSetupBootstrap && channel.setPostSetupBootstrapHandler) {
    channel.setPostSetupBootstrapHandler(async (context) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, POST_SETUP_BOOTSTRAP_DELAY_MS);
      });

      await orchestrator.deliverPostSetupBootstrap(context, postSetupBootstrap);

      if (postSetupBootstrap.autonomy?.enabled) {
        const expiresAt =
          typeof postSetupBootstrap.autonomy.hours === "number"
            ? Date.now() + postSetupBootstrap.autonomy.hours * 3600_000
            : undefined;
        heartbeatLoop?.getSecurityPolicy().setAutonomousOverride(true, expiresAt);
      }
    });
  } else {
    channel.setPostSetupBootstrapHandler?.(null);
  }

  // Setup cleanup
  const cleanupInterval = setupCleanup(orchestrator);

  const bootReport = await finalizeChannelStartupStage({
    beforeChannelConnect,
    channel,
    logger,
    config,
    channelType,
    daemonMode: Boolean(options.daemonMode),
    providerHealthy: providerInit.healthCheckPassed,
    embeddingStatus,
    deploymentWired: Boolean(daemonContext?.deploymentExecutor),
    alertingWired: false,
    backupWired: false,
    stradaMcpRuntime: toolRegistry.getStradaMcpRuntimeStatus(),
    startupNotices,
    moduleUrl: import.meta.url,
  });

  // Wire identity manager to dashboard even without daemon mode
  if (dashboard && identityManager && !dashboard["identityManager"]) {
    dashboard.setDaemonContext({
      identityManager,
      dashboardToken: config.websocketDashboard.authToken,
      startupNotices: [...new Set(startupNotices)],
      autoUpdater,
    });
  }

  registerDashboardPostBootStage({
    dashboard,
    agentManager,
    agentBudgetTracker: agentBudgetTrackerOuter,
    daemonContext,
    toolRegistry,
    orchestrator,
    soulLoader,
    config,
    providerManager,
    userProfileStore,
    embeddingStatus,
    stradaDeps,
    bootReport,
    providerRouter,
  });

  // Workspace bus: bridge learning/daemon events into the monitor UI
  const workspaceBus = createWorkspaceBus();

  // Wire learning + daemon events into workspace bus (both buses are optional)
  if (learningResult.eventBus && daemonEventBus) {
    const lwBridge = createLearningWorkspaceBridge(
      learningResult.eventBus,
      daemonEventBus,
      workspaceBus,
    );
    lwBridge.start();
  }

  // Monitor bridge: fan-out workspace events to all connected WS clients
  if ("broadcastRaw" in channel && typeof (channel as any).broadcastRaw === "function") {
    const monitorBridge = createMonitorBridge(
      workspaceBus,
      (msg: string) => (channel as any).broadcastRaw(msg),
    );
    monitorBridge.start();
  }

  // Wire workspace bus into dashboard for monitor REST endpoints (Phase 3)
  if (dashboard) {
    dashboard.setWorkspaceBus(workspaceBus);
  }

  // Wire incoming workspace commands from the frontend into the workspace bus
  if ("setWorkspaceBusEmitter" in channel && typeof (channel as any).setWorkspaceBusEmitter === "function") {
    (channel as any).setWorkspaceBusEmitter((event: string, payload: unknown) => {
      workspaceBus.emit(event, payload as any);
    });
  }

  // Return result with shutdown function
  return {
    orchestrator,
    messageRouter,
    channel,
    container,
    heartbeatLoop,
    daemonContext,
    agentManager,
    activityRegistry,
    autoUpdater,
    bootReport,
    workspaceBus,
    shutdown: createShutdownHandler({
      dashboard,
      ragPipeline,
      memoryManager,
      channel,
      cleanupInterval,
      learningPipeline: learningResult.pipeline,
      taskStorage,
      providerManager,
      eventBus: learningResult.eventBus,
      learningQueue: learningResult.learningQueue,
      metricsStorage,
      goalStorage,
      chainManager,
      toolRegistry,
      identityManager,
      modelIntelligence,
      uptimeInterval,
      heartbeatLoop,
      digestReporter: digestReporterInstance,
      notificationRouter: notificationRouterInstance,
      agentManager,
      delegationManager,
      stoppableServers,
      soulLoader,
      autoUpdater,
    }),
  };
}

// ============================================================================
// Private Helpers (kept in bootstrap.ts — used only by bootstrap())
// ============================================================================

function initializeAuth(config: Config, channelType: string, logger: winston.Logger): AuthManager {
  const allowedTelegramIds = config.telegram.allowedUserIds ?? [];
  if (channelType === "telegram" && allowedTelegramIds.length === 0) {
    logger.warn("ALLOWED_TELEGRAM_USER_IDS is empty — all Telegram users will be denied access");
  }

  const allowedDiscordIds = new Set(config.discord.allowedUserIds);
  const allowedDiscordRoles = new Set(config.discord.allowedRoleIds);

  if (channelType === "discord" && allowedDiscordIds.size === 0 && allowedDiscordRoles.size === 0) {
    logger.warn(
      "ALLOWED_DISCORD_USER_IDS and ALLOWED_DISCORD_ROLE_IDS are empty — all Discord users will be denied access",
    );
  }

  return new AuthManager(allowedTelegramIds, {
    allowedDiscordIds,
    allowedDiscordRoles,
  });
}

async function initializeRAG(
  config: Config,
  logger: winston.Logger,
  cachedProvider?: CachedEmbeddingProvider,
): Promise<RAGResult> {
  if (!config.rag.enabled) {
    logger.info("RAG: disabled by configuration");
    return {};
  }

  if (!cachedProvider) {
    // No provider was resolved upstream — RAG cannot function
    const notice =
      "RAG disabled: no embedding provider available. Semantic code search is unavailable.";
    logger.warn("RAG: disabled — no embedding provider available");
    return { notice };
  }

  try {
    const vectorStorePath = join(config.memory.dbPath, "vectors");
    const vectorStore = new FileVectorStore(vectorStorePath, cachedProvider.dimensions);

    // Dimension mismatch detection: check existing data before initializing
    const chunksPath = join(vectorStorePath, "chunks.json");
    const vectorsPath = join(vectorStorePath, "vectors.bin");
    if (existsSync(chunksPath) && existsSync(vectorsPath)) {
      try {
        const vectorsBuf = readFileSync(vectorsPath);
        const chunksRaw = readFileSync(chunksPath, "utf8");
        const chunks = JSON.parse(chunksRaw) as unknown[];
        if (chunks.length > 0 && vectorsBuf.byteLength > 0) {
          const storedDims = vectorsBuf.byteLength / 4 / chunks.length;
          if (storedDims !== cachedProvider.dimensions) {
            logger.warn(
              `RAG: dimension mismatch (stored: ${storedDims}, provider: ${cachedProvider.dimensions}). Clearing vector index for re-indexing.`,
            );
            // Remove the files so FileVectorStore starts empty
            const { unlinkSync } = await import("node:fs");
            unlinkSync(chunksPath);
            unlinkSync(vectorsPath);
          }
        }
      } catch {
        // If we can't read existing data, FileVectorStore will handle it
      }
    }

    // HNSW configuration from environment or defaults
    const hnswConfig = {
      M: parseInt(process.env["HNSW_M"] ?? "16", 10),
      efConstruction: parseInt(process.env["HNSW_EF_CONSTRUCTION"] ?? "200", 10),
      efSearch: parseInt(process.env["HNSW_EF_SEARCH"] ?? "128", 10),
      maxElements: parseInt(process.env["HNSW_MAX_ELEMENTS"] ?? "100000", 10),
    };

    // Check if HNSW is disabled via environment
    const useHNSW = process.env["HNSW_DISABLED"] !== "true";

    const pipeline = new RAGPipeline(cachedProvider, vectorStore, {
      useHNSW,
      hnswConfig,
    });
    await pipeline.initialize();

    logger.info("RAG pipeline initialized", {
      provider: cachedProvider.name,
      dimensions: cachedProvider.dimensions,
      hnsw: pipeline.isUsingHNSW(),
    });

    // Background indexing
    pipeline
      .indexProject(config.unityProjectPath)
      .then((stats) => logger.info("Initial RAG indexing complete", stats))
      .catch((err) =>
        logger.warn("Initial RAG indexing failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

    return { pipeline, cachedProvider };
  } catch (error) {
    const notice =
      "RAG disabled: embedding initialization failed. Semantic code search is unavailable.";
    logger.warn("RAG initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { notice };
  }
}

async function initializeLearning(
  config: Config,
  logger: winston.Logger,
  embeddingProvider?: CachedEmbeddingProvider,
): Promise<LearningResult> {
  const notices: string[] = [];
  try {
    const learningDbPath = join(config.memory.dbPath, "learning.db");
    const learningStorage = new LearningStorage(learningDbPath);
    learningStorage.initialize();

    // Run cross-session migrations (Phase 13) with graceful degradation
    const db = learningStorage.getDatabase();
    if (db) {
      try {
        const runner = new MigrationRunner(db, learningDbPath);
        const migrationResult = runner.run([migration001CrossSessionProvenance]);
        if (migrationResult.applied.length > 0) {
          logger.info("Learning DB migrations applied", { applied: migrationResult.applied });
        }
      } catch (error) {
        logger.warn("Learning DB migration failed, cross-session features degraded", {
          error: error instanceof Error ? error.message : String(error),
        });
        // Graceful degradation: continue without cross-session features
      }
    }

    // Create event bus for decoupled learning (created before pipeline so it can be injected)
    const eventBus = new TypedEventBus<LearningEventMap>();
    const learningQueue = new LearningQueue();

    if (!embeddingProvider) {
      const notice = "Instinct embeddings disabled: learning continues with lexical matching only.";
      notices.push(notice);
      logger.warn(
        "Learning initialized without embedding provider; semantic instinct features disabled",
      );
    }

    const pipeline = new LearningPipeline(
      learningStorage,
      {
        dbPath: learningDbPath,
        enabled: LEARNING_DEFAULTS.enabled,
        batchSize: LEARNING_DEFAULTS.batchSize,
        detectionIntervalMs: LEARNING_DEFAULTS.detectionIntervalMs as DurationMs,
        evolutionIntervalMs: LEARNING_DEFAULTS.evolutionIntervalMs as DurationMs,
        minConfidenceForCreation: LEARNING_DEFAULTS.minConfidenceForCreation,
        maxInstincts: LEARNING_DEFAULTS.maxInstincts,
      },
      embeddingProvider,
      config.bayesian,
      eventBus,
    );

    pipeline.start();

    const { InterventionEngine } = await import("../learning/intervention/intervention-engine.js");
    const interventionEngine = new InterventionEngine(learningStorage);

    const patternMatcher = new PatternMatcher(learningStorage, { eventBus });
    const confidenceScorer = new ConfidenceScorer();
    const errorLearningHooks = new ErrorLearningHooks(
      pipeline,
      patternMatcher,
      confidenceScorer,
      learningStorage,
    );

    const errorRecovery = new ErrorRecoveryEngine();
    errorRecovery.enableLearning(errorLearningHooks, {
      enableLearning: true,
      sessionId: "default",
    });

    const taskPlanner = new TaskPlanner();
    taskPlanner.enableLearning(pipeline);

    // Subscribe learning pipeline to tool result events via serial queue
    eventBus.on("tool:result", (event) => {
      learningQueue.enqueue(async () => {
        await pipeline.handleToolResult(event);
      });
    });

    logger.info("Learning pipeline initialized", {
      dbPath: learningDbPath,
      stats: pipeline.getStats(),
    });

    return {
      pipeline,
      storage: learningStorage,
      patternMatcher,
      taskPlanner,
      errorRecovery,
      eventBus,
      learningQueue,
      interventionEngine,
      notices,
    };
  } catch (error) {
    const notice =
      "Learning pipeline disabled: startup initialization failed. Core chat remains available.";
    notices.push(notice);
    logger.warn("Learning pipeline initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      taskPlanner: new TaskPlanner(),
      errorRecovery: new ErrorRecoveryEngine(),
      notices,
    };
  }
}
