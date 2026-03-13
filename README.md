<p align="center">
  <img src="icon/strada-brain-icon.png" alt="Strada.Brain Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>AI-Powered Development Agent for Unity / Strada.Core Projects</strong><br/>
  An autonomous coding agent that connects to a web dashboard, Telegram, Discord, Slack, WhatsApp, or your terminal &mdash; reads your codebase, writes code, runs builds, learns from its mistakes, and operates autonomously with a 24/7 daemon loop. Now with multi-agent orchestration, task delegation, memory consolidation, and a deployment subsystem with approval gates.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/tests-3100%2B-brightgreen?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
</p>

<p align="center">
  <strong>English</strong> |
  <a href="README.tr.md">T&uuml;rk&ccedil;e</a> |
  <a href="README.zh.md">&#20013;&#25991;</a> |
  <a href="README.ja.md">&#26085;&#26412;&#35486;</a> |
  <a href="README.ko.md">&#54620;&#44397;&#50612;</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Espa&ntilde;ol</a> |
  <a href="README.fr.md">Fran&ccedil;ais</a>
</p>

---

## What Is This?

Strada.Brain is an AI agent you talk to through a chat channel. You describe what you want -- "create a new ECS system for player movement" or "find all components that use health" -- and the agent reads your C# project, writes the code, runs `dotnet build`, fixes errors automatically, and sends you the result.

It has persistent memory backed by SQLite + HNSW vectors, learns from past errors using Bayesian confidence scoring, decomposes complex goals into parallel DAG execution, automatically synthesizes multi-tool chains with saga rollback, and can run as a 24/7 daemon with proactive triggers. It supports multi-agent orchestration with per-channel session isolation, hierarchical task delegation across agent tiers, automatic memory consolidation, and a deployment subsystem with human-in-the-loop approval gates and circuit breaker protection.

**This is not a library or an API.** It is a standalone application you run. It connects to your chat platform, reads your Unity project on disk, and operates autonomously within the boundaries you configure.

---

## Quick Start

### Prerequisites

- **Node.js 20+** and npm
- An **Anthropic API key** (Claude) -- other providers are optional
- A **Unity project** with Strada.Core framework (the path you give the agent)

### 1. Install

```bash
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

```env
ANTHROPIC_API_KEY=sk-ant-...      # Your Claude API key
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Must contain Assets/
JWT_SECRET=<generate with: openssl rand -hex 64>
```

### 3. Run

```bash
# Web channel (default) - setup wizard opens at localhost:3000
# If no .env exists, the wizard guides you through initial setup
npm start

# Or explicitly with web channel
npm run dev -- start --channel web

# Interactive CLI mode (fastest way to test)
npm run dev -- cli

# Daemon mode (24/7 autonomous operation with proactive triggers)
npm run dev -- daemon --channel web

# Or with other chat channels
npm run dev -- start --channel telegram
npm run dev -- start --channel discord
npm run dev -- start --channel slack
npm run dev -- start --channel whatsapp
```

### 4. Talk to It

Once running, send a message through your configured channel:

```
> Analyze the project structure
> Create a new module called "Combat" with a DamageSystem and HealthComponent
> Find all systems that query for PositionComponent
> Run the build and fix any errors
```

**Web channel:** No terminal needed -- interact through the web dashboard at `localhost:3000`.

---

## Architecture

```
+-----------------------------------------------------------------+
|  Chat Channels                                                   |
|  Web | Telegram | Discord | Slack | WhatsApp | CLI              |
+------------------------------+----------------------------------+
                               |
                    IChannelAdapter interface
                               |
+------------------------------v----------------------------------+
|  Orchestrator (PAOR Agent Loop)                                  |
|  Plan -> Act -> Observe -> Reflect state machine                 |
|  Instinct retrieval, failure classification, auto-replan         |
+-------+--------------+-------------+-----------+----------------+
        |              |             |           |
