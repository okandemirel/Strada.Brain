# Changelog

All notable changes to Strada.Brain are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `sync:check` documentation across root READMEs and contributor guidance
- Local Unity fixture documentation for real Strada/Unity generator validation
- Media sharing pipeline: all channels now receive and forward image/video/audio/document attachments
- MediaProcessor utility (`src/utils/media-processor.ts`) with download, MIME validation, magic bytes, SSRF protection
- Claude provider vision support enabled (was disabled) with image block handling in `buildMessages()`
- Orchestrator `buildUserContent()` converts image attachments to MessageContent[] vision blocks
- Telegram: photo, document, video, voice/audio message handlers with media download and validation
- Discord: message attachment extraction with MIME classification and size validation
- WhatsApp: video/audio attachment detection, image data download for vision support
- Web channel: base64 media in WebSocket JSON with validation (max 5 per message)
- Slack: file extraction with authenticated download (Bearer token) and parallel processing
- SSRF protection: `isUrlSafeToFetch()` blocks private IPs, metadata endpoints, rejects redirects
- Streaming download with incremental size enforcement (prevents OOM from chunked responses)
- `mimeToAttachmentType()` shared helper for consistent MIME classification across channels

### Security
- SSRF protection on all media download URLs (private IP blocklist, redirect rejection)
- Media validation enforced across all channels: MIME allowlist, per-type size limits, magic bytes
- Telegram bot token sanitized from download URL logs
- Web channel error messages no longer leak internal details

### Changed
- README tool descriptions now reflect `BurstSystem` scaffolding instead of the old `SystemGroup` wording
- Intelligence documentation now describes the deep-parser-based analyzer and the Strada API drift pipeline

## [4.1.0] - 2026-03-13 — Deep Audit & Embedding Upgrade

### Added
- Gemini Embedding 2.0 (`gemini-embedding-2-preview`) with Matryoshka dimension support (128–3072)
- `EMBEDDING_DIMENSIONS` configuration parameter for variable-dimension embeddings
- Authoritative `STRADA_API` constants module as single source of truth for Strada.Core API references
- `croner` scheduling library for cron-based trigger evaluation
- Security warnings for unauthenticated monitoring endpoints

### Changed
- All hardcoded namespace/assembly references replaced with `STRADA_API` constants across codegen tools
- Redundant regex call eliminated in service field name generation
- Directory creation parallelized with `Promise.all` in module-create tool
- Memory directory migration optimized with try-catch error handling for ENOTEMPTY/EEXIST
- Brand rename completed: remaining legacy system prompt references updated to `STRADA`
- STRADA analyzer performance optimized with reduced redundant processing
- OpenAI embeddings provider now sends `dimensions` parameter to API (was configured but not transmitted)

### Fixed
- Hardcoded update phase enum replaced with `STRADA_API` constant in system-create
- Hardcoded assembly reference replaced with `STRADA_API` constant in module-create
- Hardcoded namespaces replaced with `STRADA_API` constants in mediator-create and component-create
- Brand rename in integration test and orchestrator test mocks
- Input validation added for system dependencies in codegen tools

### Security
- Command injection prevention hardened in bootstrap and process runner
- Critical input validation for system dependencies
- Authentication gap warnings for dashboard monitoring endpoints

---

## [4.0.0] - 2026-03-13 — Strada.Core API Truth

### Added
- Authoritative Strada.Core API reference constants for compile-clean code generation

### Changed
- All code generation tools updated to produce valid Strada.Core v4 output

---

## [3.0.0] - 2026-03-12 — Multi-Agent & Deployment (Level 5+)

v3.0 added 5 phases (21–25), shipping 22 requirements across 18 plans with 3070 tests and 135K LOC, adding multi-agent orchestration and deployment automation.

### Added
- AgentManager with per-channel session isolation and lifecycle management
- AgentRegistry and AgentBudgetTracker for multi-agent resource control
- DelegationManager with DelegationTool, TierRouter (4-tier), and depth enforcement (max 2)
- DeploymentExecutor with ReadinessChecker, DeployTrigger, approval gate, and circuit breaker
- Memory consolidation engine with HNSW clustering
- Dashboard delegations and agents panels with API endpoints
- CLI commands for agent and delegation management
- Phase 20 gap closure: trigger fire history persistence, goal:failed event emission, plan_summary column migration

