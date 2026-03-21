/**
 * Application Bootstrap
 *
 * Handles initialization of all services and wires up dependencies.
 * Replaces the monolithic startBrain() function from index.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Config } from "../config/config.js";
import { type DurationMs } from "../types/index.js";
import { createLogger, getLogger } from "../utils/logger.js";
import { AuthManager } from "../security/auth.js";
import { configureAuthManager } from "../security/auth-hardened.js";
import { ClaudeProvider } from "../agents/providers/claude.js";
import { buildProviderChain } from "../agents/providers/provider-registry.js";
import { ProviderManager } from "../agents/providers/provider-manager.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { MetricsCollector } from "../dashboard/metrics.js";
import { DashboardServer } from "../dashboard/server.js";
import { FileMemoryManager } from "../memory/file-memory-manager.js";
import { AgentDBMemory } from "../memory/unified/agentdb-memory.js";
import { AgentDBAdapter } from "../memory/unified/agentdb-adapter.js";
import { runAutomaticMigration } from "../memory/unified/migration.js";
import { RAGPipeline } from "../rag/rag-pipeline.js";
import { FileVectorStore } from "../rag/vector-store.js";
import { CachedEmbeddingProvider } from "../rag/embeddings/embedding-cache.js";
import {
  resolveEmbeddingProvider,
  collectApiKeys,
  describeEmbeddingResolutionFailure,
} from "../rag/embeddings/embedding-resolver.js";
import { RateLimiter } from "../security/rate-limiter.js";
import type { DIContainer } from "./di-container.js";
import { ToolRegistry } from "./tool-registry.js";
import {
  collectProviderCredentials,
  hasConfiguredOpenAISubscription,
  hasUsableProviderConfig,
  normalizeProviderNames,
} from "./provider-config.js";
import {
  formatProviderPreflightFailures,
  preflightResponseProviders,
} from "./response-provider-preflight.js";
import { AppError } from "../common/errors.js";
import { checkStradaDeps } from "../config/strada-deps.js";
import {
  SESSION_CLEANUP_INTERVAL_MS,
  DEFAULT_RATE_LIMITS,
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
  type EmbeddingResolutionResult,
  type LearningResult,
  type ProviderInitResult,
  type RAGResult,
} from "./bootstrap-stages.js";
import type * as winston from "winston";

// Channel imports
import { TelegramChannel } from "../channels/telegram/bot.js";
import { CLIChannel } from "../channels/cli/repl.js";
import { DiscordChannel } from "../channels/discord/bot.js";
import { getDefaultSlashCommands } from "../channels/discord/commands.js";
import { WhatsAppChannel } from "../channels/whatsapp/client.js";
import { WebChannel } from "../channels/web/channel.js";

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
import { MetricsStorage } from "../metrics/metrics-storage.js";
import type { GoalStorage } from "../goals/index.js";
import { ChainManager } from "../learning/chains/index.js";
import type { IdentityStateManager } from "../identity/identity-state.js";
import { buildCapabilityManifest } from "../agents/context/strada-knowledge.js";
import { MigrationRunner } from "../learning/storage/migrations/index.js";
import { migration001CrossSessionProvenance } from "../learning/storage/migrations/001-cross-session-provenance.js";
import { SoulLoader } from "../agents/soul/index.js";

// Multi-agent type-only imports (Plan 23-03: AGENT-01, AGENT-06, AGENT-07)
import type { AgentManager as AgentManagerType } from "../agents/multi/agent-manager.js";
import type { AgentBudgetTracker as AgentBudgetTrackerType } from "../agents/multi/agent-budget-tracker.js";
// Delegation type-only imports (Plan 24-03: AGENT-03, AGENT-04, AGENT-05)
import type { DelegationManager as DelegationManagerType } from "../agents/multi/delegation/delegation-manager.js";

// Daemon imports
import { HeartbeatLoop } from "../daemon/heartbeat-loop.js";
import { NotificationRouter } from "../daemon/reporting/notification-router.js";
import { DigestReporter } from "../daemon/reporting/digest-reporter.js";

// Auto-update imports
import { ChannelActivityRegistry } from "./channel-activity-registry.js";
import { AutoUpdater } from "./auto-updater.js";
import type { PostSetupBootstrap } from "../common/setup-contract.js";

// Task system imports
import {
  TaskStorage,
  MessageRouter,
} from "../tasks/index.js";

import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type { IAIProvider } from "../agents/providers/provider.interface.js";
import type { IRAGPipeline } from "../rag/rag.interface.js";

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
        const { validateDrift, formatDriftReport } = await import("../intelligence/strada-drift-validator.js");
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
  } = await initializeProviderRuntimeStage({
    channelType,
    config,
    logger,
  }, {
    initializeAuth,
    resolveAndCacheEmbeddings,
    initializeAIProvider,
    initializeMemory,
    initializeChannel,
    isTransientEmbeddingVerificationError,
  });
  const providerManager = providerInit.manager;
  const activityRegistry = new ChannelActivityRegistry();

  const {
    ragPipeline,
    learningResult,
    startupNotices,
  } = await initializeKnowledgeStage({
    config,
    logger,
    cachedEmbeddingProvider,
    startupNotices: runtimeStageNotices,
  }, {
    initializeRAG,
    initializeLearning,
  });

  // Initialize tools (registry created here, initialized after metricsStorage below)
  const toolRegistry = new ToolRegistry(config.pluginDirs);

  const metrics = new MetricsCollector();
  const {
    dashboard,
    stoppableServers,
    rateLimiter,
    metricsStorage,
    metricsRecorder,
  } = await initializeOpsMonitoringStage({
    config,
    logger,
    metrics,
    memoryManager,
  }, {
    initializeDashboard,
    initializeRateLimiter,
  });
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
  await initializeToolRegistryStage({
    toolRegistry,
    config,
    memoryManager,
    ragPipeline,
    metrics,
    learningStorage: learningResult.storage,
    metricsStorage,
    getIdentityState: identityManager
      ? () => identityManager!.getState()
      : undefined,
  }, {
    getDaemonStatus: () => heartbeatLoop?.getDaemonStatus(),
  });

  const {
    goalStorage,
    goalDecomposer,
    interruptedGoalTrees,
    crashContext,
    goalExecutorConfig,
  } = initializeGoalContextStage({
    config,
    logger,
    provider: providerManager.getProvider(""),
    identityManager,
  });

  const {
    soulLoader,
    sessionSummarizer,
    userProfileStore,
    taskExecutionStore,
    dmPolicy,
  } = await initializeSessionRuntimeStage({
    config,
    logger,
    memoryManager,
    providerManager,
    channel,
  });

  const {
    modelIntelligence,
    providerRouter,
    consensusManager,
    confidenceEstimator,
  } = await initializeRuntimeIntelligenceStage({
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
    taskExecutionStore,
    runtimeArtifactManager,
    toolMetadataByName: toolRegistry.getMetadataMap(),
    providerRouter,
    modelIntelligence,
    consensusManager,
    confidenceEstimator,
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
        const { TriggerObserver, UserActivityObserver, GitStateObserver } = await import("../agent-core/observers/index.js");

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
      await orchestrator.withTaskExecutionContext({
        chatId: msg.chatId,
        conversationId: msg.conversationId,
        userId: msg.userId,
        taskRunId,
      }, async () => {
        try {
          await agentManager!.routeMessage(msg);
        } catch (error) {
          routeError = error;
          throw error;
        } finally {
          if (learningResult.taskPlanner?.isActive()) {
            learningResult.taskPlanner.attachReplayContext(await orchestrator.buildTrajectoryReplayContext({
              chatId: msg.chatId,
              userId: msg.userId,
              conversationId: msg.conversationId,
              sinceTimestamp: learningResult.taskPlanner.getTaskStartedAt() ?? undefined,
              taskRunId,
            }));
            learningResult.taskPlanner.endTask({
              success: routeError === undefined,
              finalOutput: routeError instanceof Error ? routeError.message : undefined,
              hadErrors: routeError !== undefined,
              errorCount: routeError === undefined ? 0 : 1,
            });
          }
        }
      });
    });
  } else {
    // v2.0 single-agent mode: unchanged path (AGENT-07)
    wireMessageHandler(channel, messageRouter, orchestrator, learningResult.taskPlanner, learningResult.pipeline, identityManager, heartbeatLoop, activityRegistry, channelType);
  }

  const postSetupBootstrap = options.postSetupBootstrap;
  if (postSetupBootstrap && channel.setPostSetupBootstrapHandler) {
    channel.setPostSetupBootstrapHandler(async (context) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, POST_SETUP_BOOTSTRAP_DELAY_MS);
      });

      await orchestrator.deliverPostSetupBootstrap(context, postSetupBootstrap);

      if (postSetupBootstrap.autonomy?.enabled) {
        const expiresAt = typeof postSetupBootstrap.autonomy.hours === "number"
          ? Date.now() + (postSetupBootstrap.autonomy.hours * 3600_000)
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
    startupNotices,
    moduleUrl: import.meta.url,
  });

  // Wire identity manager to dashboard even without daemon mode
  if (dashboard && identityManager && !dashboard["identityManager"]) {
    dashboard.setDaemonContext({
      identityManager,
      dashboardToken: config.websocketDashboard.authToken,
      startupNotices: [...new Set(startupNotices)],
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
// Private Helpers
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

export async function initializeAIProvider(
  config: Config,
  logger: winston.Logger,
): Promise<ProviderInitResult> {
  const apiKeys = collectApiKeys(config);
  const providerCredentials = collectProviderCredentials(config);
  const notices: string[] = [];
  let healthCheckPassed: boolean | undefined;

  let defaultProvider: IAIProvider;
  let defaultProviderOrder: string[] = [];

  // 1) Explicit provider chain
  if (config.providerChain) {
    const requestedNames = normalizeProviderNames(config.providerChain);
    const configuredNames = requestedNames.filter((name) =>
      name === "openai" && hasConfiguredOpenAISubscription(config)
        ? true
        : hasUsableProviderConfig(name, apiKeys),
    );
    const unavailableNames = requestedNames.filter((name) => !configuredNames.includes(name));

    if (unavailableNames.length > 0) {
      throw new AppError(
        `Configured AI providers are missing usable credentials: ${unavailableNames.join(", ")}.`,
        "NO_AI_PROVIDER",
      );
    }

    const preflightResult = await preflightResponseProviders(
      configuredNames,
      providerCredentials,
      config.providerModels,
    );
    if (preflightResult.failures.length > 0) {
      throw new AppError(
        `Configured AI providers failed preflight. ${formatProviderPreflightFailures(preflightResult.failures)}`,
        "NO_HEALTHY_AI_PROVIDER",
      );
    }

    defaultProviderOrder = preflightResult.passedProviderIds;
    defaultProvider = buildProviderChain(preflightResult.passedProviderIds, providerCredentials, {
      models: config.providerModels,
    });
    logger.info("AI provider chain initialized", { chain: preflightResult.passedProviderIds });
  }
  // 2) Anthropic key present — use ClaudeProvider directly
  else if (config.anthropicApiKey) {
    defaultProviderOrder = ["claude"];
    defaultProvider = new ClaudeProvider(config.anthropicApiKey);
    logger.info("AI provider initialized", { name: defaultProvider.name });
  }
  // 3) No explicit chain and no Anthropic key — auto-detect from available keys
  else {
    const detectedNames = Object.entries(apiKeys)
      .filter(([name, key]) => name !== "claude" && name !== "anthropic" && key)
      .map(([name]) => name);
    if (hasConfiguredOpenAISubscription(config) && !detectedNames.includes("openai")) {
      detectedNames.unshift("openai");
    }

    if (detectedNames.length === 0) {
      throw new AppError(
        "No AI provider configured. Please set at least one provider API key.",
        "NO_AI_PROVIDER",
      );
    }

    const preflightResult = await preflightResponseProviders(
      detectedNames,
      providerCredentials,
      config.providerModels,
    );
    if (preflightResult.failures.length > 0) {
      const notice =
        `Configured AI providers failed preflight and were skipped: ${formatProviderPreflightFailures(preflightResult.failures)}`;
      notices.push(notice);
      logger.warn("Configured AI providers failed preflight", {
        failedProviders: preflightResult.failures,
      });
    }
    if (preflightResult.passedProviderIds.length === 0) {
      throw new AppError(
        `No AI provider passed preflight. ${formatProviderPreflightFailures(preflightResult.failures)}`,
        "NO_HEALTHY_AI_PROVIDER",
      );
    }

    defaultProviderOrder = preflightResult.passedProviderIds;
    defaultProvider = buildProviderChain(preflightResult.passedProviderIds, providerCredentials, {
      models: config.providerModels,
    });
    logger.info("AI provider auto-detected from available keys", {
      chain: preflightResult.passedProviderIds,
    });
  }

  // Run health check (non-blocking — warn only)
  if (defaultProvider.healthCheck) {
    healthCheckPassed = await defaultProvider.healthCheck();
    const logMethod = healthCheckPassed ? "info" : "warn";
    const message = healthCheckPassed
      ? "AI provider health check passed"
      : "AI provider health check failed — API may be unreachable or key invalid";
    logger[logMethod](message, { name: defaultProvider.name });
  }

  const providerManager = new ProviderManager(
    defaultProvider,
    providerCredentials,
    config.providerModels,
    config.memory.dbPath,
    defaultProviderOrder,
  );

  // Verify Ollama reachability before marking it available for routing
  const ollamaBaseUrl = process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
  try {
    const ollamaRes = await fetch(`${ollamaBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (ollamaRes.ok) {
      providerManager.setOllamaVerified(true);
      logger.info("Ollama verified as reachable");
    }
  } catch {
    logger.debug("Ollama not reachable, excluding from routing");
  }

  logger.info("ProviderManager initialized with per-chat switching support");

  return {
    manager: providerManager,
    notices,
    healthCheckPassed,
  };
}

/**
 * Initialize memory backend with self-healing.
 *
 * Flow:
 *   1. If memory disabled -> undefined
 *   2. If backend == "file" -> FileMemoryManager directly
 *   3. Otherwise (agentdb, default):
 *      try AgentDB -> on fail: repair schema -> retry -> on fail: fallback to FileMemoryManager
 *
 * Exported for testing.
 */
