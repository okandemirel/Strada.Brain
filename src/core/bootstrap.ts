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
import { resolveEmbeddingProvider, collectApiKeys } from "../rag/embeddings/embedding-resolver.js";
import { RateLimiter } from "../security/rate-limiter.js";
import type { DIContainer } from "./di-container.js";
import { ToolRegistry } from "./tool-registry.js";
import { AppError, MissingConfigError } from "../common/errors.js";
import { checkStradaDeps } from "../config/strada-deps.js";
import {
  SESSION_CLEANUP_INTERVAL_MS,
  DEFAULT_RATE_LIMITS,
  LEARNING_DEFAULTS,
} from "../common/constants.js";
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
import { InstinctRetriever } from "../agents/instinct-retriever.js";
import { MetricsStorage } from "../metrics/metrics-storage.js";
import { MetricsRecorder } from "../metrics/metrics-recorder.js";
import { GoalStorage, GoalDecomposer, detectInterruptedTrees } from "../goals/index.js";
import type { GoalExecutorConfig } from "../goals/index.js";
import type { GoalTree } from "../goals/types.js";
import { ChainDetector, ChainSynthesizer, ChainManager } from "../learning/chains/index.js";
import type { ToolChainConfig } from "../learning/chains/index.js";
import { IdentityStateManager } from "../identity/identity-state.js";
import { buildCrashRecoveryContext } from "../identity/crash-recovery.js";
import type { CrashRecoveryContext } from "../identity/crash-recovery.js";
import { MigrationRunner } from "../learning/storage/migrations/index.js";
import { migration001CrossSessionProvenance } from "../learning/storage/migrations/001-cross-session-provenance.js";
import type { ScopeContext } from "../learning/matching/pattern-matcher.js";

// Daemon imports
import { HeartbeatLoop } from "../daemon/heartbeat-loop.js";
import { TriggerRegistry } from "../daemon/trigger-registry.js";
import { DaemonStorage } from "../daemon/daemon-storage.js";
import { BudgetTracker } from "../daemon/budget/budget-tracker.js";
import { DaemonSecurityPolicy } from "../daemon/security/daemon-security-policy.js";
import { ApprovalQueue } from "../daemon/security/approval-queue.js";
import { CronTrigger } from "../daemon/triggers/cron-trigger.js";
import { parseHeartbeatFile } from "../daemon/heartbeat-parser.js";
import type { DaemonEventMap } from "../daemon/daemon-events.js";

// Task system imports
import {
  TaskStorage,
  TaskManager,
  BackgroundExecutor,
  MessageRouter,
  CommandHandler,
  ProgressReporter,
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
}

export interface BootstrapResult {
  orchestrator: Orchestrator;
  messageRouter: MessageRouter;
  channel: IChannelAdapter;
  container: DIContainer;
  shutdown: () => Promise<void>;
  heartbeatLoop?: HeartbeatLoop;
  daemonContext?: import("../daemon/daemon-cli.js").DaemonContext;
}

/**
 * Bootstrap the application with all services
 */
