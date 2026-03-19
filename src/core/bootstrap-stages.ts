import { join } from "node:path";
import type { Config } from "../config/config.js";
import type * as winston from "winston";
import type { AuthManager } from "../security/auth.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type { IRAGPipeline } from "../rag/rag.interface.js";
import type { CachedEmbeddingProvider } from "../rag/embeddings/embedding-cache.js";
import type { ProviderManager } from "../agents/providers/provider-manager.js";
import type { DashboardServer } from "../dashboard/server.js";
import type { MetricsCollector } from "../dashboard/metrics.js";
import type { RateLimiter } from "../security/rate-limiter.js";
import { resolveRuntimePaths } from "../common/runtime-paths.js";
import { buildBootReport, summarizeBootReport } from "./boot-report.js";
import { MetricsStorage } from "../metrics/metrics-storage.js";
import { MetricsRecorder } from "../metrics/metrics-recorder.js";
import type { BootReport } from "../common/capability-contract.js";
import type { LearningPipeline, LearningStorage, PatternMatcher } from "../learning/index.js";
import type { IEventBus, LearningEventMap } from "./event-bus.js";
import type { LearningQueue } from "../learning/pipeline/learning-queue.js";
import type { TaskPlanner } from "../agents/autonomy/task-planner.js";
import type { ErrorRecoveryEngine } from "../agents/autonomy/error-recovery.js";

export interface ProviderInitResult {
  manager: ProviderManager;
  notices: string[];
  healthCheckPassed?: boolean;
}

export interface BootstrapEmbeddingStatus {
  state: "disabled" | "active" | "degraded";
  ragEnabled: boolean;
  configuredProvider: string;
  configuredModel?: string;
  configuredDimensions?: number;
  resolvedProviderName?: string;
  resolutionSource?: string;
  activeDimensions?: number;
  verified: boolean;
  usingHashFallback: boolean;
  notice?: string;
}

export interface EmbeddingResolutionResult {
  cachedProvider?: CachedEmbeddingProvider;
  notice?: string;
  status: BootstrapEmbeddingStatus;
}

export interface RAGResult {
  pipeline?: IRAGPipeline;
  cachedProvider?: CachedEmbeddingProvider;
  notice?: string;
}

export interface LearningResult {
  pipeline?: LearningPipeline;
  storage?: LearningStorage;
  patternMatcher?: PatternMatcher;
  taskPlanner: TaskPlanner;
  errorRecovery: ErrorRecoveryEngine;
  eventBus?: IEventBus<LearningEventMap>;
  learningQueue?: LearningQueue;
  notices: string[];
}

export interface ProviderRuntimeStageResult {
  providerInit: ProviderInitResult;
  memoryManager?: IMemoryManager;
  channel: IChannelAdapter;
  cachedEmbeddingProvider?: CachedEmbeddingProvider;
  embeddingStatus: BootstrapEmbeddingStatus;
  startupNotices: string[];
}

export interface KnowledgeStageResult {
  ragPipeline?: IRAGPipeline;
  learningResult: LearningResult;
  startupNotices: string[];
}

export interface OpsMonitoringStageResult {
  dashboard?: DashboardServer;
  stoppableServers: Array<{ stop(): Promise<void> | void }>;
  rateLimiter?: RateLimiter;
  metricsStorage?: MetricsStorage;
  metricsRecorder?: MetricsRecorder;
}

interface ProviderRuntimeStageDeps {
  initializeAuth: (config: Config, channelType: string, logger: winston.Logger) => AuthManager;
  resolveAndCacheEmbeddings: (
    config: Config,
    logger: winston.Logger,
  ) => Promise<EmbeddingResolutionResult>;
  initializeAIProvider: (
    config: Config,
    logger: winston.Logger,
  ) => Promise<ProviderInitResult>;
  initializeMemory: (
    config: Config,
    logger: winston.Logger,
    embeddingProvider?: CachedEmbeddingProvider,
  ) => Promise<IMemoryManager | undefined>;
  initializeChannel: (
    channelType: string,
    config: Config,
    auth: AuthManager,
    logger: winston.Logger,
  ) => Promise<IChannelAdapter>;
  isTransientEmbeddingVerificationError: (error: unknown) => boolean;
}

