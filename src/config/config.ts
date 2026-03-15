/**
 * Type-safe Configuration for Strada.Brain
 *
 * Provides:
 * - Deep partial types
 * - Config validators
 * - Environment type mapping
 * - Zod schema integration
 */

import { realpathSync, statSync } from "node:fs";
import { z } from "zod";
import * as dotenv from "dotenv";
import type { SecretPattern } from "../security/secret-sanitizer.js";
import type { DeepPartial, Result, ValidationResult, ValidationError } from "../types/index.js";
import type { BayesianConfig, CrossSessionConfig } from "../learning/types.js";
import type { ToolChainConfig } from "../learning/chains/index.js";
import type { DaemonConfig } from "../daemon/daemon-types.js";
import type { NotificationConfig, QuietHoursConfig, DigestConfig } from "../daemon/reporting/notification-types.js";
import type { AgentConfig } from "../agents/multi/agent-types.js";
import type { DelegationConfig } from "../agents/multi/delegation/delegation-types.js";
import type { DeploymentConfig } from "../daemon/deployment/deployment-types.js";
import { getPreset } from "./presets.js";

dotenv.config();

// =============================================================================
// ENVIRONMENT VARIABLE TYPES
// =============================================================================

/** Environment variable names used by the application */
export type EnvVarName =
  | "ANTHROPIC_API_KEY"
  | "OPENAI_API_KEY"
  | "DEEPSEEK_API_KEY"
  | "QWEN_API_KEY"
  | "KIMI_API_KEY"
  | "MINIMAX_API_KEY"
  | "GROQ_API_KEY"
  | "MISTRAL_API_KEY"
  | "TOGETHER_API_KEY"
  | "FIREWORKS_API_KEY"
  | "GEMINI_API_KEY"
  | "SYSTEM_PRESET"
  | "PROVIDER_CHAIN"
  | "TELEGRAM_BOT_TOKEN"
  | "DISCORD_BOT_TOKEN"
  | "DISCORD_GUILD_ID"
  | "SLACK_BOT_TOKEN"
  | "SLACK_SIGNING_SECRET"
  | "SLACK_APP_TOKEN"
  | "SLACK_SOCKET_MODE"
  | "ALLOWED_SLACK_WORKSPACES"
  | "ALLOWED_SLACK_USER_IDS"
  | "ALLOWED_TELEGRAM_USER_IDS"
  | "REQUIRE_EDIT_CONFIRMATION"
  | "READ_ONLY_MODE"
  | "UNITY_PROJECT_PATH"
  | "DASHBOARD_ENABLED"
  | "DASHBOARD_PORT"
  | "ENABLE_WEBSOCKET_DASHBOARD"
  | "WEBSOCKET_DASHBOARD_PORT"
  | "WEBSOCKET_DASHBOARD_AUTH_TOKEN"
  | "WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS"
  | "ENABLE_PROMETHEUS"
  | "PROMETHEUS_PORT"
  | "MEMORY_ENABLED"
  | "MEMORY_DB_PATH"
  | "MEMORY_BACKEND"
  | "MEMORY_DIMENSIONS"
  | "MEMORY_AUTO_TIERING"
  | "MEMORY_AUTO_TIERING_INTERVAL_MS"
  | "MEMORY_PROMOTION_THRESHOLD"
  | "MEMORY_DEMOTION_TIMEOUT_DAYS"
  | "MEMORY_TIER_WORKING_MAX"
  | "MEMORY_TIER_EPHEMERAL_MAX"
  | "MEMORY_TIER_PERSISTENT_MAX"
  | "MEMORY_EPHEMERAL_TTL_HOURS"
  | "RAG_ENABLED"
  | "EMBEDDING_PROVIDER"
  | "EMBEDDING_MODEL"
  | "EMBEDDING_BASE_URL"
  | "EMBEDDING_DIMENSIONS"
  | "RAG_CONTEXT_MAX_TOKENS"
  | "STREAMING_ENABLED"
  | "RATE_LIMIT_ENABLED"
  | "RATE_LIMIT_MESSAGES_PER_MINUTE"
  | "RATE_LIMIT_MESSAGES_PER_HOUR"
  | "RATE_LIMIT_TOKENS_PER_DAY"
  | "RATE_LIMIT_DAILY_BUDGET_USD"
  | "RATE_LIMIT_MONTHLY_BUDGET_USD"
  | "SHELL_ENABLED"
  | "LOG_LEVEL"
  | "LOG_FILE"
  | "PLUGIN_DIRS"
  | "OPENAI_MODEL" | "DEEPSEEK_MODEL" | "QWEN_MODEL" | "KIMI_MODEL"
  | "MINIMAX_MODEL" | "GROQ_MODEL" | "MISTRAL_MODEL" | "TOGETHER_MODEL"
  | "FIREWORKS_MODEL" | "GEMINI_MODEL" | "CLAUDE_MODEL" | "OLLAMA_MODEL"
  | "BAYESIAN_ENABLED" | "BAYESIAN_DEPRECATED_THRESHOLD" | "BAYESIAN_ACTIVE_THRESHOLD"
  | "BAYESIAN_EVOLUTION_THRESHOLD" | "BAYESIAN_AUTO_EVOLVE_THRESHOLD" | "BAYESIAN_MAX_INITIAL"
  | "BAYESIAN_COOLING_PERIOD_DAYS" | "BAYESIAN_COOLING_MIN_OBSERVATIONS"
  | "BAYESIAN_COOLING_MAX_FAILURES" | "BAYESIAN_PROMOTION_MIN_OBSERVATIONS"
  | "BAYESIAN_VERDICT_CLEAN_SUCCESS" | "BAYESIAN_VERDICT_RETRY_SUCCESS" | "BAYESIAN_VERDICT_FAILURE"
  | "GOAL_MAX_DEPTH"
  | "GOAL_MAX_RETRIES"
  | "GOAL_MAX_FAILURES"
  | "GOAL_PARALLEL_EXECUTION"
  | "GOAL_MAX_PARALLEL"
  | "STRADA_AGENT_NAME"
  | "STRADA_CROSS_SESSION_ENABLED"
  | "STRADA_INSTINCT_MAX_AGE_DAYS"
  | "STRADA_INSTINCT_SCOPE_FILTER"
  | "STRADA_INSTINCT_RECENCY_BOOST"
  | "STRADA_INSTINCT_SCOPE_BOOST"
  | "STRADA_INSTINCT_PROMOTION_THRESHOLD"
  | "STRADA_DAEMON_INTERVAL_MS"
  | "STRADA_DAEMON_TIMEZONE"
  | "STRADA_DAEMON_HEARTBEAT_FILE"
  | "STRADA_DAEMON_DAILY_BUDGET"
  | "STRADA_DAEMON_BUDGET_WARN_PCT"
  | "STRADA_DAEMON_APPROVAL_TIMEOUT_MINUTES"
  | "STRADA_DAEMON_AUTO_APPROVE_TOOLS"
  | "STRADA_DAEMON_BACKOFF_BASE"
  | "STRADA_DAEMON_BACKOFF_MAX"
  | "STRADA_DAEMON_FAILURE_THRESHOLD"
  | "STRADA_DAEMON_IDLE_PAUSE"
  | "STRADA_WEBHOOK_SECRET"
  | "STRADA_WEBHOOK_RATE_LIMIT"
  | "STRADA_DAEMON_DEDUP_WINDOW_MS"
  | "STRADA_DAEMON_DEFAULT_DEBOUNCE_MS"
  | "STRADA_CHECKLIST_MORNING_HOUR"
  | "STRADA_CHECKLIST_AFTERNOON_HOUR"
  | "STRADA_CHECKLIST_EVENING_HOUR"

  | "STRADA_GOAL_ESCALATION_TIMEOUT_MINUTES"
  | "STRADA_GOAL_MAX_REDECOMPOSITIONS"

  // Notification, Quiet Hours, Digest (Phase 18)
  | "STRADA_DIGEST_ENABLED"
  | "STRADA_DIGEST_SCHEDULE"
  | "STRADA_NOTIFY_MIN_LEVEL"
  | "STRADA_NOTIFY_SILENT"
  | "STRADA_NOTIFY_LOW"
  | "STRADA_NOTIFY_MEDIUM"
  | "STRADA_NOTIFY_HIGH"
  | "STRADA_NOTIFY_CRITICAL"
  | "STRADA_QUIET_START"
  | "STRADA_QUIET_END"
  | "STRADA_QUIET_BUFFER_MAX"
  | "STRADA_DASHBOARD_HISTORY_DEPTH"

  // Memory Re-Retrieval (Phase 17)
  | "STRADA_MEMORY_RERETRIEVAL_ENABLED"
  | "STRADA_MEMORY_RERETRIEVAL_INTERVAL"
  | "STRADA_MEMORY_TOPIC_SHIFT_ENABLED"
  | "STRADA_MEMORY_TOPIC_SHIFT_THRESHOLD"
  | "STRADA_MEMORY_MAX_RERETRIEVALS"
  | "STRADA_MEMORY_RERETRIEVAL_TIMEOUT_MS"
  | "STRADA_MEMORY_RERETRIEVAL_MEMORY_LIMIT"
  | "STRADA_MEMORY_RERETRIEVAL_RAG_TOPK"

  // Memory Decay (Phase 21)
  | "MEMORY_DECAY_ENABLED"
  | "MEMORY_DECAY_LAMBDA_WORKING"
  | "MEMORY_DECAY_LAMBDA_EPHEMERAL"
  | "MEMORY_DECAY_LAMBDA_PERSISTENT"
  | "MEMORY_DECAY_EXEMPT_DOMAINS"
  | "MEMORY_DECAY_TIMEOUT_MS"
  // Trigger Fire History Pruning (Phase 21)
  | "TRIGGER_FIRE_RETENTION_DAYS"

  // Chain Resilience (Phase 22)
  | "CHAIN_ROLLBACK_ENABLED"
  | "CHAIN_PARALLEL_ENABLED"
  | "CHAIN_MAX_PARALLEL_BRANCHES"
  | "CHAIN_COMPENSATION_TIMEOUT_MS"

  // Multi-Agent (Phase 23)
  | "MULTI_AGENT_ENABLED"
  | "AGENT_DEFAULT_BUDGET_USD"
  | "AGENT_MAX_CONCURRENT"
  | "AGENT_IDLE_TIMEOUT_MS"
  | "AGENT_MAX_MEMORY_ENTRIES"

  // Task Delegation (Phase 24)
  | "TASK_DELEGATION_ENABLED"
  | "AGENT_MAX_DELEGATION_DEPTH"
  | "AGENT_MAX_CONCURRENT_DELEGATIONS"
  | "DELEGATION_TIER_LOCAL"
  | "DELEGATION_TIER_CHEAP"
  | "DELEGATION_TIER_STANDARD"
  | "DELEGATION_TIER_PREMIUM"
  | "DELEGATION_VERBOSITY"
  | "DELEGATION_TYPES"
  | "DELEGATION_MAX_ITERATIONS_PER_TYPE"

  // Memory Consolidation (Phase 25)
  | "MEMORY_CONSOLIDATION_ENABLED"
  | "MEMORY_CONSOLIDATION_IDLE_MINUTES"
  | "MEMORY_CONSOLIDATION_THRESHOLD"
  | "MEMORY_CONSOLIDATION_BATCH_SIZE"
  | "MEMORY_CONSOLIDATION_MIN_CLUSTER_SIZE"
  | "MEMORY_CONSOLIDATION_MAX_DEPTH"
  | "MEMORY_CONSOLIDATION_MODEL_TIER"

  // Deployment (Phase 25)
  | "DEPLOY_ENABLED"
  | "DEPLOY_SCRIPT_PATH"
  | "DEPLOY_TEST_COMMAND"
  | "DEPLOY_TARGET_BRANCH"
  | "DEPLOY_REQUIRE_CLEAN_GIT"
  | "DEPLOY_TEST_TIMEOUT_MS"
  | "DEPLOY_EXECUTION_TIMEOUT_MS"
  | "DEPLOY_COOLDOWN_MINUTES"
  | "DEPLOY_NOTIFICATION_URGENCY"
  | "DEPLOY_POST_SCRIPT_PATH"

  // Language Preference
  | "LANGUAGE_PREFERENCE"

  // Autonomous Mode
  | "AUTONOMOUS_DEFAULT_HOURS";