export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const { channelType, config, container: customContainer } = options;
  const container = customContainer!; // We ensure container exists below

  const logger = createLogger(config.logLevel, config.logFile);
  logger.info("Bootstrapping Strata Brain", {
    channel: channelType,
    projectPath: config.unityProjectPath,
    readOnly: config.security.readOnlyMode,
  });

  // Check Strada framework dependencies
  const stradaDeps = checkStradaDeps(config.unityProjectPath);
  if (!stradaDeps.coreInstalled) {
    logger.warn("Strada.Core not found in project Packages/", {
      projectPath: config.unityProjectPath,
      searchedNames: ["strada.core", "com.strada.core", "Strada.Core"],
    });
  }
  for (const warning of stradaDeps.warnings) {
    logger.warn(warning);
  }

  // Initialize security
  const auth = initializeAuth(config, channelType, logger);

  // Initialize AI provider manager
  const providerManager = await initializeAIProvider(config, logger);

  // Initialize memory manager
  const memoryManager = await initializeMemory(config, logger);

  // Initialize RAG pipeline
  const ragResult = await initializeRAG(config, logger);
  const ragPipeline = ragResult?.pipeline;
  const cachedEmbeddingProvider = ragResult?.cachedProvider;

  // Initialize learning system (pass shared embedding provider if available)
  // Note: identityManager may not be initialized yet at this point,
  // but it's created later. We pass undefined now and wire scope context after identity init.
  const learningResult = await initializeLearning(config, logger, cachedEmbeddingProvider);

  // Initialize tools (registry created here, initialized after metricsStorage below)
  const toolRegistry = new ToolRegistry();

  // Initialize channel
  const channel = await initializeChannel(channelType, config, auth, logger);

  // Initialize metrics and dashboard
  const metrics = new MetricsCollector();

  const dashboard = await initializeDashboard(config, metrics, memoryManager, logger);

  // Initialize rate limiter
  const rateLimiter = initializeRateLimiter(config, logger);

  // InstinctRetriever created below after identity and metrics are initialized

  // Initialize metrics storage for agent performance tracking (EVAL-01, EVAL-02, EVAL-03)
  let metricsStorage: MetricsStorage | undefined;
  let metricsRecorder: MetricsRecorder | undefined;
  try {
    const metricsDbPath = join(config.memory.dbPath, "learning.db");
    metricsStorage = new MetricsStorage(metricsDbPath);
    metricsStorage.initialize();
    metricsRecorder = new MetricsRecorder(metricsStorage);
    logger.info("Metrics storage initialized", { dbPath: metricsDbPath });
  } catch (error) {
    logger.warn("Metrics storage initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Initialize identity persistence (IDENT-01)
  let identityManager: IdentityStateManager | undefined;
  let uptimeInterval: ReturnType<typeof setInterval> | undefined;
  try {
    const identityDbPath = join(config.memory.dbPath, "identity.db");
    identityManager = new IdentityStateManager(identityDbPath, config.agentName);
    identityManager.initialize();
    identityManager.recordBoot();
    identityManager.setProjectContext(config.unityProjectPath);

    // Periodic uptime flush using actual elapsed time (bounds SIGKILL loss to ~60s)
    let lastFlushTime = Date.now();
    uptimeInterval = setInterval(() => {
      const now = Date.now();
      identityManager!.updateUptime(now - lastFlushTime);
      identityManager!.flush();
      lastFlushTime = now;
    }, 60000);

    logger.info("Identity initialized", {
      bootNumber: identityManager.getState().bootCount,
      wasCrash: identityManager.wasCrash(),
    });
  } catch (error) {
    logger.warn("Identity initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Wire cross-session scope context and InstinctRetriever (Phase 13)
  let instinctRetriever: InstinctRetriever | undefined;
  if (learningResult.patternMatcher) {
    const scopeContext: ScopeContext = {
      projectPath: config.unityProjectPath,
      scopeFilter: config.crossSession.scopeFilter,
      maxAgeDays: config.crossSession.maxAgeDays,
      recencyBoost: config.crossSession.recencyBoost,
      scopeBoost: config.crossSession.scopeBoost,
      currentBootCount: identityManager?.getState().bootCount,
      currentSessionId: `boot-${identityManager?.getState().bootCount ?? 0}`,
    };

    instinctRetriever = new InstinctRetriever(learningResult.patternMatcher, {
      scopeContext,
      storage: learningResult.storage,
      metricsRecorder,
    });
  }

  // Wire project path and promotion threshold to learning pipeline (Phase 13)
  if (learningResult.pipeline) {
    learningResult.pipeline.setProjectPath(config.unityProjectPath);
    learningResult.pipeline.setPromotionThreshold(config.crossSession.promotionThreshold);
  }

  // Initialize tool registry now that all deps are available
  // getDaemonStatus closure captures heartbeatLoop (declared below) via late binding
  let heartbeatLoop: HeartbeatLoop | undefined;
  let daemonContext: import("../daemon/daemon-cli.js").DaemonContext | undefined;
  await toolRegistry.initialize(config, {
    memoryManager,
    ragPipeline,
    metricsCollector: metrics,
    learningStorage: learningResult.storage,
    metricsStorage,
    getIdentityState: identityManager
      ? () => identityManager!.getState()
      : undefined,
    getDaemonStatus: () => heartbeatLoop?.getDaemonStatus(),
  });

  // Initialize goal decomposition system (GOAL-01, GOAL-02)
  let goalStorage: GoalStorage | undefined;
  let goalDecomposer: GoalDecomposer | undefined;
  try {
    const goalsDbPath = join(config.memory.dbPath, "goals.db");
    goalStorage = new GoalStorage(goalsDbPath);
    goalStorage.initialize();
    goalStorage.pruneOldTrees(); // Clean up completed/failed trees older than 7 days
    goalDecomposer = new GoalDecomposer(
      providerManager.getProvider(""),
      config.goalMaxDepth,
    );
    logger.info("GoalDecomposer initialized", { dbPath: goalsDbPath, maxDepth: config.goalMaxDepth });
  } catch (error) {
    logger.warn("GoalDecomposer initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Detect interrupted goal trees for resume prompt
  let interruptedGoalTrees: GoalTree[] = [];
  if (goalStorage) {
    try {
      interruptedGoalTrees = detectInterruptedTrees(goalStorage);
      if (interruptedGoalTrees.length > 0) {
        logger.info("Detected interrupted goal trees", { count: interruptedGoalTrees.length });
      }
    } catch (error) {
      logger.debug("Interrupted tree detection failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Build crash recovery context if unclean shutdown detected (IDENT-02)
  let crashContext: CrashRecoveryContext | null = null;
  if (identityManager) {
    crashContext = buildCrashRecoveryContext(
      identityManager.wasCrash(),
      identityManager.getState(),
      interruptedGoalTrees,
    );
    if (crashContext) {
      logger.warn("Unclean shutdown detected", {
        downtimeMs: crashContext.downtimeMs,
        interruptedTrees: crashContext.interruptedTrees.length,
        bootCount: crashContext.bootCount,
      });
    }
  }

  // Create GoalExecutorConfig from config values
  const goalExecutorConfig: GoalExecutorConfig = {
    maxRetries: config.goalMaxRetries,
    maxFailures: config.goalMaxFailures,
    parallelExecution: config.goalParallelExecution,
    maxParallel: config.goalMaxParallel,
  };

  // Register services for deep readiness checks and agent metrics endpoint
  if (dashboard) {
    dashboard.registerServices({ memoryManager, channel, metricsStorage, learningStorage: learningResult.storage, goalStorage });
  }

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
    stradaDeps,
    instinctRetriever,
    eventEmitter: learningResult.eventBus,
    metricsRecorder,
    goalDecomposer,
    interruptedGoalTrees,
    getIdentityState: identityManager ? () => identityManager!.getState() : undefined,
    crashRecoveryContext: crashContext ?? undefined,
  });

  // Initialize tool chain synthesis (TOOL-01 through TOOL-05)
  let chainManager: ChainManager | undefined;
  if (config.toolChain.enabled && learningResult.storage) {
    try {
      const chainConfig: ToolChainConfig = config.toolChain;
      const chainDetector = new ChainDetector(learningResult.storage, chainConfig);
      const chainSynthesizer = new ChainSynthesizer(
        learningResult.storage,
        toolRegistry,
        learningResult.eventBus as IEventBus<LearningEventMap>,
        chainConfig,
      );
      // Use the same provider as orchestrator for LLM chain synthesis
      chainSynthesizer.setProvider(providerManager.getProvider(""));

      chainManager = new ChainManager(
        chainDetector,
        chainSynthesizer,
        toolRegistry,
        learningResult.storage,
        orchestrator,
        learningResult.eventBus as IEventBus<LearningEventMap>,
        chainConfig,
      );

      // Start chain manager (loads existing chains, starts detection timer)
      await chainManager.start();
      logger.info("Tool chain synthesis initialized");
    } catch (error) {
      logger.warn("Tool chain synthesis initialization failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Initialize task system
  const taskStorage = initializeTaskStorage(config, logger);
  const backgroundExecutor = new BackgroundExecutor({
    orchestrator,
    decomposer: goalDecomposer,
    goalStorage,
    goalExecutorConfig,
    aiProvider: providerManager.getProvider(""),
    channel,
  });
  const taskManager = new TaskManager(taskStorage, backgroundExecutor);
  backgroundExecutor.setTaskManager(taskManager);
  taskManager.recoverOnStartup();

  const commandHandler = new CommandHandler(taskManager, channel, providerManager);
  const messageRouter = new MessageRouter(taskManager, commandHandler);
  // ProgressReporter subscribes to taskManager events in constructor
  new ProgressReporter(channel, taskManager);

  // Initialize daemon heartbeat loop (if daemon mode enabled)
  if (options.daemonMode) {
    const daemonConfig = config.daemon;

    // Validate budget is configured (required for daemon mode)
    if (!daemonConfig.budget.dailyBudgetUsd) {
      throw new MissingConfigError("STRATA_DAEMON_DAILY_BUDGET");
    }

    // Initialize daemon storage
    const daemonDbPath = join(config.memory.dbPath, "daemon.db");
    const daemonStorage = new DaemonStorage(daemonDbPath);
    daemonStorage.initialize();

    // Create event bus for daemon events (separate from learning event bus)
    const daemonEventBus = new TypedEventBus<DaemonEventMap>();

    // Create subsystems
    const triggerRegistry = new TriggerRegistry();
    const budgetTrackerInstance = new BudgetTracker(daemonStorage, daemonConfig.budget);
    const approvalQueueInstance = new ApprovalQueue(
      daemonStorage,
      daemonConfig.security.approvalTimeoutMin,
      daemonEventBus,
    );
    const securityPolicyInstance = new DaemonSecurityPolicy(
      (name) => toolRegistry.getMetadata(name),
      approvalQueueInstance,
      new Set(daemonConfig.security.autoApproveTools),
    );

    // Parse HEARTBEAT.md and register triggers
    const heartbeatPath = daemonConfig.heartbeat.heartbeatFile;
    try {
      const content = readFileSync(heartbeatPath, "utf-8");
      const triggerDefs = parseHeartbeatFile(content);
      for (const def of triggerDefs) {
        if (def.enabled === false) continue;
        const trigger = new CronTrigger(
          { name: def.name, description: def.action, type: "cron" },
          def.cron,
          daemonConfig.timezone || undefined,
        );
        triggerRegistry.register(trigger);
      }
      logger.info("Daemon triggers loaded", {
        count: triggerRegistry.count(),
        file: heartbeatPath,
      });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        logger.warn("HEARTBEAT.md not found", { path: heartbeatPath });
      } else {
        throw err;
      }
    }

    // Create HeartbeatLoop
    heartbeatLoop = new HeartbeatLoop(
      triggerRegistry,
      taskManager,
      budgetTrackerInstance,
      securityPolicyInstance,
      approvalQueueInstance,
      daemonStorage,
      identityManager,
      daemonEventBus,
      daemonConfig,
      logger,
    );

    // Build daemon context for CLI commands (Plan 05)
    daemonContext = {
      heartbeatLoop,
      registry: triggerRegistry,
      budgetTracker: budgetTrackerInstance,
      approvalQueue: approvalQueueInstance,
      storage: daemonStorage,
      config: daemonConfig,
    };

    // Auto-restart after crash recovery
    if (crashContext?.wasCrash) {
      const wasDaemonRunning = daemonStorage.getDaemonState("daemon_was_running");
      if (wasDaemonRunning === "true") {
        logger.info("Daemon auto-restarting after crash recovery");
      }
    }

    // Start heartbeat (HeartbeatLoop.start() logs startup details)
    heartbeatLoop.start();

    // Wire daemon context into dashboard (Plan 05)
    if (dashboard) {
      dashboard.setDaemonContext({
        heartbeatLoop,
        registry: triggerRegistry,
        approvalQueue: approvalQueueInstance,
      });
    }
  }

  // Wire up message handler
  wireMessageHandler(
    channel,
    messageRouter,
    orchestrator,
    learningResult.taskPlanner,
    learningResult.pipeline,
    identityManager,
  );

  // Setup cleanup
  const cleanupInterval = setupCleanup(orchestrator);

  // Start channel
  await channel.connect();
  logger.info("Strata Brain is running!");

  // Return result with shutdown function
  return {
    orchestrator,
    messageRouter,
    channel,
    container,
    heartbeatLoop,
    daemonContext,
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
      uptimeInterval,
      heartbeatLoop,
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

  const allowedDiscordIds = new Set(
    process.env["ALLOWED_DISCORD_USER_IDS"]
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? [],
  );
  const allowedDiscordRoles = new Set(
    process.env["ALLOWED_DISCORD_ROLE_IDS"]
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? [],
  );

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

async function initializeAIProvider(config: Config, logger: winston.Logger): Promise<ProviderManager> {
  const apiKeys = collectApiKeys(config);

  let defaultProvider: IAIProvider;

  // 1) Explicit provider chain
  if (config.providerChain) {
    const names = config.providerChain.split(",").map((s) => s.trim());
    defaultProvider = buildProviderChain(names, apiKeys, {
      models: config.providerModels,
    });
    logger.info("AI provider chain initialized", { chain: names });
  }
  // 2) Anthropic key present — use ClaudeProvider directly
  else if (config.anthropicApiKey) {
    defaultProvider = new ClaudeProvider(config.anthropicApiKey);
    logger.info("AI provider initialized", { name: defaultProvider.name });
  }
  // 3) No explicit chain and no Anthropic key — auto-detect from available keys
  else {
    const detectedNames = Object.entries(apiKeys)
      .filter(([name, key]) => name !== "claude" && name !== "anthropic" && key)
      .map(([name]) => name);

    if (detectedNames.length === 0) {
      throw new AppError(
        "No AI provider configured. Please set at least one provider API key.",
        "NO_AI_PROVIDER",
      );
    }

    defaultProvider = buildProviderChain(detectedNames, apiKeys, {
      models: config.providerModels,
    });
    logger.info("AI provider auto-detected from available keys", { chain: detectedNames });
  }

  // Run health check (non-blocking — warn only)
  if (defaultProvider.healthCheck) {
    const healthy = await defaultProvider.healthCheck();
    const logMethod = healthy ? "info" : "warn";
    const message = healthy
      ? "AI provider health check passed"
      : "AI provider health check failed — API may be unreachable or key invalid";
    logger[logMethod](message, { name: defaultProvider.name });
  }

  const providerManager = new ProviderManager(
    defaultProvider,
    apiKeys,
    config.providerModels,
    config.memory.dbPath,
  );
  logger.info("ProviderManager initialized with per-chat switching support");

  return providerManager;
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
    dimensions: config.memory.unified.dimensions,
    maxEntriesPerTier: {
      working: config.memory.unified.tierLimits.working,
      ephemeral: config.memory.unified.tierLimits.ephemeral,
      persistent: config.memory.unified.tierLimits.persistent,
    },
    enableAutoTiering: config.memory.unified.autoTiering,
    ephemeralTtlMs: (config.memory.unified.ephemeralTtlHours * 3600000) as DurationMs,
  };

  // Post-init steps shared between first attempt and repair path
  async function finalizeAgentDB(agentdb: AgentDBMemory): Promise<AgentDBAdapter> {
    if (!config.rag.enabled) {
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

interface RAGResult {
  pipeline: IRAGPipeline;
  cachedProvider: CachedEmbeddingProvider;
}

async function initializeRAG(
  config: Config,
  logger: winston.Logger,
): Promise<RAGResult | undefined> {
  if (!config.rag.enabled) {
    logger.info("RAG: disabled by configuration");
    return undefined;
  }

  try {
    const resolution = resolveEmbeddingProvider(config);
    if (!resolution) {
      logger.warn("RAG: disabled — no compatible embedding provider found");
      return undefined;
    }

    logger.info(`RAG: using ${resolution.provider.name} for embeddings`, {
      source: resolution.source,
    });

    const cachedProvider = new CachedEmbeddingProvider(resolution.provider, {
      persistPath: join(config.memory.dbPath, "cache"),
    });
    await cachedProvider.initialize();

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
    logger.warn("RAG initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

interface LearningResult {
  pipeline?: LearningPipeline;
  storage?: LearningStorage;
  patternMatcher?: PatternMatcher;
  taskPlanner: TaskPlanner;
  errorRecovery: ErrorRecoveryEngine;
  eventBus?: IEventBus<LearningEventMap>;
  learningQueue?: LearningQueue;
}

async function initializeLearning(config: Config, logger: winston.Logger, embeddingProvider?: CachedEmbeddingProvider): Promise<LearningResult> {
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
        pipeline.handleToolResult(event);
      });
    });

    logger.info("Learning pipeline initialized", {
      dbPath: learningDbPath,
      stats: pipeline.getStats(),
    });

    return { pipeline, storage: learningStorage, patternMatcher, taskPlanner, errorRecovery, eventBus, learningQueue };
  } catch (error) {
    logger.warn("Learning pipeline initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      taskPlanner: new TaskPlanner(),
      errorRecovery: new ErrorRecoveryEngine(),
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
      const sessionPath = process.env["WHATSAPP_SESSION_PATH"] ?? ".whatsapp-session";
      const allowedNumbers =
        process.env["WHATSAPP_ALLOWED_NUMBERS"]
          ?.split(",")
          .map((n) => n.trim())
          .filter(Boolean) ?? [];
      if (allowedNumbers.length === 0) {
        logger.warn("WHATSAPP_ALLOWED_NUMBERS is empty — all WhatsApp users will be denied access");
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
      return new WebChannel(config.web.port);

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

function initializeTaskStorage(config: Config, logger: winston.Logger): TaskStorage {
  const dbPath = join(config.memory.dbPath, "tasks.db");
  const storage = new TaskStorage(dbPath);
  storage.initialize();
  logger.info("Task storage initialized", { dbPath });
  return storage;
}

function wireMessageHandler(
  channel: IChannelAdapter,
  messageRouter: MessageRouter,
  _orchestrator: Orchestrator,
  taskPlanner: TaskPlanner,
  learningPipeline: LearningPipeline | undefined,
  identityManager?: IdentityStateManager,
): void {
  channel.onMessage(async (msg) => {
    // Track activity and messages for identity persistence
    if (identityManager) {
      identityManager.recordActivity();
      identityManager.incrementMessages();
    }

    // Start task tracking for learning system
    if (taskPlanner) {
      taskPlanner.startTask({
        sessionId: msg.chatId ?? generateSessionId(),
        taskDescription: msg.text.slice(0, 200),
        learningPipeline,
      });
    }

    // Route through the message router (handles commands and task submission)
    await messageRouter.route(msg);

    // End task tracking
    if (taskPlanner?.isActive()) {
      taskPlanner.endTask({
        success: true,
        hadErrors: false,
        errorCount: 0,
      });
    }
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
  uptimeInterval?: ReturnType<typeof setInterval>;
  heartbeatLoop?: HeartbeatLoop;
}

function createShutdownHandler(options: ShutdownOptions): () => Promise<void> {
  const { dashboard, ragPipeline, memoryManager, channel, cleanupInterval, learningPipeline } =
    options;
  const logger = getLogger();

  return async (): Promise<void> => {
    logger.info("Shutting down Strata Brain...");

    clearInterval(cleanupInterval);

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

    if (dashboard) {
      await dashboard.stop();
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
    logger.info("Strata Brain stopped.");
  };
}

function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
