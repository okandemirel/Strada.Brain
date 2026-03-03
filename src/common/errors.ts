/**
 * Standardized Error Types
 * 
 * Provides consistent error handling across the application.
 * All errors extend AppError for structured error information.
 */

// ============================================================================
// Base Error
// ============================================================================

export interface ErrorContext {
  [key: string]: unknown;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly context?: ErrorContext;
  public readonly isOperational: boolean;
  public readonly timestamp: Date;

  constructor(
    message: string,
    code: string = "UNKNOWN_ERROR",
    statusCode: number = 500,
    context?: ErrorContext,
    isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
    this.isOperational = isOperational;
    this.timestamp = new Date();

    // Maintain proper stack trace
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Serialize error for logging
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      context: this.context,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack,
    };
  }

  /**
   * Get user-friendly error message
   */
  toUserMessage(): string {
    return this.isOperational
      ? this.message
      : "An unexpected error occurred. Please try again later.";
  }
}

// ============================================================================
// Validation Errors (400)
// ============================================================================

export class ValidationError extends AppError {
  public readonly fieldErrors?: Map<string, string[]>;

  constructor(
    message: string,
    fieldErrors?: Record<string, string[]>,
    context?: ErrorContext
  ) {
    super(message, "VALIDATION_ERROR", 400, context);
    this.fieldErrors = fieldErrors ? new Map(Object.entries(fieldErrors)) : undefined;
  }

  static fromZodError(zodError: { issues: Array<{ path: (string | number)[]; message: string }> }): ValidationError {
    const fieldErrors: Record<string, string[]> = {};
    
    for (const issue of zodError.issues) {
      const path = issue.path.join(".");
      if (!fieldErrors[path]) {
        fieldErrors[path] = [];
      }
      fieldErrors[path].push(issue.message);
    }

    return new ValidationError(
      `Validation failed: ${zodError.issues.length} error(s)`,
      fieldErrors
    );
  }
}

// ============================================================================
// Security Errors (403)
// ============================================================================

export class SecurityError extends AppError {
  constructor(
    message: string,
    code: string = "SECURITY_VIOLATION",
    context?: ErrorContext
  ) {
    super(message, code, 403, context);
  }
}

export class UnauthorizedError extends AppError {
  constructor(
    message: string = "Unauthorized",
    code: string = "UNAUTHORIZED",
    context?: ErrorContext
  ) {
    super(message, code, 401, context);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message: string = "Forbidden",
    code: string = "FORBIDDEN",
    context?: ErrorContext
  ) {
    super(message, code, 403, context);
  }
}

export class RateLimitError extends AppError {
  public readonly retryAfterMs?: number;

  constructor(
    message: string = "Rate limit exceeded",
    retryAfterMs?: number,
    context?: ErrorContext
  ) {
    super(message, "RATE_LIMIT_EXCEEDED", 429, context);
    this.retryAfterMs = retryAfterMs;
  }
}

// ============================================================================
// Configuration Errors (500)
// ============================================================================

export class ConfigError extends AppError {
  constructor(
    message: string,
    code: string = "CONFIG_ERROR",
    context?: ErrorContext
  ) {
    super(message, code, 500, context, false);
  }
}

export class MissingConfigError extends ConfigError {
  constructor(
    configKey: string,
    context?: ErrorContext
  ) {
    super(
      `Missing required configuration: ${configKey}`,
      "MISSING_CONFIG",
      { configKey, ...context }
    );
  }
}

// ============================================================================
// Tool Execution Errors (500)
// ============================================================================

export class ToolExecutionError extends AppError {
  public readonly toolName: string;
  public readonly input?: Record<string, unknown>;

  constructor(
    toolName: string,
    message: string,
    input?: Record<string, unknown>,
    cause?: Error
  ) {
    super(
      `Tool '${toolName}' failed: ${message}`,
      "TOOL_EXECUTION_ERROR",
      500,
      { toolName, input, cause: cause?.message },
      true
    );
    this.toolName = toolName;
    this.input = input;
    if (cause) {
      this.cause = cause;
    }
  }
}

export class ToolNotFoundError extends AppError {
  public readonly toolName: string;

  constructor(toolName: string) {
    super(
      `Tool '${toolName}' not found`,
      "TOOL_NOT_FOUND",
      404,
      { toolName }
    );
    this.toolName = toolName;
  }
}

// ============================================================================
// Provider Errors (503)
// ============================================================================

export class ProviderError extends AppError {
  public readonly providerName: string;

  constructor(
    providerName: string,
    message: string,
    code: string = "PROVIDER_ERROR",
    context?: ErrorContext
  ) {
    super(
      `Provider '${providerName}' error: ${message}`,
      code,
      503,
      { providerName, ...context }
    );
    this.providerName = providerName;
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(
    providerName: string,
    timeoutMs: number,
    context?: ErrorContext
  ) {
    super(
      providerName,
      `Request timed out after ${timeoutMs}ms`,
      "PROVIDER_TIMEOUT",
      { timeoutMs, ...context }
    );
  }
}

// ============================================================================
// Channel Errors (503)
// ============================================================================

export class ChannelError extends AppError {
  public readonly channelName: string;

