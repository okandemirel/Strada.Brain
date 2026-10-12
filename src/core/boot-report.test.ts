import { describe, expect, it } from "vitest";
import type { Config } from "../config/config.js";
import { buildBootReport, buildCapabilitySnapshot, collectConfigWarnings, summarizeBootReport, summarizeCapabilityHealth } from "./boot-report.js";

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

    it("the provider stage says when STREAMING_ENABLED=false turned provider streaming off (N-3)", () => {
      const detailFor = (streamingEnabled: boolean) =>
        buildBootReport({ config: makeConfig({ streamingEnabled }), channelType: "web" })
          .stages.find((stage) => stage.id === "providers")?.detail;

      expect(detailFor(false)).toContain("Provider streaming is off (STREAMING_ENABLED=false)");
      expect(detailFor(true)).not.toContain("streaming");
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
        "RAG enabled but no embedding provider available — using hash fallback embeddings (retrieval is non-semantic)",
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
        "RAG enabled but no embedding provider available — using hash fallback embeddings (retrieval is non-semantic)",
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
        "RAG enabled but no embedding provider available — using hash fallback embeddings (retrieval is non-semantic)",
      );
    });
  });
});

describe("supervisor capability (audited 2026-09-02)", () => {
  // A Supervisor Brain that failed to boot (goals.db locked, decomposer
  // missing) left every stage "ready" and no capability to observe it, so the
  // report printed "Boot report clean" while the goal-DAG planner was absent.
  it("reads degraded — not clean — when the supervisor is enabled but was not wired", () => {
    const report = buildBootReport({
      config: makeConfig({ supervisor: { enabled: true } as Config["supervisor"] }),
      installRoot: process.cwd(),
      channelType: "web",
      channelHealthy: true,
      supervisorWired: false,
      startupNotices: [],
    });

    const supervisor = report.capabilities.find((c) => c.id === "supervisor");
    expect(supervisor?.status).toBe("degraded");
    expect(summarizeBootReport(report)).toMatch(/warnings/);
    expect(summarizeBootReport(report)).toMatch(/Supervisor/);
  });

  it("separates 'a boot lost it' from 'nothing measured it' (audited 2026-09-02)", () => {
    // `doctor` reads static config and never boots, so it never constructs a
    // supervisor. Reporting that as declared-only put "Supervisor Brain" under
    // "still need truthfulness work" on every healthy install with the
    // supervisor enabled. A caller that did not measure says so, and the
    // capability says what WAS checked instead of implying a failed boot.
    const notMeasured = buildCapabilitySnapshot({
      config: makeConfig({ supervisor: { enabled: true } as Config["supervisor"] }),
      installRoot: process.cwd(),
      channelType: "doctor",
      supervisorWired: "not-measured",
    });
    const supervisor = notMeasured.find((c) => c.id === "supervisor");
    expect(supervisor?.status).toBe("active");
    expect(supervisor?.truth).toBe("wired");
    // It must not claim the brain was built, and must name the gap.
    expect(supervisor?.detail).not.toMatch(/constructed;/);
    expect(supervisor?.detail).toMatch(/not verified|did not boot|not measured/i);
    expect(summarizeCapabilityHealth(notMeasured).detail).not.toContain("Supervisor Brain");

    // A boot that reports nothing is still declared-only — the unreported case
    // is not the same as a caller that never boots.
    const unreported = buildCapabilitySnapshot({
      config: makeConfig({ supervisor: { enabled: true } as Config["supervisor"] }),
      installRoot: process.cwd(),
      channelType: "web",
    });
    expect(unreported.find((c) => c.id === "supervisor")?.truth).toBe("declared-only");
  });

  it("reads active when the brain was constructed, inactive when disabled by config", () => {
    const wired = buildBootReport({
      config: makeConfig({ supervisor: { enabled: true } as Config["supervisor"] }),
      installRoot: process.cwd(),
      channelType: "web",
      channelHealthy: true,
      supervisorWired: true,
      startupNotices: [],
    });
    expect(wired.capabilities.find((c) => c.id === "supervisor")?.status).toBe("active");

    const disabled = buildBootReport({
      config: makeConfig({ supervisor: { enabled: false } as Config["supervisor"] }),
      installRoot: process.cwd(),
      channelType: "web",
      channelHealthy: true,
      supervisorWired: false,
      startupNotices: [],
    });
    expect(disabled.capabilities.find((c) => c.id === "supervisor")?.status).toBe("inactive");
  });
});

