/**
 * Config Zod schema for Strada.Brain
 *
 * Contains the Zod object schema (configSchema) and its private helper schemas.
 * Runtime-free: only imports z from zod and types from ./config-types.js.
 * Extracted from config.ts (plan 028 step 3).
 *
 * Imported by:
 *   - config.ts (re-exports configSchema; keeps loadConfig/validateConfig/assembly)
 */

import { z } from "zod";
import {
  DEFAULT_STRADA_CORE_REPO_URL,
  DEFAULT_STRADA_MODULES_REPO_URL,
  DEFAULT_STRADA_MCP_REPO_URL,
  DEFAULT_LLM_STREAM_INITIAL_TIMEOUT_MS,
  DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS,
  DEFAULT_LLM_PROVIDER_FIRST_RESPONSE_TIMEOUT_MS,
} from "./config-types.js";

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

/** Log level schema */
const logLevelSchema = z.enum(["error", "warn", "info", "debug"]);

/** Embedding provider schema */
const embeddingProviderSchema = z.enum([
  "auto",
  "openai",
  "deepseek",
  "mistral",
  "together",
  "fireworks",
  "qwen",
  "gemini",
  "ollama",
]);

/** Port number schema */
const portSchema = z
  .string()
  .transform((s) => parseInt(s, 10))
  .pipe(z.number().int().min(1024).max(65535));

/** Boolean from string schema */
const boolFromString = (defaultValue: boolean) =>
  z
    .string()
    .transform((s) => s.toLowerCase().trim())
    .transform((s) => s === "true" || s === "1" || s === "yes")
    .default(String(defaultValue));

/** Comma-separated list schema */
const commaSeparatedList = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  )
  .optional();

/** Comma-separated number list schema */
const commaSeparatedNumberList = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean) // drop empty/whitespace tokens — a trailing comma yielded NaN and crashed config load
      .map((id) => parseInt(id, 10)),
  )
  .pipe(z.array(z.number().int()))
  .optional();

