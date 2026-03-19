import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config.js";
import {
  finalizeChannelStartupStage,
  initializeKnowledgeStage,
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
});
