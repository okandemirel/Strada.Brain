import { join } from "node:path";
import type * as winston from "winston";
import type { Config } from "../../config/config.js";
import type { CachedEmbeddingProvider } from "../../rag/embeddings/embedding-cache.js";
import type { IMemoryManager } from "../../memory/memory.interface.js";
import type { MetricsCollector } from "../../dashboard/metrics.js";
import { MetricsStorage } from "../../metrics/metrics-storage.js";
import { MetricsRecorder } from "../../metrics/metrics-recorder.js";
import type {
  KnowledgeStageDeps,
  KnowledgeStageResult,
  OpsMonitoringStageDeps,
  OpsMonitoringStageResult,
} from "./bootstrap-stages-types.js";

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
    const { WebSocketDashboardServer } = await import("../../dashboard/websocket-server.js");
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
    const { PrometheusMetrics } = await import("../../dashboard/prometheus.js");
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
