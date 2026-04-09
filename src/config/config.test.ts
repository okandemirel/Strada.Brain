import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadConfig, resetConfigCache, validateConfig } from "./config.js";
import { realpathSync, statSync } from "node:fs";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

vi.mock("dotenv", () => ({
  config: vi.fn(),
}));

function setEnv(overrides: Record<string, string | undefined> = {}) {
  const defaults: Record<string, string> = {
    ANTHROPIC_API_KEY: "sk-test-key-123",
    UNITY_PROJECT_PATH: "/test/project",
  };
  const merged = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function toLegacyEnvKey(currentKey: string): string {
  return currentKey.replace("STRADA", "STRATA");
}

describe("loadConfig", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.mocked(realpathSync).mockImplementation((p) => String(p));
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
    // Clear relevant env vars
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_AUTH_MODE"];
    delete process.env["ANTHROPIC_AUTH_TOKEN"];
    delete process.env["TELEGRAM_BOT_TOKEN"];
    delete process.env["ALLOWED_TELEGRAM_USER_IDS"];
    delete process.env["ALLOWED_DISCORD_USER_IDS"];
    delete process.env["ALLOWED_DISCORD_ROLE_IDS"];
    delete process.env["WHATSAPP_SESSION_PATH"];
    delete process.env["WHATSAPP_ALLOWED_NUMBERS"];
    delete process.env["MATRIX_HOMESERVER"];
    delete process.env["MATRIX_ACCESS_TOKEN"];
    delete process.env["MATRIX_USER_ID"];
    delete process.env["MATRIX_ALLOWED_USER_IDS"];
    delete process.env["MATRIX_ALLOWED_ROOM_IDS"];
    delete process.env["MATRIX_ALLOW_OPEN_ACCESS"];
    delete process.env["IRC_SERVER"];
    delete process.env["IRC_NICK"];
    delete process.env["IRC_CHANNELS"];
    delete process.env["IRC_ALLOWED_USERS"];
    delete process.env["IRC_ALLOW_OPEN_ACCESS"];
    delete process.env["TEAMS_APP_ID"];
    delete process.env["TEAMS_APP_PASSWORD"];
    delete process.env["TEAMS_ALLOWED_USER_IDS"];
    delete process.env["TEAMS_ALLOW_OPEN_ACCESS"];
    delete process.env["JWT_SECRET"];
    delete process.env["REQUIRE_MFA"];
    delete process.env["REQUIRE_EDIT_CONFIRMATION"];
    delete process.env["READ_ONLY_MODE"];
    delete process.env["LLM_STREAM_INITIAL_TIMEOUT_MS"];
    delete process.env["LLM_STREAM_STALL_TIMEOUT_MS"];
    delete process.env["UNITY_PROJECT_PATH"];
    delete process.env["OPENAI_AUTH_MODE"];
    delete process.env["OPENAI_CHATGPT_AUTH_FILE"];
    delete process.env["OPENAI_SUBSCRIPTION_ACCESS_TOKEN"];
    delete process.env["OPENAI_SUBSCRIPTION_ACCOUNT_ID"];
    delete process.env["STRADA_CORE_REPO_URL"];
    delete process.env["STRADA_MODULES_REPO_URL"];
    delete process.env["STRADA_MCP_PATH"];
    delete process.env["LOG_LEVEL"];
    delete process.env["LOG_FILE"];
    // Clear unified memory env vars
    delete process.env["MEMORY_BACKEND"];
    delete process.env["MEMORY_DIMENSIONS"];
    delete process.env["MEMORY_AUTO_TIERING"];
    delete process.env["MEMORY_AUTO_TIERING_INTERVAL_MS"];
    delete process.env["MEMORY_PROMOTION_THRESHOLD"];
    delete process.env["MEMORY_DEMOTION_TIMEOUT_DAYS"];
    delete process.env["MEMORY_TIER_WORKING_MAX"];
    delete process.env["MEMORY_TIER_EPHEMERAL_MAX"];
    delete process.env["MEMORY_TIER_PERSISTENT_MAX"];
    delete process.env["MEMORY_EPHEMERAL_TTL_HOURS"];
    // Clear Bayesian env vars
    delete process.env["BAYESIAN_ENABLED"];
    delete process.env["BAYESIAN_DEPRECATED_THRESHOLD"];
    delete process.env["BAYESIAN_ACTIVE_THRESHOLD"];
    delete process.env["BAYESIAN_EVOLUTION_THRESHOLD"];
    delete process.env["BAYESIAN_AUTO_EVOLVE_THRESHOLD"];
    delete process.env["BAYESIAN_MAX_INITIAL"];
    delete process.env["BAYESIAN_COOLING_PERIOD_DAYS"];
    delete process.env["BAYESIAN_COOLING_MIN_OBSERVATIONS"];
    delete process.env["BAYESIAN_COOLING_MAX_FAILURES"];
    delete process.env["BAYESIAN_PROMOTION_MIN_OBSERVATIONS"];
    delete process.env["BAYESIAN_VERDICT_CLEAN_SUCCESS"];
    delete process.env["BAYESIAN_VERDICT_RETRY_SUCCESS"];
    delete process.env["BAYESIAN_VERDICT_FAILURE"];
    // Clear daemon env vars
    delete process.env["STRADA_DAEMON_INTERVAL_MS"];
    delete process.env["STRADA_DAEMON_TIMEZONE"];
    delete process.env["STRADA_DAEMON_HEARTBEAT_FILE"];
    delete process.env["STRADA_DAEMON_DAILY_BUDGET"];
    delete process.env["STRADA_DAEMON_BUDGET_WARN_PCT"];
    delete process.env["STRADA_DAEMON_APPROVAL_TIMEOUT_MINUTES"];
    delete process.env["STRADA_DAEMON_AUTO_APPROVE_TOOLS"];
    delete process.env["STRADA_DAEMON_BACKOFF_BASE"];
    delete process.env["STRADA_DAEMON_BACKOFF_MAX"];
    delete process.env["STRADA_DAEMON_FAILURE_THRESHOLD"];
    delete process.env["STRADA_DAEMON_IDLE_PAUSE"];
    delete process.env["AUTONOMOUS_DEFAULT_ENABLED"];
    delete process.env["AUTONOMOUS_DEFAULT_HOURS"];
    // Clear chain resilience env vars
    delete process.env["CHAIN_ROLLBACK_ENABLED"];
    delete process.env["CHAIN_PARALLEL_ENABLED"];
    delete process.env["CHAIN_MAX_PARALLEL_BRANCHES"];
    delete process.env["CHAIN_COMPENSATION_TIMEOUT_MS"];
    // Clear task delegation env vars
    delete process.env["TASK_DELEGATION_ENABLED"];
    delete process.env["AGENT_MAX_DELEGATION_DEPTH"];
    delete process.env["AGENT_MAX_CONCURRENT_DELEGATIONS"];
    delete process.env["DELEGATION_TIER_LOCAL"];
    delete process.env["DELEGATION_TIER_CHEAP"];
    delete process.env["DELEGATION_TIER_STANDARD"];
    delete process.env["DELEGATION_TIER_PREMIUM"];
    delete process.env["DELEGATION_VERBOSITY"];
    delete process.env["DELEGATION_TYPES"];
    delete process.env["DELEGATION_MAX_ITERATIONS_PER_TYPE"];
    delete process.env["TASK_MAX_CONCURRENT"];
    delete process.env["TASK_MESSAGE_BURST_WINDOW_MS"];
    delete process.env["TASK_MESSAGE_BURST_MAX_MESSAGES"];
    delete process.env["TASK_INTERACTIVE_MAX_ITERATIONS"];
    delete process.env["TASK_BACKGROUND_EPOCH_MAX_ITERATIONS"];
    delete process.env["TASK_BACKGROUND_AUTO_CONTINUE"];
    delete process.env["TASK_BACKGROUND_MAX_EPOCHS"];
    delete process.env["INTERACTION_MODE"];
    delete process.env["INTERACTION_HEARTBEAT_AFTER_MS"];
    delete process.env["INTERACTION_HEARTBEAT_INTERVAL_MS"];
    delete process.env["INTERACTION_ESCALATION_POLICY"];
    delete process.env["MODEL_INTELLIGENCE_PROVIDER_SOURCES_PATH"];
  });

  it("loads valid configuration", () => {
    setEnv();
    const config = loadConfig();
    expect(config.anthropicApiKey).toBe("sk-test-key-123");
    expect(config.unityProjectPath).toBe("/test/project");
    expect(config.strada.coreRepoUrl).toBe("https://github.com/okandemirel/Strada.Core.git");
    expect(config.strada.modulesRepoUrl).toBe("https://github.com/okandemirel/Strada.Modules.git");
    expect(config.strada.mcpPath).toBeUndefined();
    expect(config.security.systemAuth).toEqual({
      jwtSecret: undefined,
      requireMfa: false,
    });
    expect(config.llmStreamInitialTimeoutMs).toBe(600000);
    expect(config.llmStreamStallTimeoutMs).toBe(300000);
    expect(config.interaction).toEqual({
      mode: "phase-driven",
      heartbeatAfterMs: 120000,
      heartbeatIntervalMs: 300000,
      escalationPolicy: "hard-blockers-only",
    });
    expect(config.notification.routing.medium).toEqual(["dashboard"]);
  });

  it("throws when ANTHROPIC_API_KEY is missing", () => {
    setEnv({ ANTHROPIC_API_KEY: undefined });
    delete process.env["ANTHROPIC_API_KEY"];
    expect(() => loadConfig()).toThrow("Invalid configuration");
  });

  it("accepts Claude subscription auth without an Anthropic API key", () => {
    setEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_MODE: "claude-subscription",
      ANTHROPIC_AUTH_TOKEN: "claude-subscription-token-123456",
    });
    delete process.env["ANTHROPIC_API_KEY"];

    const config = loadConfig();

    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.anthropicAuthMode).toBe("claude-subscription");
    expect(config.anthropicAuthToken).toBe("claude-subscription-token-123456");
  });

  it("rejects a stale Claude auth token when auth mode is api-key", () => {
    setEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_MODE: "api-key",
      ANTHROPIC_AUTH_TOKEN: "stale-claude-subscription-token-123456",
    });
    delete process.env["ANTHROPIC_API_KEY"];

    expect(() => loadConfig()).toThrow("Invalid configuration");
  });

  it("throws when UNITY_PROJECT_PATH is missing", () => {
    setEnv({ UNITY_PROJECT_PATH: undefined });
    delete process.env["UNITY_PROJECT_PATH"];
    expect(() => loadConfig()).toThrow("Invalid configuration");
  });

  it("accepts optional telegramBotToken", () => {
    setEnv();
    const config = loadConfig();
    expect(config.telegramBotToken).toBeUndefined();
  });

  it("sets telegramBotToken when provided", () => {
    setEnv({ TELEGRAM_BOT_TOKEN: "bot-token-123" });
    const config = loadConfig();
    expect(config.telegram.botToken).toBe("bot-token-123");
  });

  it("loads task delegation env vars into runtime config", () => {
    setEnv({
      TASK_DELEGATION_ENABLED: "true",
      AGENT_MAX_DELEGATION_DEPTH: "4",
      AGENT_MAX_CONCURRENT_DELEGATIONS: "5",
      DELEGATION_TIER_LOCAL: "ollama:llama3.3",
      DELEGATION_TIER_CHEAP: "deepseek:deepseek-chat",
      DELEGATION_TIER_STANDARD: "claude:claude-sonnet-4-6-20250514",
      DELEGATION_TIER_PREMIUM: "claude:claude-opus-4-6-20250514",
      DELEGATION_VERBOSITY: "verbose",
      DELEGATION_TYPES: JSON.stringify([
        {
          name: "analysis",
          tier: "cheap",
          timeoutMs: 30000,
          maxIterations: 7,
        },
      ]),
      DELEGATION_MAX_ITERATIONS_PER_TYPE: "7",
    });

    const config = loadConfig();

    expect(config.delegation.enabled).toBe(true);
    expect(config.delegation.maxDepth).toBe(4);
    expect(config.delegation.maxConcurrentPerParent).toBe(5);
    expect(config.delegation.tiers.cheap).toBe("deepseek:deepseek-chat");
    expect(config.delegation.verbosity).toBe("verbose");
    expect(config.delegation.types).toHaveLength(1);
    expect(config.delegation.types[0]?.name).toBe("analysis");
    expect(config.delegation.types[0]?.maxIterations).toBe(7);
  });

  it("loads Strada dependency config into structured runtime config", () => {
    setEnv({
      STRADA_CORE_REPO_URL: "https://example.com/core.git",
      STRADA_MODULES_REPO_URL: "https://example.com/modules.git",
      STRADA_MCP_PATH: "/opt/strada-mcp",
    });

    const config = loadConfig();

    expect(config.strada).toMatchObject({
      coreRepoUrl: "https://example.com/core.git",
      modulesRepoUrl: "https://example.com/modules.git",
      mcpPath: "/opt/strada-mcp",
    });
  });

  it("loads streaming timeout config into runtime config", () => {
    setEnv({
      LLM_STREAM_INITIAL_TIMEOUT_MS: "1500",
      LLM_STREAM_STALL_TIMEOUT_MS: "750",
    });

    const config = loadConfig();

    expect(config.llmStreamInitialTimeoutMs).toBe(1500);
    expect(config.llmStreamStallTimeoutMs).toBe(750);
  });

  it("loads model intelligence provider source registry path into runtime config", () => {
    setEnv({
      MODEL_INTELLIGENCE_PROVIDER_SOURCES_PATH: "/opt/strada/provider-sources.json",
    });

    const config = loadConfig();

    expect(config.modelIntelligence.providerSourcesPath).toBe("/opt/strada/provider-sources.json");
  });

  it("loads interaction policy env vars into runtime config", () => {
    setEnv({
      INTERACTION_MODE: "standard",
      INTERACTION_HEARTBEAT_AFTER_MS: "15000",
      INTERACTION_HEARTBEAT_INTERVAL_MS: "45000",
      INTERACTION_ESCALATION_POLICY: "standard",
    });

    const config = loadConfig();

    expect(config.interaction).toEqual({
      mode: "standard",
      heartbeatAfterMs: 15000,
      heartbeatIntervalMs: 45000,
      escalationPolicy: "standard",
    });
  });

  it("accepts OpenAI ChatGPT/Codex subscription auth without an OpenAI API key", () => {
    setEnv({
      ANTHROPIC_API_KEY: undefined,
      OPENAI_AUTH_MODE: "chatgpt-subscription",
      OPENAI_CHATGPT_AUTH_FILE: "~/.codex/auth.json",
    });

    const config = loadConfig();

    expect(config.openaiAuthMode).toBe("chatgpt-subscription");
    expect(config.openaiChatgptAuthFile).toBe("~/.codex/auth.json");
    expect(config.openaiApiKey).toBeUndefined();
  });

  it("loads manual OpenAI subscription token overrides into runtime config", () => {
    setEnv({
      ANTHROPIC_API_KEY: undefined,
      OPENAI_AUTH_MODE: "chatgpt-subscription",
      OPENAI_SUBSCRIPTION_ACCESS_TOKEN: "access-token",
      OPENAI_SUBSCRIPTION_ACCOUNT_ID: "account-id",
    });

    const config = loadConfig();

    expect(config.openaiAuthMode).toBe("chatgpt-subscription");
    expect(config.openaiSubscriptionAccessToken).toBe("access-token");
    expect(config.openaiSubscriptionAccountId).toBe("account-id");
  });

  it("loads task routing env vars into runtime config", () => {
    setEnv({
      TASK_MAX_CONCURRENT: "4",
      TASK_MESSAGE_BURST_WINDOW_MS: "500",
      TASK_MESSAGE_BURST_MAX_MESSAGES: "6",
      TASK_INTERACTIVE_MAX_ITERATIONS: "60",
      TASK_BACKGROUND_EPOCH_MAX_ITERATIONS: "75",
      TASK_BACKGROUND_AUTO_CONTINUE: "false",
      TASK_BACKGROUND_MAX_EPOCHS: "3",
    });

    const config = loadConfig();

    expect(config.tasks).toEqual({
      concurrencyLimit: 4,
      messageBurstWindowMs: 500,
      messageBurstMaxMessages: 6,
      interactiveMaxIterations: 60,
      interactiveTokenBudget: 500000,
      backgroundEpochMaxIterations: 75,
      backgroundAutoContinue: false,
      backgroundMaxEpochs: 3,
    });
  });

  it("parses CSV user IDs correctly", () => {
    setEnv({ ALLOWED_TELEGRAM_USER_IDS: "1,2,3" });
    const config = loadConfig();
    expect(config.telegram.allowedUserIds).toEqual([1, 2, 3]);
  });

  it("loads channel auth configuration into structured runtime config", () => {
    setEnv({
      ALLOWED_DISCORD_USER_IDS: "user-1,user-2",
      ALLOWED_DISCORD_ROLE_IDS: "role-1,role-2",
      WHATSAPP_SESSION_PATH: ".whatsapp-test",
      WHATSAPP_ALLOWED_NUMBERS: "905551112233,905554445566",
      MATRIX_HOMESERVER: "https://matrix.example.com",
      MATRIX_ACCESS_TOKEN: "matrix-token",
      MATRIX_USER_ID: "@strada:example.com",
      MATRIX_ALLOWED_USER_IDS: "@alice:example.com,@bob:example.com",
      MATRIX_ALLOWED_ROOM_IDS: "!room1:example.com,!room2:example.com",
      MATRIX_ALLOW_OPEN_ACCESS: "true",
      IRC_SERVER: "irc.example.com",
      IRC_NICK: "strada-test",
      IRC_CHANNELS: "#brain,#ops",
      IRC_ALLOWED_USERS: "alice,bob",
      IRC_ALLOW_OPEN_ACCESS: "true",
      TEAMS_APP_ID: "teams-app-id",
      TEAMS_APP_PASSWORD: "teams-app-password",
      TEAMS_ALLOWED_USER_IDS: "user-a,user-b",
      TEAMS_ALLOW_OPEN_ACCESS: "true",
    });

    const config = loadConfig();

    expect(config.discord.allowedUserIds).toEqual(["user-1", "user-2"]);
    expect(config.discord.allowedRoleIds).toEqual(["role-1", "role-2"]);
    expect(config.whatsapp).toEqual({
      sessionPath: ".whatsapp-test",
      allowedNumbers: ["905551112233", "905554445566"],
    });
    expect(config.matrix).toEqual({
      homeserver: "https://matrix.example.com",
      accessToken: "matrix-token",
      userId: "@strada:example.com",
      allowedUserIds: ["@alice:example.com", "@bob:example.com"],
      allowedRoomIds: ["!room1:example.com", "!room2:example.com"],
      allowOpenAccess: true,
    });
    expect(config.irc).toEqual({
      server: "irc.example.com",
      nick: "strada-test",
      channels: ["#brain", "#ops"],
      allowedUsers: ["alice", "bob"],
      allowOpenAccess: true,
    });
    expect(config.teams).toEqual({
      appId: "teams-app-id",
      appPassword: "teams-app-password",
      allowedUserIds: ["user-a", "user-b"],
      allowOpenAccess: true,
    });
  });

  it("applies default values", () => {
    setEnv();
    const config = loadConfig();
    expect(config.security.requireEditConfirmation).toBe(true);
    expect(config.security.readOnlyMode).toBe(false);
    expect(config.tasks).toEqual({
      concurrencyLimit: 3,
      messageBurstWindowMs: 350,
      messageBurstMaxMessages: 8,
      interactiveMaxIterations: 25,
      interactiveTokenBudget: 500000,
      backgroundEpochMaxIterations: 50,
      backgroundAutoContinue: true,
      backgroundMaxEpochs: 3,
    });
    expect(config.logLevel).toBe("info");
    expect(config.logFile).toBe("strada-brain.log");
  });

  it("parses boolean strings correctly", () => {
    setEnv({
      JWT_SECRET: "super-secret-for-tests",
      REQUIRE_MFA: "true",
      REQUIRE_EDIT_CONFIRMATION: "false",
      READ_ONLY_MODE: "true",
    });
    const config = loadConfig();
    expect(config.security.systemAuth).toEqual({
      jwtSecret: "super-secret-for-tests",
      requireMfa: true,
    });
    expect(config.security.requireEditConfirmation).toBe(false);
    expect(config.security.readOnlyMode).toBe(true);
  });

  it("caches config on subsequent calls", () => {
    setEnv();
    const config1 = loadConfig();
    const config2 = loadConfig();
    expect(config1).toBe(config2); // same reference
  });

  it("resets cache with resetConfigCache", () => {
    setEnv();
    const config1 = loadConfig();
    resetConfigCache();
    const config2 = loadConfig();
    expect(config1).not.toBe(config2);
  });

  it("throws when project path does not exist", () => {
    setEnv();
    vi.mocked(realpathSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => loadConfig()).toThrow("does not exist");
  });

  it("throws when project path is not a directory", () => {
    setEnv();
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<
      typeof statSync
    >);
    expect(() => loadConfig()).toThrow("not a directory");
  });

  it("resolves symlinked project path", () => {
    setEnv();
    vi.mocked(realpathSync).mockReturnValue("/real/path");
    const config = loadConfig();
    expect(config.unityProjectPath).toBe("/real/path");
  });

  // =========================================================================
  // Unified Memory Config Tests (MEM-07)
  // =========================================================================

  describe("unified memory config", () => {
    it("includes backend field with default 'agentdb'", () => {
      setEnv();
      const config = loadConfig();
      expect(config.memory.backend).toBe("agentdb");
    });

    it("includes unified sub-object with correct defaults", () => {
      setEnv();
      const config = loadConfig();
      expect(config.memory.unified).toEqual({
        dimensions: 1536,
        autoTiering: false,
        autoTieringIntervalMs: 300000,
        promotionThreshold: 5,
        demotionTimeoutDays: 7,
        tierLimits: {
          working: 100,
          ephemeral: 1000,
          persistent: 10000,
        },
        ephemeralTtlHours: 24,
      });
    });

    it("accepts MEMORY_BACKEND=agentdb", () => {
      setEnv({ MEMORY_BACKEND: "agentdb" });
      const config = loadConfig();
      expect(config.memory.backend).toBe("agentdb");
    });

    it("accepts MEMORY_BACKEND=file", () => {
      setEnv({ MEMORY_BACKEND: "file" });
      const config = loadConfig();
      expect(config.memory.backend).toBe("file");
    });

    it("rejects invalid MEMORY_BACKEND value", () => {
      setEnv({ MEMORY_BACKEND: "invalid" });
      expect(() => loadConfig()).toThrow();
    });

    it("validates MEMORY_DIMENSIONS range 64-4096", () => {
      setEnv({ MEMORY_DIMENSIONS: "768" });
      const config = loadConfig();
      expect(config.memory.unified.dimensions).toBe(768);
    });

    it("rejects MEMORY_DIMENSIONS below minimum", () => {
      setEnv({ MEMORY_DIMENSIONS: "32" });
      expect(() => loadConfig()).toThrow();
    });

    it("rejects MEMORY_DIMENSIONS above maximum", () => {
      setEnv({ MEMORY_DIMENSIONS: "5000" });
      expect(() => loadConfig()).toThrow();
    });

    it("rejects non-numeric MEMORY_DIMENSIONS", () => {
      setEnv({ MEMORY_DIMENSIONS: "abc" });
      expect(() => loadConfig()).toThrow();
    });

    it("converts MEMORY_AUTO_TIERING string to boolean", () => {
      setEnv({ MEMORY_AUTO_TIERING: "true" });
      const config = loadConfig();
      expect(config.memory.unified.autoTiering).toBe(true);
    });

    it("defaults MEMORY_AUTO_TIERING to false", () => {
      setEnv();
      const config = loadConfig();
      expect(config.memory.unified.autoTiering).toBe(false);
    });

    it("validates MEMORY_TIER_WORKING_MAX as positive integer", () => {
      setEnv({ MEMORY_TIER_WORKING_MAX: "200" });
      const config = loadConfig();
      expect(config.memory.unified.tierLimits.working).toBe(200);
    });

    it("validates MEMORY_TIER_EPHEMERAL_MAX as positive integer", () => {
      setEnv({ MEMORY_TIER_EPHEMERAL_MAX: "5000" });
      const config = loadConfig();
      expect(config.memory.unified.tierLimits.ephemeral).toBe(5000);
    });

    it("validates MEMORY_TIER_PERSISTENT_MAX as positive integer", () => {
      setEnv({ MEMORY_TIER_PERSISTENT_MAX: "50000" });
      const config = loadConfig();
      expect(config.memory.unified.tierLimits.persistent).toBe(50000);
    });

    it("validates MEMORY_EPHEMERAL_TTL_HOURS as positive integer", () => {
      setEnv({ MEMORY_EPHEMERAL_TTL_HOURS: "48" });
      const config = loadConfig();
      expect(config.memory.unified.ephemeralTtlHours).toBe(48);
    });

    it("default config (no env vars) produces valid MemoryConfig with all unified fields", () => {
      setEnv();
      const config = loadConfig();
      expect(config.memory).toEqual({
        enabled: true,
        dbPath: ".strada-memory",
        backend: "agentdb",
        unified: {
          dimensions: 1536,
          autoTiering: false,
          autoTieringIntervalMs: 300000,
          promotionThreshold: 5,
          demotionTimeoutDays: 7,
          tierLimits: {
            working: 100,
            ephemeral: 1000,
            persistent: 10000,
          },
          ephemeralTtlHours: 24,
        },
        decay: {
          enabled: true,
          lambdas: {
            working: 0.1,
            ephemeral: 0.05,
            persistent: 0.01,
          },
          exemptDomains: ["instinct", "analysis-cache"],
          timeoutMs: 30000,
        },
        consolidation: {
          enabled: true,
          idleMinutes: 5,
          threshold: 0.85,
          batchSize: 50,
          minClusterSize: 2,
          maxDepth: 3,
          modelTier: "cheap",
        },
      });
    });
  });

  // =========================================================================
  // Bayesian Config Tests (EVAL-04, EVAL-07)
  // =========================================================================

  describe("bayesian config", () => {
    it("validates with sensible defaults", () => {
      setEnv();
      const result = validateConfig({
        anthropicApiKey: "sk-test-key-123",
        unityProjectPath: "/test/project",
      });
      expect(result.kind).toBe("valid");
      if (result.kind !== "valid") return;
      const raw = result.value as Record<string, unknown>;
      expect(raw.bayesian).toBeDefined();
      const bayesian = raw.bayesian as Record<string, unknown>;
      expect(bayesian.enabled).toBe(true);
      expect(bayesian.deprecatedThreshold).toBe(0.3);
      expect(bayesian.activeThreshold).toBe(0.7);
      expect(bayesian.evolutionThreshold).toBe(0.9);
      expect(bayesian.autoEvolveThreshold).toBe(0.95);
      expect(bayesian.maxInitial).toBe(0.5);
      expect(bayesian.coolingPeriodDays).toBe(7);
      expect(bayesian.coolingMinObservations).toBe(10);
      expect(bayesian.coolingMaxFailures).toBe(3);
      expect(bayesian.promotionMinObservations).toBe(25);
      expect(bayesian.verdictCleanSuccess).toBe(0.9);
      expect(bayesian.verdictRetrySuccess).toBe(0.6);
      expect(bayesian.verdictFailure).toBe(0.2);
    });

    it("rejects invalid threshold ordering (deprecated >= active)", () => {
      setEnv({
        BAYESIAN_DEPRECATED_THRESHOLD: "0.8",
        BAYESIAN_ACTIVE_THRESHOLD: "0.5",
      });
      expect(() => loadConfig()).toThrow();
    });

    it("accepts custom threshold values within range", () => {
      setEnv({
        BAYESIAN_DEPRECATED_THRESHOLD: "0.2",
        BAYESIAN_ACTIVE_THRESHOLD: "0.6",
        BAYESIAN_EVOLUTION_THRESHOLD: "0.85",
        BAYESIAN_AUTO_EVOLVE_THRESHOLD: "0.92",
        BAYESIAN_MAX_INITIAL: "0.4",
      });
      const config = loadConfig();
      const bayesian = config.bayesian as Record<string, unknown>;
      expect(bayesian.deprecatedThreshold).toBe(0.2);
      expect(bayesian.activeThreshold).toBe(0.6);
      expect(bayesian.maxInitial).toBe(0.4);
    });
  });

  // =========================================================================
  // Daemon Config Tests (DAEMON-01, DAEMON-03, SEC-05)
  // =========================================================================

  describe("daemon config", () => {
    it("validates with sensible defaults", () => {
      setEnv();
      const config = loadConfig();
      expect(config.daemon).toBeDefined();
      expect(config.daemon.heartbeat.intervalMs).toBe(60000);
      expect(config.daemon.budget.warnPct).toBe(0.8);
      expect(config.daemon.security.approvalTimeoutMin).toBe(30);
      expect(config.daemon.backoff.baseCooldownMs).toBe(60000);
      expect(config.daemon.backoff.maxCooldownMs).toBe(3600000);
      expect(config.daemon.backoff.failureThreshold).toBe(3);
    });

    it("rejects intervalMs < 10000", () => {
      setEnv({ STRADA_DAEMON_INTERVAL_MS: "5000" });
      expect(() => loadConfig()).toThrow();
    });

    it("rejects intervalMs > 300000", () => {
      setEnv({ STRADA_DAEMON_INTERVAL_MS: "500000" });
      expect(() => loadConfig()).toThrow();
    });

    it("rejects dailyBudget <= 0 when provided", () => {
      setEnv({ STRADA_DAEMON_DAILY_BUDGET: "0" });
      expect(() => loadConfig()).toThrow();
    });

    it("accepts comma-separated STRADA_DAEMON_AUTO_APPROVE_TOOLS", () => {
      setEnv({ STRADA_DAEMON_AUTO_APPROVE_TOOLS: "file_read,git_status,search" });
      const config = loadConfig();
      expect(config.daemon.security.autoApproveTools).toEqual([
        "file_read",
        "git_status",
        "search",
      ]);
    });

    it("returns Config with daemon property matching DaemonConfig shape", () => {
      setEnv();
      const config = loadConfig();
      expect(config.daemon).toEqual({
        heartbeat: {
          intervalMs: 60000,
          heartbeatFile: "./HEARTBEAT.md",
          idlePause: false,
        },
        security: {
          approvalTimeoutMin: 30,
          autoApproveTools: [],
        },
        budget: {
          dailyBudgetUsd: undefined,
          warnPct: 0.8,
        },
        backoff: {
          baseCooldownMs: 60000,
          maxCooldownMs: 3600000,
          failureThreshold: 3,
        },
        timezone: "",
        triggers: {
          webhookSecret: undefined,
          webhookRateLimit: "10/min",
          dedupWindowMs: 300000,
          defaultDebounceMs: 500,
          checklistMorningHour: 9,
          checklistAfternoonHour: 14,
          checklistEveningHour: 18,
        },
        triggerFireRetentionDays: 30,
      });
    });

    it("defaults STRADA_DAEMON_TIMEZONE to empty string", () => {
      setEnv();
      const config = loadConfig();
      expect(config.daemon.timezone).toBe("");
    });

    it("accepts custom daemon values", () => {
      setEnv({
        STRADA_DAEMON_INTERVAL_MS: "30000",
        STRADA_DAEMON_TIMEZONE: "America/New_York",
        STRADA_DAEMON_HEARTBEAT_FILE: "./custom.md",
        STRADA_DAEMON_DAILY_BUDGET: "10.50",
        STRADA_DAEMON_BUDGET_WARN_PCT: "0.9",
        STRADA_DAEMON_APPROVAL_TIMEOUT_MINUTES: "60",
        STRADA_DAEMON_BACKOFF_BASE: "30000",
        STRADA_DAEMON_BACKOFF_MAX: "7200000",
        STRADA_DAEMON_FAILURE_THRESHOLD: "5",
        STRADA_DAEMON_IDLE_PAUSE: "true",
      });
      const config = loadConfig();
      expect(config.daemon.heartbeat.intervalMs).toBe(30000);
      expect(config.daemon.timezone).toBe("America/New_York");
      expect(config.daemon.heartbeat.heartbeatFile).toBe("./custom.md");
      expect(config.daemon.budget.dailyBudgetUsd).toBe(10.5);
      expect(config.daemon.budget.warnPct).toBe(0.9);
      expect(config.daemon.security.approvalTimeoutMin).toBe(60);
      expect(config.daemon.backoff.baseCooldownMs).toBe(30000);
      expect(config.daemon.backoff.maxCooldownMs).toBe(7200000);
      expect(config.daemon.backoff.failureThreshold).toBe(5);
      expect(config.daemon.heartbeat.idlePause).toBe(true);
    });

    it("ignores legacy daemon env aliases", () => {
      setEnv();
      const legacyIntervalKey = toLegacyEnvKey("STRADA_DAEMON_INTERVAL_MS");
      const legacyTimezoneKey = toLegacyEnvKey("STRADA_DAEMON_TIMEZONE");
      process.env[legacyIntervalKey] = "30000";
      process.env[legacyTimezoneKey] = "America/New_York";

      const config = loadConfig();

      expect(config.daemon.heartbeat.intervalMs).toBe(60000);
      expect(config.daemon.timezone).toBe("");

      delete process.env[legacyIntervalKey];
      delete process.env[legacyTimezoneKey];
    });

    it("parses autonomous defaults", () => {
      setEnv({
        AUTONOMOUS_DEFAULT_ENABLED: "true",
        AUTONOMOUS_DEFAULT_HOURS: "36",
      });

      const config = loadConfig();

      expect(config.autonomousDefaultEnabled).toBe(true);
      expect(config.autonomousDefaultHours).toBe(36);
    });
  });

  describe("memory re-retrieval config", () => {
    it("ignores legacy memory env aliases", () => {
      setEnv();
      const legacyIntervalKey = toLegacyEnvKey("STRADA_MEMORY_RERETRIEVAL_INTERVAL");
      const legacyThresholdKey = toLegacyEnvKey("STRADA_MEMORY_TOPIC_SHIFT_THRESHOLD");
      process.env[legacyIntervalKey] = "3";
      process.env[legacyThresholdKey] = "0.6";

      const config = loadConfig();

      expect(config.reRetrieval.interval).toBe(5);
      expect(config.reRetrieval.topicShiftThreshold).toBe(0.4);

      delete process.env[legacyIntervalKey];
      delete process.env[legacyThresholdKey];
    });
  });

  // =========================================================================
  // Chain Resilience Config Tests (CHAIN-01..04)
  // =========================================================================

  describe("chain resilience config", () => {
    it("validates with sensible defaults", () => {
      setEnv();
      const config = loadConfig();
      expect(config.toolChain.resilience).toEqual({
        rollbackEnabled: false,
        parallelEnabled: false,
        maxParallelBranches: 4,
        compensationTimeoutMs: 30000,
      });
    });

    it("accepts CHAIN_ROLLBACK_ENABLED=false", () => {
      setEnv({ CHAIN_ROLLBACK_ENABLED: "false" });
      const config = loadConfig();
      expect(config.toolChain.resilience.rollbackEnabled).toBe(false);
    });

    it("accepts CHAIN_PARALLEL_ENABLED=false", () => {
      setEnv({ CHAIN_PARALLEL_ENABLED: "false" });
      const config = loadConfig();
      expect(config.toolChain.resilience.parallelEnabled).toBe(false);
    });

    it("accepts CHAIN_MAX_PARALLEL_BRANCHES within range", () => {
      setEnv({ CHAIN_MAX_PARALLEL_BRANCHES: "8" });
      const config = loadConfig();
      expect(config.toolChain.resilience.maxParallelBranches).toBe(8);
    });

    it("rejects CHAIN_MAX_PARALLEL_BRANCHES below 1", () => {
      setEnv({ CHAIN_MAX_PARALLEL_BRANCHES: "0" });
      expect(() => loadConfig()).toThrow();
    });

    it("rejects CHAIN_MAX_PARALLEL_BRANCHES above 10", () => {
      setEnv({ CHAIN_MAX_PARALLEL_BRANCHES: "11" });
      expect(() => loadConfig()).toThrow();
    });

    it("accepts CHAIN_COMPENSATION_TIMEOUT_MS within range", () => {
      setEnv({ CHAIN_COMPENSATION_TIMEOUT_MS: "60000" });
      const config = loadConfig();
      expect(config.toolChain.resilience.compensationTimeoutMs).toBe(60000);
    });

    it("rejects CHAIN_COMPENSATION_TIMEOUT_MS below 1000", () => {
      setEnv({ CHAIN_COMPENSATION_TIMEOUT_MS: "500" });
      expect(() => loadConfig()).toThrow();
    });

    it("rejects CHAIN_COMPENSATION_TIMEOUT_MS above 300000", () => {
      setEnv({ CHAIN_COMPENSATION_TIMEOUT_MS: "500000" });
      expect(() => loadConfig()).toThrow();
    });
  });
});
