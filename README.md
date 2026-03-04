<p align="center">
  <img src="docs/assets/logo.svg" alt="Strada.Brain Logo" width="200"/>
</p>

<h1 align="center">Strada.Brain</h1>

<p align="center">
  <strong>AI-Powered Development Agent for Unity / Strada.Core Projects</strong><br/>
  An autonomous coding agent that connects to a web dashboard, Telegram, Discord, Slack, WhatsApp, or your terminal &mdash; reads your codebase, writes code, runs builds, and learns from its mistakes.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-green?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
</p>

<p align="center">
  <strong>English</strong> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.zh.md">中文</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a>
</p>

---

## What Is This?

Strada.Brain is an AI agent you talk to through a chat channel. You describe what you want — "create a new ECS system for player movement" or "find all components that use health" — and the agent reads your C# project, writes the code, runs `dotnet build`, fixes errors automatically, and sends you the result. It has persistent memory, learns from past errors, and can use multiple AI providers with automatic failover.

**This is not a library or an API.** It is a standalone application you run. It connects to your chat platform, reads your Unity project on disk, and operates autonomously within the boundaries you configure.

---

## Quick Start

### Prerequisites

- **Node.js 20+** and npm
- An **Anthropic API key** (Claude) — other providers are optional
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

**Web channel:** No terminal needed — interact through the web dashboard at `localhost:3000`.

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
|  Up to 50 tool iterations per message                            |
|  Instinct retrieval, failure classification, auto-replan         |
+------------------------------+----------------------------------+
                               |
          +--------------------+--------------------+
          |                    |                    |