+-------v------+ +-----v------+ +---v--------+ +v-----------------+
| AI Providers | | 30+ Tools  | | Context    | | Learning System  |
| Claude (prim)| | File I/O   | | AgentDB    | | TypedEventBus    |
| OpenAI, Kimi | | Git ops    | | (SQLite +  | | Bayesian Beta    |
| DeepSeek,Qwen| | Shell exec | |  HNSW)     | | Instinct life-   |
| MiniMax, Groq| | .NET build | | RAG vectors| |  cycle           |
| Ollama +more | | Strata gen | | Identity   | | Tool chains      |
+--------------+ +------+-----+ +---+--------+ +--+---------------+
                        |           |              |
                +-------v-----------v--------------v------+
                |  Goal Decomposer + Goal Executor        |
                |  DAG-based decomposition, wave-based    |
                |  parallel execution, failure budgets    |
                +---------+------------------+------------+
                          |                  |
          +---------------v------+  +--------v--------------------+
          | Multi-Agent Manager  |  | Task Delegation             |
          | Per-channel sessions |  | TierRouter (4-tier)         |
          | AgentBudgetTracker   |  | DelegationTool + Manager    |
          | AgentRegistry        |  | Max depth 2, budget-aware   |
          +---------------+------+  +--------+--------------------+
                          |                  |
                +---------v------------------v------------+
                |  Memory Decay & Consolidation           |
                |  Exponential decay, idle consolidation   |
                |  HNSW clustering, soft-delete + undo     |
                +-----------------------------------------+
                               |
            +------------------v-------------------+
            |  Daemon (HeartbeatLoop)              |
            |  Cron, file-watch, checklist,        |
            |  webhook, deploy triggers            |
            |  Circuit breakers, budget tracking,  |
            |  trigger deduplication                |
            |  Notification router + digest reports |
            +------------------+-------------------+
                               |
            +------------------v-------------------+
            |  Deployment Subsystem                |
            |  ReadinessChecker, DeployTrigger      |
            |  DeploymentExecutor                   |
            |  Approval gate + circuit breaker      |
            +--------------------------------------+
