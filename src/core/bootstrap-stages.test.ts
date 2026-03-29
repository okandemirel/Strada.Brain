import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config.js";
import {
  finalizeChannelStartupStage,
  initializeDaemonHeartbeatStage,
  initializeDeploymentStage,
  initializeGoalContextStage,
  initializeKnowledgeStage,
  initializeMemoryConsolidationStage,
  initializeMultiAgentDelegationStage,
  initializeRuntimeIntelligenceStage,
  initializeRuntimeStateStage,
  initializeSessionRuntimeStage,
  initializeTaskRuntimeStage,
  initializeToolChainStage,
  initializeToolRegistryStage,
  loadDaemonTriggersStage,
  registerDashboardPostBootStage,
  verifyEmbeddingProviderConnection,
} from "./bootstrap-stages.js";
import { isTransientEmbeddingVerificationError } from "./bootstrap.js";
import type * as winston from "winston";

function createMockLogger(): winston.Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as winston.Logger;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    anthropicApiKey: undefined,
    openaiApiKey: undefined,
    openaiAuthMode: "api-key",
    openaiChatgptAuthFile: undefined,
    openaiSubscriptionAccessToken: undefined,
    openaiSubscriptionAccountId: undefined,
    deepseekApiKey: undefined,
    qwenApiKey: undefined,
    kimiApiKey: undefined,
    minimaxApiKey: undefined,
    groqApiKey: undefined,
    mistralApiKey: undefined,
    togetherApiKey: undefined,
    fireworksApiKey: undefined,
    geminiApiKey: "gem-key",
    providerChain: "gemini",
    telegram: { allowedUserIds: [] },
    discord: { allowedUserIds: [], allowedRoleIds: [] },
    slack: { socketMode: true },
    whatsapp: { sessionPath: ".wwebjs_auth", allowedNumbers: [] },
    matrix: { allowedUserIds: [], allowedRoomIds: [], allowOpenAccess: false },
    irc: { nick: "strada", channels: [], allowedUsers: [], allowOpenAccess: false },
    teams: { allowedUserIds: [], allowOpenAccess: false },
    security: {
      requireEditConfirmation: true,
      readOnlyMode: false,
      systemAuth: { requireMfa: false },
    },
    tasks: {
      concurrencyLimit: 2,
      messageBurstWindowMs: 5000,
      messageBurstMaxMessages: 4,
    },
    interaction: {
      mode: "silent-first",
      heartbeatAfterMs: 120000,
      heartbeatIntervalMs: 300000,
      escalationPolicy: "hard-blockers-only",
    },
    unityProjectPath: "/Users/test/Game",
    strada: {
      coreRepoUrl: "https://example.invalid/core.git",
      modulesRepoUrl: "https://example.invalid/modules.git",
    },
    dashboard: { enabled: true, port: 3100 },
    websocketDashboard: { enabled: false, port: 3001 },
    prometheus: { enabled: false, port: 9090 },
    modelIntelligence: {
      enabled: true,
      refreshHours: 24,
      dbPath: ".strada-memory/model-intelligence.db",
      providerSourcesPath: "docs/provider-sources",
    },
    memory: {
      enabled: true,
      dbPath: ".strada-memory",
    } as Config["memory"],
    rag: {
      enabled: true,
      provider: "auto",
      contextMaxTokens: 4000,
    },
    streamingEnabled: true,
    shellEnabled: true,
    llmStreamInitialTimeoutMs: 30000,
    llmStreamStallTimeoutMs: 120000,
    rateLimit: {
      enabled: false,
    } as Config["rateLimit"],
    web: { port: 3000 },
    logLevel: "info",
    logFile: "strada.log",
    pluginDirs: [],
    bayesian: {} as Config["bayesian"],
    goalMaxDepth: 3,
    goalMaxRetries: 3,
    goalMaxFailures: 3,
    goalParallelExecution: true,
    goalMaxParallel: 3,
    goal: {} as Config["goal"],
    toolChain: {} as Config["toolChain"],
    crossSession: {} as Config["crossSession"],
    agentName: "Strada",
    language: "en",
    daemon: {} as Config["daemon"],
    reRetrieval: {} as Config["reRetrieval"],
    notification: {} as Config["notification"],
    quietHours: {} as Config["quietHours"],
    digest: {} as Config["digest"],
    agent: {
      enabled: false,
      defaultBudgetUsd: 5,
      maxConcurrent: 3,
      idleTimeoutMs: 60000,
      maxMemoryEntries: 1000,
    },
    delegation: {
      enabled: false,
      maxDepth: 2,
      maxConcurrentPerParent: 2,
      tiers: {
        local: "ollama:llama3.3",
        cheap: "deepseek:deepseek-chat",
        standard: "gemini:gemini-2.5-pro",
        premium: "claude:sonnet",
      },
      types: [],
      verbosity: "normal",
    },
    deployment: {
      enabled: false,
      testCommand: "npm test",
      targetBranch: "main",
      requireCleanGit: true,
      testTimeoutMs: 60000,
      executionTimeoutMs: 600000,
      cooldownMinutes: 30,
      notificationUrgency: "medium",
    },
    autonomousDefaultHours: 4,
    routing: { preset: "balanced", phaseSwitching: true },
    consensus: { mode: "auto", threshold: 0.7, maxProviders: 2 },
    autoUpdate: {
      enabled: true,
      intervalHours: 24,
      idleTimeoutMin: 5,
      channel: "stable",
      notify: true,
      autoRestart: true,
    },
    ...overrides,
  } as Config;
}