describe("runtime surface of a channel hub (2026-09-09)", () => {
  const surfaceOf = (channelType: string): string => {
    const report = buildBootReport({ config: makeConfig(), installRoot: process.cwd(), channelType, channelHealthy: true });
    return report.stages.find((stage) => stage.id === "channel")?.detail ?? "";
  };

  it("is protected only while every member is local (web/cli); a Telegram member makes it extended", () => {
    expect(surfaceOf("web")).toContain("protected");
    expect(surfaceOf("web,cli")).toContain("protected");
    expect(surfaceOf("web,telegram")).toContain("extended");
    expect(surfaceOf("telegram")).toContain("extended");
  });
});

// ---------------------------------------------------------------------------
// Plan 3.10 (audit 05.cap / D44): the report names the vault's retrieval mode.
// ---------------------------------------------------------------------------
describe("vault retrieval is named, not implied", () => {
  const vaultCapability = (vaultRetrieval?: { registered: number; semantic: boolean }) =>
    buildCapabilitySnapshot({
      config: makeConfig(),
      installRoot: process.cwd(),
      channelType: "web",
      ...(vaultRetrieval ? { vaultRetrieval } : {}),
    }).find((c) => c.id === "codebase-vault");

  it("says LEXICAL ONLY when the boot wired a non-semantic store", () => {
    // The placeholder store makes the vault answer from FTS/BM25, wikilinks
    // and the symbol graph. Nothing said so, and a configured embedding
    // provider made it look like semantic search.
    const capability = vaultCapability({ registered: 2, semantic: false });
    expect(capability).toBeDefined();
    expect(capability!.status).toBe("active");
    expect(capability!.truth).toBe("health-checked");
    expect(capability!.detail).toContain("Lexical only");
    expect(capability!.detail).toContain("no vectors are queried");
    expect(capability!.detail).toContain("2 vault(s)");

    const warnings = collectConfigWarnings({
      config: makeConfig(),
      channelType: "web",
      vaultRetrieval: { registered: 2, semantic: false },
    });
    expect(warnings.some((w) => w.includes("LEXICAL ONLY"))).toBe(true);
  });

  it("says semantic once vectors really are queried, and warns about nothing (guard)", () => {
    const capability = vaultCapability({ registered: 1, semantic: true });
    expect(capability!.status).toBe("active");
    expect(capability!.detail).toContain("Semantic:");
    expect(capability!.detail).not.toContain("Lexical only");

    const warnings = collectConfigWarnings({
      config: makeConfig(),
      channelType: "web",
      vaultRetrieval: { registered: 1, semantic: true },
    });
    expect(warnings.some((w) => w.includes("LEXICAL ONLY"))).toBe(false);
  });

  it("does not claim a mode nobody measured, and reports an empty registry as inactive", () => {
    expect(vaultCapability()!.truth).toBe("declared-only");
    expect(vaultCapability()!.detail).toContain("not measured");
    expect(vaultCapability({ registered: 0, semantic: false })!.status).toBe("inactive");
    // …and an unmeasured path warns about nothing.
    expect(collectConfigWarnings({ config: makeConfig(), channelType: "web" })
      .some((w) => w.includes("LEXICAL ONLY"))).toBe(false);
  });
});

