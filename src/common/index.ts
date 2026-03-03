/**
 * Common Module
 * 
 * Shared constants and error types used throughout the application.
 * 
 * @example
 * ```typescript
 * import { MAX_TOOL_ITERATIONS, AppError, ValidationError } from "./common/index.js";
 * 
 * // Use constants
 * if (iterations > MAX_TOOL_ITERATIONS) {
 *   throw new ValidationError("Too many iterations");
 * }
 * ```
 */

// ============================================================================
// Constants Exports
// ============================================================================

export {
  // File system limits
  FILE_LIMITS,
  // Session and memory
  SESSION_CONFIG,
  MEMORY_CONFIG,
  // Tool execution
  TOOL_LIMITS,
  // Rate limiting
  DEFAULT_RATE_LIMITS,
  // RAG configuration
  RAG_DEFAULTS,
  // Learning system
  LEARNING_DEFAULTS,
  // Dashboard
  DASHBOARD_DEFAULTS,
  // Streaming
  STREAMING_CONFIG,
  // Confirmation
  CONFIRMATION_CONFIG,
  WRITE_OPERATIONS,
  // Security
  SECURITY_CONFIG,
  // Logging
  LOGGING_CONFIG,
  // Timeouts
  TIMEOUTS,
  // Channels
  CHANNEL_DEFAULTS,
  type SupportedChannelType,
  // Retry
  RETRY_CONFIG,
  // Backward compatibility aliases
  SESSION_CLEANUP_INTERVAL_MS,
  MAX_SESSIONS,
  MAX_TOOL_ITERATIONS,
  MAX_TOOL_RESULT_LENGTH,
  TYPING_INTERVAL_MS,
  STREAM_THROTTLE_MS,
  MAX_FILE_SIZE,
  MAX_LINES,
} from "./constants.js";

// ============================================================================
// Error Exports
// ============================================================================

export {
  // Base error
  AppError,
  type ErrorContext,
  // Validation
  ValidationError,
  // Security
  SecurityError,
  UnauthorizedError,
  ForbiddenError,
  RateLimitError,
  // Configuration
  ConfigError,
  MissingConfigError,
  // Tool execution
  ToolExecutionError,
  ToolNotFoundError,
  // Provider
  ProviderError,
  ProviderTimeoutError,
  // Channel
  ChannelError,
  // Memory
  MemoryError,
  StorageError,
  // RAG
  RAGError,
  EmbeddingError,
  VectorStoreError,
  // Not found
  NotFoundError,
  FileNotFoundError,
  // File system
  FileSystemError,
  PathValidationError,
  // Network
  NetworkError,
  TimeoutError,
  // Utilities
  isOperationalError,
  isErrorOfType,
  wrapError,
  setupGlobalErrorHandlers,
  asyncHandler,
  withRetry,
} from "./errors.js";
