# Coding Conventions

**Analysis Date:** 2026-03-06

## Naming Patterns

**Files:**
- Use `kebab-case` for all source files: `file-read.ts`, `rate-limiter.ts`, `pattern-matcher.ts`
- Test files use `.test.ts` suffix co-located with source: `file-read.test.ts`
- Interface files use `.interface.ts` suffix: `channel.interface.ts`, `provider.interface.ts`, `tool.interface.ts`, `rag.interface.ts`
- Core interface files use `-core.interface.ts` for segregated interfaces: `channel-core.interface.ts`, `provider-core.interface.ts`, `tool-core.interface.ts`
- Barrel files use `index.ts` for module re-exports: `src/learning/index.ts`, `src/tasks/index.ts`

**Classes:**
- Use `PascalCase` for class names: `Orchestrator`, `FileReadTool`, `RateLimiter`, `PatternMatcher`
- Suffix tools with `Tool`: `FileReadTool`, `FileWriteTool`, `FileEditTool`, `DotnetBuildTool`
- Suffix providers with `Provider`: `ClaudeProvider`, `OpenAIProvider`, `DeepSeekProvider`
- Suffix channels with `Channel`: `TelegramChannel`, `WebChannel`, `CLIChannel`
- Error classes extend domain-specific base errors: `ToolExecutionError extends AppError`, `ProviderError extends AppError`

**Interfaces:**
- Prefix with `I` for core abstractions: `IChannelAdapter`, `IAIProvider`, `ITool`, `IMemoryManager`, `IRAGPipeline`
- Extended interfaces describe capability: `IStreamingProvider extends IAIProvider`, `IEnhancedTool extends ITool`
- Config interfaces use descriptive names without prefix: `RateLimitConfig`, `MemoryConfig`, `RAGConfig`

**Functions:**
- Use `camelCase` for all functions: `createLogger`, `loadConfig`, `handleMessage`, `cleanupSessions`
- Factory functions prefix with `create`: `createMockLogger()`, `createMockProvider()`, `createContainer()`
- Validation functions prefix with `validate` or `is`: `validateConfig()`, `isValidChannelType()`, `isOperationalError()`
- Initialization functions prefix with `initialize`: `initializeAuth()`, `initializeAIProvider()`, `initializeMemory()`

**Constants:**
- Use `SCREAMING_SNAKE_CASE` for constant objects: `FILE_LIMITS`, `SESSION_CONFIG`, `TOOL_LIMITS`, `RAG_DEFAULTS`
- Use `SCREAMING_SNAKE_CASE` for individual constants: `MAX_FILE_SIZE`, `MAX_SESSIONS`, `MAX_TOOL_ITERATIONS`
- Group related constants in `as const` objects in `src/common/constants.ts`

**Types:**
- Use `PascalCase` for type aliases: `LogLevel`, `EmbeddingProvider`, `SupportedChannelType`
- Brand types use `PascalCase`: `UserId`, `ChatId`, `SessionId`, `VectorId`
- Discriminated unions use `kind` field: `Result<T,E>` uses `"ok" | "err"`, `ValidationResult<T>` uses `"valid" | "invalid"`, `Option<T>` uses `"some" | "none"`

**Variables:**
- Use `camelCase` for all variables: `cachedConfig`, `defaultProvider`, `rateLimiter`
- Prefix private class fields with no underscore (TypeScript `readonly` preferred)
- Exception: internal mock state may use `_` prefix: `_healthy`

## Code Style

**Formatting:**
- Prettier with config at `.prettierrc`
- Double quotes for strings (`"`)
- Semicolons required
- 2-space indentation
- Trailing commas on all multiline constructs
- Print width: 100 characters
- Arrow parens: always `(x) => x`

**Linting:**
- ESLint v9 with flat config at `eslint.config.js`
- TypeScript ESLint parser
- Key rules:
  - `no-console`: warn (use `logger` instead)
  - `no-eval`, `no-implied-eval`, `no-new-func`: error (security)
  - `@typescript-eslint/no-explicit-any`: warn
  - `@typescript-eslint/no-unused-vars`: warn (ignore `_` prefixed args)
  - `@typescript-eslint/no-floating-promises`: off