/** Environment variable map type */
export type EnvVarMap = Record<EnvVarName, string | undefined>;

// =============================================================================
// CONFIG VALUE TYPES
// =============================================================================

/** Log level options */
export type LogLevel = "error" | "warn" | "info" | "debug";

/** Embedding provider options */
export type EmbeddingProvider =
  | "auto"
  | "openai"
  | "deepseek"
  | "mistral"
  | "together"
  | "fireworks"
  | "qwen"
  | "gemini"
  | "ollama";

/** AI provider names */
export type AIProviderName =
  | "claude"
  | "openai"
  | "deepseek"
  | "qwen"
  | "kimi"
  | "minimax"
  | "groq"
  | "mistral"
  | "together"
  | "fireworks"
  | "gemini"
  | "ollama";

/** Goal interactive execution configuration (Phase 16) */
export interface GoalConfig {
  readonly maxFailures: number;
  readonly escalationTimeoutMinutes: number;
  readonly maxRedecompositions: number;
}

/** Memory re-retrieval configuration (Phase 17) */
export interface ReRetrievalConfig {
  readonly enabled: boolean;
  readonly interval: number;
  readonly topicShiftEnabled: boolean;
  readonly topicShiftThreshold: number;
  readonly maxReRetrievals: number;
  readonly timeoutMs: number;
  readonly memoryLimit: number;
  readonly ragTopK: number;
}

/** Rate limit configuration */
export interface RateLimitConfig {
  readonly enabled: boolean;
  readonly messagesPerMinute: number;
  readonly messagesPerHour: number;
  readonly tokensPerDay: number;
  readonly dailyBudgetUsd: number;
  readonly monthlyBudgetUsd: number;
}

/** Memory backend type */
export type MemoryBackend = "agentdb" | "file";

/** Memory configuration */
export interface MemoryConfig {
  readonly enabled: boolean;
  readonly dbPath: string;
  readonly backend: MemoryBackend;
  readonly unified: {
    readonly dimensions: number;
    readonly autoTiering: boolean;
    readonly autoTieringIntervalMs: number;
    readonly promotionThreshold: number;
    readonly demotionTimeoutDays: number;
    readonly tierLimits: {
      readonly working: number;
      readonly ephemeral: number;
      readonly persistent: number;
    };
    readonly ephemeralTtlHours: number;
  };
  readonly decay: {
    readonly enabled: boolean;
    readonly lambdas: {
      readonly working: number;
      readonly ephemeral: number;
      readonly persistent: number;
    };
    readonly exemptDomains: string[];
    readonly timeoutMs: number;
  };
  readonly consolidation: {
    readonly enabled: boolean;
    readonly idleMinutes: number;
    readonly threshold: number;
    readonly batchSize: number;
    readonly minClusterSize: number;
    readonly maxDepth: number;
    readonly modelTier: string;
  };
}

/** RAG configuration */
export interface RAGConfig {
  readonly enabled: boolean;
  readonly provider: EmbeddingProvider;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly dimensions?: number;
  readonly contextMaxTokens: number;
}

/** Dashboard configuration */
export interface DashboardConfig {
  readonly enabled: boolean;
  readonly port: number;
}

/** Prometheus configuration */
export interface PrometheusConfig {
  readonly enabled: boolean;
  readonly port: number;
}

/** WebSocket dashboard configuration */
export interface WebSocketDashboardConfig {
  readonly enabled: boolean;
  readonly port: number;
  readonly authToken?: string;
  readonly allowedOrigins?: string[];
}

/** Slack configuration */
export interface SlackConfig {
  readonly botToken?: string;
  readonly signingSecret?: string;
  readonly appToken?: string;
  readonly socketMode: boolean;
  readonly allowedWorkspaces?: string[];
  readonly allowedUserIds?: string[];
}

/** Discord configuration */
export interface DiscordConfig {
  readonly botToken?: string;
  readonly guildId?: string;
}

/** Telegram configuration */
export interface TelegramConfig {
  readonly botToken?: string;
  readonly allowedUserIds: number[];
}

/** Security configuration */
export interface SecurityConfig {
  readonly requireEditConfirmation: boolean;
  readonly readOnlyMode: boolean;
}

// =============================================================================
// MAIN CONFIG TYPE
// =============================================================================

/** Complete application configuration */
export interface Config {
  // AI Providers
  readonly anthropicApiKey?: string;
  readonly openaiApiKey?: string;
  readonly deepseekApiKey?: string;
  readonly qwenApiKey?: string;
  readonly kimiApiKey?: string;
  readonly minimaxApiKey?: string;
  readonly groqApiKey?: string;
  readonly mistralApiKey?: string;
  readonly togetherApiKey?: string;
  readonly fireworksApiKey?: string;
  readonly geminiApiKey?: string;
  /** Comma-separated provider names for fallback chain */
  readonly providerChain?: string;
  /** Per-provider model overrides (env: {PROVIDER}_MODEL) */
  readonly providerModels?: Record<string, string>;

  // Channels
  readonly telegram: TelegramConfig;
  readonly discord: DiscordConfig;
  readonly slack: SlackConfig;

  // Security
  readonly security: SecurityConfig;

  // Project
  readonly unityProjectPath: string;

  // Dashboard
  readonly dashboard: DashboardConfig;
  readonly websocketDashboard: WebSocketDashboardConfig;
  readonly prometheus: PrometheusConfig;

  // Memory
  readonly memory: MemoryConfig;

  // RAG
  readonly rag: RAGConfig;

  // Features
  readonly streamingEnabled: boolean;
  readonly shellEnabled: boolean;

  // Rate Limiting
  readonly rateLimit: RateLimitConfig;

  // Web Channel
  readonly web: { readonly port: number };

  // Logging
  readonly logLevel: LogLevel;
  readonly logFile: string;

  // Plugins
  readonly pluginDirs: string[];

  // Bayesian Confidence System
  readonly bayesian: BayesianConfig;

  // Goal Decomposition
  readonly goalMaxDepth: number;

  // Goal Execution Policy
  readonly goalMaxRetries: number;
  readonly goalMaxFailures: number;
  readonly goalParallelExecution: boolean;
  readonly goalMaxParallel: number;

  // Goal Interactive Execution (Phase 16)
  readonly goal: GoalConfig;

  // Tool Chain Synthesis
  readonly toolChain: ToolChainConfig;

  // Cross-Session Learning
  readonly crossSession: CrossSessionConfig;

  // Identity
  readonly agentName: string;

  // Language Preference
  readonly language: "en" | "tr" | "ja" | "ko" | "zh" | "de" | "es" | "fr";

  // Daemon
  readonly daemon: DaemonConfig;

  // Memory Re-Retrieval (Phase 17)
  readonly reRetrieval: ReRetrievalConfig;

  // Notification Routing (Phase 18)
  readonly notification: NotificationConfig;

  // Quiet Hours (Phase 18)
  readonly quietHours: QuietHoursConfig;

  // Digest Reporting (Phase 18)
  readonly digest: DigestConfig;

  // Multi-Agent (Phase 23)
  readonly agent: AgentConfig;

  // Task Delegation (Phase 24)
  readonly delegation: DelegationConfig;

  // Deployment (Phase 25)
  readonly deployment: DeploymentConfig;

  // Autonomous Mode
  /** Default duration in hours for autonomous mode when no duration is specified */
  readonly autonomousDefaultHours: number;
}

/** Partial config for updates */
export type PartialConfig = DeepPartial<Config>;

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

/** Log level schema */
const logLevelSchema = z.enum(["error", "warn", "info", "debug"]);

