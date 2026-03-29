import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type * as winston from "winston";
import type { Config } from "../../config/config.js";
import { resolveRuntimePaths } from "../../common/runtime-paths.js";
import type { IEventBus } from "../event-bus.js";
import type { DaemonEventMap } from "../../daemon/daemon-events.js";
import { IdentityStateManager } from "../../identity/identity-state.js";
import type { CrashRecoveryContext } from "../../identity/crash-recovery.js";
import { ToolRegistry } from "../tool-registry.js";
import { BackgroundExecutor, CommandHandler, TaskManager } from "../../tasks/index.js";
import { CronTrigger } from "../../daemon/triggers/cron-trigger.js";
import { FileWatchTrigger } from "../../daemon/triggers/file-watch-trigger.js";
import { ChecklistTrigger } from "../../daemon/triggers/checklist-trigger.js";
import { WebhookTrigger } from "../../daemon/triggers/webhook-trigger.js";
import { parseHeartbeatFile } from "../../daemon/heartbeat-parser.js";
import { AppError } from "../../common/errors.js";
import type { ITrigger } from "../../daemon/daemon-types.js";
import { TriggerRegistry } from "../../daemon/trigger-registry.js";
import { HeartbeatLoop } from "../../daemon/heartbeat-loop.js";
import { DaemonStorage } from "../../daemon/daemon-storage.js";
import { BudgetTracker } from "../../daemon/budget/budget-tracker.js";
import { UnifiedBudgetManager } from "../../budget/unified-budget-manager.js";
import { ApprovalQueue } from "../../daemon/security/approval-queue.js";
import { DaemonSecurityPolicy } from "../../daemon/security/daemon-security-policy.js";
import { TriggerDeduplicator } from "../../daemon/dedup/trigger-deduplicator.js";
import type {
  DaemonTriggerStageDeps,
  DaemonTriggerStageResult,
  DaemonHeartbeatStageDeps,
  DaemonHeartbeatStageResult,
} from "./bootstrap-stages-types.js";

export function loadDaemonTriggersStage(
  params: {
    daemonConfig: Config["daemon"];
    logger: winston.Logger;
    triggerRegistry: TriggerRegistry;
    projectRoot?: string;
  },
  deps: DaemonTriggerStageDeps = {},
): DaemonTriggerStageResult {
  const projectRoot = params.projectRoot ?? resolveRuntimePaths({ moduleUrl: import.meta.url }).configRoot;
  const heartbeatPath = resolve(projectRoot, params.daemonConfig.heartbeat.heartbeatFile);
  if (!heartbeatPath.startsWith(projectRoot + sep) && heartbeatPath !== projectRoot) {
    throw new AppError("HEARTBEAT file path is outside project root", "DAEMON_CONFIG_ERROR", 400);
  }

  const webhookTriggers = new Map<string, WebhookTrigger>();
  const typeCounts = new Map<string, number>();
  try {
    const content = (deps.readFile ?? readFileSync)(heartbeatPath, "utf-8");
    const triggerDefs = (deps.parseHeartbeatFile ?? parseHeartbeatFile)(content, {
      morningHour: params.daemonConfig.triggers.checklistMorningHour,
      afternoonHour: params.daemonConfig.triggers.checklistAfternoonHour,
      eveningHour: params.daemonConfig.triggers.checklistEveningHour,
    });
    for (const def of triggerDefs) {
      if (def.enabled === false) continue;
      let trigger: ITrigger;
      switch (def.type) {
        case "cron":
          trigger = deps.createCronTrigger?.(
            { name: def.name, description: def.action, type: "cron", cooldownSeconds: def.cooldown },
            def.cron,
            params.daemonConfig.timezone || undefined,
          ) ?? new CronTrigger(
            { name: def.name, description: def.action, type: "cron", cooldownSeconds: def.cooldown },
            def.cron,
            params.daemonConfig.timezone || undefined,
          );
          break;
        case "file-watch": {
          const resolvedWatchPath = resolve(projectRoot, def.path);
          if (!resolvedWatchPath.startsWith(projectRoot + sep) && resolvedWatchPath !== projectRoot) {
            params.logger.warn("File-watch path outside project root, skipping", {
              trigger: def.name,
              path: def.path,
            });
            continue;
          }
          trigger = deps.createFileWatchTrigger?.({
            ...def,
            path: resolvedWatchPath,
            debounce: def.debounce ?? params.daemonConfig.triggers.defaultDebounceMs,
          }) ?? new FileWatchTrigger({
            ...def,
            path: resolvedWatchPath,
            debounce: def.debounce ?? params.daemonConfig.triggers.defaultDebounceMs,
          });
          break;
        }
        case "checklist":
          trigger = deps.createChecklistTrigger?.(
            def,
            params.daemonConfig.timezone || undefined,
          ) ?? new ChecklistTrigger(def, params.daemonConfig.timezone || undefined);
          break;
        case "webhook": {
          const webhookTrigger = deps.createWebhookTrigger?.(def.name, def.action)
            ?? new WebhookTrigger(def.name, def.action);
          webhookTriggers.set(def.name, webhookTrigger);
          trigger = webhookTrigger;
          break;
        }
        default:
          params.logger.warn(`Unknown trigger type '${(def as { type: string }).type}', skipping`);
          continue;
      }
      params.triggerRegistry.register(trigger);
      typeCounts.set(def.type, (typeCounts.get(def.type) ?? 0) + 1);
    }

    params.logger.info("Daemon triggers loaded", {
      total: params.triggerRegistry.count(),
      byType: Object.fromEntries(typeCounts),
      file: heartbeatPath,
    });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      params.logger.warn("HEARTBEAT.md not found", { path: heartbeatPath });
    } else {
      throw err;
    }
  }

  return {
    heartbeatPath,
    webhookTriggers,
  };
}