  constructor(
    channelName: string,
    message: string,
    code: string = "CHANNEL_ERROR",
    context?: ErrorContext
  ) {
    super(
      `Channel '${channelName}' error: ${message}`,
      code,
      503,
      { channelName, ...context }
    );
    this.channelName = channelName;
  }
}

// ============================================================================
// Memory Errors (500)
// ============================================================================

export class MemoryError extends AppError {
  constructor(
    message: string,
    code: string = "MEMORY_ERROR",
    context?: ErrorContext
  ) {
    super(message, code, 500, context);
  }
}

export class StorageError extends MemoryError {
  constructor(
    operation: string,
    message: string,
    context?: ErrorContext
  ) {
    super(
      `Storage operation '${operation}' failed: ${message}`,
      "STORAGE_ERROR",
      { operation, ...context }
    );
  }
}

// ============================================================================
// RAG Errors (500)
// ============================================================================

export class RAGError extends AppError {
  constructor(
    message: string,
    code: string = "RAG_ERROR",
    context?: ErrorContext
  ) {
    super(message, code, 500, context);
  }
}

export class EmbeddingError extends RAGError {
  constructor(
    message: string,
    provider?: string,
    context?: ErrorContext
  ) {
    super(
      `Embedding error: ${message}`,
      "EMBEDDING_ERROR",
      { provider, ...context }
    );
  }
}

export class VectorStoreError extends RAGError {
  constructor(
    operation: string,
    message: string,
    context?: ErrorContext
  ) {
    super(
      `Vector store '${operation}' failed: ${message}`,
      "VECTOR_STORE_ERROR",
      { operation, ...context }
    );
  }
}

// ============================================================================
// Not Found Errors (404)
// ============================================================================

export class NotFoundError extends AppError {
  public readonly resourceType: string;
  public readonly resourceId?: string;

  constructor(
    resourceType: string,
    resourceId?: string,
    context?: ErrorContext
  ) {
    super(
      `${resourceType}${resourceId ? ` '${resourceId}'` : ""} not found`,
      "NOT_FOUND",
      404,
      { resourceType, resourceId, ...context }
    );
    this.resourceType = resourceType;
    this.resourceId = resourceId;
  }
}

export class FileNotFoundError extends NotFoundError {
  constructor(filePath: string) {
    super("File", filePath);
  }
}

// ============================================================================
// File System Errors (500)
// ============================================================================

export class FileSystemError extends AppError {
  public readonly path: string;
  public readonly operation: string;

  constructor(
    operation: string,
    path: string,
    message: string,
    cause?: Error
  ) {
    super(
      `File system operation '${operation}' failed on '${path}': ${message}`,
      "FILE_SYSTEM_ERROR",
      500,
      { operation, path, cause: cause?.message },
      true
    );
    this.path = path;
    this.operation = operation;
    if (cause) {
      this.cause = cause;
    }
  }
}

export class PathValidationError extends SecurityError {
  public readonly path: string;
  public readonly projectPath: string;

  constructor(
    path: string,
    projectPath: string,
    reason: string
  ) {
    super(
      `Path validation failed: ${reason}`,
      "PATH_VALIDATION_FAILED",
      { path, projectPath, reason }
    );
    this.path = path;
    this.projectPath = projectPath;
  }
}

// ============================================================================
// Network Errors (503)
// ============================================================================

export class NetworkError extends AppError {
  constructor(
    message: string,
    code: string = "NETWORK_ERROR",
    context?: ErrorContext
  ) {
    super(message, code, 503, context);
  }
}

export class TimeoutError extends NetworkError {
  public readonly timeoutMs: number;

  constructor(
    operation: string,
    timeoutMs: number,
    context?: ErrorContext
  ) {
    super(
      `Operation '${operation}' timed out after ${timeoutMs}ms`,
      "TIMEOUT",
      { operation, timeoutMs, ...context }
    );
    this.timeoutMs = timeoutMs;
  }
}

// ============================================================================
// Error Utilities
// ============================================================================

/**
 * Check if an error is an operational error (expected)
 */
export function isOperationalError(error: Error): boolean {
  if (error instanceof AppError) {
    return error.isOperational;
  }
  return false;
}

/**
 * Check if an error is a specific type
 */
export function isErrorOfType<T extends AppError>(
  error: Error,
  errorClass: new (...args: unknown[]) => T
): error is T {
  return error instanceof errorClass;
}

/**
 * Wrap an unknown error in an AppError
 */
export function wrapError(
  error: unknown,
  defaultMessage: string = "An error occurred"
): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError(
      error.message || defaultMessage,
      "WRAPPED_ERROR",
      500,
      { originalError: error.name, stack: error.stack },
      false
    );
  }

  return new AppError(
    String(error) || defaultMessage,
    "UNKNOWN_ERROR",
    500,
    { error },
    false
  );
}

/**
 * Global error handler for uncaught exceptions
 */
export function setupGlobalErrorHandlers(
  onError?: (error: Error) => void,
  onShutdown?: () => void
): void {
  const logger = console;

  process.on("uncaughtException", (error: Error) => {
    logger.error("Uncaught Exception:", error);
    onError?.(error);
    
    // Give time for cleanup
    setTimeout(() => {
      onShutdown?.();
      process.exit(1);
    }, 1000);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error("Unhandled Rejection:", error);
    onError?.(error);
  });

  // Graceful shutdown signals
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    onShutdown?.();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Error handler middleware for async functions
 */
export function asyncHandler<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
  return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    try {
      return (await fn(...args)) as ReturnType<T>;
    } catch (error) {
      throw wrapError(error);
    }
  };
}

/**
 * Retry a function with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (error: Error, attempt: number) => void;
    retryableErrors?: string[];
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    onRetry,
    retryableErrors = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND"],
  } = options;

  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry if not a retryable error
      const shouldRetry = retryableErrors.some((code) =>
        lastError.message?.includes(code)
      );

      if (attempt === maxRetries || !shouldRetry) {
        throw lastError;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt),
        maxDelayMs
      );

      onRetry?.(lastError, attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}