/** Config schema for validation */
export const configSchema = z
  .object({
    // AI Providers
    anthropicApiKey: z.string().optional(),
    anthropicAuthMode: z.enum(["api-key", "claude-subscription"]).default("api-key"),
    anthropicAuthToken: z.string().optional(),
    openaiApiKey: z.string().optional(),
    openaiAuthMode: z.enum(["api-key", "chatgpt-subscription"]).default("api-key"),
    openaiChatgptAuthFile: z.string().optional(),
    openaiSubscriptionAccessToken: z.string().optional(),
    openaiSubscriptionAccountId: z.string().optional(),
    deepseekApiKey: z.string().optional(),
    qwenApiKey: z.string().optional(),
    kimiApiKey: z.string().optional(),
    minimaxApiKey: z.string().optional(),
    groqApiKey: z.string().optional(),
    mistralApiKey: z.string().optional(),
    togetherApiKey: z.string().optional(),
    fireworksApiKey: z.string().optional(),
    geminiApiKey: z.string().optional(),
    opencodeApiKey: z.string().optional(),
    opencodeBaseUrl: z.string().optional(),
    opencodeDefaultModel: z.string().optional(),
    openrouterApiKey: z.string().optional(),
    providerChain: z.string().optional(),
    ollamaBaseUrl: z.string().optional(),

    // Telegram
    telegramBotToken: z.string().optional(),
    allowedTelegramUserIds: commaSeparatedNumberList,

    // Discord
    discordBotToken: z.string().optional(),
    discordGuildId: z.string().optional(),
    allowedDiscordUserIds: commaSeparatedList,
    allowedDiscordRoleIds: commaSeparatedList,

    // Slack
    slackBotToken: z.string().optional(),
    slackSigningSecret: z.string().optional(),
    slackAppToken: z.string().optional(),
    slackSocketMode: boolFromString(true),
    allowedSlackWorkspaces: commaSeparatedList,
    allowedSlackUserIds: commaSeparatedList,

    // WhatsApp
    whatsappSessionPath: z.string().default(".whatsapp-session"),
    whatsappAllowedNumbers: commaSeparatedList,

    // Matrix
    matrixHomeserver: z.string().optional(),
    matrixAccessToken: z.string().optional(),
    matrixUserId: z.string().optional(),
    matrixAllowedUserIds: commaSeparatedList,
    matrixAllowedRoomIds: commaSeparatedList,
    matrixAllowOpenAccess: boolFromString(false),

    // IRC
    ircServer: z.string().optional(),
    ircNick: z.string().default("strada-brain"),
    ircChannels: commaSeparatedList,
    ircAllowedUsers: commaSeparatedList,
    ircAllowOpenAccess: boolFromString(false),

    // Teams
    teamsAppId: z.string().optional(),
    teamsAppPassword: z.string().optional(),
    teamsAppType: z.enum(["MultiTenant", "SingleTenant"]).optional(),
    teamsAppTenantId: z.string().optional(),
    teamsAllowedUserIds: commaSeparatedList,
    teamsAllowOpenAccess: boolFromString(false),

    // Security
    jwtSecret: z.string().min(1).optional(),
    requireMfa: boolFromString(false),
    requireEditConfirmation: boolFromString(true),
    readOnlyMode: boolFromString(false),

    // Project
    unityProjectPath: z.string().min(1, "UNITY_PROJECT_PATH is required"),
    unityBridgePort: portSchema.default("7691"),
    unityBridgeAutoConnect: boolFromString(true),
    unityBridgeTimeout: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1000).max(60000))
      .default("5000"),
    unityEditorPath: z.string().min(1).optional(),
    stradaCoreRepoUrl: z.string().url().default(DEFAULT_STRADA_CORE_REPO_URL),
    stradaModulesRepoUrl: z.string().url().default(DEFAULT_STRADA_MODULES_REPO_URL),
    stradaMcpRepoUrl: z.string().url().default(DEFAULT_STRADA_MCP_REPO_URL),
    stradaMcpPath: z.string().min(1).optional(),
    scriptExecuteEnabled: boolFromString(false),
    reflectionInvokeEnabled: boolFromString(false),

    // Dashboard
    dashboardEnabled: boolFromString(false),
    dashboardPort: portSchema.default("3100"),

    // WebSocket Dashboard
    websocketDashboardEnabled: boolFromString(false),
    websocketDashboardPort: portSchema.default("3101"),
    websocketDashboardAuthToken: z.string().optional(),
    websocketDashboardAllowedOrigins: commaSeparatedList.optional(),

    // Prometheus
    prometheusEnabled: boolFromString(false),
    prometheusPort: portSchema.default("9090"),

    // Model Intelligence
    modelIntelligenceEnabled: boolFromString(true),
    modelIntelligenceRefreshHours: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(168))
      .default("24"),
    modelIntelligenceDbPath: z.string().default(".strada-memory/model-intelligence.db"),
    modelIntelligenceProviderSourcesPath: z
      .string()
      .default("src/agents/providers/provider-sources.json"),

    // Memory
    memoryEnabled: boolFromString(true),
    memoryDbPath: z
      .string()
      .refine((p) => !p.includes(".."), { message: "Path must not contain '..' (path traversal)" })
      .default(".strada-memory"),
    memoryBackend: z.enum(["agentdb", "file"]).default("agentdb"),
    memoryDimensions: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(64).max(4096))
      .default("1536"),
    memoryAutoTiering: boolFromString(false),
    memoryAutoTieringIntervalMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(10000).max(3600000))
      .default("300000"),
    memoryPromotionThreshold: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(1000))
      .default("5"),
    memoryDemotionTimeoutDays: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(365))
      .default("7"),
    memoryTierWorkingMax: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(10).max(10000))
      .default("100"),
    memoryTierEphemeralMax: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(10).max(100000))
      .default("1000"),
    memoryTierPersistentMax: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(10).max(1000000))
      .default("10000"),
    memoryEphemeralTtlHours: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(8760))
      .default("24"),

    // Memory Decay (Phase 21)
    memoryDecayEnabled: boolFromString(true),
    memoryDecayLambdaWorking: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.001).max(1.0))
      .default("0.10"),
    memoryDecayLambdaEphemeral: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.001).max(1.0))
      .default("0.05"),
    memoryDecayLambdaPersistent: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.001).max(1.0))
      .default("0.01"),
    memoryDecayExemptDomains: z.string().default("instinct,analysis-cache"),
    memoryDecayTimeoutMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1000).max(300000))
      .default("30000"),

    // Memory Consolidation (Phase 25)
    memoryConsolidationEnabled: boolFromString(true),
    memoryConsolidationIdleMinutes: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(1440))
      .default("5"),
    memoryConsolidationThreshold: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.5).max(0.99))
      .default("0.85"),
    memoryConsolidationBatchSize: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(5).max(200))
      .default("50"),
    memoryConsolidationMinClusterSize: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(2).max(20))
      .default("2"),
    memoryConsolidationMaxDepth: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(10))
      .default("3"),
    memoryConsolidationModelTier: z
      .enum(["local", "cheap", "standard", "premium"])
      .default("cheap"),

    // RAG
    ragEnabled: boolFromString(true),
    embeddingProvider: embeddingProviderSchema.default("auto"),
    embeddingModel: z.string().optional(),
    embeddingBaseUrl: z.string().optional(),
    embeddingDimensions: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(128).max(3072))
      .optional(),
    ragContextMaxTokens: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(500).max(16000))
      .default("4000"),

    // Features
    streamingEnabled: boolFromString(true),
    shellEnabled: boolFromString(true),
    llmStreamInitialTimeoutMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(
        z
          .number()
          .int()
          .min(1)
          .max(60 * 60 * 1000),
      )
      .default(String(DEFAULT_LLM_STREAM_INITIAL_TIMEOUT_MS)),
    llmStreamStallTimeoutMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(
        z
          .number()
          .int()
          .min(1)
          .max(60 * 60 * 1000),
      )
      .default(String(DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS)),
    llmProviderFirstResponseTimeoutMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(
        z
          .number()
          .int()
          .min(1)
          .max(60 * 60 * 1000),
      )
      .default(String(DEFAULT_LLM_PROVIDER_FIRST_RESPONSE_TIMEOUT_MS)),

    // Rate Limiting
    rateLimitEnabled: boolFromString(false),
    rateLimitMessagesPerMinute: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0))
      .default("0"),
    rateLimitMessagesPerHour: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0))
      .default("0"),
    rateLimitTokensPerDay: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0))
      .default("0"),
    rateLimitDailyBudgetUsd: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0))
      .default("0"),
    rateLimitMonthlyBudgetUsd: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0))
      .default("0"),

    // Unified Budget System
    stradaBudgetDailyUsd: z
      .string()
      .optional()
      .default("0")
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0).max(10000)),
    stradaBudgetMonthlyUsd: z
      .string()
      .optional()
      .default("0")
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0).max(100000)),
    stradaBudgetWarnPct: z
      .string()
      .optional()
      .default("0.8")
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.1).max(0.99)),

    // Codebase Memory Vault
    vault: z.object({
      enabled: boolFromString(false),
      writeHookBudgetMs: z.coerce.number().int().positive().default(200),  // sync reindex p95 target
      debounceMs: z.coerce.number().int().positive().default(800),         // watcher drain interval
      embeddingFallback: z.enum(["none", "local"]).default("local"),
      self: z.object({
        enabled: boolFromString(true),
      }).default({}),
    }).default({}),

    // Obsidian Integration
    obsidian: z.object({
      enabled: boolFromString(false),
      apiUrl: z.string().default("https://127.0.0.1:27124"),
      apiKey: z.string().default(""),
      vaultPath: z.string().default(""),
      certPath: z.string().optional(),
    }).default({}),

    // Logging
    logLevel: logLevelSchema.default("info"),
    logFile: z.string().default("strada-brain.log"),

    // Web Channel
    webChannelPort: portSchema.default("3000"),

    // Plugins
    pluginDirs: commaSeparatedList.transform((arr) => arr ?? []),

    // Bayesian Confidence System
    bayesianEnabled: boolFromString(true),
    bayesianDeprecatedThreshold: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.1).max(0.5))
      .default("0.3"),
    bayesianActiveThreshold: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.5).max(0.9))
      .default("0.7"),
    bayesianEvolutionThreshold: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.8).max(0.99))
      .default("0.9"),
    bayesianAutoEvolveThreshold: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.9).max(1.0))
      .default("0.95"),
    bayesianMaxInitial: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.3).max(0.8))
      .default("0.5"),
    bayesianCoolingPeriodDays: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(30))
      .default("7"),
    bayesianCoolingMinObservations: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(3).max(50))
      .default("10"),
    bayesianCoolingMaxFailures: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(2).max(10))
      .default("3"),
    bayesianPromotionMinObservations: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(10).max(100))
      .default("25"),
    bayesianVerdictCleanSuccess: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.5).max(1.0))
      .default("0.9"),
    bayesianVerdictRetrySuccess: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.3).max(0.8))
      .default("0.6"),
    bayesianVerdictFailure: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.0).max(0.5))
      .default("0.2"),

    // Learning Pipeline v2
    stradaConfidenceWeights: z
      .string()
      .transform((s) => {
        try { return JSON.parse(s) as number[]; }
        catch { return [0.15, 0.25, 0.15, 0.30, 0.15]; }
      })
      .pipe(z.array(z.number()).length(5))
      .default("[0.15, 0.25, 0.15, 0.30, 0.15]"),
    stradaMaxInstincts: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(10).max(100000))
      .default("1000"),
    stradaDetectionWindowSize: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(5).max(200))
      .default("20"),
    stradaPeriodicExtractionInterval: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(10000).max(3600000))
      .default("300000"),

    // Goal Decomposition
    goalMaxDepth: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(5))
      .default("3"),

    // Goal Execution Policy
    goalMaxRetries: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0).max(5))
      .default("1"),
    goalMaxFailures: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(20))
      .default("3"),
    goalParallelExecution: boolFromString(true),
    goalMaxParallel: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(10))
      .default("3"),

    // Goal Interactive Execution (Phase 16)
    stradaGoalEscalationTimeoutMinutes: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(120))
      .default("10"),
    stradaGoalMaxRedecompositions: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0).max(10))
      .default("2"),

    // Tool Chain Synthesis
    toolChainEnabled: boolFromString(true),
    toolChainMinOccurrences: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(2).max(20))
      .default("3"),
    toolChainSuccessRateThreshold: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.5).max(1.0))
      .default("0.8"),
    toolChainMaxActive: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(50))
      .default("10"),
    toolChainMaxAgeDays: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(365))
      .default("30"),
    toolChainLlmBudgetPerCycle: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(20))
      .default("3"),
    toolChainMinChainLength: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(2).max(5))
      .default("2"),
    toolChainMaxChainLength: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(3).max(10))
      .default("5"),
    toolChainDetectionIntervalMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(60000).max(3600000))
      .default("300000"),

    // Chain Resilience (Phase 22)
    chainRollbackEnabled: boolFromString(false),
    chainParallelEnabled: boolFromString(false),
    chainMaxParallelBranches: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(10))
      .default("4"),
    chainCompensationTimeoutMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1000).max(300000))
      .default("30000"),

    // Cross-Session Learning
    crossSessionEnabled: boolFromString(true),
    crossSessionMaxAgeDays: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(365))
      .default("90"),
    crossSessionScopeFilter: z
      .enum(["project-only", "project+universal", "all"])
      .default("project+universal"),
    crossSessionRecencyBoost: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.5).max(3.0))
      .default("1.0"),
    crossSessionScopeBoost: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.5).max(3.0))
      .default("1.1"),
    crossSessionPromotionThreshold: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(2).max(10))
      .default("3"),

    // Identity
    agentName: z.string().default("Strada Brain"),

    // Language Preference
    language: z.enum(["en", "tr", "ja", "ko", "zh", "de", "es", "fr"]).default("en"),

    // Daemon
    daemonIntervalMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(10000).max(300000))
      .default("60000"),
    daemonTimezone: z.string().default(""),
    daemonHeartbeatFile: z.string().default("./HEARTBEAT.md"),
    daemonDailyBudget: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.01).max(1000))
      .optional(),
    daemonBudgetWarnPct: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.1).max(0.99))
      .default("0.8"),
    daemonApprovalTimeoutMin: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(1440))
      .default("30"),
    daemonAutoApproveTools: z
      .string()
      .transform((s) =>
        s
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      )
      .default(""),
    daemonBackoffBase: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(10000).max(600000))
      .default("60000"),
    daemonBackoffMax: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(60000).max(86400000))
      .default("3600000"),
    daemonFailureThreshold: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(20))
      .default("3"),
    daemonIdlePause: boolFromString(false),

    // Daemon Triggers (Phase 15)
    webhookSecret: z.string().optional(),
    webhookRateLimit: z.string().default("10/min"),
    daemonDedupWindowMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0).max(3600000))
      .default("300000"),
    daemonDefaultDebounceMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(100).max(60000))
      .default("500"),
    checklistMorningHour: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0).max(23))
      .default("9"),
    checklistAfternoonHour: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0).max(23))
      .default("14"),
    checklistEveningHour: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0).max(23))
      .default("18"),

    // Trigger Fire History Pruning (Phase 21)
    triggerFireRetentionDays: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(365))
      .default("30"),

    // Notification, Quiet Hours, Digest (Phase 18)
    stradaDigestEnabled: boolFromString(true),
    stradaDigestSchedule: z.string().default("0 9 * * *"),
    stradaNotifyMinLevel: z.enum(["silent", "low", "medium", "high", "critical"]).default("low"),
    stradaNotifySilent: z.string().default("dashboard"),
    stradaNotifyLow: z.string().default("dashboard"),
    stradaNotifyMedium: z.string().default("dashboard"),
    stradaNotifyHigh: z.string().default("chat,dashboard"),
    stradaNotifyCritical: z.string().default("chat,dashboard"),
    stradaQuietStart: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0).max(23))
      .optional(),
    stradaQuietEnd: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0).max(23))
      .default("8"),
    stradaQuietBufferMax: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(10).max(10000))
      .default("100"),
    stradaDashboardHistoryDepth: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(1000))
      .default("10"),

    // Memory Re-Retrieval (Phase 17)
    stradaMemoryReRetrievalEnabled: boolFromString(true),
    stradaMemoryReRetrievalInterval: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(100))
      .default("5"),
    stradaMemoryTopicShiftEnabled: boolFromString(true),
    stradaMemoryTopicShiftThreshold: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0.1).max(1.0))
      .default("0.4"),
    stradaMemoryMaxReRetrievals: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(100))
      .default("10"),
    stradaMemoryReRetrievalTimeoutMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(100).max(60000))
      .default("5000"),
    stradaMemoryReRetrievalMemoryLimit: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(50))
      .default("3"),
    stradaMemoryReRetrievalRagTopK: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(50))
      .default("6"),

    // Multi-Agent (Phase 23)
    multiAgentEnabled: boolFromString(false),
    agentDefaultBudgetUsd: z
      .string()
      .transform(parseFloat)
      .pipe(z.number().min(0.01).max(100))
      .default("5.00"),
    agentMaxConcurrent: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(10))
      .default("3"),
    agentIdleTimeoutMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(60000))
      .default("3600000"),
    agentMaxMemoryEntries: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(100))
      .default("5000"),

    // Task Delegation (Phase 24)
    taskDelegationEnabled: boolFromString(false),
    agentMaxDelegationDepth: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(5))
      .default("2"),
    agentMaxConcurrentDelegations: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(10))
      .default("3"),
    delegationTierLocal: z.string().default("ollama:llama3.3"),
    delegationTierCheap: z.string().default("deepseek:deepseek-chat"),
    delegationTierStandard: z.string().default("claude:claude-sonnet-4-6-20250514"),
    delegationTierPremium: z.string().default("claude:claude-opus-4-6-20250514"),
    delegationVerbosity: z.enum(["quiet", "normal", "verbose"]).default("normal"),
    delegationTypes: z.string().optional(),

    // Deployment (Phase 25)
    deployEnabled: boolFromString(false),
    deployScriptPath: z.string().optional(),
    deployTestCommand: z.string().default("npm test"),
    deployTargetBranch: z.string().default("main"),
    deployRequireCleanGit: boolFromString(true),
    deployTestTimeoutMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(10000).max(600000))
      .default("300000"),
    deployExecutionTimeoutMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(30000).max(1800000))
      .default("600000"),
    deployCooldownMinutes: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(1440))
      .default("30"),
    deployNotificationUrgency: z.enum(["low", "medium", "high", "critical"]).default("high"),
    deployPostScriptPath: z.string().optional(),
    deployRollbackScriptPath: z.string().optional(),

    // Autonomous Mode
    autonomousDefaultEnabled: boolFromString(false),
    autonomousDefaultHours: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(168))
      .default("24"),

    // Conformance Guard
    conformanceEnabled: boolFromString(true),
    conformanceFrameworkPathsOnly: boolFromString(true),
    // Control Loop
    loopFingerprintThreshold: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(100))
      .default("3"),
    loopFingerprintWindow: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(200))
      .default("20"),
    loopDensityThreshold: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(100))
      .default("5"),
    loopDensityWindow: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(200))
      .default("30"),
    loopMaxRecoveryEpisodes: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(50))
      .default("5"),
    loopStaleAnalysisThreshold: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(20))
      .default("3"),
    loopHardCapReplan: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(2).max(20))
      .default("5"),
    loopHardCapBlock: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(3).max(30))
      .default("8"),
    progressAssessmentEnabled: boolFromString(true),
    // Daemon Full Autonomy
    daemonFullAutonomy: boolFromString(false),

    // Interaction Policy
    interactionMode: z.enum(["silent-first", "standard", "phase-driven"]).default("phase-driven"),
    interactionHeartbeatAfterMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0).max(86_400_000))
      .default("120000"),
    interactionHeartbeatIntervalMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1000).max(86_400_000))
      .default("300000"),
    interactionEscalationPolicy: z
      .enum(["hard-blockers-only", "standard"])
      .default("hard-blockers-only"),

    // Tasks
    taskMaxConcurrent: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(10))
      .default("3"),
    taskMessageBurstWindowMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0).max(5000))
      .default("350"),
    taskMessageBurstMaxMessages: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(20))
      .default("8"),
    taskInteractiveMaxIterations: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(10_000))
      .default("25"),
    taskInteractiveTokenBudget: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(10_000).max(10_000_000))
      .default("500000"),
    taskBackgroundEpochMaxIterations: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(10_000))
      .default("50"),
    taskBackgroundAutoContinue: boolFromString(true),
    taskBackgroundMaxEpochs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0).max(1_000_000))
      .default("3"),

    // Provider Routing
    routingPreset: z.enum(["budget", "balanced", "performance"]).default("balanced"),
    routingPhaseSwitching: boolFromString(true),

    // Consensus
    consensusMode: z.enum(["auto", "critical-only", "always", "disabled"]).default("auto"),
    consensusThreshold: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0).max(1))
      .default("0.5"),
    consensusMaxProviders: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(5))
      .default("3"),

    // Auto-Update
    autoUpdateEnabled: boolFromString(true),
    autoUpdateIntervalHours: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().positive())
      .default("6"),
    autoUpdateIdleTimeoutMin: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().positive())
      .default("5"),
    autoUpdateChannel: z.enum(["stable", "latest"]).default("latest"),
    autoUpdateNotify: boolFromString(true),
    autoUpdateAutoRestart: boolFromString(true),

    // Supervisor Brain
    stradaSupervisorEnabled: boolFromString(true),
    stradaSupervisorComplexityThreshold: z
      .enum(["moderate", "complex"])
      .default("complex"),
    stradaSupervisorMaxParallelNodes: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(16))
      .default("4"),
    stradaSupervisorNodeTimeoutMs: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(10000).max(7_200_000))
      .default("3600000"),
    stradaSupervisorVerificationMode: z
      .enum(["always", "critical-only", "sampling", "disabled"])
      .default("critical-only"),
    stradaSupervisorVerificationBudgetPct: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0).max(50))
      .default("15"),
    stradaSupervisorTriageProvider: z
      .string()
      .default("groq"),
    stradaSupervisorMaxFailureBudget: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(0).max(20))
      .default("3"),
    stradaSupervisorDiversityCap: z
      .string()
      .transform((s) => parseFloat(s))
      .pipe(z.number().min(0).max(1))
      .default("0.6"),
  })
  .superRefine((data, ctx) => {
    // Bayesian threshold ordering validation: deprecated < active < evolution < autoEvolve
    if (data.bayesianDeprecatedThreshold >= data.bayesianActiveThreshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "BAYESIAN_DEPRECATED_THRESHOLD must be less than BAYESIAN_ACTIVE_THRESHOLD",
        path: ["bayesianDeprecatedThreshold"],
      });
    }
    if (data.bayesianActiveThreshold >= data.bayesianEvolutionThreshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "BAYESIAN_ACTIVE_THRESHOLD must be less than BAYESIAN_EVOLUTION_THRESHOLD",
        path: ["bayesianActiveThreshold"],
      });
    }
    if (data.bayesianEvolutionThreshold >= data.bayesianAutoEvolveThreshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "BAYESIAN_EVOLUTION_THRESHOLD must be less than BAYESIAN_AUTO_EVOLVE_THRESHOLD",
        path: ["bayesianEvolutionThreshold"],
      });
    }
    if (data.bayesianMaxInitial > data.bayesianActiveThreshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "BAYESIAN_MAX_INITIAL must not exceed BAYESIAN_ACTIVE_THRESHOLD",
        path: ["bayesianMaxInitial"],
      });
    }
    // At least one AI provider key must be present, or ollama must be in the chain
    const hasAnyKey = [
      data.anthropicApiKey,
      data.openaiApiKey,
      data.deepseekApiKey,
      data.qwenApiKey,
      data.kimiApiKey,
      data.minimaxApiKey,
      data.groqApiKey,
      data.mistralApiKey,
      data.togetherApiKey,
      data.fireworksApiKey,
      data.geminiApiKey,
      data.opencodeApiKey,
      data.openrouterApiKey,
    ].some((k) => k && k.length > 0);
    const hasAnthropicSubscription =
      data.anthropicAuthMode === "claude-subscription"
      && Boolean(data.anthropicAuthToken);
    const hasOpenAISubscription =
      data.openaiAuthMode === "chatgpt-subscription" ||
      Boolean(data.openaiSubscriptionAccessToken && data.openaiSubscriptionAccountId) ||
      Boolean(data.openaiChatgptAuthFile);

    const hasOllama = data.providerChain?.includes("ollama") ?? false;

    if (data.anthropicAuthMode === "claude-subscription" && !data.anthropicAuthToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ANTHROPIC_AUTH_TOKEN is required when ANTHROPIC_AUTH_MODE=claude-subscription",
        path: ["anthropicAuthToken"],
      });
    }

    if (!hasAnyKey && !hasAnthropicSubscription && !hasOpenAISubscription && !hasOllama) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one AI provider API key is required (or use Ollama)",
        path: ["anthropicApiKey"],
      });
    }
  });

/** Raw config type from Zod */
export type RawConfig = z.infer<typeof configSchema>;
