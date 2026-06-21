/**
 * Config types for Strada.Brain
 *
 * All pure TypeScript type/interface declarations and compile-time constants
 * extracted from config.ts (plan 028). No runtime side-effects here.
 *
 * Imported by:
 *   - config-schema.ts  (Zod schema helpers reference DEFAULT_* constants + interfaces)
 *   - config.ts         (re-exports everything; keeps loadConfig/validateConfig/assembly)
 */

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
  | "OPENCODE_API_KEY"
  | "OPENCODE_BASE_URL"
  | "OPENCODE_DEFAULT_MODEL"
  | "OPENROUTER_API_KEY"
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
  | "TEAMS_APP_TYPE"
  | "TEAMS_APP_TENANT_ID"
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
  | "STRADA_MCP_REPO_URL"
  | "STRADA_MCP_PATH"
  | "OBSIDIAN_ENABLED"
  | "OBSIDIAN_API_URL"
  | "OBSIDIAN_API_KEY"
  | "OBSIDIAN_VAULT_PATH"
  | "OBSIDIAN_CERT_PATH"
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
  | "WEB_CHANNEL_PORT"
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
  | "OPENROUTER_MODEL"
  | "CLAUDE_MODEL"
  | "OLLAMA_MODEL"
  | "OLLAMA_BASE_URL"
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
  | "DEPLOY_ROLLBACK_SCRIPT_PATH"

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
  | "STRADA_VAULT_SELF_ENABLED"
  | "STRADA_VAULT_WRITE_HOOK_BUDGET_MS"
  | "STRADA_VAULT_DEBOUNCE_MS"
  | "STRADA_VAULT_EMBEDDING_FALLBACK";

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
  | "opencode"
  | "openrouter"
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

/** Microsoft Teams / Bot Framework app tenancy model */
export type TeamsAppType = "MultiTenant" | "SingleTenant";

/** Teams configuration */
export interface TeamsConfig {
  readonly appId?: string;
  readonly appPassword?: string;
  /**
   * Bot Framework app tenancy. Single-tenant bots must be issued tokens scoped
   * to their home tenant, so proactive (continueConversationAsync) sends fail
   * unless the adapter is told the tenancy + tenant id. Defaults to MultiTenant.
   */
  readonly appType?: TeamsAppType;
  /** Home tenant id, required for single-tenant proactive sends. */
  readonly appTenantId?: string;
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
/**
 * Per-attempt FIRST-RESPONSE timeout for the provider fallback chain — how long a
 * single provider may stay silent (no response / no first stream chunk) before the
 * attempt is aborted, counted as a failure, and the chain fails over (or fails fast
 * for a single provider). Deliberately MUCH shorter than the stream-initial window
 * above (which is the orchestrator's full thinking/first-token budget): a provider
 * that emits literally nothing for ~90s is dead, and waiting the full 10 min to
 * discover that is the difference between a fast failover and a hung request.
 */
export const DEFAULT_LLM_PROVIDER_FIRST_RESPONSE_TIMEOUT_MS = 90 * 1000;
/**
 * Default per-task INACTIVITY window (ms). A task is aborted only after it has produced
 * NO progress update for this long (not a hard wall-clock cap), so a reasoning model that
 * legitimately spends minutes on a single step is not killed mid-flight, while a genuinely
 * hung task still cannot block the conversation forever. Lives here beside the LLM stream
 * timeouts above so the orchestrator's PolicySeed and the background executor share ONE
 * source. The streaming stall watchdog (DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS) independently
 * detects dead provider connections during a single LLM call.
 */
export const DEFAULT_TASK_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
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
  readonly self: {
    readonly enabled: boolean;
  };
}

/** Obsidian vault integration configuration */
export interface ObsidianConfig {
  readonly enabled: boolean;
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly vaultPath: string;
  readonly certPath?: string;
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
  readonly opencodeApiKey?: string;
  readonly opencodeBaseUrl?: string;
  readonly opencodeDefaultModel?: string;
  readonly openrouterApiKey?: string;
  readonly ollamaBaseUrl?: string;
  /** Comma-separated provider names for fallback chain */
  readonly providerChain?: string;
  /** Per-provider model overrides (env: {PROVIDER}_MODEL) */
  readonly providerModels?: Record<string, string>;
  /**
   * Per-provider base-URL overrides applied at provider construction time.
   * Currently sourced from OPENCODE_BASE_URL (opencode); ollama's base URL is
   * threaded separately via ollamaBaseUrl. Keyed by canonical provider name.
   */
  readonly providerBaseUrls?: Record<string, string>;

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
  /** Per-attempt first-response timeout (ms) for the provider fallback chain. */
  readonly llmProviderFirstResponseTimeoutMs: number;

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

  // Obsidian Integration
  readonly obsidian: ObsidianConfig;
}