### Changed
- Multi-agent opt-in via config; disabled = identical to v2.0
- Max delegation depth enforced at 2
- Deployment defaults to disabled, requires explicit opt-in

---

## [2.0.0] - 2026-03-10 — Full Daemon (Level 4 → 5)

v2.0 added 10 phases (10-19), shipping 33 requirements across 26 plans with 2775 tests and 118K LOC, transforming Strada.Brain into a 24/7 autonomous daemon.

### Added
- WebSocket Origin validation and auth rate-limiting (5 failures = 5min block)
- LLM self-awareness with capability manifest in system prompt and introspection tools
- Persistent identity state (boot count, uptime) with unclean shutdown recovery
- Cross-session learning transfer with project-scope filtering for instincts
- HeartbeatLoop background service with two-tier trigger evaluation (deterministic then LLM)
- TriggerRegistry with pluggable ITrigger lifecycle (CronTrigger, FileWatchTrigger, ChecklistTrigger, WebhookTrigger)
- Trigger deduplication with per-trigger cooldown and content-based dedup
- Interactive goal execution during chat with mid-execution replanning
- Dynamic memory re-retrieval on iteration count and topic shift during PAOR loops
- DigestReporter with configurable schedule and quiet hours buffering
- NotificationRouter with urgency levels (silent/low/medium/high/critical)
- Dashboard /api/daemon endpoint with identity state, trigger history, and uptime
- ChainValidator for post-synthesis validation against historical input/output pairs

### Changed
- GoalExecutor runs inline during interactive chat, not just background /task
- Failed goal subtrees re-decompose with current context instead of failing permanently
- Failure budget with user escalation prompt when budget exhausted

### Security
- DaemonSecurityPolicy enforces read-only default for daemon-initiated tool calls
- Daemon write operations queue for user approval, visible in dashboard
- Daily LLM budget cap halts daemon when exceeded and notifies user
- Exponential backoff and circuit breaker prevent runaway trigger re-evaluation

---

## [1.0.0] - 2026-03-08 — Agent Evolution (Level 3 → 4)

v1.0 was the first major milestone, 9 phases (1-9) shipping 32 requirements across 24 plans with 2142 tests and 97K LOC, transforming the agent from a chatbot wrapper into a genuine autonomous agent.

### Added
- AgentDB activation replacing FileMemoryManager with SQLite + HNSW vector memory
- MemoryMigrator for lossless import of existing JSON data into AgentDB
- HNSW semantic search for conversation retrieval (replaces TF-IDF)
- Write mutex preventing HNSW index corruption from concurrent writes
- 3-tier auto-tiering (Working/Ephemeral/Persistent) based on access patterns
- CachedEmbeddingProvider wired to learning pipeline for instinct embeddings
- SQLite pragma standardization (WAL mode, cache_size, busy_timeout) across all databases
- TypedEventBus decoupling orchestrator, learning pipeline, and memory subsystems
- LearningQueue with serial async processing and FIFO eviction
- Event-driven learning triggers replacing 5-minute batch timer
- MetricsStorage and MetricsRecorder for task completion rate, iterations, and pattern reuse
- Dashboard /api/agent-metrics endpoint with query filters
- CLI metrics command with table/JSON output
- Hybrid weighted confidence scoring (5-factor model) replacing LLM-only judgment
- Instinct lifecycle: cooling, deprecation (confidence < 0.3), and promotion (confidence > 0.95)
- GoalNode DAG with Kahn's algorithm cycle detection and max depth 3
- GoalDecomposer with proactive/reactive decomposition and dependency edges
- GoalExecutor with wave-based parallel execution, semaphore, and failure budgets
- Goal resume detecting interrupted trees on startup with staleness checks
- ChainDetector identifying recurring tool sequences (3+ occurrences, >80% success)
- ChainSynthesizer and CompositeTool registered as ITool in tool registry at runtime
- Comprehensive documentation rewrite covering all 21 subsystem READMEs

### Changed
- Confidence threshold gap enforced (new patterns start at max 0.5, not 0.8)
- Skip 100K-entry HNSW performance test in standard runs to avoid CI timeouts

---

## [0.5.0] - 2026-03-03 — Enterprise Refactor & Production Readiness

