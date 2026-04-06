import { describe, expect, it } from "vitest";
import type { Config } from "../config/config.js";
import { buildBootReport, buildCapabilitySnapshot, collectConfigWarnings, summarizeCapabilityHealth } from "./boot-report.js";

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
    memory: {} as Config["memory"],
    rag: {
      enabled: true,
      provider: "auto",
      contextMaxTokens: 4000,
    },
    streamingEnabled: true,
    shellEnabled: true,
    llmStreamInitialTimeoutMs: 30000,
    llmStreamStallTimeoutMs: 120000,
    rateLimit: {} as Config["rateLimit"],
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
      intervalHours: 6,
      idleTimeoutMin: 5,
      channel: "latest",
      notify: true,
      autoRestart: true,
    },
    ...overrides,
  } as Config;
}

describe("boot report", () => {
  it("marks protected surfaces active while keeping multi-agent opt-in", () => {
    const capabilities = buildCapabilitySnapshot({
      config: makeConfig(),
      installRoot: process.cwd(),
      channelType: "web",
      channelHealthy: true,
      providerHealthy: true,
      embeddingStatus: {
        state: "active",
        verified: true,
        usingHashFallback: false,
      },
    });

    expect(capabilities.find((capability) => capability.id === "web-surface")).toMatchObject({
      tier: "production",
      status: "active",
    });
    expect(capabilities.find((capability) => capability.id === "multi-agent")).toMatchObject({
      tier: "experimental",
      status: "inactive",
    });
    expect(capabilities.find((capability) => capability.id === "delegation")).toMatchObject({
      tier: "experimental",
      status: "inactive",
      detail: "Disabled in current config (TASK_DELEGATION_ENABLED=false). Delegation is outside the protected recovery surface.",
    });
    expect(capabilities.find((capability) => capability.id === "pentest-scripts")).toMatchObject({
      status: "active",
    });
  });

  it("keeps delegation inactive when multi-agent orchestration is disabled", () => {
    const capabilities = buildCapabilitySnapshot({
      config: makeConfig({
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
      }),
      installRoot: process.cwd(),
      channelType: "web",
      channelHealthy: true,
      providerHealthy: true,
      embeddingStatus: {
        state: "active",
        verified: true,
        usingHashFallback: false,
      },
    });

    expect(capabilities.find((capability) => capability.id === "delegation")).toMatchObject({
      status: "inactive",
      detail: "Delegation is configured, but multi-agent orchestration is disabled, so it will not initialize in this runtime.",
    });
  });

  it("warns when deployment is enabled but not wired into the runtime", () => {
    const capabilities = buildCapabilitySnapshot({
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
        },
      }),
      installRoot: process.cwd(),
      channelType: "cli",
    });

    expect(summarizeCapabilityHealth(capabilities)).toMatchObject({
      status: "warn",
    });
  });

  it("degrades the provider stage when the health probe fails", () => {
    const report = buildBootReport({
      config: makeConfig(),
      installRoot: process.cwd(),
      channelType: "web",
      channelHealthy: true,
      providerHealthy: false,
      startupNotices: ["Provider health check failed."],
    });

    expect(report.stages.find((stage) => stage.id === "providers")).toMatchObject({
      status: "degraded",
    });
  });

  describe("collectConfigWarnings", () => {
    it("warns when streaming is enabled but primary provider does not support it", () => {
      const warnings = collectConfigWarnings({
        config: makeConfig({ streamingEnabled: true }),
        channelType: "web",
        primaryProviderSupportsStreaming: false,
      });

      expect(warnings).toContain(
        "Streaming enabled but primary provider may not support it — will fall back to non-streaming",
      );
    });

    it("does not warn about streaming when provider supports it", () => {
      const warnings = collectConfigWarnings({
        config: makeConfig({ streamingEnabled: true }),
        channelType: "web",
        primaryProviderSupportsStreaming: true,
      });

      expect(warnings).not.toContain(
        "Streaming enabled but primary provider may not support it — will fall back to non-streaming",
      );
    });

    it("does not warn about streaming when streaming is disabled", () => {
      const warnings = collectConfigWarnings({
        config: makeConfig({ streamingEnabled: false }),
        channelType: "web",
        primaryProviderSupportsStreaming: false,
      });

      expect(warnings).not.toContain(
        "Streaming enabled but primary provider may not support it — will fall back to non-streaming",
      );
    });

    it("warns when RAG is enabled but using hash fallback embeddings", () => {
      const warnings = collectConfigWarnings({
        config: makeConfig({ rag: { enabled: true, provider: "auto", contextMaxTokens: 4000 } }),
        channelType: "web",
        embeddingStatus: {
          state: "degraded",
          verified: false,
          usingHashFallback: true,
        },
      });

      expect(warnings).toContain(
        "RAG enabled but no embedding provider available — using hash fallback embeddings",
      );
    });

    it("does not warn about RAG when embeddings are healthy", () => {
      const warnings = collectConfigWarnings({
        config: makeConfig({ rag: { enabled: true, provider: "auto", contextMaxTokens: 4000 } }),
        channelType: "web",
        embeddingStatus: {
          state: "active",
          verified: true,
          usingHashFallback: false,
        },
      });

      expect(warnings).not.toContain(
        "RAG enabled but no embedding provider available — using hash fallback embeddings",
      );
    });

    it("warns when memory is disabled", () => {
      const warnings = collectConfigWarnings({
        config: makeConfig({ memory: { enabled: false, dbPath: ".strada-memory", backend: "agentdb" } as Config["memory"] }),
        channelType: "web",
      });

      expect(warnings).toContain(
        "Memory is disabled — conversations will not be persisted across sessions",
      );
    });

    it("does not warn when memory is enabled", () => {
      const warnings = collectConfigWarnings({
        config: makeConfig({ memory: { enabled: true, dbPath: ".strada-memory", backend: "agentdb" } as Config["memory"] }),
        channelType: "web",
      });

      expect(warnings).not.toContain(
        "Memory is disabled — conversations will not be persisted across sessions",
      );
    });

    it("returns no warnings when config is well-matched", () => {
      const warnings = collectConfigWarnings({
        config: makeConfig({ memory: { enabled: true, dbPath: ".strada-memory", backend: "agentdb" } as Config["memory"] }),
        channelType: "web",
        primaryProviderSupportsStreaming: true,
        embeddingStatus: {
          state: "active",
          verified: true,
          usingHashFallback: false,
        },
      });

      expect(warnings).toEqual([]);
    });

    it("includes config warnings in boot report startupNotices", () => {
      const report = buildBootReport({
        config: makeConfig({ streamingEnabled: true }),
        installRoot: process.cwd(),
        channelType: "web",
        primaryProviderSupportsStreaming: false,
        embeddingStatus: {
          state: "degraded",
          verified: false,
          usingHashFallback: true,
        },
        startupNotices: ["Existing notice"],
      });

      expect(report.startupNotices).toContain("Existing notice");
      expect(report.startupNotices).toContain(
        "Streaming enabled but primary provider may not support it — will fall back to non-streaming",
      );
      expect(report.startupNotices).toContain(
        "RAG enabled but no embedding provider available — using hash fallback embeddings",
      );
    });
  });
});
