/**
 * Application Bootstrap
 *
 * Handles initialization of all services and wires up dependencies.
 * Replaces the monolithic startBrain() function from index.ts.
 */

import { join } from "node:path";
import type { Config } from "../config/config.js";
import { type DurationMs } from "../types/index.js";
import { createLogger, getLogger } from "../utils/logger.js";
import { AuthManager } from "../security/auth.js";
import { ClaudeProvider } from "../agents/providers/claude.js";
import { buildProviderChain } from "../agents/providers/provider-registry.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { MetricsCollector } from "../dashboard/metrics.js";
import { DashboardServer } from "../dashboard/server.js";
import { FileMemoryManager } from "../memory/file-memory-manager.js";
import { RAGPipeline } from "../rag/rag-pipeline.js";
import { FileVectorStore } from "../rag/vector-store.js";
import { OpenAIEmbeddingProvider } from "../rag/embeddings/openai-embeddings.js";
import { OllamaEmbeddingProvider } from "../rag/embeddings/ollama-embeddings.js";
import { CachedEmbeddingProvider } from "../rag/embeddings/embedding-cache.js";
import { RateLimiter } from "../security/rate-limiter.js";
import type { DIContainer } from "./di-container.js";
import { ToolRegistry } from "./tool-registry.js";
import { AppError } from "../common/errors.js";
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

// Learning system imports
import {
  LearningStorage,
  LearningPipeline,
  ErrorLearningHooks,
  PatternMatcher,
  ConfidenceScorer,
} from "../learning/index.js";
import { ErrorRecoveryEngine } from "../agents/autonomy/error-recovery.js";
import { TaskPlanner } from "../agents/autonomy/task-planner.js";

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
import type { IRAGPipeline, IEmbeddingProvider } from "../rag/rag.interface.js";

export interface BootstrapOptions {
  channelType: string;
  config: Config;
  container?: DIContainer;
}

export interface BootstrapResult {
  orchestrator: Orchestrator;
  messageRouter: MessageRouter;
  channel: IChannelAdapter;
  container: DIContainer;
  shutdown: () => Promise<void>;
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

  // Initialize security
  const auth = initializeAuth(config, channelType, logger);

  // Initialize AI provider
  const provider = initializeAIProvider(config, logger);

  // Initialize memory manager
  const memoryManager = await initializeMemory(config, logger);

  // Initialize RAG pipeline
  const ragPipeline = await initializeRAG(config, logger);

  // Initialize learning system
  const learningResult = await initializeLearning(config, logger);

  // Initialize tools
  const toolRegistry = new ToolRegistry();
  await toolRegistry.initialize(config, { memoryManager, ragPipeline });

  // Initialize channel
  const channel = await initializeChannel(channelType, config, auth, logger);

  // Initialize metrics and dashboard
  const metrics = new MetricsCollector();

  const dashboard = await initializeDashboard(config, metrics, memoryManager, logger);

  // Register services for deep readiness checks
  if (dashboard) {
    dashboard.registerServices({ memoryManager, channel });
  }

  // Initialize rate limiter
  const rateLimiter = initializeRateLimiter(config, logger);

  // Initialize orchestrator
  const orchestrator = new Orchestrator({
    provider,
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
  });

  // Initialize task system
  const taskStorage = initializeTaskStorage(config, logger);
  const backgroundExecutor = new BackgroundExecutor(orchestrator);
  const taskManager = new TaskManager(taskStorage, backgroundExecutor);
  backgroundExecutor.setTaskManager(taskManager);
  taskManager.recoverOnStartup();

  const commandHandler = new CommandHandler(taskManager, channel);
  const messageRouter = new MessageRouter(taskManager, commandHandler);
  // ProgressReporter subscribes to taskManager events in constructor
  new ProgressReporter(channel, taskManager);

