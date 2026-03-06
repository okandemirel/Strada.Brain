# Codebase Structure

**Analysis Date:** 2026-03-06

## Directory Layout

```
Strada.Brain/
├── src/                        # All source code (TypeScript ESM)
│   ├── index.ts                # CLI entry point (Commander)
│   ├── integration.test.ts     # Top-level integration tests
│   ├── test-helpers.ts         # Shared test utilities
│   ├── agents/                 # AI agent core: orchestrator, providers, tools, autonomy
│   │   ├── orchestrator.ts     # Core agent loop (PAOR state machine)
│   │   ├── agent-state.ts      # PAOR state types and transitions
│   │   ├── paor-prompts.ts     # Phase-aware prompt builders
│   │   ├── failure-classifier.ts # Determines when to force replan
│   │   ├── instinct-retriever.ts # Queries learned patterns for proactive hints
│   │   ├── autonomy/           # Error recovery, task planner, self-verification
│   │   ├── context/            # System prompt builders (Strata knowledge)
│   │   ├── plugins/            # Plugin loader for external tools
│   │   ├── providers/          # 12 AI provider implementations + manager
│   │   └── tools/              # 25+ built-in tools (file, git, search, shell, .NET, Strata)
│   │       └── strata/         # Strata framework-specific code generators
│   ├── alerting/               # Alert manager and monitors
│   │   └── monitors/           # Health check monitors
│   ├── audit/                  # Security audit logging
│   ├── backup/                 # Backup scheduler
│   ├── channels/               # Multi-platform channel adapters
│   │   ├── channel.interface.ts        # Unified IChannelAdapter
│   │   ├── channel-core.interface.ts   # Segregated interfaces
│   │   ├── channel-messages.interface.ts # Message types
│   │   ├── cli/                # CLI/REPL channel
│   │   ├── discord/            # Discord bot (discord.js)
│   │   ├── slack/              # Slack bot (@slack/bolt)
│   │   ├── telegram/           # Telegram bot (grammy)
│   │   ├── web/                # Web UI channel (WebSocket + HTTP)
│   │   │   └── static/         # Web frontend assets (HTML/CSS/JS)
│   │   └── whatsapp/           # WhatsApp client
│   ├── common/                 # Shared errors, constants, barrel exports
│   ├── config/                 # Zod-validated config from env vars
│   ├── core/                   # Bootstrap, DI container, tool registry, setup wizard
│   ├── dashboard/              # Metrics, HTTP dashboard, Prometheus, WebSocket server
│   ├── encryption/             # Data protection utilities
│   ├── gateway/                # Daemon process manager (auto-restart)
│   ├── intelligence/           # C# parser, Strata analyzer, code quality
│   ├── learning/               # Experience replay and pattern learning
│   │   ├── hooks/              # Error learning hooks
│   │   ├── matching/           # Pattern matcher (HNSW + keyword)
│   │   ├── pipeline/           # Learning pipeline orchestration
│   │   ├── scoring/            # Confidence scorer (Bayesian, Elo, Wilson)
│   │   └── storage/            # SQLite storage for instincts/trajectories
│   ├── memory/                 # Conversation memory and project cache
│   │   └── unified/            # Planned unified memory (AgentDB, not yet wired)
│   ├── network/                # Firewall utilities
│   ├── plugins/                # Plugin hot-reload and registry
│   ├── rag/                    # RAG pipeline: chunking, embedding, vector search
│   │   ├── embeddings/         # Embedding providers, cache, resolver
│   │   └── hnsw/               # HNSW approximate nearest neighbor index
│   ├── security/               # Auth, rate limiter, path guard, secrets, RBAC
│   ├── tasks/                  # Background task system (router, executor, decomposer)
│   ├── tests/                  # Test helpers and integration tests
│   │   ├── helpers/            # Test utility functions
│   │   └── integration/        # Integration test suites
│   ├── types/                  # Core type definitions (Brand types, Result, Option, etc.)
│   ├── utils/                  # Logger, diff formatter, process runner
│   └── validation/             # Zod schemas for runtime validation
├── dist/                       # Compiled output (tsc)
├── docker/                     # Docker-related configs
├── docs/                       # Documentation
│   ├── deployment/             # Deployment guides
│   ├── plans/                  # Implementation plan documents
│   └── security/               # Security documentation
├── logs/                       # Runtime log files
├── monitoring/                 # Monitoring configuration (Grafana, etc.)
├── nginx/                      # Nginx reverse proxy config
│   └── ssl/                    # SSL certificates
├── pentest/                    # Penetration testing
│   ├── payloads/               # Test payloads
│   ├── reports/                # Pen test reports
│   └── scripts/                # Security test scripts
├── scripts/                    # Build/deploy/utility scripts
├── .claude/                    # Claude Code configuration and skills
│   └── skills/                 # Custom Claude skills
├── .planning/                  # GSD planning documents
│   └── codebase/               # Codebase analysis (this file)
├── .strata-memory/             # Runtime data (SQLite DBs, vectors, cache)
├── package.json                # Node.js manifest
├── tsconfig.json               # TypeScript config (ES2022, strict, ESM)
├── vitest.config.ts            # Test runner config
├── eslint.config.js            # Linter config
├── .prettierrc                 # Formatter config
├── Dockerfile                  # Production container
├── docker-compose.yml          # Multi-service compose
└── grafana-dashboard.json      # Grafana metrics dashboard
```

