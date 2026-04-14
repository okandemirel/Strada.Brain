# Changelog

All notable changes to Strada.Brain are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- **Authoritative Unity Project Scope**: Runtime startup now treats the setup-selected `UNITY_PROJECT_PATH` as the coding scope of record. If a different Unity project is open in the editor, Strada surfaces a mismatch warning instead of silently retargeting work
- **Shared PAOR Loop Recovery**: Interactive `clarification/verifier/visibility/reflection continue` paths and background reflection-continue now converge on the same loop-recovery executor, avoiding repeated prompt-injection loops and letting stuck turns escalate through the same replan/delegation controls
- **Windows Web Portal Setup**: Fixed path traversal checks using hardcoded `/` separator instead of `path.sep`, causing all static assets (JS, CSS, images) to return 403 Forbidden on Windows — the setup page and web portal appeared as a blank white page
- **Windows Path Validation**: `validatePathSafety` rejected Windows absolute paths (`C:\...`) because it checked `startsWith("/")` instead of `path.isAbsolute()`; browse API and save API were unusable on Windows
- **Windows Web Portal Auto-Build**: `ensureWebSetupAssetsReady` spawned `npm.cmd` without `shell: true`, causing EINVAL on Node.js 22+ and preventing the web portal from being built automatically during setup
- **Windows Browser Launch URL Escaping**: `openBrowser` passed unquoted URLs containing `&` to `cmd /c start`, where `&` acts as a command separator; the cache-bust parameter was silently dropped
- Cross-platform path separator fix applied consistently across `setup-wizard.ts`, `channel.ts`, `stage-daemon.ts`, `soul-loader.ts`, `speech-to-text.ts`, and `browser-automation.ts`

