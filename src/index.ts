import { Command } from "commander";
import { loadConfig } from "./config/config.js";
import { createLogger } from "./utils/logger.js";
import { AuthManager } from "./security/auth.js";
import { ClaudeProvider } from "./agents/providers/claude.js";
import { buildProviderChain } from "./agents/providers/provider-registry.js";
import { Orchestrator } from "./agents/orchestrator.js";
import { MetricsCollector } from "./dashboard/metrics.js";
import { DashboardServer } from "./dashboard/server.js";
import { TelegramChannel } from "./channels/telegram/bot.js";
import { CLIChannel } from "./channels/cli/repl.js";
import { FileReadTool } from "./agents/tools/file-read.js";
import { FileWriteTool } from "./agents/tools/file-write.js";
import { FileEditTool } from "./agents/tools/file-edit.js";
import { GlobSearchTool, GrepSearchTool, ListDirectoryTool } from "./agents/tools/search.js";
import { AnalyzeProjectTool } from "./agents/tools/strata/analyze-project.js";
import { ModuleCreateTool } from "./agents/tools/strata/module-create.js";
import { ComponentCreateTool } from "./agents/tools/strata/component-create.js";
import { MediatorCreateTool } from "./agents/tools/strata/mediator-create.js";
import { SystemCreateTool } from "./agents/tools/strata/system-create.js";
import { FileMemoryManager } from "./memory/file-memory-manager.js";
import { MemorySearchTool } from "./agents/tools/memory-search.js";
import { PluginLoader } from "./agents/plugins/plugin-loader.js";
import { WhatsAppChannel } from "./channels/whatsapp/client.js";
import { Daemon } from "./gateway/daemon.js";
import type { IChannelAdapter } from "./channels/channel.interface.js";
import type { ITool } from "./agents/tools/tool.interface.js";
import type { IMemoryManager } from "./memory/memory.interface.js";
import type { IAIProvider } from "./agents/providers/provider.interface.js";
import { RAGPipeline } from "./rag/rag-pipeline.js";
import { FileVectorStore } from "./rag/vector-store.js";
import { OpenAIEmbeddingProvider } from "./rag/embeddings/openai-embeddings.js";
import { OllamaEmbeddingProvider } from "./rag/embeddings/ollama-embeddings.js";
import { CachedEmbeddingProvider } from "./rag/embeddings/embedding-cache.js";
import { CodeSearchTool } from "./agents/tools/code-search.js";
import { RAGIndexTool } from "./agents/tools/rag-index.js";
import { CodeQualityTool } from "./agents/tools/code-quality.js";
import { ShellExecTool } from "./agents/tools/shell-exec.js";
import { GitStatusTool, GitDiffTool, GitLogTool, GitCommitTool, GitBranchTool, GitPushTool, GitStashTool } from "./agents/tools/git-tools.js";
import { DotnetBuildTool, DotnetTestTool } from "./agents/tools/dotnet-tools.js";
import { FileDeleteTool, FileRenameTool, FileDeleteDirectoryTool } from "./agents/tools/file-manage.js";
import type { IRAGPipeline } from "./rag/rag.interface.js";
import type { IEmbeddingProvider } from "./rag/rag.interface.js";
import { RateLimiter } from "./security/rate-limiter.js";
import { join } from "node:path";

const program = new Command();

program
  .name("strata-brain")
  .description("AI-powered Unity development assistant for Strata.Core projects")
  .version("0.1.0");

program
  .command("start")
  .description("Start Strata Brain")
  .option("--channel <type>", "Channel to use: telegram, whatsapp, or cli", "telegram")
  .action(async (opts: { channel: string }) => {
    await startBrain(opts.channel);
  });

program
  .command("cli")
  .description("Start Strata Brain in CLI mode (for local testing)")
  .action(async () => {
    await startBrain("cli");
  });

