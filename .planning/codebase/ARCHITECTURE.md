# Architecture

**Analysis Date:** 2026-03-06

## Pattern Overview

**Overall:** Multi-channel AI Agent with PAOR State Machine and Plugin Architecture

**Key Characteristics:**
- CLI entry point (`commander`) bootstraps the entire app via a centralized `bootstrap()` function
- PAOR (Plan-Act-Observe-Reflect) state machine drives the core agent loop
- Interface-driven design: channels, providers, memory, RAG, and tools all use abstract interfaces
- Multi-channel adapter pattern: one orchestrator serves Telegram, Discord, Slack, WhatsApp, Web, and CLI
- Background task system with concurrency control and progress reporting
- Learning system that observes tool usage and evolves instincts over time

## Layers

**Entry / CLI Layer:**
- Purpose: Parse CLI commands, load config, launch the app
- Location: `src/index.ts`
- Contains: Commander CLI setup, `startApp()`, shutdown handlers, setup wizard flow
- Depends on: Config, Bootstrap, DI Container, Setup Wizard
- Used by: User (via `npx`, `node dist/index.js`)

**Core / Bootstrap Layer:**
- Purpose: Wire all services together, manage lifecycle
- Location: `src/core/`
- Contains: `bootstrap.ts` (service initialization and wiring), `di-container.ts` (DI), `tool-registry.ts` (tool registration), `setup-wizard.ts` (first-run web wizard)
- Depends on: All subsystems (providers, channels, memory, RAG, learning, tasks, security, dashboard)
- Used by: Entry layer

**Channel Layer:**
- Purpose: Receive user messages and send responses across platforms
- Location: `src/channels/`
- Contains: Platform adapters implementing `IChannelAdapter` (composed of `IChannelCore`, `IChannelReceiver`, `IChannelSender`)
- Depends on: Channel interfaces
- Used by: Orchestrator (for sending), MessageRouter (for receiving)
- Key interfaces: `src/channels/channel.interface.ts`, `src/channels/channel-core.interface.ts`, `src/channels/channel-messages.interface.ts`

**Agent / Orchestrator Layer:**
- Purpose: Core AI agent loop -- receives messages, calls LLM, executes tools, manages sessions
- Location: `src/agents/orchestrator.ts`
- Contains: `Orchestrator` class (agent loop, session management, streaming, confirmation flow)
- Depends on: Providers, Tools, Channels, Memory, RAG, Metrics, Rate Limiter, Autonomy, PAOR state
- Used by: Task system (`BackgroundExecutor`), Channel message wiring

**PAOR State Machine:**
- Purpose: Drive the agent through structured phases: Plan -> Act -> Observe -> Reflect
- Location: `src/agents/agent-state.ts`, `src/agents/paor-prompts.ts`, `src/agents/failure-classifier.ts`
- Contains: `AgentPhase` enum, `AgentState` interface, state transition logic, phase-aware prompt builders
- Depends on: Nothing (pure logic)
- Used by: Orchestrator

**AI Provider Layer:**
- Purpose: Abstract LLM API calls behind a common interface with per-chat provider selection
- Location: `src/agents/providers/`
- Contains: `IAIProvider` interface, 12 provider implementations, `ProviderManager` (per-chat selection with SQLite persistence), `FallbackChain`, `ProviderRegistry`
- Key files:
  - `src/agents/providers/provider.interface.ts` -- core `IAIProvider` and `IStreamingProvider`
  - `src/agents/providers/provider-manager.ts` -- per-chat provider resolution with caching
  - `src/agents/providers/provider-registry.ts` -- factory for creating providers by name
  - `src/agents/providers/fallback-chain.ts` -- cascading provider fallback
  - `src/agents/providers/openai-compat.ts` -- base class for OpenAI-compatible APIs
- Depends on: External SDKs (Anthropic, OpenAI-compatible endpoints)
- Used by: Orchestrator, TaskDecomposer

