import { join } from "node:path";
import type * as winston from "winston";
import type { Config } from "../../config/config.js";
import type { IMemoryManager } from "../../memory/memory.interface.js";
import type { IChannelAdapter } from "../../channels/channel.interface.js";
import type { ProviderManager } from "../../agents/providers/provider-manager.js";
import { MetricsStorage } from "../../metrics/metrics-storage.js";
import { MetricsRecorder } from "../../metrics/metrics-recorder.js";
import { IdentityStateManager } from "../../identity/identity-state.js";
import { InstinctRetriever } from "../../agents/instinct-retriever.js";
import { TrajectoryReplayRetriever } from "../../agents/trajectory-replay-retriever.js";
import { RuntimeArtifactManager } from "../../learning/index.js";
import type { ScopeContext } from "../../learning/matching/pattern-matcher.js";
import { SoulLoader } from "../../agents/soul/index.js";
import { AgentDBAdapter } from "../../memory/unified/agentdb-adapter.js";
import { DMPolicy } from "../../security/dm-policy.js";
import { resolveRuntimePaths } from "../../common/runtime-paths.js";
import type {
  LearningResult,
  RuntimeStateStageDeps,
  RuntimeStateStageResult,
  SessionRuntimeStageDeps,
  SessionRuntimeStageResult,
  TaskRuntimeStageDeps,
  TaskRuntimeStageResult,
} from "./bootstrap-stages-types.js";
import type { Orchestrator } from "../../agents/orchestrator.js";
import type { GoalExecutorConfig } from "../../goals/index.js";
import { GoalDecomposer, GoalStorage } from "../../goals/index.js";
import type { IEventBus, LearningEventMap } from "../event-bus.js";
import { TypedEventBus } from "../event-bus.js";
import type { DaemonEventMap } from "../../daemon/daemon-events.js";
import type { ChannelActivityRegistry } from "../channel-activity-registry.js";
import { AutoUpdater } from "../auto-updater.js";
import { createProjectScopeFingerprint } from "../../learning/index.js";
import {
  BackgroundExecutor,
  CommandHandler,
  MessageRouter,
  ProgressReporter,
  TaskManager,
  TaskStorage,
} from "../../tasks/index.js";
import { WorkspaceLeaseManager } from "../../agents/multi/workspace-lease-manager.js";