```

### How the Agent Loop Works

1. **Message arrives** from a chat channel
2. **Memory retrieval** -- AgentDB hybrid search (70% semantic HNSW + 30% TF-IDF) finds the most relevant past conversations
3. **RAG retrieval** -- semantic search over your C# codebase (HNSW vectors, top 6 results)
4. **Instinct retrieval** -- proactively queries learned patterns relevant to the task (semantic + keyword matching)
5. **Identity context** -- injects persistent agent identity (UUID, boot count, uptime, crash recovery state)
6. **PLAN phase** -- LLM creates a numbered plan, informed by learned insights and past failures
7. **ACT phase** -- LLM executes tool calls following the plan
8. **OBSERVE** -- results are recorded; error recovery analyzes failures; failure classifier categorizes errors
9. **REFLECT** -- every 3 steps (or on error), LLM decides: **CONTINUE**, **REPLAN**, or **DONE**
10. **Auto-replan** -- if 3+ consecutive same-type failures occur, forces a new approach avoiding failed strategies
11. **Repeat** up to 50 iterations until complete
12. **Learning** -- tool results flow through TypedEventBus to the learning pipeline for immediate pattern storage
13. **Response sent** to the user through the channel (streaming if supported)

---

## Memory System

The active memory backend is `AgentDBMemory` -- SQLite with HNSW vector indexing and a three-tier auto-tiering architecture.

**Three-tier memory:**
- **Working memory** -- active session context, auto-promoted after sustained use
- **Ephemeral memory** -- short-term storage, auto-evicted when capacity thresholds are reached
- **Persistent memory** -- long-term storage, promoted from ephemeral based on access frequency and importance

**How it works:**
- When session history exceeds 40 messages, old messages are summarized and stored as conversation entries
- Hybrid retrieval combines 70% semantic similarity (HNSW vectors) with 30% TF-IDF keyword matching
- The `strata_analyze_project` tool caches project structure analysis for instant context injection
- Memory persists across restarts in the `MEMORY_DB_PATH` directory (default: `.strata-memory/`)
- Automatic migration from the legacy FileMemoryManager runs on first startup

**Fallback:** If AgentDB initialization fails, the system automatically falls back to `FileMemoryManager` (JSON + TF-IDF).

---

## Learning System

The learning system observes agent behavior and learns from errors through an event-driven pipeline.

**Event-driven pipeline:**
- Tool results flow through `TypedEventBus` to a serial `LearningQueue` for immediate processing
- No timer-based batching -- patterns are detected and stored as they occur
- The `LearningQueue` uses bounded FIFO with error isolation (learning failures never crash the agent)

**Bayesian confidence scoring:**
- Instincts use **Beta posterior inference** (`confidence = alpha / (alpha + beta)`) with a `Beta(1,1)` uninformative prior
- Verdict scores (0.0-1.0) act as fractional evidence weights for nuanced updates
- No blending or temporal discounting -- pure Bayesian posterior mean

**Instinct lifecycle:**
- **Proposed** (new) -- below 0.7 confidence
- **Active** -- between 0.7 and 0.9 confidence
- **Evolved** -- above 0.9, proposed for promotion to permanent
- **Deprecated** -- below 0.3, marked for removal
- **Cooling period** -- 7-day window with minimum observation requirements before status changes
- **Permanent** -- frozen, no further confidence updates

**Active retrieval:** Instincts are proactively queried at the start of each task using the `InstinctRetriever`. It searches by keyword similarity and HNSW vector embeddings to find relevant learned patterns, which are injected into the PLAN phase prompt.

**Cross-session learning:** Instincts carry provenance metadata (source session, session count) for cross-session knowledge transfer.

---

## Goal Decomposition

Complex multi-step requests are automatically decomposed into a directed acyclic graph (DAG) of sub-goals.

**GoalDecomposer:**
- Heuristic pre-check avoids LLM calls for simple tasks (pattern matching for complexity indicators)
- LLM generates DAG structures with dependency edges and optional recursive depth (up to 3 levels)
- Kahn's algorithm validates cycle-free DAG structure
- Reactive re-decomposition: when a node fails, it can be broken into smaller recovery steps

**GoalExecutor:**
- Wave-based parallel execution respects dependency ordering
- Semaphore-based concurrency limiting (`GOAL_MAX_PARALLEL`)
- Failure budgets (`GOAL_MAX_FAILURES`) with user-facing continuation prompts
- LLM criticality evaluation determines whether a failed node should block dependents
- Per-node retry logic (`GOAL_MAX_RETRIES`) with recovery decomposition on exhaustion
- AbortSignal support for cancellation
- Persistent goal tree state via `GoalStorage` (SQLite) for resume after restart

---

## Tool Chain Synthesis

The agent automatically detects and synthesizes multi-tool chain patterns into reusable composite tools. V2 adds DAG-based parallel execution and saga rollback for complex chains.

**Pipeline:**
1. **ChainDetector** -- analyzes trajectory data to find recurring tool sequences (e.g., `file_read` -> `file_edit` -> `dotnet_build`)
2. **ChainSynthesizer** -- uses LLM to generate a `CompositeTool` with proper input/output mapping and description
3. **ChainValidator** -- post-synthesis validation with runtime feedback; tracks chain execution success via Bayesian confidence
4. **ChainManager** -- lifecycle orchestrator: loads existing chains on startup, runs periodic detection, auto-invalidates chains when component tools are removed

**V2 enhancements:**
- **DAG execution** -- chains with independent steps run in parallel using dependency-aware scheduling
- **Saga rollback** -- when a chain step fails, previously completed steps are undone in reverse order using registered compensating actions
- **Chain versioning** -- chains track version history; old versions are archived, not deleted

**Security:** Composite tools inherit the most restrictive security flags from their component tools.

**Confidence cascade:** Chain instincts follow the same Bayesian lifecycle as regular instincts. Chains that drop below the deprecation threshold are automatically unregistered.

---

## Multi-Agent Orchestration

Multiple agent instances can run concurrently with per-channel session isolation.

**AgentManager:**
- Creates and manages agent instances per channel/session
- Session isolation ensures agents on different channels do not interfere with each other
- Configurable via `MULTI_AGENT_ENABLED` (opt-in, disabled by default -- identical to single-agent behavior when off)

**AgentBudgetTracker:**
- Per-agent token and cost tracking with configurable budget limits
- Shared daily/monthly budget caps across all agents
- Budget exhaustion triggers graceful degradation (read-only mode) rather than hard failure

**AgentRegistry:**
- Central registry of all active agent instances
- Supports health checks and graceful shutdown
- Multi-agent is fully opt-in: when disabled, the system operates identically to v2.0

---

## Task Delegation

Agents can delegate sub-tasks to other agents using a tiered routing system.

**TierRouter (4-tier):**
- **Tier 1** -- simple tasks handled by the current agent (no delegation)
- **Tier 2** -- moderate complexity, delegated to a secondary agent
- **Tier 3** -- high complexity, delegated with extended budget
- **Tier 4** -- critical tasks requiring specialized agent capabilities

**DelegationManager:**
- Manages the delegation lifecycle: create, track, complete, cancel
- Enforces maximum delegation depth (default: 2) to prevent infinite delegation loops
- Budget-aware: delegated tasks inherit a portion of the parent's remaining budget

**DelegationTool:**
- Exposed as a tool the agent can invoke to delegate work
- Includes result aggregation from delegated sub-tasks

---

## Memory Decay & Consolidation

Memory entries naturally decay over time using an exponential decay model, while idle consolidation reduces redundancy.

**Exponential decay:**
- Each memory entry has a decay score that decreases over time
- Access frequency and importance boost decay resistance
- Instincts are exempt from decay (never expire)

**Idle consolidation:**
- During low-activity periods, the consolidation engine identifies semantically similar memories using HNSW clustering
- Related memories are merged into consolidated summaries, reducing storage and improving retrieval quality
- Soft-delete with undo: consolidated source memories are marked as consolidated (not physically deleted) and can be restored

**Consolidation engine:**
- Configurable similarity threshold for cluster detection
- Batch processing with configurable chunk sizes
- Full audit trail of consolidation operations

---

## Deployment Subsystem

An opt-in deployment system with human-in-the-loop approval gates and circuit breaker protection.

**ReadinessChecker:**
- Validates system readiness before deployment (build status, test results, resource availability)
- Configurable readiness criteria

**DeployTrigger:**
- Integrates with the daemon's trigger system as a new trigger type
- Fires when deployment conditions are met (e.g., all tests pass, approval granted)
- Includes an approval queue: deployments require explicit human approval before execution

**DeploymentExecutor:**
- Executes deployment steps in sequence with rollback capability
- Environment variable sanitization prevents credential leakage in deployment logs
- Circuit breaker: consecutive deployment failures trigger automatic cooldown to prevent cascading failures

**Security:** Deployment is disabled by default and requires explicit opt-in via configuration. All deployment actions are logged and auditable.

---

## Daemon Mode

The daemon provides 24/7 autonomous operation with a heartbeat-driven trigger system.

```bash
npm run dev -- daemon --channel web
```

**HeartbeatLoop:**
- Configurable tick interval evaluates registered triggers each cycle
- Sequential trigger evaluation prevents budget race conditions
- Persists running state for crash recovery

**Trigger types:**
- **Cron** -- scheduled tasks using cron expressions
- **File watch** -- monitors file system changes in configured paths
- **Checklist** -- fires when checklist items become due
- **Webhook** -- HTTP POST endpoint triggers tasks on incoming requests
- **Deploy** -- fires when deployment conditions are met (requires approval gate)

**Resilience:**
- **Circuit breakers** -- per-trigger with exponential backoff cooldown, persisted across restarts
- **Budget tracking** -- daily USD spend cap with warning threshold events
- **Trigger deduplication** -- content-based and cooldown-based suppression prevents duplicate fires
- **Overlap suppression** -- skips triggers that already have an active task running

**Security:**
- `DaemonSecurityPolicy` controls which tools require user approval when invoked by daemon triggers
- `ApprovalQueue` with configurable expiration for write operations

**Reporting:**
- `NotificationRouter` routes events to configured channels based on urgency level (silent/low/medium/high/critical)
- Per-urgency rate limiting and quiet hours support (non-critical notifications buffered)
- `DigestReporter` generates periodic summary reports
- All notifications logged to SQLite history

---

## Identity System

The agent maintains a persistent identity across sessions and restarts.

**IdentityStateManager** (SQLite-backed):
- Unique agent UUID generated on first boot
- Boot count, cumulative uptime, last activity timestamps
- Total message and task counters
- Clean shutdown detection for crash recovery
- In-memory counter cache with periodic flush to minimize SQLite writes

**Crash recovery:**
- On startup, if previous session did not shut down cleanly, builds a `CrashRecoveryContext`
- Includes downtime duration, interrupted goal trees, and boot count
- Injected into system prompt so the LLM naturally acknowledges the crash and can resume interrupted work

---

## Configuration Reference

All configuration is via environment variables. See `.env.example` for the full list.

### Required

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key (primary LLM provider) |
| `UNITY_PROJECT_PATH` | Absolute path to your Unity project root (must contain `Assets/`) |
| `JWT_SECRET` | Secret for JWT signing. Generate: `openssl rand -hex 64` |

### AI Providers

Any OpenAI-compatible provider works. All providers below are already implemented and need only an API key to activate.

| Variable | Provider | Default Model |
|----------|----------|---------------|
| `ANTHROPIC_API_KEY` | Claude (primary) | `claude-sonnet-4-20250514` |
| `OPENAI_API_KEY` | OpenAI | `gpt-4o` |
| `DEEPSEEK_API_KEY` | DeepSeek | `deepseek-chat` |
| `GROQ_API_KEY` | Groq | `llama-3.3-70b-versatile` |
| `QWEN_API_KEY` | Alibaba Qwen | `qwen-plus` |
| `KIMI_API_KEY` | Moonshot Kimi | `moonshot-v1-8k` |
| `MINIMAX_API_KEY` | MiniMax | `abab6.5s-chat` |
| `MISTRAL_API_KEY` | Mistral AI | `mistral-large-latest` |
| `TOGETHER_API_KEY` | Together AI | `meta-llama/Llama-3-70b-chat-hf` |
| `FIREWORKS_API_KEY` | Fireworks AI | `accounts/fireworks/models/llama-v3p1-70b-instruct` |
| `GEMINI_API_KEY` | Google Gemini | `gemini-pro` |
| `OLLAMA_BASE_URL` | Ollama (local) | `llama3` |
| `PROVIDER_CHAIN` | Fallback order | e.g. `claude,kimi,deepseek,ollama` |

**Provider chain:** Set `PROVIDER_CHAIN` to a comma-separated list of provider names. The system tries each in order, falling back on failure. Example: `PROVIDER_CHAIN=kimi,deepseek,claude` uses Kimi first, DeepSeek if Kimi fails, then Claude.

### Chat Channels

**Web:**
| Variable | Description |
|----------|-------------|
| `WEB_CHANNEL_PORT` | Port for web dashboard (default: `3000`) |

**Telegram:**
| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `ALLOWED_TELEGRAM_USER_IDS` | Comma-separated Telegram user IDs (required, deny-all if empty) |

**Discord:**
| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_CLIENT_ID` | Discord application client ID |
| `ALLOWED_DISCORD_USER_IDS` | Comma-separated user IDs (deny-all if empty) |
| `ALLOWED_DISCORD_ROLE_IDS` | Comma-separated role IDs for role-based access |