**Tool Layer:**
- Purpose: Provide capabilities the AI can invoke (file ops, search, git, shell, .NET, Strata-specific)
- Location: `src/agents/tools/`, `src/core/tool-registry.ts`
- Contains: 25+ tool implementations, each implementing `ITool` with `name`, `description`, `inputSchema`, `execute()`
- Key tool categories:
  - **File**: `file-read.ts`, `file-write.ts`, `file-edit.ts`, `file-manage.ts`
  - **Search**: `search.ts` (glob, grep, list_dir), `code-search.ts`, `memory-search.ts`
  - **Git**: `git-tools.ts` (status, diff, log, commit, branch, push, stash)
  - **Shell**: `shell-exec.ts`
  - **.NET**: `dotnet-tools.ts` (build, test)
  - **Strata**: `strata/analyze-project.ts`, `strata/module-create.ts`, `strata/component-create.ts`, `strata/mediator-create.ts`, `strata/system-create.ts`
  - **RAG**: `rag-index.ts`
  - **Code Quality**: `code-quality.ts`
  - **Browser**: `browser-automation.ts`
- Depends on: ToolContext (projectPath, workingDirectory, readOnly), Memory, RAG
- Used by: Orchestrator (via tool registry)

**Autonomy Layer:**
- Purpose: Error recovery, task planning, self-verification, failure classification
- Location: `src/agents/autonomy/`
- Contains: `ErrorRecoveryEngine`, `TaskPlanner`, `SelfVerification`
- Key files:
  - `src/agents/autonomy/error-recovery.ts` -- analyzes tool failures, injects recovery hints
  - `src/agents/autonomy/task-planner.ts` -- tracks tool calls, detects stalls, injects budget warnings
  - `src/agents/autonomy/self-verification.ts` -- checks if build verification is needed
  - `src/agents/failure-classifier.ts` -- determines when to force replan based on failure patterns
  - `src/agents/instinct-retriever.ts` -- queries learned patterns for proactive hints
- Depends on: Learning system
- Used by: Orchestrator (inline during agent loop)

**Task System:**
- Purpose: Background task execution with concurrency control, command routing, progress reporting
- Location: `src/tasks/`
- Contains: `MessageRouter` (central routing), `CommandHandler` (slash commands), `TaskManager` (lifecycle), `BackgroundExecutor` (concurrent execution), `TaskDecomposer` (LLM-based decomposition), `TaskStorage` (SQLite persistence), `ProgressReporter` (channel updates)
- Data flow: Channel -> `MessageRouter.route()` -> command or task submission -> `BackgroundExecutor` -> `Orchestrator.runBackgroundTask()`
- Key files:
  - `src/tasks/message-router.ts` -- classifies messages as commands vs tasks
  - `src/tasks/command-detector.ts` -- deterministic prefix matching (bilingual TR/EN)
  - `src/tasks/background-executor.ts` -- runs tasks with concurrency limit (default 3)
  - `src/tasks/task-decomposer.ts` -- LLM-based decomposition of complex prompts into subtasks
  - `src/tasks/task-storage.ts` -- SQLite persistence
- Depends on: Orchestrator, Channels, Providers
- Used by: Bootstrap (wired to channel.onMessage)

**Memory Layer:**
- Purpose: Persistent conversation memory, project analysis cache, semantic retrieval
- Location: `src/memory/`
- Contains: `IMemoryManager` interface, `FileMemoryManager` implementation, `TextIndex` for TF-IDF search
- Key files:
  - `src/memory/memory.interface.ts` -- comprehensive typed interface with discriminated unions for entry types
  - `src/memory/file-memory-manager.ts` -- JSON-file-backed implementation
  - `src/memory/text-index.ts` -- TF-IDF text search
  - `src/memory/unified/` -- planned unified memory system (not yet wired to bootstrap)
- Depends on: Types, Intelligence (for StrataProjectAnalysis)
- Used by: Orchestrator (context injection), Tools (memory search)