### Added
- **Web Portal — Code Mode (Phase 5)**: Monaco editor with multi-tab support, syntax highlighting for 30+ languages, file tree explorer with lazy-loaded directories and agent-touched file highlights, terminal output panel with 5k line cap, diff viewer. Full WebSocket event pipeline: `code:file_open`, `code:file_update`, `code:terminal_output`, `code:annotation_add`. Workspace file REST endpoints with path security (traversal protection, denylist, symlink verification, 1MB size limit)
- **Web Portal — Auto Mode Switching (Phase 6)**: Intelligent auto-switching between Chat, Monitor, Canvas, and Code modes based on agent activity. Toast notification system with auto-dismiss, severity colors, and mode-switch undo. Keyboard shortcuts help modal (`Cmd/Ctrl+?`). Sidebar notification bell with badge count. Chat override reset (sending a message resumes auto-switch). Monitor export endpoint (`POST /api/monitor/export`) generating markdown reports with DAG summary, task list, and review results. Performance validated: 60-node DAG <50ms, 100 task updates <100ms, 50 code tabs <50ms
- **CLI Setup Wizard**: `strada setup` command with interactive terminal-based quick setup or web browser full setup. Asks for Unity project path, API key, channel, and language. Writes `.env` with owner-only permissions (0o600)
- **Auto-Update System**: Automatic version detection and self-updating for npm (global/local) and git installations. Checks daily, applies updates during idle periods. Configurable via `AUTO_UPDATE_*` env vars. Includes dependency installation before build, post-update health check with rollback, daemon-aware restart (safe for direct `strada start`), webhook-triggered immediate checks via `POST /api/update`, and atomic lock file acquisition
- **Source Launcher Uninstall + Binding Refresh**: source installs now support `strada uninstall` / `./strada uninstall` with optional `--purge-config`, and git auto-update now rewrites installed bare-command wrappers so they keep following the active checkout
- **CLI Commands**: `strada update` (manual update), `strada update --check` (check only), `strada version-info` (version + install method + update status), `strada setup` (setup wizard)
- **Global CLI Install**: `npm install -g strada-brain` registers `strada` and `strada-brain` commands via bin field
- **ChannelActivityRegistry**: Per-channel activity tracking for idle detection and cross-channel notification delivery
- **BackgroundExecutor.hasRunningTasks()**: Public method for checking if background tasks are running or queued
- **Agent Core**: Autonomous OODA reasoning loop (observe → orient → decide → act) with a registered observer set. Default daemon wiring currently uses trigger, user-activity, and git-state observers, while build/test observers are attached only when those runtime signals are available. Includes PriorityScorer with learning integration and budget-safe LLM reasoning with 3-layer throttling
- **Multi-Provider Routing**: Task-aware dynamic provider selection with TaskClassifier (heuristic), ProviderRouter with configurable presets (budget/balanced/performance), PAOR phase switching across providers
- **Confidence-Based Consensus**: ConfidenceEstimator (heuristic scoring from PAOR state) + ConsensusManager (review/re-execute strategies, fail-safe on errors)
- **Autonomous Agent Overhaul**: 3-layer autonomous bypass (system prompt injection, ask_user/show_plan tool auto-resolve, DaemonSecurityPolicy override with time-based expiry)
- **Verifier Pipeline**: explicit build/log/targeted-repro/conformance/completion-review pipeline with verifier-driven continue vs replan outcomes
- **Execution Journal + Adaptive Phase Scores**: PAOR now keeps branch/rollback memory per task and feeds runtime phase outcomes back into routing without hardcoded provider lore, including project/world anchors, verifier clean rate, rollback pressure, retry count, repeated failure fingerprints, repeated world-context failures, and phase-local token cost
- **Execution Replay Memory**: learning trajectories now carry project/world-aware recovery summaries, and orchestrator injects the most relevant prior success/failure branches as an `Execution Replay` context layer before retrying similar work
- **Persistent Phase Replay Signals**: trajectory replay context now also stores phase/provider telemetry for each task window, letting adaptive routing reuse successful workers for similar tasks across sessions instead of relying only on in-memory phase history
- **Exact Task Replay Correlation**: learning trajectories, runtime traces, and replay context now persist chat-scoped `taskRunId` values so concurrent tasks in the same chat keep separate phase telemetry and recovery history
- **Verdict-Aware Replay Weighting**: adaptive routing now also blends the strongest available verdict for each replayed terminal / verification trajectory phase into persisted phase signals, preferring trusted judge types before recency, so weakly judged branches lose influence without penalizing earlier non-terminal phases for a later bad final result
- **Memory Role Split**: User profile state is now separated from task execution memory, while session summaries, open items, verifier memory, and rollback context persist outside the persona/preferences layer. Task execution memory remains the `latest snapshot` only; exact task chronology lives in replay trajectories keyed by `taskRunId`. Project/world memory is now also surfaced explicitly as its own prompt layer from the active project root plus cached project analysis
- **MiniMax Catalog Refresh Coverage**: MiniMax official docs/pricing sources are now part of provider-source refresh, `MiniMax-M2.7` is the default worker preset, and official model signals can now supplement selector model lists when the shared catalog lags
- **Catalog-Aware Adaptive Routing**: provider routing now also scores provider catalog freshness and official alignment / capability drift, so worker selection can react when official sources move ahead of stale local assumptions
- **First-Run Web Handoff Hardening**: `strada setup` now retries the post-save web launch automatically, keeps a dedicated handoff page alive on the same URL until the main app is ready, and rejects any second Save after config has already been committed
- **Source-Install Doctor Semantics**: `strada doctor` now treats missing `dist/` as a warning, not a blocker, when a git/source checkout is already runnable through the source launcher, and it prints the exact repo-root bootstrap command
- **OpenAI Subscription Session Validation**: setup, doctor, and OpenAI health checks now validate the local ChatGPT/Codex subscription session eagerly and surface expired-token failures before they degrade into later background 401s
- **Setup Bootstrap Status Contract**: the web setup wizard now exposes explicit `saved` / `booting` / `ready` / `failed` handoff states on the same URL, keeps failures visible after refresh, and blocks repeat saves during handoff
- **Response Worker Preflight Contract**: setup, `strada doctor`, and bootstrap now require all selected response workers to pass real preflight instead of silently skipping invalid configured providers
- **OpenAI Responses Replay Repair**: ChatGPT/Codex subscription replay now sends assistant history with the supported `output_text` content shape, fixing the `Invalid value: 'input_text'` 400 during startup tasks
- **Internal Plan Deflection Gate**: Strada now keeps plain-text execution plans, action menus, and intake checklists inside the orchestration loop instead of surfacing them to the user before work is actually done, while still preserving an explicit plan-review / approval step when the user actually asked to see the plan first
- **Interaction Policy State Machine**: explicit plan-review requests, approval intent, and write blocking now flow through a shared internal control-plane gate instead of ad-hoc orchestrator checks
- **Phase-Local Verdict Memory**: runtime phase outcomes now persist explicit `clean` / `retry` / `failure` verdict labels and normalized scores, and replay persistence keeps those verdicts so routing can learn from individual planning / execution / review quality instead of only coarse terminal status
- **Structured Closure Review**: completion review now persists `verified` / `partial` / `unverified` closure state plus open investigations, so "build fixed but runtime hypotheses remain" stays internal in both interactive and daemon execution until the real issue is verified or honestly blocked
- **Visibility Boundary Repair**: user-visible replies now pass through a single fail-closed interaction boundary, worker tool pools exclude control-plane-only tools plus bridge-gated MCP actions, and searchable conversation memory persists only the visible transcript instead of raw worker drafts / verifier gates
- **Runtime Self-Improvement Artifacts**: high-confidence instincts now materialize runtime-first `skill`, `workflow`, and `knowledge_patch` artifacts in `shadow` state, promote to `active` only after verifier-backed clean evaluations, and expose lifecycle telemetry through `/routing info`, the dashboard, and the settings UI
- **Windows Install/Setup Parity**: source checkouts now have shared cross-platform launcher logic behind `strada`, `strada.ps1`, and `strada.cmd`; packaged installs default to `%LOCALAPPDATA%\Strada` on Windows; `install-command`, build, setup, and doctor guidance are now platform-aware instead of POSIX-only
- **Universal Node.js Entry Point**: `strada.js` lets users run `node strada.js setup` on any platform when native launchers (`strada`, `strada.cmd`, `strada.ps1`) aren't available or convenient
- **Windows Troubleshooting Docs**: All 8 language READMEs now include Windows-specific guidance for ExecutionPolicy workarounds, `strada.cmd` as the simpler alternative, and the `pipefail` SyntaxError when users accidentally run `node strada`
- **PAOR Unification**: Removed TaskPlanner conflicting PLANNING_PROMPT, background tasks now use full PAOR (reflect/replan), extracted shared buildSystemPromptWithContext()
- **Strada.MCP Detection**: Automatic detection of sibling Strada.MCP installation with system prompt awareness (76 tools)
- **TierRouter Facade**: ProviderRouter wraps TierRouter as internal sub-component for delegation compatibility
- `/daemon` command (start/stop/status/triggers) with Turkish `/arka-plan`
- `/agent` command for Agent Core status with Turkish `/ajan`
- `/routing` command (status/preset/info) with Turkish `/yonlendirme`
- Web daemon toggle with configured/not-configured state detection
- Interactive routing preset selector in SettingsPage
- `/api/daemon/start`, `/api/daemon/stop` POST endpoints
- `/api/agent-activity` GET endpoint for routing decisions, runtime execution traces, and phase outcomes (including clarification-review)
- `/api/routing/preset` POST endpoint for runtime preset switching
- AgentNotifier for proactive user notifications
- TestResultObserver for test execution monitoring
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
- SOUL.md agent personality system with hot-reload and per-channel overrides (`SOUL_FILE_{CHANNEL}` env vars)
- Personality profiles: casual, formal, minimal (in `profiles/` directory)
- `switch_personality` tool for runtime personality switching (casual/formal/minimal/default)
- `ask_user` tool for LLM-driven clarification questions with multiple-choice options and recommended answer
- `show_plan` tool for execution plan approval workflow (Approve/Modify/Reject)
- React + Vite web portal replacing vanilla HTML/JS (dark/light theme, file upload, streaming responses)
- Dashboard tab in web portal with full metrics (system health, tokens, tools, agent performance, daemon, deployment)
- Collapsible side panel in web portal with agent status and session info
- **Web Portal — Shadcn/UI Integration**: Full migration to shadcn/ui component system with `cn()` utility, `components.json` registry, and `@/` path alias. Migrated Button (with cva variants), Dialog, DropdownMenu, Tooltip, Tabs to shadcn/ui pattern. Added 7 new base components: Badge, Sheet, ScrollArea, Skeleton, Input, Table, Separator
- **Web Portal — 21st.dev / Magic UI Components**: Integrated community components from 21st.dev and Magic UI registries — NumberTicker (animated dashboard metrics), BlurFade (page entry animations), BorderBeam (active card borders), TypingAnimation (AI thinking indicator), SparklesText (brand title sparkles), ShimmerButton (chat send shimmer), CoolMode (send button confetti easter egg). 11 components installed via `npx shadcn@latest add`
- **Web Portal — Glassmorphism Visual Evolution**: Evolved portal identity from flat dark UI to modern glassmorphism design. `backdrop-blur-xl`, `bg-white/3`, `border-white/5` applied to all panels: Sidebar (with cyan left-bar active indicator, micro-interactions), Chat (gradient user bubbles, glassmorphism AI bubbles, hover-reveal copy buttons), Dashboard (redesigned MetricCards with status-colored accent strips, count-up animation, SVG sparklines), Monitor (DAG node status borders, timeline activity feed, kanban drag glow), Code panel (file type icons, tab glow, glassmorphism terminal), all admin pages
- **Web Portal — Sonner Notification System**: Replaced custom Toast with Sonner toast library. Transient toasts (auto-dismiss, severity colors, action buttons with undo) + persistent Notification Center sheet (grouped history: today/earlier, dismiss actions). Dual-write pattern: Sonner owns display, workspace-store owns history
- **Web Portal — Collapsible Admin Navigation**: Replaced AdminDropdown with in-sidebar collapsible AdminNav section. Chevron toggle, smooth height animation, auto-expand on admin routes, cyan active highlighting. 11 admin pages directly accessible from sidebar
- **Web Portal — Shared UI Primitives**: Extracted reusable components from review findings — PageSkeleton (loading shimmer), PageError (error state), CopyButton (clipboard with timer cleanup), Sparkline (React.memo SVG), StatusDot styles (`status-styles.ts`), glass style constants (`lib/styles.ts`)

