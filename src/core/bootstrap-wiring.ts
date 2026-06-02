/**
 * Bootstrap — Wiring and cleanup helpers
 *
 * Extracted from bootstrap.ts to reduce file size.
 * Contains message handler wiring, shutdown logic, session cleanup, and session ID generation.
 */

import { randomUUID } from "node:crypto";
import { getLogger } from "../utils/logger.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { DashboardServer } from "../dashboard/server.js";
import { ProviderManager } from "../agents/providers/provider-manager.js";
import { LearningPipeline } from "../learning/index.js";
import { LearningQueue } from "../learning/pipeline/learning-queue.js";
import { TaskPlanner } from "../agents/autonomy/task-planner.js";
import { MetricsStorage } from "../metrics/metrics-storage.js";
import { HeartbeatLoop } from "../daemon/heartbeat-loop.js";
import { NotificationRouter } from "../daemon/reporting/notification-router.js";
import { DigestReporter } from "../daemon/reporting/digest-reporter.js";
import { ChannelActivityRegistry } from "./channel-activity-registry.js";
import { AutoUpdater } from "./auto-updater.js";
import { ToolRegistry } from "./tool-registry.js";
import { SoulLoader } from "../agents/soul/index.js";
import { SESSION_CLEANUP_INTERVAL_MS } from "../common/constants.js";
import { MessageRouter, TaskStorage } from "../tasks/index.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { ChainManager } from "../learning/chains/index.js";
import type { GoalStorage } from "../goals/index.js";
import type { IdentityStateManager } from "../identity/identity-state.js";
import type { VaultRegistry } from "../vault/vault-registry.js";
import type { ProviderHealthRegistry } from "../agents/providers/provider-health.js";
import type { IEventBus, LearningEventMap } from "./event-bus.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type { IRAGPipeline } from "../rag/rag.interface.js";
import type { AgentManager as AgentManagerType } from "../agents/multi/agent-manager.js";
import type { DelegationManager as DelegationManagerType } from "../agents/multi/delegation/delegation-manager.js";
import { transcribeIncomingAudioMessage } from "./incoming-audio-transcription.js";

