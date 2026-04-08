import type * as winston from "winston";
import type { Config } from "../../config/config.js";
import type { ProviderManager } from "../../agents/providers/provider-manager.js";
import type { DashboardServer } from "../../dashboard/server.js";
import type { LearningStorage } from "../../learning/index.js";
import type { IChannelAdapter } from "../../channels/channel.interface.js";
import type { Orchestrator } from "../../agents/orchestrator.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";
import type { BootReport } from "../../common/capability-contract.js";
import { ToolRegistry } from "../tool-registry.js";
import { SoulLoader } from "../../agents/soul/index.js";
import { resolveRuntimePaths } from "../../common/runtime-paths.js";
import { buildBootReport, summarizeBootReport } from "../boot-report.js";
import type {
  BootstrapEmbeddingStatus,
  RuntimeIntelligenceStageDeps,
  RuntimeIntelligenceStageResult,
  DashboardPostBootStageDeps,
} from "./bootstrap-stages-types.js";

export async function initializeRuntimeIntelligenceStage(
  params: {
    config: Config;
    logger: winston.Logger;
    providerManager: ProviderManager;
    learningStorage?: LearningStorage;
  },
  deps: RuntimeIntelligenceStageDeps = {},
): Promise<RuntimeIntelligenceStageResult> {
  let modelIntelligence: import("../../agents/providers/model-intelligence.js").ModelIntelligenceService | undefined;
  if (params.config.modelIntelligence.enabled) {
    try {
      const { ModelIntelligenceService } = await import("../../agents/providers/model-intelligence.js");
      modelIntelligence = deps.createModelIntelligenceService?.({
        refreshHours: params.config.modelIntelligence.refreshHours,
        providerSourcesPath: params.config.modelIntelligence.providerSourcesPath,
      }) ?? new ModelIntelligenceService({
        refreshHours: params.config.modelIntelligence.refreshHours,
        providerSourcesPath: params.config.modelIntelligence.providerSourcesPath,
      });
      await modelIntelligence.initialize(params.config.modelIntelligence.dbPath, {
        refreshOnInitialize: false,
      });
      params.providerManager.setModelCatalog?.(modelIntelligence);
      params.logger.info("ModelIntelligenceService initialized", {
        dbPath: params.config.modelIntelligence.dbPath,
        refreshHours: params.config.modelIntelligence.refreshHours,
      });
    } catch (error) {
      params.logger.warn("ModelIntelligenceService initialization failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let providerRouter: import("../../agent-core/routing/provider-router.js").ProviderRouter | undefined;
  try {
    const { ProviderRouter } = await import("../../agent-core/routing/provider-router.js");
    const { TrajectoryPhaseSignalRetriever } = await import("../../agent-core/routing/trajectory-phase-signal-retriever.js");
    const trajectoryPhaseSignalRetriever = params.learningStorage
      ? (deps.createTrajectoryPhaseSignalRetriever?.(params.learningStorage)
        ?? new TrajectoryPhaseSignalRetriever(params.learningStorage))
      : undefined;
    providerRouter = deps.createProviderRouter?.(
      params.providerManager,
      params.config.routing.preset,
      {
        modelIntelligence,
        trajectoryPhaseSignalRetriever,
      },
    ) ?? new ProviderRouter(params.providerManager, params.config.routing.preset, {
      modelIntelligence,
      trajectoryPhaseSignalRetriever,
    });
    params.logger.info("ProviderRouter initialized", { preset: params.config.routing.preset });
  } catch {
    // Non-fatal — routing disabled
  }

  let consensusManager: import("../../agent-core/routing/consensus-manager.js").ConsensusManager | undefined;
  let confidenceEstimator: import("../../agent-core/routing/confidence-estimator.js").ConfidenceEstimator | undefined;
  try {
    const { ConsensusManager } = await import("../../agent-core/routing/consensus-manager.js");
    consensusManager = deps.createConsensusManager?.({
      mode: params.config.consensus.mode,
      threshold: params.config.consensus.threshold,
      maxProviders: params.config.consensus.maxProviders,
    }) ?? new ConsensusManager({
      mode: params.config.consensus.mode,
      threshold: params.config.consensus.threshold,
      maxProviders: params.config.consensus.maxProviders,
    });
    const { ConfidenceEstimator } = await import("../../agent-core/routing/confidence-estimator.js");
    confidenceEstimator = deps.createConfidenceEstimator?.() ?? new ConfidenceEstimator();
    params.logger.info("ConsensusManager initialized", { mode: params.config.consensus.mode });
  } catch {
    // Non-fatal — consensus disabled
  }

  return {
    modelIntelligence,
    providerRouter,
    consensusManager,
    confidenceEstimator,
  };
}

export function registerDashboardPostBootStage(
  params: {
    dashboard?: Pick<DashboardServer,
      "registerAgentServices"
      | "registerConsolidationDeploymentServices"
      | "registerExtendedServices"
      | "setProviderRouter">;
    agentManager?: import("../../agents/multi/agent-manager.js").AgentManager;
    agentBudgetTracker?: import("../../agents/multi/agent-budget-tracker.js").AgentBudgetTracker;
    daemonContext?: import("../../daemon/daemon-cli.js").DaemonContext;
    toolRegistry: ToolRegistry;
    taskManager: import("../../tasks/task-manager.js").TaskManager;
    orchestrator: Orchestrator;
    soulLoader: SoulLoader;
    config: Config;
    providerManager: ProviderManager;
    userProfileStore?: import("../../memory/unified/user-profile-store.js").UserProfileStore;
    embeddingStatus: BootstrapEmbeddingStatus;
    stradaDeps: StradaDepsStatus;
    bootReport: BootReport;
    providerRouter?: import("../../agent-core/routing/provider-router.js").ProviderRouter;
  },
  deps: DashboardPostBootStageDeps = {},
): void {
  if (!params.dashboard) {
    return;
  }

  if (params.agentManager) {
    params.dashboard.registerAgentServices({
      agentManager: params.agentManager,
      agentBudgetTracker: params.agentBudgetTracker,
    });
  }

  if (params.daemonContext) {
    params.dashboard.registerConsolidationDeploymentServices({
      consolidationEngine: params.daemonContext.consolidationEngine,
      deploymentExecutor: params.daemonContext.deploymentExecutor,
      readinessChecker: params.daemonContext.readinessChecker,
    });
  }

  const flatConfig = deps.flattenConfig?.(params.config) ?? (() => {
    const flat: Record<string, unknown> = {};
    const flatten = (obj: Record<string, unknown>, prefix = "") => {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "function") continue;
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
          flatten(v as Record<string, unknown>, key);
        } else {
          flat[key] = v;
        }
      }
    };
    flatten(params.config as unknown as Record<string, unknown>);
    return flat;
  })();

  params.dashboard.registerExtendedServices({
    toolRegistry: {
      getAllTools: () => params.toolRegistry.getToolInventory(),
    },
    taskManager: params.taskManager,
    orchestratorSessions: params.orchestrator,
    soulLoader: params.soulLoader,
    configSnapshot: () => flatConfig,
    providerManager: {
      listAvailable: () => params.providerManager.listAvailable().map((provider) => ({
        ...provider,
        configured: true,
        models: [provider.defaultModel],
      })),
      listExecutionCandidates: (identityKey?: string) =>
        params.providerManager.listExecutionCandidates(identityKey).map((provider) => ({
          ...provider,
          configured: true,
          models: [provider.defaultModel],
        })),
      listAvailableWithModels: async () => {
        const results = await params.providerManager.listAvailableWithModels();
        return results.map((provider) => ({
          ...provider,
          configured: true,
          activeModel: provider.defaultModel,
        }));
      },
      describeAvailable: () => params.providerManager.describeAvailable(),
      getProviderCapabilities: (name: string, model?: string) =>
        params.providerManager.getProviderCapabilities(name, model),
      getActiveInfo: (chatId: string) => {
        const info = params.providerManager.getActiveInfo(chatId);
        return info ? {
          provider: info.providerName,
          providerName: info.providerName,
          model: info.model,
          isDefault: info.isDefault,
          selectionMode: info.selectionMode,
          executionPolicyNote: info.executionPolicyNote,
        } : null;
      },
      setPreference: async (
        chatId: string,
        provider: string,
        model?: string,
        selectionMode?: "strada-preference-bias" | "strada-hard-pin",
      ) => {
        params.providerManager.setPreference(chatId, provider, model, selectionMode);
      },
      refreshCatalog: async () => params.providerManager.refreshModelCatalog(),
    },
    userProfileStore: params.userProfileStore,
    embeddingStatusProvider: {
      getStatus: () => ({ ...params.embeddingStatus }),
    },
    stradaDeps: params.stradaDeps,
    bootReport: params.bootReport,
  });

  if (params.providerRouter) {
    params.dashboard.setProviderRouter(params.providerRouter);
  }
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
  stradaMcpRuntime?: ReturnType<ToolRegistry["getStradaMcpRuntimeStatus"]>;
  primaryProviderSupportsStreaming?: boolean;
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
    stradaMcpRuntime: params.stradaMcpRuntime ?? undefined,
    primaryProviderSupportsStreaming: params.primaryProviderSupportsStreaming,
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
    const uniqueNotices = [...new Set(params.startupNotices)];
    for (const notice of uniqueNotices) {
      params.logger.warn(`Startup notice: ${notice}`);
    }
  }

  return bootReport;
}
