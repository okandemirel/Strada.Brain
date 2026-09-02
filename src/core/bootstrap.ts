/**
 * Application Bootstrap
 *
 * Handles initialization of all services and wires up dependencies.
 * Replaces the monolithic startBrain() function from index.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "../config/config.js";
import { type DurationMs } from "../types/index.js";
import { createLogger } from "../utils/logger.js";
import { AuthManager } from "../security/auth.js";
import { configureAuthManager } from "../security/auth-hardened.js";
import { configureProviderConcurrency } from "../common/fetch-with-retry.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { resolveConversationScope } from "../agents/orchestrator-text-utils.js";
import { MetricsCollector } from "../dashboard/metrics.js";
import { setSanitizationCallback } from "../security/secret-sanitizer.js";
import { CachedEmbeddingProvider } from "../rag/embeddings/embedding-cache.js";
import { HashEmbeddingProvider } from "../rag/embeddings/hash-embeddings.js";
import { RAGPipeline } from "../rag/rag-pipeline.js";
import { FileVectorStore } from "../rag/vector-store.js";
import { type DIContainer, createContainer } from "./di-container.js";
import { ToolRegistry } from "./tool-registry.js";
import { checkStradaDeps } from "../config/strada-deps.js";
import type { FrameworkKnowledgeStore } from "../intelligence/framework/framework-knowledge-store.js";
import type { FrameworkSyncPipeline } from "../intelligence/framework/framework-sync-pipeline.js";
import {
  LEARNING_DEFAULTS,
} from "../common/constants.js";
import {
  finalizeChannelStartupStage,
  initializeGoalContextStage,
  initializeDaemonHeartbeatStage,
  initializeDeploymentStage,
  initializeKnowledgeStage,
  initializeMemoryConsolidationStage,
  initializeMultiAgentDelegationStage,
  initializeOpsMonitoringStage,
  initializeProviderRuntimeStage,
  initializeRuntimeIntelligenceStage,
  initializeRuntimeStateStage,
  initializeSessionRuntimeStage,
  initializeTaskRuntimeStage,
  initializeSupervisorStage,
  initializeToolChainStage,
  initializeToolRegistryStage,
  registerDashboardPostBootStage,
  type LearningResult,
  type RAGResult,
} from "./bootstrap-stages.js";
import type * as winston from "winston";
import { resolveRuntimeUnityProjectPath } from "./runtime-unity-project.js";
import { describeFrameworkInstall } from "../agents/tools/strada/module-folders.js";
import type { GoalStorage } from "../goals/goal-storage.js";

// Learning system imports
import {
  LearningStorage,
  LearningPipeline,
  ErrorLearningHooks,
  PatternMatcher,
  ConfidenceScorer,
} from "../learning/index.js";
import { TypedEventBus, type IEventBus, type LearningEventMap } from "./event-bus.js";
import { LearningQueue } from "../learning/pipeline/learning-queue.js";
import { ErrorRecoveryEngine } from "../agents/autonomy/error-recovery.js";
import { TaskPlanner } from "../agents/autonomy/task-planner.js";
import { buildCapabilityManifest } from "../agents/context/strada-knowledge.js";
import { MigrationRunner } from "../learning/storage/migrations/index.js";
import { migration001CrossSessionProvenance } from "../learning/storage/migrations/001-cross-session-provenance.js";
// Multi-agent type-only imports (Plan 23-03: AGENT-01, AGENT-06, AGENT-07)
import type { AgentManager as AgentManagerType } from "../agents/multi/agent-manager.js";
import type { AgentBudgetTracker as AgentBudgetTrackerType } from "../agents/multi/agent-budget-tracker.js";
// Delegation type-only imports (Plan 24-03: AGENT-03, AGENT-04, AGENT-05)
import type { DelegationManager as DelegationManagerType } from "../agents/multi/delegation/delegation-manager.js";

// Daemon imports
import { HeartbeatLoop } from "../daemon/heartbeat-loop.js";
import { NotificationRouter } from "../daemon/reporting/notification-router.js";
import { DigestReporter } from "../daemon/reporting/digest-reporter.js";
import type { DaemonEventMap } from "../daemon/daemon-events.js";
import { DaemonStorage } from "../daemon/daemon-storage.js";
import { UnifiedBudgetManager } from "../budget/unified-budget-manager.js";
import { ProviderHealthRegistry } from "../agents/providers/provider-health.js";

// Workspace / monitor bridge imports
import { createWorkspaceBus, type WorkspaceBus } from "../dashboard/workspace-bus.js";
import { createLearningWorkspaceBridge } from "../dashboard/learning-workspace-bridge.js";
import { createTaskWorkspaceBridge } from "../dashboard/task-workspace-bridge.js";
import { createMonitorBridge } from "../dashboard/monitor-bridge.js";
import { createWorkspaceRuntimeBridge } from "../dashboard/workspace-runtime-bridge.js";
import { CanvasStorage } from "../dashboard/canvas-storage.js";
import { createMonitorLifecycle, type MonitorLifecycle } from "../dashboard/monitor-lifecycle.js";
import Database from "better-sqlite3";

// Auto-update imports
import { ChannelActivityRegistry } from "./channel-activity-registry.js";
import { AutoUpdater } from "./auto-updater.js";
import type { PostSetupBootstrap } from "../common/setup-contract.js";

// Task system imports
import { MessageRouter } from "../tasks/index.js";
import { buildTaskProgressSummary } from "../tasks/progress-signals.js";
import type { BackgroundExecutor } from "../tasks/background-executor.js";
import { resolveFlagSetById, PRODUCTION_DEFAULT_FLAG_SET_ID } from "../agent-core/runner/index.js";
import {
  CapabilityRegistry,
  CAPABILITY_MCP_STRADA,
  type CapabilityAdapter,
  seedCapabilities,
  SystemClock,
} from "../agent-core/control/index.js";

import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { NodeResult, SupervisorContext, TaggedGoalNode } from "../supervisor/supervisor-types.js";

// Extracted helpers — imported and re-exported for backward compatibility
import {
  initializeAIProvider as _initializeAIProvider,
  resolveAndCacheEmbeddings as _resolveAndCacheEmbeddings,
  isTransientEmbeddingVerificationError as _isTransientEmbeddingVerificationError,
} from "./bootstrap-providers.js";
import {
  initializeMemory as _initializeMemory,
} from "./bootstrap-memory.js";
import {
  initializeChannel as _initializeChannel,
  initializeDashboard as _initializeDashboard,
  initializeRateLimiter as _initializeRateLimiter,
} from "./bootstrap-channels.js";
import {
  BootstrapDisposables,
  wireMessageHandler as _wireMessageHandler,
  setupCleanup as _setupCleanup,
  createShutdownHandler as _createShutdownHandler,
  generateSessionId as _generateSessionId,
} from "./bootstrap-wiring.js";
import { transcribeIncomingAudioMessage } from "./incoming-audio-transcription.js";
import { fireDevKnowledgeCompletionNote } from "../vault/dev-knowledge-writer.js";

// Re-export for backward compatibility (tests and other modules import these from bootstrap.js)
export const initializeAIProvider = _initializeAIProvider;
export const resolveAndCacheEmbeddings = _resolveAndCacheEmbeddings;
export const isTransientEmbeddingVerificationError = _isTransientEmbeddingVerificationError;
export const initializeMemory = _initializeMemory;

// Local aliases for internal use
const initializeChannel = _initializeChannel;
const initializeDashboard = _initializeDashboard;
const initializeRateLimiter = _initializeRateLimiter;
const wireMessageHandler = _wireMessageHandler;
const setupCleanup = _setupCleanup;
const createShutdownHandler = _createShutdownHandler;
const generateSessionId = _generateSessionId;

export function createSupervisorExecuteNodeBridge(params: {
  backgroundExecutor: Pick<BackgroundExecutor, "runWorkerEnvelope">;
  orchestrator: Orchestrator;
  workspaceBus?: WorkspaceBus | null;
  defaultChannelType?: string;
}): (node: TaggedGoalNode, context: SupervisorContext, signal: AbortSignal) => Promise<NodeResult> {
  return async (node, context, signal) => {
    let lastNarrative = "";
    let lastNarrativeAt = 0;
    const nodeTaskRunId = `${context.taskRunId?.trim() || `supervisor:${context.chatId}`}:${node.id}`;
    const startedAt = Date.now();
    // The worker's tool evidence, in the shape deriveTestVerdict reads. Every
    // production NodeResult carried `toolResults: []`, so a supervised sprint
    // whose Unity node printed "3 of 40 tests failed" produced NO mechanical
    // verdict and the campaign's red gate never fired (audited 2026-09-02).
    const toNodeToolResults = (
      workerResult?: { toolTrace?: readonly { summary: string; success: boolean }[] },
    ): NodeResult["toolResults"] =>
      (workerResult?.toolTrace ?? []).map((t, i) => ({
        toolCallId: `trace-${i}`,
        content: t.summary,
        isError: !t.success,
      }));
    const toNodeArtifacts = (workerResult?: { touchedFiles?: readonly string[] }) =>
      (workerResult?.touchedFiles ?? []).map((path) => ({ path, action: "modify" as const }));
    try {
      const goalRootId = context.goalTree ? String(context.goalTree.rootId) : undefined;
      // Carry the upstream results this node depends on. A wave-3 worker used
      // to receive its one-line task and NOTHING of what waves 1–2 produced —
      // preserved completed-node results were written and never read.
      let nodePrompt = node.task;
      if (context.goalTree && node.dependsOn.length > 0) {
        const depLines: string[] = [];
        for (const depId of node.dependsOn) {
          const dep = context.goalTree.nodes.get(depId);
          if (dep?.status === "completed" && dep.result) {
            depLines.push(`- ${dep.task}\n  Result: ${dep.result.slice(0, 600)}`);
          }
        }
        if (depLines.length > 0) {
          nodePrompt =
            `${node.task}\n\n## Completed dependencies (build on these; do not redo them)\n${depLines.join("\n")}`;
        }
      }
      const result = await params.backgroundExecutor.runWorkerEnvelope(params.orchestrator, {
        mode: "delegated",
        prompt: nodePrompt,
        chatId: context.chatId,
        channelType: context.channelType ?? params.defaultChannelType ?? "cli",
        conversationId: context.conversationId,
        userId: context.userId,
        // PRODUCER: stamp the originating request's parent scope — the SAME scope the supervisor
        // uses for its own dag_init/task_update (supervisor-brain.ts) — so every supervisor-
        // decomposed sub-goal worker's monitor episode JOINs the parent goal's ONE dropdown
        // conversation (isMonitorRootRun=false → joinEpisode) instead of minting a sibling.
        // MONITOR-only — the worker's chatId/conversationId/session/identity stay fresh.
        // Confined to this bridge + strictly the originating request's scope (no cross-conv bleed).
        monitorScope: resolveConversationScope(context.chatId, context.conversationId),
        taskRunId: nodeTaskRunId,
        assignedProvider: node.assignedProvider,
        assignedModel: node.assignedModel,
        attachments: context.attachments,
        userContent: context.userContent,
        onUsage: context.onUsage,
        // Nodes share the task's lease. Per-node CHILD leases were tried
        // 2026-09-01 to unlock wave parallelism and reverted the same day:
        // a lease derived from another lease is a temp copy, so (a) it has no
        // .git — every git_* tool and the "commit per logical unit" rule fail
        // inside a node, (b) commitLease takes the project write lock only
        // when sourceRoot === projectRoot, so node commits took NO lock, and
        // a sibling that touched the same file had its work quarantined into
        // the PARENT lease's .strada — deleted with the parent on release.
        // Wave parallelism needs per-node leases that are real worktrees off
        // the project root plus lock-covered commits; until that exists the
        // shared lease (and the supervisor's clamp) is the correct trade.
        workspaceLease: context.workspaceLease,
        signal: signal ?? context.signal ?? AbortSignal.timeout(300_000),
        ...(goalRootId ? { goalContext: { rootId: goalRootId, nodeId: String(node.id) } } : {}),
        onProgress: (update) => {
          const narrative = buildTaskProgressSummary(
            { title: node.task, prompt: node.task },
            update,
            "en",
          );
          const now = Date.now();
          if (
            !params.workspaceBus ||
            (!narrative || (narrative === lastNarrative && now - lastNarrativeAt < 1500))
          ) {
            return;
          }
          lastNarrative = narrative;
          lastNarrativeAt = now;
          params.workspaceBus.emit("progress:narrative", {
            nodeId: String(node.id),
            narrative,
            lang: narrative.startsWith("Aşama:") ? "tr" : "en",
          });
        },
        supervisorMode: "off",
      });

      if (result.workerResult?.status === "blocked") {
        return {
          nodeId: node.id,
          status: "failed" as const,
          output: result.workerResult.reason ?? result.output ?? "Worker blocked",
          blockedReason: result.workerResult.reason ?? result.output ?? "Worker blocked",
          artifacts: toNodeArtifacts(result.workerResult),
          toolResults: toNodeToolResults(result.workerResult),
          provider: result.workerResult.provider ?? node.assignedProvider ?? "unknown",
          model: result.workerResult.model ?? node.assignedModel ?? "unknown",
          cost: 0,
          duration: Date.now() - startedAt,
        };
      }

      if (result.workerResult?.status === "failed") {
        return {
          nodeId: node.id,
          status: "failed" as const,
          output: result.workerResult.reason ?? result.output ?? "Worker failed",
          artifacts: toNodeArtifacts(result.workerResult),
          toolResults: toNodeToolResults(result.workerResult),
          provider: result.workerResult.provider ?? node.assignedProvider ?? "unknown",
          model: result.workerResult.model ?? node.assignedModel ?? "unknown",
          cost: 0,
          duration: Date.now() - startedAt,
        };
      }

      return {
        nodeId: node.id,
        status: "ok" as const,
        output: result.output ?? "",
        artifacts: toNodeArtifacts(result.workerResult),
        toolResults: toNodeToolResults(result.workerResult),
        provider: result.workerResult?.provider ?? node.assignedProvider ?? "unknown",
        model: result.workerResult?.model ?? node.assignedModel ?? "unknown",
        cost: 0,
        duration: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        nodeId: node.id,
        status: "failed" as const,
        output: String(err),
        artifacts: [],
        toolResults: [],
        provider: node.assignedProvider ?? "unknown",
        model: node.assignedModel ?? "unknown",
        cost: 0,
        duration: Date.now() - startedAt,
      };
    }
  };
}

export function initializeWorkspaceRuntime(params: {
  learningEventBus?: IEventBus<LearningEventMap>;
  daemonEventBus?: IEventBus<DaemonEventMap>;
  channel: { broadcastRaw?: (msg: string) => void };
  orchestrator: Pick<Orchestrator, "setWorkspaceBus" | "setMonitorLifecycle" | "setGoalStorage">;
  backgroundExecutor: Pick<BackgroundExecutor, "setWorkspaceBus" | "setMonitorLifecycle" | "runWorkerEnvelope">;
  supervisorBrain?: {
    setExecuteNode: (
      fn: (node: TaggedGoalNode, context: SupervisorContext, signal: AbortSignal) => Promise<NodeResult>
    ) => void;
    setEventEmitter: (emitter: WorkspaceBus) => void;
  } | null;
  dashboard?: { setWorkspaceBus: (workspaceBus: WorkspaceBus) => void } | null;
  agentManager?: {
    setWorkspaceRuntime?: (workspaceBus: WorkspaceBus, monitorLifecycle: MonitorLifecycle) => void;
  } | null;
  stoppableServers?: Array<{ stop?: () => void }>;
  channelType?: string;
  orchestratorForSupervisorBridge: Orchestrator;
  goalStorage?: GoalStorage;
}): WorkspaceBus {
  const workspaceBus = createWorkspaceBus();

  if (params.learningEventBus && params.daemonEventBus) {
    const lwBridge = createLearningWorkspaceBridge(
      params.learningEventBus,
      params.daemonEventBus,
      workspaceBus,
    );
    lwBridge.start();
    params.stoppableServers?.push(lwBridge);
  }

  if (typeof params.channel.broadcastRaw === "function") {
    const broadcastFn = params.channel.broadcastRaw.bind(params.channel);
    const monitorBridge = createMonitorBridge(
      workspaceBus,
      broadcastFn,
    );
    monitorBridge.start();
    params.stoppableServers?.push(monitorBridge);
  }

  params.orchestrator.setWorkspaceBus(workspaceBus);
  const monitorLifecycle = createMonitorLifecycle(workspaceBus);
  params.orchestrator.setMonitorLifecycle(monitorLifecycle);
  if (params.goalStorage) {
    params.orchestrator.setGoalStorage(params.goalStorage);
  }
  params.backgroundExecutor.setWorkspaceBus(workspaceBus);
  params.backgroundExecutor.setMonitorLifecycle(monitorLifecycle);
  params.agentManager?.setWorkspaceRuntime?.(workspaceBus, monitorLifecycle);
  if (params.supervisorBrain) {
    params.supervisorBrain.setExecuteNode(createSupervisorExecuteNodeBridge({
      backgroundExecutor: params.backgroundExecutor,
      orchestrator: params.orchestratorForSupervisorBridge,
      workspaceBus,
      defaultChannelType: params.channelType,
    }));
    params.supervisorBrain.setEventEmitter(workspaceBus);
  }

  params.dashboard?.setWorkspaceBus(workspaceBus);

  return workspaceBus;
}

export interface BootstrapOptions {
  channelType: string;
  config: Config;
  container?: DIContainer;
  daemonMode?: boolean;
  beforeChannelConnect?: (() => Promise<void> | void) | undefined;
  postSetupBootstrap?: PostSetupBootstrap | null;
}

export interface BootstrapResult {
  orchestrator: Orchestrator;
  messageRouter: MessageRouter;
  channel: IChannelAdapter;
  container: DIContainer;
  shutdown: () => Promise<void>;
  heartbeatLoop?: HeartbeatLoop;
  daemonContext?: import("../daemon/daemon-cli.js").DaemonContext;
  agentManager?: AgentManagerType;
  activityRegistry?: ChannelActivityRegistry;
  autoUpdater?: AutoUpdater;
  bootReport?: import("../common/capability-contract.js").BootReport;
  workspaceBus?: WorkspaceBus;
}

const POST_SETUP_BOOTSTRAP_DELAY_MS = 1200;

/**
 * Bootstrap the application with all services.
 *
 * Thin wrapper that owns mid-bootstrap failure cleanup (H11). `bootstrapImpl`
 * registers a disposer on the {@link BootstrapDisposables} stack immediately
 * after each resource is allocated; if any later step throws, we tear those
 * resources down here (releasing SQLite fds, clearing timers, stopping
 * servers/ports) before rethrowing instead of leaking them. On the success
 * path nothing is torn down here — the returned `shutdown` handler owns the
 * full lifecycle exactly as before.
 */
