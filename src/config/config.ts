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
import { resolveDotenvPath } from "../common/runtime-paths.js";
import type { BayesianConfig, CrossSessionConfig } from "../learning/types.js";
import type { ToolChainConfig } from "../learning/chains/chain-types.js";
import type { DaemonConfig } from "../daemon/daemon-types.js";
import type {
  NotificationConfig,
  QuietHoursConfig,
  DigestConfig,
} from "../daemon/reporting/notification-types.js";
import type { AgentConfig } from "../agents/multi/agent-types.js";
import type { DelegationConfig } from "../agents/multi/delegation/delegation-types.js";
import type { DeploymentConfig } from "../daemon/deployment/deployment-types.js";
import type { SupervisorConfig } from "../supervisor/supervisor-types.js";
import { getPreset } from "./presets.js";

dotenv.config({ path: resolveDotenvPath({ moduleUrl: import.meta.url }) });

// =============================================================================
// ENVIRONMENT VARIABLE TYPES
// =============================================================================

/** Environment variable names used by the application */
export type EnvVarName =
  | "ANTHROPIC_API_KEY"
  | "ANTHROPIC_AUTH_MODE"
  | "ANTHROPIC_AUTH_TOKEN"
  | "OPENAI_API_KEY"
  | "OPENAI_AUTH_MODE"
  | "OPENAI_CHATGPT_AUTH_FILE"
  | "OPENAI_SUBSCRIPTION_ACCESS_TOKEN"
  | "OPENAI_SUBSCRIPTION_ACCOUNT_ID"
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
  | "ALLOWED_DISCORD_USER_IDS"
  | "ALLOWED_DISCORD_ROLE_IDS"
  | "SLACK_BOT_TOKEN"
  | "SLACK_SIGNING_SECRET"
  | "SLACK_APP_TOKEN"
  | "SLACK_SOCKET_MODE"
  | "ALLOWED_SLACK_WORKSPACES"
  | "ALLOWED_SLACK_USER_IDS"
  | "WHATSAPP_SESSION_PATH"
  | "WHATSAPP_ALLOWED_NUMBERS"
  | "MATRIX_HOMESERVER"
  | "MATRIX_ACCESS_TOKEN"
  | "MATRIX_USER_ID"
  | "MATRIX_ALLOWED_USER_IDS"
  | "MATRIX_ALLOWED_ROOM_IDS"
  | "MATRIX_ALLOW_OPEN_ACCESS"
  | "IRC_SERVER"
  | "IRC_NICK"
  | "IRC_CHANNELS"
  | "IRC_ALLOWED_USERS"
  | "IRC_ALLOW_OPEN_ACCESS"
  | "TEAMS_APP_ID"
  | "TEAMS_APP_PASSWORD"
  | "TEAMS_ALLOWED_USER_IDS"
  | "TEAMS_ALLOW_OPEN_ACCESS"
  | "ALLOWED_TELEGRAM_USER_IDS"
  | "JWT_SECRET"
  | "REQUIRE_MFA"
  | "REQUIRE_EDIT_CONFIRMATION"
  | "READ_ONLY_MODE"
  | "UNITY_PROJECT_PATH"
  | "UNITY_BRIDGE_PORT"
  | "UNITY_BRIDGE_AUTO_CONNECT"
  | "UNITY_BRIDGE_TIMEOUT"
  | "UNITY_EDITOR_PATH"
  | "UNITY_PATH"
  | "STRADA_CORE_REPO_URL"
  | "STRADA_MODULES_REPO_URL"
  | "STRADA_MCP_PATH"
  | "SCRIPT_EXECUTE_ENABLED"
  | "REFLECTION_INVOKE_ENABLED"
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
  | "OPENAI_MODEL"
  | "DEEPSEEK_MODEL"
  | "QWEN_MODEL"
  | "KIMI_MODEL"
  | "MINIMAX_MODEL"
  | "GROQ_MODEL"
  | "MISTRAL_MODEL"
  | "TOGETHER_MODEL"
  | "FIREWORKS_MODEL"
  | "GEMINI_MODEL"
  | "CLAUDE_MODEL"
  | "OLLAMA_MODEL"
  | "BAYESIAN_ENABLED"
  | "BAYESIAN_DEPRECATED_THRESHOLD"
  | "BAYESIAN_ACTIVE_THRESHOLD"
  | "BAYESIAN_EVOLUTION_THRESHOLD"
  | "BAYESIAN_AUTO_EVOLVE_THRESHOLD"
  | "BAYESIAN_MAX_INITIAL"
  | "BAYESIAN_COOLING_PERIOD_DAYS"
  | "BAYESIAN_COOLING_MIN_OBSERVATIONS"
  | "BAYESIAN_COOLING_MAX_FAILURES"
  | "BAYESIAN_PROMOTION_MIN_OBSERVATIONS"
  | "BAYESIAN_VERDICT_CLEAN_SUCCESS"
  | "BAYESIAN_VERDICT_RETRY_SUCCESS"
  | "BAYESIAN_VERDICT_FAILURE"
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
  | "TASK_INTERACTIVE_MAX_ITERATIONS"
  | "TASK_INTERACTIVE_TOKEN_BUDGET"
  | "TASK_BACKGROUND_EPOCH_MAX_ITERATIONS"
  | "TASK_BACKGROUND_AUTO_CONTINUE"
  | "TASK_BACKGROUND_MAX_EPOCHS"
  | "INTERACTION_MODE"
  | "INTERACTION_HEARTBEAT_AFTER_MS"
  | "INTERACTION_HEARTBEAT_INTERVAL_MS"
  | "INTERACTION_ESCALATION_POLICY"

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
  | "LLM_STREAM_INITIAL_TIMEOUT_MS"
  | "LLM_STREAM_STALL_TIMEOUT_MS"

  // Autonomous Mode
  | "AUTONOMOUS_DEFAULT_ENABLED"
  | "AUTONOMOUS_DEFAULT_HOURS"

  // Conformance Guard
  | "STRADA_CONFORMANCE_ENABLED"
  | "STRADA_CONFORMANCE_FRAMEWORK_PATHS_ONLY"
  // Control Loop
  | "STRADA_LOOP_FINGERPRINT_THRESHOLD"
  | "STRADA_LOOP_FINGERPRINT_WINDOW"
  | "STRADA_LOOP_DENSITY_THRESHOLD"
  | "STRADA_LOOP_DENSITY_WINDOW"
  | "STRADA_LOOP_MAX_RECOVERY_EPISODES"
  | "STRADA_LOOP_STALE_ANALYSIS_THRESHOLD"
  | "STRADA_LOOP_HARD_CAP_REPLAN"
  | "STRADA_LOOP_HARD_CAP_BLOCK"
  | "STRADA_PROGRESS_ASSESSMENT_ENABLED"
  // Daemon Full Autonomy
  | "STRADA_DAEMON_FULL_AUTONOMY"

  // Model Intelligence Service
  | "MODEL_INTELLIGENCE_ENABLED"
  | "MODEL_INTELLIGENCE_REFRESH_HOURS"
  | "MODEL_INTELLIGENCE_DB_PATH"
  | "MODEL_INTELLIGENCE_PROVIDER_SOURCES_PATH"

  // Provider Routing
  | "ROUTING_PRESET"
  | "ROUTING_PHASE_SWITCHING"

  // Consensus
  | "CONSENSUS_MODE"
  | "CONSENSUS_THRESHOLD"
  | "CONSENSUS_MAX_PROVIDERS"

  // Auto-Update
  | "AUTO_UPDATE_ENABLED"
  | "AUTO_UPDATE_INTERVAL_HOURS"
  | "AUTO_UPDATE_IDLE_TIMEOUT_MIN"
  | "AUTO_UPDATE_CHANNEL"
  | "AUTO_UPDATE_NOTIFY"
  | "AUTO_UPDATE_AUTO_RESTART"
  | "TASK_MAX_CONCURRENT"
  | "TASK_MESSAGE_BURST_WINDOW_MS"
  | "TASK_MESSAGE_BURST_MAX_MESSAGES"

  // Learning Pipeline v2
  | "STRADA_CONFIDENCE_WEIGHTS"
  | "STRADA_MAX_INSTINCTS"
  | "STRADA_DETECTION_WINDOW_SIZE"
  | "STRADA_PERIODIC_EXTRACTION_INTERVAL"

  // Supervisor Brain
  | "SUPERVISOR_ENABLED"
  | "SUPERVISOR_COMPLEXITY_THRESHOLD"
  | "SUPERVISOR_MAX_PARALLEL_NODES"
  | "SUPERVISOR_NODE_TIMEOUT_MS"
  | "SUPERVISOR_VERIFICATION_MODE"
  | "SUPERVISOR_VERIFICATION_BUDGET_PCT"
  | "SUPERVISOR_TRIAGE_PROVIDER"
  | "SUPERVISOR_MAX_FAILURE_BUDGET"
  | "SUPERVISOR_DIVERSITY_CAP"

  // Unified Budget System
  | "STRADA_BUDGET_DAILY_USD"
  | "STRADA_BUDGET_MONTHLY_USD"
  | "STRADA_BUDGET_WARN_PCT"

  // Codebase Memory Vault
  | "STRADA_VAULT_ENABLED"
  | "STRADA_VAULT_WRITE_HOOK_BUDGET_MS"
  | "STRADA_VAULT_DEBOUNCE_MS";

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