## Directory Purposes

**`src/agents/`:**
- Purpose: The AI agent core -- orchestrator, providers, tools, autonomy
- Contains: Orchestrator (agent loop), PAOR state machine, 12 AI providers, 25+ tools, autonomy subsystem
- Key files: `orchestrator.ts`, `agent-state.ts`, `paor-prompts.ts`, `failure-classifier.ts`, `instinct-retriever.ts`

**`src/agents/providers/`:**
- Purpose: AI provider implementations with per-chat switching
- Contains: One file per provider (Claude, OpenAI, Gemini, DeepSeek, Qwen, Kimi, MiniMax, Groq, Mistral, Together, Fireworks, Ollama), plus `openai-compat.ts` base class, `provider-manager.ts`, `provider-registry.ts`, `fallback-chain.ts`
- Key files: `provider.interface.ts`, `provider-core.interface.ts`, `provider-manager.ts`

**`src/agents/tools/`:**
- Purpose: Tool implementations invokable by the AI
- Contains: One file per tool category (file ops, search, git, shell, .NET, code quality, browser, memory, RAG)
- Key files: `tool.interface.ts`, `tool-core.interface.ts`

**`src/agents/tools/strata/`:**
- Purpose: Strata framework-specific code generators (create modules, components, mediators, systems)
- Contains: `analyze-project.ts`, `module-create.ts`, `component-create.ts`, `mediator-create.ts`, `system-create.ts`

**`src/agents/autonomy/`:**
- Purpose: Agent self-management -- error recovery, task planning, self-verification
- Contains: `error-recovery.ts`, `task-planner.ts`, `self-verification.ts`, `constants.ts`, `index.ts`

**`src/channels/`:**
- Purpose: Platform-specific message adapters
- Contains: One subdirectory per channel platform, plus shared interfaces
- Key files: `channel.interface.ts`, `channel-core.interface.ts`, `channel-messages.interface.ts`

**`src/core/`:**
- Purpose: Application lifecycle, DI container, tool registry, setup wizard
- Contains: `bootstrap.ts` (main wiring), `di-container.ts`, `tool-registry.ts`, `setup-wizard.ts`

**`src/config/`:**
- Purpose: Configuration loading and validation from env vars
- Contains: `config.ts` (Zod schema, `loadConfig()`, secret patterns), `strada-deps.ts` (Strada framework dependency checker)

**`src/tasks/`:**
- Purpose: Background task execution with concurrency control and command routing
- Contains: `message-router.ts`, `command-handler.ts`, `command-detector.ts`, `task-manager.ts`, `background-executor.ts`, `task-decomposer.ts`, `task-storage.ts`, `progress-reporter.ts`, `types.ts`

**`src/learning/`:**
- Purpose: Experience replay and pattern learning from tool usage and errors
- Contains: Subdirectories for `hooks/`, `matching/`, `pipeline/`, `scoring/`, `storage/`

**`src/memory/`:**
- Purpose: Persistent conversation memory and project analysis cache
- Contains: `memory.interface.ts`, `file-memory-manager.ts`, `text-index.ts`
- Note: `unified/` subdirectory contains planned AgentDB implementation not yet wired to bootstrap