export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const disposables = new BootstrapDisposables();
  try {
    return await bootstrapImpl(options, disposables);
  } catch (error) {
    await disposables.teardown();
    throw error;
  }
}

async function bootstrapImpl(
  options: BootstrapOptions,
  disposables: BootstrapDisposables,
): Promise<BootstrapResult> {
  const { channelType, container: customContainer, beforeChannelConnect } = options;
  const runtimeProjectResolution = resolveRuntimeUnityProjectPath(options.config.unityProjectPath);
  const config = runtimeProjectResolution.effectiveProjectPath === options.config.unityProjectPath
    ? options.config
    : {
      ...options.config,
      unityProjectPath: runtimeProjectResolution.effectiveProjectPath,
    };
  const container = customContainer ?? createContainer();

  const logger = createLogger(config.logLevel, config.logFile);
  logger.info("Bootstrapping Strada Brain", {
    channel: channelType,
    projectPath: config.unityProjectPath,
    readOnly: config.security.readOnlyMode,
  });

  // Restore provider health state from previous run.
  //
  // Say what was restored. This step was silent for a day while a quota-blocked
  // provider kept being handed goals, and the silence made it impossible to
  // tell "the file was never read" from "the file was read and said nothing".
  const providerHealthPath = join(config.memory.dbPath, "provider-health.json");
  const providerHealth = ProviderHealthRegistry.getInstance();
  providerHealth.load(providerHealthPath);
  logger.info("Provider health restored", {
    // Absolute, deliberately. A relative ".strada-memory/provider-health.json"
    // is resolved against the process CWD, which is not the project directory;
    // printing it relative sent an investigation to the wrong file for an hour
    // and produced a confident "persistence is broken" about a file that was
    // being written correctly somewhere else.
    path: resolve(providerHealthPath),
    fileExists: existsSync(providerHealthPath),
    unavailable: providerHealth.unavailableProviders(),
  });
  if (runtimeProjectResolution.notice) {
    logger.warn("Runtime Unity project path mismatch detected", {
      configuredProjectPath: runtimeProjectResolution.configuredProjectPath,
      effectiveProjectPath: runtimeProjectResolution.effectiveProjectPath,
      detectedProjectPaths: runtimeProjectResolution.detectedProjectPaths,
      source: runtimeProjectResolution.source,
    });
  }

  configureAuthManager(config.security.systemAuth);

  // Cap simultaneous in-flight HTTP calls PER PROVIDER so the fan-out of parallel
  // agents/nodes/delegations does not burst a single provider key past its
  // concurrency/RPM ceiling (HTTP 429). Different providers never block each other.
  configureProviderConcurrency(config.providerMaxConcurrentRequests);

  // Check Strada framework dependencies
  const stradaDeps = checkStradaDeps(config.unityProjectPath, config.strada);
  if (!stradaDeps.coreInstalled) {
    logger.warn("Strada.Core not found in project Packages/", {
      projectPath: config.unityProjectPath,
      searchedNames: ["strada.core", "com.strada.core", "Strada.Core"],
    });
  }
  for (const warning of stradaDeps.warnings) {
    logger.warn(warning);
  }

  // Log Strada.MCP status
  if (stradaDeps.mcpInstalled) {
    logger.info("Strada.MCP found", { path: stradaDeps.mcpPath, version: stradaDeps.mcpVersion });
  } else {
    logger.info("Strada.MCP not found (optional — install for MCP server capabilities)");
  }

  // Framework Knowledge Layer: extract + store + drift check for all Strada packages
  const frameworkSyncConfig = {
    bootSync: config.strada?.frameworkSync?.bootSync ?? true,
    watchEnabled: config.strada?.frameworkSync?.watchEnabled ?? false,
    watchDebounceMs: config.strada?.frameworkSync?.watchDebounceMs ?? 2000,
    gitFallbackEnabled: config.strada?.frameworkSync?.gitFallbackEnabled ?? true,
    gitCacheDir: config.strada?.frameworkSync?.gitCacheDir ?? join(homedir(), ".strada", "framework-cache"),
    gitCacheMaxAgeMs: config.strada?.frameworkSync?.gitCacheMaxAgeMs ?? 24 * 60 * 60 * 1000,
    maxDriftScore: config.strada?.frameworkSync?.maxDriftScore ?? 30,
  };

  let frameworkStore: FrameworkKnowledgeStore | null = null;
  let frameworkSyncPipeline: FrameworkSyncPipeline | null = null;
  // Callback set after orchestrator is constructed; the IIFE calls it when sync completes.
  // deferredFrameworkStore buffers the result if the IIFE finishes before the callback is assigned.
  let onFrameworkStoreReady: ((store: FrameworkKnowledgeStore) => void) | null = null;
  let deferredFrameworkStore: FrameworkKnowledgeStore | null = null;

  if (frameworkSyncConfig.bootSync) {
    void (async () => {
      try {
        const { FrameworkKnowledgeStore, FrameworkSyncPipeline, initializeFrameworkSchemaProvider } =
          await import("../intelligence/framework/index.js");

        const dbPath = join(config.memory?.dbPath ?? join(homedir(), ".strada-memory"), "framework-knowledge.db");
        frameworkStore = new FrameworkKnowledgeStore(dbPath);
        frameworkStore.initialize();
        // Register failure-path disposers immediately so a mid-bootstrap throw
        // (in a later stage) releases the SQLite fd and stops the watcher even
        // though this IIFE runs detached. The success-path shutdown handler also
        // closes these (via daemonStorage-style wiring below).
        disposables.push("frameworkStore", () => frameworkStore?.close());

        frameworkSyncPipeline = new FrameworkSyncPipeline(frameworkStore, frameworkSyncConfig, stradaDeps);
        disposables.push("frameworkSyncPipeline", () => frameworkSyncPipeline?.stop());
        const syncResult = await frameworkSyncPipeline.bootSync();

        initializeFrameworkSchemaProvider(frameworkStore);

        for (const report of syncResult.reports) {
          if (report.driftScore > frameworkSyncConfig.maxDriftScore) {
            logger.warn(`Framework drift detected for ${report.packageId}`, {
              driftScore: report.driftScore,
              errors: report.errors.length,
              version: report.currentVersion,
            });
          }
        }

        logger.info("Framework Knowledge Layer synced", {
          packages: syncResult.reports.map((r) => `${r.packageId}:v${r.currentVersion ?? "?"}`).join(", "),
        });

        // Notify the orchestrator (if already constructed) that framework store is ready
        if (onFrameworkStoreReady && frameworkStore) {
          (onFrameworkStoreReady as (store: FrameworkKnowledgeStore) => void)(frameworkStore);
        } else if (frameworkStore) {
          // IIFE completed before callback was assigned -- buffer the result
          deferredFrameworkStore = frameworkStore;
        }

        if (frameworkSyncConfig.watchEnabled) {
          await frameworkSyncPipeline.startWatcher();
        }
      } catch (fwError) {
        logger.debug("Framework sync skipped", {
          reason: fwError instanceof Error ? fwError.message : "unknown",
        });
      }
    })();
  }

  const {
    providerInit,
    memoryManager,
    channel,
    cachedEmbeddingProvider,
    embeddingStatus,
    startupNotices: runtimeStageNotices,
  } = await initializeProviderRuntimeStage(
    {
      channelType,
      config,
      logger,
    },
    {
      initializeAuth,
      resolveAndCacheEmbeddings: _resolveAndCacheEmbeddings,
      initializeAIProvider: _initializeAIProvider,
      initializeMemory: _initializeMemory,
      initializeChannel,
      isTransientEmbeddingVerificationError: _isTransientEmbeddingVerificationError,
    },
  );
  if (runtimeProjectResolution.notice) {
    runtimeStageNotices.push(runtimeProjectResolution.notice);
  }
  // Say whether this is a Strada.Core project UP FRONT. The conformance gates
  // catch reimplementations after the fact; a run that never hears the framework
  // exists may build a vanilla dotnet project beside it instead (measured
  // 2026-08-23, PixelFlow). One line at start beats a gate at the end.
  const frameworkNotice = describeFrameworkInstall(config.unityProjectPath);
  if (frameworkNotice) {
    runtimeStageNotices.push(frameworkNotice);
  }
  const providerManager = providerInit.manager;
  const activityRegistry = new ChannelActivityRegistry();

  // H11: from here on, register a failure-cleanup disposer immediately after each
  // resource comes online (mirrors createShutdownHandler). If a later bootstrap
  // step throws, the bootstrap() wrapper runs these in LIFO order before rethrowing
  // so a mid-bootstrap failure can't leak SQLite fds, timers, or server ports.
  if (memoryManager) {
    disposables.push("memoryManager", async () => { await memoryManager.shutdown(); });
  }
  disposables.push("channel", () => channel.disconnect());
  disposables.push("providerManager", () => providerManager.shutdown());
  // Persist the embedding cache on the failure path too — registered early (when
  // it comes online) so LIFO teardown flushes it after RAG/learning stop using it.
  if (cachedEmbeddingProvider) {
    disposables.push("cachedEmbeddingProvider", () => cachedEmbeddingProvider.shutdown());
  }

  const { ragPipeline: codeRagPipeline, learningResult, startupNotices } = await initializeKnowledgeStage(
    {
      config,
      logger,
      cachedEmbeddingProvider,
      startupNotices: runtimeStageNotices,
    },
    {
      initializeRAG,
      initializeLearning,
    },
  );
  disposables.push("learningEventBus", () => learningResult.eventBus?.shutdown());
  disposables.push("learningQueue", () => learningResult.learningQueue?.shutdown());
  disposables.push("learningPipeline", () => learningResult.pipeline?.stop());
  disposables.push("learningStorage", () => learningResult.storage?.close());

  // DocRAG + CompositeRAG: wrap code RAG with documentation search when available
  let ragPipeline = codeRagPipeline;
  if (codeRagPipeline && cachedEmbeddingProvider && config.rag?.docRag?.enabled !== false) {
    try {
      const { CompositeRAGPipeline, DocRAGPipeline, discoverPackageRoots } =
        await import("../rag/docs/index.js");
      const packageRoots = discoverPackageRoots(stradaDeps);
      if (packageRoots.length > 0) {
        const docVectorStorePath = join(config.memory?.dbPath ?? join(homedir(), ".strada-memory"), "vectors", "hnsw-docs");
        const docVectorStore = new FileVectorStore(docVectorStorePath, cachedEmbeddingProvider.dimensions);
        const docPipeline = new DocRAGPipeline(cachedEmbeddingProvider, docVectorStore);
        ragPipeline = new CompositeRAGPipeline(
          codeRagPipeline as RAGPipeline,
          docPipeline,
          cachedEmbeddingProvider,
          packageRoots,
        );
        logger.info("DocRAG enabled: composite pipeline wraps code + framework docs", {
          packages: packageRoots.map((p) => p.name).join(", "),
        });
      }
    } catch (docRagError) {
      logger.debug("DocRAG initialization skipped (non-fatal)", {
        reason: docRagError instanceof Error ? docRagError.message : String(docRagError),
      });
      // ragPipeline remains the code-only pipeline
    }
  }
  // Dispose the FINAL ragPipeline (composite when DocRAG wrapped the code pipeline).
  if (ragPipeline) {
    disposables.push("ragPipeline", () => ragPipeline?.shutdown());
  }

  // Initialize tools (registry created here, initialized after metricsStorage below)
  const toolRegistry = new ToolRegistry(config.pluginDirs);
  disposables.push("toolRegistry", () => toolRegistry.shutdown());

  const metrics = new MetricsCollector();
  setSanitizationCallback((count) => metrics.recordSecretSanitized(count));
  const { dashboard, stoppableServers, rateLimiter, metricsStorage, metricsRecorder } =
    await initializeOpsMonitoringStage(
      {
        config,
        logger,
        metrics,
        memoryManager,
      },
      {
        initializeDashboard,
        initializeRateLimiter,
      },
    );
  if (dashboard) {
    disposables.push("dashboard", () => dashboard.stop());
  }
  if (stoppableServers) {
    disposables.push("stoppableServers", async () => {
      await Promise.all(stoppableServers.map((s) => s.stop()));
    });
  }
  if (metricsStorage) {
    disposables.push("metricsStorage", () => metricsStorage.close());
  }
  const {
    identityManager,
    uptimeInterval,
    runtimeArtifactManager,
    instinctRetriever,
    trajectoryReplayRetriever,
  } = initializeRuntimeStateStage({
    config,
    logger,
    learningResult,
    metricsStorage,
    metricsRecorder,
  });
  if (uptimeInterval) {
    disposables.push("uptimeInterval", () => clearInterval(uptimeInterval));
  }
  if (identityManager) {
    disposables.push("identityManager", () => {
      identityManager.recordShutdown();
      identityManager.close();
    });
  }

  // Initialize tool registry now that all deps are available
  // getDaemonStatus closure captures heartbeatLoop (declared below) via late binding
  let heartbeatLoop: HeartbeatLoop | undefined;
  let digestReporterInstance: DigestReporter | undefined;
  let notificationRouterInstance: NotificationRouter | undefined;
  let daemonContext: import("../daemon/daemon-cli.js").DaemonContext | undefined;
  let agentManager: AgentManagerType | undefined;
  let agentBudgetTrackerOuter: AgentBudgetTrackerType | undefined;
  let delegationManager: DelegationManagerType | undefined;
  // Vault (Phase 1+): create registry, wire the VaultFactory, and auto-register
  // a codebase vault whenever an embedding provider is available.
  //
  // IMPORTANT: we intentionally do NOT gate factory install / auto-register on
  // `config.vault?.enabled`. That flag historically toggled the *feature*, but
  // the HTTP surface (POST /api/vaults, GET /api/vaults, portal vault UI) and
  // the runtime factory are always present in the binary. Gating them behind
  // `vault.enabled=false` (the default) meant the dashboard returned
  // 503 "vault registration unavailable" for every user who hadn't explicitly
  // opted in — even though the portal UI is shipped unconditionally.
  //
  // The vault always builds now: use the real embedding provider when one is
  // configured, otherwise fall back to a deterministic hash embedder so the
  // Codebase Memory Vault is never silently skipped. (Previously a missing
  // embedding provider skipped the ENTIRE vault subsystem — a user with no
  // embedding key got no vault at all, even with STRADA_VAULT_ENABLED=true.)
  //
  // Lexical FTS/BM25 (plus wikilinks/symbols/PPR) carries retrieval on its own.
  // The in-memory vector store wired below is a NON-SEMANTIC placeholder
  // (`semantic: false`): the vault's query() skips it entirely, so it never
  // pollutes the BM25 ranking and the vault runs fully without any embedding
  // dependency. A real persistent HNSW store (semantic: true) later restores
  // vectors into the RRF fusion — embeddings only ENHANCE, never carry.
  const { VaultRegistry } = await import("../vault/vault-registry.js");
  const vaultRegistry = new VaultRegistry();
  disposables.push("vaultRegistry", () => vaultRegistry.disposeAll());
  // LIVING VAULT: set once the dedicated dev-knowledge vault is registered so
  // the learning-bridge note-writer (C) is only wired when there is a target.
  let devKnowledgeVaultRegistered = false;
  let vaultEmbeddingProvider = cachedEmbeddingProvider;
  if (!vaultEmbeddingProvider) {
    try {
      const { join } = await import("node:path");
      const hashFallback = new CachedEmbeddingProvider(new HashEmbeddingProvider(), {
        persistPath: join(config.memory.dbPath, "vault-hash-cache"),
      });
      await hashFallback.initialize();
      vaultEmbeddingProvider = hashFallback;
      logger.warn(
        "[vault] no embedding provider configured — building vault with a hash " +
          "fallback (lexical BM25 + hash vectors; semantic quality degraded). Add " +
          "GEMINI_API_KEY / OPENAI_API_KEY or run local Ollama for semantic search.",
      );
    } catch (err) {
      logger.warn("[vault] hash fallback embedding init failed", { err });
    }
  }
  // `const` (not the mutable `vaultEmbeddingProvider`) so TS narrows it to
  // non-null inside the async `embed` closure below. Keep it a const.
  const resolvedVaultEmbedding = vaultEmbeddingProvider;
  if (resolvedVaultEmbedding) {
    try {
      logger.info("[vault] initializing vault subsystem", {
        hasUnityProjectPath: Boolean(config.unityProjectPath),
        vaultConfigEnabled: Boolean(config.vault?.enabled),
      });
      // Bridge CachedEmbeddingProvider (returns {embeddings, usage}) → vault EmbeddingProvider (returns Float32Array[])
      const vaultEmbedding = {
        model: "cached", dim: resolvedVaultEmbedding.dimensions,
        async embed(texts: string[]) {
          const result = await resolvedVaultEmbedding.embed(texts);
          return result.embeddings.map((e: number[]) => Float32Array.from(e));
        },
      };
      // In-memory VectorStore placeholder. It is intentionally NON-SEMANTIC
      // (`semantic: false`): its `search()` cannot honour a query vector (no
      // ANN index) and it is not persisted, so it must never fuse vectors into
      // the lexical (BM25) ranking. With `semantic: false` the vault's query()
      // skips the embed + search round-trip entirely (pure-lexical fast path).
      // `search()` therefore returns [] rather than a bogus insertion-ordered
      // slice. A future Phase wires a REAL persistent HNSW backing store here
      // with `semantic: true`, which restores HNSW into the RRF fusion exactly
      // as "embeddings only enhance" intends. `add`/`remove` stay functional so
      // the existing index/lifecycle bookkeeping (hnsw_id mapping) is unchanged.
      // One store PER VAULT, not one shared instance: a shared store let any
      // vault's rebuild() clear() every other vault's vectors and reset the id
      // counter to 1, so newly issued ids collided with ids persisted in other
      // vaults' embedding tables — a later remove(id) from vault A deleted
      // vault B's live entry. Obsidian's rebuild (which never cleared) made the
      // asymmetry worse: dead vectors accumulated forever. Latent while
      // semantic:false keeps vectors query-inert; corruption the moment a real
      // HNSW store lands.
      const createVaultVectorStore = () => {
        let nextId = 1;
        const entries = new Map<number, { v: Float32Array; payload: unknown }>();
        return {
          semantic: false as const,
          add(v: Float32Array, payload: unknown): number { const id = nextId++; entries.set(id, { v, payload }); return id; },
          remove(id: number): void { entries.delete(id); },
          search(_q: Float32Array, _k: number): Array<{ id: number; score: number; payload?: unknown }> {
            return [];
          },
          clear(): void { entries.clear(); nextId = 1; },
        };
      };
      const { UnityProjectVault } = await import("../vault/unity-project-vault.js");
      const runtimeVaultFactory = {
        watchDebounceMs: config.vault?.debounceMs ?? 800,
        async create(spec: { id: string; rootPath: string; kind: "unity" | "generic" }) {
          return new UnityProjectVault({
            id: spec.id,
            rootPath: spec.rootPath,
            embedding: vaultEmbedding,
            vectorStore: createVaultVectorStore(),
          });
        },
      };
      vaultRegistry.setFactory({
        allowedRootPaths: [
          process.cwd(),
          ...(config.unityProjectPath ? [config.unityProjectPath] : []),
        ],
        createVault(rootPath: string) {
          const hash = createHash("sha1").update(rootPath).digest("hex").slice(0, 8);
          return runtimeVaultFactory.create({ id: `generic:${hash}`, rootPath, kind: "generic" });
        },
      });

      // Unity-specific discovery (only runs when vault.enabled is on — preserves
      // old behavior for users who explicitly opted in to Unity indexing).
      if (config.vault?.enabled) {
        try {
          const { initVaultsFromBootstrap } = await import("./bootstrap-stages/stage-knowledge.js");
          await initVaultsFromBootstrap({
            config: { vault: config.vault, unityProjectPath: config.unityProjectPath },
            vaultRegistry,
            embedding: vaultEmbedding,
            vectorStore: createVaultVectorStore(),
          });
        } catch (err) {
          logger.warn("[vault] Unity auto-discovery failed", { err });
        }
      }

      // Phase 2: SelfVault for Strada.Brain's own source. This is controlled
      // by vault.self.enabled, not by vault.enabled (which gates project auto-discovery).
      try {
        const { initSelfVaultFromBootstrap } = await import("./bootstrap-stages/stage-knowledge.js");
        await initSelfVaultFromBootstrap({
          config: { vault: config.vault },
          vaultRegistry,
          embedding: vaultEmbedding,
          vectorStore: createVaultVectorStore(),
          repoRoot: process.cwd(),
        });
      } catch (err) {
        logger.warn("[vault] SelfVault initialization failed", { err });
      }

      try {
        const { initObsidianVaultFromBootstrap } = await import("./bootstrap-stages/stage-knowledge.js");
        await initObsidianVaultFromBootstrap({
          config: { obsidian: config.obsidian },
          vaultRegistry,
          embedding: vaultEmbedding,
          vectorStore: createVaultVectorStore(),
        });
      } catch (err) {
        logger.warn("[vault] ObsidianVault initialization failed", { err });
      }

      // Generic auto-register: when a project path is configured but no vault
      // was picked up by Unity discovery (typical case: vault.enabled=false,
      // or non-Unity project), register a plain-codebase vault so the portal
      // shows indexed content instead of "No vaults registered".
      try {
        if (config.unityProjectPath && vaultRegistry.list().length === 0) {
          const { basename } = await import("node:path");
          const rootPath = config.unityProjectPath;
          const hash = createHash("sha1").update(rootPath).digest("hex").slice(0, 8);
          const vault = await runtimeVaultFactory.create({
            id: `generic:${hash}`,
            rootPath,
            kind: "generic",
          });
          vaultRegistry.register(vault);
          logger.info("[vault] auto-registered generic vault from setup config", {
            id: vault.id,
            name: basename(rootPath),
            rootPath,
          });
          // Fire-and-log init + watcher so bootstrap never blocks on indexing
          // a potentially large directory.
          void (async () => {
            try {
              await vault.init();
              await vault.startWatch(config.vault?.debounceMs ?? 800);
              logger.info(`[vault] async init complete for ${vault.id}`);
            } catch (err) {
              logger.warn(`[vault] async init failed for ${vault.id}`, {
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
              });
            }
          })();
        } else if (!config.unityProjectPath) {
          logger.info("[vault] skipping auto-register: no unityProjectPath configured");
        } else {
          logger.info("[vault] skipping auto-register: registry already populated", {
            count: vaultRegistry.list().length,
          });
        }
      } catch (err) {
        logger.warn("[vault] generic auto-register failed", { err });
      }

        // The codebases every plan is written against.
        //
        // Both registrations above are pinned to the Unity project, so the only
        // thing this system ever indexed was the game it was building. The
        // frameworks it is supposed to have mastered — and its own source —
        // were searchable nowhere, and the knowledge that should come from
        // reading them arrived instead as prose rules typed into a prompt after
        // each incident.
        try {
          const { frameworkVaultTargets } = await import("../vault/framework-vault-targets.js");
          // installRoot, not cwd: runtime-paths chdirs the process to the Strada
          // home at startup, so cwd here is ~/.strada and the vault registered
          // under the name "Strada.Brain" indexed the config directory instead
          // of this system's source. installRoot is derived from the module's
          // own location and survives the chdir.
          const { resolveRuntimePaths } = await import("../common/runtime-paths.js");
          const brainRoot = resolveRuntimePaths({ moduleUrl: import.meta.url }).installRoot;
          const selfVaultActive =
            config.vault?.self?.enabled !== false &&
            vaultRegistry.list().some((v) => v.id.startsWith("self:"));
          // SelfVault already curates this repo; a second whole-repo vault would
          // re-watch dist/benchmarks artifacts (~1.7K fds) and feed generated
          // .d.ts noise into vault_search.
          const targets = frameworkVaultTargets(stradaDeps, brainRoot).filter(
            (t) => t.name !== "Strada.Brain" || !selfVaultActive,
          );
          for (const target of targets) {
            if (!existsSync(target.rootPath)) continue;
            const hash = createHash("sha1").update(target.rootPath).digest("hex").slice(0, 8);
            const id = `generic:${hash}`;
            if (vaultRegistry.list().some((v) => v.id === id)) continue;
            const vault = await runtimeVaultFactory.create({
              id,
              rootPath: target.rootPath,
              kind: "generic",
            });
            vaultRegistry.register(vault, target.name);
            logger.info("[vault] registered framework vault", {
              id: vault.id,
              name: target.name,
              rootPath: target.rootPath,
            });
            void (async () => {
              try {
                await vault.init();
                await vault.startWatch(config.vault?.debounceMs ?? 800);
                logger.info(`[vault] async init complete for ${vault.id} (${target.name})`);
              } catch (err) {
                logger.warn(`[vault] async init failed for ${vault.id} (${target.name})`, {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            })();
          }
        } catch (err) {
          logger.warn("[vault] framework vault registration failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }


      // LIVING VAULT (A) — dedicated per-project dev-knowledge vault rooted at
      // `<unityProjectPath>/.strada/knowledge/`. It ACCUMULATES dev-time
      // knowledge (task-completion notes, learned heuristics, clean-success
      // verdicts) so the agent improves incrementally. It reuses the full
      // UnityProjectVault engine via the DevKnowledgeVault subclass (distinct
      // `kind: 'knowledge'` so the code write-hook never binds to it). The
      // CODE vault rooted at <unityProjectPath> never walks into `.strada`
      // (IGNORE_DIRS), so there is zero double-indexing, and resolveVaultForPath
      // is longest-prefix so paths under `.strada/knowledge/` route here.
      try {
        if (config.unityProjectPath) {
          const { join } = await import("node:path");
          const { mkdir } = await import("node:fs/promises");
          const knowledgeRoot = join(config.unityProjectPath, ".strada", "knowledge");
          await mkdir(knowledgeRoot, { recursive: true });
          const { DevKnowledgeVault } = await import("../vault/dev-knowledge-vault.js");
          const hash = createHash("sha1").update(knowledgeRoot).digest("hex").slice(0, 8);
          const knowledgeVault = new DevKnowledgeVault({
            id: `knowledge:${hash}`,
            rootPath: knowledgeRoot,
            embedding: vaultEmbedding,
            vectorStore: createVaultVectorStore(),
          });
          vaultRegistry.register(knowledgeVault, "Dev Knowledge");
          devKnowledgeVaultRegistered = true;
          logger.info("[vault] registered dev-knowledge vault", {
            id: knowledgeVault.id,
            rootPath: knowledgeRoot,
          });
          // Fire-and-log init + watcher so bootstrap never blocks on indexing.
          void (async () => {
            try {
              await knowledgeVault.init();
              await knowledgeVault.startWatch(config.vault?.debounceMs ?? 800);
              logger.info(`[vault] async init complete for ${knowledgeVault.id}`);
            } catch (err) {
              logger.warn(`[vault] async init failed for ${knowledgeVault.id}`, {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          })();
        } else {
          logger.info("[vault] skipping dev-knowledge vault: no unityProjectPath configured");
        }
      } catch (err) {
        logger.warn("[vault] dev-knowledge vault registration failed", { err });
      }

      // Hand a factory to the dashboard so POST /api/vaults (and the web
      // channel's proxy to it) can create new vaults at runtime using the
      // same embedding + vector-store deps wired above.
      if (dashboard) {
        logger.info("[vault] installing VaultFactory on dashboard");
        dashboard.registerVaultFactory(runtimeVaultFactory);
        logger.info("[vault] VaultFactory installed — POST /api/vaults ready");
      } else {
        logger.warn("[vault] dashboard unavailable at factory-install time — POST /api/vaults will return 503");
      }
    } catch (err) {
      logger.warn("[vault] bootstrap initialization failed", { err });
    }
  } else {
    logger.warn("[vault] skipping vault bootstrap: embedding fallback unavailable (hash init failed)");
  }

  // Hand the vault registry to the dashboard server so HTTP routes can resolve it.
  if (dashboard) {
    dashboard.registerVaultRegistry(vaultRegistry);
    logger.info("[vault] VaultRegistry installed on dashboard", {
      vaultCount: vaultRegistry.list().length,
    });
  }

  // LIVING VAULT (B + C) — build the shared dev-knowledge note-writer over the
  // registry (resolves the `kind: 'knowledge'` vault at write time) and inject
  // it into BOTH the learning pipeline (C: high-confidence instinct /
  // clean-success verdict notes) and the route completion-hook (B: per-task
  // write-back). Cycle-safe: the learning pipeline depends only on the
  // DevKnowledgeNoteWriter INTERFACE (defined in vault/, type-only from
  // learning's side) — no runtime src/learning -> src/vault edge. When no
  // knowledge vault was registered the writer is a no-op (resolve returns
  // undefined), so flag/path-off is byte-identical.
  let devKnowledgeNoteWriter:
    | import("../vault/dev-knowledge-writer.js").DevKnowledgeNoteWriter
    | undefined;
  if (devKnowledgeVaultRegistered) {
    try {
      const { DevKnowledgeNoteWriterImpl } = await import("../vault/dev-knowledge-writer.js");
      devKnowledgeNoteWriter = new DevKnowledgeNoteWriterImpl(vaultRegistry, logger);
      learningResult.pipeline?.setNoteWriter(devKnowledgeNoteWriter);
      logger.info("[vault] dev-knowledge note-writer wired into learning pipeline");
    } catch (err) {
      logger.warn("[vault] dev-knowledge note-writer wiring failed", { err });
    }
  }

  await initializeToolRegistryStage(
    {
      toolRegistry,
      config,
      memoryManager,
      ragPipeline,
      metrics,
      learningStorage: learningResult.storage,
      metricsStorage,
      vaultRegistry,
      getIdentityState: identityManager ? () => identityManager!.getState() : undefined,
      onDegraded: (notice) => startupNotices.push(notice),
    },
    {
      getDaemonStatus: () => heartbeatLoop?.getDaemonStatus(),
    },
  );

  // Load skill ecosystem (after tool registry is initialized)
  const { SkillManager } = await import("../skills/skill-manager.js");
  const skillManager = new SkillManager();
  skillManager.setToolRegistrar(
    (tools) => {
      for (const tool of tools) {
        try {
          toolRegistry.register(tool, { category: "custom", dangerous: false, readOnly: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Only a duplicate-name collision is expected/benign here; anything
          // else (malformed schema, validation/internal registry error) means
          // the skill tool was silently dropped — surface it so it's debuggable.
          if (message.includes("is already registered")) {
            // Duplicate tool name — skip silently (already registered)
            continue;
          }
          logger.warn("Skill tool registration failed", {
            tool: tool.name,
            error: message,
          });
        }
      }
    },
    (toolNames) => {
      for (const name of toolNames) {
        toolRegistry.unregister(name);
      }
    },
  );
  try {
    await skillManager.loadAll(config.unityProjectPath);
  } catch (skillError) {
    logger.warn("Skill loading failed (non-fatal)", {
      error: skillError instanceof Error ? skillError.message : String(skillError),
    });
  }

  // External MCP servers. Registered after skills so a user-configured server
  // cannot shadow a built-in tool: names are namespaced `mcp__<server>__<tool>`
  // anyway, but registration order decides who wins a collision.
  const mcpServers = config.mcpServers.filter((s) => s.enabled);
  const mcpConnections: Array<{ serverName: string; close(): Promise<void> }> = [];
  if (mcpServers.length > 0) {
    try {
      const { connectMcpServers } = await import("../mcp/mcp-client.js");
      const connections = await connectMcpServers(mcpServers);
      for (const connection of connections) {
        mcpConnections.push(connection);
        for (const tool of connection.tools) {
          try {
            // dangerous/readOnly are deliberately conservative: an MCP tool is
            // a third-party binary whose effects Strada cannot introspect, so
            // it is not claimed to be read-only.
            toolRegistry.register(tool, { category: "custom", dangerous: true, readOnly: false });
          } catch (err) {
            logger.warn("MCP tool registration failed", {
              tool: tool.name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      // Without this the child processes outlive the agent and hold their
      // stdio pipes open, so shutdown hangs.
      disposables.push("mcpConnections", async () => {
        for (const connection of mcpConnections) await connection.close();
      });
    } catch (mcpError) {
      logger.warn("MCP server loading failed (non-fatal)", {
        error: mcpError instanceof Error ? mcpError.message : String(mcpError),
      });
    }
  }

  const { goalStorage, goalDecomposer, interruptedGoalTrees, crashContext } =
    initializeGoalContextStage({
      config,
      logger,
      provider: providerManager.getProvider(""),
      identityManager,
    });
  if (goalStorage) {
    disposables.push("goalStorage", () => goalStorage.close());
  }

  const { soulLoader, sessionSummarizer, userProfileStore, taskExecutionStore, dmPolicy } =
    await initializeSessionRuntimeStage({
      config,
      logger,
      memoryManager,
      providerManager,
      channel,
    });
  if (soulLoader) {
    disposables.push("soulLoader", () => soulLoader.shutdown());
  }

  const {
    modelIntelligence, providerRouter, consensusManager, confidenceEstimator,
    dynamicProfiles, dynamicProfilePersistence,
  } = await initializeRuntimeIntelligenceStage({
      config,
      logger,
      providerManager,
      learningStorage: learningResult.storage,
    });
  if (modelIntelligence) {
    disposables.push("modelIntelligence", () => modelIntelligence.shutdown());
  }
  // Hoisted so the clean-shutdown handler (createShutdownHandler, below) can clear
  // it too — the disposables stack only fires on the bootstrap-FAILURE path.
  let dynamicProfilesFlushInterval: ReturnType<typeof setInterval> | undefined;
  if (dynamicProfiles) {
    // Periodically persist the telemetry-blended profiles so learned per-model
    // scores survive a restart. Unref'd so it never holds the process open.
    dynamicProfilesFlushInterval = setInterval(() => { void dynamicProfiles.flush(); }, 60_000);
    dynamicProfilesFlushInterval.unref?.();
    disposables.push("dynamicProfilesFlush", () => {
      if (dynamicProfilesFlushInterval) clearInterval(dynamicProfilesFlushInterval);
    });
    disposables.push("dynamicProfiles", async () => {
      await dynamicProfiles.flush();
      dynamicProfilePersistence?.close();
    });
  }

  const { supervisorBrain } = initializeSupervisorStage({
    // Planning gets the same live framework API the orchestrator already had.
    getFrameworkKnowledge: () =>
      getFrameworkPromptGenerator()?.buildFrameworkKnowledgeSection() ?? null,
    config,
    logger,
    providerManager,
    goalDecomposer,
  });

  // Agent Core v2: select the active stage by id via the AGENT_CORE_FLAG_SET ops knob, REJECT-AT-
  // BOOT for an unknown id (P-F closed matrix). Resolved BEFORE the orchestrator so the FlagSet
  // threads into it. UNSET (the normal case) → PRODUCTION_DEFAULT_FLAG_SET_ID (the V2 engine on
  // every route + full control plane). NOTE (cutover Step 5): the v1 engine is DELETED — there is
  // no v1 revert. The old revert ids (all-v1, v1-driver+full-control-plane, the rollout stages)
  // are DEPRECATED aliases that resolve to the production default; the warn below makes that
  // loud so an operator can never believe a v1 revert took effect.
  const rawFlagSetEnv = process.env.AGENT_CORE_FLAG_SET?.trim();
  const requestedFlagSetId = rawFlagSetEnv || PRODUCTION_DEFAULT_FLAG_SET_ID;
  const agentCoreFlagSet = resolveFlagSetById(requestedFlagSetId);
  if (rawFlagSetEnv && agentCoreFlagSet.id !== rawFlagSetEnv) {
    logger.warn(
      "AGENT_CORE_FLAG_SET names a deprecated v1-era flag set (the v1 engine was deleted in cutover Step 5); running the production default instead",
      { requested: rawFlagSetEnv, resolved: agentCoreFlagSet.id },
    );
  }
  logger.info("Agent Core flag set resolved", {
    flagSet: agentCoreFlagSet.id,
    requested: requestedFlagSetId,
    source: rawFlagSetEnv ? "AGENT_CORE_FLAG_SET" : "production-default",
  });

  // Agent Core v2 — Phase 3b: construct + seed the CapabilityRegistry (tool-substrate liveness) ONLY
  // when the capabilityRegistry flag is on (the v2-all+scoring+capability legal sets). Seeded here,
  // where the MCP runtime handle lives, from the live bridge status; held by the orchestrator for the
  // advertise/guardExecute wiring. No reader yet → behavior-neutral. Default-off → undefined.
  const capabilityRegistry = agentCoreFlagSet.capabilityRegistry
    ? (() => {
        const registry = new CapabilityRegistry(new SystemClock());
        seedCapabilities(registry, {
          mcpConnected: toolRegistry.getStradaMcpRuntimeStatus()?.bridgeConnected ?? false,
        });
        return registry;
      })()
    : undefined;

  // Phase 3b step 2b: the bridge revive adapter. guardExecute gives a `down` mcp:strada capability ONE
  // revive attempt (generalizing StradaMcp's lazy-reconnect) before it returns BLOCKED. Built only
  // when the registry is (same flag); in-process/dotnet/network seed live and need no revive.
  const capabilityAdapters: ReadonlyMap<string, CapabilityAdapter> | undefined = capabilityRegistry
    ? new Map<string, CapabilityAdapter>([
        [
          CAPABILITY_MCP_STRADA,
          { capabilityId: CAPABILITY_MCP_STRADA, revive: () => toolRegistry.tryStradaMcpReconnect() },
        ],
      ])
    : undefined;

  // Initialize orchestrator
  const orchestrator = new Orchestrator({
    providerManager,
    tools: toolRegistry.getAllTools(),
    channel,
    projectPath: config.unityProjectPath,
    readOnly: config.security.readOnlyMode,
    requireConfirmation: config.security.requireEditConfirmation,
    memoryManager,
    metrics,
    ragPipeline,
    rateLimiter,
    defaultLanguage: config.language,
    streamInitialTimeoutMs: config.llmStreamInitialTimeoutMs,
    streamStallTimeoutMs: config.llmStreamStallTimeoutMs,
    stradaDeps,
    stradaConfig: config.strada,
    instinctRetriever,
    trajectoryReplayRetriever,
    eventEmitter: learningResult.eventBus,
    metricsRecorder,
    goalDecomposer,
    interruptedGoalTrees,
    getIdentityState: identityManager ? () => identityManager!.getState() : undefined,
    crashRecoveryContext: crashContext ?? undefined,
    reRetrievalConfig: config.reRetrieval,
    embeddingProvider: cachedEmbeddingProvider,
    soulLoader,
    dmPolicy,
    sessionSummarizer,
    userProfileStore,
    autonomousDefaultEnabled: config.autonomousDefaultEnabled,
    autonomousDefaultHours: config.autonomousDefaultHours,
    interactionConfig: config.interaction,
    taskConfig: config.tasks,
    taskExecutionStore,
    runtimeArtifactManager,
    toolMetadataByName: toolRegistry.getMetadataMap(),
    vaultRegistry,
    vaultWriteHookBudgetMs: config.vault?.writeHookBudgetMs,
    providerRouter,
    modelIntelligence,
    consensusManager,
    confidenceEstimator,
    interventionEngine: learningResult.interventionEngine,
    memoryDbPath: config.memory.dbPath,
    supervisorBrain,
    supervisorComplexityThreshold: config.supervisor.complexityThreshold,
    conformanceEnabled: config.conformanceEnabled,
    conformanceFrameworkPathsOnly: config.conformanceFrameworkPathsOnly,
    loopFingerprintThreshold: config.loopFingerprintThreshold,
    loopFingerprintWindow: config.loopFingerprintWindow,
    loopDensityThreshold: config.loopDensityThreshold,
    loopDensityWindow: config.loopDensityWindow,
    loopMaxRecoveryEpisodes: config.loopMaxRecoveryEpisodes,
    loopStaleAnalysisThreshold: config.loopStaleAnalysisThreshold,
    loopHardCapReplan: config.loopHardCapReplan,
    loopHardCapBlock: config.loopHardCapBlock,
    progressAssessmentEnabled: config.progressAssessmentEnabled,
    onSkillCreated: (skillPath) => skillManager.loadSingle(skillPath),
    getSkillEntries: () => skillManager.getEntries(),
    agentCoreFlagSet,
    capabilityRegistry,
    capabilityAdapters,
  });

  // Wire FrameworkPromptGenerator to the orchestrator (deferred: IIFE may complete before or after)
  // Held so the agent/delegation stages can hand their orchestrators the same
  // generator. They are constructed before this deferred wiring finishes, which
  // is why they receive an accessor rather than the instance.
  let frameworkPromptGenerator: import("../intelligence/framework/framework-prompt-generator.js").FrameworkPromptGenerator | undefined;
  const getFrameworkPromptGenerator = () => frameworkPromptGenerator;

  const wireFrameworkPromptGenerator = async (store: FrameworkKnowledgeStore) => {
    try {
      const { FrameworkPromptGenerator } = await import("../intelligence/framework/framework-prompt-generator.js");
      const generator = new FrameworkPromptGenerator(store);
      frameworkPromptGenerator = generator;
      orchestrator.setFrameworkPromptGenerator(generator);
      logger.debug("FrameworkPromptGenerator wired to orchestrator");
    } catch (fwErr) {
      logger.debug("FrameworkPromptGenerator wiring failed (non-fatal)", {
        reason: fwErr instanceof Error ? fwErr.message : String(fwErr),
      });
    }
  };
  if (frameworkStore) {
    // IIFE already completed synchronously (unlikely but possible)
    await wireFrameworkPromptGenerator(frameworkStore);
  } else {
    // Set callback for when the async IIFE completes
    onFrameworkStoreReady = (store) => {
      wireFrameworkPromptGenerator(store).catch((err) => {
        logger.warn("FrameworkPromptGenerator wiring failed", { error: err instanceof Error ? err.message : String(err) });
      });
    };
    // If the IIFE already completed before we got here, apply the buffered result
    if (deferredFrameworkStore) {
      onFrameworkStoreReady(deferredFrameworkStore);
      deferredFrameworkStore = null;
    }
  }

  const { chainManager } = await initializeToolChainStage({
    config,
    logger,
    learningStorage: learningResult.storage,
    learningEventBus: learningResult.eventBus as IEventBus<LearningEventMap> | undefined,
    learningQueue: learningResult.learningQueue,
    learningPipeline: learningResult.pipeline,
    toolRegistry,
    providerManager,
    orchestrator,
  });
  if (chainManager) {
    disposables.push("chainManager", () => chainManager.stop());
  }

  const {
    daemonEventBus,
    taskStorage,
    backgroundExecutor,
    taskManager,
    autoUpdater,
    projectScopeFingerprint,
    commandHandler,
    messageRouter,
    realTreeGuardian,
  } = await initializeTaskRuntimeStage({
    daemonMode: Boolean(options.daemonMode),
    metrics,
    config,
    logger,
    orchestrator,
    providerManager,
    channel,
    dmPolicy,
    userProfileStore,
    soulLoader,
    runtimeArtifactManager,
    activityRegistry,
    goalDecomposer,
    goalStorage,
    learningEventBus: learningResult.eventBus,
    identityManager,
    providerRouter,
    startupNotices,
    toolRegistry,
  });
  commandHandler.setVaultRegistry(vaultRegistry);
  if (taskStorage) {
    disposables.push("taskStorage", () => taskStorage.close());
  }
  if (backgroundExecutor) {
    disposables.push("backgroundExecutor", () => backgroundExecutor.shutdown());
  }
  if (autoUpdater) {
    disposables.push("autoUpdater", () => autoUpdater.shutdown());
  }
  if (realTreeGuardian) {
    disposables.push("realTreeGuardian", () => realTreeGuardian.stop());
  }
  if (messageRouter) {
    disposables.push("messageRouter", () => messageRouter.dispose());
  }

  let outerCheckpointStore: { close(): void } | undefined;
  // Task checkpoint store — persists in-flight context for budget / provider
  // aborts so we can resume rather than silently drop the user's work.
  // Lives next to tasks.db under the memory db dir.
  try {
    const { join: pathJoin } = await import("node:path");
    const { TaskCheckpointStore } = await import("../tasks/task-checkpoint-store.js");
    const checkpointDbPath = pathJoin(config.memory.dbPath, "task-checkpoints.db");
    const checkpointStore = new TaskCheckpointStore(checkpointDbPath);
    checkpointStore.initialize();
    outerCheckpointStore = checkpointStore;
    disposables.push("checkpointStore", () => checkpointStore.close());
    orchestrator.setTaskCheckpointStore(checkpointStore);
    commandHandler.setTaskCheckpointStore(checkpointStore);
    taskManager.setCheckpointStore(checkpointStore);
    // Wire the orchestrator into the command handler so /retry, /continue,
    // and implicit recovery intents can trigger real checkpoint replays
    // (not just metadata display). Safe late-binding setter — avoids the
    // circular import that would arise from declaring the dependency in
    // the command-handler constructor.
    commandHandler.setOrchestrator(orchestrator);
    // Wire the web channel's `verify:*` ownership resolver so cross-chat
    // spawn attempts (CWE-639) are rejected when a persistent checkpoint
    // for the taskId exists. Non-web channels (Telegram, Discord, CLI, …) that
    // don't implement the optional API are simply skipped via `?.` — keeps
    // bootstrap free of a hard WebChannel import.
    if (typeof channel.setTaskOwnerResolver === "function") {
      channel.setTaskOwnerResolver(async (taskId) => {
        // Resolver must NEVER throw into the WS handler (WebChannel
        // already allow-and-logs on throw, but returning null on failure
        // keeps the fast path clean).
        try {
          const cp = await checkpointStore.loadByTaskId(taskId);
          return cp?.chatId ?? null;
        } catch {
          return null;
        }
      });
      logger.info("Task ownership resolver wired into web channel");
    }
    logger.info("Task checkpoint store initialized", { dbPath: checkpointDbPath });
  } catch (err) {
    logger.warn("Task checkpoint store failed to initialize — continuing without checkpointing", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Register services for deep readiness checks and agent metrics endpoint
  if (dashboard) {
    dashboard.registerServices({
      memoryManager,
      channel,
      metricsStorage,
      learningStorage: learningResult.storage,
      runtimeArtifactManager,
      projectScopeFingerprint,
      goalStorage,
      chainResilienceConfig: config.toolChain.resilience,
    });
    dashboard.registerSkillManager(skillManager);
  }
  // HeartbeatLoop wired to CommandHandler below after daemon init (late binding)

  // Create DaemonStorage + UnifiedBudgetManager unconditionally so /token and
  // the portal budget editor work even in non-daemon runtimes (CLI, web, …).
  const daemonDbPath = join(config.memory.dbPath, "daemon.db");
  const sharedDaemonStorage = new DaemonStorage(daemonDbPath);
  sharedDaemonStorage.initialize();
  // Opened unconditionally and (by design) kept open for the daemon's lifetime on
  // success; close it only on the failure path so a mid-bootstrap throw can't leak
  // the daemon.db SQLite fd.
  disposables.push("daemonStorage", () => sharedDaemonStorage.close());
  // Flat-fee auth pays no per-token dollars: billing a ChatGPT subscription at
  // API-key rates fabricated spend that budget walls then enforced (the daemon
  // went quiet daily on $10 of imaginary money). Zero the metered rate.
  if (config.openaiAuthMode === "chatgpt-subscription") {
    const { markProviderFlatFee } = await import("../budget/cost-model.js");
    markProviderFlatFee("openai");
    logger.info("OpenAI metered cost rate zeroed: chatgpt-subscription auth is flat-fee");
  }
  const sharedUnifiedBudgetManager = new UnifiedBudgetManager(
    sharedDaemonStorage,
    daemonEventBus ?? { emit: () => {} },
    process.env,
  );
  sharedDaemonStorage.migrateBudgetSource();
  // Wire immediately — orchestrator loop re-reads every iteration, and
  // commandHandler.handleToken needs a live manager to update.
  orchestrator.setUnifiedBudgetManager(sharedUnifiedBudgetManager);
  commandHandler.setUnifiedBudgetManager(sharedUnifiedBudgetManager);
  backgroundExecutor.setUnifiedBudgetManager(sharedUnifiedBudgetManager);
  // Settlement hook for the dev-knowledge completion note: the route-level
  // call sites fire when a background task is merely SUBMITTED (planner state
  // empty → real-work gate rejects), so this note type had written exactly 0
  // times while the verdict notes wrote 213. Settlement carries the real
  // outcome — files touched, node tallies, failure reasons.
  if (devKnowledgeNoteWriter) {
    const writerForHook = devKnowledgeNoteWriter;
    const { fireDevKnowledgeCompletionNote: fireNote } = await import("../vault/dev-knowledge-writer.js");
    backgroundExecutor.setDevKnowledgeCompletionHook((p) =>
      fireNote(writerForHook, {
        goal: p.goal,
        success: p.success,
        reason: p.reason,
        taskRunId: p.taskRunId,
        state: { iterationsUsed: p.iterationsUsed, mutationsSinceVerify: 0, errorHistory: [] },
        steps: p.touchedFiles.map((f) => ({ toolName: "file_write", input: { path: f } })),
        errorCount: p.errorCount,
      }),
    );
  }
  if (dashboard) {
    dashboard.setUnifiedBudgetManager(sharedUnifiedBudgetManager);
  }

  // Initialize daemon heartbeat loop (if daemon mode enabled)
  if (options.daemonMode) {
    const daemonConfig = config.daemon;

    // No budget set anywhere (neither system nor daemon-specific): the
    // daemon still runs — the UnifiedBudgetManager's guards are the wallet;
    // a missing cap means "share whatever the system allows", not "off".
    if (!daemonConfig.budget.dailyBudgetUsd) {
      logger.info("Daemon budget: sharing the system budget (no dedicated cap set)");
    }
    {
      // daemonEventBus is guaranteed defined when daemonMode is true
      const daemonBus = daemonEventBus!;
      const {
        daemonStorage,
        triggerRegistry,
        budgetTracker: budgetTrackerInstance,
        approvalQueue: approvalQueueInstance,
        heartbeatLoop: activeHeartbeatLoop,
        webhookTriggers,
        unifiedBudgetManager,
      } = initializeDaemonHeartbeatStage({
        config,
        logger,
        toolRegistry,
        backgroundExecutor,
        taskManager,
        commandHandler,
        daemonEventBus: daemonBus,
        identityManager,
        crashContext,
        daemonStorage: sharedDaemonStorage,
        unifiedBudgetManager: sharedUnifiedBudgetManager,
      });
      heartbeatLoop = activeHeartbeatLoop;
      disposables.push("heartbeatLoop", () => heartbeatLoop?.stop());

      // Agent Core: autonomous OODA reasoning loop (Phase 4)
      try {
        const { AgentCore } = await import("../agent-core/agent-core.js");
        const { ObservationEngine } = await import("../agent-core/observation-engine.js");
        const { PriorityScorer } = await import("../agent-core/priority-scorer.js");
        const { TriggerObserver, UserActivityObserver, GitStateObserver, BuildStateObserver } =
          await import("../agent-core/observers/index.js");
        const { getLatestGlobalBuildState } = await import("../agents/autonomy/self-verification.js");

        const observationEngine = new ObservationEngine();

        // Register observers that wrap existing infrastructure
        observationEngine.register(new TriggerObserver(triggerRegistry));
        observationEngine.register(new UserActivityObserver(daemonConfig.heartbeat.intervalMs * 5));
        observationEngine.register(new GitStateObserver(config.unityProjectPath));
        // Build health flows through the process-wide publication every
        // SelfVerification instance writes on each tracked verification tool.
        observationEngine.register(new BuildStateObserver({ getState: getLatestGlobalBuildState }));

        observationEngine.start();

        const priorityScorer = new PriorityScorer(instinctRetriever);
        const agentCoreInstance = new AgentCore(
          observationEngine,
          priorityScorer,
          providerManager.getProvider(""),
          taskManager,
          channel,
          budgetTrackerInstance,
          instinctRetriever,
          undefined, // config — use defaults
          providerRouter,
          providerRouter ? providerManager : undefined,
        );

        heartbeatLoop.setAgentCore(agentCoreInstance);
        logger.info("Agent Core initialized", { observers: observationEngine.getObserverCount() });
      } catch (error) {
        logger.warn("Agent Core initialization failed (non-fatal)", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Create NotificationRouter (RPT-03, RPT-04)
      notificationRouterInstance = new NotificationRouter({
        config: config.notification,
        quietHoursConfig: config.quietHours,
        eventBus: daemonBus,
        storage: daemonStorage,
        channelSender: channel,
        chatId: undefined, // Will be set on first message
      });
      notificationRouterInstance.start();
      disposables.push("notificationRouter", () => notificationRouterInstance?.stop());

      // Create DigestReporter (RPT-01)
      digestReporterInstance = new DigestReporter({
        config: config.digest,
        daemonConfig: { timezone: daemonConfig.timezone },
        storage: daemonStorage,
        channelSender: channel,
        chatId: undefined, // Will be set on first message
        channelType,
        eventBus: daemonBus,
        metricsStorage,
        learningStorage: learningResult.storage,
        budgetTracker: budgetTrackerInstance,
        dashboardPort: config.dashboard.port,
        logger,
      });
      digestReporterInstance.start();
      disposables.push("digestReporter", () => digestReporterInstance?.stop());

      // Build daemon context for CLI commands (Plan 05 + Plan 18-02 reporting + Plan 21-03 decay stats + Plan 22-04 chain resilience)
      daemonContext = {
        heartbeatLoop,
        registry: triggerRegistry,
        budgetTracker: budgetTrackerInstance,
        approvalQueue: approvalQueueInstance,
        storage: daemonStorage,
        config: daemonConfig,
        digestReporter: digestReporterInstance,
        notificationRouter: notificationRouterInstance,
        memoryManager,
        learningStorage: learningResult.storage,
        chainResilienceConfig: config.toolChain.resilience,
      };

      const multiAgentStage = await initializeMultiAgentDelegationStage({
        getFrameworkPromptGenerator,
        config,
        logger,
        daemonMode: Boolean(options.daemonMode),
        daemonStorage,
        daemonContext: daemonContext!,
        taskManager,
        orchestrator,
        learningEventBus: learningResult.eventBus,
        providerManager,
        toolRegistry,
        channel,
        metrics,
        ragPipeline,
        rateLimiter,
        instinctRetriever,
        metricsRecorder,
        goalDecomposer,
        identityManager,
        cachedEmbeddingProvider,
        soulLoader,
        dmPolicy,
        userProfileStore,
        providerRouter,
        dashboard,
        stradaDeps,
        supervisorBrain,
        goalStorage,
        vaultRegistry,
        vaultWriteHookBudgetMs: config.vault?.writeHookBudgetMs,
      });
      agentManager = multiAgentStage.agentManager;
      agentManager?.setUnifiedBudgetManager?.(unifiedBudgetManager);
      // Wire the live budget manager into the orchestrator so the token-budget
      // loop reads fresh values (portal POST /api/budget/config + env overrides).
      orchestrator.setUnifiedBudgetManager(unifiedBudgetManager);
      // Also wire into the command handler so /token can update the live budget.
      commandHandler.setUnifiedBudgetManager(unifiedBudgetManager);
      agentBudgetTrackerOuter = multiAgentStage.agentBudgetTracker;
      delegationManager = multiAgentStage.delegationManager;
      disposables.push("agentManager", () => agentManager?.shutdown());
      disposables.push("delegationManager", () => delegationManager?.shutdown());
      // Activate capability-aware delegation scoring with the live model catalog
      // (created earlier in bootstrap than the DelegationManager).
      if (modelIntelligence) {
        delegationManager?.setModelIntelligence(modelIntelligence);
      }

      // Derive delegation tiers the operator left empty from the live catalog.
      // Pins (non-empty config values) are filtered out here, so they are never
      // passed to the router as "derived" and can never be overwritten.
      if (modelIntelligence && delegationManager) {
        try {
          const { resolveTierMap } = await import("../agents/multi/delegation/tier-resolution.js");
          const { getAvailableProviderNames } = await import("../config/config.js");
          const configuredTiers = config.delegation.tiers;
          // Fold in what this deployment has actually observed. The store
          // accumulates per `provider` AND per `provider::model`, and
          // getBlendedProfile already weights observations against the static
          // prior by sample count — so a model with little history returns
          // something close to its baseline rather than a noisy extreme.
          const behavioralScore = dynamicProfiles
            ? (provider: string, modelId: string): number | undefined => {
              const profile = dynamicProfiles.getBlendedProfile(provider, modelId);
              if (!profile) return undefined;
              const values = Object.values(profile.scores);
              if (values.length === 0) return undefined;
              return values.reduce((sum, v) => sum + v, 0) / values.length;
            }
            : undefined;
          const { tiers: derivedTiers, derivations } = resolveTierMap({
            configured: configuredTiers,
            catalog: modelIntelligence.getAllModels(),
            availableProviders: getAvailableProviderNames(config),
            ...(behavioralScore ? { behavioralScore } : {}),
          });
          const derivedOnly = Object.fromEntries(
            Object.entries(derivedTiers).filter(
              ([tier]) => !configuredTiers[tier as keyof typeof configuredTiers]?.trim(),
            ),
          );
          delegationManager.getTierRouter().applyDerivedTiers(derivedOnly);
          for (const d of derivations) {
            const line = { tier: d.tier, spec: d.spec, source: d.source, reason: d.reason };
            if (d.source === "unresolved") {
              logger.warn("Delegation tier unresolved", line);
            } else {
              logger.info("Delegation tier resolved", line);
            }
          }
        } catch (error) {
          // Tier derivation is an optimization, never a boot blocker: on failure
          // the router keeps whatever the config gave it.
          logger.warn("Delegation tier derivation failed; using configured tiers", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await initializeMemoryConsolidationStage({
        config,
        logger,
        memoryManager,
        cachedEmbeddingProvider,
        providerManager,
        learningEventBus: learningResult.eventBus,
        heartbeatLoop,
        daemonContext: daemonContext!,
      });

      await initializeDeploymentStage({
        config,
        logger,
        daemonConfig,
        daemonStorage,
        approvalQueue: approvalQueueInstance,
        triggerRegistry,
        heartbeatLoop,
        daemonEventBus: daemonEventBus!,
        taskManager,
        daemonContext: daemonContext!,
      });

      if (dashboard) {
        // Wire daemon context into dashboard (Plan 05 + Plan 18-03 enrichment)
        dashboard.setDaemonContext({
          heartbeatLoop,
          registry: triggerRegistry,
          approvalQueue: approvalQueueInstance,
          webhookTriggers,
          webhookSecret: daemonConfig.triggers.webhookSecret,
          webhookRateLimit: daemonConfig.triggers.webhookRateLimit,
          dashboardToken: config.websocketDashboard.authToken,
          identityManager,
          capabilityManifest: buildCapabilityManifest(),
          startupNotices: [...new Set(startupNotices)],
          daemonStorage,
          historyDepth: 10,
          triggerFireRetentionDays: daemonConfig.triggerFireRetentionDays,
          autoUpdater,
        });
      }
    }
  }

  // Wire up message handler
  if (agentManager) {
    // Give AgentManager the command handler so prefix commands bypass LLM
    agentManager.setCommandHandler(commandHandler);

    // Multi-agent mode: route through AgentManager (AGENT-06)
    channel.onMessage(async (msg) => {
      const audioResult = await transcribeIncomingAudioMessage(msg, config.unityProjectPath);
      if (audioResult.shouldDrop) {
        if (audioResult.userWarning) {
          await channel.sendText(msg.chatId, audioResult.userWarning);
        }
        return;
      }
      const normalizedMsg = audioResult.message;

      // Bind daemon notification delivery to the first real inbound chat so
      // quiet-hours drains, grouped summaries, and high/critical alerts have a
      // concrete chat target (the router is constructed with chatId=undefined).
      if (normalizedMsg.chatId) {
        notificationRouterInstance?.setChatId(normalizedMsg.chatId);
        digestReporterInstance?.setChatId(normalizedMsg.chatId);
      }

      activityRegistry.recordActivity(channelType, normalizedMsg.chatId);
      // Interrupt consolidation on user activity (MEM-13)
      heartbeatLoop?.onUserActivity();
      if (identityManager) {
        identityManager.recordActivity();
        identityManager.incrementMessages();
      }
      let taskRunId: string | undefined;
      if (learningResult.taskPlanner) {
        learningResult.taskPlanner.startTask({
          sessionId: normalizedMsg.chatId ?? generateSessionId(),
          chatId: normalizedMsg.chatId,
          taskDescription: normalizedMsg.text.slice(0, 200),
          learningPipeline: learningResult.pipeline,
        });
        taskRunId = learningResult.taskPlanner.getTaskRunId() ?? undefined;
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
            await agentManager!.routeMessage(normalizedMsg);
          } catch (error) {
            routeError = error;
            throw error;
          } finally {
            if (learningResult.taskPlanner?.isActive()) {
              learningResult.taskPlanner.attachReplayContext(
                await orchestrator.buildTrajectoryReplayContext({
                  chatId: normalizedMsg.chatId,
                  userId: normalizedMsg.userId,
                  conversationId: normalizedMsg.conversationId,
                  channelType: normalizedMsg.channelType,
                  sinceTimestamp: learningResult.taskPlanner.getTaskStartedAt() ?? undefined,
                  taskRunId,
                }),
              );
              // LIVING VAULT (B): fire the fire-and-forget dev-knowledge
              // write-back BEFORE endTask teardown (multi-agent twin of the
              // single-agent path). Real-work-gated; INCLUDES failures; skips
              // trivial chat. Never awaited.
              fireDevKnowledgeCompletionNote(devKnowledgeNoteWriter, {
                goal: normalizedMsg.text,
                success: routeError === undefined,
                reason: routeError instanceof Error ? routeError.message : undefined,
                taskRunId,
                state: learningResult.taskPlanner.getState(),
                steps: learningResult.taskPlanner.getTrajectorySteps().map((s) => ({
                  toolName: String(s.toolName),
                  input: s.input as Record<string, unknown> | undefined,
                })),
                errorCount: routeError === undefined ? 0 : 1,
              });
              learningResult.taskPlanner.endTask({
                success: routeError === undefined,
                finalOutput: routeError instanceof Error ? routeError.message : undefined,
                hadErrors: routeError !== undefined,
                errorCount: routeError === undefined ? 0 : 1,
                // Issue #22 (SIBLING A): when trajectory-level credit is ON, the in-run trigger is the
                // sole recordTrajectory writer; suppress this early, empty-step route-level emission to
                // avoid a duplicate. Flag-OFF (default) ⇒ false ⇒ records exactly as today.
                suppressTrajectoryRecord:
                  learningResult.pipeline?.isTrajectoryLevelCreditEnabled() ?? false,
              });
            }
          }
        },
      );
    });
  } else {
    // v2.0 single-agent mode: unchanged path (AGENT-07)
    wireMessageHandler(
      channel,
      messageRouter,
      orchestrator,
      learningResult.taskPlanner,
      learningResult.pipeline,
      config.unityProjectPath,
      identityManager,
      heartbeatLoop,
      activityRegistry,
      channelType,
      notificationRouterInstance,
      digestReporterInstance,
      devKnowledgeNoteWriter,
    );
  }

  // Wire feedback reactions from channel adapters to the learning event bus
  if (learningResult.eventBus) {
    const feedbackBus = learningResult.eventBus;
    const feedbackCallback = (
      type: "thumbs_up" | "thumbs_down",
      instinctIds: string[],
      userId?: string,
      source?: "reaction" | "button",
    ) => {
      feedbackBus.emit("feedback:reaction", {
        type,
        instinctIds,
        userId,
        source: source ?? "reaction",
        channel: channelType,
        timestamp: Date.now(),
      });
    };
    if (typeof channel.setFeedbackHandler === "function") {
      channel.setFeedbackHandler(feedbackCallback);
    }
  }

  const postSetupBootstrap = options.postSetupBootstrap;
  if (postSetupBootstrap && channel.setPostSetupBootstrapHandler) {
    channel.setPostSetupBootstrapHandler(async (context) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, POST_SETUP_BOOTSTRAP_DELAY_MS);
      });

      await orchestrator.deliverPostSetupBootstrap(context, postSetupBootstrap);

      if (postSetupBootstrap.autonomy?.enabled) {
        const expiresAt =
          typeof postSetupBootstrap.autonomy.hours === "number"
            ? Date.now() + postSetupBootstrap.autonomy.hours * 3600_000
            : undefined;
        heartbeatLoop?.getSecurityPolicy().setAutonomousOverride(true, expiresAt);
      }
    });
  } else {
    channel.setPostSetupBootstrapHandler?.(null);
  }

  // Setup cleanup
  const cleanupInterval = setupCleanup(orchestrator);
  disposables.push("cleanupInterval", () => clearInterval(cleanupInterval));

  // Workspace/monitor runtime must be wired before channel.connect() so the
  // first inbound supervisor request cannot race ahead of executeNode setup.
  const workspaceBus = initializeWorkspaceRuntime({
    learningEventBus: learningResult.eventBus,
    daemonEventBus,
    channel: channel as { broadcastRaw?: (msg: string) => void },
    orchestrator,
    backgroundExecutor,
    supervisorBrain,
    dashboard,
    agentManager,
    stoppableServers,
    channelType,
    orchestratorForSupervisorBridge: orchestrator,
    goalStorage,
  });

  const workspaceRuntimeBridge = createWorkspaceRuntimeBridge({
    workspaceBus,
    goalStorage,
    taskManager,
  });
  workspaceRuntimeBridge.start();
  stoppableServers.push(workspaceRuntimeBridge);

  // Task lifecycle → workspace bus (dashboard receives task created/completed/failed/blocked)
  const taskWorkspaceBridge = createTaskWorkspaceBridge(taskManager, workspaceBus);
  taskWorkspaceBridge.start();
  stoppableServers.push(taskWorkspaceBridge);

  // Resolve primary provider streaming capability for boot-time config warnings
  const primaryProviderName = config.providerChain?.split(/[>,\s]+/).filter(Boolean)[0];
  const primaryProviderStreaming = primaryProviderName
    ? providerManager.getProviderCapabilities(primaryProviderName)?.streaming
    : undefined;

  const bootReport = await finalizeChannelStartupStage({
    beforeChannelConnect,
    channel,
    logger,
    config,
    channelType,
    daemonMode: Boolean(options.daemonMode),
    providerHealthy: providerInit.healthCheckPassed,
    embeddingStatus,
    deploymentWired: Boolean(daemonContext?.deploymentExecutor),
    alertingWired: false,
    backupWired: false,
    stradaMcpRuntime: toolRegistry.getStradaMcpRuntimeStatus(),
    primaryProviderSupportsStreaming: primaryProviderStreaming,
    startupNotices,
    moduleUrl: import.meta.url,
  });

  // Wire identity manager to dashboard even without daemon mode
  if (dashboard && identityManager && !dashboard["identityManager"]) {
    dashboard.setDaemonContext({
      identityManager,
      dashboardToken: config.websocketDashboard.authToken,
      startupNotices: [...new Set(startupNotices)],
      autoUpdater,
    });
  }

  registerDashboardPostBootStage({
    dashboard,
    agentManager,
    agentBudgetTracker: agentBudgetTrackerOuter,
    daemonContext,
    toolRegistry,
    taskManager,
    orchestrator,
    soulLoader,
    config,
    providerManager,
    userProfileStore,
    embeddingStatus,
    stradaDeps,
    bootReport,
    providerRouter,
  });

  // Wire canvas storage into dashboard for canvas REST endpoints (Phase 4)
  let canvasStorage: CanvasStorage | undefined;
  if (dashboard) {
    let canvasDb: Database.Database | undefined;
    try {
      const canvasDbPath = join(config.memory.dbPath, "canvas.db");
      canvasDb = new Database(canvasDbPath);
      canvasStorage = new CanvasStorage(canvasDb);
      disposables.push("canvasStorage", () => canvasStorage?.close());
      dashboard.setCanvasStorage(canvasStorage);
      logger.info("Canvas storage initialized", { path: canvasDbPath });
    } catch (error) {
      canvasDb?.close();
      logger.warn("Canvas storage initialization failed, canvas endpoints degraded", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Wire project root into dashboard for workspace file endpoints (Phase 5)
  if (dashboard) {
    dashboard.setProjectRoot(config.unityProjectPath);
  }

  // Wire incoming workspace commands from the frontend into the workspace bus
  if (typeof channel.setWorkspaceBusEmitter === "function") {
    channel.setWorkspaceBusEmitter((event: string, payload: unknown) => {
      const key = event as keyof import("../dashboard/workspace-events.js").WorkspaceEventMap & string;
      // Report whether anything is subscribed so the channel's ack can say
      // "enforced" only when a consumer actually received the command
      // (audited 2026-09-02: verify:gate_decision had none and was acked as enforced).
      const delivered = workspaceBus.listenerCount(key) > 0;
      workspaceBus.emit(key, payload as never);
      return delivered;
    });
  }

  // Return result with shutdown function
  return {
    orchestrator,
    messageRouter,
    channel,
    container,
    heartbeatLoop,
    daemonContext,
    agentManager,
    activityRegistry,
    autoUpdater,
    bootReport,
    workspaceBus,
    shutdown: createShutdownHandler({
      dashboard,
      canvasStorage,
      ragPipeline,
      memoryManager,
      cachedEmbeddingProvider,
      channel,
      cleanupInterval,
      learningPipeline: learningResult.pipeline,
      learningStorage: learningResult.storage,
      taskStorage,
      taskManager,
      providerManager,
      eventBus: learningResult.eventBus,
      learningQueue: learningResult.learningQueue,
      metricsStorage,
      goalStorage,
      chainManager,
      toolRegistry,
      identityManager,
      modelIntelligence,
      mcpConnections,
      dynamicProfiles,
      dynamicProfilePersistence,
      dynamicProfilesFlushInterval,
      uptimeInterval,
      heartbeatLoop,
      digestReporter: digestReporterInstance,
      notificationRouter: notificationRouterInstance,
      agentManager,
      messageRouter,
      vaultRegistry,
      backgroundExecutor,
      delegationManager,
      stoppableServers,
      soulLoader,
      autoUpdater,
      checkpointStore: outerCheckpointStore,
      providerHealthRegistry: ProviderHealthRegistry.getInstance(),
      providerHealthPersistencePath: providerHealthPath,
      // Close daemon.db on a clean shutdown too — it is opened unconditionally
      // and otherwise leaks its fd/WAL across restarts (failure path already
      // closes it via the disposables stack).
      daemonStorage: sharedDaemonStorage,
      // Framework store/pipeline are assigned by a detached IIFE that may finish
      // after this point; adapter objects read the live refs at shutdown time so
      // the watcher + SQLite fd are released on a clean stop, not just on failure.
      frameworkStore: { close: () => frameworkStore?.close() },
      frameworkSyncPipeline: { stop: async () => { await frameworkSyncPipeline?.stop(); } },
    }),
  };
}

// ============================================================================
// Private Helpers (kept in bootstrap.ts — used only by bootstrap())
// ============================================================================

function initializeAuth(config: Config, channelType: string, logger: winston.Logger): AuthManager {
  const allowedTelegramIds = config.telegram.allowedUserIds ?? [];
  if (channelType === "telegram" && allowedTelegramIds.length === 0) {
    logger.warn("ALLOWED_TELEGRAM_USER_IDS is empty — all Telegram users will be denied access");
  }

  const allowedDiscordIds = new Set(config.discord.allowedUserIds);
  const allowedDiscordRoles = new Set(config.discord.allowedRoleIds);

  if (channelType === "discord" && allowedDiscordIds.size === 0 && allowedDiscordRoles.size === 0) {
    logger.warn(
      "ALLOWED_DISCORD_USER_IDS and ALLOWED_DISCORD_ROLE_IDS are empty — all Discord users will be denied access",
    );
  }

  return new AuthManager(allowedTelegramIds, {
    allowedDiscordIds,
    allowedDiscordRoles,
  });
}

async function initializeRAG(
  config: Config,
  logger: winston.Logger,
  cachedProvider?: CachedEmbeddingProvider,
): Promise<RAGResult> {
  if (!config.rag.enabled) {
    logger.info("RAG: disabled by configuration");
    return {};
  }

  if (!cachedProvider) {
    // No provider was resolved upstream — RAG cannot function
    const notice =
      "RAG disabled: no embedding provider available. Semantic code search is unavailable.";
    logger.warn("RAG: disabled — no embedding provider available");
    return { notice };
  }

  try {
    const vectorStorePath = join(config.memory.dbPath, "vectors");
    const vectorStore = new FileVectorStore(vectorStorePath, cachedProvider.dimensions);

    // Dimension mismatch detection: check existing data before initializing
    const chunksPath = join(vectorStorePath, "chunks.json");
    const vectorsPath = join(vectorStorePath, "vectors.bin");
    if (existsSync(chunksPath) && existsSync(vectorsPath)) {
      try {
        const vectorsBuf = readFileSync(vectorsPath);
        const chunksRaw = readFileSync(chunksPath, "utf8");
        const chunks = JSON.parse(chunksRaw) as unknown[];
        if (chunks.length > 0 && vectorsBuf.byteLength > 0) {
          const storedDims = vectorsBuf.byteLength / 4 / chunks.length;
          if (storedDims !== cachedProvider.dimensions) {
            logger.warn(
              `RAG: dimension mismatch (stored: ${storedDims}, provider: ${cachedProvider.dimensions}). Clearing vector index for re-indexing.`,
            );
            // Remove the files so FileVectorStore starts empty
            const { unlinkSync } = await import("node:fs");
            unlinkSync(chunksPath);
            unlinkSync(vectorsPath);
          }
        }
      } catch {
        // If we can't read existing data, FileVectorStore will handle it
      }
    }

    // HNSW configuration from environment or defaults
    const hnswConfig = {
      M: parseInt(process.env["HNSW_M"] ?? "16", 10),
      efConstruction: parseInt(process.env["HNSW_EF_CONSTRUCTION"] ?? "200", 10),
      efSearch: parseInt(process.env["HNSW_EF_SEARCH"] ?? "128", 10),
      maxElements: parseInt(process.env["HNSW_MAX_ELEMENTS"] ?? "100000", 10),
    };

    // Check if HNSW is disabled via environment
    const useHNSW = process.env["HNSW_DISABLED"] !== "true";

    const pipeline = new RAGPipeline(cachedProvider, vectorStore, {
      useHNSW,
      hnswConfig,
    });
    await pipeline.initialize();

    logger.info("RAG pipeline initialized", {
      provider: cachedProvider.name,
      dimensions: cachedProvider.dimensions,
      hnsw: pipeline.isUsingHNSW(),
    });

    // Background indexing
    pipeline
      .indexProject(config.unityProjectPath)
      .then((stats) => logger.info("Initial RAG indexing complete", stats))
      .catch((err) =>
        logger.warn("Initial RAG indexing failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

    return { pipeline, cachedProvider };
  } catch (error) {
    const notice =
      "RAG disabled: embedding initialization failed. Semantic code search is unavailable.";
    logger.warn("RAG initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { notice };
  }
}

async function initializeLearning(
  config: Config,
  logger: winston.Logger,
  embeddingProvider?: CachedEmbeddingProvider,
): Promise<LearningResult> {
  const notices: string[] = [];
  try {
    const learningDbPath = join(config.memory.dbPath, "learning.db");
    const learningStorage = new LearningStorage(learningDbPath);
    learningStorage.initialize();

    // Run cross-session migrations (Phase 13) with graceful degradation
    const db = learningStorage.getDatabase();
    if (db) {
      try {
        const runner = new MigrationRunner(db, learningDbPath);
        const migrationResult = runner.run([migration001CrossSessionProvenance]);
        if (migrationResult.applied.length > 0) {
          logger.info("Learning DB migrations applied", { applied: migrationResult.applied });
        }
      } catch (error) {
        logger.warn("Learning DB migration failed, cross-session features degraded", {
          error: error instanceof Error ? error.message : String(error),
        });
        // Graceful degradation: continue without cross-session features
      }
    }

    // Create event bus for decoupled learning (created before pipeline so it can be injected)
    const eventBus = new TypedEventBus<LearningEventMap>();
    const learningQueue = new LearningQueue();

    if (!embeddingProvider) {
      const notice = "Instinct embeddings disabled: learning continues with lexical matching only.";
      notices.push(notice);
      logger.warn(
        "Learning initialized without embedding provider; semantic instinct features disabled",
      );
    }

    const pipeline = new LearningPipeline(
      learningStorage,
      {
        dbPath: learningDbPath,
        enabled: LEARNING_DEFAULTS.enabled,
        batchSize: config.learningPipelineV2.detectionWindowSize,
        detectionIntervalMs: config.learningPipelineV2.periodicExtractionInterval as DurationMs,
        evolutionIntervalMs: LEARNING_DEFAULTS.evolutionIntervalMs as DurationMs,
        minConfidenceForCreation: LEARNING_DEFAULTS.minConfidenceForCreation,
        maxInstincts: config.learningPipelineV2.maxInstincts,
      },
      embeddingProvider,
      config.bayesian,
      eventBus,
    );

    pipeline.start();

    const { InterventionEngine } = await import("../learning/intervention/intervention-engine.js");
    const interventionEngine = new InterventionEngine(learningStorage);

    const patternMatcher = new PatternMatcher(learningStorage, { eventBus });
    const confidenceScorer = new ConfidenceScorer({
      confidenceWeights: config.learningPipelineV2.confidenceWeights,
    });
    const errorLearningHooks = new ErrorLearningHooks(
      pipeline,
      patternMatcher,
      confidenceScorer,
      learningStorage,
    );

    const errorRecovery = new ErrorRecoveryEngine();
    errorRecovery.enableLearning(errorLearningHooks, {
      enableLearning: true,
      sessionId: "default",
    });

    const taskPlanner = new TaskPlanner();
    taskPlanner.enableLearning(pipeline);

    // Subscribe learning pipeline to tool result events via serial queue
    eventBus.on("tool:result", (event) => {
      learningQueue.enqueue(async () => {
        await pipeline.handleToolResult(event);
      });
    });

    logger.info("Learning pipeline initialized", {
      dbPath: learningDbPath,
      stats: pipeline.getStats(),
    });

    return {
      pipeline,
      storage: learningStorage,
      patternMatcher,
      taskPlanner,
      errorRecovery,
      eventBus,
      learningQueue,
      interventionEngine,
      notices,
    };
  } catch (error) {
    const notice =
      "Learning pipeline disabled: startup initialization failed. Core chat remains available.";
    notices.push(notice);
    logger.warn("Learning pipeline initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      taskPlanner: new TaskPlanner(),
      errorRecovery: new ErrorRecoveryEngine(),
      notices,
    };
  }
}