### Security
- DaemonSecurityPolicy autonomous override now includes time-based expiry (auto-revokes)
- Consensus fail-safe: null LLM response treated as non-approval for destructive operations
- MCP path newline sanitization prevents prompt injection via malicious symlinks
- `/api/providers/switch` added to proxy allowlist (was silently returning 403)
- TOCTOU safety in strada-deps.ts filesystem checks
- LLM response fields capped at 2000 characters in consensus
- Budget pct scale corrected (0.0-1.0 decimal, not 0-100 percentage)
- SSRF protection on all media download URLs (private IP blocklist, redirect rejection)
- Media validation enforced across all channels: MIME allowlist, per-type size limits, magic bytes
- Telegram bot token sanitized from download URL logs
- Web channel error messages no longer leak internal details
- IPv6 SSRF bypass vector blocked in media download
- WhatsApp video/audio/document now validated with actual file size (was size:0 bypass)
- Discord image attachments now downloaded and magic-bytes validated

### Fixed
- **Web Portal — 6 Navigation & UI Bugs**: Fixed admin panel navigation from Code/Monitor/Canvas tabs (mode→chat on admin click), chat return from admin pages (navigate to / on Chat click), admin panel scroll on all 10 pages (flex-1→h-full), notification button (was no-op), personality page stale data after onboarding (refetchOnMount: always), mobile BottomTabBar same-route navigation
- **Web Portal — AdminNav Route Sync**: Fixed stale expanded state when navigating between admin and non-admin routes (useEffect sync)
- **Web Portal — CopyButton Timer Leak**: Fixed setTimeout not cleared on unmount in CopyButton (useRef + cleanup)
- **Windows `npm run bootstrap`**: bash-only `;` command separator replaced with cross-platform `&&` — bootstrap was silently broken on Windows cmd.exe
- **Windows `npm run test`**: NODE_OPTIONS heap config moved into `run-vitest-batches.mjs` programmatically — POSIX `VAR=val cmd` syntax doesn't work on Windows
- **Kimi K2.5 type assertion**: added missing intermediate `unknown` cast for `OpenAIMessage` → `Record<string, unknown>` conversion (CI typecheck failure)
- **McpInstallPanel lint**: replaced `useEffect` + `setState` anti-pattern with derived state to satisfy `react-hooks/set-state-in-effect` rule
- TaskPlanner PLANNING_PROMPT conflict with PAOR state machine resolved
- Background tasks now use PAOR reflection and replanning (were using flat loop)
- Daemon toggle UX: shows "Not Configured" vs "Stopped" vs "Running"
- Provider routing cost/speed scores clamped to prevent negative values
- Reasoning prompt correctly passed as user message (was system prompt)
- Goal submissions from AgentCore include origin:"daemon" for security policy
- trimSession now preserves tool_call/tool_result pairs (prevents Kimi API 400 errors)
- Conversation persistence after every message exchange (agent remembers across sessions)
- Task progress spam suppressed — user sees only final results
- Task failure shows generic error message (no internal API error leakage)

