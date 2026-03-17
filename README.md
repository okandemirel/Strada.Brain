<p align="center">
  <img src="icon/strada-brain-icon.png" alt="Strada.Brain Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>AI-Powered Development Agent for Unity / Strada.Core Projects</strong><br/>
  An autonomous coding agent that connects to a web dashboard, Telegram, Discord, Slack, WhatsApp, or your terminal &mdash; reads your codebase, writes code, runs builds, learns from its mistakes, and operates autonomously with a 24/7 daemon loop. Now with multi-agent orchestration, task delegation, memory consolidation, a deployment subsystem with approval gates, media sharing with LLM vision support, a configurable personality system via SOUL.md, and interactive clarification tools, intelligent multi-provider routing with task-aware dynamic switching, confidence-based consensus verification, an autonomous Agent Core with OODA reasoning loop, and Strada.MCP integration.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/tests-3450%2B-brightgreen?style=flat-square" alt="Tests">
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

It has persistent memory backed by SQLite + HNSW vectors, learns from past errors using hybrid weighted confidence scoring, decomposes complex goals into parallel DAG execution, automatically synthesizes multi-tool chains with saga rollback, and can run as a 24/7 daemon with proactive triggers. It supports multi-agent orchestration with per-channel session isolation, hierarchical task delegation across agent tiers, automatic memory consolidation, and a deployment subsystem with human-in-the-loop approval gates and circuit breaker protection.

New in this release: Strada.Brain now features an **Agent Core** -- an autonomous OODA reasoning engine that observes the environment (file changes, git state, build results), reasons about priorities using learned patterns, and takes action proactively. The **multi-provider routing** system dynamically selects the best AI provider for each task type (planning, code generation, debugging, review) with configurable presets (budget/balanced/performance). A **confidence-based consensus** system automatically consults a second provider when the agent's confidence is low, preventing errors on critical operations. All features gracefully degrade -- with a single provider, the system works identically to before with zero overhead.

**This is not a library or an API.** It is a standalone application you run. It connects to your chat platform, reads your Unity project on disk, and operates autonomously within the boundaries you configure.

---

## Quick Start

### Prerequisites

- **Node.js 20+** and npm
- An **Anthropic API key** (Claude) -- other providers are optional
- A **Unity project** with Strada.Core framework (the path you give the agent)

### 1. Install

```bash
# Global install (recommended)
npm install -g strada-brain

# Or clone from source
git clone https://github.com/okandemirel/strada-brain.git
cd strada-brain
npm install
npm install --prefix web-portal
```

### 2. Setup

```bash
# Interactive setup wizard (terminal or web browser)
strada setup
```

The wizard asks for your Unity project path, AI provider API key, default channel, and language. Choose **Terminal** for quick setup or **Web Browser** for the full configuration UI.

Alternatively, create `.env` manually:

```env
ANTHROPIC_API_KEY=sk-ant-...      # Your Claude API key
UNITY_PROJECT_PATH=/path/to/your/UnityProject  # Must contain Assets/
JWT_SECRET=<generate with: openssl rand -hex 64>
```

### 3. Run

```bash
# Start with default web channel
strada start

# Interactive CLI mode (fastest way to test)
strada start --channel cli

# Daemon mode (24/7 autonomous operation with proactive triggers)
strada start --channel web --daemon

# Other chat channels
strada start --channel telegram
strada start --channel discord
strada start --channel slack
strada start --channel whatsapp

# Always-on supervisor with auto-restart
strada supervise --channel web
```

### 4. CLI Commands

```bash
strada setup              # Interactive setup wizard
strada start              # Start the agent
strada supervise          # Run with auto-restart supervisor
strada update             # Check and apply updates
strada update --check     # Check for updates without applying
strada version-info       # Show version, install method, update status
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

### 5. Auto-Update

Strada.Brain automatically checks for updates daily and applies them when idle. It detects its installation method (npm global, npm local, or git clone) and uses the appropriate update strategy.

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_UPDATE_ENABLED` | `true` | Enable/disable auto-update |
| `AUTO_UPDATE_INTERVAL_HOURS` | `24` | Check frequency (hours) |
| `AUTO_UPDATE_IDLE_TIMEOUT_MIN` | `5` | Minutes idle before applying update |
| `AUTO_UPDATE_CHANNEL` | `stable` | npm dist-tag: `stable` or `latest` |
| `AUTO_UPDATE_AUTO_RESTART` | `true` | Auto-restart after update when idle |

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
| OpenAI, Kimi | | Git ops    | | (SQLite +  | | Hybrid weighted  |
| DeepSeek,Qwen| | Shell exec | |  HNSW)     | | Instinct life-   |
| MiniMax, Groq| | .NET build | | RAG vectors| |  cycle           |
| Ollama +more | | Strada gen | | Identity   | | Tool chains      |
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