### Added
- Dependency injection container, bootstrap system, and tool registry (`src/core/`)
- Learning system with experience replay, hybrid weighted confidence scoring, and pattern matching (`src/learning/`)
- HNSW vector store delivering 150x--12,500x search performance improvement over flat scan
- Discord and Slack channel adapters (`src/channels/`)
- Unified 3-tier memory architecture (Working / Ephemeral / Persistent)
- Alerting, monitoring, backup, and encryption modules
- GitHub Actions CI/CD pipeline with ESLint and Prettier configs

### Changed
- Password hashing upgraded from custom SHA-256 to `scryptSync` + `timingSafeEqual`
- Brute-force lockout now uses escalating duration (2x--32x) instead of count reset
- Token revocation switched to time-based cleanup instead of clear-all
- JWT singleton is lazy-initialized (no startup crash when secret is absent)
- CSP policy uses SHA-256 hash instead of `unsafe-inline`
- Readiness check handles critical index state; degraded health returns HTTP 207
- `start()` now rejects on listen error; secret rotation uses `watchFile` instead of `fs.watch`

### Fixed
- TOTP verification now properly validates codes (was accepting any 6-digit input)
- Refresh token expiry enforced via `refreshExpiresAt` field
- MFA pre-token no longer leaks `passwordHash` or grants `system:read`
- Session invalidation properly cleans up all associated maps
- Browser `getOrCreateSession` cleans up partial resources on error
- Screenshot capture uses `writeFile` (was silently losing data with `createWriteStream`)
- Browser session `lastUsed` updated on every action (prevents premature cleanup)
- Download page leak fixed with `try/finally`
- WhatsApp socket teardown on reconnect, timer leak fixes, session cleanup `.unref()`
- HNSW index rebuilt on cold start; entries without embeddings no longer dropped
- `saveEntries` transaction atomicity restored; promote/demote/touch now persist to SQLite
- 20 failing tests across memory, learning, and RAG modules resolved
- Plugin registry properly disposes on unregister; concurrent init protection added
- Fire-and-forget promise warnings resolved with shared `sanitizeError` utility

### Security
- 42 security fixes across 7 hardening phases
- 6 new browser script validation patterns
- Rate limit defaults and full `RateLimitConfig` exposure for WhatsApp channel
- Embedding provider injection hardened

---

## [0.4.0] - 2026-03-02 — Autonomy & DevOps Tooling

### Added
- Autonomy layer: `ErrorRecoveryEngine` with O(1) error-code categorization and structured recovery context
- `TaskPlanner` with stall detection, budget warnings, and PLAN-ACT-VERIFY-RESPOND protocol
- `SelfVerification` gate that tracks file mutations and blocks agent exit until build passes
- Shell execution tool with safety blocklist and timeout support
- Git tools: status, diff, log, commit, branch, push, stash
- Dotnet build tool with MSBuild error/warning parsing
- Dotnet test runner with result parsing (passed/failed/skipped)
- File delete, rename, and directory delete tools
- Deep recursive-descent C# parser producing full AST (replaces regex-based parsing)
- Code quality analyzer with Strata-specific anti-pattern detection
- Streaming response support for Telegram (edit-message) and CLI channels
- Token-bucket rate limiter with per-user quotas and budget enforcement
- `FallbackChainProvider` streaming support

### Changed
- `isWriteOperation()` refactored from O(n) chain of 16 `===` to O(1) `Set.has()`
- Tool classification sets extracted to single-source-of-truth constants module
- `WRITE_OPERATIONS` composed from `MUTATION_TOOLS + VERIFY_TOOLS + SIDE_EFFECT_TOOLS` to prevent drift
- Agent loop limit raised from 15 to 50 iterations
- Write-confirmation required for all destructive operations
- `canStream` check hoisted before agent loop (computed once, not per iteration)
- `BUILTIN_TYPES` and `REFERENCE_TYPES` hoisted to module scope for performance

### Fixed
- Tool results re-sanitized after recovery injection to prevent API key leakage (8192-char cap enforced)
- Verification gate flag reset after build attempt so it can re-fire on failures
- Shell-exec path validation uses `validatePath()` instead of naive `startsWith`
- TOCTOU race in `FileDeleteTool` (stat-then-unlink replaced with unlink + error handling)
- TOCTOU race in `FileRenameTool` (stat-stat-rename replaced with rename + error handling)
- Dead state removed: `lastTestOk` (SelfVerification), `testsVerified` (TaskPlanner)
- Inline import type fixed in orchestrator `streamResponse`
- Dead `getDependencies` loop removed from code-quality module

