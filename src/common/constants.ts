/**
 * Application Constants
 *
 * Centralized location for all magic numbers, default values,
 * limits, and thresholds used throughout the application.
 */

// ============================================================================
// File System Limits
// ============================================================================

export const FILE_LIMITS = {
  /** Maximum file size for reading (512 KB) */
  MAX_FILE_SIZE: 512 * 1024,
  /** Maximum lines to read from a file */
  MAX_LINES: 2000,
  /** Default lines to read */
  DEFAULT_LINES: 2000,
  /** Maximum file size for writing (1 MB) */
  MAX_WRITE_SIZE: 1024 * 1024,
} as const;

// ============================================================================
// Session & Memory Management
// ============================================================================

export const SESSION_CONFIG = {
  /** Maximum number of concurrent sessions */
  MAX_SESSIONS: 100,
  /** Default session timeout (1 hour) */
  DEFAULT_TIMEOUT_MS: 60 * 60 * 1000,
  /** Maximum messages per session before trimming */
  MAX_MESSAGES: 40,
  /** Session cleanup interval (30 minutes) */
  CLEANUP_INTERVAL_MS: 30 * 60 * 1000,
} as const;

export const MEMORY_CONFIG = {
  /** Default memory database path */
  DEFAULT_DB_PATH: ".strada-memory",
  /** Maximum memory entries to retrieve */
  MAX_RETRIEVAL_RESULTS: 10,
  /** Default minimum similarity score for memory retrieval */
  MIN_SIMILARITY_SCORE: 0.15,
  /** Maximum age for cached analysis (24 hours) */
  MAX_ANALYSIS_AGE_MS: 24 * 60 * 60 * 1000,
} as const;

// ============================================================================
// Tool Execution Limits
// ============================================================================

export const TOOL_LIMITS = {
  /** Maximum tool iterations per request */
  MAX_TOOL_ITERATIONS: 50,
  /** Maximum tool result length (8 KB) */
  MAX_TOOL_RESULT_LENGTH: 8192,
  /** Maximum tool execution time (5 minutes) */
  MAX_EXECUTION_TIME_MS: 5 * 60 * 1000,
} as const;

// ============================================================================
// Rate Limiting Defaults
// ============================================================================

export const DEFAULT_RATE_LIMITS = {
  /** Messages per minute (0 = unlimited) */
  messagesPerMinute: 0,
  /** Messages per hour (0 = unlimited) */
  messagesPerHour: 0,
  /** Tokens per day — 500K default for production safety */
  tokensPerDay: 500_000,
  /** Daily budget in USD */
  dailyBudgetUsd: 5.0,
  /** Monthly budget in USD */
  monthlyBudgetUsd: 100.0,
} as const;

// ============================================================================
// RAG Configuration
// ============================================================================

export const RAG_DEFAULTS = {
  /** Default context max tokens */
  CONTEXT_MAX_TOKENS: 4000,
  /** Default top-K results */
  TOP_K: 6,
  /** Default minimum score */
  MIN_SCORE: 0.2,
  /** Chunk size for text splitting */
  CHUNK_SIZE: 1000,
  /** Chunk overlap */
  CHUNK_OVERLAP: 200,
  /** Default embedding provider — "auto" scans the provider chain */
  EMBEDDING_PROVIDER: "auto" as const,
  /** Default embedding model */
  OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
  /** Default Ollama embedding model */
  OLLAMA_EMBEDDING_MODEL: "nomic-embed-text",
} as const;

/** Embedding preset configuration for a single provider */
export interface EmbeddingPreset {
  readonly supported: boolean;
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;
  readonly maxInputTokens: number;
  /** Matryoshka-supported output dimensions (empty = fixed only) */
  readonly supportedDimensions: readonly number[];
  readonly label: string;
}