/** OpenAI authentication modes */
export type OpenAIAuthMode = "api-key" | "chatgpt-subscription";

/** Anthropic authentication modes */
export type AnthropicAuthMode = "api-key" | "claude-subscription";

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
  readonly docRag?: {
    readonly enabled?: boolean;
    readonly maxDocChunkChars?: number;
    readonly overlapChars?: number;
    readonly frameworkBoost?: number;
  };
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

/** Model intelligence configuration */
export interface ModelIntelligenceConfig {
  readonly enabled: boolean;
  readonly refreshHours: number;
  readonly dbPath: string;
  readonly providerSourcesPath: string;
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
  readonly allowedUserIds: string[];
  readonly allowedRoleIds: string[];
}

/** Telegram configuration */
export interface TelegramConfig {
  readonly botToken?: string;
  readonly allowedUserIds: number[];
}

/** WhatsApp configuration */
export interface WhatsAppConfig {
  readonly sessionPath: string;
  readonly allowedNumbers: string[];
}

/** Matrix configuration */
export interface MatrixConfig {
  readonly homeserver?: string;
  readonly accessToken?: string;
  readonly userId?: string;
  readonly allowedUserIds: string[];
  readonly allowedRoomIds: string[];
  readonly allowOpenAccess: boolean;
}

/** IRC configuration */
export interface IRCConfig {
  readonly server?: string;
  readonly nick: string;
  readonly channels: string[];
  readonly allowedUsers: string[];
  readonly allowOpenAccess: boolean;
}

/** Teams configuration */
export interface TeamsConfig {
  readonly appId?: string;
  readonly appPassword?: string;
  readonly allowedUserIds: string[];
  readonly allowOpenAccess: boolean;
}

/** Security configuration */
export interface SystemAuthConfig {
  readonly jwtSecret?: string;
  readonly requireMfa: boolean;
}

/** Security configuration */
export interface SecurityConfig {
  readonly requireEditConfirmation: boolean;
  readonly readOnlyMode: boolean;
  readonly systemAuth: SystemAuthConfig;
}

/** Task execution and routing configuration */
export interface TaskConfig {
  readonly concurrencyLimit: number;
  readonly messageBurstWindowMs: number;
  readonly messageBurstMaxMessages: number;
  readonly interactiveMaxIterations: number;
  readonly interactiveTokenBudget: number;
  readonly backgroundEpochMaxIterations: number;
  readonly backgroundAutoContinue: boolean;
  readonly backgroundMaxEpochs: number;
}

export interface InteractionConfig {
  readonly mode: "silent-first" | "standard" | "phase-driven";
  readonly heartbeatAfterMs: number;
  readonly heartbeatIntervalMs: number;
  readonly escalationPolicy: "hard-blockers-only" | "standard";
  readonly narrativeEnabled?: boolean;
  readonly narrativeThrottleMs?: number;
}

/** Strada dependency configuration */
export interface StradaDependencyConfig {
  readonly coreRepoUrl: string;
  readonly modulesRepoUrl: string;
  readonly mcpRepoUrl: string;
  readonly mcpPath?: string;
  readonly unityBridgePort: number;
  readonly unityBridgeAutoConnect: boolean;
  readonly unityBridgeTimeout: number;
  readonly unityEditorPath?: string;
  readonly scriptExecuteEnabled: boolean;
  readonly reflectionInvokeEnabled: boolean;
  readonly frameworkSync?: {
    readonly bootSync?: boolean;
    readonly watchEnabled?: boolean;
    readonly watchDebounceMs?: number;
    readonly gitFallbackEnabled?: boolean;
    readonly gitCacheDir?: string;
    readonly gitCacheMaxAgeMs?: number;
    readonly maxDriftScore?: number;
  };
}

export const DEFAULT_STRADA_CORE_REPO_URL = "https://github.com/okandemirel/Strada.Core.git";
export const DEFAULT_STRADA_MODULES_REPO_URL = "https://github.com/okandemirel/Strada.Modules.git";
export const DEFAULT_STRADA_MCP_REPO_URL = "https://github.com/okandemirel/Strada.MCP.git";
export const DEFAULT_LLM_STREAM_INITIAL_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_INTERACTION_CONFIG: InteractionConfig = {
  mode: "phase-driven",
  heartbeatAfterMs: 120_000,
  heartbeatIntervalMs: 300_000,
  escalationPolicy: "hard-blockers-only",
  narrativeEnabled: true,
  narrativeThrottleMs: 8_000,
};
export const DEFAULT_TASK_CONFIG: TaskConfig = {
  concurrencyLimit: 3,
  messageBurstWindowMs: 350,
  messageBurstMaxMessages: 8,
  interactiveMaxIterations: 25,
  interactiveTokenBudget: 500_000,
  backgroundEpochMaxIterations: 50,
  backgroundAutoContinue: true,
  backgroundMaxEpochs: 3,
};

// =============================================================================
// MAIN CONFIG TYPE
// =============================================================================

/** Unified budget configuration */
export interface BudgetConfig {
  readonly dailyLimitUsd: number;
  readonly monthlyLimitUsd: number;
  readonly warnPct: number;
}

/** Codebase Memory Vault configuration */
export interface VaultConfig {
  readonly enabled: boolean;
  readonly writeHookBudgetMs: number;
  readonly debounceMs: number;
  readonly embeddingFallback: 'none' | 'local';
}

/** Complete application configuration */
export interface Config {
  // AI Providers
  readonly anthropicApiKey?: string;
  readonly anthropicAuthMode?: AnthropicAuthMode;
  readonly anthropicAuthToken?: string;
  readonly openaiApiKey?: string;
  readonly openaiAuthMode: OpenAIAuthMode;
  readonly openaiChatgptAuthFile?: string;
  readonly openaiSubscriptionAccessToken?: string;
  readonly openaiSubscriptionAccountId?: string;
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
  readonly whatsapp: WhatsAppConfig;
  readonly matrix: MatrixConfig;
  readonly irc: IRCConfig;
  readonly teams: TeamsConfig;

  // Security
  readonly security: SecurityConfig;

  // Tasks
  readonly tasks: TaskConfig;

  // Interaction Policy
  readonly interaction: InteractionConfig;

  // Project
  readonly unityProjectPath: string;
  readonly strada: StradaDependencyConfig;

  // Dashboard
  readonly dashboard: DashboardConfig;
  readonly websocketDashboard: WebSocketDashboardConfig;
  readonly prometheus: PrometheusConfig;
  readonly modelIntelligence: ModelIntelligenceConfig;

  // Memory
  readonly memory: MemoryConfig;

  // RAG
  readonly rag: RAGConfig;

  // Features
  readonly streamingEnabled: boolean;
  readonly shellEnabled: boolean;
  readonly llmStreamInitialTimeoutMs: number;
  readonly llmStreamStallTimeoutMs: number;

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

  // Learning Pipeline v2
  readonly learningPipelineV2: {
    readonly confidenceWeights: number[];
    readonly maxInstincts: number;
    readonly detectionWindowSize: number;
    readonly periodicExtractionInterval: number;
  };

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
  readonly autonomousDefaultEnabled: boolean;
  /** Default duration in hours for autonomous mode when no duration is specified */
  readonly autonomousDefaultHours: number;

  // Conformance Guard
  readonly conformanceEnabled: boolean;
  readonly conformanceFrameworkPathsOnly: boolean;
  // Control Loop
  readonly loopFingerprintThreshold: number;
  readonly loopFingerprintWindow: number;
  readonly loopDensityThreshold: number;
  readonly loopDensityWindow: number;
  readonly loopMaxRecoveryEpisodes: number;
  readonly loopStaleAnalysisThreshold: number;
  readonly loopHardCapReplan: number;
  readonly loopHardCapBlock: number;
  readonly progressAssessmentEnabled: boolean;
  // Daemon Full Autonomy
  readonly daemonFullAutonomy: boolean;

  // Provider Routing
  readonly routing: {
    readonly preset: "budget" | "balanced" | "performance";
    readonly phaseSwitching: boolean;
  };

  // Consensus
  readonly consensus: {
    readonly mode: "auto" | "critical-only" | "always" | "disabled";
    readonly threshold: number;
    readonly maxProviders: number;
  };