**RAG Layer:**
- Purpose: Index Unity project code, provide semantic code search for context injection
- Location: `src/rag/`
- Contains: `IRAGPipeline` interface, `RAGPipeline` implementation, vector store, chunker, embeddings, HNSW index, reranker
- Key files:
  - `src/rag/rag.interface.ts` -- comprehensive typed interfaces for chunks, search, vector store, embeddings
  - `src/rag/rag-pipeline.ts` -- main pipeline: index files, search, format context
  - `src/rag/chunker.ts` -- splits C# code into semantic chunks
  - `src/rag/vector-store.ts` -- file-backed vector storage
  - `src/rag/vector-math.ts` -- cosine similarity, normalization
  - `src/rag/embeddings/` -- embedding providers, cache, resolver
  - `src/rag/hnsw/` -- HNSW approximate nearest neighbor index
  - `src/rag/reranker.ts` -- cross-encoder reranking
- Depends on: Embedding providers (via external APIs), File system
- Used by: Orchestrator (context injection), Tools (code search, RAG index)

**Learning Layer:**
- Purpose: Experience replay, pattern learning from errors and tool usage, instinct evolution
- Location: `src/learning/`
- Contains: `LearningPipeline`, `LearningStorage`, `PatternMatcher`, `ConfidenceScorer`, `ErrorLearningHooks`
- Subdirectories: `hooks/`, `matching/`, `pipeline/`, `scoring/`, `storage/`
- Key files:
  - `src/learning/pipeline/learning-pipeline.ts` -- orchestrates detection and evolution intervals
  - `src/learning/storage/learning-storage.ts` -- SQLite storage for instincts and trajectories
  - `src/learning/matching/pattern-matcher.ts` -- HNSW semantic search + keyword matching
  - `src/learning/scoring/confidence-scorer.ts` -- Bayesian confidence updates, Elo rating, Wilson intervals
  - `src/learning/hooks/error-learning-hooks.ts` -- observes errors and creates instincts
- Depends on: SQLite (better-sqlite3)
- Used by: Orchestrator (via InstinctRetriever), Autonomy (ErrorRecoveryEngine, TaskPlanner)

**Security Layer:**
- Purpose: Authentication, rate limiting, path validation, secret sanitization, read-only guard
- Location: `src/security/`
- Contains: `AuthManager`, `RateLimiter`, `PathGuard`, `SecretSanitizer`, `ReadOnlyGuard`, `DMPolicy`, RBAC, browser security
- Key files:
  - `src/security/auth.ts` -- Telegram/Discord user ID allowlisting
  - `src/security/rate-limiter.ts` -- per-user message/token/budget rate limiting
  - `src/security/path-guard.ts` -- prevents path traversal outside project
  - `src/security/secret-sanitizer.ts` -- strips API keys from tool output
  - `src/security/read-only-guard.ts` -- blocks write operations in read-only mode
  - `src/security/dm-policy.ts` -- DM-only mode policy enforcement
- Depends on: Config
- Used by: Channels (auth), Orchestrator (rate limiter), Tools (path guard, read-only guard)

**Intelligence Layer:**
- Purpose: Static analysis of Unity/C# projects
- Location: `src/intelligence/`
- Contains: `StrataAnalyzer` (project analysis), `CSharpParser` + `CSharpDeepParser` (code parsing), `CodeQuality` (metrics)
- Used by: Tools (analyze_project), Memory (caching analysis)

**Config Layer:**
- Purpose: Zod-validated configuration from environment variables
- Location: `src/config/config.ts`
- Contains: Zod schemas, `loadConfig()` / `loadConfigSafe()`, config cache, per-provider model overrides, `checkStradaDeps()`
- Depends on: Zod, dotenv
- Used by: Everything (via bootstrap)

**Dashboard Layer:**
- Purpose: Metrics collection, HTTP dashboard, Prometheus export, WebSocket real-time
- Location: `src/dashboard/`
- Contains: `MetricsCollector`, `DashboardServer`, `PrometheusExporter`, `WebSocketServer`
- Used by: Orchestrator (metrics recording), Bootstrap (initialization)