/** Embedding provider schema */
const embeddingProviderSchema = z.enum([
  "auto", "openai", "deepseek", "mistral", "together",
  "fireworks", "qwen", "gemini", "ollama",
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
    .transform((s) => s === "true")
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
  .transform((s) => s.split(",").map((id) => parseInt(id.trim(), 10)))
  .pipe(z.array(z.number().int()))
  .optional();

/** Config schema for validation */
export const configSchema = z
  .object({
    // AI Providers
    anthropicApiKey: z.string().optional(),
    openaiApiKey: z.string().optional(),
    deepseekApiKey: z.string().optional(),
    qwenApiKey: z.string().optional(),
    kimiApiKey: z.string().optional(),
    minimaxApiKey: z.string().optional(),
    groqApiKey: z.string().optional(),
    mistralApiKey: z.string().optional(),
    togetherApiKey: z.string().optional(),
    fireworksApiKey: z.string().optional(),
    geminiApiKey: z.string().optional(),
    providerChain: z.string().optional(),

    // Telegram
    telegramBotToken: z.string().optional(),
    allowedTelegramUserIds: commaSeparatedNumberList,

    // Discord
    discordBotToken: z.string().optional(),
    discordGuildId: z.string().optional(),

    // Slack
    slackBotToken: z.string().optional(),
    slackSigningSecret: z.string().optional(),
    slackAppToken: z.string().optional(),
    slackSocketMode: boolFromString(true),
    allowedSlackWorkspaces: commaSeparatedList,
    allowedSlackUserIds: commaSeparatedList,

    // Security
    requireEditConfirmation: boolFromString(true),
    readOnlyMode: boolFromString(false),

    // Project
    unityProjectPath: z.string().min(1, "UNITY_PROJECT_PATH is required"),

    // Dashboard
    dashboardEnabled: boolFromString(false),
    dashboardPort: portSchema.default("3100"),

    // WebSocket Dashboard
    websocketDashboardEnabled: boolFromString(false),
    websocketDashboardPort: portSchema.default("3100"),
    websocketDashboardAuthToken: z.string().optional(),
    websocketDashboardAllowedOrigins: commaSeparatedList.optional(),

    // Prometheus
    prometheusEnabled: boolFromString(false),
    prometheusPort: portSchema.default("9090"),

    // Memory
    memoryEnabled: boolFromString(true),
    memoryDbPath: z.string().refine((p) => !p.includes(".."), { message: "Path must not contain '..' (path traversal)" }).default(".strada-memory"),
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
    memoryDecayLambdaWorking: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.001).max(1.0)).default("0.10"),
    memoryDecayLambdaEphemeral: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.001).max(1.0)).default("0.05"),
    memoryDecayLambdaPersistent: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.001).max(1.0)).default("0.01"),
    memoryDecayExemptDomains: z.string().default("instinct,analysis-cache"),
    memoryDecayTimeoutMs: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1000).max(300000)).default("30000"),

    // Memory Consolidation (Phase 25)
    memoryConsolidationEnabled: boolFromString(true),
    memoryConsolidationIdleMinutes: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(1440)).default("5"),
    memoryConsolidationThreshold: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.5).max(0.99)).default("0.85"),
    memoryConsolidationBatchSize: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(5).max(200)).default("50"),
    memoryConsolidationMinClusterSize: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(2).max(20)).default("2"),
    memoryConsolidationMaxDepth: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(10)).default("3"),
    memoryConsolidationModelTier: z.enum(["local", "cheap", "standard", "premium"]).default("cheap"),

    // RAG
    ragEnabled: boolFromString(true),
    embeddingProvider: embeddingProviderSchema.default("auto"),
    embeddingModel: z.string().optional(),
    embeddingBaseUrl: z.string().optional(),
    embeddingDimensions: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(128).max(3072)).optional(),
    ragContextMaxTokens: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(500).max(16000))
      .default("4000"),

    // Features
    streamingEnabled: boolFromString(true),
    shellEnabled: boolFromString(true),

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

    // Logging
    logLevel: logLevelSchema.default("info"),
    logFile: z.string().default("strada-brain.log"),

    // Web Channel
    webChannelPort: portSchema.default("3000"),

    // Plugins
    pluginDirs: commaSeparatedList.transform((arr) => arr ?? []),

    // Bayesian Confidence System
    bayesianEnabled: boolFromString(true),
    bayesianDeprecatedThreshold: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.1).max(0.5)).default("0.3"),
    bayesianActiveThreshold: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.5).max(0.9)).default("0.7"),
    bayesianEvolutionThreshold: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.8).max(0.99)).default("0.9"),
    bayesianAutoEvolveThreshold: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.9).max(1.0)).default("0.95"),
    bayesianMaxInitial: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.3).max(0.8)).default("0.5"),
    bayesianCoolingPeriodDays: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(30)).default("7"),
    bayesianCoolingMinObservations: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(3).max(50)).default("10"),
    bayesianCoolingMaxFailures: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(2).max(10)).default("3"),
    bayesianPromotionMinObservations: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(10).max(100)).default("25"),
    bayesianVerdictCleanSuccess: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.5).max(1.0)).default("0.9"),
    bayesianVerdictRetrySuccess: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.3).max(0.8)).default("0.6"),
    bayesianVerdictFailure: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.0).max(0.5)).default("0.2"),

    // Goal Decomposition
    goalMaxDepth: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(5)).default("3"),

    // Goal Execution Policy
    goalMaxRetries: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(0).max(5)).default("1"),
    goalMaxFailures: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(20)).default("3"),
    goalParallelExecution: boolFromString(true),
    goalMaxParallel: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(10)).default("3"),

    // Goal Interactive Execution (Phase 16)
    stradaGoalEscalationTimeoutMinutes: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(120)).default("10"),
    stradaGoalMaxRedecompositions: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(0).max(10)).default("2"),

    // Tool Chain Synthesis
    toolChainEnabled: boolFromString(true),
    toolChainMinOccurrences: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(2).max(20)).default("3"),
    toolChainSuccessRateThreshold: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.5).max(1.0)).default("0.8"),
    toolChainMaxActive: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(50)).default("10"),
    toolChainMaxAgeDays: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(365)).default("30"),
    toolChainLlmBudgetPerCycle: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(20)).default("3"),
    toolChainMinChainLength: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(2).max(5)).default("2"),
    toolChainMaxChainLength: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(3).max(10)).default("5"),
    toolChainDetectionIntervalMs: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(60000).max(3600000)).default("300000"),

    // Chain Resilience (Phase 22)
    chainRollbackEnabled: boolFromString(false),
    chainParallelEnabled: boolFromString(false),
    chainMaxParallelBranches: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(10)).default("4"),
    chainCompensationTimeoutMs: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1000).max(300000)).default("30000"),

    // Cross-Session Learning
    crossSessionEnabled: boolFromString(true),
    crossSessionMaxAgeDays: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(365)).default("90"),
    crossSessionScopeFilter: z.enum(["project-only", "project+universal", "all"]).default("project+universal"),
    crossSessionRecencyBoost: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.5).max(3.0)).default("1.0"),
    crossSessionScopeBoost: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.5).max(3.0)).default("1.1"),
    crossSessionPromotionThreshold: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(2).max(10)).default("3"),

    // Identity
    agentName: z.string().default("Strada Brain"),

    // Language Preference
    language: z.enum(["en", "tr", "ja", "ko", "zh", "de", "es", "fr"]).default("en"),

    // Daemon
    daemonIntervalMs: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(10000).max(300000)).default("60000"),
    daemonTimezone: z.string().default(""),
    daemonHeartbeatFile: z.string().default("./HEARTBEAT.md"),
    daemonDailyBudget: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.01).max(1000)).optional(),
    daemonBudgetWarnPct: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.1).max(0.99)).default("0.8"),
    daemonApprovalTimeoutMin: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(1440)).default("30"),
    daemonAutoApproveTools: z.string().transform((s) => s.split(",").map((t) => t.trim()).filter(Boolean)).default(""),
    daemonBackoffBase: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(10000).max(600000)).default("60000"),
    daemonBackoffMax: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(60000).max(86400000)).default("3600000"),
    daemonFailureThreshold: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(20)).default("3"),
    daemonIdlePause: boolFromString(false),

    // Daemon Triggers (Phase 15)
    webhookSecret: z.string().optional(),
    webhookRateLimit: z.string().default("10/min"),
    daemonDedupWindowMs: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(0).max(3600000)).default("300000"),
    daemonDefaultDebounceMs: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(100).max(60000)).default("500"),
    checklistMorningHour: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(0).max(23)).default("9"),
    checklistAfternoonHour: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(0).max(23)).default("14"),
    checklistEveningHour: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(0).max(23)).default("18"),

    // Trigger Fire History Pruning (Phase 21)
    triggerFireRetentionDays: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(365)).default("30"),

    // Notification, Quiet Hours, Digest (Phase 18)
    stradaDigestEnabled: boolFromString(true),
    stradaDigestSchedule: z.string().default("0 9 * * *"),
    stradaNotifyMinLevel: z.enum(["silent", "low", "medium", "high", "critical"]).default("low"),
    stradaNotifySilent: z.string().default("dashboard"),
    stradaNotifyLow: z.string().default("dashboard"),
    stradaNotifyMedium: z.string().default("chat,dashboard"),
    stradaNotifyHigh: z.string().default("chat,dashboard"),
    stradaNotifyCritical: z.string().default("chat,dashboard"),
    stradaQuietStart: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(0).max(23)).optional(),
    stradaQuietEnd: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(0).max(23)).default("8"),
    stradaQuietBufferMax: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(10).max(10000)).default("100"),
    stradaDashboardHistoryDepth: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(1000)).default("10"),

    // Memory Re-Retrieval (Phase 17)
    stradaMemoryReRetrievalEnabled: boolFromString(true),
    stradaMemoryReRetrievalInterval: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(100)).default("5"),
    stradaMemoryTopicShiftEnabled: boolFromString(true),
    stradaMemoryTopicShiftThreshold: z.string().transform((s) => parseFloat(s)).pipe(z.number().min(0.1).max(1.0)).default("0.4"),
    stradaMemoryMaxReRetrievals: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(100)).default("10"),
    stradaMemoryReRetrievalTimeoutMs: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(100).max(60000)).default("5000"),
    stradaMemoryReRetrievalMemoryLimit: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(50)).default("3"),
    stradaMemoryReRetrievalRagTopK: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(50)).default("6"),

    // Multi-Agent (Phase 23)
    multiAgentEnabled: boolFromString(true),
    agentDefaultBudgetUsd: z.string().transform(parseFloat).pipe(z.number().min(0.01).max(100)).default("5.00"),
    agentMaxConcurrent: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(10)).default("3"),
    agentIdleTimeoutMs: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(60000)).default("3600000"),
    agentMaxMemoryEntries: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(100)).default("5000"),

    // Task Delegation (Phase 24)
    taskDelegationEnabled: boolFromString(false),
    agentMaxDelegationDepth: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(5)).default("2"),
    agentMaxConcurrentDelegations: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(10)).default("3"),
    delegationTierLocal: z.string().default("ollama:llama3.3"),
    delegationTierCheap: z.string().default("deepseek:deepseek-chat"),
    delegationTierStandard: z.string().default("claude:claude-sonnet-4-6-20250514"),
    delegationTierPremium: z.string().default("claude:claude-opus-4-6-20250514"),
    delegationVerbosity: z.enum(["quiet", "normal", "verbose"]).default("normal"),
    delegationTypes: z.string().optional(),
    delegationMaxIterationsPerType: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(50)).default("10"),

    // Deployment (Phase 25)
    deployEnabled: boolFromString(false),
    deployScriptPath: z.string().optional(),
    deployTestCommand: z.string().default("npm test"),
    deployTargetBranch: z.string().default("main"),
    deployRequireCleanGit: boolFromString(true),
    deployTestTimeoutMs: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(10000).max(600000)).default("300000"),
    deployExecutionTimeoutMs: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(30000).max(1800000)).default("600000"),
    deployCooldownMinutes: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(1440)).default("30"),
    deployNotificationUrgency: z.enum(["low", "medium", "high", "critical"]).default("high"),
    deployPostScriptPath: z.string().optional(),

    // Autonomous Mode
    autonomousDefaultHours: z.string().transform((s) => parseInt(s, 10)).pipe(z.number().int().min(1).max(168)).default("24"),
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
    ].some((k) => k && k.length > 0);

    const hasOllama = data.providerChain?.includes("ollama") ?? false;

    if (!hasAnyKey && !hasOllama) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one AI provider API key is required (or use Ollama)",
        path: ["anthropicApiKey"],
      });
    }
  });