/** Embedding presets for all known providers */
export const EMBEDDING_PRESETS: Record<string, EmbeddingPreset> = {
  openai:    { supported: true,  model: "text-embedding-3-small",                    dimensions: 1536, maxBatchSize: 100, maxInputTokens: 8191,  supportedDimensions: [512, 1536],               label: "OpenAI" },
  deepseek:  { supported: false, model: "",                                           dimensions: 0,    maxBatchSize: 0,   maxInputTokens: 0,     supportedDimensions: [],                        label: "DeepSeek" },
  mistral:   { supported: true,  model: "mistral-embed",                             dimensions: 1024, maxBatchSize: 100, maxInputTokens: 8192,  supportedDimensions: [],                        label: "Mistral" },
  together:  { supported: true,  model: "togethercomputer/m2-bert-80M-8k-retrieval", dimensions: 768,  maxBatchSize: 100, maxInputTokens: 8192,  supportedDimensions: [],                        label: "Together AI" },
  fireworks: { supported: true,  model: "nomic-ai/nomic-embed-text-v1.5",            dimensions: 768,  maxBatchSize: 100, maxInputTokens: 8192,  supportedDimensions: [],                        label: "Fireworks AI" },
  qwen:      { supported: true,  model: "text-embedding-v3",                         dimensions: 1024, maxBatchSize: 100, maxInputTokens: 8192,  supportedDimensions: [],                        label: "Qwen" },
  gemini:    { supported: true,  model: "gemini-embedding-2-preview",                dimensions: 3072, maxBatchSize: 100, maxInputTokens: 8192,  supportedDimensions: [256, 512, 768, 1536, 3072], label: "Gemini" },
  claude:    { supported: false, model: "",                                           dimensions: 0,    maxBatchSize: 0,   maxInputTokens: 0,     supportedDimensions: [],                        label: "Claude" },
  kimi:      { supported: false, model: "",                                           dimensions: 0,    maxBatchSize: 0,   maxInputTokens: 0,     supportedDimensions: [],                        label: "Kimi" },
  minimax:   { supported: false, model: "",                                           dimensions: 0,    maxBatchSize: 0,   maxInputTokens: 0,     supportedDimensions: [],                        label: "MiniMax" },
  groq:      { supported: false, model: "",                                           dimensions: 0,    maxBatchSize: 0,   maxInputTokens: 0,     supportedDimensions: [],                        label: "Groq" },
  ollama:    { supported: true,  model: "nomic-embed-text",                          dimensions: 768,  maxBatchSize: 100, maxInputTokens: 8192,  supportedDimensions: [],                        label: "Ollama" },
};

// ============================================================================
// Learning System Defaults
// ============================================================================

export const LEARNING_DEFAULTS = {
  /** Enable learning by default */
  enabled: true,
  /** Batch size for processing */
  batchSize: 10,
  /** Pattern detection interval (5 minutes) */
  detectionIntervalMs: 5 * 60 * 1000,
  /** Pattern evolution interval (1 hour) */
  evolutionIntervalMs: 60 * 60 * 1000,
  /** Minimum confidence for pattern creation */
  minConfidenceForCreation: 0.6,
  /** Maximum number of instincts to store */
  maxInstincts: 1000,
} as const;

// ============================================================================
// Dashboard & Metrics
// ============================================================================

export const DASHBOARD_DEFAULTS = {
  /** Default dashboard port */
  PORT: 3100,
  /** WebSocket dashboard port */
  WEBSOCKET_PORT: 3101,
  /** Prometheus metrics port */
  PROMETHEUS_PORT: 9090,
  /** Metrics retention period (7 days) */
  METRICS_RETENTION_MS: 7 * 24 * 60 * 60 * 1000,
} as const;

// ============================================================================
// Streaming Configuration
// ============================================================================

export const STREAMING_CONFIG = {
  /** Throttle streaming updates (500ms) */
  THROTTLE_MS: 500,
  /** Typing indicator interval (4 seconds) */
  TYPING_INTERVAL_MS: 4000,
  /** Maximum chunk size for streaming */
  MAX_CHUNK_SIZE: 4096,
} as const;

// ============================================================================
// Confirmation & DM Policy
// ============================================================================

export const CONFIRMATION_CONFIG = {
  /** Default confirmation timeout (5 minutes) */
  TIMEOUT_MS: 5 * 60 * 1000,
  /** Maximum operations per batch confirmation */
  MAX_BATCH_OPERATIONS: 10,
  /** Whether to require confirmation for destructive operations */
  REQUIRE_CONFIRMATION: true,
} as const;