**`src/rag/`:**
- Purpose: RAG pipeline for Unity project code indexing and semantic search
- Contains: `rag-pipeline.ts`, `chunker.ts`, `vector-store.ts`, `vector-math.ts`, `reranker.ts`
- Subdirectories: `embeddings/` (providers, cache, resolver), `hnsw/` (approximate nearest neighbor)

**`src/security/`:**
- Purpose: Authentication, authorization, rate limiting, path safety, secret scrubbing
- Contains: `auth.ts`, `rate-limiter.ts`, `path-guard.ts`, `secret-sanitizer.ts`, `read-only-guard.ts`, `dm-policy.ts`, `rbac.ts`, `browser-security.ts`, `communication.ts`, `dependency-security.ts`, `filesystem-security.ts`

**`src/intelligence/`:**
- Purpose: Static code analysis for Unity C# projects
- Contains: `strata-analyzer.ts` (project structure analysis), `csharp-parser.ts`, `csharp-deep-parser.ts` (AST-like C# parsing), `code-quality.ts` (metrics)

**`src/dashboard/`:**
- Purpose: Observability -- metrics collection, HTTP dashboard, Prometheus export
- Contains: `metrics.ts`, `server.ts`, `prometheus.ts`, `websocket-server.ts`

**`src/common/`:**
- Purpose: Shared constants, error classes, barrel exports
- Contains: `constants.ts` (all magic numbers centralized), `errors.ts` (hierarchical error classes), `index.ts`

**`src/types/`:**
- Purpose: Core type system -- brand types, Result/Option monads, vector types, utility types
- Contains: `index.ts` (single barrel file with all types)

**`src/utils/`:**
- Purpose: Cross-cutting utilities
- Contains: `logger.ts` (Winston wrapper), `diff-formatter.ts`, `diff-generator.ts`, `process-runner.ts`

**`src/validation/`:**
- Purpose: Reusable Zod validation schemas
- Contains: `schemas.ts`, `index.ts`

## Key File Locations

**Entry Points:**
- `src/index.ts`: CLI entry point -- Commander setup, `startApp()`, shutdown handlers
- `src/core/bootstrap.ts`: Service initialization and wiring -- the "main" function

**Configuration:**
- `src/config/config.ts`: Zod config schema, `loadConfig()`, `loadConfigSafe()`, secret patterns
- `src/common/constants.ts`: All magic numbers, limits, thresholds, defaults
- `tsconfig.json`: TypeScript (ES2022, strict, ESM, bundler resolution)
- `vitest.config.ts`: Test framework config
- `eslint.config.js`: Linter rules
- `.prettierrc`: Formatter config

**Core Logic:**
- `src/agents/orchestrator.ts`: Agent loop, session management, PAOR integration
- `src/agents/agent-state.ts`: PAOR state machine types and transitions
- `src/agents/paor-prompts.ts`: Phase-aware prompt builders
- `src/tasks/message-router.ts`: Central message routing (command vs task)
- `src/tasks/background-executor.ts`: Concurrent task execution

**Interfaces (contracts):**
- `src/agents/providers/provider.interface.ts`: `IAIProvider`, `IStreamingProvider`
- `src/agents/tools/tool.interface.ts`: `ITool`, `IEnhancedTool`
- `src/channels/channel.interface.ts`: `IChannelAdapter`
- `src/channels/channel-core.interface.ts`: Segregated channel interfaces
- `src/memory/memory.interface.ts`: `IMemoryManager`
- `src/rag/rag.interface.ts`: `IRAGPipeline`, `IVectorStore`, `IEmbeddingProvider`

**Testing:**
- `src/test-helpers.ts`: Shared test utilities
- `src/integration.test.ts`: Top-level integration tests
- `src/tests/`: Additional test helpers and integration suites
- Co-located tests: `*.test.ts` files alongside source files

## Naming Conventions

**Files:**
- `kebab-case.ts` for all source files: `file-memory-manager.ts`, `error-recovery.ts`
- `*.test.ts` for test files co-located with source: `orchestrator.test.ts`
- `*.interface.ts` for interface-only files: `provider.interface.ts`, `channel.interface.ts`
- `index.ts` for barrel exports in directories: `src/tasks/index.ts`, `src/learning/index.ts`

**Directories:**
- `kebab-case` for all directories: `agents/`, `rate-limiter/`
- Flat structure within feature directories (no deep nesting beyond 2 levels)

**Classes:**
- PascalCase: `Orchestrator`, `FileMemoryManager`, `TaskDecomposer`
- Suffix with role: `*Manager`, `*Pipeline`, `*Storage`, `*Handler`, `*Tool`, `*Provider`, `*Channel`

**Interfaces:**
- Prefixed with `I`: `IAIProvider`, `IChannelAdapter`, `IMemoryManager`, `ITool`, `IRAGPipeline`

**Types:**
- PascalCase: `AgentState`, `Config`, `IncomingMessage`
- Brand types: `UserId`, `ChatId`, `MemoryId` (via `Brand<K, T>`)
- Enums: PascalCase with UPPER_CASE values: `AgentPhase.PLANNING`

**Constants:**
- UPPER_SNAKE_CASE grouped in const objects: `FILE_LIMITS.MAX_FILE_SIZE`, `SESSION_CONFIG.MAX_SESSIONS`
- Exported individually for backward compat: `export const MAX_TOOL_ITERATIONS = TOOL_LIMITS.MAX_TOOL_ITERATIONS`

## Where to Add New Code

**New AI Provider:**
- Implementation: `src/agents/providers/{name}.ts` -- extend `OpenAICompatProvider` from `openai-compat.ts` if API is OpenAI-compatible
- Tests: `src/agents/providers/{name}.test.ts`
- Register in: `src/agents/providers/provider-registry.ts` (add to `PROVIDER_PRESETS` and `createProvider()` switch)
- Add API key to: `src/config/config.ts` (add to `EnvVarName`, Zod schema, `Config` interface, `loadFromEnv()`)
- Add embedding preset to: `src/common/constants.ts` (`EMBEDDING_PRESETS`)

**New Tool:**
- Implementation: `src/agents/tools/{name}.ts` -- implement `ITool` interface
- Tests: `src/agents/tools/{name}.test.ts`
- Register in: `src/core/tool-registry.ts` (`registerBuiltinTools()` method)

**New Channel:**
- Implementation: `src/channels/{name}/` directory with main adapter file
- Must implement: `IChannelAdapter` from `src/channels/channel.interface.ts`
- Register in: `src/core/bootstrap.ts` (`initializeChannel()` switch statement)
- Add to: `src/common/constants.ts` (`CHANNEL_DEFAULTS.SUPPORTED_TYPES`)

**New Feature (full subsystem):**
- Primary code: `src/{feature-name}/` directory
- Interface: `src/{feature-name}/{feature}.interface.ts`
- Implementation: `src/{feature-name}/{feature-name}.ts`
- Tests: Co-located `*.test.ts` files
- Wire in: `src/core/bootstrap.ts`
- Types: Add to `src/types/index.ts` if shared across modules

**New Utility:**
- Shared helpers: `src/utils/{name}.ts`
- Tests: `src/utils/{name}.test.ts`

**New Strata Tool:**
- Implementation: `src/agents/tools/strata/{name}.ts`
- Tests: `src/agents/tools/strata/{name}.test.ts`
- Register in: `src/core/tool-registry.ts` (`registerBuiltinTools()`)

**New Autonomy Component:**
- Implementation: `src/agents/autonomy/{name}.ts`
- Tests: `src/agents/autonomy/{name}.test.ts`
- Export from: `src/agents/autonomy/index.ts`
- Wire in: `src/agents/orchestrator.ts` (inline in agent loop)

## Special Directories

**`.strata-memory/`:**
- Purpose: Runtime data -- SQLite databases, vector indices, caches
- Generated: Yes (at runtime)
- Committed: No (in `.gitignore`)
- Contains: `learning.db`, `tasks.db`, `provider-preferences.db`, `vectors/`, `cache/`

**`dist/`:**
- Purpose: TypeScript compilation output
- Generated: Yes (`npm run build` / `tsc`)
- Committed: No (should be in `.gitignore`)

**`node_modules/`:**
- Purpose: npm dependencies
- Generated: Yes (`npm install`)
- Committed: No

**`.planning/`:**
- Purpose: GSD planning and analysis documents
- Generated: Yes (by analysis tools)
- Committed: Yes

**`pentest/`:**
- Purpose: Security testing scripts and reports
- Generated: Partially (reports generated, scripts authored)
- Committed: Yes

**`scripts/`:**
- Purpose: Build, deploy, and utility shell scripts
- Generated: No (authored)
- Committed: Yes

---

*Structure analysis: 2026-03-06*