/** Raw config type from Zod */
export type RawConfig = z.infer<typeof configSchema>;

// =============================================================================
// CONFIG VALIDATION
// =============================================================================

/** Config validation error */
export interface ConfigValidationError {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

/** Config validation result */
export type ConfigValidationResult = ValidationResult<Config>;

/**
 * Validate raw config values
 */
export function validateConfig(raw: unknown): ConfigValidationResult {
  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const errors: ValidationError[] = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    }));
    return { kind: "invalid", errors };
  }

  // Transform to structured config
  const rawConfig = result.data;
  const config: Config = {
    anthropicApiKey: rawConfig.anthropicApiKey,
    openaiApiKey: rawConfig.openaiApiKey,
    deepseekApiKey: rawConfig.deepseekApiKey,
    qwenApiKey: rawConfig.qwenApiKey,
    kimiApiKey: rawConfig.kimiApiKey,
    minimaxApiKey: rawConfig.minimaxApiKey,
    groqApiKey: rawConfig.groqApiKey,
    mistralApiKey: rawConfig.mistralApiKey,
    togetherApiKey: rawConfig.togetherApiKey,
    fireworksApiKey: rawConfig.fireworksApiKey,
    geminiApiKey: rawConfig.geminiApiKey,
    providerChain: rawConfig.providerChain,

    telegram: {
      botToken: rawConfig.telegramBotToken,
      allowedUserIds: rawConfig.allowedTelegramUserIds ?? [],
    },

    discord: {
      botToken: rawConfig.discordBotToken,
      guildId: rawConfig.discordGuildId,
    },

    slack: {
      botToken: rawConfig.slackBotToken,
      signingSecret: rawConfig.slackSigningSecret,
      appToken: rawConfig.slackAppToken,
      socketMode: rawConfig.slackSocketMode,
      allowedWorkspaces: rawConfig.allowedSlackWorkspaces,
      allowedUserIds: rawConfig.allowedSlackUserIds,
    },

    security: {
      requireEditConfirmation: rawConfig.requireEditConfirmation,
      readOnlyMode: rawConfig.readOnlyMode,
    },

    unityProjectPath: rawConfig.unityProjectPath,

    dashboard: {
      enabled: rawConfig.dashboardEnabled,
      port: rawConfig.dashboardPort,
    },

    websocketDashboard: {
      enabled: rawConfig.websocketDashboardEnabled,
      port: rawConfig.websocketDashboardPort,
      authToken: rawConfig.websocketDashboardAuthToken,
      allowedOrigins: rawConfig.websocketDashboardAllowedOrigins,
    },

    prometheus: {
      enabled: rawConfig.prometheusEnabled,
      port: rawConfig.prometheusPort,
    },

    memory: {
      enabled: rawConfig.memoryEnabled,
      dbPath: rawConfig.memoryDbPath,
      backend: rawConfig.memoryBackend,
      unified: {
        dimensions: rawConfig.memoryDimensions,
        autoTiering: rawConfig.memoryAutoTiering,
        autoTieringIntervalMs: rawConfig.memoryAutoTieringIntervalMs,
        promotionThreshold: rawConfig.memoryPromotionThreshold,
        demotionTimeoutDays: rawConfig.memoryDemotionTimeoutDays,
        tierLimits: {
          working: rawConfig.memoryTierWorkingMax,
          ephemeral: rawConfig.memoryTierEphemeralMax,
          persistent: rawConfig.memoryTierPersistentMax,
        },
        ephemeralTtlHours: rawConfig.memoryEphemeralTtlHours,
      },
      decay: {
        enabled: rawConfig.memoryDecayEnabled,
        lambdas: {
          working: rawConfig.memoryDecayLambdaWorking,
          ephemeral: rawConfig.memoryDecayLambdaEphemeral,
          persistent: rawConfig.memoryDecayLambdaPersistent,
        },
        exemptDomains: rawConfig.memoryDecayExemptDomains.split(",").map((s: string) => s.trim()).filter(Boolean),
        timeoutMs: rawConfig.memoryDecayTimeoutMs,
      },
      consolidation: {
        enabled: rawConfig.memoryConsolidationEnabled,
        idleMinutes: rawConfig.memoryConsolidationIdleMinutes,
        threshold: rawConfig.memoryConsolidationThreshold,
        batchSize: rawConfig.memoryConsolidationBatchSize,
        minClusterSize: rawConfig.memoryConsolidationMinClusterSize,
        maxDepth: rawConfig.memoryConsolidationMaxDepth,
        modelTier: rawConfig.memoryConsolidationModelTier,
      },
    },

    rag: {
      enabled: rawConfig.ragEnabled,
      provider: rawConfig.embeddingProvider,
      model: rawConfig.embeddingModel,
      baseUrl: rawConfig.embeddingBaseUrl,
      dimensions: rawConfig.embeddingDimensions,
      contextMaxTokens: rawConfig.ragContextMaxTokens,
    },

    streamingEnabled: rawConfig.streamingEnabled,
    shellEnabled: rawConfig.shellEnabled,

    rateLimit: {
      enabled: rawConfig.rateLimitEnabled,
      messagesPerMinute: rawConfig.rateLimitMessagesPerMinute,
      messagesPerHour: rawConfig.rateLimitMessagesPerHour,
      tokensPerDay: rawConfig.rateLimitTokensPerDay,
      dailyBudgetUsd: rawConfig.rateLimitDailyBudgetUsd,
      monthlyBudgetUsd: rawConfig.rateLimitMonthlyBudgetUsd,
    },

    web: {
      port: rawConfig.webChannelPort,
    },

    logLevel: rawConfig.logLevel,
    logFile: rawConfig.logFile,
    pluginDirs: rawConfig.pluginDirs,

    bayesian: {
      enabled: rawConfig.bayesianEnabled,
      deprecatedThreshold: rawConfig.bayesianDeprecatedThreshold,
      activeThreshold: rawConfig.bayesianActiveThreshold,
      evolutionThreshold: rawConfig.bayesianEvolutionThreshold,
      autoEvolveThreshold: rawConfig.bayesianAutoEvolveThreshold,
      maxInitial: rawConfig.bayesianMaxInitial,
      coolingPeriodDays: rawConfig.bayesianCoolingPeriodDays,
      coolingMinObservations: rawConfig.bayesianCoolingMinObservations,
      coolingMaxFailures: rawConfig.bayesianCoolingMaxFailures,
      promotionMinObservations: rawConfig.bayesianPromotionMinObservations,
      verdictCleanSuccess: rawConfig.bayesianVerdictCleanSuccess,
      verdictRetrySuccess: rawConfig.bayesianVerdictRetrySuccess,
      verdictFailure: rawConfig.bayesianVerdictFailure,
    },

    goalMaxDepth: rawConfig.goalMaxDepth,
    goalMaxRetries: rawConfig.goalMaxRetries,
    goalMaxFailures: rawConfig.goalMaxFailures,
    goalParallelExecution: rawConfig.goalParallelExecution,
    goalMaxParallel: rawConfig.goalMaxParallel,

    goal: {
      maxFailures: rawConfig.goalMaxFailures,
      escalationTimeoutMinutes: rawConfig.stradaGoalEscalationTimeoutMinutes,
      maxRedecompositions: rawConfig.stradaGoalMaxRedecompositions,
    },

    toolChain: {
      enabled: rawConfig.toolChainEnabled,
      minOccurrences: rawConfig.toolChainMinOccurrences,
      successRateThreshold: rawConfig.toolChainSuccessRateThreshold,
      maxActive: rawConfig.toolChainMaxActive,
      maxAgeDays: rawConfig.toolChainMaxAgeDays,
      llmBudgetPerCycle: rawConfig.toolChainLlmBudgetPerCycle,
      minChainLength: rawConfig.toolChainMinChainLength,
      maxChainLength: rawConfig.toolChainMaxChainLength,
      detectionIntervalMs: rawConfig.toolChainDetectionIntervalMs,
      resilience: {
        rollbackEnabled: rawConfig.chainRollbackEnabled,
        parallelEnabled: rawConfig.chainParallelEnabled,
        maxParallelBranches: rawConfig.chainMaxParallelBranches,
        compensationTimeoutMs: rawConfig.chainCompensationTimeoutMs,
      },
    },

    crossSession: {
      enabled: rawConfig.crossSessionEnabled,
      maxAgeDays: rawConfig.crossSessionMaxAgeDays,
      scopeFilter: rawConfig.crossSessionScopeFilter,
      recencyBoost: rawConfig.crossSessionRecencyBoost,
      scopeBoost: rawConfig.crossSessionScopeBoost,
      promotionThreshold: rawConfig.crossSessionPromotionThreshold,
    },

    agentName: rawConfig.agentName,
    language: rawConfig.language,

    daemon: {
      heartbeat: {
        intervalMs: rawConfig.daemonIntervalMs,
        heartbeatFile: rawConfig.daemonHeartbeatFile,
        idlePause: rawConfig.daemonIdlePause,
      },
      security: {
        approvalTimeoutMin: rawConfig.daemonApprovalTimeoutMin,
        autoApproveTools: rawConfig.daemonAutoApproveTools,
      },
      budget: {
        dailyBudgetUsd: rawConfig.daemonDailyBudget,
        warnPct: rawConfig.daemonBudgetWarnPct,
      },
      backoff: {
        baseCooldownMs: rawConfig.daemonBackoffBase,
        maxCooldownMs: rawConfig.daemonBackoffMax,
        failureThreshold: rawConfig.daemonFailureThreshold,
      },
      timezone: rawConfig.daemonTimezone,
      triggers: {
        webhookSecret: rawConfig.webhookSecret,
        webhookRateLimit: rawConfig.webhookRateLimit,
        dedupWindowMs: rawConfig.daemonDedupWindowMs,
        defaultDebounceMs: rawConfig.daemonDefaultDebounceMs,
        checklistMorningHour: rawConfig.checklistMorningHour,
        checklistAfternoonHour: rawConfig.checklistAfternoonHour,
        checklistEveningHour: rawConfig.checklistEveningHour,
      },
      triggerFireRetentionDays: rawConfig.triggerFireRetentionDays,
    },

    reRetrieval: {
      enabled: rawConfig.stradaMemoryReRetrievalEnabled,
      interval: rawConfig.stradaMemoryReRetrievalInterval,
      topicShiftEnabled: rawConfig.stradaMemoryTopicShiftEnabled,
      topicShiftThreshold: rawConfig.stradaMemoryTopicShiftThreshold,
      maxReRetrievals: rawConfig.stradaMemoryMaxReRetrievals,
      timeoutMs: rawConfig.stradaMemoryReRetrievalTimeoutMs,
      memoryLimit: rawConfig.stradaMemoryReRetrievalMemoryLimit,
      ragTopK: rawConfig.stradaMemoryReRetrievalRagTopK,
    },

    notification: {
      minLevel: rawConfig.stradaNotifyMinLevel,
      routing: {
        silent: splitCsv(rawConfig.stradaNotifySilent),
        low: splitCsv(rawConfig.stradaNotifyLow),
        medium: splitCsv(rawConfig.stradaNotifyMedium),
        high: splitCsv(rawConfig.stradaNotifyHigh),
        critical: splitCsv(rawConfig.stradaNotifyCritical),
      },
      groupingWindowMs: 30000,
    },

    quietHours: {
      enabled: rawConfig.stradaQuietStart !== undefined,
      startHour: rawConfig.stradaQuietStart ?? 22,
      endHour: rawConfig.stradaQuietEnd,
      timezone: rawConfig.daemonTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      bufferMax: rawConfig.stradaQuietBufferMax,
    },

    digest: {
      enabled: rawConfig.stradaDigestEnabled,
      schedule: rawConfig.stradaDigestSchedule,
      timezone: rawConfig.daemonTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      dashboardHistoryDepth: rawConfig.stradaDashboardHistoryDepth,
    },

    agent: {
      enabled: rawConfig.multiAgentEnabled,
      defaultBudgetUsd: rawConfig.agentDefaultBudgetUsd,
      maxConcurrent: rawConfig.agentMaxConcurrent,
      idleTimeoutMs: rawConfig.agentIdleTimeoutMs,
      maxMemoryEntries: rawConfig.agentMaxMemoryEntries,
    },

    delegation: {
      enabled: rawConfig.taskDelegationEnabled,
      maxDepth: rawConfig.agentMaxDelegationDepth,
      maxConcurrentPerParent: rawConfig.agentMaxConcurrentDelegations,
      tiers: {
        local: rawConfig.delegationTierLocal,
        cheap: rawConfig.delegationTierCheap,
        standard: rawConfig.delegationTierStandard,
        premium: rawConfig.delegationTierPremium,
      },
      types: rawConfig.delegationTypes
        ? parseDelegationTypes(rawConfig.delegationTypes)
        : ([] as unknown as DelegationConfig["types"]), // DEFAULT_DELEGATION_TYPES applied at runtime
      verbosity: rawConfig.delegationVerbosity,
    },

    deployment: {
      enabled: rawConfig.deployEnabled,
      scriptPath: rawConfig.deployScriptPath,
      testCommand: rawConfig.deployTestCommand,
      targetBranch: rawConfig.deployTargetBranch,
      requireCleanGit: rawConfig.deployRequireCleanGit,
      testTimeoutMs: rawConfig.deployTestTimeoutMs,
      executionTimeoutMs: rawConfig.deployExecutionTimeoutMs,
      cooldownMinutes: rawConfig.deployCooldownMinutes,
      notificationUrgency: rawConfig.deployNotificationUrgency,
      postScriptPath: rawConfig.deployPostScriptPath,
    },

    autonomousDefaultHours: rawConfig.autonomousDefaultHours,
  };

  return { kind: "valid", value: config };
}

