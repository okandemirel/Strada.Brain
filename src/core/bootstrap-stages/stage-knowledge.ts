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
  try {
    if (params.config.websocketDashboard.enabled) {
      const { WebSocketDashboardServer } = await import("../../dashboard/websocket-server.js");
      const wsDashboard = new WebSocketDashboardServer({
        port: params.config.websocketDashboard.port,
        bindHost: params.config.bindHost,
        authToken: params.config.websocketDashboard.authToken,
        allowedOrigins: params.config.websocketDashboard.allowedOrigins,
        metrics: params.metrics,
        getMemoryStats: () => params.memoryManager?.getStats(),
      });
      await wsDashboard.start();
      stoppableServers.push(wsDashboard);
      if (!params.config.websocketDashboard.authToken) {
        params.logger.info("WebSocket dashboard enabled without static auth token; command mode is read-only");
      }
      params.logger.info("WebSocket dashboard started", { port: params.config.websocketDashboard.port });
    }

    if (params.config.prometheus.enabled) {
      const { PrometheusMetrics } = await import("../../dashboard/prometheus.js");
      const prometheus = new PrometheusMetrics(
        params.config.prometheus.port,
        params.metrics,
        () => params.memoryManager?.getStats(),
        undefined,
        params.config.bindHost,
      );
      await prometheus.start();
      stoppableServers.push(prometheus);
      params.logger.warn("SECURITY: Prometheus metrics endpoint has no authentication — restrict access at network level");
      params.logger.info("Prometheus metrics started", { port: params.config.prometheus.port });
    }
  } catch (error) {
    // A listener that fails to start aborts boot, and the servers started
    // before it were not on the teardown stack yet, so they stayed bound and a
    // retry in the same process hit EADDRINUSE (COR-17).
    await Promise.allSettled([...stoppableServers, ...(dashboard ? [dashboard] : [])].map(async (server) => server.stop()));
    throw error;
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
import type { IVault } from "../../vault/vault.interface.js";
import type { EmbeddingProvider, VectorStore } from "../../vault/embedding-adapter.js";
import { SelfVault } from "../../vault/self-vault.js";
import { ObsidianVault } from "../../vault/obsidian-vault.js";
import { getLoggerSafe } from "../../utils/logger.js";

/** A vault registered at boot whose initial index runs in the background. */
export interface VaultStartup<V extends IVault> {
  vault: V;
  /**
   * Settles once the initial index (and the watchers, for a watched vault) is
   * up: true when it is, false when the index failed or the vault was disposed
   * first. Never rejects.
   */
  ready: Promise<boolean>;
}

/**
 * Register first and index in the background: an initial walk of a large
 * tree held up startup for minutes. Registered, the vault is reachable by
 * shutdown's disposeAll (which stops the walk) and reports "indexing" until it
 * is done; queries meanwhile see what is indexed so far.
 */
function indexInBackground<V extends IVault>(
  registry: VaultRegistry,
  vault: V,
  label: string,
  afterInit?: () => Promise<void>,
): VaultStartup<V> {
  registry.register(vault);
  const init = vault.init();
  registry.trackInit(vault, init);
  const ready = (async () => {
    await init;
    // Disposed or replaced while indexing: watchers started now would never be stopped.
    if (registry.get(vault.id) !== vault) return false;
    await afterInit?.();
    getLoggerSafe().info(`[vault] async init complete for ${vault.id}`);
    return true;
  })().catch((err: unknown) => {
    getLoggerSafe().warn(`[vault] ${label} initialization failed for ${vault.id}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  });
  return { vault, ready };
}

export interface InitVaultsInput {
  config: {
    vault?: { enabled: boolean; debounceMs?: number; writeHookBudgetMs?: number };
    unityProjectPath?: string;
  };
  vaultRegistry: VaultRegistry;
  embedding: EmbeddingProvider;
  vectorStore: VectorStore;
}

export async function initVaultsFromBootstrap(
  input: InitVaultsInput,
): Promise<VaultStartup<UnityProjectVault> | undefined> {
  if (!input.config.vault?.enabled) return undefined;
  const projectPath = input.config.unityProjectPath;
  if (!projectPath) return undefined;
  const roots = await discoverUnityRoots(projectPath);
  if (!roots) return undefined;
  const hash = createHash("sha1").update(projectPath).digest("hex").slice(0, 8);
  const vault = new UnityProjectVault({
    id: `unity:${hash}`,
    rootPath: projectPath,
    embedding: input.embedding,
    vectorStore: input.vectorStore,
  });
  // Registered before the watchers start, so a watcher start failure cannot
  // orphan already-started watchers outside the registry.
  const debounceMs = input.config.vault.debounceMs ?? 800;
  return indexInBackground(input.vaultRegistry, vault, "Unity project vault", () => vault.startWatch(debounceMs));
}

export interface InitSelfVaultInput {
  config: {
    vault?: {
      enabled: boolean;
      debounceMs?: number;
      self?: { enabled?: boolean };
    };
  };
  vaultRegistry: VaultRegistry;
  embedding: EmbeddingProvider;
  vectorStore: VectorStore;
  /** Absolute path to the Strada.Brain repo root. */
  repoRoot: string;
}

export type SelfVaultStartup = VaultStartup<SelfVault>;

export async function initSelfVaultFromBootstrap(
  input: InitSelfVaultInput,
): Promise<SelfVaultStartup | undefined> {
  // SelfVault is always initialized regardless of vault.enabled flag,
  // because it indexes Strada.Brain's own source code which is always useful.
  // Only explicit opt-out via self.enabled === false skips it.
  if (input.config.vault?.self?.enabled === false) return undefined;
  const vault = new SelfVault({
    id: "self:strada-brain",
    rootPath: input.repoRoot,
    embedding: input.embedding,
    vectorStore: input.vectorStore,
  });
  // The initial walk of the install root took minutes on a cold checkout.
  const debounceMs = input.config.vault?.debounceMs ?? 800;
  return indexInBackground(input.vaultRegistry, vault, "SelfVault", () => vault.startWatch(debounceMs));
}

export interface InitObsidianVaultInput {
  config: {
    obsidian?: {
      enabled: boolean;
      apiUrl: string;
      apiKey: string;
      vaultPath: string;
      certPath?: string;
    };
  };
  vaultRegistry: VaultRegistry;
  embedding: EmbeddingProvider;
  vectorStore: VectorStore;
}

export async function initObsidianVaultFromBootstrap(
  input: InitObsidianVaultInput,
): Promise<VaultStartup<ObsidianVault> | undefined> {
  const obsidian = input.config.obsidian;
  if (!obsidian?.enabled || !obsidian.vaultPath) return undefined;
  const hash = createHash("sha1").update(obsidian.vaultPath).digest("hex").slice(0, 8);
  const vault = new ObsidianVault({
    id: `obsidian:${hash}`,
    rootPath: obsidian.vaultPath,
    embedding: input.embedding,
    vectorStore: input.vectorStore,
    obsidian: {
      apiUrl: obsidian.apiUrl,
      apiKey: obsidian.apiKey,
      certPath: obsidian.certPath,
    },
  });
  // The init waits on the Obsidian API health check (up to its request
  // timeout) before it indexes the notes. No watcher: sync() refreshes it.
  return indexInBackground(input.vaultRegistry, vault, "ObsidianVault");
}