describe("bootstrap-stages", () => {
  it("keeps live embeddings active for transient verification failures", async () => {
    const logger = createMockLogger();
    const provider = {
      embed: vi.fn().mockRejectedValue(new Error("fetch failed")),
    } as any;

    const result = await verifyEmbeddingProviderConnection(
      provider,
      {
        state: "active",
        ragEnabled: true,
        configuredProvider: "auto",
        verified: false,
        usingHashFallback: false,
      },
      logger,
      isTransientEmbeddingVerificationError,
    );

    expect(result.cachedEmbeddingProvider).toBe(provider);
    expect(result.embeddingStatus).toMatchObject({
      state: "active",
      verified: false,
      usingHashFallback: false,
    });
    expect(result.embeddingStatus.notice).toContain("retrying on demand");
  });

  it("falls back to hash embeddings for non-transient verification failures", async () => {
    const logger = createMockLogger();
    const provider = {
      embed: vi.fn().mockRejectedValue(new Error("OpenAI API error 401: invalid_api_key")),
    } as any;

    const result = await verifyEmbeddingProviderConnection(
      provider,
      {
        state: "active",
        ragEnabled: true,
        configuredProvider: "openai",
        verified: false,
        usingHashFallback: false,
      },
      logger,
      isTransientEmbeddingVerificationError,
    );

    expect(result.cachedEmbeddingProvider).toBeUndefined();
    expect(result.embeddingStatus).toMatchObject({
      state: "degraded",
      verified: false,
      usingHashFallback: true,
    });
    expect(result.embeddingStatus.notice).toContain("falling back to hash embeddings");
  });

  it("aggregates rag and learning notices in the knowledge stage", async () => {
    const pipeline = { _tag: "rag" } as any;
    const learningPipeline = { _tag: "learning" } as any;
    const result = await initializeKnowledgeStage({
      config: makeConfig(),
      logger: createMockLogger(),
      cachedEmbeddingProvider: undefined,
      startupNotices: ["provider notice"],
    }, {
      initializeRAG: vi.fn().mockResolvedValue({
        pipeline,
        notice: "rag notice",
      }),
      initializeLearning: vi.fn().mockResolvedValue({
        pipeline: learningPipeline,
        taskPlanner: {} as any,
        errorRecovery: {} as any,
        notices: ["learning notice"],
      }),
    });

    expect(result.ragPipeline).toBe(pipeline);
    expect(result.learningResult.pipeline).toBe(learningPipeline);
    expect(result.startupNotices).toEqual([
      "provider notice",
      "rag notice",
      "learning notice",
    ]);
  });

  it("runs channel handoff before connect and emits a boot report", async () => {
    const logger = createMockLogger();
    const callOrder: string[] = [];
    const channel = {
      connect: vi.fn().mockImplementation(async () => {
        callOrder.push("connect");
      }),
      isHealthy: vi.fn().mockReturnValue(true),
    } as any;

    const bootReport = await finalizeChannelStartupStage({
      beforeChannelConnect: async () => {
        callOrder.push("handoff");
      },
      channel,
      logger,
      config: makeConfig(),
      channelType: "web",
      daemonMode: false,
      providerHealthy: true,
      embeddingStatus: {
        state: "active",
        ragEnabled: true,
        configuredProvider: "auto",
        verified: true,
        usingHashFallback: false,
      },
      deploymentWired: false,
      alertingWired: false,
      backupWired: false,
      startupNotices: ["provider warning"],
      moduleUrl: import.meta.url,
    });

    expect(callOrder).toEqual(["handoff", "connect"]);
    expect(bootReport.channelType).toBe("web");
    expect(logger.info).toHaveBeenCalledWith(
      "Boot report",
      expect.objectContaining({
        summary: expect.any(String),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Startup capability notices",
      expect.objectContaining({
        notices: ["provider warning"],
      }),
    );
  });

  it("initializes runtime state and wires learning context", () => {
    const logger = createMockLogger();
    const metricsStorage = {
      initialize: vi.fn(),
    } as any;
    const metricsRecorder = {
      _tag: "metrics-recorder",
    } as any;
    const identityManager = {
      initialize: vi.fn(),
      recordBoot: vi.fn(),
      setProjectContext: vi.fn(),
      updateUptime: vi.fn(),
      flush: vi.fn(),
      getState: vi.fn().mockReturnValue({ bootCount: 7 }),
      wasCrash: vi.fn().mockReturnValue(false),
    } as any;
    const runtimeArtifactManager = { _tag: "runtime-artifacts" } as any;
    const instinctRetriever = { _tag: "instincts" } as any;
    const replayRetriever = { _tag: "replays" } as any;
    const pipeline = {
      getRuntimeArtifactManager: vi.fn().mockReturnValue(undefined),
      setProjectPath: vi.fn(),
      setPromotionThreshold: vi.fn(),
    } as any;

    const result = initializeRuntimeStateStage({
      config: makeConfig({
        crossSession: {
          scopeFilter: "project",
          maxAgeDays: 30,
          recencyBoost: 0.2,
          scopeBoost: 0.5,
          promotionThreshold: 0.75,
        } as Config["crossSession"],
      }),
      logger,
      learningResult: {
        pipeline,
        storage: { _tag: "learning-storage" } as any,
        patternMatcher: { _tag: "pattern-matcher" } as any,
        taskPlanner: {} as any,
        errorRecovery: {} as any,
        notices: [],
      },
      metricsStorage: undefined,
      metricsRecorder: undefined,
    }, {
      createMetricsStorage: vi.fn().mockReturnValue(metricsStorage),
      createMetricsRecorder: vi.fn().mockReturnValue(metricsRecorder),
      createIdentityManager: vi.fn().mockReturnValue(identityManager),
      createRuntimeArtifactManager: vi.fn().mockReturnValue(runtimeArtifactManager),
      createInstinctRetriever: vi.fn().mockReturnValue(instinctRetriever),
      createTrajectoryReplayRetriever: vi.fn().mockReturnValue(replayRetriever),
    });

    expect(result.metricsStorage).toBe(metricsStorage);
    expect(result.metricsRecorder).toBe(metricsRecorder);
    expect(result.identityManager).toBe(identityManager);
    expect(result.runtimeArtifactManager).toBe(runtimeArtifactManager);
    expect(result.instinctRetriever).toBe(instinctRetriever);
    expect(result.trajectoryReplayRetriever).toBe(replayRetriever);
    expect(identityManager.recordBoot).toHaveBeenCalled();
    expect(identityManager.setProjectContext).toHaveBeenCalledWith("/Users/test/Game");
    expect(pipeline.setProjectPath).toHaveBeenCalledWith("/Users/test/Game");
    expect(pipeline.setPromotionThreshold).toHaveBeenCalledWith(0.75);
    if (result.uptimeInterval) {
      clearInterval(result.uptimeInterval);
    }
  });

  it("builds goal context, crash context, and executor config from shared inputs", () => {
    const logger = createMockLogger();
    const goalStorage = {
      initialize: vi.fn(),
      pruneOldTrees: vi.fn(),
    } as any;
    const goalDecomposer = { _tag: "goal-decomposer" } as any;
    const crashContext = {
      wasCrash: true,
      downtimeMs: 1234,
      interruptedTrees: [{ id: "tree-1" }],
      bootCount: 9,
    } as any;
    const identityManager = {
      wasCrash: vi.fn().mockReturnValue(true),
      getState: vi.fn().mockReturnValue({ bootCount: 9 }),
    } as any;

    const result = initializeGoalContextStage({
      config: makeConfig({
        goalMaxRetries: 5,
        goalMaxFailures: 4,
        goalParallelExecution: false,
        goalMaxParallel: 2,
        goal: {
          maxRedecompositions: 6,
        } as Config["goal"],
      }),
      logger,
      provider: { name: "mock-provider" } as any,
      identityManager,
    }, {
      createGoalStorage: vi.fn().mockReturnValue(goalStorage),
      createGoalDecomposer: vi.fn().mockReturnValue(goalDecomposer),
      detectInterruptedTrees: vi.fn().mockReturnValue([{ id: "tree-1" }] as any),
      buildCrashRecoveryContext: vi.fn().mockReturnValue(crashContext),
    });

    expect(result.goalStorage).toBe(goalStorage);
    expect(result.goalDecomposer).toBe(goalDecomposer);
    expect(result.interruptedGoalTrees).toEqual([{ id: "tree-1" }]);
    expect(result.crashContext).toBe(crashContext);
    expect(result.goalExecutorConfig).toEqual({
      maxRetries: 5,
      maxFailures: 4,
      parallelExecution: false,
      maxParallel: 2,
      maxRedecompositions: 6,
    });
    expect(goalStorage.initialize).toHaveBeenCalled();
    expect(goalStorage.pruneOldTrees).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Unclean shutdown detected",
      expect.objectContaining({
        bootCount: 9,
      }),
    );
  });

  it("forwards shared dependencies into tool registry initialization", async () => {
    const toolRegistry = {
      initialize: vi.fn().mockResolvedValue(undefined),
    } as any;
    const getIdentityState = vi.fn();
    const getDaemonStatus = vi.fn();

    await initializeToolRegistryStage({
      toolRegistry,
      config: makeConfig(),
      memoryManager: { _tag: "memory" } as any,
      ragPipeline: { _tag: "rag" } as any,
      metrics: { _tag: "metrics" } as any,
      learningStorage: { _tag: "learning" } as any,
      metricsStorage: { _tag: "metrics-storage" } as any,
      getIdentityState,
    }, {
      getDaemonStatus,
    });

    expect(toolRegistry.initialize).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        getIdentityState,
        getDaemonStatus,
      }),
    );
  });

  it("initializes soul/session runtime around an AgentDB-backed memory manager", async () => {
    const logger = createMockLogger();
    const soulLoader = {
      initialize: vi.fn().mockResolvedValue(undefined),
    } as any;
    const profileStore = { _tag: "profiles" } as any;
    const executionStore = { _tag: "executions" } as any;
    const memoryManager = {
      getUserProfileStore: vi.fn().mockReturnValue(profileStore),
      getTaskExecutionStore: vi.fn().mockReturnValue(executionStore),
    } as any;
    const sessionSummarizer = { _tag: "summaries" } as any;
    const dmPolicy = { _tag: "dm-policy" } as any;
    const providerManager = {
      getProvider: vi.fn().mockReturnValue({ name: "mock-provider" }),
    } as any;

    const result = await initializeSessionRuntimeStage({
      config: makeConfig(),
      logger,
      memoryManager,
      providerManager,
      channel: { name: "web" } as any,
    }, {
      createSoulLoader: vi.fn().mockReturnValue(soulLoader),
      isAgentDbAdapter: vi.fn().mockReturnValue(true),
      createSessionSummarizer: vi.fn().mockReturnValue(sessionSummarizer),
      createDMPolicy: vi.fn().mockReturnValue(dmPolicy),
    });

    expect(soulLoader.initialize).toHaveBeenCalled();
    expect(result.soulLoader).toBe(soulLoader);
    expect(result.userProfileStore).toBe(profileStore);
    expect(result.taskExecutionStore).toBe(executionStore);
    expect(result.sessionSummarizer).toBe(sessionSummarizer);
    expect(result.dmPolicy).toBe(dmPolicy);
    expect(logger.info).toHaveBeenCalledWith("SessionSummarizer wired for session-end summarization");
  });

  it("initializes task runtime, updater, and message routing from shared dependencies", async () => {
    const logger = createMockLogger();
    const taskStorage = {
      initialize: vi.fn(),
    } as any;
    const backgroundExecutor = {
      setTaskManager: vi.fn(),
    } as any;
    const taskManager = {
      recoverOnStartup: vi.fn(),
      on: vi.fn(),
    } as any;
    const autoUpdater = {
      setNotifyFn: vi.fn(),
      init: vi.fn().mockResolvedValue(undefined),
      scheduleChecks: vi.fn(),
    } as any;
    const commandHandler = {
      setProviderRouter: vi.fn(),
    } as any;
    const messageRouter = { _tag: "message-router" } as any;
    const daemonEventBus = { _tag: "daemon-bus" } as any;
    const providerRouter = { _tag: "provider-router" } as any;
    const channel = {
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
    } as any;
    const activityRegistry = {
      getActiveChatIds: vi.fn().mockReturnValue([{ chatId: "chat-1" }]),
    } as any;
    const providerManager = {
      getProvider: vi.fn().mockReturnValue({ name: "mock-provider" }),
    } as any;
    const identityManager = {
      incrementTasks: vi.fn(),
    } as any;
    const orchestrator = {
      setTaskManager: vi.fn(),
    } as any;

    const result = await initializeTaskRuntimeStage({
      daemonMode: true,
      config: makeConfig(),
      logger,
      orchestrator,
      providerManager,
      channel,
      dmPolicy: { _tag: "dm-policy" } as any,
      userProfileStore: { _tag: "profiles" } as any,
      soulLoader: { _tag: "soul-loader" } as any,
      runtimeArtifactManager: { _tag: "artifacts" } as any,
      activityRegistry,
      goalDecomposer: { _tag: "goal-decomposer" } as any,
      goalStorage: { _tag: "goal-storage" } as any,
      goalExecutorConfig: {
        maxRetries: 3,
        maxFailures: 3,
        parallelExecution: true,
        maxParallel: 3,
        maxRedecompositions: 2,
      },
      learningEventBus: { _tag: "event-bus" } as any,
      identityManager,
      providerRouter: providerRouter as any,
      startupNotices: ["boot notice"],
    }, {
      createTaskStorage: vi.fn().mockReturnValue(taskStorage),
      createDaemonEventBus: vi.fn().mockReturnValue(daemonEventBus),
      createBackgroundExecutor: vi.fn().mockReturnValue(backgroundExecutor),
      createTaskManager: vi.fn().mockReturnValue(taskManager),
      createAutoUpdater: vi.fn().mockReturnValue(autoUpdater),
      createProjectScopeFingerprint: vi.fn().mockReturnValue("scope-123"),
      createCommandHandler: vi.fn().mockReturnValue(commandHandler),
      createMessageRouter: vi.fn().mockReturnValue(messageRouter),
      createProgressReporter: vi.fn(),
    });

    expect(taskStorage.initialize).toHaveBeenCalled();
    expect(backgroundExecutor.setTaskManager).toHaveBeenCalledWith(taskManager);
    expect(orchestrator.setTaskManager).toHaveBeenCalledWith(taskManager);
    expect(taskManager.recoverOnStartup).toHaveBeenCalled();
    expect(taskManager.on).toHaveBeenCalledWith("task:created", expect.any(Function));
    expect(autoUpdater.init).toHaveBeenCalled();
    expect(autoUpdater.scheduleChecks).toHaveBeenCalled();
    expect(commandHandler.setProviderRouter).toHaveBeenCalledWith(providerRouter);
    expect(result.daemonEventBus).toBe(daemonEventBus);
    expect(result.taskStorage).toBe(taskStorage);
    expect(result.backgroundExecutor).toBe(backgroundExecutor);
    expect(result.taskManager).toBe(taskManager);
    expect(result.autoUpdater).toBe(autoUpdater);
    expect(result.projectScopeFingerprint).toBe("scope-123");
    expect(result.commandHandler).toBe(commandHandler);
    expect(result.messageRouter).toBe(messageRouter);

    const notifyFn = autoUpdater.setNotifyFn.mock.calls[0][0] as (msg: string) => void;
    notifyFn("update available");
    expect(channel.sendMarkdown).toHaveBeenCalledWith("chat-1", "update available");
  });

  it("loads heartbeat triggers into the shared trigger registry and tracks webhook triggers", () => {
    const logger = createMockLogger();
    const triggerRegistry = {
      register: vi.fn(),
      count: vi.fn().mockReturnValue(2),
    } as any;
    const webhookTrigger = { _tag: "webhook-trigger" } as any;

    const result = loadDaemonTriggersStage({
      daemonConfig: makeConfig({
        daemon: {
          heartbeat: { heartbeatFile: "HEARTBEAT.md", intervalMs: 1000 },
          triggers: {
            checklistMorningHour: 9,
            checklistAfternoonHour: 14,
            checklistEveningHour: 18,
            defaultDebounceMs: 250,
          },
          timezone: "Europe/Istanbul",
        } as Config["daemon"],
      }).daemon,
      logger,
      triggerRegistry,
      projectRoot: "/workspace",
    }, {
      readFile: vi.fn().mockReturnValue("# heartbeat"),
      parseHeartbeatFile: vi.fn().mockReturnValue([
        { type: "cron", name: "cron-1", action: "Run cron", cron: "0 * * * *" },
        { type: "webhook", name: "hook-1", action: "Run webhook" },
        { type: "file-watch", name: "watch-1", action: "Watch", path: "../outside", debounce: 100 },
      ]),
      createCronTrigger: vi.fn().mockReturnValue({ _tag: "cron-trigger" } as any),
      createWebhookTrigger: vi.fn().mockReturnValue(webhookTrigger),
      createFileWatchTrigger: vi.fn(),
    });

    expect(result.heartbeatPath).toBe("/workspace/HEARTBEAT.md");
    expect(result.webhookTriggers.get("hook-1")).toBe(webhookTrigger);
    expect(triggerRegistry.register).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "File-watch path outside project root, skipping",
      expect.objectContaining({ trigger: "watch-1" }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Daemon triggers loaded",
      expect.objectContaining({
        byType: { cron: 1, webhook: 1 },
      }),
    );
  });

  it("initializes daemon heartbeat wiring and binds the command handler", () => {
    const logger = createMockLogger();
    const daemonStorage = {
      initialize: vi.fn(),
      getDaemonState: vi.fn().mockReturnValue("true"),
      migrateBudgetSource: vi.fn(),
      getAllBudgetConfig: vi.fn().mockReturnValue({}),
      getBudgetConfig: vi.fn(),
      setBudgetConfig: vi.fn(),
      sumBudgetSince: vi.fn().mockReturnValue(0),
      sumBudgetBySource: vi.fn().mockReturnValue({}),
      sumBudgetForSource: vi.fn().mockReturnValue(0),
      sumBudgetSinceForAgent: vi.fn().mockReturnValue(0),
      getDailyHistory: vi.fn().mockReturnValue([]),
      insertBudgetEntry: vi.fn(),
      insertBudgetEntryWithSource: vi.fn(),
      insertBudgetEntryWithAgent: vi.fn(),
    } as any;
    const triggerRegistry = {
      register: vi.fn(),
      count: vi.fn().mockReturnValue(1),
    } as any;
    const budgetTracker = { _tag: "budget-tracker" } as any;
    const approvalQueue = { _tag: "approval-queue" } as any;
    const securityPolicy = { _tag: "security-policy" } as any;
    const heartbeatLoop = {
      start: vi.fn(),
      stop: vi.fn(),
      isRunning: vi.fn().mockReturnValue(true),
      getDaemonStatus: vi.fn().mockReturnValue({ running: true }),
      setUnifiedBudgetManager: vi.fn(),
    } as any;
    const backgroundExecutor = {
      setDaemonBudgetTracker: vi.fn(),
      setUnifiedBudgetManager: vi.fn(),
    } as any;
    const commandHandler = {
      setHeartbeatLoop: vi.fn(),
    } as any;
    const webhookTrigger = { _tag: "webhook-trigger" } as any;

    const result = initializeDaemonHeartbeatStage({
      config: makeConfig({
        daemon: {
          budget: { dailyBudgetUsd: 5 },
          security: { approvalTimeoutMin: 15, autoApproveTools: ["status"] },
          triggers: {
            checklistMorningHour: 9,
            checklistAfternoonHour: 14,
            checklistEveningHour: 18,
            defaultDebounceMs: 250,
            dedupWindowMs: 1000,
          },
          heartbeat: { heartbeatFile: "HEARTBEAT.md", intervalMs: 1000 },
          timezone: "Europe/Istanbul",
        } as Config["daemon"],
      }),
      logger,
      toolRegistry: {
        getMetadata: vi.fn().mockReturnValue({ readOnly: true }),
      } as any,
      backgroundExecutor,
      taskManager: { _tag: "task-manager" } as any,
      commandHandler,
      daemonEventBus: { _tag: "daemon-event-bus" } as any,
      identityManager: { recordActivity: vi.fn() } as any,
      crashContext: { wasCrash: true } as any,
    }, {
      createDaemonStorage: vi.fn().mockReturnValue(daemonStorage),
      createTriggerRegistry: vi.fn().mockReturnValue(triggerRegistry),
      createBudgetTracker: vi.fn().mockReturnValue(budgetTracker),
      createApprovalQueue: vi.fn().mockReturnValue(approvalQueue),
      createSecurityPolicy: vi.fn().mockReturnValue(securityPolicy),
      readFile: vi.fn().mockReturnValue("# heartbeat"),
      parseHeartbeatFile: vi.fn().mockReturnValue([
        { type: "webhook", name: "hook-1", action: "Run webhook" },
      ]),
      createWebhookTrigger: vi.fn().mockReturnValue(webhookTrigger),
      createTriggerDeduplicator: vi.fn().mockReturnValue({ _tag: "deduplicator" } as any),
      createHeartbeatLoop: vi.fn().mockReturnValue(heartbeatLoop),
    });

    expect(daemonStorage.initialize).toHaveBeenCalled();
    expect(backgroundExecutor.setDaemonBudgetTracker).toHaveBeenCalledWith(budgetTracker);
    expect(heartbeatLoop.start).toHaveBeenCalled();
    expect(commandHandler.setHeartbeatLoop).toHaveBeenCalledWith(expect.objectContaining({
      start: expect.any(Function),
      stop: expect.any(Function),
      isRunning: expect.any(Function),
      getDaemonStatus: expect.any(Function),
      getSecurityPolicy: expect.any(Function),
    }));
    expect(result.daemonStorage).toBe(daemonStorage);
    expect(result.triggerRegistry).toBe(triggerRegistry);
    expect(result.budgetTracker).toBe(budgetTracker);
    expect(result.approvalQueue).toBe(approvalQueue);
    expect(result.securityPolicy).toBe(securityPolicy);
    expect(result.heartbeatLoop).toBe(heartbeatLoop);
    expect(result.webhookTriggers.get("hook-1")).toBe(webhookTrigger);
    expect(logger.info).toHaveBeenCalledWith("Daemon auto-restarting after crash recovery");
  });

  it("initializes multi-agent delegation and wires daemon context/dashboard state", async () => {
    const logger = createMockLogger();
    const daemonStorage = {
      getDatabase: vi.fn().mockReturnValue({ _tag: "daemon-db" }),
    } as any;
    const agentRegistry = {
      initialize: vi.fn(),
    } as any;
    const agentBudgetTracker = {
      initialize: vi.fn(),
    } as any;
    const agentManager = {
      setBackgroundTaskSubmitter: vi.fn(),
      setDelegationFactory: vi.fn(),
      getLiveOrchestrator: vi.fn().mockReturnValue({ _tag: "live-orchestrator" }),
    } as any;
    const delegationLog = { _tag: "delegation-log" } as any;
    const tierRouter = { _tag: "tier-router" } as any;
    const delegationManager = { _tag: "delegation-manager" } as any;
    const orchestrator = {
      addTool: vi.fn(),
    } as any;
    const daemonContext = {} as any;
    const providerRouter = {
      setTierRouter: vi.fn(),
    } as any;
    const dashboard = {
      registerDelegationServices: vi.fn(),
    } as any;
    const createDelegationTools = vi.fn().mockReturnValue([{ name: "delegate-tool" }] as any);
    const taskManager = {
      submit: vi.fn(),
    } as any;

    const result = await initializeMultiAgentDelegationStage({
      config: makeConfig({
        agent: {
          enabled: true,
          defaultBudgetUsd: 5,
          maxConcurrent: 3,
          idleTimeoutMs: 60000,
          maxMemoryEntries: 1000,
        },
        delegation: {
          enabled: true,
          maxDepth: 2,
          maxConcurrentPerParent: 2,
          tiers: {
            local: "ollama:llama3.3",
            cheap: "deepseek:deepseek-chat",
            standard: "gemini:gemini-2.5-pro",
            premium: "claude:sonnet",
          },
          types: [],
          verbosity: "normal",
        },
        memory: {
          dbPath: ".strada-memory",
          unified: { dimensions: 1536 },
        } as Config["memory"],
      }),
      logger,
      daemonMode: true,
      daemonStorage,
      daemonContext,
      taskManager,
      orchestrator,
      learningEventBus: { _tag: "learning-event-bus" } as any,
      providerManager: {
        isAvailable: vi.fn().mockReturnValue(true),
      } as any,
      toolRegistry: {
        getAllTools: vi.fn().mockReturnValue([{ name: "tool-1" }]),
      } as any,
      channel: { _tag: "channel" } as any,
      metrics: { _tag: "metrics" } as any,
      ragPipeline: { _tag: "rag" } as any,
      rateLimiter: { _tag: "rate-limiter" } as any,
      instinctRetriever: { _tag: "instincts" } as any,
      metricsRecorder: { _tag: "metrics-recorder" } as any,
      goalDecomposer: { _tag: "goal-decomposer" } as any,
      identityManager: {
        getState: vi.fn().mockReturnValue({ bootCount: 1 }),
      } as any,
      cachedEmbeddingProvider: { _tag: "embeddings" } as any,
      soulLoader: { _tag: "soul-loader" } as any,
      dmPolicy: { _tag: "dm-policy" } as any,
      userProfileStore: { _tag: "profiles" } as any,
      providerRouter,
      dashboard,
      stradaDeps: { coreInstalled: true, mcpInstalled: false, warnings: [] } as any,
    }, {
      createAgentRegistry: vi.fn().mockReturnValue(agentRegistry),
      createAgentBudgetTracker: vi.fn().mockReturnValue(agentBudgetTracker),
      createAgentManager: vi.fn().mockReturnValue(agentManager),
      createDelegationLog: vi.fn().mockReturnValue(delegationLog),
      createTierRouter: vi.fn().mockReturnValue(tierRouter),
      createDelegationManager: vi.fn().mockReturnValue(delegationManager),
      createDelegationTools,
      defaultDelegationTypes: [{ name: "delegate_task" }] as any,
    });

    expect(agentRegistry.initialize).toHaveBeenCalled();
    expect(agentBudgetTracker.initialize).toHaveBeenCalled();
    expect(agentManager.setBackgroundTaskSubmitter).toHaveBeenCalledWith(expect.any(Function));
    const submitter = agentManager.setBackgroundTaskSubmitter.mock.calls[0]?.[0];
    expect(typeof submitter).toBe("function");
    submitter?.({
      channelType: "web",
      chatId: "chat-123",
      conversationId: "conv-123",
      userId: "user-123",
      text: "Fix the broken flow",
      attachments: [{ type: "image", name: "shot.png" }],
      timestamp: new Date("2026-03-27T12:00:00.000Z"),
    }, {
      id: "agent-123",
    }, {
      _tag: "agent-orchestrator",
    });
    expect(taskManager.submit).toHaveBeenCalledWith("chat-123", "web", "Fix the broken flow", {
      attachments: [{ type: "image", name: "shot.png" }],
      conversationId: "conv-123",
      userId: "user-123",
      orchestrator: { _tag: "agent-orchestrator" },
    });
    expect(agentManager.setDelegationFactory).toHaveBeenCalledWith(expect.any(Function));
    expect(orchestrator.addTool).toHaveBeenCalledWith({ name: "delegate-tool" });
    expect(providerRouter.setTierRouter).toHaveBeenCalledWith(tierRouter);
    expect(dashboard.registerDelegationServices).toHaveBeenCalledWith(delegationLog, delegationManager);
    expect(daemonContext.agentManager).toBe(agentManager);
    expect(daemonContext.agentBudgetTracker).toBe(agentBudgetTracker);
    expect(daemonContext.delegationManager).toBe(delegationManager);
    expect(daemonContext.delegationLog).toBe(delegationLog);
    expect(daemonContext.tierRouter).toBe(tierRouter);
    expect(result.agentManager).toBe(agentManager);
    expect(result.agentBudgetTracker).toBe(agentBudgetTracker);
    expect(result.delegationManager).toBe(delegationManager);
  });

  it("initializes memory consolidation with hash fallback embeddings and daemon wiring", async () => {
    const logger = createMockLogger();
    const heartbeatLoop = {
      setConsolidationEngine: vi.fn(),
    } as any;
    const daemonContext = {} as any;
    const provider = {
      name: "mock-provider",
      chat: vi.fn().mockResolvedValue({ text: "summary" }),
    } as any;
    let engineOptions: any;
    const consolidationEngine = { _tag: "consolidation-engine" } as any;

    const result = await initializeMemoryConsolidationStage({
      config: makeConfig({
        memory: {
          dbPath: ".strada-memory",
          unified: { dimensions: 4 },
          consolidation: { enabled: true, idleMinutes: 10, threshold: 0.8 },
          decay: { exemptDomains: ["identity"] },
        } as Config["memory"],
      }),
      logger,
      memoryManager: { _tag: "memory-manager" } as any,
      cachedEmbeddingProvider: undefined,
      providerManager: {
        getProvider: vi.fn().mockReturnValue(provider),
      } as any,
      learningEventBus: { emit: vi.fn() } as any,
      heartbeatLoop,
      daemonContext,
    }, {
      isAgentDbAdapter: vi.fn().mockReturnValue(true),
      getConsolidationInternals: vi.fn().mockReturnValue({
        sqliteDb: { _tag: "sqlite" },
        entries: [],
        hnswStore: { _tag: "hnsw" },
      }),
      createMemoryConsolidationEngine: vi.fn().mockImplementation((options) => {
        engineOptions = options;
        return consolidationEngine;
      }),
    });

    const vector = await engineOptions.generateEmbedding("abc");
    const summary = await engineOptions.summarizeWithLLM(["a", "b"]);

    expect(vector).toHaveLength(4);
    expect(summary.summary).toBe("summary");
    expect(provider.chat).toHaveBeenCalled();
    expect(heartbeatLoop.setConsolidationEngine).toHaveBeenCalledWith(consolidationEngine, {
      idleMinutes: 10,
    });
    expect(daemonContext.consolidationEngine).toBe(consolidationEngine);
    expect(result.consolidationEngine).toBe(consolidationEngine);
    expect(logger.info).toHaveBeenCalledWith(
      "Memory consolidation engine initialized",
      expect.objectContaining({
        idleMinutes: 10,
      }),
    );
  });

  it("initializes deployment wiring and preserves warning-only script validation", async () => {
    const logger = createMockLogger();
    const readinessChecker = {
      validateScriptPath: vi.fn().mockImplementation(() => {
        throw new Error("bad path");
      }),
    } as any;
    const deploymentExecutor = { _tag: "deployment-executor" } as any;
    const deployTrigger = { _tag: "deploy-trigger" } as any;
    const triggerRegistry = {
      register: vi.fn(),
    } as any;
    const heartbeatLoop = {
      setDeployTrigger: vi.fn(),
      onTaskSettled: vi.fn(),
    } as any;
    const taskManager = {
      on: vi.fn(),
    } as any;
    const daemonContext = {} as any;

    const result = await initializeDeploymentStage({
      config: makeConfig({
        deployment: {
          enabled: true,
          testCommand: "npm test",
          targetBranch: "main",
          requireCleanGit: true,
          testTimeoutMs: 60000,
          executionTimeoutMs: 600000,
          cooldownMinutes: 30,
          notificationUrgency: "medium",
          scriptPath: "deploy.sh",
        } as Config["deployment"],
        daemon: {
          backoff: {
            failureThreshold: 2,
            baseCooldownMs: 1000,
            maxCooldownMs: 10000,
          },
        } as Config["daemon"],
      }),
      logger,
      daemonConfig: makeConfig({
        daemon: {
          backoff: {
            failureThreshold: 2,
            baseCooldownMs: 1000,
            maxCooldownMs: 10000,
          },
        } as Config["daemon"],
      }).daemon,
      daemonStorage: {
        getDatabase: vi.fn().mockReturnValue({ _tag: "daemon-db" }),
      } as any,
      approvalQueue: { _tag: "approval-queue" } as any,
      triggerRegistry,
      heartbeatLoop,
      daemonEventBus: { _tag: "daemon-event-bus" } as any,
      taskManager,
      daemonContext,
    }, {
      createReadinessChecker: vi.fn().mockReturnValue(readinessChecker),
      createDeploymentExecutor: vi.fn().mockReturnValue(deploymentExecutor),
      createDeployCircuitBreaker: vi.fn().mockReturnValue({ _tag: "circuit-breaker" } as any),
      createDeployTrigger: vi.fn().mockReturnValue(deployTrigger),
      registerDeployApprovalBridge: vi.fn(),
    });

    expect(triggerRegistry.register).toHaveBeenCalledWith(deployTrigger);
    expect(heartbeatLoop.setDeployTrigger).toHaveBeenCalledWith(deployTrigger);
    expect(taskManager.on).toHaveBeenCalledTimes(2);
    expect(daemonContext.deploymentExecutor).toBe(deploymentExecutor);
    expect(daemonContext.readinessChecker).toBe(readinessChecker);
    expect(daemonContext.deployTrigger).toBe(deployTrigger);
    expect(logger.warn).toHaveBeenCalledWith(
      "Deployment script path validation failed at startup (will be re-validated at execution time)",
      expect.objectContaining({ scriptPath: "deploy.sh" }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Deployment subsystem initialized",
      expect.objectContaining({ targetBranch: "main" }),
    );
    expect(result.deploymentExecutor).toBe(deploymentExecutor);
    expect(result.readinessChecker).toBe(readinessChecker);
    expect(result.deployTrigger).toBe(deployTrigger);
  });

  it("initializes runtime intelligence, routing, and consensus services", async () => {
    const logger = createMockLogger();
    const modelIntelligence = {
      initialize: vi.fn().mockResolvedValue(undefined),
    } as any;
    const trajectoryPhaseSignalRetriever = { _tag: "trajectory-retriever" } as any;
    const providerRouter = { _tag: "provider-router" } as any;
    const consensusManager = { _tag: "consensus-manager" } as any;
    const confidenceEstimator = { _tag: "confidence-estimator" } as any;
    const providerManager = {
      setModelCatalog: vi.fn(),
    } as any;

    const result = await initializeRuntimeIntelligenceStage({
      config: makeConfig(),
      logger,
      providerManager,
      learningStorage: { _tag: "learning-storage" } as any,
    }, {
      createModelIntelligenceService: vi.fn().mockReturnValue(modelIntelligence),
      createTrajectoryPhaseSignalRetriever: vi.fn().mockReturnValue(trajectoryPhaseSignalRetriever),
      createProviderRouter: vi.fn().mockReturnValue(providerRouter),
      createConsensusManager: vi.fn().mockReturnValue(consensusManager),
      createConfidenceEstimator: vi.fn().mockReturnValue(confidenceEstimator),
    });

    expect(modelIntelligence.initialize).toHaveBeenCalledWith(
      ".strada-memory/model-intelligence.db",
      { refreshOnInitialize: false },
    );
    expect(providerManager.setModelCatalog).toHaveBeenCalledWith(modelIntelligence);
    expect(result.modelIntelligence).toBe(modelIntelligence);
    expect(result.providerRouter).toBe(providerRouter);
    expect(result.consensusManager).toBe(consensusManager);
    expect(result.confidenceEstimator).toBe(confidenceEstimator);
    expect(logger.info).toHaveBeenCalledWith(
      "ProviderRouter initialized",
      expect.objectContaining({ preset: "balanced" }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "ConsensusManager initialized",
      expect.objectContaining({ mode: "auto" }),
    );
  });

  it("initializes tool chain synthesis and wires runtime feedback", async () => {
    const logger = createMockLogger();
    const chainSynthesizer = {
      setProvider: vi.fn(),
    } as any;
    const chainValidator = {
      handleChainExecuted: vi.fn(),
    } as any;
    const chainManager = {
      start: vi.fn().mockResolvedValue(undefined),
      handleChainDeprecated: vi.fn(),
    } as any;
    const learningEventBus = {
      on: vi.fn(),
    } as any;
    const learningQueue = {
      enqueue: vi.fn(),
    } as any;

    const result = await initializeToolChainStage({
      config: makeConfig({
        toolChain: {
          enabled: true,
          maxAgeDays: 30,
          detectionIntervalMs: 120000,
          resilience: {},
        } as Config["toolChain"],
      }),
      logger,
      learningStorage: { _tag: "learning-storage" } as any,
      learningEventBus,
      learningQueue: learningQueue as any,
      learningPipeline: {
        updateInstinctStatus: vi.fn(),
      } as any,
      toolRegistry: { _tag: "tool-registry" } as any,
      providerManager: {
        getProvider: vi.fn().mockReturnValue({ name: "mock-provider" }),
      } as any,
      orchestrator: { addTool: vi.fn(), removeTool: vi.fn() } as any,
    }, {
      createChainDetector: vi.fn().mockReturnValue({ _tag: "detector" } as any),
      createChainSynthesizer: vi.fn().mockReturnValue(chainSynthesizer),
      createChainValidator: vi.fn().mockReturnValue(chainValidator),
      createChainManager: vi.fn().mockReturnValue(chainManager),
    });

    expect(chainSynthesizer.setProvider).toHaveBeenCalled();
    expect(chainManager.start).toHaveBeenCalled();
    expect(learningEventBus.on).toHaveBeenCalledWith("chain:executed", expect.any(Function));
    const handler = learningEventBus.on.mock.calls[0][1] as (event: unknown) => void;
    handler({ chainName: "demo" });
    expect(learningQueue.enqueue).toHaveBeenCalled();
    expect(result.chainManager).toBe(chainManager);
    expect(logger.info).toHaveBeenCalledWith("Tool chain synthesis initialized");
  });

  it("registers dashboard post-boot integrations from shared services", () => {
    const dashboard = {
      registerAgentServices: vi.fn(),
      registerConsolidationDeploymentServices: vi.fn(),
      registerExtendedServices: vi.fn(),
      setProviderRouter: vi.fn(),
    } as any;
    const providerManager = {
      listAvailable: vi.fn().mockReturnValue([{ name: "gemini", label: "Gemini", defaultModel: "gemini-2.5-pro" }]),
      listExecutionCandidates: vi.fn().mockReturnValue([{ name: "gemini", label: "Gemini", defaultModel: "gemini-2.5-pro" }]),
      listAvailableWithModels: vi.fn().mockResolvedValue([{ name: "gemini", label: "Gemini", defaultModel: "gemini-2.5-pro" }]),
      describeAvailable: vi.fn().mockReturnValue([]),
      getProviderCapabilities: vi.fn(),
      getActiveInfo: vi.fn().mockReturnValue(null),
      setPreference: vi.fn(),
      refreshModelCatalog: vi.fn(),
    } as any;

    registerDashboardPostBootStage({
      dashboard,
      agentManager: { _tag: "agent-manager" } as any,
      agentBudgetTracker: { _tag: "agent-budget-tracker" } as any,
      daemonContext: {
        consolidationEngine: { _tag: "consolidation-engine" },
        deploymentExecutor: { _tag: "deployment-executor" },
        readinessChecker: { _tag: "readiness-checker" },
      } as any,
      toolRegistry: {
        getAllTools: vi.fn().mockReturnValue([{ name: "tool-a", description: "Tool A" }]),
        getMetadata: vi.fn().mockReturnValue({ category: "builtin" }),
      } as any,
      taskManager: { _tag: "task-manager" } as any,
      orchestrator: { _tag: "orchestrator" } as any,
      soulLoader: { _tag: "soul-loader" } as any,
      config: makeConfig(),
      providerManager,
      userProfileStore: { _tag: "profiles" } as any,
      embeddingStatus: {
        state: "active",
        ragEnabled: true,
        configuredProvider: "auto",
        verified: true,
        usingHashFallback: false,
      },
      stradaDeps: { coreInstalled: true, mcpInstalled: false, warnings: [] } as any,
      bootReport: { _tag: "boot-report" } as any,
      providerRouter: { _tag: "provider-router" } as any,
    });

    expect(dashboard.registerAgentServices).toHaveBeenCalled();
    expect(dashboard.registerConsolidationDeploymentServices).toHaveBeenCalled();
    expect(dashboard.registerExtendedServices).toHaveBeenCalled();
    expect(dashboard.registerExtendedServices).toHaveBeenCalledWith(
      expect.objectContaining({ taskManager: expect.objectContaining({ _tag: "task-manager" }) }),
    );
    expect(dashboard.setProviderRouter).toHaveBeenCalled();
  });
});
