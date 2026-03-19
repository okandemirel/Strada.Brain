import { describe, expect, it } from "vitest";
import type { Config } from "../config/config.js";
import { buildBootReport, buildCapabilitySnapshot, summarizeCapabilityHealth } from "./boot-report.js";

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
      intervalHours: 24,
      idleTimeoutMin: 5,
      channel: "stable",
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
    expect(capabilities.find((capability) => capability.id === "pentest-scripts")).toMatchObject({
      status: "active",
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
});