describe("vault retrieval before registration settles (plan 3.10)", () => {
  it("says the mode is not settled yet instead of claiming no vault, and warns about nothing", () => {
    const capability = buildCapabilitySnapshot({
      config: makeConfig(),
      installRoot: process.cwd(),
      channelType: "web",
      vaultRetrieval: { registered: 0, semantic: false, pending: true },
    }).find((c) => c.id === "codebase-vault");
    expect(capability!.truth).toBe("declared-only");
    expect(capability!.detail).toContain("had not settled");
    expect(capability!.detail).toContain("[vault] retrieval mode");
    // A subsystem that is still starting is not evidence of a lexical vault.
    expect(collectConfigWarnings({
      config: makeConfig(),
      channelType: "web",
      vaultRetrieval: { registered: 0, semantic: false, pending: true },
    }).some((w) => w.includes("LEXICAL ONLY"))).toBe(false);
  });
});

describe("multi-agent and delegation report what a boot built, not what config asked for", () => {
  // Both are constructed only in daemon mode. With STRADA_DAEMON_ENABLED=false
  // and the MULTI_AGENT_ENABLED / TASK_DELEGATION_ENABLED that setup writes,
  // the report said "active" while chats ran single-agent with no delegate tools.
  function configWithBoth(): Config {
    const base = makeConfig();
    return {
      ...base,
      agent: { ...base.agent, enabled: true },
      delegation: { ...base.delegation, enabled: true },
    } as Config;
  }

  it("reads inactive, and names the daemon, when the daemon-off boot never built them", () => {
    const report = buildBootReport({
      config: configWithBoth(),
      installRoot: process.cwd(),
      channelType: "web",
      channelHealthy: true,
      daemonMode: false,
      multiAgentWired: false,
      delegationWired: false,
      startupNotices: [],
    });

    const multiAgent = report.capabilities.find((c) => c.id === "multi-agent");
    const delegation = report.capabilities.find((c) => c.id === "delegation");
    expect(multiAgent?.status).toBe("inactive");
    expect(multiAgent?.detail).toMatch(/NOT built.*STRADA_DAEMON_ENABLED=false/);
    expect(delegation?.status).toBe("inactive");
    expect(delegation?.detail).toMatch(/NOT built.*STRADA_DAEMON_ENABLED=false/);
  });

  it("reads active when the boot built them, and stays config-read when nothing measured", () => {
    const built = buildCapabilitySnapshot({
      config: configWithBoth(),
      installRoot: process.cwd(),
      channelType: "web",
      daemonMode: true,
      multiAgentWired: true,
      delegationWired: true,
    });
    expect(built.find((c) => c.id === "multi-agent")?.status).toBe("active");
    expect(built.find((c) => c.id === "delegation")?.status).toBe("active");

    // The doctor reads static config and never boots: no measurement, no verdict.
    const unmeasured = buildCapabilitySnapshot({
      config: configWithBoth(),
      installRoot: process.cwd(),
      channelType: "doctor",
      daemonMode: false,
    });
    expect(unmeasured.find((c) => c.id === "multi-agent")?.detail).toBe("Multi-agent orchestration is enabled in current config.");
    expect(unmeasured.find((c) => c.id === "delegation")?.detail).toBe("Delegation is enabled in current config.");
  });
});

/**
 * WP-0.1: a refused Strada.MCP read "Install Strada.MCP" — the report said
 * "not installed" for a copy that was on disk and turned away by the trust
 * gate, which sends an operator to the wrong fix. And Strada.Modules had no
 * line at all, so "available beside the install, not installed" was nowhere.
 */