### Changed
- Split 4 large monolithic files into focused modules (-5,179 lines, 22 new files):
  - `orchestrator.ts` (8,929→7,777 lines): extracted supervisor-routing, session-persistence, clarification, context-builder helpers
  - `bootstrap-stages.ts` (2,190 lines→directory): split into typed stage modules with barrel re-export
  - `agentdb-memory.ts` (2,398→1,444 lines): extracted sqlite, vector, tiering, retrieval helpers using delegation pattern
  - `bootstrap.ts` (1,925→1,040 lines): extracted providers, memory, channels, wiring helpers
- README tool descriptions now reflect `BurstSystem` scaffolding instead of the old `SystemGroup` wording
- Intelligence documentation now describes the deep-parser-based analyzer and the Strada API drift pipeline

---

## [4.2.69] - 2026-04-14 — Codebase Memory Vault (Phase 1 + Phase 2)

### Added
- **Codebase Memory Vault — Phase 1 (Hybrid Retrieval)**: Persistent per-project codebase memory at `<project>/.strada/vault/index.db` (`better-sqlite3`, WAL + foreign_keys). Tables: `vault_files`, `vault_chunks`, `vault_chunks_fts` (FTS5/BM25), `vault_embeddings` (HNSW pointer), `vault_meta`. Hybrid retrieval fuses BM25 and vector recall via Reciprocal Rank Fusion (k=60), with token-budget-aware greedy packing (`packByBudget`). Three update paths: chokidar watcher (default 800ms debounce), write-hook (`installWriteHook`, 200ms sync budget) for Strada.Brain's own tool writes, and manual `/vault sync` for full reindex. xxhash64 content hashes short-circuit unchanged files (no re-embed). Language-aware chunking via `chunker.ts`, per-file kind detection via `discovery.ts`. Tools `vault_init`, `vault_sync`, and `vault_status` registered with the agent tool registry. Portal `/admin/vaults` exposes Files (tree + markdown/raw preview) and Search (hybrid query) tabs. HTTP surface at `/api/vaults/*`; WebSocket event `vault:update` broadcasts dirty-set batches
- **Codebase Memory Vault — Phase 2 (Symbol Graph + PPR + SelfVault + Graph UI)**: Adds a deterministic L2 symbol layer on top of Phase 1's L3 hybrid search. New tables `vault_symbols`, `vault_edges`, `vault_wikilinks` in `schema.sql`; `vault_meta.indexer_version='phase2.v1'`. Tree-sitter WASM extractors for TypeScript and C# (`src/vault/symbol-extractor/`) plus a regex wikilink extractor for markdown. Symbol IDs use `<lang>::<relPath>::<qualifiedName>` (e.g. `csharp::Assets/Scripts/Player.cs::Game.Player.Move`); unresolved externs use `<lang>::unresolved::<label>`. `.strada/vault/graph.canvas` (JSON Canvas 1.0) regenerated atomically on cold start, `/vault sync`, and watcher drain. Personalized PageRank (`src/vault/ppr.ts`) re-ranks hybrid results when `VaultQuery.focusFiles` is set; the RRF-only path is preserved when omitted. **SelfVault** (`src/vault/self-vault.ts`) indexes Strada.Brain's own source automatically (`src/`, `web-portal/src/`, `tests/`, `docs/`, `AGENTS.md`, `CLAUDE.md`); symlinks are skipped. Three new HTTP endpoints: `GET /api/vaults/:id/canvas`, `GET /api/vaults/:id/symbols/by-name?q=X`, `GET /api/vaults/:id/symbols/:symbolId/callers`. Portal `/admin/vaults` gains a **Graph** tab rendering `graph.canvas` via `@xyflow/react` + `@dagrejs/dagre` (no new frontend dependencies)
- **Vault Configuration**: `config.vault.enabled` (default `false`, env `STRADA_VAULT_ENABLED`), `config.vault.writeHookBudgetMs` (default 200, env `STRADA_VAULT_WRITE_HOOK_BUDGET_MS`), `config.vault.debounceMs` (default 800, env `STRADA_VAULT_DEBOUNCE_MS`), `config.vault.embeddingFallback` (`'none' | 'local'`, default `'local'`), `config.vault.self.enabled` (default `true`, opt out of SelfVault)
- **Vault Documentation**: New authoritative reference at `docs/vault.md` covering overview, quick start, three-layer architecture (L1 file metadata → L2 symbol graph → L3 hybrid chunks), Phase 1 and Phase 2 details, configuration reference, HTTP API shapes, portal UI guide, security posture, and Phase 3 roadmap

### Security
- **Atomic canvas writes**: `graph.canvas` is written via temp file + rename; no partial-write reads
- **Symlink-skip in SelfVault discovery**: prevents directory escape via symlinks pointing outside the repo
- **Fresh tree-sitter Parser per call**: concurrency safety; no shared parser state
- **Search endpoint maxBytes cap**: request body capped to prevent DoS
- **Orphaned edge GC**: edges referencing deleted files are removed on reindex
- **PPR damping normalization**: stationary distribution sums to 1 (no drift or bias)
- **2 MB cap on symbol extraction per file**: bounds memory/CPU per parse
- **Edge cache invalidation on `reindexFile`**: prevents stale graph state
- **Bounded `findCallers` results**: no unbounded graph walks

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