/** Zod schema for DELEGATION_TYPES env var validation */
const DelegationTypeConfigSchema = z.array(z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  tier: z.enum(["local", "cheap", "standard", "premium"]),
  timeoutMs: z.number().int().min(5000).max(300000),
  maxIterations: z.number().int().min(1).max(50),
  systemPrompt: z.string().optional(),
}));

/** Parse and validate DELEGATION_TYPES JSON env var */
function parseDelegationTypes(raw: string): DelegationConfig["types"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`DELEGATION_TYPES is not valid JSON: ${raw.substring(0, 100)}`);
  }
  const result = DelegationTypeConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`DELEGATION_TYPES validation failed: ${result.error.message}`);
  }
  return result.data as DelegationConfig["types"];
}

/** Known valid notification channel names */
const VALID_CHANNELS = new Set(["chat", "dashboard"]);

/** Split a comma-separated string into a trimmed, non-empty, allowlist-validated array */
function splitCsv(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean).filter((ch) => VALID_CHANNELS.has(ch));
}

/**
 * Validate project path exists and is a directory
 */
export function validateProjectPath(projectPath: string): Result<string, string> {
  try {
    const realPath = realpathSync(projectPath);
    const stats = statSync(realPath);

    if (!stats.isDirectory()) {
      return { kind: "err", error: `UNITY_PROJECT_PATH is not a directory: ${projectPath}` };
    }

    return { kind: "ok", value: realPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "err", error: `UNITY_PROJECT_PATH does not exist: ${projectPath} (${message})` };
  }
}

// =============================================================================
// SECRET PATTERNS
// =============================================================================

/** Redaction function type */
export type RedactionFunction = (match: string) => string;

/** Enhanced secret pattern with typed redaction */
export interface TypedSecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly redaction: string | RedactionFunction;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly description: string;
}

/**
 * Secret patterns for sanitization.
 * Loaded from environment variable or uses defaults.
 */
export const secretPatterns: SecretPattern[] = [
  // OpenAI API keys
  {
    name: "openai_api_key",
    pattern: /sk-[a-zA-Z0-9]{48,}/g,
    redaction: "[REDACTED_OPENAI_KEY]",
  },
  {
    name: "openai_project_key",
    pattern: /sk-proj-[a-zA-Z0-9_-]{48,}/g,
    redaction: "[REDACTED_OPENAI_PROJECT_KEY]",
  },
  // GitHub tokens
  {
    name: "github_token",
    pattern: /gh[pousr]_[a-zA-Z0-9]{36,}/g,
    redaction: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    name: "github_pat",
    pattern: /github_pat_[a-zA-Z0-9]{22,}_[a-zA-Z0-9]{59,}/g,
    redaction: "[REDACTED_GITHUB_PAT]",
  },
  // Slack tokens
  {
    name: "slack_token",
    pattern: /xox[bpas]-[a-zA-Z0-9-]{10,}/g,
    redaction: "[REDACTED_SLACK_TOKEN]",
  },
  {
    name: "slack_webhook",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9]+\/B[a-zA-Z0-9]+\/[a-zA-Z0-9]+/g,
    redaction: "[REDACTED_SLACK_WEBHOOK]",
  },
  // Authorization tokens
  {
    name: "bearer_token",
    pattern: /Bearer\s+[a-zA-Z0_\-\.]{20,}/gi,
    redaction: "Bearer [REDACTED]",
  },
  {
    name: "basic_auth",
    pattern: /Basic\s+[a-zA-Z0-9+/]{20,}={0,2}/gi,
    redaction: "Basic [REDACTED]",
  },
  // Private keys
  {
    name: "private_key",
    pattern:
      /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    redaction: "[REDACTED_PRIVATE_KEY]",
  },
  // Database credentials
  {
    name: "connection_password",
    pattern: /(?:password|pwd)=([^;\s&]{4,})/gi,
    redaction: "password=[REDACTED]",
  },
  {
    name: "database_url",
    pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^/\s]+/gi,
    redaction: (match: string) => {
      const urlMatch = match.match(/^(\w+:\/\/)[^:]+:[^@]+(@.+)$/);
      if (urlMatch) {
        return `${urlMatch[1]}[REDACTED_CREDENTIALS]${urlMatch[2]}`;
      }
      return "[REDACTED_DATABASE_URL]";
    },
  },
  // JWT tokens
  {
    name: "jwt_token",
    pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
    redaction: "[REDACTED_JWT]",
  },
  // .env values
  {
    name: "env_value",
    pattern: /^([A-Z_][A-Z0-9_]*)=(.+)$/gm,
    redaction: "$1=[REDACTED]",
  },
  // Platform tokens
  {
    name: "discord_token",
    pattern: /[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27}/g,
    redaction: "[REDACTED_DISCORD_TOKEN]",
  },
  {
    name: "telegram_token",
    pattern: /\d{8,10}:[a-zA-Z0-9_-]{35}/g,
    redaction: "[REDACTED_TELEGRAM_TOKEN]",
  },
  // AWS credentials
  {
    name: "aws_access_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    redaction: "[REDACTED_AWS_KEY]",
  },
  // Generic secrets
  {
    name: "secret_value",
    pattern: /(?:secret|token|password|key)["']?\s*[:=]\s*["']?[a-zA-Z0-9_\-\/+=]{20,}["']?/gi,
    redaction: "[REDACTED_SECRET]",
  },
];

// =============================================================================
// ENVIRONMENT LOADING
// =============================================================================

/**
 * Raw environment values - all values are strings or undefined
 */