describe("the Strada.MCP and Strada.Modules lines name what happened (WP-0.1)", () => {
  type SnapshotOptions = Parameters<typeof buildCapabilitySnapshot>[0];
  const snapshot = (extra: Partial<SnapshotOptions>) =>
    buildCapabilitySnapshot({ config: makeConfig(), installRoot: process.cwd(), channelType: "web", ...extra });
  const mcpLine = (extra: Partial<SnapshotOptions>) => snapshot(extra).find((c) => c.id === "strada-mcp-runtime")!;
  const modulesLine = (extra: Partial<SnapshotOptions>) => snapshot(extra).find((c) => c.id === "strada-modules");

  const refusal =
    "Strada.MCP at /games/test/Packages/Submodules/Strada.MCP is inside the Unity project, which the agent can modify, so it was not loaded into the Brain process. Set STRADA_MCP_ALLOW_PROJECT_LOCAL=true to trust this copy.";

  it("says REFUSED, with the reason and the opt-in, for a copy the trust gate turned away", () => {
    const line = mcpLine({ stradaMcpLoadFailure: { refused: true, detail: refusal } });

    expect(line.status).toBe("degraded");
    expect(line.detail).toMatch(/refused/i);
    expect(line.detail).toContain("STRADA_MCP_ALLOW_PROJECT_LOCAL=true");
    expect(line.detail).not.toContain("Install Strada.MCP");
    // The surfaces that depend on it say why they are off, not "install it".
    const bridge = snapshot({ stradaMcpLoadFailure: { refused: true, detail: refusal } }).find((c) => c.id === "unity-bridge")!;
    expect(bridge.detail).toMatch(/refused/i);
    expect(bridge.detail).not.toContain("not installed");
  });

  it("says it failed to load, not that it is missing, for a copy that threw", () => {
    const line = mcpLine({ stradaMcpLoadFailure: { refused: false, detail: "Cannot find package 'zod'" } });

    expect(line.status).toBe("degraded");
    expect(line.detail).toContain("failed to load");
    expect(line.detail).toContain("Cannot find package 'zod'");
  });

  it("says not installed only when nothing was found (guard)", () => {
    const line = mcpLine({});

    expect(line.status).toBe("inactive");
    expect(line.detail).toContain("Install Strada.MCP");
  });

  it("names the copy it loaded and the copy it refused when it fell back", () => {
    const line = mcpLine({
      stradaMcpRuntime: {
        installed: true,
        sourcePath: "/work/Strada.MCP",
        version: "1.0.0",
        toolCount: 111,
        resourceCount: 3,
        promptCount: 2,
        bridgeConfigured: true,
        bridgeConnected: false,
        bridgeState: "disconnected",
        availableToolCount: 40,
        unavailableToolCount: 71,
        installSource: "sibling-checkout",
        refusedCopy: { path: "/games/test/Packages/Submodules/Strada.MCP", reason: refusal },
      },
    });

    expect(line.status).toBe("active");
    expect(line.detail).toContain("111 tools");
    expect(line.detail).toContain("/work/Strada.MCP (sibling-checkout)");
    expect(line.detail).toContain("/games/test/Packages/Submodules/Strada.MCP was refused");
  });

  it("reports Strada.Modules as available beside the install, not installed in the project", () => {
    const line = modulesLine({
      stradaDeps: {
        modulesInstalled: false,
        modulesPath: null,
        modulesCheckout: { path: "/work/Strada.Modules", source: "sibling-checkout", version: "1.0.0", commit: "abc1234" },
      },
    });

    expect(line).toBeDefined();
    expect(line!.status).toBe("inactive");
    expect(line!.detail).toContain("available (sibling abc1234), not installed in the project");
    expect(line!.detail).toContain("/work/Strada.Modules");
  });

  it("reports Strada.Modules installed, absent, or not looked for — three different lines", () => {
    const installed = modulesLine({
      stradaDeps: { modulesInstalled: true, modulesPath: "/games/test/Packages/Submodules/Strada.Modules", modulesVersion: "1.0.0" },
    })!;
    expect(installed).toMatchObject({ status: "active", truth: "wired" });
    expect(installed.detail).toContain("installed in the project");

    const absent = modulesLine({ stradaDeps: { modulesInstalled: false, modulesPath: null } })!;
    expect(absent.status).toBe("inactive");
    expect(absent.detail).toContain("no checkout");

    const unmeasured = modulesLine({})!;
    expect(unmeasured.truth).toBe("declared-only");
    expect(unmeasured.detail).toContain("not looked for");
  });
});