  // Wire up message handler
  wireMessageHandler(
    channel,
    messageRouter,
    orchestrator,
    learningResult.taskPlanner,
    learningResult.pipeline,
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
    shutdown: createShutdownHandler({
      dashboard,
      ragPipeline,
      memoryManager,
      channel,
      cleanupInterval,
      learningPipeline: learningResult.pipeline,
      taskStorage,
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

function initializeAIProvider(config: Config, logger: winston.Logger): IAIProvider {
  if (config.providerChain) {
    const names = config.providerChain.split(",").map((s) => s.trim());
    const apiKeys = {
      claude: config.anthropicApiKey,
      anthropic: config.anthropicApiKey,
      openai: config.openaiApiKey,
      deepseek: config.deepseekApiKey,
      qwen: config.qwenApiKey,
      kimi: config.kimiApiKey,
      minimax: config.minimaxApiKey,
      groq: config.groqApiKey,
      mistral: config.mistralApiKey,
      together: config.togetherApiKey,
      fireworks: config.fireworksApiKey,
      gemini: config.geminiApiKey,
    };
    const provider = buildProviderChain(names, apiKeys);
    logger.info("AI provider chain initialized", { chain: names });
    return provider;
  }

  const provider = new ClaudeProvider(config.anthropicApiKey);
  logger.info("AI provider initialized", { name: provider.name });
  return provider;
}

async function initializeMemory(
  config: Config,
  logger: winston.Logger,
): Promise<IMemoryManager | undefined> {
  if (!config.memory.enabled) {
    return undefined;
  }

  try {
    const mm = new FileMemoryManager(config.memory.dbPath);
    await mm.initialize();
    logger.info("Memory manager initialized", { dbPath: config.memory.dbPath });
    return mm;
  } catch (error) {
    logger.warn("Memory manager initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function initializeRAG(
  config: Config,
  logger: winston.Logger,
): Promise<IRAGPipeline | undefined> {
  if (!config.rag.enabled) {
    return undefined;
  }

  try {
    let embeddingProvider: IEmbeddingProvider;

    if (config.rag.provider === "ollama") {
      embeddingProvider = new OllamaEmbeddingProvider({
        model: config.rag.model,
        baseUrl: config.rag.baseUrl,
      });
    } else {
      const apiKey = config.openaiApiKey;
      if (!apiKey) {
        logger.warn("RAG disabled: OPENAI_API_KEY required for OpenAI embeddings");
        return undefined;
      }
      embeddingProvider = new OpenAIEmbeddingProvider({
        apiKey,
        model: config.rag.model,
        baseUrl: config.rag.baseUrl,
      });
    }

    const cachedProvider = new CachedEmbeddingProvider(embeddingProvider, {
      persistPath: join(config.memory.dbPath, "cache"),
    });
    await cachedProvider.initialize();

    const vectorStore = new FileVectorStore(
      join(config.memory.dbPath, "vectors"),
      cachedProvider.dimensions,
    );

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

    return pipeline;
  } catch (error) {
    logger.warn("RAG initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

interface LearningResult {
  pipeline?: LearningPipeline;
  taskPlanner: TaskPlanner;
  errorRecovery: ErrorRecoveryEngine;
}

async function initializeLearning(config: Config, logger: winston.Logger): Promise<LearningResult> {
  try {
    const learningDbPath = join(config.memory.dbPath, "learning.db");
    const learningStorage = new LearningStorage(learningDbPath);
    learningStorage.initialize();

    const pipeline = new LearningPipeline(learningStorage, {
      dbPath: learningDbPath,
      enabled: LEARNING_DEFAULTS.enabled,
      batchSize: LEARNING_DEFAULTS.batchSize,
      detectionIntervalMs: LEARNING_DEFAULTS.detectionIntervalMs as DurationMs,
      evolutionIntervalMs: LEARNING_DEFAULTS.evolutionIntervalMs as DurationMs,
      minConfidenceForCreation: LEARNING_DEFAULTS.minConfidenceForCreation,
      maxInstincts: LEARNING_DEFAULTS.maxInstincts,
    });

    pipeline.start();

    const patternMatcher = new PatternMatcher(learningStorage);
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

    logger.info("Learning pipeline initialized", {
      dbPath: learningDbPath,
      stats: pipeline.getStats(),
    });

    return { pipeline, taskPlanner, errorRecovery };
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
): void {
  channel.onMessage(async (msg) => {
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
}

function createShutdownHandler(options: ShutdownOptions): () => Promise<void> {
  const { dashboard, ragPipeline, memoryManager, channel, cleanupInterval, learningPipeline } =
    options;
  const logger = getLogger();

  return async (): Promise<void> => {
    logger.info("Shutting down Strata Brain...");

    clearInterval(cleanupInterval);

    if (learningPipeline) {
      learningPipeline.stop();
    }

    if (options.taskStorage) {
      options.taskStorage.close();
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

    await channel.disconnect();
    logger.info("Strata Brain stopped.");
  };
}

function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