**TypeScript Strictness:**
- `strict: true` in `tsconfig.json`
- `noUncheckedIndexedAccess: true` -- array/object index access returns `T | undefined`
- `noUnusedLocals: true`, `noUnusedParameters: true`
- `noImplicitReturns: true`
- `noFallthroughCasesInSwitch: true`
- `isolatedModules: true`

## Import Organization

**Order:**
1. Node.js built-in modules: `import { join } from "node:path";`
2. External packages: `import { z } from "zod";`
3. Internal modules (relative): `import { createLogger } from "./utils/logger.js";`
4. Type-only imports: `import type { Config } from "../config/config.js";`

**Key Rules:**
- Always use `.js` extension in import paths (ESM requirement): `import { Foo } from "./foo.js";`
- Use `import type` for type-only imports to avoid runtime overhead
- Use `node:` protocol for Node built-ins: `import { readFileSync } from "node:fs";`
- No default exports (all named exports)

**Path Aliases:**
- `@/*` maps to `./src/*` (configured in `tsconfig.json` and `vitest.config.ts`)
- Primarily used in test files; source files mostly use relative imports

## Error Handling

**Error Hierarchy:**
All application errors extend `AppError` from `src/common/errors.ts`:
```
AppError (base)
├── ValidationError (400)
├── SecurityError (403)
│   ├── UnauthorizedError (401)
│   ├── ForbiddenError (403)
│   ├── RateLimitError (429)
│   └── PathValidationError (403)
├── ConfigError (500)
│   └── MissingConfigError (500)
├── ToolExecutionError (500)
├── ToolNotFoundError (404)
├── ProviderError (503)
│   └── ProviderTimeoutError (503)
├── ChannelError (503)
├── MemoryError (500)
│   └── StorageError (500)
├── RAGError (500)
│   ├── EmbeddingError (500)
│   └── VectorStoreError (500)
├── NotFoundError (404)
│   └── FileNotFoundError (404)
├── FileSystemError (500)
├── NetworkError (503)
│   └── TimeoutError (503)
```

**Error Patterns:**
- Use `AppError` subclasses with error `code` strings: `"VALIDATION_ERROR"`, `"TOOL_EXECUTION_ERROR"`, `"RATE_LIMIT_EXCEEDED"`
- Include `statusCode` for HTTP semantics: 400, 403, 404, 429, 500, 503
- Include `context` object for structured logging: `{ toolName, input, cause }`
- Use `isOperational` flag to distinguish expected vs. unexpected errors
- Use `wrapError()` to normalize unknown errors into `AppError`
- Use `withRetry()` for retryable operations with exponential backoff

**Result Type Pattern:**
Use `Result<T, E>` from `src/types/index.ts` for functions that can fail without throwing:
```typescript
// Return Result instead of throwing
function loadConfigSafe(): Result<Config, string> {
  try {
    return { kind: "ok", value: loadConfig() };
  } catch (error) {
    return { kind: "err", error: message };
  }
}

// Check with kind discriminator
if (result.kind === "ok") {
  // result.value is typed
} else {
  // result.error is typed
}
```

**Try-Catch Pattern:**
- Wrap service initializations in try-catch, log warning, return `undefined` for optional services
- Example from `src/core/bootstrap.ts`:
```typescript
try {
  const mm = new FileMemoryManager(config.memory.dbPath);
  await mm.initialize();
  return mm;
} catch (error) {
  logger.warn("Memory manager initialization failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  return undefined;
}
```

## Logging

**Framework:** Winston (`winston` v3) configured in `src/utils/logger.ts`

**Initialization:**
- Call `createLogger(level, logFile)` once during bootstrap
- Access via `getLogger()` elsewhere -- throws if not initialized
- Singleton pattern (first call wins)

**Patterns:**
- Use structured logging with metadata objects: `logger.info("Message", { key: value })`
- Error logging includes `error.message` and `error.stack`: `logger.error("Failed", { error: error.message, stack: error.stack })`
- Service lifecycle logs: `logger.info("Service initialized", { config })` at startup, `logger.info("Service stopped")` at shutdown
- Use log levels consistently:
  - `error`: Unexpected failures, unrecoverable errors
  - `warn`: Degraded behavior, optional service failures, missing config
  - `info`: Service lifecycle, key operations, user actions
  - `debug`: Internal state, detailed flow tracing

