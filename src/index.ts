#!/usr/bin/env node
/**
 * Strata Brain - AI-powered Unity development assistant
 *
 * Entry point for the application.
 * All initialization logic has been moved to bootstrap.ts
 */

import { Command } from "commander";
import * as dotenv from "dotenv";
import { loadConfig, loadConfigSafe, resetConfigCache } from "./config/config.js";
import { createLogger } from "./utils/logger.js";
import { Daemon } from "./gateway/daemon.js";
import { bootstrap } from "./core/bootstrap.js";
import { createContainer } from "./core/di-container.js";
import { SetupWizard } from "./core/setup-wizard.js";
import { AppError, setupGlobalErrorHandlers } from "./common/errors.js";
import { CHANNEL_DEFAULTS, type SupportedChannelType } from "./common/constants.js";
import { runMetricsCommand } from "./metrics/metrics-cli.js";
import { registerDaemonCommands } from "./daemon/daemon-cli.js";

// Setup global error handlers
setupGlobalErrorHandlers(
  (error) => {
    const logger = createLogger("error", "strata-brain-error.log");
    logger.error("Fatal error", { error: error.message, stack: error.stack });
  },
  () => {
    // Cleanup will be handled by the bootstrap shutdown
  },
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
    CHANNEL_DEFAULTS.DEFAULT_TYPE,
  )
  .option("--daemon", "Enable daemon heartbeat mode", false)
  .action(async (opts: { channel: string; daemon: boolean }) => {
    await startApp(opts.channel, opts.daemon);
  });

program
  .command("cli")
  .description("Start Strata Brain in CLI mode (for local testing)")
  .action(async () => {
    await startApp("cli");
  });

program
  .command("supervise")
  .description("Run Strata Brain as an always-on supervisor with auto-restart")
  .option(
    "--channel <type>",
    `Channel to use: ${CHANNEL_DEFAULTS.SUPPORTED_TYPES.join(", ")}`,
    CHANNEL_DEFAULTS.DEFAULT_TYPE,
  )
  .action(async (opts: { channel: string }) => {
    const config = loadConfig();
    const logger = createLogger(config.logLevel, config.logFile);
    logger.info("Starting Strata Brain in supervisor mode");

    const daemon = new Daemon({
      args: ["start", "--channel", opts.channel],
    });
    await daemon.start();
  });

program
  .command("metrics")
  .description("Show agent performance metrics")
  .option("--json", "Output as JSON")
  .option("--session <id>", "Filter by session/chat ID")
  .option("--since <duration>", "Time window (e.g., 1d, 7d, 1h)")
  .action((opts: { json?: boolean; session?: string; since?: string }) => {
    runMetricsCommand(opts);
  });

program
  .command("cross-session")
  .description("Show cross-session learning statistics")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { crossSessionCommand } = await import("./metrics/metrics-cli.js");
    crossSessionCommand(opts);
  });

// Register daemon management commands (status, trigger, reset, audit, config, budget)
// Context is provided via callback since daemon may not be initialized at registration time
let appResult: import("./core/bootstrap.js").BootstrapResult | undefined;
registerDaemonCommands(program, () => appResult?.daemonContext);

// Run CLI
program.parse();

// ============================================================================
// Application Startup
// ============================================================================

async function startApp(channelType: string, daemonMode = false): Promise<void> {
  const MAX_WIZARD_ATTEMPTS = 3;

  // Try loading config — if invalid and using web channel, launch setup wizard
  let configResult = loadConfigSafe();
  if (configResult.kind === "err") {
    if (channelType === "web") {
      for (let attempt = 1; attempt <= MAX_WIZARD_ATTEMPTS; attempt++) {
        console.log(
          attempt === 1
            ? "Configuration missing or invalid. Starting setup wizard..."
            : `Configuration still invalid. Retrying setup wizard (attempt ${attempt}/${MAX_WIZARD_ATTEMPTS})...`,
        );
        console.log("Open http://localhost:3000 in your browser to configure.");
        const wizard = new SetupWizard({ port: 3000 });
        await wizard.start();
        console.log("Setup complete! Validating configuration...");
        // Reload .env into process.env and reset config cache
        dotenv.config({ override: true });
        resetConfigCache();
        configResult = loadConfigSafe();
        if (configResult.kind === "ok") break;
        console.error(`Configuration invalid: ${configResult.error}`);
      }
      if (configResult.kind === "err") {
        console.error(
          `Configuration still invalid after ${MAX_WIZARD_ATTEMPTS} attempts: ${configResult.error}`,
        );
        process.exit(1);
      }
    } else {
      console.error(`Configuration error: ${configResult.error}`);
      process.exit(1);
    }
  }

  const config = configResult.value;
  const logger = createLogger(config.logLevel, config.logFile);

  try {
    // Validate channel type
    if (!isValidChannelType(channelType)) {
      throw new AppError(
        `Invalid channel type: ${channelType}. Supported: ${CHANNEL_DEFAULTS.SUPPORTED_TYPES.join(", ")}`,
        "INVALID_CHANNEL_TYPE",
        400,
      );
    }

    // Create DI container
    const container = createContainer();

    // Bootstrap the application
    const app = await bootstrap({
      channelType,
      config,
      container,
      daemonMode,
    });

    // Store bootstrap result for daemon CLI context access
    appResult = app;

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
