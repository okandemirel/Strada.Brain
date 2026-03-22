# src/core/

Application bootstrap, dependency injection, and tool registration. These files wire every subsystem together at startup, including the truthful worker tool surface that Strada exposes to internal providers.

The source-checkout launcher is now cross-platform. `strada` remains the thin POSIX wrapper, while `strada.ps1` and `strada.cmd` delegate into the same no-dependency Node launcher core in `scripts/source-launcher.mjs`. That shared core owns source-checkout preparation, `install-command`, `uninstall`, wrapper generation, and the source-vs-dist launch decision so setup/doctor behavior stays aligned across macOS/Linux and Windows.

## Bootstrap (`bootstrap.ts` + helpers)

The main entry point that replaces a monolithic `startBrain()`. The exported `bootstrap()` function accepts `BootstrapOptions` (channel type, config, optional DI container) and returns a `BootstrapResult` with the orchestrator, channel, container, and a `shutdown()` handler. Heavy initialization is delegated to focused helper modules (`bootstrap-providers.ts`, `bootstrap-memory.ts`, `bootstrap-channels.ts`, `bootstrap-wiring.ts`) and typed stage modules under `bootstrap-stages/`.

Initialization sequence (order matters):

1. Logger (via `createLogger`)
2. `AuthManager` — per-channel allow-lists (Telegram user IDs, Discord user/role IDs, WhatsApp numbers)
3. AI provider — single `ClaudeProvider` or a multi-provider chain built from `config.providerChain` (comma-separated names mapped to API keys)
4. `FileMemoryManager` — optional, gated on `config.memory.enabled`
5. `RAGPipeline` — optional, gated on `config.rag.enabled`; selects `OllamaEmbeddingProvider` or `OpenAIEmbeddingProvider`, wraps it in `CachedEmbeddingProvider`, configures HNSW params from env vars, triggers background `indexProject()`
6. Learning system — `LearningStorage` + `LearningPipeline` + `RuntimeArtifactManager` + `ErrorRecoveryEngine` + `TaskPlanner`; falls back to bare `TaskPlanner`/`ErrorRecoveryEngine` on failure
7. `ToolRegistry.initialize()` — receives `memoryManager` and `ragPipeline` as optional deps
8. Channel adapter — `CLIChannel`, `TelegramChannel`, `DiscordChannel`, or `WhatsAppChannel` based on `channelType`
9. `MetricsCollector` + optional `DashboardServer`
10. `RateLimiter` — optional, configured from `DEFAULT_RATE_LIMITS` and config overrides
11. `Orchestrator` — receives provider, tools, channel, memory, metrics, RAG, rate limiter, streaming flag
12. Message handler wiring — `channel.onMessage` allocates `taskRunId`, wraps execution in task context, delegates to `orchestrator.handleMessage`, and feeds replay context back into `TaskPlanner`
13. Session cleanup interval (`SESSION_CLEANUP_INTERVAL_MS`)

Shutdown handler tears down in reverse: clears cleanup interval, stops learning pipeline, stops dashboard, shuts down RAG, shuts down memory, disconnects channel.

The bootstrap path now also wires runtime self-improvement into the control plane. High-confidence instincts materialize shadow runtime artifacts in the learning subsystem, the orchestrator retrieves matching active artifacts as internal guidance, and `/api/agent-activity` plus `/routing info` surface identity-scoped artifact lifecycle telemetry without exposing raw internal drafts or the full artifact pool to users.

## DI Container (`di-container.ts`)

A string-keyed dependency injection container with three lifecycles: `singleton`, `transient`, and `scoped`.

- `Map<string, Registration<unknown>>` stores registrations keyed by interface name
- `Map<string, unknown>` caches singleton instances separately
- `resolutionStack: string[]` tracks the current resolution chain for circular dependency detection
- Registration methods: `registerTransient()`, `registerSingleton()`, `registerSingletonFactory()`, `registerScoped()`, `registerInstance()`
- `resolve<T>(name)` checks the resolution stack, returns cached singletons, or creates via constructor/factory
- `tryResolve<T>(name)` swallows errors and returns `undefined`
- `createScope()` copies registrations to a child container; scoped registrations get fresh copies, singletons are shared
- Custom errors: `ServiceNotFoundError`, `CircularDependencyError` (includes the full resolution chain in the message)
- Global container: `getContainer()` (lazy singleton), `resetContainer()`, `createContainer()`
- `Services` const object defines typed string keys for all known services (Logger, Config, AuthManager, RateLimiter, AIProvider, MemoryManager, RAGPipeline, ToolRegistry, Orchestrator, LearningPipeline, etc.)
- `ServiceKey` type is derived from `typeof Services`

Note: `bootstrap.ts` does not currently use `DIContainer` for resolution. The container is passed through but services are wired manually.

## Tool Registry (`tool-registry.ts`)

Centralized registry for all tools available to the orchestrator.

- `Map<string, ITool>` stores tool instances by name
- `Map<string, ToolMetadata>` stores per-tool metadata (category, dangerous, requiresConfirmation, readOnly, dependencies, `controlPlaneOnly`, `requiresBridge`)
- `Map<ToolCategory, Set<string>>` provides a category-to-tool-names index
- `ToolCategories` const: `file`, `code`, `search`, `strata`, `shell`, `git`, `dotnet`, `memory`, `browser`
- `initialize(config, options)` is idempotent (guarded by `initialized` flag); calls `registerBuiltinTools()`, loads any usable Strada.MCP action tools, then loads plugin tools via `PluginLoader`
- `register(tool, metadata)` throws `ValidationError` on duplicate names
- Query methods: `get()`, `getAllTools()`, `getToolsByCategory()`, `getDangerousTools()`, `getReadOnlyTools()`, `has()`, `getMetadata()`, `getToolNames()`
- `createFiltered(allowedNames)` returns a new `ToolRegistry` containing only the specified tools
- `execute(name, input, context)` is a convenience wrapper around `tool.execute()`