**Common / Types:**
- Purpose: Shared types, constants, and error definitions
- Location: `src/types/index.ts`, `src/common/constants.ts`, `src/common/errors.ts`
- Contains: Brand types (`UserId`, `ChatId`, etc.), `Result<T,E>`, `Option<T>`, `ValidationResult<T>`, vector types, JSON types, utility types; centralized constants; hierarchical error classes
- Used by: Everything

## Data Flow

**User Message Flow (Primary):**

1. User sends message via platform (Telegram, Discord, Web, etc.)
2. Channel adapter receives message, wraps as `IncomingMessage`
3. `channel.onMessage()` callback invokes `messageRouter.route(msg)`
4. `MessageRouter` classifies: command prefix -> `CommandHandler`, otherwise -> `TaskManager.submit()`
5. `TaskManager` creates a `Task` record in SQLite, enqueues to `BackgroundExecutor`
6. `BackgroundExecutor` calls `orchestrator.runBackgroundTask(prompt, options)`
7. Orchestrator builds system prompt: base Strata knowledge + memory context + RAG code context + learned instincts
8. PAOR state machine: PLANNING phase -> LLM generates plan
9. Transition to EXECUTING: LLM makes tool calls
10. Tool results fed back; after every N steps or on error -> REFLECTING phase
11. Reflection decision: DONE (return), CONTINUE (keep executing), REPLAN (new plan)
12. Final response sent back via channel adapter
13. Learning system records outcomes for future pattern matching

**State Management:**
- Per-chat sessions stored in `Orchestrator.sessions` Map (in-memory, LRU-evicted at 100 sessions)
- Trimmed conversation messages persisted to `IMemoryManager`
- Per-chat AI provider preferences stored in SQLite via `ProviderPreferenceStore`
- Task state persisted in SQLite via `TaskStorage`
- Learning instincts and trajectories persisted in SQLite via `LearningStorage`

**Context Injection Flow:**
1. Last user message used as query
2. Memory retrieval: top 3 similar conversation summaries (TF-IDF, minScore 0.15)
3. RAG search: top 6 code chunks from indexed Unity project (vector similarity, minScore 0.2)
4. Cached project analysis summary appended
5. InstinctRetriever: relevant learned patterns injected into PLANNING phase prompt
6. All injected into system prompt before LLM call

## Key Abstractions

**IChannelAdapter:**
- Purpose: Abstract platform-specific messaging behind a common interface
- Examples: `src/channels/telegram/bot.ts`, `src/channels/discord/bot.ts`, `src/channels/web/channel.ts`, `src/channels/cli/repl.ts`, `src/channels/slack/app.ts`, `src/channels/whatsapp/client.ts`
- Pattern: Adapter pattern with capability type guards (`supportsStreaming()`, `supportsRichMessaging()`, `supportsInteractivity()`)

**IAIProvider:**
- Purpose: Abstract LLM API calls
- Examples: `src/agents/providers/claude.ts`, `src/agents/providers/openai.ts`, `src/agents/providers/gemini.ts`, `src/agents/providers/ollama.ts`, `src/agents/providers/deepseek.ts`, plus 7 more
- Pattern: Strategy pattern; `IStreamingProvider` extends for streaming; `FallbackChain` wraps multiple providers with cascading fallback

**ITool:**
- Purpose: Represent a capability the AI can invoke
- Examples: `src/agents/tools/file-read.ts`, `src/agents/tools/git-tools.ts`, `src/agents/tools/shell-exec.ts`
- Pattern: Command pattern with JSON Schema input validation. Each tool has `name`, `description`, `inputSchema`, `execute()`.

**IMemoryManager:**
- Purpose: Persistent knowledge storage and retrieval
- Examples: `src/memory/file-memory-manager.ts`
- Pattern: Repository pattern with discriminated union entry types (`ConversationMemoryEntry`, `AnalysisMemoryEntry`, etc.)

**IRAGPipeline:**
- Purpose: Code indexing and semantic search
- Examples: `src/rag/rag-pipeline.ts`
- Pattern: Pipeline pattern (embed -> index -> search -> format)

**AgentState:**
- Purpose: Immutable state for the PAOR state machine
- Examples: `src/agents/agent-state.ts`
- Pattern: Finite state machine with explicit valid transitions via `VALID_TRANSITIONS` map. State is immutable (spread-copy on every update).