export function initializeDaemonHeartbeatStage(
  params: {
    config: Config;
    logger: winston.Logger;
    toolRegistry: ToolRegistry;
    backgroundExecutor: BackgroundExecutor;
    taskManager: TaskManager;
    commandHandler: CommandHandler;
    daemonEventBus: IEventBus<DaemonEventMap>;
    identityManager?: IdentityStateManager;
    crashContext: CrashRecoveryContext | null;
  },
  deps: DaemonHeartbeatStageDeps = {},
): DaemonHeartbeatStageResult {
  const daemonConfig = params.config.daemon;
  const daemonDbPath = join(params.config.memory.dbPath, "daemon.db");
  const daemonStorage = deps.createDaemonStorage?.(daemonDbPath) ?? new DaemonStorage(daemonDbPath);
  daemonStorage.initialize();

  const triggerRegistry = deps.createTriggerRegistry?.() ?? new TriggerRegistry();
  const budgetTracker = deps.createBudgetTracker?.(daemonStorage, daemonConfig.budget)
    ?? new BudgetTracker(daemonStorage, daemonConfig.budget);
  params.backgroundExecutor.setDaemonBudgetTracker(budgetTracker);

  const unifiedBudgetManager = new UnifiedBudgetManager(daemonStorage, params.daemonEventBus);
  daemonStorage.migrateBudgetSource();
  params.backgroundExecutor.setUnifiedBudgetManager(unifiedBudgetManager);

  const approvalQueue = deps.createApprovalQueue?.(
    daemonStorage,
    daemonConfig.security.approvalTimeoutMin,
    params.daemonEventBus,
  ) ?? new ApprovalQueue(
    daemonStorage,
    daemonConfig.security.approvalTimeoutMin,
    params.daemonEventBus,
  );
  const securityPolicy = deps.createSecurityPolicy?.(
    (name) => params.toolRegistry.getMetadata(name),
    approvalQueue,
    new Set(daemonConfig.security.autoApproveTools),
  ) ?? new DaemonSecurityPolicy(
    (name) => params.toolRegistry.getMetadata(name),
    approvalQueue,
    new Set(daemonConfig.security.autoApproveTools),
    params.config.daemonFullAutonomy,
  );

  const { webhookTriggers } = loadDaemonTriggersStage({
    daemonConfig,
    logger: params.logger,
    triggerRegistry,
  }, deps);

  const deduplicator = deps.createTriggerDeduplicator?.(daemonConfig.triggers.dedupWindowMs)
    ?? new TriggerDeduplicator(daemonConfig.triggers.dedupWindowMs);
  const heartbeatLoop = deps.createHeartbeatLoop?.(
    triggerRegistry,
    params.taskManager,
    budgetTracker,
    securityPolicy,
    approvalQueue,
    daemonStorage,
    params.identityManager,
    params.daemonEventBus,
    daemonConfig,
    params.logger,
    deduplicator,
  ) ?? new HeartbeatLoop(
    triggerRegistry,
    params.taskManager,
    budgetTracker,
    securityPolicy,
    approvalQueue,
    daemonStorage,
    params.identityManager,
    params.daemonEventBus,
    daemonConfig,
    params.logger,
    deduplicator,
  );

  if (params.crashContext?.wasCrash) {
    const wasDaemonRunning = daemonStorage.getDaemonState("daemon_was_running");
    if (wasDaemonRunning === "true") {
      params.logger.info("Daemon auto-restarting after crash recovery");
    }
  }

  heartbeatLoop.setUnifiedBudgetManager(unifiedBudgetManager);

  heartbeatLoop.start();
  params.commandHandler.setHeartbeatLoop({
    start: () => heartbeatLoop.start(),
    stop: () => heartbeatLoop.stop(),
    isRunning: () => heartbeatLoop.isRunning(),
    getDaemonStatus: () => heartbeatLoop.getDaemonStatus(),
    getSecurityPolicy: () => securityPolicy,
  });

  return {
    daemonStorage,
    triggerRegistry,
    budgetTracker,
    approvalQueue,
    securityPolicy,
    heartbeatLoop,
    webhookTriggers,
    unifiedBudgetManager,
  };
}
