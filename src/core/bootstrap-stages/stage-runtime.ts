import { supportsRichMessaging } from "../../channels/channel-core.interface.js";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, readdirSync } from "node:fs";
import type { Attachment } from "../../channels/channel-messages.interface.js";
import { dirname, join } from "node:path";
import { runCodexSecondOpinion } from "../../agents/review/codex-second-opinion.js";
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
import { sanitizeSecrets } from "../../security/secret-sanitizer.js";
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
import { WorkspaceLeaseManager, DEFAULT_WORKSPACE_COPY_EXCLUDES } from "../../agents/multi/workspace-lease-manager.js";

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

    // audited 2026-09-02: task outcomes must reach the stored confidence, not
    // only factor_consistency; route them through the pipeline's evidence path.
    const learningPipeline = params.learningResult.pipeline;
    const onOutcome = learningPipeline
      ? (instinctId: string, success: boolean) => learningPipeline.recordInstinctOutcomeEvidence(instinctId, success)
      : undefined;
    instinctRetriever = deps.createInstinctRetriever?.(
      params.learningResult.patternMatcher,
      {
        scopeContext,
        storage: params.learningResult.storage,
        metricsRecorder,
        onOutcome,
      },
    ) ?? new InstinctRetriever(params.learningResult.patternMatcher, {
      scopeContext,
      storage: params.learningResult.storage,
      metricsRecorder,
      onOutcome,
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
  for (const channel of ["telegram", "discord", "slack", "web"] as const) {
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
    learningEventBus?: IEventBus<LearningEventMap>;
    identityManager?: IdentityStateManager;
    providerRouter?: Parameters<CommandHandler["setProviderRouter"]>[0];
    startupNotices: string[];
    /** Shared in-memory collector. The MessageRouter records one message per
     *  submitted batch here — see the note on MessageRouterOptions.metrics. */
    metrics?: import("../../dashboard/metrics.js").MetricsCollector;
    /** Tool registry — the real-tree guardian verifies compiles through it. */
    toolRegistry?: import("../tool-registry.js").ToolRegistry;
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
    const envExcludes = process.env["WORKSPACE_COPY_EXCLUDES"];
    const additionalExcludes = envExcludes
      ? envExcludes.split(",").map((s) => s.trim()).filter(Boolean)
      : [...DEFAULT_WORKSPACE_COPY_EXCLUDES];
    workspaceLeaseManager = new WorkspaceLeaseManager({
      projectRoot: params.config.unityProjectPath,
      additionalExcludes,
    });
  } catch (error) {
    params.logger.warn("Workspace isolation disabled for background executor", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const backgroundExecutorOptions: ConstructorParameters<typeof BackgroundExecutor>[0] = {
    orchestrator: params.orchestrator,
    concurrencyLimit: params.config.tasks.concurrencyLimit,
    // Feed the per-call stream timeout so the executor can keep the per-task
    // inactivity window strictly larger than a single legitimately-long LLM call.
    streamInitialTimeoutMs: params.config.llmStreamInitialTimeoutMs,
    decomposer: params.goalDecomposer,
    goalStorage: params.goalStorage,
    aiProvider: params.providerManager.getProvider(""),
    channel: params.channel,
    daemonEventBus,
    learningEventBus: params.learningEventBus,
    workspaceLeaseManager,
    projectPath: params.config.unityProjectPath,
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
      const safe = sanitizeSecrets(msg);
      // Only notify chats active within the idle window — avoids broadcasting
      // update notices to long-dead conversations.
      const idleWindowMs = params.config.autoUpdate.idleTimeoutMin * 60 * 1000;
      const chats = params.activityRegistry.getActiveChatIds(idleWindowMs);
      for (const { chatId } of chats) {
        const send = params.channel.sendSystemMessage
          ? params.channel.sendSystemMessage.bind(params.channel)
          : params.channel.sendMarkdown.bind(params.channel);
        send(chatId, safe).catch(() => {});
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
  // Wire the project root so `/run` can execute gated shell commands from chat.
  commandHandler.setProjectPath(params.config.unityProjectPath);

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
    ...(params.metrics ? { metrics: params.metrics } : {}),
  });

  // Campaign layer ("GDD in → finished game out"). Wired best-effort: a
  // failure here degrades the run to ordinary per-message tasks, it must
  // never block the boot.
  // The web portal's campaign card: re-pushed whenever the campaign or the
  // guardian speaks, so the card and the chat notice never disagree.
  const statusChannel = params.channel as unknown as {
    setBuildStatusProvider?: (p: import("../../channels/web/channel.js").BuildStatusProvider | null) => void;
    broadcastBuildStatus?: () => Promise<void>;
  };
  const broadcastBuildStatus = async (): Promise<void> => {
    await statusChannel.broadcastBuildStatus?.();
  };
  let campaignManager: import("../../campaign/index.js").CampaignManager | undefined;
  try {
    const { CampaignManager, CampaignPlanner, CampaignStorage } = await import("../../campaign/index.js");
    const campaignStorage = new CampaignStorage(join(params.config.memory.dbPath, "campaigns.db"));
    const { StyleAnalysis } = await import("../../agents/style/style-analysis.js");
    campaignManager = new CampaignManager({
      storage: campaignStorage,
      planner: new CampaignPlanner(params.providerManager.getProvider("")),
      // A provider that claims vision on its OWN capabilities. NEVER
      // getProvider(""): that is the fallback chain, whose vision flag is an
      // OR across members and which strips the image when it routes to a
      // text-only one — "yes I can see", answered blind (audited 2026-09-03).
      visionProvider: (params.providerManager as { getVisionProvider?: () => { provider: unknown; name: string } | null })
        .getVisionProvider?.() as never ?? null,
      taskManager,
      messenger: makeCampaignMessenger(params.channel, () => { void broadcastBuildStatus(); }),
      // The newest gameplay frame travels with the delivery report when the
      // channel can carry files (the web portal serves it under a token).
      attach: (() => {
        const rich = supportsRichMessaging(params.channel) ? params.channel : null;
        return rich ? (chatId: string, attachment: Attachment) => rich.sendAttachment(chatId, attachment) : undefined;
      })(),
      // The independent second opinion on every delivery report: Codex CLI,
      // read-only, a different model family than the one that built the game.
      independentReviewer: (params) => runCodexSecondOpinion(params),
      projectRoot: params.config.unityProjectPath,
      // The delivery gate asks the COMPILER, not the agent's report. Same tool
      // the real-tree guardian uses; a missing registry or an unregistered
      // verifier answers `ran: false`, which the gate discloses as NOT
      // MEASURED and never treats as a pass (audited 2026-09-04: a campaign
      // delivered on a tree carrying 37 compile errors).
      verifyCompile: params.toolRegistry ? makeVerifyCompile(params.toolRegistry) : undefined,
      // The delivery artifact: the campaign builds the player itself from the
      // project root through the same tool a sprint uses, and reads the
      // tool's own JSON verdict (path, size, duration) — never the worker's
      // sentence about it.
      buildPlayer: params.toolRegistry
        ? async (projectRoot: string, target?: string, evidenceRunId?: string) => {
            const registry = params.toolRegistry!;
            if (!registry.getAvailableToolNames().includes("unity_build_player")) {
              return { ran: false, detail: "unity_build_player is not registered" };
            }
            const result = await registry.execute(
              "unity_build_player",
              // The GDD's platform, when it names one: the build used to take
              // whatever target the project happened to have active (Codex
              // 2026-09-11 B#11).
              // …and the RUN this dispatch answers for, so the producer can
              // stamp a receipt Strada.Brain holds against its ticket.
              { ...(target ? { target } : {}), ...(evidenceRunId ? { evidenceRunId } : {}) },
              {
                projectPath: projectRoot,
                workingDirectory: projectRoot,
                readOnly: false,
              } as import("../../agents/tools/tool-core.interface.js").ToolContext,
            );
            const content = String(result.content ?? "");
            const receipt = extractReceipt(content);
            return { ...parsePlayerBuildOutput(content), ...(receipt === undefined ? {} : { receipt }) };
          }
        : undefined,
      // Play the artifact the campaign built: unity_run_player writes its
      // verdict under Recordings/player-playthrough, which the campaign reads.
      runPlayer: params.toolRegistry ? makeRunPlayer(params.toolRegistry) : undefined,
      styleAnalysis: new StyleAnalysis(params.providerManager.getProvider("")),
    });
    campaignManager.attachEvents();
    messageRouter.setCampaignManager(campaignManager);
    // Re-attach campaigns that were mid-sprint when the process last stopped.
    void campaignManager.resumeActive().catch((error: unknown) => {
      params.logger.warn("Campaign resume failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    params.logger.info("Campaign layer initialized");
  } catch (error) {
    params.logger.warn("Campaign layer disabled", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Real-tree guardian: the autonomous detect-and-fix loop for the project the
  // user actually opens. Measured 2026-08-27: the tree sat red for ~25h
  // because every verification loop only ever looked at leases.
  let realTreeGuardian: import("../../daemon/real-tree-guardian.js").RealTreeGuardian | undefined;
  if (params.toolRegistry && params.config.unityProjectPath) {
    try {
      const { RealTreeGuardian } = await import("../../daemon/real-tree-guardian.js");
      const registry = params.toolRegistry;
      realTreeGuardian = new RealTreeGuardian({
        taskManager,
        projectRoot: params.config.unityProjectPath,
        verify: async (projectRoot) => {
          // A missing/unreachable verifier is NOT a red tree. Treating registry
          // "tool not found" or bridge errors as compile failures fed agents
          // infrastructure noise as if it were CS errors, in an endless loop.
          if (!registry.getAvailableToolNames().includes("unity_verify_change")) {
            return { ok: true, ran: false, detail: "unity_verify_change is not registered — verification skipped" };
          }
          const result = await registry.execute(
            "unity_verify_change",
            {},
            {
              projectPath: projectRoot,
              workingDirectory: projectRoot,
              readOnly: true,
            } as import("../../agents/tools/tool-core.interface.js").ToolContext,
          );
          const detail = String(result.content ?? "");
          // PROVE THE FAILURE, do not assume it. The guardian edits the user's
          // REAL project when this says "red", so a red verdict must carry a
          // compile diagnostic. Measured live 2026-09-03 11:24: the tool
          // returned "Connection lost" — an error that matched no
          // infrastructure pattern — and the guardian declared the tree
          // uncompilable and launched an autonomous repair task against the
          // project the user was inspecting.
          // A red verdict must name at least one ERROR. Measured live
          // 2026-09-03 11:51: the tool answered
          // `{"status":"failed","reason":"Headless compile failed with 0
          // error(s)","compileErrors":0}` — a failure that contradicts itself,
          // and the guardian took it as licence to edit the user's project.
          const namedErrorCount = /(\d+)\s*(?:error\(s\)|errors?\b)/i.exec(detail)?.[1];
          const jsonErrorCount = /"compileErrors"\s*:\s*(\d+)/i.exec(detail)?.[1];
          const provenErrors =
            /error\s+CS\d+/i.test(detail)
            || (namedErrorCount !== undefined && Number(namedErrorCount) > 0)
            || (jsonErrorCount !== undefined && Number(jsonErrorCount) > 0);
          const carriesCompileDiagnostic =
            provenErrors || /compile succeeded|verification passed/i.test(detail);
          if (result.isError === true && !carriesCompileDiagnostic) {
            return { ok: true, ran: false, detail };
          }
          if (result.isError === true && !provenErrors) {
            // "failed" with nothing failing is not a measurement.
            return { ok: true, ran: false, detail };
          }
          return { ok: result.isError !== true, ran: true, detail };
        },
        // The play rung: unity_playthrough on the real tree once it compiles.
        play: makeGuardianPlay(registry),
        messenger: async (chatId, text) => {
          // Guardian notices need a human. Its own chatId defaults to
          // "cli-local", which on a non-CLI channel is a chat nobody reads —
          // route to wherever a person most recently talked instead.
          const target = taskManager.findLatestUserChat()?.chatId ?? chatId;
          await params.channel.sendMarkdown(target, sanitizeSecrets(text));
          void broadcastBuildStatus();
        },
      });
      // Every lease written back into the project earns a prompt verdict,
      // sprint or no sprint (see RealTreeGuardian.noteWriteBack).
      const guardian = realTreeGuardian;
      backgroundExecutor.setWorkspaceCommittedListener?.((info) => guardian.noteWriteBack(`write-back of ${info.taskId}`));
      realTreeGuardian.start();
      params.logger.info("Real-tree guardian started");
    } catch (error) {
      params.logger.warn("Real-tree guardian disabled", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Channels: /campaign, /measure, /guardian on every channel; GET /api/campaign
  // and the `campaign:status` frame on the web channel. Wired 2026-09-09.
  commandHandler.setCampaignManager(campaignManager);
  commandHandler.setRealTreeGuardian(realTreeGuardian);
  if (typeof statusChannel.setBuildStatusProvider === "function") {
    const { buildBuildStatus } = await import("../../campaign/build-status.js");
    const projectRoot = params.config.unityProjectPath;
    statusChannel.setBuildStatusProvider(async ({ measure }) =>
      buildBuildStatus({
        campaign: campaignManager?.describeStatus(),
        guardian: realTreeGuardian?.snapshot(),
        projectRoot,
        measure,
      }),
    );
  }

  const progressReporter = deps.createProgressReporter
    ? deps.createProgressReporter(
        params.channel,
        taskManager,
        params.config.interaction,
        params.config.language,
      )
    : new ProgressReporter(params.channel, taskManager, params.config.interaction, params.config.language);

  return {
    daemonEventBus,
    taskStorage,
    backgroundExecutor,
    taskManager,
    autoUpdater,
    projectScopeFingerprint,
    commandHandler,
    messageRouter,
    progressReporter,
    campaignManager,
    realTreeGuardian,
  };
}

/**
 * The build tool's fenced JSON verdict → campaign evidence. No JSON (the tool
 * crashed before judging, or its output was cut) is `ran: false` with the
 * first line as the reason, so the gate discloses instead of guessing.
 */
/**
 * Play the built artifact through unity_run_player. The tool's own failure is
 * THROWN: swallowed, an "unsupported artifact on this host" answer looked
 * identical to a runner that merely left no verdict, so the host exemption
 * could never fire in production (Codex 2026-09-11 D#6).
 */
/**
 * Does this path look like a player build? Existence alone authenticated the
 * claim, so any file in the repository passed — a package.json was accepted as
 * a delivered game (Codex 2026-09-11 D#12).
 */
const PLAYER_EXT_RE = /\.(?:app|apk|aab|ipa|exe|x86_64|dmg|zip)$/i;
/**
 * Smallest a packaged player can plausibly be. A game is megabytes; this floor
 * only has to be above "a file someone created to satisfy the gate" — a
 * zero-byte `empty.app` passed on its NAME alone (Codex 2026-09-11 E#2).
 */
const MIN_PLAYER_FILE_BYTES = 64 * 1024;

export function looksLikePlayer(artifactPath: string): boolean {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(artifactPath);
  } catch {
    return false;
  }
  if (st.isDirectory()) {
    // A WebGL build or a .app bundle. The entry NAMES are not the evidence —
    // `Game.app/Contents/` with nothing anywhere inside passed on its
    // directory names alone (Codex 2026-09-11 G#3). Something in there has to
    // be a file with bytes in it.
    try {
      const entries = readdirSync(artifactPath);
      // The entry page is a PAGE, not one conventional filename: a build whose
      // entry is `play.html` was refused outright, and renaming a page does
      // not invalidate its relative references (Codex 2026-09-11 L#18).
      const pages = entries.filter((e) => /\.html?$/i.test(e));
      const named = pages.length > 0 || entries.some((e) => /^(?:Build|Data|.*_Data|Contents|UnityPlayer\.(?:dll|so|dylib))$/i.test(e));
      if (!named) return false;
      // A WEB BUILD IS ITS DATA, not its page: index.html padded to 4 KB
      // passed as a game (Codex 2026-09-11 I#15). When the only named entry
      // is the page, the build folder beside it has to exist.
      // A WEB BUILD IS ITS DATA: the payload has to be INSIDE the build
      // directory, not anywhere in the folder — a padded index.html beside an
      // empty Build/ passed (Codex 2026-09-11 J#23).
      // A MAC BUNDLE IS ITS BINARY. Contents/padding.bin was accepted as a
      // player because something in there had bytes (Codex 2026-09-11 O#8).
      if (/\.app$/i.test(artifactPath) && entries.some((e) => /^Contents$/i.test(e))) {
        return holdsExecutable(join(artifactPath, "Contents", "MacOS"));
      }
      const buildDirs = entries.filter((e) => /^(?:Build|Data|.*_Data|Contents)$/i.test(e));
      if (buildDirs.length > 0) {
        // A WEB build needs its PAGE as well as its data: a Build folder
        // holding only a log, or a data file with no page at all, is not
        // something anyone can open (Codex 2026-09-11 K#12).
        // …and the page has to LOAD the build: "<html>a WebGL build</html>"
        // beside 4 KB of zeros passed as a delivered game (Codex 2026-09-11
        // L#17). A page that references no script and no build directory is
        // not something anyone can play.
        const webish = pages.some((p) => loadsSomething(join(artifactPath, p), buildDirs));
        const buildOnly = buildDirs.every((d) => /^Build$/i.test(d));
        if (buildOnly && !webish) return false;
        return buildDirs.some((dir) => holdsGameData(join(artifactPath, dir), 3));
      }
      // A player library at the top level is a build of its own shape.
      const hasPlayerLib = entries.some((e) => /^UnityPlayer\.(?:dll|so|dylib)$/i.test(e));
      return hasPlayerLib && holdsPayload(artifactPath, 3);
    } catch {
      return false;
    }
  }
  // A FILE with a player extension: the extension says what it CLAIMS to be
  // and the first bytes say whether it is one. 131 072 bytes of ASCII "x"
  // named Padded.apk passed the size floor (G#3).
  if (PLAYER_EXT_RE.test(artifactPath)) {
    return st.size >= MIN_PLAYER_FILE_BYTES && hasPackageMagic(artifactPath);
  }
  // A bare Linux/macOS executable has no extension; require it to be
  // executable and not trivially small.
  return st.size > 1024 * 1024 && (st.mode & 0o111) !== 0 && !/\.[a-z0-9]{1,6}$/i.test(artifactPath);
}

/** A real executable inside a macOS bundle's MacOS directory. */
function holdsExecutable(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    try {
      const st = statSync(join(dir, entry));
      if (st.isFile() && st.size >= MIN_BUNDLE_PAYLOAD_BYTES && (st.mode & 0o111) !== 0) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** Smallest file inside a bundle that counts as payload rather than metadata. */
const MIN_BUNDLE_PAYLOAD_BYTES = 4 * 1024;

/**
 * A real file that is not a LOG: a Build folder containing only build.log
 * passed as a web game (Codex 2026-09-11 K#12).
 */
function holdsGameData(dir: string, depth: number): boolean {
  if (depth <= 0) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (/\.(?:log|txt|md|json)$/i.test(entry)) continue;
    const child = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(child);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (holdsGameData(child, depth - 1)) return true;
    } else if (st.size >= MIN_BUNDLE_PAYLOAD_BYTES) {
      return true;
    }
  }
  return false;
}

/** Does this directory hold a real file somewhere in its first few levels? */
function holdsPayload(dir: string, depth: number): boolean {
  if (depth <= 0) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const child = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(child);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (holdsPayload(child, depth - 1)) return true;
    } else if (st.size >= MIN_BUNDLE_PAYLOAD_BYTES) {
      return true;
    }
  }
  return false;
}

/** How much of a file has to be something other than zero padding. */
const MIN_SUBSTANCE_RATIO = 0.02;

/**
 * A web entry page that actually LOADS the build beside it: a script, a
 * module, or a reference into one of the build directories. A page naming
 * none of them is prose with an .html extension (Codex 2026-09-11 L#17).
 */
function loadsSomething(page: string, buildDirs: readonly string[]): boolean {
  let text: string;
  try {
    text = readFileSync(page, "latin1").slice(0, 256 * 1024);
  } catch {
    return false;
  }
  // The page has to load something that EXISTS: a lone
  // "<script>console.log('hello')</script>" is not a game (Codex 2026-09-11 O#8).
  const dir = dirname(page);
  for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = m[1];
    if (ref === undefined || /^(?:https?:)?\/\//i.test(ref) || ref.startsWith("data:")) continue;
    if (existsSync(join(dir, ref.split("?")[0] ?? ref))) return true;
  }
  // …or it names the build directory beside it, which was measured separately.
  return buildDirs.some((d) => new RegExp(`\\b${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "i").test(text));
}

/**
 * Is there anything in this file but its header? 65 536 bytes of which five
 * are an ELF header and 65 531 are zeros passed every magic-byte check, the
 * runner's "exec format error" was waived as host incompatibility, and the
 * campaign delivered a game that did not exist (Codex 2026-09-11 L#17).
 */
function hasSubstance(path: string, size: number): boolean {
  const window = 8192;
  const offsets = [Math.floor(size / 2), Math.max(0, size - window)];
  let nonZero = 0;
  let read = 0;
  try {
    const fd = openSync(path, "r");
    try {
      for (const at of offsets) {
        const buf = Buffer.alloc(Math.min(window, Math.max(0, size - at)));
        if (buf.length === 0) continue;
        readSync(fd, buf, 0, buf.length, at);
        read += buf.length;
        for (const b of buf) if (b !== 0) nonZero++;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  return read > 0 && nonZero / read >= MIN_SUBSTANCE_RATIO;
}

/**
 * The end-of-central-directory record every real ZIP container ends with —
 * and the directory it points at.
 *
 * A signature plus padding was accepted as a package: random bytes beginning
 * "PK\x03\x04" and containing "PK\x05\x06" near the end passed with no
 * entries in them at all (Codex 2026-09-11 O#8).
 */
function hasZipDirectory(path: string, size: number): boolean {
  const window = Math.min(size, 66_000);
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(window);
      readSync(fd, buf, 0, window, size - window);
      const at = buf.lastIndexOf(Buffer.from("PK\u0005\u0006", "latin1"));
      if (at < 0 || at + 22 > buf.length) return false;
      const entries = buf.readUInt16LE(at + 10);
      const directoryOffset = buf.readUInt32LE(at + 16);
      if (entries === 0 || directoryOffset === 0 || directoryOffset >= size) return false;
      // …and the offset must point AT the central directory.
      const head = Buffer.alloc(4);
      readSync(fd, head, 0, 4, directoryOffset);
      return head.toString("latin1") === "PK\u0001\u0002";
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** The PE signature a Windows executable's DOS header points at. */
function hasPeSignature(path: string, size: number): boolean {
  try {
    const fd = openSync(path, "r");
    try {
      const at = Buffer.alloc(4);
      readSync(fd, at, 0, 4, 0x3c);
      const offset = at.readUInt32LE(0);
      if (offset <= 0 || offset + 4 > size) return false;
      const sig = Buffer.alloc(4);
      readSync(fd, sig, 0, 4, offset);
      return sig.toString("latin1") === "PE\u0000\u0000";
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * An ELF header that declares an EXECUTABLE for a machine — not five bytes
 * of magic. e_type 2 (EXEC) or 3 (DYN, what a PIE build is), e_machine set.
 */
function hasElfProgram(path: string): boolean {
  try {
    const fd = openSync(path, "r");
    try {
      const head = Buffer.alloc(20);
      readSync(fd, head, 0, 20, 0);
      const little = head[5] === 1;
      const type = little ? head.readUInt16LE(16) : head.readUInt16BE(16);
      const machine = little ? head.readUInt16LE(18) : head.readUInt16BE(18);
      return (type === 2 || type === 3) && machine !== 0;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * The first bytes of a packaged player: a ZIP container (apk/aab/ipa/zip), a
 * Windows executable, or a macOS Mach-O / universal binary. A `.dmg` is
 * checked only for size, since its header varies by creator.
 */
function hasPackageMagic(path: string): boolean {
  let head: Buffer;
  try {
    const fd = openSync(path, "r");
    try {
      head = Buffer.alloc(4);
      readSync(fd, head, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  const magic = head.readUInt32BE(0);
  // The MAGIC IS A COSTUME: every check below used to stop at the first bytes,
  // so a header followed by zeros authenticated a player that did not exist
  // (Codex 2026-09-11 L#17). Each format is now asked for the structure that
  // makes it loadable, and every artifact for content behind its header.
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return false;
  }
  if (!hasSubstance(path, size)) return false;
  if (/\.(?:apk|aab|ipa|zip)$/i.test(path)) return head.toString("latin1", 0, 2) === "PK" && hasZipDirectory(path, size);
  if (/\.exe$/i.test(path)) return head.toString("latin1", 0, 2) === "MZ" && hasPeSignature(path, size);
  // A LINUX player is an ELF binary, and this branch demanded Mach-O of it —
  // so a perfectly good .x86_64 build was refused (Codex 2026-09-11 I#15).
  // All four bytes: checking only "ELF" from byte one accepted "AELF"
  // (Codex 2026-09-11 J#23).
  // The magic AND the class byte AND the executable bit: four bytes followed
  // by 65 532 zeros, mode 0644, is not a player (Codex 2026-09-11 K#12).
  if (/\.x86_64$/i.test(path)) {
    if (!(head[0] === 0x7f && head.toString("latin1", 1, 4) === "ELF")) return false;
    try {
      const st = statSync(path);
      const cls = Buffer.alloc(1);
      const fd = openSync(path, "r");
      try {
        readSync(fd, cls, 0, 1, 4);
      } finally {
        closeSync(fd);
      }
      // 1 = 32-bit, 2 = 64-bit; anything else is not an ELF header. And the
      // header has to declare a program for a machine (L#17).
      return (cls[0] === 1 || cls[0] === 2) && (st.mode & 0o111) !== 0 && hasElfProgram(path);
    } catch {
      return false;
    }
  }
  if (/\.app$/i.test(path)) {
    // Mach-O 32/64 in both byte orders, and the universal (fat) header.
    return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic);
  }
  // A .dmg carries no single stable header; its size is the only check.
  return true;
}

/**
 * What the built player's run is allowed to take, derived from the document's
 * own numbers rather than the tool's defaults (Codex 2026-09-12 T#8).
 */
export interface PlayerRunSpec {
  /** "all", "1-3", "2,5" — which sessions to play. */
  readonly sessions?: string;
  readonly maxActions?: number;
  readonly deadlineSeconds?: number;
  readonly bootDeadlineSeconds?: number;
  /**
   * Does the DOCUMENT require a session to end in a win or a lose state?
   *
   * A producer cannot know a game's win condition, and it refused every
   * endless or sandbox session as "never ended" — a verdict no correct
   * implementation could satisfy (Codex 2026-09-13 AG#3). The document can
   * say, so the campaign reads it and tells the producer.
   */
  readonly outcomeRequired?: boolean;
}

/**
 * The delivery gate's compile verdict, from the COMPILER rather than a report.
 *
 * A missing registry or an unregistered verifier answers `ran: false`, which
 * the gate discloses as NOT MEASURED and never treats as a pass (audited
 * 2026-09-04: a campaign delivered on a tree carrying 37 compile errors).
 */
export function makeVerifyCompile(
  registry: {
    getAvailableToolNames(): readonly string[];
    execute(name: string, input: Record<string, unknown>, context: never): Promise<{ content?: unknown; isError?: boolean }>;
  },
): (projectRoot: string) => Promise<{ ok: boolean; ran: boolean; errors?: number; detail?: string }> {
  return async (projectRoot: string) => {
            if (!registry.getAvailableToolNames().includes("unity_verify_change")) {
              return { ok: false, ran: false, detail: "unity_verify_change is not registered" };
            }
            const result = await registry.execute(
              "unity_verify_change",
              {},
              {
                projectPath: projectRoot,
                workingDirectory: projectRoot,
                readOnly: true,
              } as never,
            );
            const detail = String(result.content ?? "");
            const counted = /"compileErrors"\s*:\s*(\d+)/i.exec(detail)?.[1]
              ?? /(\d+)\s*error\(s\)/i.exec(detail)?.[1];
            const errors = counted === undefined ? undefined : Number(counted);
            // THE TOOL'S OWN ERROR FLAG, read AFTER the count. It was never
            // read at all, so "Unity Editor executable not found" and
            // "Operation timed out" both reported a zero-error compile (Codex
            // 2026-09-12 R#5) — but reading it first turned a COMPLETED
            // compile that found 37 errors into "not run", which the non-final
            // gate does not treat as broken at all (S#2). A counted error is
            // the compiler's answer whatever the flag says; a flag with no
            // count is a tool that did not get to answer.
            if (result.isError === true) {
              return errors !== undefined && errors > 0
                ? { ok: false, ran: true, errors, detail: detail.slice(0, 300) }
                : { ok: false, ran: false, detail: detail.slice(0, 300) || "the compile tool reported an error" };
            }
            // A "failed" with no counted error is the killed-compile shape:
            // real, but it says nothing about the CODE, so it is reported as
            // not measured rather than as a compile error the sprint can fix.
            const failed = /"status"\s*:\s*"failed"/i.test(detail);
            if (failed && (errors === undefined || errors === 0)) {
              return { ok: false, ran: false, errors, detail: detail.slice(0, 300) };
            }
            // A COMPILE IS PROVEN, not assumed: either the errors were counted
            // or the tool said in so many words that it succeeded. Anything
            // else is unmeasured, which the gate discloses and never passes.
            // A COUNT IS ONLY AN ANSWER WHEN THE COMPILE FINISHED. A reply
            // carrying "verified": false, "status": "unknown", or a compile
            // still in progress has a zero in it that means nothing (Codex
            // 2026-09-12 S#2).
            const unfinished = /"verified"\s*:\s*false|"status"\s*:\s*"(?:unknown|compiling|in[_ -]?progress|pending)"|\bstill compiling\b/i.test(detail);
            if (unfinished) {
              return { ok: false, ran: false, detail: detail.slice(0, 300) };
            }
            const said = /"(?:lastSucceeded|success|compiled)"\s*:\s*true|"exitCode"\s*:\s*0|"status"\s*:\s*"(?:ok|success|succeeded|passed)"/i.test(detail);
            if (errors === undefined && !said) {
              return { ok: false, ran: false, detail: detail.slice(0, 300) || "the compile tool answered nothing measurable" };
            }
            return {
              ok: !failed && (errors ?? 0) === 0,
              ran: true,
              ...(errors === undefined ? {} : { errors }),
              detail: detail.slice(0, 300),
            };
  };
}

export function makeRunPlayer(registry: {
  getAvailableToolNames(): readonly string[];
  execute(name: string, input: Record<string, unknown>, context: unknown): Promise<{ content?: unknown; isError?: boolean }>;
}): (projectRoot: string, artifactPath: string, spec?: PlayerRunSpec) => Promise<void> {
  return async (projectRoot, artifactPath, spec) => {
    if (!registry.getAvailableToolNames().includes("unity_run_player")) throw new Error("unity_run_player is not registered");
    // THE REQUIREMENT SETS THE ALLOWANCES. Only the artifact was passed, so
    // the run always used the tool's defaults — 45 seconds a session, 60
    // actions, a 30-second boot — and a game whose own document asks for a
    // 90-second round, or more than sixty moves, could not be played to its
    // outcome at all (Codex 2026-09-12 T#8).
    const result = await registry.execute(
      "unity_run_player",
      {
        artifactPath,
        ...(spec?.sessions !== undefined ? { sessions: spec.sessions } : {}),
        ...(spec?.maxActions !== undefined ? { maxActions: spec.maxActions } : {}),
        ...(spec?.deadlineSeconds !== undefined ? { deadlineSeconds: spec.deadlineSeconds } : {}),
        ...(spec?.bootDeadlineSeconds !== undefined ? { bootDeadlineSeconds: spec.bootDeadlineSeconds } : {}),
        ...(spec?.outcomeRequired === undefined ? {} : { outcomeRequired: spec.outcomeRequired }),
      },
      { projectPath: projectRoot, workingDirectory: projectRoot, readOnly: false },
    );
    // THE WHOLE REFUSAL, not its first 300 characters: the producer names the
    // artifact first, so three long directory components pushed "is not a
    // player this machine can run" past the cut and the campaign saw a
    // missing proof with no cause (Codex 2026-09-12 AB J2.4). The campaign
    // truncates for display where it needs to.
    if (result.isError === true) throw new Error(String(result.content ?? "unity_run_player failed").slice(0, 2000));
  };
}

export function parsePlayerBuildOutput(content: string): import("../../campaign/types.js").PlayerBuildEvidence {
  const fence = /```json\s*\n([\s\S]*?)\n\s*```/.exec(content);
  if (!fence?.[1]) return { ran: false, detail: content.split("\n")[0]?.slice(0, 200) || "the build tool returned no verdict" };
  let parsed: {
    ok?: unknown;
    reasons?: unknown;
    result?: { target?: unknown; durationMs?: unknown; scenes?: unknown } | null;
    artifact?: { path?: unknown; exists?: unknown; sizeBytes?: unknown } | null;
    measuredAt?: unknown;
  };
  try {
    parsed = JSON.parse(fence[1]);
  } catch {
    return { ran: false, detail: "the build tool's verdict was not valid JSON" };
  }
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  // A build is ok when its artifact exists on disk; "ok" without an artifact
  // was accepted as a successful build and then skipped the player run
  // because there was nothing to play (Codex 2026-09-11 B#3).
  // The producer's own Boolean is a claim; the file system is the measurement
  // (Codex 2026-09-11 C#12).
  const artifactPath = typeof parsed.artifact?.path === "string" && parsed.artifact.path.length > 0 ? parsed.artifact.path : undefined;
  const artifactExists =
    parsed.artifact?.exists === true && artifactPath !== undefined && existsSync(artifactPath) && looksLikePlayer(artifactPath);
  const ok = parsed.ok === true && artifactExists;
  const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String).slice(0, 8) : [];
  if (parsed.ok === true && !artifactExists) {
    reasons.push(artifactPath === undefined
      ? "the build reported ok but named no artifact"
      : !existsSync(artifactPath)
      ? `the build reported ok but ${artifactPath} is not on disk`
      : `the build reported ok but ${artifactPath} is not a player artifact (expected an app bundle, executable, apk/aab/ipa or a WebGL folder)`);
  }
  return {
    ran: true,
    ok,
    reasons,
    target: str(parsed.result?.target),
    durationMs: num(parsed.result?.durationMs),
    scenes: Array.isArray(parsed.result?.scenes) ? parsed.result!.scenes.length : undefined,
    ...(parsed.artifact?.exists === true ? { artifactPath: str(parsed.artifact.path), sizeBytes: num(parsed.artifact.sizeBytes) } : {}),
    detail: content.split("\n")[0]?.slice(0, 200),
    measuredAt: str(parsed.measuredAt),
  };
}

/**
 * The guardian's play rung: unity_playthrough on the real tree.
 *
 * Its verdict rides in a fenced JSON block at the end of the content; `ok`
 * there is the measurement, the prose above it is for people. Exported so the
 * interpretation itself can be tested — it used to accept a fenced
 * `{"ok":true}` with the tool's error flag set and no record of play at all
 * (Codex 2026-09-13 AF#9).
 */
export function makeGuardianPlay(
  registry: { getAvailableToolNames(): string[]; execute(name: string, input: Record<string, unknown>, ctx: unknown): Promise<{ content?: unknown; isError?: boolean }> },
): (projectRoot: string) => Promise<{ ok: boolean; ran: boolean; detail: string }> {
  return async (projectRoot: string) => {
  if (!registry.getAvailableToolNames().includes("unity_playthrough")) {
    return { ok: true, ran: false, detail: "unity_playthrough is not registered — the play rung is skipped" };
  }
  const result = await registry.execute(
    "unity_playthrough",
    {},
    {
      projectPath: projectRoot,
      workingDirectory: projectRoot,
      readOnly: false,
    } as import("../../agents/tools/tool-core.interface.js").ToolContext,
  );
  const detail = String(result.content ?? "");
  const fenced = /```json\s*\n([\s\S]*?)\n```/.exec(detail)?.[1];
  if (!fenced) {
    // No verdict block at all: the editor did not run, or the tool
    // refused before playing. Not a measurement of the game.
    return { ok: true, ran: false, detail: detail.slice(0, 1500) };
  }
  try {
    const verdict = JSON.parse(fenced) as {
      ok?: unknown;
      reasons?: unknown;
      record?: { session?: unknown; actions?: unknown; outcome?: unknown; sessions?: unknown };
    };
    const reasons = Array.isArray(verdict.reasons) ? verdict.reasons.map(String) : [];
    // A VERDICT IS A RECORD OF PLAY, not the word "ok". A fenced
    // `{"ok":true}` — with the tool's own error flag set, no session,
    // no action and no outcome — was accepted as a played game, and
    // the guardian then cleared its play obligation (Codex
    // 2026-09-13 AF#9). A block with nothing in it measured nothing:
    // that is "did not run", so the rung stays pending instead of
    // becoming a game failure that provokes repairs.
    const record = verdict.record;
    const sessions = Array.isArray(record?.sessions) ? record.sessions : [];
    const played =
      sessions.length > 0
      || (typeof record?.actions === "number" && record.actions > 0)
      || (typeof record?.outcome === "string" && record.outcome.trim() !== "");
    if (!played) {
      return {
        ok: true,
        ran: false,
        detail: `the play-through verdict carries no record of play (no session, action or outcome)\n\n${detail.slice(0, 1200)}`,
      };
    }
    // THE TOOL'S OWN ERROR FLAG COUNTS: a producer that reports an
    // error and "ok" at once has not played the game cleanly.
    const ok = verdict.ok === true && result.isError !== true;
    return {
      ok,
      ran: true,
      detail: ok ? detail.slice(0, 600) : `${reasons.join("; ")}\n\n${detail.slice(0, 1200)}`,
    };
  } catch {
    return { ok: true, ran: false, detail: detail.slice(0, 1500) };
  }
};
}

/** The fenced block a producer stamps for the run it was asked to answer for. */
export const EVIDENCE_FENCE = "strada-evidence";

/**
 * The producer's receipt, verbatim, out of its own report.
 *
 * Verbatim matters: the receiver hashes the bytes it validates, so anything
 * that re-serialises the record breaks the identity it is there to establish
 * (Codex 2026-09-12 AB).
 */
export function extractReceipt(content: string): string | undefined {
  const match = new RegExp("```" + EVIDENCE_FENCE + "\\s*\\n([\\s\\S]*?)\\n```").exec(content);
  const body = match?.[1]?.trim();
  return body === undefined || body === "" ? undefined : body;
}

/**
 * The campaign's messenger: markdown out, and an HONEST answer about whether
 * it left.
 *
 * A channel that buffers a frame for the next reconnect resolves exactly like
 * one that sent it, so a delivery report produced while the browser was
 * offline was recorded as reported — and a restart then dropped it unread
 * (Codex 2026-09-13 AG#13). A channel that can tell the difference is asked;
 * one that cannot is used exactly as before.
 */
export function makeCampaignMessenger(
  channel: {
    sendMarkdown(chatId: string, markdown: string): Promise<void>;
    sendMarkdownDelivered?(chatId: string, markdown: string): Promise<boolean>;
  },
  afterSend: () => void,
): (chatId: string, markdown: string) => Promise<void> {
  return async (chatId: string, markdown: string) => {
    const text = sanitizeSecrets(markdown);
    if (typeof channel.sendMarkdownDelivered === "function") {
      const delivered = await channel.sendMarkdownDelivered(chatId, text);
      afterSend();
      if (!delivered) {
        throw new Error("the message was queued for a client that is not connected — nobody has read it yet");
      }
      return;
    }
    await channel.sendMarkdown(chatId, text);
    afterSend();
  };
}