**Result<T, E> / Option<T>:**
- Purpose: Functional error handling without exceptions
- Examples: `src/types/index.ts`
- Pattern: Discriminated unions (`kind: "ok" | "err"`, `kind: "some" | "none"`) with helper functions (`isOk()`, `unwrap()`, `mapResult()`)

## Entry Points

**CLI Entry (`src/index.ts`):**
- Location: `src/index.ts`
- Triggers: `node dist/index.js start --channel web`, `npx tsx src/index.ts cli`
- Commands: `start` (main app), `cli` (local testing), `daemon` (auto-restart wrapper)
- Responsibilities: Parse CLI args, validate config, create DI container, call `bootstrap()`, setup shutdown handlers

**Bootstrap (`src/core/bootstrap.ts`):**
- Location: `src/core/bootstrap.ts`
- Triggers: Called by `startApp()` in `src/index.ts`
- Responsibilities: Initialize all services in order (auth -> provider -> memory -> RAG -> learning -> tools -> channel -> dashboard -> rate limiter -> orchestrator -> task system), wire message handler, return shutdown function

**Message Entry (`src/tasks/message-router.ts`):**
- Location: `src/tasks/message-router.ts`
- Triggers: `channel.onMessage()` callback via `wireMessageHandler()` in bootstrap
- Responsibilities: Classify messages (command vs task), route to appropriate handler

## Error Handling

**Strategy:** Hierarchical error classes extending `AppError` with structured codes and contexts. Non-fatal subsystem failures use graceful degradation (return `undefined` instead of crashing).

**Patterns:**
- `Result<T, E>` discriminated unions for expected failures (config validation, path validation, memory operations)
- `AppError` hierarchy for exceptional errors: `ValidationError` (400), `SecurityError` (403), `ProviderError` (503), `ToolExecutionError` (500), `ChannelError` (503), `MemoryError` (500), `RAGError` (500)
- `isOperational` flag distinguishes expected vs unexpected errors
- `wrapError()` converts unknown errors to `AppError`
- `withRetry()` provides exponential backoff for transient network errors
- Tool results are sanitized via `sanitizeToolResult()` to strip API keys and cap length
- Subsystem init failures (memory, RAG, learning, dashboard) are caught in bootstrap and logged as warnings -- the app continues without them
- User-facing error messages never leak internal details

## Cross-Cutting Concerns

**Logging:**
- Winston logger created in bootstrap via `createLogger(logLevel, logFile)`
- Global logger accessible via `getLogger()` (module-level singleton in `src/utils/logger.ts`)
- Structured JSON logging with context objects

**Validation:**
- Config: Zod schemas in `src/config/config.ts`
- Tool input: JSON Schema per tool (`inputSchema` property)
- Paths: `PathGuard` in `src/security/path-guard.ts` prevents directory traversal
- General: Zod schemas in `src/validation/schemas.ts`

**Authentication:**
- `AuthManager` in `src/security/auth.ts` -- allowlists Telegram user IDs, Discord user/role IDs
- Per-channel auth checked in channel adapters before message reaches orchestrator
- Web channel binds to 127.0.0.1 only (no external auth needed)

**Rate Limiting:**
- `RateLimiter` in `src/security/rate-limiter.ts` -- per-user message rate, token usage, daily/monthly budgets
- Checked in orchestrator before processing each message

**Secret Sanitization:**
- `SecretSanitizer` in `src/security/secret-sanitizer.ts` -- regex patterns for known API key formats
- `sanitizeToolResult()` in orchestrator strips keys from tool output before feeding back to LLM
- Config `secretPatterns` in `src/config/config.ts` defines 15+ redaction patterns

**Dependency Injection:**
- `DIContainer` in `src/core/di-container.ts` -- simple container with singleton/transient/scoped lifecycles
- Currently used minimally; most wiring is explicit in `bootstrap()`
- `Services` const provides type-safe service key strings

---

*Architecture analysis: 2026-03-06*