**In Tests:**
- Mock the logger module at the top of test files:
```typescript
vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
```

## Comments

**When to Comment:**
- Module-level JSDoc block at top of every file explaining purpose
- Use `@example` in module barrel files (`index.ts`) showing usage
- Use `@see` for external API references (e.g., provider docs)
- Use `/** description */` for constant values with units: `/** Maximum file size for reading (512 KB) */`

**Section Separators:**
- Use comment blocks with `=` to separate logical sections in long files:
```typescript
// ============================================================================
// Section Name
// ============================================================================
```

**JSDoc/TSDoc:**
- Functions in public APIs get JSDoc: `/** description */`
- Interface properties get JSDoc when non-obvious
- No JSDoc needed for private helper functions or test code

## Function Design

**Size:** Keep functions focused. Long functions are split into private helpers (see `src/core/bootstrap.ts` where `bootstrap()` delegates to `initializeAuth()`, `initializeAIProvider()`, `initializeMemory()`, etc.)

**Parameters:** Use options objects for functions with 3+ parameters:
```typescript
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  } = {}
): Promise<T>
```

**Return Values:**
- Return `Result<T, E>` for fallible operations when callers should handle errors
- Return `T | undefined` for optional lookups
- Throw `AppError` subclasses for unexpected failures
- Use `Promise<void>` for side-effect-only async functions

## Module Design

**Exports:**
- Named exports only (no default exports)
- Re-export types from interface files for convenience: `export type { ToolContext } from "./tool-core.interface.js";`
- Export both functions and type guards from interface files: `export { supportsStreaming, isEnhancedTool }`

**Barrel Files:**
- Use `index.ts` barrel files for module boundaries: `src/learning/index.ts`, `src/tasks/index.ts`
- Barrel files export classes, functions, and type aliases
- Include JSDoc module description with `@example` usage

**Interface Segregation:**
- Core interfaces are minimal (e.g., `IAIProvider` has `name`, `capabilities`, `chat()`)
- Extended interfaces add capabilities: `IStreamingProvider`, `IStructuredStreamingProvider`
- Type guard functions verify capability support: `supportsStreaming(provider)`, `supportsRichMessaging(channel)`

## Type System Patterns

**Brand Types:**
- Use branded types for type-safe IDs from `src/types/index.ts`: `UserId`, `ChatId`, `SessionId`, `ToolName`
- Create with factory functions: `toUserId(value)`, `toChatId(value)`
- Prevents accidental mixing of structurally identical types

**Discriminated Unions:**
- Use `kind` field as discriminator throughout: `Result<T,E>`, `Option<T>`, `ValidationResult<T>`
- Pattern: `{ kind: "ok"; value: T } | { kind: "err"; error: E }`

**Const Assertions:**
- Use `as const` on constant objects for narrow literal types
- Derive types from constants: `type SupportedChannelType = (typeof CHANNEL_DEFAULTS.SUPPORTED_TYPES)[number]`

**Readonly:**
- Interface properties are `readonly` by default (see `Config`, `RateLimitConfig`, all config interfaces)
- Class properties exposed publicly are `readonly`
- Use `DeepReadonly<T>` utility type for deeply immutable structures

## Configuration Pattern

**Zod Schema Validation:**
- All config validation uses Zod schemas in `src/config/config.ts`
- Environment variables are loaded as strings, transformed via Zod: `z.string().transform(s => parseInt(s, 10))`
- Config is cached as singleton: `loadConfig()` returns cached, `resetConfigCache()` clears it
- Safe variant: `loadConfigSafe()` returns `Result<Config, string>` instead of throwing
- Config interfaces use `readonly` properties throughout

## Dependency Injection

**DI Container:**
- Simple container in `src/core/di-container.ts` with `singleton`, `transient`, and `scoped` lifecycles
- Service keys are string constants in `Services` object
- Bootstrap wires dependencies manually (not decorator-based)
- `registerInstance()` for pre-created objects (common in tests)

---

*Convention analysis: 2026-03-06*