1. **Message arrives** from a chat channel (text, images, video, audio, or documents)
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
- The `strada_analyze_project` tool caches project structure analysis for instant context injection
- Memory persists across restarts in the `MEMORY_DB_PATH` directory (default: `.strada-memory/`)
- Automatic migration from the legacy FileMemoryManager runs on first startup

**Fallback:** If AgentDB initialization fails, the system automatically falls back to `FileMemoryManager` (JSON + TF-IDF).

---

## Learning System

The learning system observes agent behavior and learns from errors through an event-driven pipeline.

**Event-driven pipeline:**
- Tool results flow through `TypedEventBus` to a serial `LearningQueue` for immediate processing
- No timer-based batching -- patterns are detected and stored as they occur
- The `LearningQueue` uses bounded FIFO with error isolation (learning failures never crash the agent)

**Hybrid weighted confidence scoring:**
- Confidence = weighted sum across 5 factors: successRate (0.35), pattern strength (0.25), recency (0.20), context match (0.15), verification (0.05)
- Verdict scores (0.0-1.0) update alpha/beta evidence counters for confidence intervals
- Alpha/beta parameters are maintained for uncertainty estimation but are not used for primary confidence computation

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
3. **ChainValidator** -- post-synthesis validation with runtime feedback; tracks chain execution success via weighted confidence scoring
4. **ChainManager** -- lifecycle orchestrator: loads existing chains on startup, runs periodic detection, auto-invalidates chains when component tools are removed

**V2 enhancements:**
- **DAG execution** -- chains with independent steps run in parallel using dependency-aware scheduling
- **Saga rollback** -- when a chain step fails, previously completed steps are undone in reverse order using registered compensating actions
- **Chain versioning** -- chains track version history; old versions are archived, not deleted

**Security:** Composite tools inherit the most restrictive security flags from their component tools.

**Confidence cascade:** Chain instincts follow the same confidence lifecycle as regular instincts. Chains that drop below the deprecation threshold are automatically unregistered.

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

### Agent Core (Autonomous OODA Loop)

When daemon mode is active, the Agent Core runs a continuous observe-orient-decide-act loop:

- **Observe**: Collects environment state from 6 observers (file changes, git status, build results, trigger events, user activity, test results)
- **Orient**: Scores observations using learning-informed priority (PriorityScorer with instinct integration)
- **Decide**: LLM reasoning with budget-aware throttling (30s minimum interval, priority threshold, budget floor)
- **Act**: Submits goals, notifies user, or waits (agent can decide "nothing to do")

Safety: tickInFlight guard, rate limiting, budget floor (10%), and DaemonSecurityPolicy enforcement.

### Multi-Provider Intelligent Routing

With 2+ providers configured, Strada.Brain automatically routes tasks to the optimal provider:

| Task Type | Routing Strategy |
|-----------|-----------------|
| Planning | Widest context window (Claude > GPT > Gemini) |
| Code Generation | Strong tool calling (Claude > Kimi > OpenAI) |
| Code Review | Different model than executor (diversity bias) |
| Simple Questions | Fastest/cheapest (Groq > Kimi > Ollama) |
| Debugging | Strong error analysis |

**Presets**: `budget` (cost-optimized), `balanced` (default), `performance` (quality-first)
**PAOR Phase Switching**: Different providers for planning vs execution vs reflection phases.
**Consensus**: Low confidence → automatic second opinion from different provider.

### Strada.MCP Integration