export function initializeRuntimeStateStage(
  params: {
    config: Config;
    logger: winston.Logger;
    learningResult: LearningResult;
    metricsStorage?: MetricsStorage;
    metricsRecorder?: MetricsRecorder;
  },
  deps: RuntimeStateStageDeps = {},
): RuntimeStateStageResult {
  let metricsStorage = params.metricsStorage;
  let metricsRecorder = params.metricsRecorder;

  if (!metricsStorage) {
    try {
      const metricsDbPath = join(params.config.memory.dbPath, "learning.db");
      const storage = deps.createMetricsStorage?.(metricsDbPath)
        ?? new MetricsStorage(metricsDbPath);
      storage.initialize();
      metricsStorage = storage;
      metricsRecorder = deps.createMetricsRecorder?.(storage)
        ?? new MetricsRecorder(storage);
      params.logger.info("Metrics storage initialized", { dbPath: metricsDbPath });
    } catch (error) {
      params.logger.warn("Metrics storage initialization failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let identityManager: IdentityStateManager | undefined;
  let uptimeInterval: ReturnType<typeof setInterval> | undefined;
  try {
    const identityDbPath = join(params.config.memory.dbPath, "identity.db");
    identityManager = deps.createIdentityManager?.(identityDbPath, params.config.agentName)
      ?? new IdentityStateManager(identityDbPath, params.config.agentName);
    identityManager.initialize();
    identityManager.recordBoot();
    identityManager.setProjectContext(params.config.unityProjectPath);

    let lastFlushTime = Date.now();
    uptimeInterval = setInterval(() => {
      const now = Date.now();
      identityManager!.updateUptime(now - lastFlushTime);
      identityManager!.flush();
      lastFlushTime = now;
    }, 60000);

    params.logger.info("Identity initialized", {
      bootNumber: identityManager.getState().bootCount,
      wasCrash: identityManager.wasCrash(),
    });
  } catch (error) {
    params.logger.warn("Identity initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const runtimeArtifactManager = params.learningResult.pipeline?.getRuntimeArtifactManager()
    ?? (params.learningResult.storage
      ? (deps.createRuntimeArtifactManager?.(params.learningResult.storage)
        ?? new RuntimeArtifactManager(params.learningResult.storage))
      : undefined);

  let instinctRetriever: InstinctRetriever | undefined;
  let trajectoryReplayRetriever: TrajectoryReplayRetriever | undefined;
  if (params.learningResult.patternMatcher) {
    const scopeContext: ScopeContext = {
      projectPath: params.config.unityProjectPath,
      scopeFilter: params.config.crossSession.scopeFilter,
      maxAgeDays: params.config.crossSession.maxAgeDays,
      recencyBoost: params.config.crossSession.recencyBoost,
      scopeBoost: params.config.crossSession.scopeBoost,
      currentBootCount: identityManager?.getState().bootCount,
      currentSessionId: `boot-${identityManager?.getState().bootCount ?? 0}`,
    };

    instinctRetriever = deps.createInstinctRetriever?.(
      params.learningResult.patternMatcher,
      {
        scopeContext,
        storage: params.learningResult.storage,
        metricsRecorder,
      },
    ) ?? new InstinctRetriever(params.learningResult.patternMatcher, {
      scopeContext,
      storage: params.learningResult.storage,
      metricsRecorder,
    });
  }

  if (params.learningResult.storage) {
    trajectoryReplayRetriever = deps.createTrajectoryReplayRetriever?.(params.learningResult.storage)
      ?? new TrajectoryReplayRetriever(params.learningResult.storage);
  }

  if (params.learningResult.pipeline) {
    params.learningResult.pipeline.setProjectPath(params.config.unityProjectPath);
    params.learningResult.pipeline.setPromotionThreshold(params.config.crossSession.promotionThreshold);
  }

  return {
    metricsStorage,
    metricsRecorder,
    identityManager,
    uptimeInterval,
    runtimeArtifactManager,
    instinctRetriever,
    trajectoryReplayRetriever,
  };
}

export async function initializeSessionRuntimeStage(
  params: {
    config: Config;
    logger: winston.Logger;
    memoryManager?: IMemoryManager;
    providerManager: ProviderManager;
    channel: IChannelAdapter;
  },
  deps: SessionRuntimeStageDeps = {},
): Promise<SessionRuntimeStageResult> {
  const runtimePaths = resolveRuntimePaths({ moduleUrl: import.meta.url });
  const soulOverrides: Record<string, string> = {};
  for (const channel of ["telegram", "discord", "slack", "whatsapp", "web"] as const) {
    const envValue = process.env[`SOUL_FILE_${channel.toUpperCase()}`];
    if (envValue) {
      soulOverrides[channel] = envValue;
    }
  }

  const soulBasePath = runtimePaths.configRoot;
  const soulLoader = deps.createSoulLoader?.(soulBasePath, {
    soulFile: process.env.SOUL_FILE ?? "soul.md",
    channelOverrides: Object.keys(soulOverrides).length > 0 ? soulOverrides : undefined,
  }) ?? new SoulLoader(soulBasePath, {
    soulFile: process.env.SOUL_FILE ?? "soul.md",
    channelOverrides: Object.keys(soulOverrides).length > 0 ? soulOverrides : undefined,
  });
  await soulLoader.initialize();

  let sessionSummarizer: import("../../memory/unified/session-summarizer.js").SessionSummarizer | undefined;
  let userProfileStore: import("../../memory/unified/user-profile-store.js").UserProfileStore | undefined;
  let taskExecutionStore: import("../../memory/unified/task-execution-store.js").TaskExecutionStore | undefined;
  const isAgentDbAdapter = deps.isAgentDbAdapter ?? ((memoryManager: IMemoryManager): memoryManager is AgentDBAdapter =>
    memoryManager instanceof AgentDBAdapter);

  if (params.memoryManager) {
    try {
      if (isAgentDbAdapter(params.memoryManager)) {
        const profileStore = params.memoryManager.getUserProfileStore();
        const executionStore = params.memoryManager.getTaskExecutionStore();
        if (profileStore) {
          userProfileStore = profileStore;
        }
        if (executionStore) {
          taskExecutionStore = executionStore;
          sessionSummarizer = deps.createSessionSummarizer?.(
            params.providerManager.getProvider(""),
            executionStore,
          );
          if (!sessionSummarizer) {
            const { SessionSummarizer } = await import("../../memory/unified/session-summarizer.js");
            sessionSummarizer = new SessionSummarizer(params.providerManager.getProvider(""), executionStore);
          }
          params.logger.info("SessionSummarizer wired for session-end summarization");
        }
      }
    } catch {
      params.logger.debug("SessionSummarizer wiring skipped");
    }
  }

  return {
    soulLoader,
    sessionSummarizer,
    userProfileStore,
    taskExecutionStore,
    dmPolicy: deps.createDMPolicy?.(params.channel) ?? new DMPolicy(params.channel),
  };
}

export async function initializeTaskRuntimeStage(
  params: {
    daemonMode: boolean;
    config: Config;
    logger: winston.Logger;
    orchestrator: Orchestrator;
    providerManager: ProviderManager;
    channel: IChannelAdapter;
    dmPolicy: DMPolicy;
    userProfileStore?: import("../../memory/unified/user-profile-store.js").UserProfileStore;
    soulLoader: SoulLoader;
    runtimeArtifactManager?: RuntimeArtifactManager;
    activityRegistry: ChannelActivityRegistry;
    goalDecomposer?: GoalDecomposer;
    goalStorage?: GoalStorage;
    goalExecutorConfig: GoalExecutorConfig;
    learningEventBus?: IEventBus<LearningEventMap>;
    identityManager?: IdentityStateManager;
    providerRouter?: Parameters<CommandHandler["setProviderRouter"]>[0];
    startupNotices: string[];
  },
  deps: TaskRuntimeStageDeps = {},
): Promise<TaskRuntimeStageResult> {
  const daemonEventBus = params.daemonMode
    ? (deps.createDaemonEventBus?.() ?? new TypedEventBus<DaemonEventMap>())
    : undefined;

  const taskDbPath = join(params.config.memory.dbPath, "tasks.db");
  const taskStorage = deps.createTaskStorage?.(taskDbPath) ?? new TaskStorage(taskDbPath);
  taskStorage.initialize();
  params.logger.info("Task storage initialized", { dbPath: taskDbPath });

  let workspaceLeaseManager: WorkspaceLeaseManager | undefined;
  try {
    workspaceLeaseManager = new WorkspaceLeaseManager({
      projectRoot: params.config.unityProjectPath,
    });
  } catch (error) {
    params.logger.warn("Workspace isolation disabled for background executor", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const backgroundExecutorOptions: ConstructorParameters<typeof BackgroundExecutor>[0] = {
    orchestrator: params.orchestrator,
    concurrencyLimit: params.config.tasks.concurrencyLimit,
    decomposer: params.goalDecomposer,
    goalStorage: params.goalStorage,
    goalExecutorConfig: params.goalExecutorConfig,
    aiProvider: params.providerManager.getProvider(""),
    channel: params.channel,
    daemonEventBus,
    goalConfig: params.config.goal,
    learningEventBus: params.learningEventBus,
    workspaceLeaseManager,
  };
  const backgroundExecutor = deps.createBackgroundExecutor?.(backgroundExecutorOptions)
    ?? new BackgroundExecutor(backgroundExecutorOptions);
  const taskManager = deps.createTaskManager?.(taskStorage, backgroundExecutor)
    ?? new TaskManager(taskStorage, backgroundExecutor, params.goalStorage);

  backgroundExecutor.setTaskManager(taskManager);
  params.orchestrator.setTaskManager(taskManager);
  taskManager.recoverOnStartup();
  if (params.identityManager) {
    taskManager.on("task:created", () => {
      params.identityManager!.incrementTasks();
    });
  }

  let autoUpdater: AutoUpdater | undefined;
  if (params.config.autoUpdate.enabled) {
    autoUpdater = deps.createAutoUpdater?.(
      params.config,
      params.activityRegistry,
      backgroundExecutor,
    ) ?? new AutoUpdater(params.config, params.activityRegistry, backgroundExecutor);
    autoUpdater.setNotifyFn((msg: string) => {
      const chats = params.activityRegistry.getActiveChatIds();
      for (const { chatId } of chats) {
        params.channel.sendMarkdown(chatId, msg).catch(() => {});
      }
    });
    await autoUpdater.init();
    autoUpdater.scheduleChecks();
  }

  const projectScopeFingerprint = deps.createProjectScopeFingerprint?.(params.config.unityProjectPath)
    ?? createProjectScopeFingerprint(params.config.unityProjectPath);

  const commandHandler = deps.createCommandHandler?.({
    taskManager,
    channel: params.channel,
    providerManager: params.providerManager,
    dmPolicy: params.dmPolicy,
    userProfileStore: params.userProfileStore,
    soulLoader: params.soulLoader,
    runtimeArtifactManager: params.runtimeArtifactManager,
    projectScopeFingerprint,
    autonomousDefaultEnabled: params.config.autonomousDefaultEnabled,
    autonomousDefaultHours: params.config.autonomousDefaultHours,
  }) ?? new CommandHandler(
    taskManager,
    params.channel,
    params.providerManager,
    params.dmPolicy,
    params.userProfileStore,
    params.soulLoader,
    params.runtimeArtifactManager,
    projectScopeFingerprint,
    undefined,
    {
      autonomousDefaultEnabled: params.config.autonomousDefaultEnabled,
      autonomousDefaultHours: params.config.autonomousDefaultHours,
    },
  );
  if (params.providerRouter) {
    commandHandler.setProviderRouter(params.providerRouter);
  }

  const messageRouter = deps.createMessageRouter?.({
    taskManager,
    commandHandler,
    channel: params.channel,
    startupNotices: params.startupNotices,
    burstWindowMs: params.config.tasks.messageBurstWindowMs,
    maxBurstMessages: params.config.tasks.messageBurstMaxMessages,
  }) ?? new MessageRouter(taskManager, commandHandler, params.channel, params.startupNotices, {
    burstWindowMs: params.config.tasks.messageBurstWindowMs,
    maxBurstMessages: params.config.tasks.messageBurstMaxMessages,
  });

  if (deps.createProgressReporter) {
    deps.createProgressReporter(
      params.channel,
      taskManager,
      params.config.interaction,
      params.config.language,
    );
  } else {
    new ProgressReporter(params.channel, taskManager, params.config.interaction, params.config.language);
  }

  return {
    daemonEventBus,
    taskStorage,
    backgroundExecutor,
    taskManager,
    autoUpdater,
    projectScopeFingerprint,
    commandHandler,
    messageRouter,
  };
}