+---------v------+  +---------v------+  +----------v---------+
| AI Providers   |  | 30+ Tools      |  | Context Sources    |
| Claude (primary|  | File I/O       |  | Memory (TF-IDF)    |
| OpenAI, Kimi   |  | Git operations |  | RAG (HNSW vectors) |
| DeepSeek, Qwen |  | Shell exec     |  | Project analysis   |
| MiniMax, Groq  |  | .NET build/test|  | Learning patterns  |
| Ollama (local) |  | Browser        |  +--------------------+
| + 4 more       |  | Strata codegen |
+----------------+  +----------------+
```

### How the Agent Loop Works

1. **Message arrives** from a chat channel
2. **Memory retrieval** — finds the 3 most relevant past conversations (TF-IDF)
3. **RAG retrieval** — semantic search over your C# codebase (HNSW vectors, top 6 results)
4. **Instinct retrieval** — proactively queries learned patterns relevant to the task (semantic + keyword matching)
5. **PLAN phase** — LLM creates a numbered plan, informed by learned insights and past failures
6. **ACT phase** — LLM executes tool calls following the plan
7. **OBSERVE** — results are recorded; error recovery analyzes failures; failure classifier categorizes errors
8. **REFLECT** — every 3 steps (or on error), LLM decides: **CONTINUE**, **REPLAN**, or **DONE**
9. **Auto-replan** — if 3+ consecutive same-type failures occur, forces a new approach avoiding failed strategies
10. **Repeat** up to 50 iterations until complete
11. **Response sent** to the user through the channel (streaming if supported)

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
| `code_search` | Semantic/vector search via RAG — natural language queries |
| `memory_search` | Search persistent conversation memory |

### Strada Code Generation
| Tool | Description |
|------|-------------|
| `strata_analyze_project` | Full C# project scan — modules, systems, components, services |
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

## Memory System

The production memory backend is `FileMemoryManager` — JSON files with TF-IDF text indexing for search.

**How it works:**
- When session history exceeds 40 messages, old messages are summarized and stored as conversation entries
- The agent automatically retrieves the 3 most relevant memories before each LLM call
- The `strata_analyze_project` tool caches project structure analysis for instant context injection
- Memory persists across restarts in the `MEMORY_DB_PATH` directory (default: `.strata-memory/`)

**Advanced backend (implemented, not yet wired):** `AgentDBMemory` with SQLite + HNSW vector search, three-tier memory (working/ephemeral/persistent), hybrid retrieval (70% semantic + 30% TF-IDF). This is fully coded but not connected in bootstrap — `FileMemoryManager` is the active backend.

---

## RAG Pipeline

The RAG (Retrieval-Augmented Generation) pipeline indexes your C# source code for semantic search.

**Indexing flow:**
1. Scans `**/*.cs` files in your Unity project
2. Chunks code structurally — file headers, classes, methods, constructors
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

## Learning System

The learning system observes agent behavior and learns from errors:

- **Error patterns** are captured with full-text search indexing
- **Solutions** are linked to error patterns for future retrieval
- **Instincts** are atomic learned behaviors with Bayesian confidence scores
- **Trajectories** record sequences of tool calls with outcomes
- Confidence scores use **Elo rating** and **Wilson score intervals** for statistical validity
- Instincts below 0.3 confidence are deprecated; above 0.9 are proposed for promotion

**Active retrieval (new):** Instincts are proactively queried at the start of each task using the `InstinctRetriever`. It searches by keyword similarity and HNSW vector embeddings to find relevant learned patterns, which are injected into the PLAN phase prompt. This means the agent improves with use — past solutions inform future planning.

**Task decomposition:** Complex multi-step requests are automatically detected by heuristic analysis and decomposed into 3-8 ordered subtasks via the LLM before execution.

The learning pipeline runs on timers: pattern detection every 5 minutes, evolution proposals every hour. Data is stored in a separate SQLite database (`learning.db`).

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
When `READ_ONLY_MODE=true`, 23 write tools are removed from the agent's tool list entirely — the LLM cannot even attempt to call them.

### Layer 6: Operation Confirmation
Write operations (file writes, git commits, shell execution) can require user confirmation via the channel's interactive UI (buttons, inline keyboards, text prompts).

### Layer 7: Tool Output Sanitization
All tool results are capped at 8192 characters and scrubbed for API key patterns before feeding back to the LLM.

### Layer 8: RBAC (Internal)
5 roles (superadmin, admin, developer, viewer, service) with a permission matrix covering 9 resource types. Policy engine supports time-based, IP-based, and custom conditions.

---

## Dashboard & Monitoring

### HTTP Dashboard (`DASHBOARD_ENABLED=true`)
Accessible at `http://localhost:3001` (localhost only). Shows: uptime, message count, token usage, active sessions, tool usage table, security stats. Auto-refreshes every 3 seconds.

### Health Endpoints
- `GET /health` — Liveness probe (`{"status":"ok"}`)
- `GET /ready` — Deep readiness: checks memory and channel health. Returns 200 (ready), 207 (degraded), or 503 (not ready)

### Prometheus (`ENABLE_PROMETHEUS=true`)
Metrics at `http://localhost:9090/metrics`. Counters for messages, tool calls, tokens. Histograms for request duration, tool duration, LLM latency. Default Node.js metrics (CPU, heap, GC, event loop).

### WebSocket Dashboard (`ENABLE_WEBSOCKET_DASHBOARD=true`)
Real-time metrics pushed every second. Supports authenticated connections and remote commands (plugin reload, cache clear, log retrieval).

---

## Deployment

### Docker

```bash
docker-compose up -d
```

The `docker-compose.yml` includes the application, monitoring stack, and nginx reverse proxy.

### Daemon Mode

```bash
# Auto-restarts on crash with exponential backoff (1s to 60s, up to 10 restarts)
node dist/index.js daemon --channel telegram
```

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Set `LOG_LEVEL=warn` or `error`
- [ ] Configure `RATE_LIMIT_ENABLED=true` with budget caps
- [ ] Set channel allowlists (especially Slack — open by default)
- [ ] Set `READ_ONLY_MODE=true` if you want safe exploration only
- [ ] Enable `DASHBOARD_ENABLED=true` for monitoring
- [ ] Enable `ENABLE_PROMETHEUS=true` for metric collection
- [ ] Generate a strong `JWT_SECRET`

---

## Testing

```bash
npm test                         # Run all 1730+ tests
npm run test:watch               # Watch mode
npm test -- --coverage           # With coverage
npm test -- src/agents/tools/file-read.test.ts  # Single file
npm run typecheck                # TypeScript type checking
npm run lint                     # ESLint
```

110 test files covering: agents, channels, security, RAG, memory, learning, dashboard, integration flows.

---

## Project Structure

```
src/
  index.ts              # CLI entry point (Commander.js)
  core/
    bootstrap.ts        # Full initialization sequence — all wiring happens here
    di-container.ts     # DI container (available but manual wiring dominates)
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
    cli/                # Readline REPL
  memory/
    file-memory-manager.ts   # Active backend: JSON + TF-IDF
    unified/                 # AgentDB backend: SQLite + HNSW (not yet wired)
  rag/
    rag-pipeline.ts     # Index + search + format orchestration
    chunker.ts          # C#-specific structural chunking
    hnsw/               # HNSW vector store (hnswlib-node)
    embeddings/         # OpenAI and Ollama embedding providers
    reranker.ts         # Weighted reranking (vector + keyword + structural)
  security/             # Auth, RBAC, path guard, rate limiter, secret sanitizer
  learning/             # Pattern matching, HNSW semantic search, confidence scoring, instinct lifecycle
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