Strada.Brain detects [Strada.MCP](https://github.com/okandemirel/Strada.MCP) (76-tool Unity MCP server) and informs the agent about available MCP capabilities including runtime control, file operations, git, .NET build, code analysis, and scene/prefab management.

---

## Daemon Mode

The daemon provides 24/7 autonomous operation with a heartbeat-driven trigger system. When daemon mode is active, the **Agent Core OODA loop** runs within daemon ticks, observing the environment and proactively taking action between user interactions. The `/autonomous on` command now propagates to the DaemonSecurityPolicy, enabling fully autonomous operation without per-action approval prompts.

```bash
npm run dev -- start --channel web --daemon
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
- **Deploy** -- proposes deployment after a refreshed readiness check confirms the project is ready (requires approval gate)

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

**Matrix:**
| Variable | Description |
|----------|-------------|
| `MATRIX_HOMESERVER` | Matrix homeserver URL |
| `MATRIX_ACCESS_TOKEN` | Bot access token |
| `MATRIX_USER_ID` | Bot user ID |
| `MATRIX_ALLOWED_USER_IDS` | Optional comma-separated Matrix user IDs allowed to talk to the bot |
| `MATRIX_ALLOWED_ROOM_IDS` | Optional comma-separated Matrix room IDs allowed to deliver messages |

**IRC:**
| Variable | Description |
|----------|-------------|
| `IRC_SERVER` | IRC server hostname |
| `IRC_NICK` | Bot nick |
| `IRC_CHANNELS` | Comma-separated channels to join |
| `IRC_ALLOWED_USERS` | Optional comma-separated IRC nicknames allowed to trigger the bot |

**Teams:**
| Variable | Description |
|----------|-------------|
| `TEAMS_APP_ID` | Microsoft Teams app ID |
| `TEAMS_APP_PASSWORD` | Microsoft Teams app password |
| `TEAMS_ALLOWED_USER_IDS` | Optional comma-separated Teams user IDs allowed to message the bot |

### Features

| Variable | Default | Description |
|----------|---------|-------------|
| `RAG_ENABLED` | `true` | Enable semantic code search over your C# project |
| `EMBEDDING_PROVIDER` | `auto` | Embedding provider: `auto`, `openai`, `gemini`, `mistral`, `together`, `fireworks`, `qwen`, `ollama` |
| `EMBEDDING_DIMENSIONS` | (provider default) | Output vector dimensions (Matryoshka: 128-3072 for Gemini/OpenAI) |
| `MEMORY_ENABLED` | `true` | Enable persistent conversation memory |
| `MEMORY_DB_PATH` | `.strada-memory` | Directory for memory database files |
| `WEB_CHANNEL_PORT` | `3000` | Web dashboard port |
| `DASHBOARD_ENABLED` | `false` | Enable HTTP monitoring dashboard |
| `DASHBOARD_PORT` | `3100` | Dashboard server port |
| `ENABLE_WEBSOCKET_DASHBOARD` | `false` | Enable WebSocket real-time dashboard |
| `WEBSOCKET_DASHBOARD_PORT` | `3100` | WebSocket dashboard server port |
| `WEBSOCKET_DASHBOARD_AUTH_TOKEN` | (unset) | Optional bearer token for dashboard API proxy and WebSocket dashboard auth |
| `WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS` | (unset) | Comma-separated extra allowed origins for the WebSocket dashboard |
| `LLM_STREAM_INITIAL_TIMEOUT_MS` | `600000` | Max time to wait for a streaming response to start before treating it as stalled |
| `LLM_STREAM_STALL_TIMEOUT_MS` | `120000` | Max gap between streaming chunks before treating an in-progress response as stalled |
| `ENABLE_PROMETHEUS` | `false` | Enable Prometheus metrics endpoint (port 9090) |
| `MULTI_AGENT_ENABLED` | `false` | Enable multi-agent orchestration |
| `TASK_DELEGATION_ENABLED` | `false` | Enable task delegation between agents |
| `AGENT_MAX_DELEGATION_DEPTH` | `2` | Maximum delegation chain depth |
| `AGENT_MAX_CONCURRENT_DELEGATIONS` | `3` | Maximum concurrent delegations per parent agent |
| `DELEGATION_VERBOSITY` | `normal` | Delegation logging verbosity: `quiet`, `normal`, or `verbose` |
| `DEPLOYMENT_ENABLED` | `false` | Enable deployment subsystem |
| `SOUL_FILE` | `soul.md` | Path to the agent personality file (SOUL.md); hot-reloaded on change |
| `SOUL_FILE_WEB` | (unset) | Per-channel personality override for the web channel |
| `SOUL_FILE_TELEGRAM` | (unset) | Per-channel personality override for Telegram |
| `SOUL_FILE_DISCORD` | (unset) | Per-channel personality override for Discord |
| `SOUL_FILE_SLACK` | (unset) | Per-channel personality override for Slack |
| `SOUL_FILE_WHATSAPP` | (unset) | Per-channel personality override for WhatsApp |
| `READ_ONLY_MODE` | `false` | Block all write operations |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` |

### Routing & Consensus

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTING_PRESET` | `balanced` | Routing preset: `budget`, `balanced`, or `performance` |
| `ROUTING_PHASE_SWITCHING` | `true` | Enable PAOR phase switching across providers |
| `CONSENSUS_MODE` | `auto` | Consensus mode: `auto`, `critical-only`, `always`, or `disabled` |
| `CONSENSUS_THRESHOLD` | `0.5` | Confidence threshold for triggering consensus |
| `CONSENSUS_MAX_PROVIDERS` | `3` | Maximum providers to consult for consensus |
| `STRADA_DAEMON_DAILY_BUDGET` | `1.0` | Daily budget (USD) for daemon mode |

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

The agent has 40+ built-in tools organized by category:

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
| `strada_analyze_project` | Full C# project scan -- modules, systems, components, services |
| `strada_create_module` | Generate complete module scaffold (`.asmdef`, config, directories) |
| `strada_create_component` | Generate ECS component structs with field definitions |
| `strada_create_mediator` | Generate `EntityMediator<TView>` with component bindings |
| `strada_create_system` | Generate `SystemBase`/`JobSystemBase`/`BurstSystem` scaffolds |

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

### Agent Interaction
| Tool | Description |
|------|-------------|
| `ask_user` | Ask the user a clarifying question with multiple-choice options and a recommended answer |
| `show_plan` | Show the execution plan and wait for user approval (Approve/Modify/Reject) |
| `switch_personality` | Switch agent personality at runtime (casual/formal/minimal/default) |

### Other
| Tool | Description |
|------|-------------|
| `shell_exec` | Execute shell commands (30s timeout, dangerous command blocklist) |
| `code_quality` | Per-file or per-project code quality analysis |
| `rag_index` | Trigger incremental or full project re-indexing |

---

## Chat Commands

Slash commands available in all chat channels:

| Command | Description |
|---------|-------------|
| `/daemon` | Show daemon status |
| `/daemon start` | Start daemon heartbeat loop (when the app was started with `--daemon`) |
| `/daemon stop` | Stop daemon heartbeat loop |
| `/daemon triggers` | Show active triggers |
| `/agent` | Show Agent Core status |
| `/routing` | Show routing status and preset |
| `/routing preset <name>` | Switch routing preset (budget/balanced/performance) |
| `/routing info` | Show recent routing decisions |

---

## RAG Pipeline

The RAG (Retrieval-Augmented Generation) pipeline indexes your C# source code for semantic search.

**Indexing flow:**
1. Scans `**/*.cs` files in your Unity project
2. Chunks code structurally -- file headers, classes, methods, constructors
3. Generates embeddings via configured provider -- OpenAI (`text-embedding-3-small`), Gemini (`gemini-embedding-2-preview` with Matryoshka dimensions 128-3072), Mistral, Ollama, or others. Set `EMBEDDING_DIMENSIONS` to control output size.
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
| Media attachments | Yes (base64) | Yes (photo/doc/video/voice) | Yes (any attachment) | Yes (file download) | Yes (image/video/audio/doc) | No |
| Vision (image→LLM) | Yes | Yes | Yes | Yes | Yes | No |
| Streaming (edit-in-place) | Yes | Yes | Yes | Yes | Yes | Yes |
| Typing indicator | Yes | Yes | Yes | No-op | Yes | No |
| Confirmation dialogs | Yes (modal) | Yes (inline keyboard) | Yes (buttons) | Yes (Block Kit) | Yes (numbered reply) | Yes (readline) |
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

### Layer 4: Media Security
All media attachments are validated before processing: MIME allowlist (image/video/audio/document), per-type size limits (20MB image, 50MB video, 25MB audio, 10MB document), magic bytes verification (JPEG, PNG, GIF, WebP, MP4, PDF), and SSRF protection on download URLs (blocks private IPs, metadata endpoints, rejects redirects).

### Layer 5: Secret Sanitizer
24 regex patterns detect and mask credentials in all tool outputs before they reach the LLM. Covers: OpenAI keys, GitHub tokens, Slack/Discord/Telegram tokens, AWS keys, JWTs, Bearer auth, PEM keys, database URLs, and generic secret patterns.

### Layer 6: Read-Only Mode
When `READ_ONLY_MODE=true`, 23 write tools are removed from the agent's tool list entirely -- the LLM cannot even attempt to call them.

### Layer 7: Operation Confirmation
Write operations (file writes, git commits, shell execution) can require user confirmation via the channel's interactive UI (buttons, inline keyboards, text prompts).

### Layer 8: Tool Output Sanitization
All tool results are capped at 8192 characters and scrubbed for API key patterns before feeding back to the LLM.

### Layer 9: RBAC (Internal)
5 roles (superadmin, admin, developer, viewer, service) with a permission matrix covering 9 resource types. Policy engine supports time-based, IP-based, and custom conditions.

### Layer 10: Daemon Security
`DaemonSecurityPolicy` enforces tool-level approval requirements for daemon-triggered operations. Write tools require explicit user approval via the `ApprovalQueue` before execution.

---

## Dashboard and Monitoring

### HTTP Dashboard (`DASHBOARD_ENABLED=true`)
Accessible at `http://localhost:3100` (localhost only by default). Shows: uptime, message count, token usage, active sessions, tool usage table, security stats. Auto-refreshes every 3 seconds.

### Health Endpoints
- `GET /health` -- Liveness probe (`{"status":"ok"}`)
- `GET /ready` -- Deep readiness: checks memory and channel health. Returns 200 (ready), 207 (degraded), or 503 (not ready)

### Prometheus (`ENABLE_PROMETHEUS=true`)
Metrics at `http://localhost:9090/metrics`. Counters for messages, tool calls, tokens. Histograms for request duration, tool duration, LLM latency. Default Node.js metrics (CPU, heap, GC, event loop).

### WebSocket Dashboard (`ENABLE_WEBSOCKET_DASHBOARD=true`)
Real-time metrics are pushed every second. Supports optional token authentication, heartbeat monitoring, and app-registered command handlers or notifications. If `WEBSOCKET_DASHBOARD_AUTH_TOKEN` is set, use the web channel UI or provide a bearer token when accessing protected dashboard APIs.

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
node dist/index.js start --channel web --daemon

# Auto-restarts on crash with exponential backoff (1s to 60s, up to 10 restarts)
node dist/index.js supervise --channel telegram
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
npm test                         # Default full suite (batched for stability)
npm run test:watch               # Watch mode
npm test -- --coverage           # With coverage
npm test -- src/agents/tools/file-read.test.ts  # Single file / targeted passthrough
npm test -- src/dashboard/prometheus.test.ts    # Targeted suite under the default runner
LOCAL_SERVER_TESTS=1 npm test -- src/dashboard/prometheus.test.ts src/dashboard/websocket-server.test.ts
npm run sync:check -- --core-path /path/to/Strada.Core  # Validate Strada.Core API drift
npm run test:file-build-flow     # Opt-in local .NET integration flow
npm run test:unity-fixture       # Opt-in local Unity fixture compile/test flow
npm run test:hnsw-perf           # Opt-in HNSW benchmark / recall suite
npm run test:portal              # Web portal smoke tests
npm run typecheck                # TypeScript type checking
npm run lint                     # ESLint
```

Notes:
- `npm test` uses a batched Vitest runner plus forked workers to avoid the previous full-suite OOM path.
- Bind-dependent dashboard tests are skipped by default unless `LOCAL_SERVER_TESTS=1`.
- `sync:check` validates Strada.Brain's Strada.Core knowledge against a real checkout; CI enforces it with `--max-drift-score 0`.
- `test:file-build-flow`, `test:unity-fixture`, and `test:hnsw-perf` are intentionally opt-in because they depend on local build tooling, a licensed Unity editor, or benchmark-heavy workloads.
- `test:unity-fixture` may still fail if the local Unity batchmode / licensing environment is unhealthy, even when the generated code is correct.

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
    tools/              # 30+ tool implementations (ask_user, show_plan, switch_personality, ...)
    soul/               # SOUL.md personality loader with hot-reload and per-channel overrides
    plugins/            # External plugin loader
  profiles/             # Personality profile files: casual.md, formal.md, minimal.md
  channels/
    telegram/           # Grammy-based bot
    discord/            # discord.js bot with slash commands
    slack/              # Slack Bolt (socket mode) with Block Kit
    whatsapp/           # Baileys-based client with session management
    web/                # Local HTTP + WebSocket web channel
    cli/                # Readline REPL
  web-portal/           # React + Vite chat UI (dark/light theme, file upload, streaming, dashboard tab, side panel)
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
      confidence-scorer.ts  # Hybrid weighted confidence (5-factor), Elo, Wilson intervals
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
  utils/
    media-processor.ts  # Media download, validation (MIME/size/magic bytes), SSRF protection
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