  // Auto-Update
  readonly autoUpdate: {
    readonly enabled: boolean;
    readonly intervalHours: number;
    readonly idleTimeoutMin: number;
    readonly channel: "stable" | "latest";
    readonly notify: boolean;
    readonly autoRestart: boolean;
  };

  // Supervisor Brain
  readonly supervisor: SupervisorConfig;

  // Unified Budget System
  readonly budget: BudgetConfig;

  // Codebase Memory Vault
  readonly vault: VaultConfig;
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
  .transform((s) => s.split(",").map((id) => parseInt(id.trim(), 10)))
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
    providerChain: z.string().optional(),

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
    websocketDashboardPort: portSchema.default("3100"),
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
    vaultEnabled: z.string().optional().default("false").transform((s) => s === "true" || s === "1"),
    vaultWriteHookBudgetMs: z
      .string()
      .optional()
      .default("200")
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().positive()),
    vaultDebounceMs: z
      .string()
      .optional()
      .default("800")
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().positive()),
    vaultEmbeddingFallback: z.enum(["none", "local"]).default("local"),

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
    delegationMaxIterationsPerType: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().min(1).max(50))
      .default("10"),

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
    anthropicAuthMode: rawConfig.anthropicAuthMode,
    anthropicAuthToken: rawConfig.anthropicAuthToken,
    openaiApiKey: rawConfig.openaiApiKey,
    openaiAuthMode: rawConfig.openaiAuthMode,
    openaiChatgptAuthFile: rawConfig.openaiChatgptAuthFile,
    openaiSubscriptionAccessToken: rawConfig.openaiSubscriptionAccessToken,
    openaiSubscriptionAccountId: rawConfig.openaiSubscriptionAccountId,
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
      allowedUserIds: rawConfig.allowedDiscordUserIds ?? [],
      allowedRoleIds: rawConfig.allowedDiscordRoleIds ?? [],
    },

    slack: {
      botToken: rawConfig.slackBotToken,
      signingSecret: rawConfig.slackSigningSecret,
      appToken: rawConfig.slackAppToken,
      socketMode: rawConfig.slackSocketMode,
      allowedWorkspaces: rawConfig.allowedSlackWorkspaces,
      allowedUserIds: rawConfig.allowedSlackUserIds,
    },

    whatsapp: {
      sessionPath: rawConfig.whatsappSessionPath,
      allowedNumbers: rawConfig.whatsappAllowedNumbers ?? [],
    },

    matrix: {
      homeserver: rawConfig.matrixHomeserver,
      accessToken: rawConfig.matrixAccessToken,
      userId: rawConfig.matrixUserId,
      allowedUserIds: rawConfig.matrixAllowedUserIds ?? [],
      allowedRoomIds: rawConfig.matrixAllowedRoomIds ?? [],
      allowOpenAccess: rawConfig.matrixAllowOpenAccess,
    },

    irc: {
      server: rawConfig.ircServer,
      nick: rawConfig.ircNick,
      channels: rawConfig.ircChannels ?? [],
      allowedUsers: rawConfig.ircAllowedUsers ?? [],
      allowOpenAccess: rawConfig.ircAllowOpenAccess,
    },

    teams: {
      appId: rawConfig.teamsAppId,
      appPassword: rawConfig.teamsAppPassword,
      allowedUserIds: rawConfig.teamsAllowedUserIds ?? [],
      allowOpenAccess: rawConfig.teamsAllowOpenAccess,
    },

    security: {
      systemAuth: {
        jwtSecret: rawConfig.jwtSecret,
        requireMfa: rawConfig.requireMfa,
      },
      requireEditConfirmation: rawConfig.requireEditConfirmation,
      readOnlyMode: rawConfig.readOnlyMode,
    },

    tasks: {
      concurrencyLimit: rawConfig.taskMaxConcurrent,
      messageBurstWindowMs: rawConfig.taskMessageBurstWindowMs,
      messageBurstMaxMessages: rawConfig.taskMessageBurstMaxMessages,
      interactiveMaxIterations: rawConfig.taskInteractiveMaxIterations,
      interactiveTokenBudget: rawConfig.taskInteractiveTokenBudget,
      backgroundEpochMaxIterations: rawConfig.taskBackgroundEpochMaxIterations,
      backgroundAutoContinue: rawConfig.taskBackgroundAutoContinue,
      backgroundMaxEpochs: rawConfig.taskBackgroundMaxEpochs,
    },

    interaction: {
      mode: rawConfig.interactionMode,
      heartbeatAfterMs: rawConfig.interactionHeartbeatAfterMs,
      heartbeatIntervalMs: rawConfig.interactionHeartbeatIntervalMs,
      escalationPolicy: rawConfig.interactionEscalationPolicy,
    },

    unityProjectPath: rawConfig.unityProjectPath,
    strada: {
      coreRepoUrl: rawConfig.stradaCoreRepoUrl,
      modulesRepoUrl: rawConfig.stradaModulesRepoUrl,
      mcpRepoUrl: rawConfig.stradaMcpRepoUrl,
      mcpPath: rawConfig.stradaMcpPath,
      unityBridgePort: rawConfig.unityBridgePort,
      unityBridgeAutoConnect: rawConfig.unityBridgeAutoConnect,
      unityBridgeTimeout: rawConfig.unityBridgeTimeout,
      unityEditorPath: rawConfig.unityEditorPath,
      scriptExecuteEnabled: rawConfig.scriptExecuteEnabled,
      reflectionInvokeEnabled: rawConfig.reflectionInvokeEnabled,
    },

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

    modelIntelligence: {
      enabled: rawConfig.modelIntelligenceEnabled,
      refreshHours: rawConfig.modelIntelligenceRefreshHours,
      dbPath: rawConfig.modelIntelligenceDbPath,
      providerSourcesPath: rawConfig.modelIntelligenceProviderSourcesPath,
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
        exemptDomains: rawConfig.memoryDecayExemptDomains
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean),
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
    llmStreamInitialTimeoutMs: rawConfig.llmStreamInitialTimeoutMs,
    llmStreamStallTimeoutMs: rawConfig.llmStreamStallTimeoutMs,

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

    learningPipelineV2: {
      confidenceWeights: rawConfig.stradaConfidenceWeights,
      maxInstincts: rawConfig.stradaMaxInstincts,
      detectionWindowSize: rawConfig.stradaDetectionWindowSize,
      periodicExtractionInterval: rawConfig.stradaPeriodicExtractionInterval,
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

    autonomousDefaultEnabled: rawConfig.autonomousDefaultEnabled,
    autonomousDefaultHours: rawConfig.autonomousDefaultHours,

    conformanceEnabled: rawConfig.conformanceEnabled,
    conformanceFrameworkPathsOnly: rawConfig.conformanceFrameworkPathsOnly,
    loopFingerprintThreshold: rawConfig.loopFingerprintThreshold,
    loopFingerprintWindow: rawConfig.loopFingerprintWindow,
    loopDensityThreshold: rawConfig.loopDensityThreshold,
    loopDensityWindow: rawConfig.loopDensityWindow,
    loopMaxRecoveryEpisodes: rawConfig.loopMaxRecoveryEpisodes,
    loopStaleAnalysisThreshold: rawConfig.loopStaleAnalysisThreshold,
    loopHardCapReplan: rawConfig.loopHardCapReplan,
    loopHardCapBlock: Math.max(rawConfig.loopHardCapBlock, rawConfig.loopHardCapReplan + 1),
    progressAssessmentEnabled: rawConfig.progressAssessmentEnabled,
    daemonFullAutonomy: rawConfig.daemonFullAutonomy,

    routing: {
      preset: rawConfig.routingPreset,
      phaseSwitching: rawConfig.routingPhaseSwitching,
    },

    consensus: {
      mode: rawConfig.consensusMode,
      threshold: rawConfig.consensusThreshold,
      maxProviders: rawConfig.consensusMaxProviders,
    },

    autoUpdate: {
      enabled: rawConfig.autoUpdateEnabled,
      intervalHours: rawConfig.autoUpdateIntervalHours,
      idleTimeoutMin: rawConfig.autoUpdateIdleTimeoutMin,
      channel: rawConfig.autoUpdateChannel,
      notify: rawConfig.autoUpdateNotify,
      autoRestart: rawConfig.autoUpdateAutoRestart,
    },

    supervisor: {
      enabled: rawConfig.stradaSupervisorEnabled,
      complexityThreshold: rawConfig.stradaSupervisorComplexityThreshold,
      maxParallelNodes: rawConfig.stradaSupervisorMaxParallelNodes,
      nodeTimeoutMs: rawConfig.stradaSupervisorNodeTimeoutMs,
      verificationMode: rawConfig.stradaSupervisorVerificationMode,
      verificationBudgetPct: rawConfig.stradaSupervisorVerificationBudgetPct,
      triageProvider: rawConfig.stradaSupervisorTriageProvider,
      maxFailureBudget: rawConfig.stradaSupervisorMaxFailureBudget,
      diversityCap: rawConfig.stradaSupervisorDiversityCap,
    },

    budget: {
      dailyLimitUsd: rawConfig.stradaBudgetDailyUsd,
      monthlyLimitUsd: rawConfig.stradaBudgetMonthlyUsd,
      warnPct: rawConfig.stradaBudgetWarnPct,
    },

    vault: {
      enabled: rawConfig.vaultEnabled,
      writeHookBudgetMs: rawConfig.vaultWriteHookBudgetMs,
      debounceMs: rawConfig.vaultDebounceMs,
      embeddingFallback: rawConfig.vaultEmbeddingFallback,
    },
  };

  // Cross-field validation: dashboardPort and websocketDashboardPort must differ when both enabled
  if (
    config.dashboard.enabled &&
    config.websocketDashboard.enabled &&
    config.dashboard.port === config.websocketDashboard.port
  ) {
    return {
      kind: "invalid",
      errors: [{
        path: "websocketDashboardPort",
        message: "dashboardPort and websocketDashboardPort must be different when both are enabled",
        code: "custom",
      }],
    };
  }

  return { kind: "valid", value: config };
}