/** Write operations that require confirmation */
export const WRITE_OPERATIONS = new Set([
  "file_write",
  "file_edit",
  "file_delete",
  "file_rename",
  "file_delete_directory",
  "shell_exec",
  "git_commit",
  "git_push",
  "git_stash",
  "strada_create_module",
  "strada_create_component",
  "strada_create_mediator",
  "strada_create_system",
  // NOTE: create_tool, create_skill, remove_dynamic_tool are intentionally
  // excluded from WRITE_OPERATIONS. They use internal read-only guards instead
  // to allow granular control (e.g. composite-only in read-only mode).
]);

// ============================================================================
// Security
// ============================================================================

export const SECURITY_CONFIG = {
  /** Default to read-only mode */
  DEFAULT_READ_ONLY: false,
  /** Path traversal check depth */
  MAX_PATH_DEPTH: 100,
  /** Secret patterns update interval (1 hour) */
  SECRET_PATTERNS_REFRESH_MS: 60 * 60 * 1000,
} as const;

// ============================================================================
// Logging
// ============================================================================

export const LOGGING_CONFIG = {
  /** Default log level */
  DEFAULT_LEVEL: "info" as const,
  /** Default log file */
  DEFAULT_FILE: "strada-brain.log",
  /** Maximum log file size (10 MB) */
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  /** Maximum number of log files to keep */
  MAX_FILES: 3,
} as const;

// ============================================================================
// Timeouts
// ============================================================================

export const TIMEOUTS = {
  /** Provider API timeout (2 minutes) */
  PROVIDER_API_MS: 2 * 60 * 1000,
  /** Channel connection timeout (30 seconds) */
  CHANNEL_CONNECT_MS: 30 * 1000,
  /** Shutdown timeout (10 seconds) */
  SHUTDOWN_MS: 10 * 1000,
  /** Health check timeout (5 seconds) */
  HEALTH_CHECK_MS: 5 * 1000,
} as const;

// ============================================================================
// Channel Defaults
// ============================================================================

export const CHANNEL_DEFAULTS = {
  /** Default channel type */
  DEFAULT_TYPE: "web" as const,
  /** Supported channels */
  SUPPORTED_TYPES: ["web", "telegram", "discord", "whatsapp", "cli", "slack", "matrix", "irc", "teams"] as const,
  /** WhatsApp session path */
  WHATSAPP_SESSION_PATH: ".whatsapp-session",
} as const;

/** Supported channel type */
export type SupportedChannelType = (typeof CHANNEL_DEFAULTS.SUPPORTED_TYPES)[number];

// ============================================================================
// Retry Configuration
// ============================================================================

export const RETRY_CONFIG = {
  /** Default max retries */
  MAX_RETRIES: 3,
  /** Base delay in milliseconds */
  BASE_DELAY_MS: 1000,
  /** Maximum delay in milliseconds */
  MAX_DELAY_MS: 30000,
  /** Retryable error codes */
  RETRYABLE_ERRORS: [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNABORTED",
  ] as const,
} as const;

// ============================================================================
// Export convenience aliases for backward compatibility
// ============================================================================

export const SESSION_CLEANUP_INTERVAL_MS = SESSION_CONFIG.CLEANUP_INTERVAL_MS;
export const MAX_SESSIONS = SESSION_CONFIG.MAX_SESSIONS;
export const MAX_TOOL_ITERATIONS = TOOL_LIMITS.MAX_TOOL_ITERATIONS;
export const MAX_TOOL_RESULT_LENGTH = TOOL_LIMITS.MAX_TOOL_RESULT_LENGTH;
export const TYPING_INTERVAL_MS = STREAMING_CONFIG.TYPING_INTERVAL_MS;
export const STREAM_THROTTLE_MS = STREAMING_CONFIG.THROTTLE_MS;
export const MAX_FILE_SIZE = FILE_LIMITS.MAX_FILE_SIZE;
export const MAX_LINES = FILE_LIMITS.MAX_LINES;