**Slack:**
| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | `xoxb-...` Bot token |
| `SLACK_APP_TOKEN` | `xapp-...` App-level token (for socket mode) |
| `SLACK_SIGNING_SECRET` | Signing secret from Slack app |
| `ALLOWED_SLACK_USER_IDS` | Comma-separated user IDs (**open to all if empty**) |
| `ALLOWED_SLACK_WORKSPACES` | Comma-separated workspace IDs (**open to all if empty**) |

**WhatsApp:**
| Variable | Description |
|----------|-------------|
| `WHATSAPP_SESSION_PATH` | Directory for session files (default: `.whatsapp-session`) |
| `WHATSAPP_ALLOWED_NUMBERS` | Comma-separated phone numbers |

### Features

| Variable | Default | Description |
|----------|---------|-------------|
| `RAG_ENABLED` | `true` | Enable semantic code search over your C# project |
| `EMBEDDING_PROVIDER` | `openai` | Embedding provider: `openai` or `ollama` |
| `MEMORY_ENABLED` | `true` | Enable persistent conversation memory |
| `MEMORY_DB_PATH` | `.strata-memory` | Directory for memory database files |
| `WEB_CHANNEL_PORT` | `3000` | Web dashboard port |
| `DASHBOARD_ENABLED` | `false` | Enable HTTP monitoring dashboard |
| `DASHBOARD_PORT` | `3001` | Dashboard server port |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | Enable WebSocket real-time dashboard |
| `ENABLE_PROMETHEUS` | `false` | Enable Prometheus metrics endpoint (port 9090) |
| `MULTI_AGENT_ENABLED` | `false` | Enable multi-agent orchestration |
| `DELEGATION_ENABLED` | `false` | Enable task delegation between agents |
| `DELEGATION_MAX_DEPTH` | `2` | Maximum delegation chain depth |
| `DEPLOYMENT_ENABLED` | `false` | Enable deployment subsystem |
| `READ_ONLY_MODE` | `false` | Block all write operations |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_ENABLED` | `false` | Enable rate limiting |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | `0` | Per-user message limit (0 = unlimited) |
| `RATE_LIMIT_MESSAGES_PER_HOUR` | `0` | Per-user hourly limit |
| `RATE_LIMIT_TOKENS_PER_DAY` | `0` | Global daily token quota |
| `RATE_LIMIT_DAILY_BUDGET_USD` | `0` | Daily spend cap in USD |
| `RATE_LIMIT_MONTHLY_BUDGET_USD` | `0` | Monthly spend cap in USD |

### Security

| Variable | Default | Description |
|----------|---------|-------------|
| `REQUIRE_MFA` | `false` | Require multi-factor authentication |
| `BROWSER_HEADLESS` | `true` | Run browser automation headless |
| `BROWSER_MAX_CONCURRENT` | `5` | Maximum concurrent browser sessions |

---

## Tools

The agent has 30+ built-in tools organized by category:

### File Operations
| Tool | Description |
|------|-------------|
| `file_read` | Read files with line numbers, offset/limit pagination (512KB limit) |
| `file_write` | Create or overwrite files (256KB limit, auto-creates directories) |
| `file_edit` | Search-and-replace editing with uniqueness enforcement |
| `file_delete` | Delete a single file |
| `file_rename` | Rename or move files within the project |
| `file_delete_directory` | Recursive directory deletion (50-file safety cap) |

### Search
| Tool | Description |
|------|-------------|
| `glob_search` | Find files by glob pattern (max 50 results) |
| `grep_search` | Regex content search across files (max 20 matches) |
| `list_directory` | Directory listing with file sizes |
| `code_search` | Semantic/vector search via RAG -- natural language queries |
| `memory_search` | Search persistent conversation memory |

### Strada Code Generation
| Tool | Description |
|------|-------------|
| `strata_analyze_project` | Full C# project scan -- modules, systems, components, services |
| `strata_create_module` | Generate complete module scaffold (`.asmdef`, config, directories) |
| `strata_create_component` | Generate ECS component structs with field definitions |
| `strata_create_mediator` | Generate `EntityMediator<TView>` with component bindings |
| `strata_create_system` | Generate `SystemBase`/`JobSystemBase`/`SystemGroup` |

### Git
| Tool | Description |
|------|-------------|
| `git_status` | Working tree status |
| `git_diff` | Show changes |
| `git_log` | Commit history |
| `git_commit` | Stage and commit |
| `git_push` | Push to remote |
| `git_branch` | List, create, or checkout branches |
| `git_stash` | Push, pop, list, or drop stash |

### .NET / Unity
| Tool | Description |
|------|-------------|
| `dotnet_build` | Run `dotnet build`, parse MSBuild errors into structured output |
| `dotnet_test` | Run `dotnet test`, parse pass/fail/skip results |

### Other
| Tool | Description |
|------|-------------|
| `shell_exec` | Execute shell commands (30s timeout, dangerous command blocklist) |
| `code_quality` | Per-file or per-project code quality analysis |
| `rag_index` | Trigger incremental or full project re-indexing |

---

## RAG Pipeline

The RAG (Retrieval-Augmented Generation) pipeline indexes your C# source code for semantic search.

**Indexing flow:**
1. Scans `**/*.cs` files in your Unity project
2. Chunks code structurally -- file headers, classes, methods, constructors
3. Generates embeddings via OpenAI (`text-embedding-3-small`) or Ollama (`nomic-embed-text`)
4. Stores vectors in HNSW index for fast approximate nearest-neighbor search
5. Runs automatically on startup (background, non-blocking)

**Search flow:**
1. Query is embedded using the same provider
2. HNSW search returns `topK * 3` candidates
3. Reranker scores: vector similarity (60%) + keyword overlap (25%) + structural bonus (15%)
4. Top 6 results (above score 0.2) are injected into the LLM context

**Note:** The RAG pipeline currently only supports C# files. The chunker is C#-specific.

---

## Channel Capabilities

| Capability | Web | Telegram | Discord | Slack | WhatsApp | CLI |
|------------|-----|----------|---------|-------|----------|-----|
| Text messaging | Yes | Yes | Yes | Yes | Yes | Yes |
| Streaming (edit-in-place) | Yes | Yes | Yes | Yes | Yes | Yes |
| Typing indicator | Yes | Yes | Yes | No-op | Yes | No |
| Confirmation dialogs | Yes (modal) | Yes (inline keyboard) | Yes (buttons) | Yes (Block Kit) | Yes (numbered reply) | Yes (readline) |
| File uploads | Yes | No | No | Yes | Yes | No |
| Thread support | No | No | Yes | Yes | No | No |
| Rate limiter (outbound) | Yes (per-session) | No | Yes (token bucket) | Yes (4-tier sliding window) | Inline throttle | No |

### Streaming

All channels implement edit-in-place streaming. The agent's response appears progressively as the LLM generates it. Updates are throttled per platform to avoid rate limits (WhatsApp/Discord: 1/sec, Slack: 2/sec).

### Authentication

- **Telegram**: Deny-all by default. Must set `ALLOWED_TELEGRAM_USER_IDS`.
- **Discord**: Deny-all by default. Must set `ALLOWED_DISCORD_USER_IDS` or `ALLOWED_DISCORD_ROLE_IDS`.
- **Slack**: **Open by default.** If `ALLOWED_SLACK_USER_IDS` is empty, any Slack user can access the bot. Set the allowlist for production.
- **WhatsApp**: Uses `WHATSAPP_ALLOWED_NUMBERS` allowlist checked locally in the adapter.

---

## Security

### Layer 1: Channel Authentication
Platform-specific allowlists checked at message arrival (before any processing).

### Layer 2: Rate Limiting
Per-user sliding window (minute/hour) + global daily/monthly token and USD budget caps.

### Layer 3: Path Guard
Every file operation resolves symlinks and validates the path stays within the project root. 30+ sensitive patterns are blocked (`.env`, `.git/credentials`, SSH keys, certificates, `node_modules/`).

### Layer 4: Secret Sanitizer
24 regex patterns detect and mask credentials in all tool outputs before they reach the LLM. Covers: OpenAI keys, GitHub tokens, Slack/Discord/Telegram tokens, AWS keys, JWTs, Bearer auth, PEM keys, database URLs, and generic secret patterns.

### Layer 5: Read-Only Mode
When `READ_ONLY_MODE=true`, 23 write tools are removed from the agent's tool list entirely -- the LLM cannot even attempt to call them.

### Layer 6: Operation Confirmation
Write operations (file writes, git commits, shell execution) can require user confirmation via the channel's interactive UI (buttons, inline keyboards, text prompts).

### Layer 7: Tool Output Sanitization
All tool results are capped at 8192 characters and scrubbed for API key patterns before feeding back to the LLM.

### Layer 8: RBAC (Internal)
5 roles (superadmin, admin, developer, viewer, service) with a permission matrix covering 9 resource types. Policy engine supports time-based, IP-based, and custom conditions.

### Layer 9: Daemon Security
`DaemonSecurityPolicy` enforces tool-level approval requirements for daemon-triggered operations. Write tools require explicit user approval via the `ApprovalQueue` before execution.

---

## Dashboard and Monitoring

### HTTP Dashboard (`DASHBOARD_ENABLED=true`)
Accessible at `http://localhost:3001` (localhost only). Shows: uptime, message count, token usage, active sessions, tool usage table, security stats. Auto-refreshes every 3 seconds.

### Health Endpoints
- `GET /health` -- Liveness probe (`{"status":"ok"}`)
- `GET /ready` -- Deep readiness: checks memory and channel health. Returns 200 (ready), 207 (degraded), or 503 (not ready)

### Prometheus (`ENABLE_PROMETHEUS=true`)
Metrics at `http://localhost:9090/metrics`. Counters for messages, tool calls, tokens. Histograms for request duration, tool duration, LLM latency. Default Node.js metrics (CPU, heap, GC, event loop).

### WebSocket Dashboard (`ENABLE_WEBSOCKET_DASHBOARD=true`)
Real-time metrics pushed every second. Supports authenticated connections and remote commands (plugin reload, cache clear, log retrieval). Daemon events (trigger fires, budget warnings, goal progress) are broadcast over WebSocket.

### Metrics System
`MetricsStorage` (SQLite) records task completion rate, iteration counts, tool usage, and pattern reuse. `MetricsRecorder` captures metrics per-session. `metrics` CLI command displays historical metrics.

---

## Deployment

### Docker

```bash
docker-compose up -d
```

The `docker-compose.yml` includes the application, monitoring stack, and nginx reverse proxy.

### Daemon Mode

```bash
# 24/7 autonomous operation with heartbeat loop and proactive triggers
node dist/index.js daemon --channel web

# Auto-restarts on crash with exponential backoff (1s to 60s, up to 10 restarts)
node dist/index.js daemon --channel telegram
```

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Set `LOG_LEVEL=warn` or `error`
- [ ] Configure `RATE_LIMIT_ENABLED=true` with budget caps
- [ ] Set channel allowlists (especially Slack -- open by default)
- [ ] Set `READ_ONLY_MODE=true` if you want safe exploration only
- [ ] Enable `DASHBOARD_ENABLED=true` for monitoring
- [ ] Enable `ENABLE_PROMETHEUS=true` for metric collection
- [ ] Generate a strong `JWT_SECRET`
- [ ] Configure daemon budget limits (`RATE_LIMIT_DAILY_BUDGET_USD`)

---

## Testing

```bash
npm test                         # Run all 3100+ tests
npm run test:watch               # Watch mode
npm test -- --coverage           # With coverage
npm test -- src/agents/tools/file-read.test.ts  # Single file
npm run typecheck                # TypeScript type checking
npm run lint                     # ESLint
```

---

## Project Structure

```
src/
  index.ts              # CLI entry point (Commander.js)
  core/
    bootstrap.ts        # Full initialization sequence -- all wiring happens here
    event-bus.ts        # TypedEventBus for decoupled event-driven communication
    tool-registry.ts    # Tool instantiation and registration
  agents/
    orchestrator.ts     # PAOR agent loop, session management, streaming
    agent-state.ts      # Phase state machine (Plan/Act/Observe/Reflect)
    paor-prompts.ts     # Phase-aware prompt builders
    instinct-retriever.ts # Proactive learned-pattern retrieval
    failure-classifier.ts # Error categorization and auto-replan triggers
    autonomy/           # Error recovery, task planning, self-verification
    context/            # System prompt (Strada.Core knowledge base)
    providers/          # Claude, OpenAI, Ollama, DeepSeek, Kimi, Qwen, MiniMax, Groq, + more
    tools/              # 30+ tool implementations
    plugins/            # External plugin loader
  channels/
    telegram/           # Grammy-based bot
    discord/            # discord.js bot with slash commands
    slack/              # Slack Bolt (socket mode) with Block Kit
    whatsapp/           # Baileys-based client with session management
    web/                # Express + WebSocket web dashboard
    cli/                # Readline REPL
  memory/
    file-memory-manager.ts   # Legacy backend: JSON + TF-IDF (fallback)
    unified/
      agentdb-memory.ts      # Active backend: SQLite + HNSW, 3-tier auto-tiering
      agentdb-adapter.ts     # IMemoryManager adapter for AgentDBMemory
      migration.ts           # Legacy FileMemoryManager -> AgentDB migration
      consolidation-engine.ts # Idle memory consolidation with HNSW clustering
      consolidation-types.ts  # Consolidation type definitions and interfaces
    decay/                    # Exponential memory decay system
  rag/
    rag-pipeline.ts     # Index + search + format orchestration
    chunker.ts          # C#-specific structural chunking
    hnsw/               # HNSW vector store (hnswlib-node)
    embeddings/         # OpenAI and Ollama embedding providers
    reranker.ts         # Weighted reranking (vector + keyword + structural)
  learning/
    pipeline/
      learning-pipeline.ts  # Pattern detection, instinct creation, evolution proposals
      learning-queue.ts     # Serial async processor for event-driven learning
      embedding-queue.ts    # Bounded async embedding generation
    scoring/
      confidence-scorer.ts  # Bayesian Beta posterior confidence, Elo, Wilson intervals
    matching/
      pattern-matcher.ts    # Keyword + semantic pattern matching
    hooks/
      error-learning-hooks.ts  # Error/resolution capture hooks
    storage/
      learning-storage.ts  # SQLite storage for instincts, trajectories, patterns
      migrations/          # Schema migrations (cross-session provenance)
    chains/
      chain-detector.ts    # Recurring tool sequence detection
      chain-synthesizer.ts # LLM-based composite tool generation
      composite-tool.ts    # Executable composite tool
      chain-validator.ts   # Post-synthesis validation, runtime feedback
      chain-manager.ts     # Full lifecycle orchestrator
  multi-agent/
    agent-manager.ts    # Multi-agent lifecycle and session isolation
    agent-budget-tracker.ts  # Per-agent budget tracking
    agent-registry.ts   # Central registry of active agents
  delegation/
    delegation-manager.ts    # Delegation lifecycle management
    delegation-tool.ts       # Agent-facing delegation tool
    tier-router.ts           # 4-tier task routing
  goals/
    goal-decomposer.ts  # DAG-based goal decomposition (proactive + reactive)
    goal-executor.ts    # Wave-based parallel execution with failure budgets
    goal-validator.ts   # Kahn's algorithm DAG cycle detection
    goal-storage.ts     # SQLite persistence for goal trees
    goal-progress.ts    # Progress tracking and reporting
    goal-resume.ts      # Resume interrupted goal trees after restart
    goal-renderer.ts    # Goal tree visualization
  daemon/
    heartbeat-loop.ts   # Core tick-evaluate-fire loop
    trigger-registry.ts # Trigger registration and lifecycle
    daemon-storage.ts   # SQLite persistence for daemon state
    daemon-events.ts    # Typed event definitions for daemon subsystem
    daemon-cli.ts       # CLI commands for daemon management
    budget/
      budget-tracker.ts # Daily USD budget tracking
    resilience/
      circuit-breaker.ts # Per-trigger circuit breaker with exponential backoff
    security/
      daemon-security-policy.ts  # Tool approval requirements for daemon
      approval-queue.ts          # Approval request queue with expiration
    dedup/
      trigger-deduplicator.ts    # Content + cooldown deduplication
    triggers/
      cron-trigger.ts        # Cron expression scheduling
      file-watch-trigger.ts  # File system change monitoring
      checklist-trigger.ts   # Due-date checklist items
      webhook-trigger.ts     # HTTP POST webhook endpoint
      deploy-trigger.ts      # Deployment condition trigger with approval gate
    deployment/
      deployment-executor.ts # Deployment execution with rollback
      readiness-checker.ts   # Pre-deployment readiness validation
    reporting/
      notification-router.ts # Urgency-based notification routing
      digest-reporter.ts     # Periodic summary digest generation
      digest-formatter.ts    # Format digest reports for channels
      quiet-hours.ts         # Non-critical notification buffering
  identity/
    identity-state.ts   # Persistent agent identity (UUID, boot count, uptime)
    crash-recovery.ts   # Crash detection and recovery context
  tasks/
    task-manager.ts     # Task lifecycle management
    task-storage.ts     # SQLite task persistence
    background-executor.ts # Background task execution with goal integration
    message-router.ts   # Message routing to orchestrator
    command-detector.ts # Slash command detection
    command-handler.ts  # Command execution
  metrics/
    metrics-storage.ts  # SQLite metrics storage
    metrics-recorder.ts # Per-session metric capture
    metrics-cli.ts      # CLI metrics display command
  security/             # Auth, RBAC, path guard, rate limiter, secret sanitizer
  intelligence/         # C# parsing, project analysis, code quality
  dashboard/            # HTTP, WebSocket, Prometheus dashboards
  config/               # Zod-validated environment configuration
  validation/           # Input validation schemas
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code conventions, and PR guidelines.

---

## License

MIT License - see [LICENSE](LICENSE) for details.