interface KnowledgeStageDeps {
  initializeRAG: (
    config: Config,
    logger: winston.Logger,
    cachedProvider?: CachedEmbeddingProvider,
  ) => Promise<RAGResult>;
  initializeLearning: (
    config: Config,
    logger: winston.Logger,
    embeddingProvider?: CachedEmbeddingProvider,
  ) => Promise<LearningResult>;
}

interface OpsMonitoringStageDeps {
  initializeDashboard: (
    config: Config,
    metrics: MetricsCollector,
    memoryManager: IMemoryManager | undefined,
    logger: winston.Logger,
  ) => Promise<DashboardServer | undefined>;
  initializeRateLimiter: (
    config: Config,
    logger: winston.Logger,
  ) => RateLimiter | undefined;
}

export async function verifyEmbeddingProviderConnection(
  cachedEmbeddingProvider: CachedEmbeddingProvider | undefined,
  embeddingStatus: BootstrapEmbeddingStatus,
  logger: winston.Logger,
  isTransientEmbeddingVerificationError: (error: unknown) => boolean,
): Promise<{
  cachedEmbeddingProvider?: CachedEmbeddingProvider;
  embeddingStatus: BootstrapEmbeddingStatus;
}> {
  if (!cachedEmbeddingProvider) {
    return { cachedEmbeddingProvider, embeddingStatus };
  }

  try {
    await cachedEmbeddingProvider.embed(["test"]);
    logger.info("Embedding provider verified");
    return {
      cachedEmbeddingProvider,
      embeddingStatus: {
        ...embeddingStatus,
        verified: true,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (isTransientEmbeddingVerificationError(error)) {
      const notice =
        `Embedding provider could not be verified at startup (${errorMessage}). ` +
        "Keeping live embeddings enabled and retrying on demand.";
      logger.warn(notice);
      return {
        cachedEmbeddingProvider,
        embeddingStatus: {
          ...embeddingStatus,
          verified: false,
          usingHashFallback: false,
          notice,
        },
      };
    }

    const notice = `Embedding provider unreachable, falling back to hash embeddings: ${errorMessage}`;
    logger.warn(notice);
    return {
      cachedEmbeddingProvider: undefined,
      embeddingStatus: {
        ...embeddingStatus,
        state: "degraded",
        verified: false,
        usingHashFallback: true,
        notice,
      },
    };
  }
}

export async function initializeProviderRuntimeStage(
  params: {
    channelType: string;
    config: Config;
    logger: winston.Logger;
  },
  deps: ProviderRuntimeStageDeps,
): Promise<ProviderRuntimeStageResult> {
  const auth = deps.initializeAuth(params.config, params.channelType, params.logger);
  const embeddingResult = await deps.resolveAndCacheEmbeddings(params.config, params.logger);
  const verifiedEmbedding = await verifyEmbeddingProviderConnection(
    embeddingResult.cachedProvider,
    embeddingResult.status,
    params.logger,
    deps.isTransientEmbeddingVerificationError,
  );

  const [providerInit, memoryManager, channel] = await Promise.all([
    deps.initializeAIProvider(params.config, params.logger),
    deps.initializeMemory(
      params.config,
      params.logger,
      verifiedEmbedding.cachedEmbeddingProvider,
    ),
    deps.initializeChannel(params.channelType, params.config, auth, params.logger),
  ]);

  const startupNotices = [...providerInit.notices];
  if (embeddingResult.notice) {
    startupNotices.push(embeddingResult.notice);
  }

  return {
    providerInit,
    memoryManager,
    channel,
    cachedEmbeddingProvider: verifiedEmbedding.cachedEmbeddingProvider,
    embeddingStatus: verifiedEmbedding.embeddingStatus,
    startupNotices,
  };
}

export async function initializeKnowledgeStage(
  params: {
    config: Config;
    logger: winston.Logger;
    cachedEmbeddingProvider?: CachedEmbeddingProvider;
    startupNotices: string[];
  },
  deps: KnowledgeStageDeps,
): Promise<KnowledgeStageResult> {
  const startupNotices = [...params.startupNotices];
  const ragResult = await deps.initializeRAG(
    params.config,
    params.logger,
    params.cachedEmbeddingProvider,
  );
  if (ragResult.notice) {
    startupNotices.push(ragResult.notice);
  }

  const learningResult = await deps.initializeLearning(
    params.config,
    params.logger,
    params.cachedEmbeddingProvider,
  );
  startupNotices.push(...learningResult.notices);

  return {
    ragPipeline: ragResult.pipeline,
    learningResult,
    startupNotices,
  };
}

export async function initializeOpsMonitoringStage(
  params: {
    config: Config;
    logger: winston.Logger;
    metrics: MetricsCollector;
    memoryManager?: IMemoryManager;
  },
  deps: OpsMonitoringStageDeps,
): Promise<OpsMonitoringStageResult> {
  const dashboard = await deps.initializeDashboard(
    params.config,
    params.metrics,
    params.memoryManager,
    params.logger,
  );

  const stoppableServers: Array<{ stop(): Promise<void> | void }> = [];
  if (params.config.websocketDashboard.enabled) {
    const { WebSocketDashboardServer } = await import("../dashboard/websocket-server.js");
    const wsDashboard = new WebSocketDashboardServer({
      port: params.config.websocketDashboard.port,
      authToken: params.config.websocketDashboard.authToken,
      allowedOrigins: params.config.websocketDashboard.allowedOrigins,
      metrics: params.metrics,
      getMemoryStats: () => params.memoryManager?.getStats(),
    });
    await wsDashboard.start();
    stoppableServers.push(wsDashboard);
    if (!params.config.websocketDashboard.authToken) {
      params.logger.info("WebSocket dashboard enabled without static auth token; using generated same-process auth token");
    }
    params.logger.info("WebSocket dashboard started", { port: params.config.websocketDashboard.port });
  }

  if (params.config.prometheus.enabled) {
    const { PrometheusMetrics } = await import("../dashboard/prometheus.js");
    const prometheus = new PrometheusMetrics(
      params.config.prometheus.port,
      params.metrics,
      () => params.memoryManager?.getStats(),
    );
    await prometheus.start();
    stoppableServers.push(prometheus);
    params.logger.warn("SECURITY: Prometheus metrics endpoint has no authentication — restrict access at network level");
    params.logger.info("Prometheus metrics started", { port: params.config.prometheus.port });
  }

  const rateLimiter = deps.initializeRateLimiter(params.config, params.logger);

  let metricsStorage: MetricsStorage | undefined;
  let metricsRecorder: MetricsRecorder | undefined;
  try {
    const metricsDbPath = join(params.config.memory.dbPath, "learning.db");
    metricsStorage = new MetricsStorage(metricsDbPath);
    metricsStorage.initialize();
    metricsRecorder = new MetricsRecorder(metricsStorage);
    params.logger.info("Metrics storage initialized", { dbPath: metricsDbPath });
  } catch (error) {
    params.logger.warn("Metrics storage initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    dashboard,
    stoppableServers,
    rateLimiter,
    metricsStorage,
    metricsRecorder,
  };
}

export async function finalizeChannelStartupStage(params: {
  beforeChannelConnect?: (() => Promise<void> | void) | undefined;
  channel: IChannelAdapter;
  logger: winston.Logger;
  config: Config;
  channelType: string;
  daemonMode: boolean;
  providerHealthy?: boolean;
  embeddingStatus: BootstrapEmbeddingStatus;
  deploymentWired: boolean;
  alertingWired: boolean;
  backupWired: boolean;
  startupNotices: string[];
  moduleUrl: string;
}): Promise<BootReport> {
  if (params.beforeChannelConnect) {
    await params.beforeChannelConnect();
  }
  await params.channel.connect();
  params.logger.info("Strada Brain is running!");

  const runtimePaths = resolveRuntimePaths({ moduleUrl: params.moduleUrl });
  const bootReport = buildBootReport({
    config: params.config,
    installRoot: runtimePaths.installRoot,
    channelType: params.channelType,
    channelHealthy: params.channel.isHealthy(),
    daemonMode: params.daemonMode,
    providerHealthy: params.providerHealthy,
    embeddingStatus: params.embeddingStatus,
    deploymentWired: params.deploymentWired,
    alertingWired: params.alertingWired,
    backupWired: params.backupWired,
    startupNotices: params.startupNotices,
  });

  params.logger.info("Boot report", {
    summary: summarizeBootReport(bootReport),
    stages: bootReport.stages.map((stage) => ({
      id: stage.id,
      status: stage.status,
    })),
  });
  if (params.startupNotices.length > 0) {
    params.logger.warn("Startup capability notices", {
      notices: [...new Set(params.startupNotices)],
    });
  }

  return bootReport;
}