### Security
- `sanitizeGitArg()` rejects args starting with `-` or containing shell metacharacters
- Credential URL scrubbing on all git output via `CREDENTIAL_URL_PATTERN`
- Read-only guards added to git checkout, stash push/pop/drop, dotnet build/test
- `git_branch`, `git_stash`, `dotnet_build`, `dotnet_test` registered as write operations
- Dotnet project paths validated via `validatePath` (path-guard)
- `--` separator before files in `git add` to prevent flag injection
- SIGKILL backup timer cleared in process-runner close/error handlers
- `API_KEY_PATTERN` widened to catch `ghp_`, `gho_`, `xox*`, `Bearer` tokens

---

## [0.3.0] - 2026-03-01 — RAG Pipeline & Plugin System

### Added
- RAG pipeline with vector embeddings for semantic C# code search
- C# structural chunker splitting files at class/method/struct boundaries
- File-based vector store with binary Float32Array storage and debounced flush
- OpenAI and Ollama embedding providers with batch processing and retry logic
- LRU embedding cache with disk persistence for cost reduction
- Reranker combining vector similarity, keyword overlap, and structural relevance
- Incremental RAG indexing via content-hash change detection
- `code_search` and `rag_index` tools for LLM integration
- Gateway daemon mode with auto-restart and exponential backoff
- ECS `SystemCreateTool` for SystemBase/JobSystemBase/SystemGroup scaffolding
- Dynamic plugin loader with `plugin.json` manifests and namespaced tools
- WhatsApp channel adapter via baileys (optional peer dependency)
- Streaming support via `chatStream()` on `IAIProvider` with Claude implementation
- Daemon CLI command

### Changed
- Test count increased from 196 to 446 across 12 new test files

---

## [0.2.0] - 2026-03-01 — Memory, Testing & Security Hardening

### Added
- Persistent memory layer with TF-IDF retrieval and project analysis caching
- `IMemoryManager` interface with JSON file-based implementation
- TF-IDF semantic text index with cosine similarity (zero external dependencies)
- `memory-search` tool for AI-callable memory retrieval
- `buildAnalysisSummary` for cached Strata project analysis injection into system prompt
- Conversation memory: trimmed session messages stored and searchable across restarts
- Context injection of retrieved memory and cached analysis before each LLM call
- `MEMORY_ENABLED` and `MEMORY_DB_PATH` configuration options
- Comprehensive test infrastructure with Vitest config and shared test helpers
- Co-located unit tests for all modules: security, config, agents, channels, intelligence, and logger

### Fixed
- 3 high-severity no-op tests now assert actual error content (orchestrator unknown tool/error, Telegram callback auth)
- Timer leak in `sanitizeToolResult` tests resolved with proper `beforeEach`
- 16 manual `vi.clearAllMocks()` calls removed in favor of `clearMocks: true` in Vitest config

### Security
- `default_value` blocklist in component-create replaced with strict allowlist regex
- Glob pattern sanitization and per-file `validatePath` in `GrepSearchTool`
- Null byte rejection in `validatePath` (defense-in-depth)
- `isValidCSharpType` rejects newlines; uses literal space instead of `\s`
- `BLOCKED_PATTERNS` expanded with 9 additional sensitive file types
- Warning emitted when Telegram allowlist is empty (all users denied)
- Sanitize tests extended for `key-`/`token-` patterns beyond `sk-`
- Absolute path escape test added to path-guard security tests

---

## [0.1.0] - 2026-03-01 — Initial Release

### Added
- AI-powered Unity development assistant for Strada.Core framework projects
- Telegram and CLI channel adapters
- Claude AI provider with tool-use agent loop
- 10 built-in tools: file read, file write, file search (grep), directory listing, component create, system create, analyze project, C# parser, Strata analyzer, and web search
- C# parser for structural code analysis
- Strata project analyzer for framework-specific insights
- Path-guard with directory traversal prevention
- JWT authentication with session management and configurable limits
- Input validation and ReDoS protection
- Sensitive file blocklist
- Configuration management via environment variables