Truthfulness rules:
- `controlPlaneOnly` tools such as `ask_user` and `show_plan` exist for orchestrator policy decisions, not as ordinary worker action tools
- `requiresBridge` tools stay out of worker tool pools unless the current Brain runtime actually exposes the required bridge
- installed Strada.MCP prompts/resources/docs can still be authoritative knowledge even when some MCP action tools are filtered out of the live worker surface

Built-in tools registered in `registerBuiltinTools()`:

| Category | Tools |
|----------|-------|
| `file` | FileReadTool, FileWriteTool, FileEditTool, FileDeleteTool, FileRenameTool, FileDeleteDirectoryTool |
| `search` | GlobSearchTool, GrepSearchTool, ListDirectoryTool, CodeSearchTool (if RAG), RAGIndexTool (if RAG) |
| `strata` | AnalyzeProjectTool, ModuleCreateTool, ComponentCreateTool, MediatorCreateTool, SystemCreateTool |
| `code` | CodeQualityTool |
| `shell` | ShellExecTool |
| `git` | GitStatusTool, GitDiffTool, GitLogTool, GitCommitTool, GitBranchTool, GitPushTool, GitStashTool |
| `dotnet` | DotnetBuildTool, DotnetTestTool |
| `memory` | MemorySearchTool (if memoryManager provided) |

Static const objects (`FileTools`, `SearchTools`, `StradaTools`, `GitTools`, `DotnetTools`, `ShellTools`) export tool name strings for type-safe references elsewhere.

## Setup Wizard (`setup-wizard.ts`)

A minimal HTTP server that runs during first-time configuration when no valid `.env` file exists (on the web channel). It provides a web UI for users to configure required settings and automatically generates the `.env` file.

**When it launches:** Bootstrap detects invalid configuration and starts SetupWizard instead of the normal Orchestrator. The wizard blocks the main application from running until configuration is complete.

**HTTP Endpoints:**

- `GET /` — Serves the setup UI (`setup.html`)
- `POST /api/setup` — Accepts JSON-encoded configuration, validates required fields (`UNITY_PROJECT_PATH`, provider credentials, OpenAI subscription session state when `chatgpt-subscription` is selected), runs real preflight for every selected response worker, sanitizes all values, writes `.env`, and then hands off to the main app
- `GET /api/setup/status` — Returns explicit bootstrap handoff state (`collecting`, `saved`, `booting`, `ready`, `failed`) so the frontend can show startup progress or failure without guessing from `/health`
- `GET /api/setup/validate-path` — Query parameter `path` (must be absolute, no `..` sequences); returns `{ valid: true }` if directory exists, or `{ valid: false, error: "..." }` otherwise

**Security Measures:**

- **Newline injection prevention:** All `.env` values are sanitized via `sanitizeEnvValue()` to strip carriage returns and newlines, blocking log injection and key overwriting attacks
- **Directory traversal blocking:** Path validation rejects relative paths, `..` sequences, and URL-encoded traversals using `path.resolve()` normalization
- **Subscription auth validation:** OpenAI `chatgpt-subscription` mode is rejected early when the local Codex/ChatGPT session file is missing, malformed, already expired, or fails the real Responses preflight probe
- **Fail-closed provider setup:** Every selected response worker must pass setup preflight. Invalid provider chains are rejected instead of being silently skipped during startup
- **HTTP security headers:** Every response includes:
  - `X-Content-Type-Options: nosniff` — prevents MIME sniffing
  - `X-Frame-Options: DENY` — blocks framing in other sites
  - `Referrer-Policy: no-referrer`
  - `Content-Security-Policy` — restrictive CSP allowing only `self` for scripts/styles/connects, no `eval`, no external objects
- **Request size limit:** Request body limited to 64KB to prevent memory exhaustion
- **Static file containment:** Serves only files from `../channels/web/static/`, with normalized path checks preventing escape

**Supported Configuration Contract:**

- Required: `UNITY_PROJECT_PATH` plus at least one usable response worker selection
- Provider-specific: setup accepts API-key providers, OpenAI `chatgpt-subscription`, and multi-provider response chains, but every selected response worker must pass real preflight before save can complete
- Optional channel/auth settings: web/CLI defaults, Telegram/Discord/other channel credentials when the chosen setup flow collects them
- Auto-populated defaults: `STREAMING_ENABLED=true`, `REQUIRE_EDIT_CONFIRMATION=true`, `LOG_LEVEL=info`
- Failure reporting: invalid response workers are returned as structured provider failures instead of being silently dropped from the generated config

## Key Files

| File | Purpose |
|------|---------|
| `bootstrap.ts` | Application startup sequence, service wiring, shutdown handler |
| `bootstrap-providers.ts` | AI provider initialization, embedding resolution |
| `bootstrap-memory.ts` | Memory system initialization, schema repair, migration |
| `bootstrap-channels.ts` | Channel adapter setup, dashboard, rate limiter |
| `bootstrap-wiring.ts` | Message handler wiring, shutdown handler, session ID |
| `bootstrap-stages/` | Directory with typed stage modules (types, providers, knowledge, runtime, goals, agents, daemon, finalization) |
| `di-container.ts` | String-keyed DI container with singleton/transient/scoped lifecycles and circular dependency detection |
| `setup-wizard.ts` | Minimal HTTP server for first-time `.env` configuration with security hardening |
| `terminal-wizard.ts` | Terminal/web setup flow, platform-aware Node upgrade guidance, and post-save launch handoff |
| `tool-registry.ts` | Tool registration, categorization, metadata, plugin loading, and filtered registry creation |
