#!/usr/bin/env node
/**
 * Strata Brain - AI-powered Unity development assistant
 * 
 * Entry point for the application.
 * All initialization logic has been moved to bootstrap.ts
 */

import { Command } from "commander";
import { loadConfig } from "./config/config.js";
import { createLogger } from "./utils/logger.js";
import { Daemon } from "./gateway/daemon.js";
import { bootstrap } from "./core/bootstrap.js";
import { createContainer } from "./core/di-container.js";
import { AppError, setupGlobalErrorHandlers } from "./common/errors.js";
import { CHANNEL_DEFAULTS, type SupportedChannelType } from "./common/constants.js";

// Setup global error handlers
setupGlobalErrorHandlers(
  (error) => {
    const logger = createLogger("error", "strata-brain-error.log");
    logger.error("Fatal error", { error: error.message, stack: error.stack });
  },
  () => {
    // Cleanup will be handled by the bootstrap shutdown
  }
);

// CLI Setup
const program = new Command();

program
  .name("strata-brain")
  .description("AI-powered Unity development assistant for Strada.Core projects")
  .version("0.1.0");

program
  .command("start")
  .description("Start Strata Brain")
  .option(
    "--channel <type>",
    `Channel to use: ${CHANNEL_DEFAULTS.SUPPORTED_TYPES.join(", ")}`,
    CHANNEL_DEFAULTS.DEFAULT_TYPE
  )
  .action(async (opts: { channel: string }) => {
    await startApp(opts.channel);
  });

program
  .command("cli")
  .description("Start Strata Brain in CLI mode (for local testing)")
  .action(async () => {
    await startApp("cli");
  });

program
  .command("daemon")
  .description("Run Strata Brain as an always-on daemon with auto-restart")
  .option(
    "--channel <type>",
    `Channel to use: ${CHANNEL_DEFAULTS.SUPPORTED_TYPES.join(", ")}`,
    CHANNEL_DEFAULTS.DEFAULT_TYPE
  )
  .action(async (opts: { channel: string }) => {
    const config = loadConfig();
    const logger = createLogger(config.logLevel, config.logFile);
    logger.info("Starting Strata Brain in daemon mode");

    const daemon = new Daemon({
      args: ["start", "--channel", opts.channel],
    });
    await daemon.start();
  });

// Run CLI
program.parse();

// ============================================================================
// Application Startup
// ============================================================================

async function startApp(channelType: string): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.logFile);

  try {
    // Validate channel type
    if (!isValidChannelType(channelType)) {
      throw new AppError(
        `Invalid channel type: ${channelType}. Supported: ${CHANNEL_DEFAULTS.SUPPORTED_TYPES.join(", ")}`,
        "INVALID_CHANNEL_TYPE",
        400
      );
    }

    // Create DI container
    const container = createContainer();

    // Bootstrap the application
    const app = await bootstrap({
      channelType,
      config,
      container,
    });
    
    // Register container services after bootstrap creates them
    container.registerInstance("Logger", logger);
    container.registerInstance("Config", config);

    // Setup graceful shutdown
    setupShutdownHandlers(app.shutdown);

    // Keep process alive
    await new Promise(() => {
      // Process will stay alive until shutdown
    });
  } catch (error) {
    if (error instanceof AppError) {
      logger.error("Failed to start application", {
        code: error.code,
        message: error.message,
        context: error.context,
      });
    } else {
      logger.error("Unexpected error during startup", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
    process.exit(1);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isValidChannelType(type: string): type is SupportedChannelType {
  return (CHANNEL_DEFAULTS.SUPPORTED_TYPES as readonly string[]).includes(type);
}

function setupShutdownHandlers(shutdown: () => Promise<void>): void {
  let isShuttingDown = false;

  const handleShutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      console.log("Force shutdown...");
      process.exit(1);
    }
    isShuttingDown = true;

    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    
    try {
      await shutdown();
      console.log("Shutdown complete.");
      process.exit(0);
    } catch (error) {
      console.error("Error during shutdown:", error);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
  process.on("SIGINT", () => void handleShutdown("SIGINT"));
  
  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    void handleShutdown("uncaughtException");
  });
  
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
    void handleShutdown("unhandledRejection");
  });
}