interface EnvVars {
  anthropicApiKey: string | undefined;
  openaiApiKey: string | undefined;
  deepseekApiKey: string | undefined;
  qwenApiKey: string | undefined;
  kimiApiKey: string | undefined;
  minimaxApiKey: string | undefined;
  groqApiKey: string | undefined;
  mistralApiKey: string | undefined;
  togetherApiKey: string | undefined;
  fireworksApiKey: string | undefined;
  geminiApiKey: string | undefined;
  providerChain: string | undefined;
  telegramBotToken: string | undefined;
  allowedTelegramUserIds: string | undefined;
  discordBotToken: string | undefined;
  discordGuildId: string | undefined;
  slackBotToken: string | undefined;
  slackSigningSecret: string | undefined;
  slackAppToken: string | undefined;
  slackSocketMode: string | undefined;
  allowedSlackWorkspaces: string | undefined;
  allowedSlackUserIds: string | undefined;
  requireEditConfirmation: string | undefined;
  readOnlyMode: string | undefined;
  unityProjectPath: string | undefined;
  dashboardEnabled: string | undefined;
  dashboardPort: string | undefined;
  websocketDashboardEnabled: string | undefined;
  websocketDashboardPort: string | undefined;
  websocketDashboardAuthToken: string | undefined;
  websocketDashboardAllowedOrigins: string | undefined;
  prometheusEnabled: string | undefined;
  prometheusPort: string | undefined;
  memoryEnabled: string | undefined;
  memoryDbPath: string | undefined;
  memoryBackend: string | undefined;
  memoryDimensions: string | undefined;
  memoryAutoTiering: string | undefined;
  memoryAutoTieringIntervalMs: string | undefined;
  memoryPromotionThreshold: string | undefined;
  memoryDemotionTimeoutDays: string | undefined;
  memoryTierWorkingMax: string | undefined;
  memoryTierEphemeralMax: string | undefined;
  memoryTierPersistentMax: string | undefined;
  memoryEphemeralTtlHours: string | undefined;
  ragEnabled: string | undefined;
  embeddingProvider: string | undefined;
  embeddingModel: string | undefined;
  embeddingBaseUrl: string | undefined;
  embeddingDimensions: string | undefined;
  ragContextMaxTokens: string | undefined;
  streamingEnabled: string | undefined;
  shellEnabled: string | undefined;
  rateLimitEnabled: string | undefined;
  rateLimitMessagesPerMinute: string | undefined;
  rateLimitMessagesPerHour: string | undefined;
  rateLimitTokensPerDay: string | undefined;
  rateLimitDailyBudgetUsd: string | undefined;
  rateLimitMonthlyBudgetUsd: string | undefined;
  logLevel: string | undefined;
  logFile: string | undefined;
  webChannelPort: string | undefined;
  pluginDirs: string | undefined;
  bayesianEnabled: string | undefined;
  bayesianDeprecatedThreshold: string | undefined;
  bayesianActiveThreshold: string | undefined;
  bayesianEvolutionThreshold: string | undefined;
  bayesianAutoEvolveThreshold: string | undefined;
  bayesianMaxInitial: string | undefined;
  bayesianCoolingPeriodDays: string | undefined;
  bayesianCoolingMinObservations: string | undefined;
  bayesianCoolingMaxFailures: string | undefined;
  bayesianPromotionMinObservations: string | undefined;
  bayesianVerdictCleanSuccess: string | undefined;
  bayesianVerdictRetrySuccess: string | undefined;
  bayesianVerdictFailure: string | undefined;
  goalMaxDepth: string | undefined;
  goalMaxRetries: string | undefined;
  goalMaxFailures: string | undefined;
  goalParallelExecution: string | undefined;
  goalMaxParallel: string | undefined;
  stradaGoalEscalationTimeoutMinutes: string | undefined;
  stradaGoalMaxRedecompositions: string | undefined;
  toolChainEnabled: string | undefined;
  toolChainMinOccurrences: string | undefined;
  toolChainSuccessRateThreshold: string | undefined;
  toolChainMaxActive: string | undefined;
  toolChainMaxAgeDays: string | undefined;
  toolChainLlmBudgetPerCycle: string | undefined;
  toolChainMinChainLength: string | undefined;
  toolChainMaxChainLength: string | undefined;
  toolChainDetectionIntervalMs: string | undefined;
  crossSessionEnabled: string | undefined;
  crossSessionMaxAgeDays: string | undefined;
  crossSessionScopeFilter: string | undefined;
  crossSessionRecencyBoost: string | undefined;
  crossSessionScopeBoost: string | undefined;
  crossSessionPromotionThreshold: string | undefined;
  agentName: string | undefined;
  language: string | undefined;
  daemonIntervalMs: string | undefined;
  daemonTimezone: string | undefined;
  daemonHeartbeatFile: string | undefined;
  daemonDailyBudget: string | undefined;
  daemonBudgetWarnPct: string | undefined;
  daemonApprovalTimeoutMin: string | undefined;
  daemonAutoApproveTools: string | undefined;
  daemonBackoffBase: string | undefined;
  daemonBackoffMax: string | undefined;
  daemonFailureThreshold: string | undefined;
  daemonIdlePause: string | undefined;
  webhookSecret: string | undefined;
  webhookRateLimit: string | undefined;
  daemonDedupWindowMs: string | undefined;
  daemonDefaultDebounceMs: string | undefined;
  checklistMorningHour: string | undefined;
  checklistAfternoonHour: string | undefined;
  checklistEveningHour: string | undefined;
  // Trigger Fire History Pruning (Phase 21)
  triggerFireRetentionDays: string | undefined;
  // Notification, Quiet Hours, Digest (Phase 18)
  stradaDigestEnabled: string | undefined;
  stradaDigestSchedule: string | undefined;
  stradaNotifyMinLevel: string | undefined;
  stradaNotifySilent: string | undefined;
  stradaNotifyLow: string | undefined;
  stradaNotifyMedium: string | undefined;
  stradaNotifyHigh: string | undefined;
  stradaNotifyCritical: string | undefined;
  stradaQuietStart: string | undefined;
  stradaQuietEnd: string | undefined;
  stradaQuietBufferMax: string | undefined;
  stradaDashboardHistoryDepth: string | undefined;
  // Memory Re-Retrieval (Phase 17)
  stradaMemoryReRetrievalEnabled: string | undefined;
  stradaMemoryReRetrievalInterval: string | undefined;
  stradaMemoryTopicShiftEnabled: string | undefined;
  stradaMemoryTopicShiftThreshold: string | undefined;
  stradaMemoryMaxReRetrievals: string | undefined;
  stradaMemoryReRetrievalTimeoutMs: string | undefined;
  stradaMemoryReRetrievalMemoryLimit: string | undefined;
  stradaMemoryReRetrievalRagTopK: string | undefined;
  // Memory Decay (Phase 21)
  memoryDecayEnabled: string | undefined;
  memoryDecayLambdaWorking: string | undefined;
  memoryDecayLambdaEphemeral: string | undefined;
  memoryDecayLambdaPersistent: string | undefined;
  memoryDecayExemptDomains: string | undefined;
  memoryDecayTimeoutMs: string | undefined;
  // Memory Consolidation (Phase 25)
  memoryConsolidationEnabled: string | undefined;
  memoryConsolidationIdleMinutes: string | undefined;
  memoryConsolidationThreshold: string | undefined;
  memoryConsolidationBatchSize: string | undefined;
  memoryConsolidationMinClusterSize: string | undefined;
  memoryConsolidationMaxDepth: string | undefined;
  memoryConsolidationModelTier: string | undefined;
  // Chain Resilience (Phase 22)
  chainRollbackEnabled: string | undefined;
  chainParallelEnabled: string | undefined;
  chainMaxParallelBranches: string | undefined;
  chainCompensationTimeoutMs: string | undefined;
  // Multi-Agent (Phase 23)
  multiAgentEnabled: string | undefined;
  agentDefaultBudgetUsd: string | undefined;
  agentMaxConcurrent: string | undefined;
  agentIdleTimeoutMs: string | undefined;
  agentMaxMemoryEntries: string | undefined;
  // Autonomous Mode
  autonomousDefaultHours: string | undefined;
}

/**
 * Load configuration from environment variables
 */
