# src/common/

Shared constants and error types used throughout the application.

## Constants (`constants.ts`)

Centralized numeric limits, thresholds, and default values grouped by domain.

- `FILE_LIMITS` — max read size 512 KB, max write size 1 MB, max lines 2,000
- `SESSION_CONFIG` — max 100 concurrent sessions, 1-hour timeout, 40-message baseline trimming constant, 30-minute cleanup interval
- `MEMORY_CONFIG` — default DB path `.strada-memory`, max 10 retrieval results, min similarity 0.15, 24-hour analysis cache
- `TOOL_LIMITS` — max 50 iterations per request, 8 KB result length, 5-minute execution timeout
- `DEFAULT_RATE_LIMITS` — messages/minute, messages/hour, tokens/day, daily/monthly budget (all default 0 = unlimited)
- `RAG_DEFAULTS` — 4,000 context tokens, top-K 6, min score 0.2, 1,000-char chunks with 200-char overlap, OpenAI `text-embedding-3-small` or Ollama `nomic-embed-text`
- `LEARNING_DEFAULTS` — batch size 10, 5-minute detection interval, 1-hour evolution interval, 0.6 min confidence, max 1,000 instincts
- `DASHBOARD_DEFAULTS` — port 3100, WebSocket 3101, Prometheus 9090, 7-day metrics retention
- `STREAMING_CONFIG` — 500ms throttle, 4-second typing indicator, 4 KB max chunk
- `CONFIRMATION_CONFIG` — 5-minute timeout, max 10 batch operations
- `WRITE_OPERATIONS` — `Set` of 12 operation names requiring confirmation (file_write, shell_exec, git_push, etc.)
- `SECURITY_CONFIG` — read-only default false, max path depth 100, 1-hour secret pattern refresh
- `LOGGING_CONFIG` — info level, 10 MB max file size, 3 file rotation
- `TIMEOUTS` — provider API 2 min, channel connect 30s, shutdown 10s, health check 5s
- `CHANNEL_DEFAULTS` — default type web, supported: web/telegram/discord/whatsapp/cli/slack/matrix/irc/teams
- `RETRY_CONFIG` — max 3 retries, 1s base delay, 30s max delay, 6 retryable error codes
- Backward-compatibility aliases exported for commonly used values

## Error Types (`errors.ts`)

Hierarchy of typed errors extending a base `AppError` class.

- `AppError` — base with `code`, `statusCode`, `context`, `isOperational`, `timestamp`; includes `toJSON()` serialization and `toUserMessage()` (hides internals for non-operational errors)
- `ValidationError` (400) — optional `Map<string, string[]>` field errors; `fromZodError()` static factory
- `SecurityError` (403), `UnauthorizedError` (401), `ForbiddenError` (403), `RateLimitError` (429) with `retryAfterMs`
- `ConfigError` (500, non-operational), `MissingConfigError`
- `ToolExecutionError` (500) with `toolName` and `input`, `ToolNotFoundError` (404)
- `ProviderError` (503) with `providerName`, `ProviderTimeoutError`
- `ChannelError` (503), `MemoryError` (500), `StorageError`
- `RAGError` (500), `EmbeddingError`, `VectorStoreError`
- `NotFoundError` (404) with `resourceType`/`resourceId`, `FileNotFoundError`
- `FileSystemError` (500) with `path`/`operation`, `PathValidationError` (403)
- `NetworkError` (503), `TimeoutError` with `timeoutMs`

Utility functions:
- `isOperationalError()` — checks if error is expected/recoverable
- `isErrorOfType()` — type-narrowing guard
- `wrapError()` — wraps unknown values in `AppError`
- `setupGlobalErrorHandlers()` — registers `uncaughtException`, `unhandledRejection`, `SIGTERM`, `SIGINT` handlers with 1-second cleanup window
- `asyncHandler()` — wraps async functions to auto-wrap thrown errors
- `withRetry()` — exponential backoff (base 1s, max 30s, 3 retries) for retryable network error codes

## Barrel Export (`index.ts`)

Re-exports all constants and error types from `constants.ts` and `errors.ts`.

## Key Files

| File | Purpose |
|------|---------|
| `constants.ts` | All application-wide numeric limits, thresholds, defaults, and configuration constants |
| `errors.ts` | Typed error hierarchy, error utilities, global error handlers, retry logic |
| `index.ts` | Barrel re-export of constants and errors |