export async function initializeMemory(
  config: Config,
  logger: winston.Logger,
  embeddingProvider?: CachedEmbeddingProvider,
): Promise<IMemoryManager | undefined> {
  if (!config.memory.enabled) {
    return undefined;
  }

  // Explicit file backend — skip AgentDB entirely
  if (config.memory.backend === "file") {
    return initializeFileMemory(config, logger);
  }

  // AgentDB backend (default)
  const agentdbPath = join(config.memory.dbPath, "agentdb");
  const agentdbConfig = {
    dbPath: agentdbPath,
    dimensions: embeddingProvider?.dimensions ?? config.memory.unified.dimensions,
    maxEntriesPerTier: {
      working: config.memory.unified.tierLimits.working,
      ephemeral: config.memory.unified.tierLimits.ephemeral,
      persistent: config.memory.unified.tierLimits.persistent,
    },
    enableAutoTiering: config.memory.unified.autoTiering,
    ephemeralTtlMs: (config.memory.unified.ephemeralTtlHours * 3600000) as DurationMs,
    embeddingProvider: embeddingProvider
      ? async (text: string) => {
          const batch = await embeddingProvider.embed([text]);
          return batch.embeddings[0]!;
        }
      : undefined,
  };

  // Post-init steps shared between first attempt and repair path
  async function finalizeAgentDB(agentdb: AgentDBMemory): Promise<AgentDBAdapter> {
    if (!embeddingProvider) {
      logger.warn(
        "AgentDB running with hash-based fallback embeddings - semantic search quality is degraded. Configure an embedding provider for better results.",
      );
    }

    await triggerLegacyMigration(config, agentdb, logger);

    if (config.memory.unified.autoTiering) {
      agentdb.startAutoTiering(
        config.memory.unified.autoTieringIntervalMs,
        config.memory.unified.promotionThreshold,
        config.memory.unified.demotionTimeoutDays,
      );
      logger.info("Auto-tiering enabled", {
        intervalMs: config.memory.unified.autoTieringIntervalMs,
        promotionThreshold: config.memory.unified.promotionThreshold,
        demotionTimeoutDays: config.memory.unified.demotionTimeoutDays,
      });
    }

    agentdb.setDecayConfig(config.memory.decay);

    // Fire-and-forget: migrate hash embeddings to real embeddings
    const agentdbAny = agentdb as unknown as Record<string, unknown>;
    if (embeddingProvider && typeof agentdbAny.reEmbedHashEntries === "function") {
      (agentdbAny.reEmbedHashEntries as () => Promise<{ migrated: number; total: number; skipped: number }>)()
        .then(result => {
          if (result.migrated > 0 || result.skipped > 0) {
            logger.info(`[Bootstrap] Re-embedded ${result.migrated}/${result.total} hash entries${result.skipped > 0 ? ` (${result.skipped} skipped)` : ""}`);
          }
        })
        .catch(err => {
          logger.warn(`[Bootstrap] Re-embed migration failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    return new AgentDBAdapter(agentdb);
  }

  // First attempt
  try {
    const agentdb = new AgentDBMemory(agentdbConfig);
    const initResult = await agentdb.initialize();
    if (initResult.kind === "ok") {
      logger.info("AgentDB memory initialized", { dbPath: agentdbPath });
      return await finalizeAgentDB(agentdb);
    }
    // Init returned err — throw to enter recovery
    throw initResult.error;
  } catch (firstError) {
    logger.warn("AgentDB initialization failed, attempting schema repair", {
      error: firstError instanceof Error ? firstError.message : String(firstError),
    });

    // Attempt schema repair
    const repairOk = await attemptSchemaRepair(agentdbPath, logger);

    // Retry AgentDB after repair
    try {
      const agentdb2 = new AgentDBMemory(agentdbConfig);
      const retryResult = await agentdb2.initialize();
      if (retryResult.kind === "ok") {
        logger.info("AgentDB recovered after schema repair", { dbPath: agentdbPath });
        return await finalizeAgentDB(agentdb2);
      }
      throw retryResult.error;
    } catch (retryError) {
      logger.warn("AgentDB retry failed after repair, falling back to FileMemoryManager", {
        repairAttempted: repairOk,
        error: retryError instanceof Error ? retryError.message : String(retryError),
      });
      return initializeFileMemory(config, logger);
    }
  }
}

async function attemptSchemaRepair(dbPath: string, logger: winston.Logger): Promise<boolean> {
  try {
    const sqlitePath = join(dbPath, "memory.db");
    if (!existsSync(sqlitePath)) return true; // Fresh DB, no repair needed
    const db = new Database(sqlitePath);
    db.pragma("journal_mode = WAL");
    try {
      db.prepare("SELECT COUNT(*) FROM memories").get();
    } catch {
      logger.info("AgentDB schema repair: memories table will be recreated on next init");
    }
    db.close();
    return true;
  } catch (e) {
    logger.error("AgentDB schema repair failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Trigger legacy FileMemoryManager → AgentDB migration if needed.
 * Non-blocking: migration failure must never prevent agent startup.
 */
async function triggerLegacyMigration(
  config: Config,
  agentdb: AgentDBMemory,
  logger: winston.Logger,
): Promise<void> {
  try {
    const migrationStatus = await runAutomaticMigration(
      config.memory.dbPath, // sourcePath where memory.json lives
      agentdb,              // IUnifiedMemory target
    );
    if (migrationStatus) {
      logger.info("Legacy memory migration completed", {
        migrated: migrationStatus.entriesMigrated,
        failed: migrationStatus.entriesFailed,
        errors: migrationStatus.errors.length,
      });
    }
  } catch (migrationError) {
    // Migration failure must not block agent startup
    logger.warn("Legacy memory migration failed, continuing with empty AgentDB", {
      error: migrationError instanceof Error ? migrationError.message : String(migrationError),
    });
  }
}

async function initializeFileMemory(
  config: Config,
  logger: winston.Logger,
): Promise<IMemoryManager | undefined> {
  try {
    const mm = new FileMemoryManager(config.memory.dbPath);
    await mm.initialize();
    logger.info("FileMemoryManager initialized", { dbPath: config.memory.dbPath });
    return mm;
  } catch (error) {
    logger.warn("FileMemoryManager initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTransientEmbeddingVerificationError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return [
    "fetch failed",
    "network",
    "timed out",
    "timeout",
    "aborted",
    "econnreset",
    "econnrefused",
    "enotfound",
    "eai_again",
    "etimedout",
    "api error 429",
    "api error 500",
    "api error 502",
    "api error 503",
    "api error 504",
  ].some((token) => message.includes(token));
}

function describeEmbeddingConsumers(config: Config): string[] {
  const consumers: string[] = [];
  if (config.rag.enabled) {
    consumers.push("RAG");
  }
  if (config.memory.enabled) {
    consumers.push("memory/learning");
  }
  return consumers;
}

/**
 * Resolve and cache the embedding provider independently from the RAG pipeline.
 * This allows the embedding provider to be shared with AgentDBMemory and learning.
 */
export async function resolveAndCacheEmbeddings(
  config: Config,
  logger: winston.Logger,
): Promise<EmbeddingResolutionResult> {
  const embeddingConsumers = describeEmbeddingConsumers(config);
  if (embeddingConsumers.length === 0) {
    logger.info("Embeddings: semantic subsystems disabled by configuration, no embedding provider resolved");
    return {
      status: {
        state: "disabled",
        ragEnabled: config.rag.enabled,
        configuredProvider: config.rag.provider,
        configuredModel: config.rag.model,
        configuredDimensions: config.rag.dimensions,
        verified: false,
        usingHashFallback: true,
        notice: "RAG and semantic memory are disabled by configuration",
      },
    };
  }

  if (!config.rag.enabled) {
    logger.info("Embeddings: RAG disabled, but keeping embeddings active for memory/learning");
  }

  const consumerLabel = embeddingConsumers.join(" and ");

  try {
    const resolution = resolveEmbeddingProvider(config);
    if (!resolution) {
      const notice = describeEmbeddingResolutionFailure(config, consumerLabel);
      logger.warn("Embeddings: no compatible embedding provider found", { consumers: embeddingConsumers });
      return {
        notice,
        status: {
          state: "degraded",
          ragEnabled: config.rag.enabled,
          configuredProvider: config.rag.provider,
          configuredModel: config.rag.model,
          configuredDimensions: config.rag.dimensions,
          verified: false,
          usingHashFallback: true,
          notice,
        },
      };
    }

    logger.info(`Embeddings: using ${resolution.provider.name}`, {
      source: resolution.source,
      dimensions: resolution.provider.dimensions,
    });

    const cachedProvider = new CachedEmbeddingProvider(resolution.provider, {
      persistPath: join(config.memory.dbPath, "cache"),
    });
    await cachedProvider.initialize();

    return {
      cachedProvider,
      status: {
        state: "active",
        ragEnabled: config.rag.enabled,
        configuredProvider: config.rag.provider,
        configuredModel: config.rag.model,
        configuredDimensions: config.rag.dimensions,
        resolvedProviderName: resolution.provider.name,
        resolutionSource: resolution.source,
        activeDimensions: resolution.provider.dimensions,
        verified: false,
        usingHashFallback: false,
      },
    };
  } catch (error) {
    const notice = `Embeddings unavailable: initialization failed for ${consumerLabel}.`;
    logger.warn("Embedding resolution failed", {
      error: error instanceof Error ? error.message : String(error),
      consumers: embeddingConsumers,
    });
    return {
      notice,
      status: {
        state: "degraded",
        ragEnabled: config.rag.enabled,
        configuredProvider: config.rag.provider,
        configuredModel: config.rag.model,
        configuredDimensions: config.rag.dimensions,
        verified: false,
        usingHashFallback: true,
        notice,
      },
    };
  }
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

async function initializeLearning(config: Config, logger: winston.Logger, embeddingProvider?: CachedEmbeddingProvider): Promise<LearningResult> {
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
      const notice =
        "Instinct embeddings disabled: learning continues with lexical matching only.";
      notices.push(notice);
      logger.warn("Learning initialized without embedding provider; semantic instinct features disabled");
    }

    const pipeline = new LearningPipeline(learningStorage, {
      dbPath: learningDbPath,
      enabled: LEARNING_DEFAULTS.enabled,
      batchSize: LEARNING_DEFAULTS.batchSize,
      detectionIntervalMs: LEARNING_DEFAULTS.detectionIntervalMs as DurationMs,
      evolutionIntervalMs: LEARNING_DEFAULTS.evolutionIntervalMs as DurationMs,
      minConfidenceForCreation: LEARNING_DEFAULTS.minConfidenceForCreation,
      maxInstincts: LEARNING_DEFAULTS.maxInstincts,
    }, embeddingProvider, config.bayesian, eventBus);

    pipeline.start();

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

async function initializeChannel(
  channelType: string,
  config: Config,
  auth: AuthManager,
  logger: winston.Logger,
): Promise<IChannelAdapter> {
  switch (channelType) {
    case "cli":
      return new CLIChannel();

    case "whatsapp": {
      const sessionPath = config.whatsapp.sessionPath;
      const allowedNumbers = config.whatsapp.allowedNumbers;
      if (allowedNumbers.length === 0) {
        logger.info("WHATSAPP_ALLOWED_NUMBERS is empty — WhatsApp is open to all senders");
      }
      return new WhatsAppChannel(sessionPath, allowedNumbers);
    }

    case "discord": {
      if (!config.discord.botToken) {
        throw new AppError(
          "DISCORD_BOT_TOKEN is required when using Discord channel",
          "MISSING_DISCORD_TOKEN",
        );
      }
      return new DiscordChannel(config.discord.botToken, auth, {
        guildId: config.discord.guildId,
        slashCommands: getDefaultSlashCommands(),
      });
    }

    case "web":
      return new WebChannel(config.web.port, config.dashboard.port, {
        dashboardAuthToken: config.websocketDashboard.authToken,
        identityDbPath: join(config.memory.dbPath, "web-identities.db"),
      });

    case "matrix": {
      const { MatrixChannel } = await import("../channels/matrix/channel.js");
      const homeserver = config.matrix.homeserver;
      const accessToken = config.matrix.accessToken;
      const matrixUserId = config.matrix.userId;
      const allowOpenAccess = config.matrix.allowOpenAccess;
      const allowedUserIds = config.matrix.allowedUserIds;
      const allowedRoomIds = config.matrix.allowedRoomIds;
      if (!homeserver || !accessToken || !matrixUserId) {
        throw new AppError(
          "MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, and MATRIX_USER_ID are required for Matrix channel",
          "MISSING_MATRIX_CONFIG",
        );
      }
      return new MatrixChannel(
        homeserver,
        accessToken,
        matrixUserId,
        allowedUserIds,
        allowedRoomIds,
        allowOpenAccess,
      );
    }

    case "irc": {
      const { IRCChannel } = await import("../channels/irc/channel.js");
      const ircServer = config.irc.server;
      const ircNick = config.irc.nick;
      const allowOpenAccess = config.irc.allowOpenAccess;
      const ircChannels = config.irc.channels;
      const allowedUsers = config.irc.allowedUsers;
      if (!ircServer) {
        throw new AppError("IRC_SERVER is required for IRC channel", "MISSING_IRC_CONFIG");
      }
      return new IRCChannel(ircServer, ircNick, ircChannels, allowedUsers, allowOpenAccess);
    }

    case "teams": {
      const { TeamsChannel } = await import("../channels/teams/channel.js");
      const teamsAppId = config.teams.appId;
      const teamsAppPassword = config.teams.appPassword;
      const allowOpenAccess = config.teams.allowOpenAccess;
      const allowedUserIds = config.teams.allowedUserIds;
      if (!teamsAppId || !teamsAppPassword) {
        throw new AppError(
          "TEAMS_APP_ID and TEAMS_APP_PASSWORD are required for Teams channel",
          "MISSING_TEAMS_CONFIG",
        );
      }
      return new TeamsChannel(teamsAppId, teamsAppPassword, 3978, allowedUserIds, "127.0.0.1", allowOpenAccess);
    }

    case "telegram":
    default: {
      if (!config.telegram.botToken) {
        throw new AppError(
          "TELEGRAM_BOT_TOKEN is required when using Telegram channel",
          "MISSING_TELEGRAM_TOKEN",
        );
      }
      return new TelegramChannel(config.telegram.botToken, auth);
    }
  }
}

async function initializeDashboard(
  config: Config,
  metrics: MetricsCollector,
  memoryManager: IMemoryManager | undefined,
  logger: winston.Logger,
): Promise<DashboardServer | undefined> {
  if (!config.dashboard.enabled) {
    return undefined;
  }

  const dashboard = new DashboardServer(config.dashboard.port, metrics, () =>
    memoryManager?.getStats(),
  );

  try {
    await dashboard.start();
    return dashboard;
  } catch (error) {
    logger.warn("Dashboard failed to start", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function initializeRateLimiter(config: Config, logger: winston.Logger): RateLimiter | undefined {
  if (!config.rateLimit.enabled) {
    return undefined;
  }

  const rateLimiter = new RateLimiter({
    messagesPerMinute: config.rateLimit.messagesPerMinute || DEFAULT_RATE_LIMITS.messagesPerMinute,
    messagesPerHour: config.rateLimit.messagesPerHour || DEFAULT_RATE_LIMITS.messagesPerHour,
    tokensPerDay: config.rateLimit.tokensPerDay || DEFAULT_RATE_LIMITS.tokensPerDay,
    dailyBudgetUsd: config.rateLimit.dailyBudgetUsd || DEFAULT_RATE_LIMITS.dailyBudgetUsd,
    monthlyBudgetUsd: config.rateLimit.monthlyBudgetUsd || DEFAULT_RATE_LIMITS.monthlyBudgetUsd,
  });

  logger.info("Rate limiter initialized", {
    messagesPerMinute: config.rateLimit.messagesPerMinute,
    dailyBudgetUsd: config.rateLimit.dailyBudgetUsd,
  });

  return rateLimiter;
}

function wireMessageHandler(
  channel: IChannelAdapter,
  messageRouter: MessageRouter,
  orchestrator: Orchestrator,
  taskPlanner: TaskPlanner,
  learningPipeline: LearningPipeline | undefined,
  identityManager?: IdentityStateManager,
  heartbeatLoopRef?: HeartbeatLoop,
  activityRegistryRef?: ChannelActivityRegistry,
  channelTypeName?: string,
): void {
  channel.onMessage(async (msg) => {
    if (activityRegistryRef && channelTypeName) {
      activityRegistryRef.recordActivity(channelTypeName, msg.chatId);
    }
    // Interrupt consolidation on user activity (MEM-13)
    heartbeatLoopRef?.onUserActivity();
    // Track activity and messages for identity persistence
    if (identityManager) {
      identityManager.recordActivity();
      identityManager.incrementMessages();
    }

    // Start task tracking for learning system
    let taskRunId: string | undefined;
    if (taskPlanner) {
      taskPlanner.startTask({
        sessionId: msg.chatId ?? generateSessionId(),
        chatId: msg.chatId,
        taskDescription: msg.text.slice(0, 200),
        learningPipeline,
      });
      taskRunId = taskPlanner.getTaskRunId() ?? undefined;
    }

    let routeError: unknown;
    await orchestrator.withTaskExecutionContext({
      chatId: msg.chatId,
      conversationId: msg.conversationId,
      userId: msg.userId,
      taskRunId,
    }, async () => {
      try {
        // Route through the message router (handles commands and task submission)
        await messageRouter.route(msg);
      } catch (error) {
        routeError = error;
        throw error;
      } finally {
        // End task tracking
        if (taskPlanner?.isActive()) {
          taskPlanner.attachReplayContext(await orchestrator.buildTrajectoryReplayContext({
            chatId: msg.chatId,
            userId: msg.userId,
            conversationId: msg.conversationId,
            sinceTimestamp: taskPlanner.getTaskStartedAt() ?? undefined,
            taskRunId,
          }));
          taskPlanner.endTask({
            success: routeError === undefined,
            finalOutput: routeError instanceof Error ? routeError.message : undefined,
            hadErrors: routeError !== undefined,
            errorCount: routeError === undefined ? 0 : 1,
          });
        }
      }
    });
  });
}

function setupCleanup(orchestrator: Orchestrator): ReturnType<typeof setInterval> {
  return setInterval(() => {
    orchestrator.cleanupSessions();
  }, SESSION_CLEANUP_INTERVAL_MS);
}

interface ShutdownOptions {
  dashboard?: DashboardServer;
  ragPipeline?: IRAGPipeline;
  memoryManager?: IMemoryManager;
  channel: IChannelAdapter;
  cleanupInterval: ReturnType<typeof setInterval>;
  learningPipeline?: LearningPipeline;
  taskStorage?: TaskStorage;
  providerManager?: ProviderManager;
  eventBus?: IEventBus<LearningEventMap>;
  learningQueue?: LearningQueue;
  metricsStorage?: MetricsStorage;
  goalStorage?: GoalStorage;
  chainManager?: ChainManager;
  identityManager?: IdentityStateManager;
  modelIntelligence?: import("../agents/providers/model-intelligence.js").ModelIntelligenceService;
  uptimeInterval?: ReturnType<typeof setInterval>;
  heartbeatLoop?: HeartbeatLoop;
  digestReporter?: DigestReporter;
  notificationRouter?: NotificationRouter;
  agentManager?: AgentManagerType;
  delegationManager?: DelegationManagerType;
  stoppableServers?: Array<{ stop(): Promise<void> | void }>;
  soulLoader?: SoulLoader;
  autoUpdater?: AutoUpdater;
}

function createShutdownHandler(options: ShutdownOptions): () => Promise<void> {
  const { dashboard, ragPipeline, memoryManager, channel, cleanupInterval, learningPipeline } =
    options;
  const logger = getLogger();

  return async (): Promise<void> => {
    const SHUTDOWN_TIMEOUT_MS = 30_000;

    const gracefulShutdown = async (): Promise<void> => {
      logger.info("Shutting down Strada Brain...");

      clearInterval(cleanupInterval);

      // Stop auto-updater timers
      if (options.autoUpdater) {
        options.autoUpdater.shutdown();
      }

      // Stop soul file watchers
      if (options.soulLoader) {
        options.soulLoader.shutdown();
      }

      // Stop reporting before heartbeat loop
      if (options.digestReporter) {
        options.digestReporter.stop();
      }
      if (options.notificationRouter) {
        options.notificationRouter.stop();
      }

      // Shut down delegation manager before multi-agent system
      if (options.delegationManager) {
        await options.delegationManager.shutdown();
      }

      // Shut down multi-agent system before heartbeat loop
      if (options.agentManager) {
        await options.agentManager.shutdown();
      }

      // Stop heartbeat loop before draining events
      if (options.heartbeatLoop) {
        options.heartbeatLoop.stop();
      }

      // Stop chain detection timer before draining events
      if (options.chainManager) {
        options.chainManager.stop();
      }

      // Drain event bus and learning queue before stopping pipeline
      if (options.eventBus) {
        await options.eventBus.shutdown();
      }
      if (options.learningQueue) {
        await options.learningQueue.shutdown();
      }

      // Then stop the pipeline (clears evolution timer, shuts down embedding queue)
      if (learningPipeline) {
        learningPipeline.stop();
      }

      if (options.metricsStorage) {
        options.metricsStorage.close();
      }

      if (options.goalStorage) {
        options.goalStorage.close();
      }

      if (options.taskStorage) {
        options.taskStorage.close();
      }

      if (options.providerManager) {
        options.providerManager.shutdown();
      }

      if (options.modelIntelligence) {
        options.modelIntelligence.shutdown();
      }

      if (dashboard) {
        await dashboard.stop();
      }

      if (options.stoppableServers) {
        await Promise.all(options.stoppableServers.map(s => s.stop()));
      }

      if (ragPipeline) {
        await ragPipeline.shutdown();
      }

      if (memoryManager) {
        await memoryManager.shutdown();
      }

      // Identity shutdown: record clean shutdown and flush uptime (before DB closes)
      if (options.uptimeInterval) {
        clearInterval(options.uptimeInterval);
      }
      if (options.identityManager) {
        options.identityManager.recordShutdown();
        options.identityManager.close();
      }

      await channel.disconnect();
      logger.info("Strada Brain stopped.");
    };

    try {
      await Promise.race([
        gracefulShutdown(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Shutdown timeout exceeded")), SHUTDOWN_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      if (err instanceof Error && err.message === "Shutdown timeout exceeded") {
        logger.error("Forced shutdown: graceful shutdown took longer than 30s");
        process.exit(1);
      }
      throw err;
    }
  };
}

function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
