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

// ---------------------------------------------------------------------------
// Vault bootstrap helper — wires a UnityProjectVault into the vault registry.
// Standalone: invoke from the bootstrap orchestrator when ready.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { UnityProjectVault } from "../../vault/unity-project-vault.js";
import { discoverUnityRoots } from "../../vault/discovery.js";
import type { VaultRegistry } from "../../vault/vault-registry.js";
import type { EmbeddingProvider, VectorStore } from "../../vault/embedding-adapter.js";

export interface InitVaultsInput {
  config: {
    vault?: { enabled: boolean; debounceMs?: number; writeHookBudgetMs?: number };
    unityProjectPath?: string;
  };
  vaultRegistry: VaultRegistry;
  embedding: EmbeddingProvider;
  vectorStore: VectorStore;
}

export async function initVaultsFromBootstrap(input: InitVaultsInput): Promise<void> {
  if (!input.config.vault?.enabled) return;
  const projectPath = input.config.unityProjectPath;
  if (!projectPath) return;
  const roots = await discoverUnityRoots(projectPath);
  if (!roots) return;
  const hash = createHash("sha1").update(projectPath).digest("hex").slice(0, 8);
  const vault = new UnityProjectVault({
    id: `unity:${hash}`,
    rootPath: projectPath,
    embedding: input.embedding,
    vectorStore: input.vectorStore,
  });
  await vault.init();
  await vault.startWatch(input.config.vault.debounceMs ?? 800);
  input.vaultRegistry.register(vault);
}

import { SelfVault } from "../../vault/self-vault.js";

export interface InitSelfVaultInput {
  config: {
    vault?: {
      enabled: boolean;
      self?: { enabled?: boolean };
    };
  };
  vaultRegistry: VaultRegistry;
  embedding: EmbeddingProvider;
  vectorStore: VectorStore;
  /** Absolute path to the Strada.Brain repo root. */
  repoRoot: string;
}

export async function initSelfVaultFromBootstrap(input: InitSelfVaultInput): Promise<void> {
  if (!input.config.vault?.enabled) return;
  if (input.config.vault.self?.enabled === false) return;  // explicit opt-out
  const vault = new SelfVault({
    id: "self:strada-brain",
    rootPath: input.repoRoot,
    embedding: input.embedding,
    vectorStore: input.vectorStore,
  });
  await vault.init();
  input.vaultRegistry.register(vault);
}