/** Zod schema for DELEGATION_TYPES env var validation */
const DelegationTypeConfigSchema = z.array(
  z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    tier: z.enum(["local", "cheap", "standard", "premium"]),
    timeoutMs: z.number().int().min(5000).max(300000),
    maxIterations: z.number().int().min(1).max(50),
    systemPrompt: z.string().optional(),
  }),
);

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
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((ch) => VALID_CHANNELS.has(ch));
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
  anthropicAuthMode: string | undefined;
  anthropicAuthToken: string | undefined;
  openaiApiKey: string | undefined;
  openaiAuthMode: string | undefined;
  openaiChatgptAuthFile: string | undefined;
  openaiSubscriptionAccessToken: string | undefined;
  openaiSubscriptionAccountId: string | undefined;
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
  allowedDiscordUserIds: string | undefined;
  allowedDiscordRoleIds: string | undefined;
  slackBotToken: string | undefined;
  slackSigningSecret: string | undefined;
  slackAppToken: string | undefined;
  slackSocketMode: string | undefined;
  allowedSlackWorkspaces: string | undefined;
  allowedSlackUserIds: string | undefined;
  whatsappSessionPath: string | undefined;
  whatsappAllowedNumbers: string | undefined;
  matrixHomeserver: string | undefined;
  matrixAccessToken: string | undefined;
  matrixUserId: string | undefined;
  matrixAllowedUserIds: string | undefined;
  matrixAllowedRoomIds: string | undefined;
  matrixAllowOpenAccess: string | undefined;
  ircServer: string | undefined;
  ircNick: string | undefined;
  ircChannels: string | undefined;
  ircAllowedUsers: string | undefined;
  ircAllowOpenAccess: string | undefined;
  teamsAppId: string | undefined;
  teamsAppPassword: string | undefined;
  teamsAllowedUserIds: string | undefined;
  teamsAllowOpenAccess: string | undefined;
  jwtSecret: string | undefined;
  requireMfa: string | undefined;
  requireEditConfirmation: string | undefined;
  readOnlyMode: string | undefined;
  unityProjectPath: string | undefined;
  unityBridgePort: string | undefined;
  unityBridgeAutoConnect: string | undefined;
  unityBridgeTimeout: string | undefined;
  unityEditorPath: string | undefined;
  stradaCoreRepoUrl: string | undefined;
  stradaModulesRepoUrl: string | undefined;
  stradaMcpRepoUrl: string | undefined;
  stradaMcpPath: string | undefined;
  scriptExecuteEnabled: string | undefined;
  reflectionInvokeEnabled: string | undefined;
  dashboardEnabled: string | undefined;
  dashboardPort: string | undefined;
  websocketDashboardEnabled: string | undefined;
  websocketDashboardPort: string | undefined;
  websocketDashboardAuthToken: string | undefined;
  websocketDashboardAllowedOrigins: string | undefined;
  prometheusEnabled: string | undefined;
  prometheusPort: string | undefined;
  modelIntelligenceEnabled: string | undefined;
  modelIntelligenceRefreshHours: string | undefined;
  modelIntelligenceDbPath: string | undefined;
  modelIntelligenceProviderSourcesPath: string | undefined;
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
  llmStreamInitialTimeoutMs: string | undefined;
  llmStreamStallTimeoutMs: string | undefined;
  rateLimitEnabled: string | undefined;
  rateLimitMessagesPerMinute: string | undefined;
  rateLimitMessagesPerHour: string | undefined;
  rateLimitTokensPerDay: string | undefined;
  rateLimitDailyBudgetUsd: string | undefined;
  rateLimitMonthlyBudgetUsd: string | undefined;
  // Unified Budget System
  stradaBudgetDailyUsd: string | undefined;
  stradaBudgetMonthlyUsd: string | undefined;
  stradaBudgetWarnPct: string | undefined;
  // Codebase Memory Vault
  vaultEnabled: string | undefined;
  vaultWriteHookBudgetMs: string | undefined;
  vaultDebounceMs: string | undefined;
  vaultEmbeddingFallback: string | undefined;
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
  // Task Delegation (Phase 24)
  taskDelegationEnabled: string | undefined;
  agentMaxDelegationDepth: string | undefined;
  agentMaxConcurrentDelegations: string | undefined;
  delegationTierLocal: string | undefined;
  delegationTierCheap: string | undefined;
  delegationTierStandard: string | undefined;
  delegationTierPremium: string | undefined;
  delegationVerbosity: string | undefined;
  delegationTypes: string | undefined;
  delegationMaxIterationsPerType: string | undefined;
  // Task routing
  taskMaxConcurrent: string | undefined;
  taskMessageBurstWindowMs: string | undefined;
  taskMessageBurstMaxMessages: string | undefined;
  taskInteractiveMaxIterations: string | undefined;
  taskInteractiveTokenBudget: string | undefined;
  taskBackgroundEpochMaxIterations: string | undefined;
  taskBackgroundAutoContinue: string | undefined;
  taskBackgroundMaxEpochs: string | undefined;
  // Interaction Policy
  interactionMode: string | undefined;
  interactionHeartbeatAfterMs: string | undefined;
  interactionHeartbeatIntervalMs: string | undefined;
  interactionEscalationPolicy: string | undefined;
  // Autonomous Mode
  autonomousDefaultEnabled: string | undefined;
  autonomousDefaultHours: string | undefined;
  // Conformance Guard
  conformanceEnabled: string | undefined;
  conformanceFrameworkPathsOnly: string | undefined;
  // Control Loop
  loopFingerprintThreshold: string | undefined;
  loopFingerprintWindow: string | undefined;
  loopDensityThreshold: string | undefined;
  loopDensityWindow: string | undefined;
  loopMaxRecoveryEpisodes: string | undefined;
  loopStaleAnalysisThreshold: string | undefined;
  loopHardCapReplan: string | undefined;
  loopHardCapBlock: string | undefined;
  progressAssessmentEnabled: string | undefined;
  // Daemon Full Autonomy
  daemonFullAutonomy: string | undefined;
  // Provider Routing
  routingPreset: string | undefined;
  routingPhaseSwitching: string | undefined;
  // Consensus
  consensusMode: string | undefined;
  consensusThreshold: string | undefined;
  consensusMaxProviders: string | undefined;
  // Auto-Update
  autoUpdateEnabled: string | undefined;
  autoUpdateIntervalHours: string | undefined;
  autoUpdateIdleTimeoutMin: string | undefined;
  autoUpdateChannel: string | undefined;
  autoUpdateNotify: string | undefined;
  autoUpdateAutoRestart: string | undefined;
  // Learning Pipeline v2
  stradaConfidenceWeights: string | undefined;
  stradaMaxInstincts: string | undefined;
  stradaDetectionWindowSize: string | undefined;
  stradaPeriodicExtractionInterval: string | undefined;
  // Supervisor Brain
  stradaSupervisorEnabled: string | undefined;
  stradaSupervisorComplexityThreshold: string | undefined;
  stradaSupervisorMaxParallelNodes: string | undefined;
  stradaSupervisorNodeTimeoutMs: string | undefined;
  stradaSupervisorVerificationMode: string | undefined;
  stradaSupervisorVerificationBudgetPct: string | undefined;
  stradaSupervisorTriageProvider: string | undefined;
  stradaSupervisorMaxFailureBudget: string | undefined;
  stradaSupervisorDiversityCap: string | undefined;
}

/**
 * Load configuration from environment variables
 */