export function wireMessageHandler(
  channel: IChannelAdapter,
  messageRouter: MessageRouter,
  orchestrator: Orchestrator,
  taskPlanner: TaskPlanner,
  learningPipeline: LearningPipeline | undefined,
  projectPath: string,
  identityManager?: IdentityStateManager,
  heartbeatLoopRef?: HeartbeatLoop,
  activityRegistryRef?: ChannelActivityRegistry,
  channelTypeName?: string,
): void {
  channel.onMessage(async (msg) => {
    const audioResult = await transcribeIncomingAudioMessage(msg, projectPath);
    if (audioResult.shouldDrop) {
      if (audioResult.userWarning) {
        await channel.sendText(msg.chatId, audioResult.userWarning);
      }
      return;
    }
    const normalizedMsg = audioResult.message;

    if (activityRegistryRef && channelTypeName) {
      activityRegistryRef.recordActivity(channelTypeName, normalizedMsg.chatId);
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
        sessionId: normalizedMsg.chatId ?? generateSessionId(),
        chatId: normalizedMsg.chatId,
        taskDescription: normalizedMsg.text.slice(0, 200),
        learningPipeline,
      });
      taskRunId = taskPlanner.getTaskRunId() ?? undefined;
    }

    let routeError: unknown;
    await orchestrator.withTaskExecutionContext(
      {
        chatId: normalizedMsg.chatId,
        conversationId: normalizedMsg.conversationId,
        userId: normalizedMsg.userId,
        taskRunId,
      },
      async () => {
        try {
          // Route through the message router (handles commands and task submission)
          await messageRouter.route(normalizedMsg);
        } catch (error) {
          routeError = error;
          throw error;
        } finally {
          // End task tracking
          if (taskPlanner?.isActive()) {
            taskPlanner.attachReplayContext(
              await orchestrator.buildTrajectoryReplayContext({
                chatId: normalizedMsg.chatId,
                userId: normalizedMsg.userId,
                conversationId: normalizedMsg.conversationId,
                channelType: normalizedMsg.channelType,
                sinceTimestamp: taskPlanner.getTaskStartedAt() ?? undefined,
                taskRunId,
              }),
            );
            taskPlanner.endTask({
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
}

export function setupCleanup(orchestrator: Orchestrator): ReturnType<typeof setInterval> {
  return setInterval(() => {
    orchestrator.cleanupSessions();
  }, SESSION_CLEANUP_INTERVAL_MS);
}

export interface ShutdownOptions {
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
  toolRegistry?: ToolRegistry;
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
  taskManager?: TaskManager;
  /** Persistent task checkpoint store — closed on shutdown to release SQLite fd. */
  checkpointStore?: { close(): void };
  /** Canvas storage for dashboard — closed on shutdown to release SQLite fd. */
  canvasStorage?: { close(): void };
  /** Learning storage — closed on shutdown to release SQLite fd. */
  learningStorage?: { close(): void };
  /** Message router — disposed on shutdown to clear pending batches and timers. */
  messageRouter?: MessageRouter;
  /** Vault registry — disposes all vaults on shutdown to release SQLite fds and stop watchers. */
  vaultRegistry?: VaultRegistry;
  /** Background executor — shuts down to clear queue and release workspace leases. */
  backgroundExecutor?: { shutdown(): Promise<void> };
  /** Provider health registry — persisted on shutdown to survive restarts. */
  providerHealthRegistry?: ProviderHealthRegistry;
  /** Path to persist provider health registry state across restarts. */
  providerHealthPersistencePath?: string;
  /** Shared daemon storage (daemon.db) — closed late on shutdown to release the SQLite fd/WAL. */
  daemonStorage?: { close(): void };
  /** Framework knowledge store (SQLite) — closed on shutdown to release the fd. */
  frameworkStore?: { close(): void };
  /** Framework sync pipeline — stopped on shutdown to close the chokidar watcher and clear its debounce timer. */
  frameworkSyncPipeline?: { stop(): Promise<void> | void };
}

function failIncompleteTasksInStorage(
  taskStorage: Pick<TaskStorage, "loadIncomplete" | "updateError">,
  reason: string,
): void {
  const logger = getLogger();
  const activeTasks = taskStorage.loadIncomplete();
  if (activeTasks.length === 0) {
    return;
  }

  logger.info("Persisting shutdown failure state for active tasks", { count: activeTasks.length });
  for (const task of activeTasks) {
    taskStorage.updateError(task.id, reason);
    logger.warn("Task marked as failed in storage on shutdown", {
      taskId: task.id,
      previousStatus: task.status,
    });
  }
}

export function createShutdownHandler(options: ShutdownOptions): () => Promise<void> {
  const { dashboard, ragPipeline, memoryManager, channel, cleanupInterval, learningPipeline } =
    options;
  const logger = getLogger();
  const shutdownTaskReason = "Task interrupted by system shutdown. Resume is available after restart.";

  // Idempotency: a second invocation must not re-run close()/stop()/disconnect()
  // (better-sqlite3 .close(), channel.disconnect(), memoryManager.shutdown()
  // throw or error on a double call). Cache the in-flight/completed promise.
  let shutdownPromise: Promise<void> | undefined;

  // Run a single disposal step in isolation: a throwing/rejecting collaborator
  // is logged and swallowed so it cannot abort the remaining cleanup (which
  // would leak SQLite fds/sockets and skip channel.disconnect).
  const runStep = async (name: string, step: () => unknown): Promise<void> => {
    try {
      await step();
    } catch (err) {
      logger.warn("Shutdown step failed (continuing)", {
        step: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const run = async (): Promise<void> => {
    const SHUTDOWN_TIMEOUT_MS = 60_000;

    const gracefulShutdown = async (): Promise<void> => {
      logger.info("Shutting down Strada Brain...");

      await runStep("cleanupInterval", () => clearInterval(cleanupInterval));

      // Dispose message router (clears pending batches and timers)
      if (options.messageRouter) {
        await runStep("messageRouter", () => options.messageRouter!.dispose());
      }

      // Stop auto-updater timers
      if (options.autoUpdater) {
        await runStep("autoUpdater", () => options.autoUpdater!.shutdown());
      }

      // Stop soul file watchers
      if (options.soulLoader) {
        await runStep("soulLoader", () => options.soulLoader!.shutdown());
      }

      // Stop reporting before heartbeat loop
      if (options.digestReporter) {
        await runStep("digestReporter", () => options.digestReporter!.stop());
      }
      if (options.notificationRouter) {
        await runStep("notificationRouter", () => options.notificationRouter!.stop());
      }

      // Shut down delegation manager before multi-agent system
      if (options.delegationManager) {
        await runStep("delegationManager", () => options.delegationManager!.shutdown());
      }

      // Shut down multi-agent system before heartbeat loop
      if (options.agentManager) {
        await runStep("agentManager", () => options.agentManager!.shutdown());
      }

      // Stop heartbeat loop before draining events
      if (options.heartbeatLoop) {
        await runStep("heartbeatLoop", () => options.heartbeatLoop!.stop());
      }

      // Stop chain detection timer before draining events
      if (options.chainManager) {
        await runStep("chainManager", () => options.chainManager!.stop());
      }

      // Shut down background executor before failing tasks
      if (options.backgroundExecutor) {
        await runStep("backgroundExecutor", () => options.backgroundExecutor!.shutdown());
      }

      if (options.taskManager) {
        await runStep("taskManager", () =>
          options.taskManager!.failActiveTasksOnShutdown(shutdownTaskReason),
        );
      }
      if (!options.taskManager && options.taskStorage) {
        await runStep("failIncompleteTasks", () =>
          failIncompleteTasksInStorage(options.taskStorage!, shutdownTaskReason),
        );
      }

      // Stop event-bus subscribers (workspace/monitor bridges live in
      // stoppableServers) BEFORE eventBus.shutdown() clears the emitter, so
      // their drain does not run against an already-removed listener set.
      if (options.stoppableServers) {
        await runStep("stoppableServers", () =>
          Promise.all(options.stoppableServers!.map((s) => s.stop())),
        );
      }

      // Drain event bus and learning queue before stopping pipeline
      if (options.eventBus) {
        await runStep("eventBus", () => options.eventBus!.shutdown());
      }
      if (options.learningQueue) {
        await runStep("learningQueue", () => options.learningQueue!.shutdown());
      }

      // Then stop the pipeline (clears evolution timer, shuts down embedding queue)
      if (learningPipeline) {
        await runStep("learningPipeline", () => learningPipeline.stop());
      }

      if (options.metricsStorage) {
        await runStep("metricsStorage", () => options.metricsStorage!.close());
      }

      if (options.goalStorage) {
        await runStep("goalStorage", () => options.goalStorage!.close());
      }

      if (options.taskStorage) {
        await runStep("taskStorage", () => options.taskStorage!.close());
      }

      if (options.providerManager) {
        await runStep("providerManager", () => options.providerManager!.shutdown());
      }

      await runStep("toolRegistry", () => options.toolRegistry?.shutdown());

      if (options.modelIntelligence) {
        await runStep("modelIntelligence", () => options.modelIntelligence!.shutdown());
      }

      if (dashboard) {
        await runStep("dashboard", () => dashboard.stop());
      }

      if (ragPipeline) {
        await runStep("ragPipeline", () => ragPipeline.shutdown());
      }

      if (memoryManager) {
        await runStep("memoryManager", () => memoryManager.shutdown());
      }

      // Stop framework sync watcher (chokidar + debounce timer) and close its
      // SQLite store — these are opened on the success path and otherwise leak.
      if (options.frameworkSyncPipeline) {
        await runStep("frameworkSyncPipeline", () => options.frameworkSyncPipeline!.stop());
      }
      if (options.frameworkStore) {
        await runStep("frameworkStore", () => options.frameworkStore!.close());
      }

      // Dispose all vaults (stops watchers and closes SQLite stores)
      if (options.vaultRegistry) {
        await runStep("vaultRegistry", () => options.vaultRegistry!.disposeAll());
      }

      // Close canvas storage to release SQLite fd
      if (options.canvasStorage) {
        await runStep("canvasStorage", () => options.canvasStorage!.close());
      }

      // Identity shutdown: record clean shutdown and flush uptime (before DB closes)
      if (options.uptimeInterval) {
        await runStep("uptimeInterval", () => clearInterval(options.uptimeInterval!));
      }
      if (options.identityManager) {
        await runStep("identityManager", () => {
          options.identityManager!.recordShutdown();
          options.identityManager!.close();
        });
      }

      if (options.checkpointStore) {
        await runStep("checkpointStore", () => options.checkpointStore!.close());
      }

      if (options.learningStorage) {
        await runStep("learningStorage", () => options.learningStorage!.close());
      }

      // Persist provider health state so cooldowns survive restarts
      if (options.providerHealthRegistry && options.providerHealthPersistencePath) {
        await runStep("providerHealthRegistry", () =>
          options.providerHealthRegistry!.save(options.providerHealthPersistencePath!),
        );
      }

      // Close shared daemon storage (daemon.db) last — it is opened
      // unconditionally and kept alive for the daemon's lifetime, so it must be
      // released on a clean shutdown (not just the failure path) to avoid
      // leaking the fd/WAL across restarts.
      if (options.daemonStorage) {
        await runStep("daemonStorage", () => options.daemonStorage!.close());
      }

      await runStep("channel", () => channel.disconnect());
      logger.info("Strada Brain stopped.");
    };

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        gracefulShutdown(),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("Shutdown timeout exceeded")),
            SHUTDOWN_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      if (err instanceof Error && err.message === "Shutdown timeout exceeded") {
        logger.error("Forced shutdown: graceful shutdown took longer than 60s; pending I/O may be interrupted");
        process.exit(1);
      }
      throw err;
    } finally {
      // Clear the losing branch of the race so its 60s timer cannot keep the
      // Node event loop alive after a successful shutdown.
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  };

  return (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = run();
    }
    return shutdownPromise;
  };
}

/**
 * Tracks resources allocated during bootstrap so a mid-bootstrap failure can
 * tear them down (release SQLite fds, clear timers, stop servers/ports) instead
 * of leaking them. This is the failure-path analogue of {@link createShutdownHandler}:
 * `bootstrap()` registers a disposer immediately after each resource is created,
 * and if any later step throws the wrapper runs {@link teardown} before rethrowing.
 *
 * Disposers run in reverse (LIFO) registration order — newest resource first —
 * mirroring conventional teardown. Each disposer is isolated in its own
 * try/catch so one failure cannot strand the rest, and `teardown()` is idempotent
 * (it snapshots-and-clears the list) so it can never double-dispose. On the
 * success path nothing is torn down here; the returned `shutdown` handler owns
 * the full lifecycle as before.
 */
export class BootstrapDisposables {
  private readonly disposers: Array<{ name: string; dispose: () => void | Promise<void> }> = [];

  /** Register a teardown callback. Call immediately after the resource is allocated. */
  push(name: string, dispose: () => void | Promise<void>): void {
    this.disposers.push({ name, dispose });
  }

  /** Number of registered disposers (observability / tests). */
  get size(): number {
    return this.disposers.length;
  }

  /**
   * Run all registered disposers in reverse (LIFO) order. Each runs in its own
   * try/catch; a throwing disposer is logged and does not abort the remaining
   * teardown. Snapshots-and-clears the list first, so repeated calls are no-ops.
   */
  async teardown(): Promise<void> {
    // Snapshot + clear up-front so a re-entrant call cannot double-dispose.
    const pending = this.disposers.splice(0).reverse();
    if (pending.length === 0) {
      return;
    }
    const logger = getLogger();
    logger.warn("Bootstrap failed mid-initialization — tearing down allocated resources", {
      count: pending.length,
    });
    for (const { name, dispose } of pending) {
      try {
        await dispose();
      } catch (err) {
        logger.warn("Bootstrap cleanup failed for a resource (continuing)", {
          resource: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

export function generateSessionId(): string {
  return `${randomUUID()}`;
}
