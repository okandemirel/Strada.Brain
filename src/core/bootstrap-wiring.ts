/**
 * Bootstrap — Wiring and cleanup helpers
 *
 * Extracted from bootstrap.ts to reduce file size.
 * Contains message handler wiring, shutdown logic, session cleanup, and session ID generation.
 */

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

      if (options.taskManager) {
        options.taskManager.failActiveTasksOnShutdown(shutdownTaskReason);
      }
      if (!options.taskManager && options.taskStorage) {
        failIncompleteTasksInStorage(options.taskStorage, shutdownTaskReason);
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

      options.toolRegistry?.shutdown();

      if (options.modelIntelligence) {
        options.modelIntelligence.shutdown();
      }

      if (dashboard) {
        await dashboard.stop();
      }

      if (options.stoppableServers) {
        await Promise.all(options.stoppableServers.map((s) => s.stop()));
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

export function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