function loadFromEnv(): EnvVars {
  return {
    anthropicApiKey: _env["ANTHROPIC_API_KEY"],
    anthropicAuthMode: _env["ANTHROPIC_AUTH_MODE"],
    anthropicAuthToken: _env["ANTHROPIC_AUTH_TOKEN"],
    openaiApiKey: _env["OPENAI_API_KEY"],
    openaiAuthMode: _env["OPENAI_AUTH_MODE"],
    openaiChatgptAuthFile: _env["OPENAI_CHATGPT_AUTH_FILE"],
    openaiSubscriptionAccessToken: _env["OPENAI_SUBSCRIPTION_ACCESS_TOKEN"],
    openaiSubscriptionAccountId: _env["OPENAI_SUBSCRIPTION_ACCOUNT_ID"],
    deepseekApiKey: _env["DEEPSEEK_API_KEY"],
    qwenApiKey: _env["QWEN_API_KEY"],
    kimiApiKey: _env["KIMI_API_KEY"],
    minimaxApiKey: _env["MINIMAX_API_KEY"],
    groqApiKey: _env["GROQ_API_KEY"],
    mistralApiKey: _env["MISTRAL_API_KEY"],
    togetherApiKey: _env["TOGETHER_API_KEY"],
    fireworksApiKey: _env["FIREWORKS_API_KEY"],
    geminiApiKey: _env["GEMINI_API_KEY"],
    providerChain: _env["PROVIDER_CHAIN"],
    telegramBotToken: _env["TELEGRAM_BOT_TOKEN"],
    allowedTelegramUserIds: _env["ALLOWED_TELEGRAM_USER_IDS"],
    discordBotToken: _env["DISCORD_BOT_TOKEN"],
    discordGuildId: _env["DISCORD_GUILD_ID"],
    allowedDiscordUserIds: _env["ALLOWED_DISCORD_USER_IDS"],
    allowedDiscordRoleIds: _env["ALLOWED_DISCORD_ROLE_IDS"],
    slackBotToken: _env["SLACK_BOT_TOKEN"],
    slackSigningSecret: _env["SLACK_SIGNING_SECRET"],
    slackAppToken: _env["SLACK_APP_TOKEN"],
    slackSocketMode: _env["SLACK_SOCKET_MODE"],
    allowedSlackWorkspaces: _env["ALLOWED_SLACK_WORKSPACES"],
    allowedSlackUserIds: _env["ALLOWED_SLACK_USER_IDS"],
    whatsappSessionPath: _env["WHATSAPP_SESSION_PATH"],
    whatsappAllowedNumbers: _env["WHATSAPP_ALLOWED_NUMBERS"],
    matrixHomeserver: _env["MATRIX_HOMESERVER"],
    matrixAccessToken: _env["MATRIX_ACCESS_TOKEN"],
    matrixUserId: _env["MATRIX_USER_ID"],
    matrixAllowedUserIds: _env["MATRIX_ALLOWED_USER_IDS"],
    matrixAllowedRoomIds: _env["MATRIX_ALLOWED_ROOM_IDS"],
    matrixAllowOpenAccess: _env["MATRIX_ALLOW_OPEN_ACCESS"],
    ircServer: _env["IRC_SERVER"],
    ircNick: _env["IRC_NICK"],
    ircChannels: _env["IRC_CHANNELS"],
    ircAllowedUsers: _env["IRC_ALLOWED_USERS"],
    ircAllowOpenAccess: _env["IRC_ALLOW_OPEN_ACCESS"],
    teamsAppId: _env["TEAMS_APP_ID"],
    teamsAppPassword: _env["TEAMS_APP_PASSWORD"],
    teamsAllowedUserIds: _env["TEAMS_ALLOWED_USER_IDS"],
    teamsAllowOpenAccess: _env["TEAMS_ALLOW_OPEN_ACCESS"],
    jwtSecret: _env["JWT_SECRET"],
    requireMfa: _env["REQUIRE_MFA"],
    requireEditConfirmation: _env["REQUIRE_EDIT_CONFIRMATION"],
    readOnlyMode: _env["READ_ONLY_MODE"],
    unityProjectPath: _env["UNITY_PROJECT_PATH"],
    unityBridgePort: _env["UNITY_BRIDGE_PORT"],
    unityBridgeAutoConnect: _env["UNITY_BRIDGE_AUTO_CONNECT"],
    unityBridgeTimeout: _env["UNITY_BRIDGE_TIMEOUT"],
    unityEditorPath: _env["UNITY_EDITOR_PATH"] ?? _env["UNITY_PATH"],
    stradaCoreRepoUrl: _env["STRADA_CORE_REPO_URL"],
    stradaModulesRepoUrl: _env["STRADA_MODULES_REPO_URL"],
    stradaMcpRepoUrl: _env["STRADA_MCP_REPO_URL"],
    stradaMcpPath: _env["STRADA_MCP_PATH"],
    scriptExecuteEnabled: _env["SCRIPT_EXECUTE_ENABLED"],
    reflectionInvokeEnabled: _env["REFLECTION_INVOKE_ENABLED"],
    dashboardEnabled: _env["DASHBOARD_ENABLED"],
    dashboardPort: _env["DASHBOARD_PORT"],
    websocketDashboardEnabled: _env["ENABLE_WEBSOCKET_DASHBOARD"],
    websocketDashboardPort: _env["WEBSOCKET_DASHBOARD_PORT"],
    websocketDashboardAuthToken: _env["WEBSOCKET_DASHBOARD_AUTH_TOKEN"],
    websocketDashboardAllowedOrigins: _env["WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS"],
    prometheusEnabled: _env["ENABLE_PROMETHEUS"],
    prometheusPort: _env["PROMETHEUS_PORT"],
    modelIntelligenceEnabled: _env["MODEL_INTELLIGENCE_ENABLED"],
    modelIntelligenceRefreshHours: _env["MODEL_INTELLIGENCE_REFRESH_HOURS"],
    modelIntelligenceDbPath: _env["MODEL_INTELLIGENCE_DB_PATH"],
    modelIntelligenceProviderSourcesPath: _env["MODEL_INTELLIGENCE_PROVIDER_SOURCES_PATH"],
    memoryEnabled: _env["MEMORY_ENABLED"],
    memoryDbPath: _env["MEMORY_DB_PATH"],
    memoryBackend: _env["MEMORY_BACKEND"],
    memoryDimensions: _env["MEMORY_DIMENSIONS"],
    memoryAutoTiering: _env["MEMORY_AUTO_TIERING"],
    memoryAutoTieringIntervalMs: _env["MEMORY_AUTO_TIERING_INTERVAL_MS"],
    memoryPromotionThreshold: _env["MEMORY_PROMOTION_THRESHOLD"],
    memoryDemotionTimeoutDays: _env["MEMORY_DEMOTION_TIMEOUT_DAYS"],
    memoryTierWorkingMax: _env["MEMORY_TIER_WORKING_MAX"],
    memoryTierEphemeralMax: _env["MEMORY_TIER_EPHEMERAL_MAX"],
    memoryTierPersistentMax: _env["MEMORY_TIER_PERSISTENT_MAX"],
    memoryEphemeralTtlHours: _env["MEMORY_EPHEMERAL_TTL_HOURS"],
    ragEnabled: _env["RAG_ENABLED"],
    embeddingProvider: _env["EMBEDDING_PROVIDER"],
    embeddingModel: _env["EMBEDDING_MODEL"],
    embeddingBaseUrl: _env["EMBEDDING_BASE_URL"],
    embeddingDimensions: _env["EMBEDDING_DIMENSIONS"],
    ragContextMaxTokens: _env["RAG_CONTEXT_MAX_TOKENS"],
    streamingEnabled: _env["STREAMING_ENABLED"],
    shellEnabled: _env["SHELL_ENABLED"],
    llmStreamInitialTimeoutMs: _env["LLM_STREAM_INITIAL_TIMEOUT_MS"],
    llmStreamStallTimeoutMs: _env["LLM_STREAM_STALL_TIMEOUT_MS"],
    rateLimitEnabled: _env["RATE_LIMIT_ENABLED"],
    rateLimitMessagesPerMinute: _env["RATE_LIMIT_MESSAGES_PER_MINUTE"],
    rateLimitMessagesPerHour: _env["RATE_LIMIT_MESSAGES_PER_HOUR"],
    rateLimitTokensPerDay: _env["RATE_LIMIT_TOKENS_PER_DAY"],
    rateLimitDailyBudgetUsd: _env["RATE_LIMIT_DAILY_BUDGET_USD"],
    rateLimitMonthlyBudgetUsd: _env["RATE_LIMIT_MONTHLY_BUDGET_USD"],
    // Unified Budget System
    stradaBudgetDailyUsd: _env["STRADA_BUDGET_DAILY_USD"],
    stradaBudgetMonthlyUsd: _env["STRADA_BUDGET_MONTHLY_USD"],
    stradaBudgetWarnPct: _env["STRADA_BUDGET_WARN_PCT"],
    // Codebase Memory Vault
    vaultEnabled: _env["STRADA_VAULT_ENABLED"],
    vaultWriteHookBudgetMs: _env["STRADA_VAULT_WRITE_HOOK_BUDGET_MS"],
    vaultDebounceMs: _env["STRADA_VAULT_DEBOUNCE_MS"],
    vaultEmbeddingFallback: _env["STRADA_VAULT_EMBEDDING_FALLBACK"],
    logLevel: _env["LOG_LEVEL"],
    logFile: _env["LOG_FILE"],
    webChannelPort: _env["WEB_CHANNEL_PORT"],
    pluginDirs: _env["PLUGIN_DIRS"],
    bayesianEnabled: _env["BAYESIAN_ENABLED"],
    bayesianDeprecatedThreshold: _env["BAYESIAN_DEPRECATED_THRESHOLD"],
    bayesianActiveThreshold: _env["BAYESIAN_ACTIVE_THRESHOLD"],
    bayesianEvolutionThreshold: _env["BAYESIAN_EVOLUTION_THRESHOLD"],
    bayesianAutoEvolveThreshold: _env["BAYESIAN_AUTO_EVOLVE_THRESHOLD"],
    bayesianMaxInitial: _env["BAYESIAN_MAX_INITIAL"],
    bayesianCoolingPeriodDays: _env["BAYESIAN_COOLING_PERIOD_DAYS"],
    bayesianCoolingMinObservations: _env["BAYESIAN_COOLING_MIN_OBSERVATIONS"],
    bayesianCoolingMaxFailures: _env["BAYESIAN_COOLING_MAX_FAILURES"],
    bayesianPromotionMinObservations: _env["BAYESIAN_PROMOTION_MIN_OBSERVATIONS"],
    bayesianVerdictCleanSuccess: _env["BAYESIAN_VERDICT_CLEAN_SUCCESS"],
    bayesianVerdictRetrySuccess: _env["BAYESIAN_VERDICT_RETRY_SUCCESS"],
    bayesianVerdictFailure: _env["BAYESIAN_VERDICT_FAILURE"],
    goalMaxDepth: _env["GOAL_MAX_DEPTH"],
    goalMaxRetries: _env["GOAL_MAX_RETRIES"],
    goalMaxFailures: _env["GOAL_MAX_FAILURES"],
    goalParallelExecution: _env["GOAL_PARALLEL_EXECUTION"],
    goalMaxParallel: _env["GOAL_MAX_PARALLEL"],
    stradaGoalEscalationTimeoutMinutes: _env["STRADA_GOAL_ESCALATION_TIMEOUT_MINUTES"],
    stradaGoalMaxRedecompositions: _env["STRADA_GOAL_MAX_REDECOMPOSITIONS"],
    toolChainEnabled: _env["TOOL_CHAIN_ENABLED"],
    toolChainMinOccurrences: _env["TOOL_CHAIN_MIN_OCCURRENCES"],
    toolChainSuccessRateThreshold: _env["TOOL_CHAIN_SUCCESS_RATE_THRESHOLD"],
    toolChainMaxActive: _env["TOOL_CHAIN_MAX_ACTIVE"],
    toolChainMaxAgeDays: _env["TOOL_CHAIN_MAX_AGE_DAYS"],
    toolChainLlmBudgetPerCycle: _env["TOOL_CHAIN_LLM_BUDGET_PER_CYCLE"],
    toolChainMinChainLength: _env["TOOL_CHAIN_MIN_CHAIN_LENGTH"],
    toolChainMaxChainLength: _env["TOOL_CHAIN_MAX_CHAIN_LENGTH"],
    toolChainDetectionIntervalMs: _env["TOOL_CHAIN_DETECTION_INTERVAL_MS"],
    crossSessionEnabled: _env["STRADA_CROSS_SESSION_ENABLED"],
    crossSessionMaxAgeDays: _env["STRADA_INSTINCT_MAX_AGE_DAYS"],
    crossSessionScopeFilter: _env["STRADA_INSTINCT_SCOPE_FILTER"],
    crossSessionRecencyBoost: _env["STRADA_INSTINCT_RECENCY_BOOST"],
    crossSessionScopeBoost: _env["STRADA_INSTINCT_SCOPE_BOOST"],
    crossSessionPromotionThreshold: _env["STRADA_INSTINCT_PROMOTION_THRESHOLD"],
    agentName: _env["STRADA_AGENT_NAME"],
    language: _env["LANGUAGE_PREFERENCE"],
    daemonIntervalMs: _env["STRADA_DAEMON_INTERVAL_MS"],
    daemonTimezone: _env["STRADA_DAEMON_TIMEZONE"],
    daemonHeartbeatFile: _env["STRADA_DAEMON_HEARTBEAT_FILE"],
    daemonDailyBudget: _env["STRADA_DAEMON_DAILY_BUDGET"],
    daemonBudgetWarnPct: _env["STRADA_DAEMON_BUDGET_WARN_PCT"],
    daemonApprovalTimeoutMin: _env["STRADA_DAEMON_APPROVAL_TIMEOUT_MINUTES"],
    daemonAutoApproveTools: _env["STRADA_DAEMON_AUTO_APPROVE_TOOLS"],
    daemonBackoffBase: _env["STRADA_DAEMON_BACKOFF_BASE"],
    daemonBackoffMax: _env["STRADA_DAEMON_BACKOFF_MAX"],
    daemonFailureThreshold: _env["STRADA_DAEMON_FAILURE_THRESHOLD"],
    daemonIdlePause: _env["STRADA_DAEMON_IDLE_PAUSE"],
    webhookSecret: _env["STRADA_WEBHOOK_SECRET"],
    webhookRateLimit: _env["STRADA_WEBHOOK_RATE_LIMIT"],
    daemonDedupWindowMs: _env["STRADA_DAEMON_DEDUP_WINDOW_MS"],
    daemonDefaultDebounceMs: _env["STRADA_DAEMON_DEFAULT_DEBOUNCE_MS"],
    checklistMorningHour: _env["STRADA_CHECKLIST_MORNING_HOUR"],
    checklistAfternoonHour: _env["STRADA_CHECKLIST_AFTERNOON_HOUR"],
    checklistEveningHour: _env["STRADA_CHECKLIST_EVENING_HOUR"],
    // Trigger Fire History Pruning (Phase 21)
    triggerFireRetentionDays: _env["TRIGGER_FIRE_RETENTION_DAYS"],
    // Notification, Quiet Hours, Digest (Phase 18)
    stradaDigestEnabled: _env["STRADA_DIGEST_ENABLED"],
    stradaDigestSchedule: _env["STRADA_DIGEST_SCHEDULE"],
    stradaNotifyMinLevel: _env["STRADA_NOTIFY_MIN_LEVEL"],
    stradaNotifySilent: _env["STRADA_NOTIFY_SILENT"],
    stradaNotifyLow: _env["STRADA_NOTIFY_LOW"],
    stradaNotifyMedium: _env["STRADA_NOTIFY_MEDIUM"],
    stradaNotifyHigh: _env["STRADA_NOTIFY_HIGH"],
    stradaNotifyCritical: _env["STRADA_NOTIFY_CRITICAL"],
    stradaQuietStart: _env["STRADA_QUIET_START"],
    stradaQuietEnd: _env["STRADA_QUIET_END"],
    stradaQuietBufferMax: _env["STRADA_QUIET_BUFFER_MAX"],
    stradaDashboardHistoryDepth: _env["STRADA_DASHBOARD_HISTORY_DEPTH"],
    // Memory Re-Retrieval (Phase 17)
    stradaMemoryReRetrievalEnabled: _env["STRADA_MEMORY_RERETRIEVAL_ENABLED"],
    stradaMemoryReRetrievalInterval: _env["STRADA_MEMORY_RERETRIEVAL_INTERVAL"],
    stradaMemoryTopicShiftEnabled: _env["STRADA_MEMORY_TOPIC_SHIFT_ENABLED"],
    stradaMemoryTopicShiftThreshold: _env["STRADA_MEMORY_TOPIC_SHIFT_THRESHOLD"],
    stradaMemoryMaxReRetrievals: _env["STRADA_MEMORY_MAX_RERETRIEVALS"],
    stradaMemoryReRetrievalTimeoutMs: _env["STRADA_MEMORY_RERETRIEVAL_TIMEOUT_MS"],
    stradaMemoryReRetrievalMemoryLimit: _env["STRADA_MEMORY_RERETRIEVAL_MEMORY_LIMIT"],
    stradaMemoryReRetrievalRagTopK: _env["STRADA_MEMORY_RERETRIEVAL_RAG_TOPK"],
    // Memory Decay (Phase 21)
    memoryDecayEnabled: _env["MEMORY_DECAY_ENABLED"],
    memoryDecayLambdaWorking: _env["MEMORY_DECAY_LAMBDA_WORKING"],
    memoryDecayLambdaEphemeral: _env["MEMORY_DECAY_LAMBDA_EPHEMERAL"],
    memoryDecayLambdaPersistent: _env["MEMORY_DECAY_LAMBDA_PERSISTENT"],
    memoryDecayExemptDomains: _env["MEMORY_DECAY_EXEMPT_DOMAINS"],
    memoryDecayTimeoutMs: _env["MEMORY_DECAY_TIMEOUT_MS"],
    // Memory Consolidation (Phase 25)
    memoryConsolidationEnabled: _env["MEMORY_CONSOLIDATION_ENABLED"],
    memoryConsolidationIdleMinutes: _env["MEMORY_CONSOLIDATION_IDLE_MINUTES"],
    memoryConsolidationThreshold: _env["MEMORY_CONSOLIDATION_THRESHOLD"],
    memoryConsolidationBatchSize: _env["MEMORY_CONSOLIDATION_BATCH_SIZE"],
    memoryConsolidationMinClusterSize: _env["MEMORY_CONSOLIDATION_MIN_CLUSTER_SIZE"],
    memoryConsolidationMaxDepth: _env["MEMORY_CONSOLIDATION_MAX_DEPTH"],
    memoryConsolidationModelTier: _env["MEMORY_CONSOLIDATION_MODEL_TIER"],
    // Chain Resilience (Phase 22)
    chainRollbackEnabled: _env["CHAIN_ROLLBACK_ENABLED"],
    chainParallelEnabled: _env["CHAIN_PARALLEL_ENABLED"],
    chainMaxParallelBranches: _env["CHAIN_MAX_PARALLEL_BRANCHES"],
    chainCompensationTimeoutMs: _env["CHAIN_COMPENSATION_TIMEOUT_MS"],
    // Multi-Agent (Phase 23)
    multiAgentEnabled: _env["MULTI_AGENT_ENABLED"],
    agentDefaultBudgetUsd: _env["AGENT_DEFAULT_BUDGET_USD"],
    agentMaxConcurrent: _env["AGENT_MAX_CONCURRENT"],
    agentIdleTimeoutMs: _env["AGENT_IDLE_TIMEOUT_MS"],
    agentMaxMemoryEntries: _env["AGENT_MAX_MEMORY_ENTRIES"],
    // Task Delegation (Phase 24)
    taskDelegationEnabled: _env["TASK_DELEGATION_ENABLED"],
    agentMaxDelegationDepth: _env["AGENT_MAX_DELEGATION_DEPTH"],
    agentMaxConcurrentDelegations: _env["AGENT_MAX_CONCURRENT_DELEGATIONS"],
    delegationTierLocal: _env["DELEGATION_TIER_LOCAL"],
    delegationTierCheap: _env["DELEGATION_TIER_CHEAP"],
    delegationTierStandard: _env["DELEGATION_TIER_STANDARD"],
    delegationTierPremium: _env["DELEGATION_TIER_PREMIUM"],
    delegationVerbosity: _env["DELEGATION_VERBOSITY"],
    delegationTypes: _env["DELEGATION_TYPES"],
    delegationMaxIterationsPerType: _env["DELEGATION_MAX_ITERATIONS_PER_TYPE"],
    taskMaxConcurrent: _env["TASK_MAX_CONCURRENT"],
    taskMessageBurstWindowMs: _env["TASK_MESSAGE_BURST_WINDOW_MS"],
    taskMessageBurstMaxMessages: _env["TASK_MESSAGE_BURST_MAX_MESSAGES"],
    taskInteractiveMaxIterations: _env["TASK_INTERACTIVE_MAX_ITERATIONS"],
    taskInteractiveTokenBudget: _env["TASK_INTERACTIVE_TOKEN_BUDGET"],
    taskBackgroundEpochMaxIterations: _env["TASK_BACKGROUND_EPOCH_MAX_ITERATIONS"],
    taskBackgroundAutoContinue: _env["TASK_BACKGROUND_AUTO_CONTINUE"],
    taskBackgroundMaxEpochs: _env["TASK_BACKGROUND_MAX_EPOCHS"],
    interactionMode: _env["INTERACTION_MODE"],
    interactionHeartbeatAfterMs: _env["INTERACTION_HEARTBEAT_AFTER_MS"],
    interactionHeartbeatIntervalMs: _env["INTERACTION_HEARTBEAT_INTERVAL_MS"],
    interactionEscalationPolicy: _env["INTERACTION_ESCALATION_POLICY"],
    // Autonomous Mode
    autonomousDefaultEnabled: _env["AUTONOMOUS_DEFAULT_ENABLED"],
    autonomousDefaultHours: _env["AUTONOMOUS_DEFAULT_HOURS"],
    // Conformance Guard
    conformanceEnabled: _env["STRADA_CONFORMANCE_ENABLED"],
    conformanceFrameworkPathsOnly: _env["STRADA_CONFORMANCE_FRAMEWORK_PATHS_ONLY"],
    // Control Loop
    loopFingerprintThreshold: _env["STRADA_LOOP_FINGERPRINT_THRESHOLD"],
    loopFingerprintWindow: _env["STRADA_LOOP_FINGERPRINT_WINDOW"],
    loopDensityThreshold: _env["STRADA_LOOP_DENSITY_THRESHOLD"],
    loopDensityWindow: _env["STRADA_LOOP_DENSITY_WINDOW"],
    loopMaxRecoveryEpisodes: _env["STRADA_LOOP_MAX_RECOVERY_EPISODES"],
    loopStaleAnalysisThreshold: _env["STRADA_LOOP_STALE_ANALYSIS_THRESHOLD"],
    loopHardCapReplan: _env["STRADA_LOOP_HARD_CAP_REPLAN"],
    loopHardCapBlock: _env["STRADA_LOOP_HARD_CAP_BLOCK"],
    progressAssessmentEnabled: _env["STRADA_PROGRESS_ASSESSMENT_ENABLED"],
    // Daemon Full Autonomy
    daemonFullAutonomy: _env["STRADA_DAEMON_FULL_AUTONOMY"],
    // Provider Routing
    routingPreset: _env["ROUTING_PRESET"],
    routingPhaseSwitching: _env["ROUTING_PHASE_SWITCHING"],
    // Consensus
    consensusMode: _env["CONSENSUS_MODE"],
    consensusThreshold: _env["CONSENSUS_THRESHOLD"],
    consensusMaxProviders: _env["CONSENSUS_MAX_PROVIDERS"],
    // Auto-Update
    autoUpdateEnabled: _env["AUTO_UPDATE_ENABLED"],
    autoUpdateIntervalHours: _env["AUTO_UPDATE_INTERVAL_HOURS"],
    autoUpdateIdleTimeoutMin: _env["AUTO_UPDATE_IDLE_TIMEOUT_MIN"],
    autoUpdateChannel: _env["AUTO_UPDATE_CHANNEL"],
    autoUpdateNotify: _env["AUTO_UPDATE_NOTIFY"],
    autoUpdateAutoRestart: _env["AUTO_UPDATE_AUTO_RESTART"],
    // Learning Pipeline v2
    stradaConfidenceWeights: _env["STRADA_CONFIDENCE_WEIGHTS"],
    stradaMaxInstincts: _env["STRADA_MAX_INSTINCTS"],
    stradaDetectionWindowSize: _env["STRADA_DETECTION_WINDOW_SIZE"],
    stradaPeriodicExtractionInterval: _env["STRADA_PERIODIC_EXTRACTION_INTERVAL"],
    // Supervisor Brain
    stradaSupervisorEnabled: _env["SUPERVISOR_ENABLED"],
    stradaSupervisorComplexityThreshold: _env["SUPERVISOR_COMPLEXITY_THRESHOLD"],
    stradaSupervisorMaxParallelNodes: _env["SUPERVISOR_MAX_PARALLEL_NODES"],
    stradaSupervisorNodeTimeoutMs: _env["SUPERVISOR_NODE_TIMEOUT_MS"],
    stradaSupervisorVerificationMode: _env["SUPERVISOR_VERIFICATION_MODE"],
    stradaSupervisorVerificationBudgetPct: _env["SUPERVISOR_VERIFICATION_BUDGET_PCT"],
    stradaSupervisorTriageProvider: _env["SUPERVISOR_TRIAGE_PROVIDER"],
    stradaSupervisorMaxFailureBudget: _env["SUPERVISOR_MAX_FAILURE_BUDGET"],
    stradaSupervisorDiversityCap: _env["SUPERVISOR_DIVERSITY_CAP"],
  };
}