function loadFromEnv(): EnvVars {
  return {
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
    openaiApiKey: process.env["OPENAI_API_KEY"],
    deepseekApiKey: process.env["DEEPSEEK_API_KEY"],
    qwenApiKey: process.env["QWEN_API_KEY"],
    kimiApiKey: process.env["KIMI_API_KEY"],
    minimaxApiKey: process.env["MINIMAX_API_KEY"],
    groqApiKey: process.env["GROQ_API_KEY"],
    mistralApiKey: process.env["MISTRAL_API_KEY"],
    togetherApiKey: process.env["TOGETHER_API_KEY"],
    fireworksApiKey: process.env["FIREWORKS_API_KEY"],
    geminiApiKey: process.env["GEMINI_API_KEY"],
    providerChain: process.env["PROVIDER_CHAIN"],
    telegramBotToken: process.env["TELEGRAM_BOT_TOKEN"],
    allowedTelegramUserIds: process.env["ALLOWED_TELEGRAM_USER_IDS"],
    discordBotToken: process.env["DISCORD_BOT_TOKEN"],
    discordGuildId: process.env["DISCORD_GUILD_ID"],
    slackBotToken: process.env["SLACK_BOT_TOKEN"],
    slackSigningSecret: process.env["SLACK_SIGNING_SECRET"],
    slackAppToken: process.env["SLACK_APP_TOKEN"],
    slackSocketMode: process.env["SLACK_SOCKET_MODE"],
    allowedSlackWorkspaces: process.env["ALLOWED_SLACK_WORKSPACES"],
    allowedSlackUserIds: process.env["ALLOWED_SLACK_USER_IDS"],
    requireEditConfirmation: process.env["REQUIRE_EDIT_CONFIRMATION"],
    readOnlyMode: process.env["READ_ONLY_MODE"],
    unityProjectPath: process.env["UNITY_PROJECT_PATH"],
    dashboardEnabled: process.env["DASHBOARD_ENABLED"],
    dashboardPort: process.env["DASHBOARD_PORT"],
    websocketDashboardEnabled: process.env["ENABLE_WEBSOCKET_DASHBOARD"],
    websocketDashboardPort: process.env["WEBSOCKET_DASHBOARD_PORT"],
    websocketDashboardAuthToken: process.env["WEBSOCKET_DASHBOARD_AUTH_TOKEN"],
    websocketDashboardAllowedOrigins: process.env["WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS"],
    prometheusEnabled: process.env["ENABLE_PROMETHEUS"],
    prometheusPort: process.env["PROMETHEUS_PORT"],
    memoryEnabled: process.env["MEMORY_ENABLED"],
    memoryDbPath: process.env["MEMORY_DB_PATH"],
    memoryBackend: process.env["MEMORY_BACKEND"],
    memoryDimensions: process.env["MEMORY_DIMENSIONS"],
    memoryAutoTiering: process.env["MEMORY_AUTO_TIERING"],
    memoryAutoTieringIntervalMs: process.env["MEMORY_AUTO_TIERING_INTERVAL_MS"],
    memoryPromotionThreshold: process.env["MEMORY_PROMOTION_THRESHOLD"],
    memoryDemotionTimeoutDays: process.env["MEMORY_DEMOTION_TIMEOUT_DAYS"],
    memoryTierWorkingMax: process.env["MEMORY_TIER_WORKING_MAX"],
    memoryTierEphemeralMax: process.env["MEMORY_TIER_EPHEMERAL_MAX"],
    memoryTierPersistentMax: process.env["MEMORY_TIER_PERSISTENT_MAX"],
    memoryEphemeralTtlHours: process.env["MEMORY_EPHEMERAL_TTL_HOURS"],
    ragEnabled: process.env["RAG_ENABLED"],
    embeddingProvider: process.env["EMBEDDING_PROVIDER"],
    embeddingModel: process.env["EMBEDDING_MODEL"],
    embeddingBaseUrl: process.env["EMBEDDING_BASE_URL"],
    embeddingDimensions: process.env["EMBEDDING_DIMENSIONS"],
    ragContextMaxTokens: process.env["RAG_CONTEXT_MAX_TOKENS"],
    streamingEnabled: process.env["STREAMING_ENABLED"],
    shellEnabled: process.env["SHELL_ENABLED"],
    rateLimitEnabled: process.env["RATE_LIMIT_ENABLED"],
    rateLimitMessagesPerMinute: process.env["RATE_LIMIT_MESSAGES_PER_MINUTE"],
    rateLimitMessagesPerHour: process.env["RATE_LIMIT_MESSAGES_PER_HOUR"],
    rateLimitTokensPerDay: process.env["RATE_LIMIT_TOKENS_PER_DAY"],
    rateLimitDailyBudgetUsd: process.env["RATE_LIMIT_DAILY_BUDGET_USD"],
    rateLimitMonthlyBudgetUsd: process.env["RATE_LIMIT_MONTHLY_BUDGET_USD"],
    logLevel: process.env["LOG_LEVEL"],
    logFile: process.env["LOG_FILE"],
    webChannelPort: process.env["WEB_CHANNEL_PORT"],
    pluginDirs: process.env["PLUGIN_DIRS"],
    bayesianEnabled: process.env["BAYESIAN_ENABLED"],
    bayesianDeprecatedThreshold: process.env["BAYESIAN_DEPRECATED_THRESHOLD"],
    bayesianActiveThreshold: process.env["BAYESIAN_ACTIVE_THRESHOLD"],
    bayesianEvolutionThreshold: process.env["BAYESIAN_EVOLUTION_THRESHOLD"],
    bayesianAutoEvolveThreshold: process.env["BAYESIAN_AUTO_EVOLVE_THRESHOLD"],
    bayesianMaxInitial: process.env["BAYESIAN_MAX_INITIAL"],
    bayesianCoolingPeriodDays: process.env["BAYESIAN_COOLING_PERIOD_DAYS"],
    bayesianCoolingMinObservations: process.env["BAYESIAN_COOLING_MIN_OBSERVATIONS"],
    bayesianCoolingMaxFailures: process.env["BAYESIAN_COOLING_MAX_FAILURES"],
    bayesianPromotionMinObservations: process.env["BAYESIAN_PROMOTION_MIN_OBSERVATIONS"],
    bayesianVerdictCleanSuccess: process.env["BAYESIAN_VERDICT_CLEAN_SUCCESS"],
    bayesianVerdictRetrySuccess: process.env["BAYESIAN_VERDICT_RETRY_SUCCESS"],
    bayesianVerdictFailure: process.env["BAYESIAN_VERDICT_FAILURE"],
    goalMaxDepth: process.env["GOAL_MAX_DEPTH"],
    goalMaxRetries: process.env["GOAL_MAX_RETRIES"],
    goalMaxFailures: process.env["GOAL_MAX_FAILURES"],
    goalParallelExecution: process.env["GOAL_PARALLEL_EXECUTION"],
    goalMaxParallel: process.env["GOAL_MAX_PARALLEL"],
    stradaGoalEscalationTimeoutMinutes: process.env["STRADA_GOAL_ESCALATION_TIMEOUT_MINUTES"],
    stradaGoalMaxRedecompositions: process.env["STRADA_GOAL_MAX_REDECOMPOSITIONS"],
    toolChainEnabled: process.env["TOOL_CHAIN_ENABLED"],
    toolChainMinOccurrences: process.env["TOOL_CHAIN_MIN_OCCURRENCES"],
    toolChainSuccessRateThreshold: process.env["TOOL_CHAIN_SUCCESS_RATE_THRESHOLD"],
    toolChainMaxActive: process.env["TOOL_CHAIN_MAX_ACTIVE"],
    toolChainMaxAgeDays: process.env["TOOL_CHAIN_MAX_AGE_DAYS"],
    toolChainLlmBudgetPerCycle: process.env["TOOL_CHAIN_LLM_BUDGET_PER_CYCLE"],
    toolChainMinChainLength: process.env["TOOL_CHAIN_MIN_CHAIN_LENGTH"],
    toolChainMaxChainLength: process.env["TOOL_CHAIN_MAX_CHAIN_LENGTH"],
    toolChainDetectionIntervalMs: process.env["TOOL_CHAIN_DETECTION_INTERVAL_MS"],
    crossSessionEnabled: process.env["STRADA_CROSS_SESSION_ENABLED"],
    crossSessionMaxAgeDays: process.env["STRADA_INSTINCT_MAX_AGE_DAYS"],
    crossSessionScopeFilter: process.env["STRADA_INSTINCT_SCOPE_FILTER"],
    crossSessionRecencyBoost: process.env["STRADA_INSTINCT_RECENCY_BOOST"],
    crossSessionScopeBoost: process.env["STRADA_INSTINCT_SCOPE_BOOST"],
    crossSessionPromotionThreshold: process.env["STRADA_INSTINCT_PROMOTION_THRESHOLD"],
    agentName: process.env["STRADA_AGENT_NAME"],
    language: process.env["LANGUAGE_PREFERENCE"],
    daemonIntervalMs: process.env["STRADA_DAEMON_INTERVAL_MS"],
    daemonTimezone: process.env["STRADA_DAEMON_TIMEZONE"],
    daemonHeartbeatFile: process.env["STRADA_DAEMON_HEARTBEAT_FILE"],
    daemonDailyBudget: process.env["STRADA_DAEMON_DAILY_BUDGET"],
    daemonBudgetWarnPct: process.env["STRADA_DAEMON_BUDGET_WARN_PCT"],
    daemonApprovalTimeoutMin: process.env["STRADA_DAEMON_APPROVAL_TIMEOUT_MINUTES"],
    daemonAutoApproveTools: process.env["STRADA_DAEMON_AUTO_APPROVE_TOOLS"],
    daemonBackoffBase: process.env["STRADA_DAEMON_BACKOFF_BASE"],
    daemonBackoffMax: process.env["STRADA_DAEMON_BACKOFF_MAX"],
    daemonFailureThreshold: process.env["STRADA_DAEMON_FAILURE_THRESHOLD"],
    daemonIdlePause: process.env["STRADA_DAEMON_IDLE_PAUSE"],
    webhookSecret: process.env["STRADA_WEBHOOK_SECRET"],
    webhookRateLimit: process.env["STRADA_WEBHOOK_RATE_LIMIT"],
    daemonDedupWindowMs: process.env["STRADA_DAEMON_DEDUP_WINDOW_MS"],
    daemonDefaultDebounceMs: process.env["STRADA_DAEMON_DEFAULT_DEBOUNCE_MS"],
    checklistMorningHour: process.env["STRADA_CHECKLIST_MORNING_HOUR"],
    checklistAfternoonHour: process.env["STRADA_CHECKLIST_AFTERNOON_HOUR"],
    checklistEveningHour: process.env["STRADA_CHECKLIST_EVENING_HOUR"],
    // Trigger Fire History Pruning (Phase 21)
    triggerFireRetentionDays: process.env["TRIGGER_FIRE_RETENTION_DAYS"],
    // Notification, Quiet Hours, Digest (Phase 18)
    stradaDigestEnabled: process.env["STRADA_DIGEST_ENABLED"],
    stradaDigestSchedule: process.env["STRADA_DIGEST_SCHEDULE"],
    stradaNotifyMinLevel: process.env["STRADA_NOTIFY_MIN_LEVEL"],
    stradaNotifySilent: process.env["STRADA_NOTIFY_SILENT"],
    stradaNotifyLow: process.env["STRADA_NOTIFY_LOW"],
    stradaNotifyMedium: process.env["STRADA_NOTIFY_MEDIUM"],
    stradaNotifyHigh: process.env["STRADA_NOTIFY_HIGH"],
    stradaNotifyCritical: process.env["STRADA_NOTIFY_CRITICAL"],
    stradaQuietStart: process.env["STRADA_QUIET_START"],
    stradaQuietEnd: process.env["STRADA_QUIET_END"],
    stradaQuietBufferMax: process.env["STRADA_QUIET_BUFFER_MAX"],
    stradaDashboardHistoryDepth: process.env["STRADA_DASHBOARD_HISTORY_DEPTH"],
    // Memory Re-Retrieval (Phase 17)
    stradaMemoryReRetrievalEnabled: process.env["STRADA_MEMORY_RERETRIEVAL_ENABLED"],
    stradaMemoryReRetrievalInterval: process.env["STRADA_MEMORY_RERETRIEVAL_INTERVAL"],
    stradaMemoryTopicShiftEnabled: process.env["STRADA_MEMORY_TOPIC_SHIFT_ENABLED"],
    stradaMemoryTopicShiftThreshold: process.env["STRADA_MEMORY_TOPIC_SHIFT_THRESHOLD"],
    stradaMemoryMaxReRetrievals: process.env["STRADA_MEMORY_MAX_RERETRIEVALS"],
    stradaMemoryReRetrievalTimeoutMs: process.env["STRADA_MEMORY_RERETRIEVAL_TIMEOUT_MS"],
    stradaMemoryReRetrievalMemoryLimit: process.env["STRADA_MEMORY_RERETRIEVAL_MEMORY_LIMIT"],
    stradaMemoryReRetrievalRagTopK: process.env["STRADA_MEMORY_RERETRIEVAL_RAG_TOPK"],
    // Memory Decay (Phase 21)
    memoryDecayEnabled: process.env["MEMORY_DECAY_ENABLED"],
    memoryDecayLambdaWorking: process.env["MEMORY_DECAY_LAMBDA_WORKING"],
    memoryDecayLambdaEphemeral: process.env["MEMORY_DECAY_LAMBDA_EPHEMERAL"],
    memoryDecayLambdaPersistent: process.env["MEMORY_DECAY_LAMBDA_PERSISTENT"],
    memoryDecayExemptDomains: process.env["MEMORY_DECAY_EXEMPT_DOMAINS"],
    memoryDecayTimeoutMs: process.env["MEMORY_DECAY_TIMEOUT_MS"],
    // Memory Consolidation (Phase 25)
    memoryConsolidationEnabled: process.env["MEMORY_CONSOLIDATION_ENABLED"],
    memoryConsolidationIdleMinutes: process.env["MEMORY_CONSOLIDATION_IDLE_MINUTES"],
    memoryConsolidationThreshold: process.env["MEMORY_CONSOLIDATION_THRESHOLD"],
    memoryConsolidationBatchSize: process.env["MEMORY_CONSOLIDATION_BATCH_SIZE"],
    memoryConsolidationMinClusterSize: process.env["MEMORY_CONSOLIDATION_MIN_CLUSTER_SIZE"],
    memoryConsolidationMaxDepth: process.env["MEMORY_CONSOLIDATION_MAX_DEPTH"],
    memoryConsolidationModelTier: process.env["MEMORY_CONSOLIDATION_MODEL_TIER"],
    // Chain Resilience (Phase 22)
    chainRollbackEnabled: process.env["CHAIN_ROLLBACK_ENABLED"],
    chainParallelEnabled: process.env["CHAIN_PARALLEL_ENABLED"],
    chainMaxParallelBranches: process.env["CHAIN_MAX_PARALLEL_BRANCHES"],
    chainCompensationTimeoutMs: process.env["CHAIN_COMPENSATION_TIMEOUT_MS"],
    // Multi-Agent (Phase 23)
    multiAgentEnabled: process.env["MULTI_AGENT_ENABLED"],
    agentDefaultBudgetUsd: process.env["AGENT_DEFAULT_BUDGET_USD"],
    agentMaxConcurrent: process.env["AGENT_MAX_CONCURRENT"],
    agentIdleTimeoutMs: process.env["AGENT_IDLE_TIMEOUT_MS"],
    agentMaxMemoryEntries: process.env["AGENT_MAX_MEMORY_ENTRIES"],
    // Autonomous Mode
    autonomousDefaultHours: process.env["AUTONOMOUS_DEFAULT_HOURS"],
  };
}

