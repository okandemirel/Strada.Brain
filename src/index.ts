#!/usr/bin/env node
/**
 * Strada Brain - AI-powered Unity development assistant
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
import { shouldEnableDaemonMode } from "./core/daemon-mode.js";
import { SetupWizard } from "./core/setup-wizard.js";
import { AppError, setupGlobalErrorHandlers } from "./common/errors.js";
import { initializeRuntimeEnvironment } from "./common/runtime-paths.js";
import { CHANNEL_DEFAULTS, type SupportedChannelType } from "./common/constants.js";
import { runMetricsCommand } from "./metrics/metrics-cli.js";
import { registerDaemonCommands } from "./daemon/daemon-cli.js";
import { registerPresetCommands } from "./config/preset-cli.js";
import {
  getConfiguredDefaultChannel,
  promptLauncherAction,
  resolveQuickLaunchAction,
  type RootLaunchOptions,
} from "./core/launcher.js";

// Setup global error handlers
initializeRuntimeEnvironment({ moduleUrl: import.meta.url });

setupGlobalErrorHandlers(
  (error) => {
    const logger = createLogger("error", "strada-brain-error.log");
    logger.error("Fatal error", { error: error.message, stack: error.stack });
  },
  () => {
    // Cleanup will be handled by the bootstrap shutdown
  },
);

// CLI Setup
const program = new Command();
program.enablePositionalOptions();

program
  .name("strada")
  .description("AI-powered Unity development assistant for Strada.Core projects")
  .version("0.1.0");

program
  .option("--daemon", "Run the selected launch target in daemon mode")
  .option("--web", "Open or resume Strada through the local web channel")
  .option("--terminal", "Open Strada in the terminal (or use terminal setup if not configured)")
  .option("--cli", "Open Strada in the interactive CLI")
  .option("--telegram", "Start the Telegram channel directly")
  .option("--discord", "Start the Discord channel directly")
  .option("--slack", "Start the Slack channel directly")
  .option("--whatsapp", "Start the WhatsApp channel directly")
  .option("--matrix", "Start the Matrix channel directly")
  .option("--irc", "Start the IRC channel directly")
  .option("--teams", "Start the Teams channel directly")
  .command("start")
  .description("Start Strada Brain")
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
  .description("Start Strada Brain in CLI mode (for local testing)")
  .action(async () => {
    await startApp("cli");
  });

program
  .command("supervise")
  .description("Run Strada Brain as an always-on supervisor with auto-restart")
  .option(
    "--channel <type>",
    `Channel to use: ${CHANNEL_DEFAULTS.SUPPORTED_TYPES.join(", ")}`,
    CHANNEL_DEFAULTS.DEFAULT_TYPE,
  )
  .action(async (opts: { channel: string }) => {
    const config = loadConfig();
    const logger = createLogger(config.logLevel, config.logFile);
    logger.info("Starting Strada Brain in supervisor mode");

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

program
  .command("sync")
  .description("Validate and sync Brain's Strada.Core API knowledge against source")
  .requiredOption("--core-path <path>", "Path to Strada.Core source directory")
  .option("--dry-run", "Show drift report without applying changes", false)
  .option("--apply", "Apply auto-generated API updates", false)
  .option("--json", "Output the drift report as JSON", false)
  .option("--max-drift-score <score>", "Fail if drift score exceeds this integer threshold")
  .option("--fail-on-warnings", "Fail if any drift warnings are detected", false)
  .action(async (opts: {
    corePath: string;
    dryRun: boolean;
    apply: boolean;
    json?: boolean;
    maxDriftScore?: string;
    failOnWarnings?: boolean;
  }) => {
    const { runSyncCommand } = await import("./intelligence/strada-api-sync.js");
    await runSyncCommand({
      corePath: opts.corePath,
      dryRun: opts.dryRun,
      apply: opts.apply,
      json: opts.json,
      maxDriftScore:
        opts.maxDriftScore !== undefined ? Number.parseInt(opts.maxDriftScore, 10) : undefined,
      failOnWarnings: opts.failOnWarnings,
    });
  });

program
  .command("setup")
  .description("Interactive setup wizard for first-time configuration")
  .option("--web", "Launch the browser wizard directly", false)
  .option("--terminal", "Use the terminal wizard directly", false)
  .action(async (opts: { web?: boolean; terminal?: boolean }) => {
    if (opts.web && opts.terminal) {
      console.error("Choose either --web or --terminal, not both.");
      process.exit(1);
    }
    const { runTerminalWizard } = await import("./core/terminal-wizard.js");
    await runTerminalWizard({
      mode: opts.web ? "web" : opts.terminal ? "terminal" : undefined,
    });
  });

program
  .command("doctor")
  .description("Check install, build, config, and embedding readiness")
  .action(async () => {
    const { runDoctorCommand } = await import("./core/setup-doctor.js");
    const exitCode = await runDoctorCommand();
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  });

program
  .command("update")
  .description("Check for and apply updates")
  .option("--check", "Only check for updates, do not apply")
  .action(async (opts) => {
    const { AutoUpdater } = await import("./core/auto-updater.js");
    const { ChannelActivityRegistry } = await import("./core/channel-activity-registry.js");

    const configResult = loadConfigSafe();
    const autoUpdateConfig = configResult.kind === "ok"
      ? { autoUpdate: configResult.value.autoUpdate }
      : { autoUpdate: { enabled: true, intervalHours: 24, idleTimeoutMin: 5, channel: "stable" as const, notify: false, autoRestart: false } };

    const updater = new AutoUpdater(autoUpdateConfig, new ChannelActivityRegistry(), { hasRunningTasks: () => false });
    const result = await updater.checkForUpdate();

    if (!result.available) {
      console.log(`✅ Strada Brain is up to date (v${result.currentVersion}).`);
      return;
    }

    console.log(`🔄 Update available: v${result.currentVersion} → v${result.latestVersion}`);
    if (opts.check) return;

    console.log("Updating...");
    try {
      await updater.performUpdate();
      console.log("✅ Updated successfully! Please restart with `strada start`.");
    } catch (err) {
      console.error(`❌ Update failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("version-info")
  .description("Show version and update status")
  .action(async () => {
    const { AutoUpdater } = await import("./core/auto-updater.js");
    const { ChannelActivityRegistry } = await import("./core/channel-activity-registry.js");

    const configResult = loadConfigSafe();
    const autoUpdateConfig = configResult.kind === "ok"
      ? { autoUpdate: configResult.value.autoUpdate }
      : { autoUpdate: { enabled: true, intervalHours: 24, idleTimeoutMin: 5, channel: "stable" as const, notify: false, autoRestart: false } };

    const updater = new AutoUpdater(autoUpdateConfig, new ChannelActivityRegistry(), { hasRunningTasks: () => false });
    const currentVersion = updater.getCurrentVersion();
    const method = updater.detectInstallMethod();

    console.log(`Strada Brain v${currentVersion}`);
    console.log(`Install method: ${method}`);
    console.log(`Update channel: ${autoUpdateConfig.autoUpdate.channel}`);

    try {
      const result = await updater.checkForUpdate();
      if (result.available) console.log(`Update available: v${result.latestVersion}`);
      else console.log("Up to date.");
    } catch {
      console.log("Could not check for updates.");
    }
  });

// Register preset management commands (list, show, set, models)
registerPresetCommands(program);

// Register daemon management commands (status, trigger, reset, audit, config, budget)
// Context is provided via callback since daemon may not be initialized at registration time
let appResult: import("./core/bootstrap.js").BootstrapResult | undefined;
registerDaemonCommands(program, () => appResult?.daemonContext);

program.action(async (opts: RootLaunchOptions) => {
  await runRootLauncher(opts);
});

// Run CLI
program.parse();

// ============================================================================
// Application Startup
// ============================================================================

async function startApp(channelType: string, daemonMode = false): Promise<void> {
  const MAX_WIZARD_ATTEMPTS = 3;
  const wizardPort = Number.parseInt(process.env["SETUP_WIZARD_PORT"] ?? "3000", 10) || 3000;
  let activeWizard: SetupWizard | null = null;

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
        console.log(`Open http://127.0.0.1:${wizardPort} in your browser to configure.`);
        const wizard = new SetupWizard({ port: wizardPort });
        await wizard.start();
        console.log("Setup complete! Validating configuration...");
        // Reload .env into process.env and reset config cache
        dotenv.config({ override: true });
        resetConfigCache();
        configResult = loadConfigSafe();
        if (configResult.kind === "ok") {
          activeWizard = wizard; // Keep wizard alive until app starts on same port
          break;
        }
        await wizard.shutdown();
        console.error(`Configuration invalid: ${configResult.error}`);
      }
      if (configResult.kind === "err") {
        console.error(
          `Configuration still invalid after ${MAX_WIZARD_ATTEMPTS} attempts: ${configResult.error}`,
        );
        process.exit(1);
      }
    } else {
      // Non-web channels: offer setup wizard as a web-based option
      console.warn(`Config invalid: ${configResult.error}. Run 'strada setup' to configure.`);
      console.log(`\nStarting setup wizard on http://127.0.0.1:${wizardPort} — open in your browser to configure.`);
      const wizard = new SetupWizard({ port: wizardPort });
      await wizard.start();
      console.log("Setup complete! Validating configuration...");
      await wizard.shutdown();
      dotenv.config({ override: true });
      resetConfigCache();
      configResult = loadConfigSafe();
      if (configResult.kind === "err") {
        console.error(`Configuration still invalid: ${configResult.error}`);
        process.exit(1);
      }
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

    // Shut down wizard server to free the port for the main app
    if (activeWizard) {
      await activeWizard.shutdown();
      activeWizard = null;
    }

    // Create DI container
    const container = createContainer();

    // Bootstrap the application
    const effectiveDaemonMode = shouldEnableDaemonMode(channelType, daemonMode);
    const app = await bootstrap({
      channelType,
      config,
      container,
      daemonMode: effectiveDaemonMode,
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

async function runRootLauncher(options: RootLaunchOptions): Promise<void> {
  const configResult = loadConfigSafe();
  if (configResult.kind === "err") {
    console.log("First-time setup is required before Strada can start.\n");
    const { runTerminalWizard } = await import("./core/terminal-wizard.js");
    await runTerminalWizard({
      mode: options.web ? "web" : options.terminal ? "terminal" : undefined,
    });
    return;
  }

  const defaultChannel = getConfiguredDefaultChannel();
  const quickAction = resolveQuickLaunchAction(options);
  if (quickAction) {
    await runLauncherAction(quickAction);
    return;
  }

  if (options.daemon) {
    await runLauncherAction({
      kind: "start",
      channelType: defaultChannel,
      daemonMode: true,
    });
    return;
  }

  const action = await promptLauncherAction({
    defaultChannel,
    webPort: configResult.value.web.port,
    dashboardPort: configResult.value.dashboard.port,
  });
  await runLauncherAction(action);
}

async function runLauncherAction(action: {
  kind: "start";
  channelType: SupportedChannelType;
  daemonMode: boolean;
} | { kind: "setup" } | { kind: "doctor" } | { kind: "exit" }): Promise<void> {
  if (action.kind === "start") {
    await startApp(action.channelType, action.daemonMode);
    return;
  }

  if (action.kind === "setup") {
    const { runTerminalWizard } = await import("./core/terminal-wizard.js");
    await runTerminalWizard();
    return;
  }

  if (action.kind === "doctor") {
    const { runDoctorCommand } = await import("./core/setup-doctor.js");
    const exitCode = await runDoctorCommand();
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
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