// =============================================================================
// CONFIG LOADING
// =============================================================================

let cachedConfig: Config | null = null;

/** Active env source — overridable for testing via loadConfig(envOverride) */
let _env: Record<string, string | undefined> = process.env;

/**
 * Load and validate configuration from environment.
 * Pass an env override map (e.g. in tests) to read from that map instead of process.env.
 * When an override is provided the result is NOT cached.
 */
export function loadConfig(envOverride?: Record<string, string | undefined>): Config {
  if (!envOverride && cachedConfig) return cachedConfig;

  const prevEnv = _env;
  _env = envOverride ?? process.env;
  try {
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
  const presetName = _env["SYSTEM_PRESET"];
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
  for (const p of [
    "openai",
    "deepseek",
    "qwen",
    "kimi",
    "minimax",
    "groq",
    "mistral",
    "together",
    "fireworks",
    "gemini",
    "claude",
    "ollama",
  ]) {
    const val = _env[`${p.toUpperCase()}_MODEL`];
    if (val) providerModels[p] = val;
  }

  // Update with resolved path + preset overrides
  // Preset overrides must be applied to the correct nested config paths
  const presetRagOverrides = preset ? {
    ...(!_env["EMBEDDING_PROVIDER"] ? { provider: preset.embeddingProvider } : {}),
    ...(!_env["EMBEDDING_MODEL"] ? { model: preset.embeddingModel } : {}),
    ...(!_env["EMBEDDING_BASE_URL"] && preset.embeddingBaseUrl ? { baseUrl: preset.embeddingBaseUrl } : {}),
  } : {};
  const presetDelegationTierOverrides = preset ? {
    ...(!_env["DELEGATION_TIER_LOCAL"] ? { local: preset.delegationTierLocal } : {}),
    ...(!_env["DELEGATION_TIER_CHEAP"] ? { cheap: preset.delegationTierCheap } : {}),
    ...(!_env["DELEGATION_TIER_STANDARD"] ? { standard: preset.delegationTierStandard } : {}),
    ...(!_env["DELEGATION_TIER_PREMIUM"] ? { premium: preset.delegationTierPremium } : {}),
  } : {};

  const resolved: Config = {
    ...config,
    unityProjectPath: pathResult.value,
    providerModels,
    // Preset fills in defaults; explicit env vars take precedence (already parsed by Zod above)
    ...(preset && !_env["PROVIDER_CHAIN"] ? { providerChain: preset.providerChain } : {}),
    // Apply embedding overrides to the nested rag config
    ...(Object.keys(presetRagOverrides).length > 0 ? {
      rag: { ...config.rag, ...presetRagOverrides },
    } : {}),
    // Apply delegation tier overrides to the nested delegation.tiers config
    ...(Object.keys(presetDelegationTierOverrides).length > 0 ? {
      delegation: {
        ...config.delegation,
        tiers: { ...config.delegation.tiers, ...presetDelegationTierOverrides },
      },
    } : {}),
  } as Config;
  if (!envOverride) {
    cachedConfig = resolved;
  }

  return resolved;
  } finally {
    _env = prevEnv;
  }
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
      claude: config.anthropicApiKey ?? (
        config.anthropicAuthMode === "claude-subscription" ? config.anthropicAuthToken : undefined
      ),
      anthropic: config.anthropicApiKey ?? (
        config.anthropicAuthMode === "claude-subscription" ? config.anthropicAuthToken : undefined
      ),
      openai:
        config.openaiApiKey ??
        (config.openaiAuthMode === "chatgpt-subscription" ||
        Boolean(config.openaiSubscriptionAccessToken && config.openaiSubscriptionAccountId) ||
        Boolean(config.openaiChatgptAuthFile)
          ? "[chatgpt-subscription]"
          : undefined),
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
        if (name === "claude" || name === "anthropic") {
          const hasSubscription =
            config.anthropicAuthMode === "claude-subscription"
            && Boolean(config.anthropicAuthToken);
          if (!hasSubscription) {
            missing.push("ANTHROPIC_API_KEY");
          }
          continue;
        }
        if (name === "openai") {
          const hasSubscription =
            config.openaiAuthMode === "chatgpt-subscription" ||
            Boolean(config.openaiSubscriptionAccessToken && config.openaiSubscriptionAccountId) ||
            Boolean(config.openaiChatgptAuthFile);
          if (!hasSubscription) {
            missing.push("OPENAI_API_KEY");
          }
          continue;
        }
        missing.push(`${name.toUpperCase()}_API_KEY`);
      }
    }
  } else if (
    !config.anthropicApiKey
    && !(config.anthropicAuthMode === "claude-subscription" && config.anthropicAuthToken)
  ) {
    // No chain specified and no Anthropic key — check if any key exists
    const hasAny = [
      config.anthropicApiKey ?? (
        config.anthropicAuthMode === "claude-subscription" ? config.anthropicAuthToken : undefined
      ),
      config.openaiApiKey ??
        (config.openaiAuthMode === "chatgpt-subscription" ||
        Boolean(config.openaiSubscriptionAccessToken && config.openaiSubscriptionAccountId) ||
        Boolean(config.openaiChatgptAuthFile)
          ? "[chatgpt-subscription]"
          : undefined),
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
  channelType:
    | "telegram"
    | "discord"
    | "slack"
    | "whatsapp"
    | "matrix"
    | "irc"
    | "teams"
    | "cli"
    | "web",
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
      if (
        config.discord.allowedUserIds.length === 0 &&
        config.discord.allowedRoleIds.length === 0
      ) {
        errors.push("ALLOWED_DISCORD_USER_IDS or ALLOWED_DISCORD_ROLE_IDS must be set");
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

    case "whatsapp":
      if (!config.whatsapp.sessionPath) {
        errors.push("WHATSAPP_SESSION_PATH is required");
      }
      break;

    case "matrix":
      if (!config.matrix.homeserver || !config.matrix.accessToken || !config.matrix.userId) {
        errors.push("MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, and MATRIX_USER_ID are required");
      }
      break;

    case "irc":
      if (!config.irc.server) {
        errors.push("IRC_SERVER is required");
      }
      break;

    case "teams":
      if (!config.teams.appId || !config.teams.appPassword) {
        errors.push("TEAMS_APP_ID and TEAMS_APP_PASSWORD are required");
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
  if (env.ANTHROPIC_AUTH_MODE) raw.anthropicAuthMode = env.ANTHROPIC_AUTH_MODE;
  if (env.ANTHROPIC_AUTH_TOKEN) raw.anthropicAuthToken = env.ANTHROPIC_AUTH_TOKEN;
  if (env.OPENAI_API_KEY) raw.openaiApiKey = env.OPENAI_API_KEY;
  if (env.OPENAI_AUTH_MODE) raw.openaiAuthMode = env.OPENAI_AUTH_MODE;
  if (env.OPENAI_CHATGPT_AUTH_FILE) raw.openaiChatgptAuthFile = env.OPENAI_CHATGPT_AUTH_FILE;
  if (env.OPENAI_SUBSCRIPTION_ACCESS_TOKEN)
    raw.openaiSubscriptionAccessToken = env.OPENAI_SUBSCRIPTION_ACCESS_TOKEN;
  if (env.OPENAI_SUBSCRIPTION_ACCOUNT_ID)
    raw.openaiSubscriptionAccountId = env.OPENAI_SUBSCRIPTION_ACCOUNT_ID;
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
    whatsapp: { ...base.whatsapp, ...partial.whatsapp },
    matrix: { ...base.matrix, ...partial.matrix },
    irc: { ...base.irc, ...partial.irc },
    teams: { ...base.teams, ...partial.teams },
    security: {
      ...base.security,
      ...partial.security,
      systemAuth: {
        ...base.security.systemAuth,
        ...(partial.security?.systemAuth ?? {}),
      },
    },
    dashboard: { ...base.dashboard, ...partial.dashboard },
    websocketDashboard: { ...base.websocketDashboard, ...partial.websocketDashboard },
    prometheus: { ...base.prometheus, ...partial.prometheus },
    modelIntelligence: {
      ...base.modelIntelligence,
      ...((partial as Partial<Config>).modelIntelligence ?? {}),
    },
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
    goalParallelExecution:
      (partial as Partial<Config>).goalParallelExecution ?? base.goalParallelExecution,
    goalMaxParallel: (partial as Partial<Config>).goalMaxParallel ?? base.goalMaxParallel,
    goal: { ...base.goal, ...((partial as Partial<Config>).goal ?? {}) },
    tasks: { ...base.tasks, ...((partial as Partial<Config>).tasks ?? {}) },
    interaction: { ...base.interaction, ...((partial as Partial<Config>).interaction ?? {}) },
    toolChain: { ...base.toolChain, ...(partial as Partial<Config>).toolChain },
    crossSession: { ...base.crossSession, ...(partial as Partial<Config>).crossSession },
    reRetrieval: { ...base.reRetrieval, ...((partial as Partial<Config>).reRetrieval ?? {}) },
    notification: { ...base.notification, ...((partial as Partial<Config>).notification ?? {}) },
    quietHours: { ...base.quietHours, ...((partial as Partial<Config>).quietHours ?? {}) },
    digest: { ...base.digest, ...((partial as Partial<Config>).digest ?? {}) },
  } as Config;
}