// =============================================================================
// CONFIG LOADING
// =============================================================================

let cachedConfig: Config | null = null;

/**
 * Load and validate configuration from environment
 */
export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const raw = loadFromEnv();
  const validation = validateConfig(raw);

  if (validation.kind === "invalid") {
    const errors = validation.errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  const config = validation.value;

  // Validate project path
  const pathResult = validateProjectPath(config.unityProjectPath);
  if (pathResult.kind === "err") {
    throw new Error(pathResult.error);
  }

  // Apply system preset if configured (env vars override preset values)
  const presetName = process.env["SYSTEM_PRESET"];
  const preset = presetName ? getPreset(presetName) : undefined;
  if (presetName && !preset) {
    throw new Error(
      `Invalid SYSTEM_PRESET "${presetName}". Valid values: free, budget, balanced, performance, premium`,
    );
  }

  // Parse per-provider model overrides (manual env > preset > defaults)
  const providerModels: Record<string, string> = {};
  if (preset) {
    Object.assign(providerModels, preset.providerModels);
  }
  for (const p of ["openai", "deepseek", "qwen", "kimi", "minimax", "groq", "mistral", "together", "fireworks", "gemini", "claude", "ollama"]) {
    const val = process.env[`${p.toUpperCase()}_MODEL`];
    if (val) providerModels[p] = val;
  }

  // Update with resolved path + preset overrides
  cachedConfig = {
    ...config,
    unityProjectPath: pathResult.value,
    providerModels,
    // Preset fills in defaults; explicit env vars take precedence (already parsed by Zod above)
    ...(preset && !process.env["PROVIDER_CHAIN"] ? { providerChain: preset.providerChain } : {}),
    ...(preset && !process.env["EMBEDDING_PROVIDER"] ? { embeddingProvider: preset.embeddingProvider } : {}),
    ...(preset && !process.env["EMBEDDING_MODEL"] ? { embeddingModel: preset.embeddingModel } : {}),
    ...(preset && !process.env["EMBEDDING_BASE_URL"] && preset.embeddingBaseUrl ? { embeddingBaseUrl: preset.embeddingBaseUrl } : {}),
    ...(preset && !process.env["DELEGATION_TIER_LOCAL"] ? { delegationTierLocal: preset.delegationTierLocal } : {}),
    ...(preset && !process.env["DELEGATION_TIER_CHEAP"] ? { delegationTierCheap: preset.delegationTierCheap } : {}),
    ...(preset && !process.env["DELEGATION_TIER_STANDARD"] ? { delegationTierStandard: preset.delegationTierStandard } : {}),
    ...(preset && !process.env["DELEGATION_TIER_PREMIUM"] ? { delegationTierPremium: preset.delegationTierPremium } : {}),
  };

  return cachedConfig;
}

/**
 * Load config without throwing (returns Result)
 */
export function loadConfigSafe(): Result<Config, string> {
  try {
    return { kind: "ok", value: loadConfig() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "err", error: message };
  }
}

/**
 * Reset config cache (useful for testing)
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}

/**
 * Get cached config or undefined
 */
export function getCachedConfig(): Config | undefined {
  return cachedConfig ?? undefined;
}

/**
 * Check if required API keys are present
 */
export function hasRequiredApiKeys(config: Config): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  // If a provider chain is specified, check that each provider in the chain has its key
  if (config.providerChain) {
    const names = config.providerChain.split(",").map((s) => s.trim());
    const keyMap: Record<string, string | undefined> = {
      claude: config.anthropicApiKey,
      anthropic: config.anthropicApiKey,
      openai: config.openaiApiKey,
      deepseek: config.deepseekApiKey,
      qwen: config.qwenApiKey,
      kimi: config.kimiApiKey,
      minimax: config.minimaxApiKey,
      groq: config.groqApiKey,
      mistral: config.mistralApiKey,
      together: config.togetherApiKey,
      fireworks: config.fireworksApiKey,
      gemini: config.geminiApiKey,
    };
    for (const name of names) {
      if (name === "ollama") continue; // no key needed
      if (!keyMap[name]) {
        missing.push(`${name.toUpperCase()}_API_KEY`);
      }
    }
  } else if (!config.anthropicApiKey) {
    // No chain specified and no Anthropic key — check if any key exists
    const hasAny = [
      config.openaiApiKey,
      config.deepseekApiKey,
      config.qwenApiKey,
      config.kimiApiKey,
      config.minimaxApiKey,
      config.groqApiKey,
      config.mistralApiKey,
      config.togetherApiKey,
      config.fireworksApiKey,
      config.geminiApiKey,
    ].some((k) => k && k.length > 0);

    if (!hasAny) {
      missing.push("ANTHROPIC_API_KEY");
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Check channel-specific configuration
 */
export function checkChannelConfig(
  config: Config,
  channelType: "telegram" | "discord" | "slack" | "cli" | "web",
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  switch (channelType) {
    case "telegram":
      if (!config.telegram.botToken) {
        errors.push("TELEGRAM_BOT_TOKEN is required");
      }
      if (config.telegram.allowedUserIds.length === 0) {
        errors.push("ALLOWED_TELEGRAM_USER_IDS is empty - all users will be denied");
      }
      break;

    case "discord":
      if (!config.discord.botToken) {
        errors.push("DISCORD_BOT_TOKEN is required");
      }
      break;

    case "slack":
      if (!config.slack.botToken) {
        errors.push("SLACK_BOT_TOKEN is required");
      }
      if (!config.slack.socketMode && !config.slack.signingSecret) {
        errors.push("SLACK_SIGNING_SECRET is required when not using socket mode");
      }
      break;

    case "cli":
    case "web":
      // CLI and Web don't require any special config
      break;
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Create a partial config from environment subset
 */
export function createPartialConfig(env: Partial<EnvVarMap>): PartialConfig {
  const raw: Record<string, unknown> = {};

  if (env.ANTHROPIC_API_KEY) raw.anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY) raw.openaiApiKey = env.OPENAI_API_KEY;
  if (env.LOG_LEVEL) raw.logLevel = env.LOG_LEVEL;
  if (env.READ_ONLY_MODE) raw.security = { readOnlyMode: env.READ_ONLY_MODE === "true" };

  return raw as PartialConfig;
}

/**
 * Merge partial configs
 */
export function mergeConfigs(base: Config, partial: PartialConfig): Config {
  return {
    ...base,
    ...partial,
    telegram: { ...base.telegram, ...partial.telegram },
    discord: { ...base.discord, ...partial.discord },
    slack: { ...base.slack, ...partial.slack },
    security: { ...base.security, ...partial.security },
    dashboard: { ...base.dashboard, ...partial.dashboard },
    websocketDashboard: { ...base.websocketDashboard, ...partial.websocketDashboard },
    prometheus: { ...base.prometheus, ...partial.prometheus },
    memory: {
      ...base.memory,
      ...partial.memory,
      unified: {
        ...base.memory.unified,
        ...(partial.memory?.unified ?? {}),
        tierLimits: {
          ...base.memory.unified.tierLimits,
          ...(partial.memory?.unified?.tierLimits ?? {}),
        },
      },
    },
    rag: { ...base.rag, ...partial.rag },
    rateLimit: { ...base.rateLimit, ...partial.rateLimit },
    bayesian: { ...base.bayesian, ...partial.bayesian },
    goalMaxDepth: (partial as Partial<Config>).goalMaxDepth ?? base.goalMaxDepth,
    goalMaxRetries: (partial as Partial<Config>).goalMaxRetries ?? base.goalMaxRetries,
    goalMaxFailures: (partial as Partial<Config>).goalMaxFailures ?? base.goalMaxFailures,
    goalParallelExecution: (partial as Partial<Config>).goalParallelExecution ?? base.goalParallelExecution,
    goalMaxParallel: (partial as Partial<Config>).goalMaxParallel ?? base.goalMaxParallel,
    goal: { ...base.goal, ...((partial as Partial<Config>).goal ?? {}) },
    toolChain: { ...base.toolChain, ...(partial as Partial<Config>).toolChain },
    crossSession: { ...base.crossSession, ...(partial as Partial<Config>).crossSession },
    reRetrieval: { ...base.reRetrieval, ...((partial as Partial<Config>).reRetrieval ?? {}) },
    notification: { ...base.notification, ...((partial as Partial<Config>).notification ?? {}) },
    quietHours: { ...base.quietHours, ...((partial as Partial<Config>).quietHours ?? {}) },
    digest: { ...base.digest, ...((partial as Partial<Config>).digest ?? {}) },
  } as Config;
}