program
  .command("daemon")
  .description("Run Strata Brain as an always-on daemon with auto-restart")
  .option("--channel <type>", "Channel to use: telegram, whatsapp, or cli", "telegram")
  .action(async (opts: { channel: string }) => {
    const config = loadConfig();
    const logger = createLogger(config.logLevel, config.logFile);
    logger.info("Starting Strata Brain in daemon mode");

    const daemon = new Daemon({
      args: ["start", "--channel", opts.channel],
    });
    await daemon.start();
  });

program.parse();

async function startBrain(channelType: string): Promise<void> {
  // Load configuration
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.logFile);

  logger.info("Starting Strata Brain", {
    channel: channelType,
    projectPath: config.unityProjectPath,
    readOnly: config.readOnlyMode,
  });

  // Initialize security
  const allowedIds = config.allowedTelegramUserIds ?? [];
  if (channelType === "telegram" && allowedIds.length === 0) {
    logger.warn("ALLOWED_TELEGRAM_USER_IDS is empty — all Telegram users will be denied access");
  }
  const auth = new AuthManager(allowedIds);

  // Initialize AI provider(s)
  // Supports: PROVIDER_CHAIN=claude,deepseek,ollama for fallback
  // Or single provider via ANTHROPIC_API_KEY (default)
  let provider: IAIProvider;

  if (config.providerChain) {
    const names = config.providerChain.split(",").map((s) => s.trim());
    provider = buildProviderChain(names, {
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
    });
  } else {
    // Default: Claude only (backwards compatible)
    provider = new ClaudeProvider(config.anthropicApiKey);
  }
  logger.info("AI provider initialized", { name: provider.name });

  // Initialize memory manager
  let memoryManager: IMemoryManager | undefined;
  if (config.memoryEnabled) {
    const mm = new FileMemoryManager(config.memoryDbPath);
    await mm.initialize();
    memoryManager = mm;
    logger.info("Memory manager initialized", { dbPath: config.memoryDbPath });
  }

  // Initialize RAG pipeline
  let ragPipeline: IRAGPipeline | undefined;
  if (config.ragEnabled) {
    try {
      let embeddingProvider: IEmbeddingProvider;
      if (config.embeddingProvider === "ollama") {
        embeddingProvider = new OllamaEmbeddingProvider({
          model: config.embeddingModel,
          baseUrl: config.embeddingBaseUrl,
        });
      } else {
        const apiKey = config.openaiApiKey;
        if (!apiKey) {
          logger.warn("RAG disabled: OPENAI_API_KEY required for OpenAI embeddings");
        } else {
          embeddingProvider = new OpenAIEmbeddingProvider({
            apiKey,
            model: config.embeddingModel,
            baseUrl: config.embeddingBaseUrl,
          });
        }
      }

      if (embeddingProvider!) {
        const cachedProvider = new CachedEmbeddingProvider(embeddingProvider, {
          persistPath: join(config.memoryDbPath, "cache"),
        });
        await cachedProvider.initialize();

        const vectorStore = new FileVectorStore(
          join(config.memoryDbPath, "vectors"),
          cachedProvider.dimensions
        );

        const pipeline = new RAGPipeline(cachedProvider, vectorStore);
        await pipeline.initialize();
        ragPipeline = pipeline;

        logger.info("RAG pipeline initialized", {
          provider: cachedProvider.name,
          dimensions: cachedProvider.dimensions,
        });

        // Background indexing at startup
        pipeline.indexProject(config.unityProjectPath).then((stats) => {
          logger.info("Initial RAG indexing complete", stats);
        }).catch((err) => {
          logger.warn(`Initial RAG indexing failed: ${err instanceof Error ? err.message : err}`);
        });
      }
    } catch (err) {
      logger.warn(`RAG initialization failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Initialize tools
  const tools: ITool[] = [
    // File operations
    new FileReadTool(),
    new FileWriteTool(),
    new FileEditTool(),
    new GlobSearchTool(),
    new GrepSearchTool(),
    new ListDirectoryTool(),
    // Strata-specific tools
    new AnalyzeProjectTool(memoryManager),
    new ModuleCreateTool(),
    new ComponentCreateTool(),
    new MediatorCreateTool(),
    new SystemCreateTool(),
    // Code quality analysis
    new CodeQualityTool(),
    // File management
    new FileDeleteTool(),
    new FileRenameTool(),
    new FileDeleteDirectoryTool(),
    // Shell execution
    new ShellExecTool(),
    // Git operations
    new GitStatusTool(),
    new GitDiffTool(),
    new GitLogTool(),
    new GitCommitTool(),
    new GitBranchTool(),
    new GitPushTool(),
    new GitStashTool(),
    // .NET build & test
    new DotnetBuildTool(),
    new DotnetTestTool(),
  ];
  if (memoryManager) {
    tools.push(new MemorySearchTool(memoryManager));
  }
  if (ragPipeline) {
    tools.push(new CodeSearchTool(ragPipeline));
    tools.push(new RAGIndexTool(ragPipeline));
  }

  // Load plugins
  const pluginDirs = process.env["PLUGIN_DIRS"]?.split(",").map((d) => d.trim()).filter(Boolean) ?? [];
  if (pluginDirs.length > 0) {
    const pluginLoader = new PluginLoader(pluginDirs);
    const pluginTools = await pluginLoader.loadAll();
    tools.push(...pluginTools);
  }

  logger.info(`Registered ${tools.length} tools`);

  // Initialize channel
  let channel: IChannelAdapter;
  if (channelType === "cli") {
    channel = new CLIChannel();
  } else if (channelType === "whatsapp") {
    const sessionPath = process.env["WHATSAPP_SESSION_PATH"] ?? ".whatsapp-session";
    const allowedNumbers = process.env["WHATSAPP_ALLOWED_NUMBERS"]?.split(",").map((n) => n.trim()).filter(Boolean) ?? [];
    if (allowedNumbers.length === 0) {
      logger.warn("WHATSAPP_ALLOWED_NUMBERS is empty — all WhatsApp users will be denied access");
    }
    channel = new WhatsAppChannel(sessionPath, allowedNumbers);
  } else {
    if (!config.telegramBotToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is required when using Telegram channel");
    }
    channel = new TelegramChannel(config.telegramBotToken, auth);
  }

  // Initialize metrics and dashboard
  const metrics = new MetricsCollector();
  let dashboard: DashboardServer | undefined;
  if (config.dashboardEnabled) {
    dashboard = new DashboardServer(
      config.dashboardPort,
      metrics,
      () => memoryManager?.getStats()
    );
    try {
      await dashboard.start();
    } catch (err) {
      logger.warn(`Dashboard failed to start: ${err instanceof Error ? err.message : err}`);
      dashboard = undefined;
    }
  }

  // Initialize rate limiter
  let rateLimiter: RateLimiter | undefined;
  if (config.rateLimitEnabled) {
    rateLimiter = new RateLimiter({
      messagesPerMinute: config.rateLimitMessagesPerMinute,
      messagesPerHour: config.rateLimitMessagesPerHour,
      tokensPerDay: config.rateLimitTokensPerDay,
      dailyBudgetUsd: config.rateLimitDailyBudgetUsd,
      monthlyBudgetUsd: config.rateLimitMonthlyBudgetUsd,
    });
    logger.info("Rate limiter initialized", {
      messagesPerMinute: config.rateLimitMessagesPerMinute,
      dailyBudgetUsd: config.rateLimitDailyBudgetUsd,
    });
  }

  // Initialize orchestrator
  const orchestrator = new Orchestrator({
    provider,
    tools,
    channel,
    projectPath: config.unityProjectPath,
    readOnly: config.readOnlyMode,
    requireConfirmation: config.requireEditConfirmation,
    memoryManager,
    metrics,
    ragPipeline,
    rateLimiter,
    streamingEnabled: config.streamingEnabled,
  });

  // Wire message handler
  channel.onMessage(async (msg) => {
    await orchestrator.handleMessage(msg);
  });

  // Session cleanup interval (every 30 minutes)
  const cleanupInterval = setInterval(() => {
    orchestrator.cleanupSessions();
  }, 30 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.info("Shutting down Strata Brain...");
    clearInterval(cleanupInterval);
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
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Start the channel
  await channel.connect();
  logger.info("Strata Brain is running!");
}
