import { Command } from "commander";
import { loadConfig } from "./config/config.js";
import { createLogger } from "./utils/logger.js";
import { AuthManager } from "./security/auth.js";
import { ClaudeProvider } from "./agents/providers/claude.js";
import { Orchestrator } from "./agents/orchestrator.js";
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
import type { IChannelAdapter } from "./channels/channel.interface.js";
import type { ITool } from "./agents/tools/tool.interface.js";

const program = new Command();

program
  .name("strata-brain")
  .description("AI-powered Unity development assistant for Strata.Core projects")
  .version("0.1.0");

program
  .command("start")
  .description("Start Strata Brain daemon")
  .option("--channel <type>", "Channel to use: telegram or cli", "telegram")
  .action(async (opts: { channel: string }) => {
    await startBrain(opts.channel);
  });

program
  .command("cli")
  .description("Start Strata Brain in CLI mode (for local testing)")
  .action(async () => {
    await startBrain("cli");
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

  // Initialize AI provider
  const provider = new ClaudeProvider(config.anthropicApiKey);
  logger.info("Claude AI provider initialized");

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
    new AnalyzeProjectTool(),
    new ModuleCreateTool(),
    new ComponentCreateTool(),
    new MediatorCreateTool(),
  ];
  logger.info(`Registered ${tools.length} tools`);

  // Initialize channel
  let channel: IChannelAdapter;
  if (channelType === "cli") {
    channel = new CLIChannel();
  } else {
    if (!config.telegramBotToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is required when using Telegram channel");
    }
    channel = new TelegramChannel(config.telegramBotToken, auth);
  }

  // Initialize orchestrator
  const orchestrator = new Orchestrator({
    provider,
    tools,
    channel,
    projectPath: config.unityProjectPath,
    readOnly: config.readOnlyMode,
    requireConfirmation: config.requireEditConfirmation,
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
