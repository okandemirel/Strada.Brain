# External Integrations

**Analysis Date:** 2026-03-06

## APIs & External Services

### AI Providers (LLM Chat Completion)

The system supports 12 AI providers via a unified `IAIProvider` interface (`src/agents/providers/provider.interface.ts`). Providers can be chained for fallback via `PROVIDER_CHAIN` env var.

**Anthropic Claude (Primary):**
- SDK: `@anthropic-ai/sdk` ^0.39.0
- Implementation: `src/agents/providers/claude.ts`
- Auth: `ANTHROPIC_API_KEY` env var
- Default model: `claude-sonnet-4-20250514`
- Features: Streaming, tool calling, native SDK (not OpenAI-compat)
- Capabilities: `streaming: true`, `toolCalling: true`, `systemPrompt: true`

**OpenAI:**
- Implementation: `src/agents/providers/openai.ts` (base class for all OpenAI-compat providers)
- Auth: `OPENAI_API_KEY` env var
- Base URL: `https://api.openai.com/v1`
- Default model: `gpt-5.2`
- Uses native `fetch` for HTTP requests

**Google Gemini:**
- Implementation: `src/agents/providers/gemini.ts` (extends `OpenAIProvider`)
- Auth: `GEMINI_API_KEY` env var
- Base URL: `https://generativelanguage.googleapis.com/v1beta/openai`
- Default model: `gemini-3-flash-preview`
- Special handling: `thought_signature` echoing for tool calls

**DeepSeek:**
- Implementation: `src/agents/providers/deepseek.ts` (extends `OpenAIProvider`)
- Auth: `DEEPSEEK_API_KEY` env var
- Base URL: `https://api.deepseek.com/v1`
- Default model: `deepseek-chat`
- Special handling: `reasoning_content` extraction (R1 CoT), cache hit stats

**Qwen (Alibaba):**
- Implementation: `src/agents/providers/qwen.ts` (extends `OpenAIProvider`)
- Auth: `QWEN_API_KEY` env var
- Base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Default model: `qwen-max`

**Kimi (Moonshot):**
- Implementation: `src/agents/providers/kimi.ts` (extends `OpenAIProvider`)
- Auth: `KIMI_API_KEY` env var
- Base URL: `https://api.kimi.com/coding/v1`
- Default model: `kimi-for-coding`

**MiniMax:**
- Implementation: `src/agents/providers/minimax.ts` (extends `OpenAIProvider`)
- Auth: `MINIMAX_API_KEY` env var
- Base URL: `https://api.minimax.io/v1`
- Default model: `MiniMax-M2.5`

**Groq:**
- Implementation: `src/agents/providers/groq.ts` (extends `OpenAIProvider`)
- Auth: `GROQ_API_KEY` env var
- Base URL: `https://api.groq.com/openai/v1`
- Default model: `openai/gpt-oss-120b`

**Mistral:**
- Implementation: `src/agents/providers/mistral.ts` (extends `OpenAIProvider`)
- Auth: `MISTRAL_API_KEY` env var
- Base URL: `https://api.mistral.ai/v1`
- Default model: `mistral-large-latest`

**Together AI:**
- Implementation: `src/agents/providers/together.ts` (extends `OpenAIProvider`)
- Auth: `TOGETHER_API_KEY` env var
- Base URL: `https://api.together.xyz/v1`
- Default model: `meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8`

**Fireworks AI:**
- Implementation: `src/agents/providers/fireworks.ts` (extends `OpenAIProvider`)
- Auth: `FIREWORKS_API_KEY` env var
- Base URL: `https://api.fireworks.ai/inference/v1`
- Default model: `accounts/fireworks/models/llama4-maverick-instruct-basic`

**Ollama (Local):**
- Implementation: `src/agents/providers/ollama.ts`
- Auth: None required (local)
- Base URL: `OLLAMA_BASE_URL` env var (default: `http://localhost:11434`)
- Default model: `llama3.3`
- Uses OpenAI-compatible endpoint format

**Provider Management:**
- Registry: `src/agents/providers/provider-registry.ts` - factory + preset map
- Manager: `src/agents/providers/provider-manager.ts` - per-chat switching with SQLite persistence
- Fallback chain: `src/agents/providers/fallback-chain.ts` - sequential failover
- Preferences: `src/agents/providers/provider-preferences.ts` - SQLite store for per-chat provider selection

### Embedding Providers (RAG)

Resolved via `src/rag/embeddings/embedding-resolver.ts`. Uses OpenAI-compatible embedding API for most providers.

**Supported (with presets in `src/common/constants.ts`):**
| Provider | Model | Dimensions | Batch Size |
|----------|-------|-----------|------------|
| OpenAI | text-embedding-3-small | 1536 | 100 |
| Mistral | mistral-embed | 1024 | 100 |
| Together AI | m2-bert-80M-8k-retrieval | 768 | 100 |
| Fireworks AI | nomic-embed-text-v1.5 | 768 | 100 |
| Qwen | text-embedding-v3 | 1024 | 100 |
| Gemini | gemini-embedding-001 | 3072 | 1 |
| Ollama | nomic-embed-text | 768 | 100 |

**Not supported for embeddings:** Claude, DeepSeek, Kimi, MiniMax, Groq

**Implementation:**
- `src/rag/embeddings/openai-embeddings.ts` - OpenAI-compatible embedding client
- `src/rag/embeddings/ollama-embeddings.ts` - Ollama embedding client
- `src/rag/embeddings/embedding-cache.ts` - Persistent embedding cache

## Chat Channels (Communication Platforms)

All channels implement `IChannelAdapter` interface from `src/channels/channel.interface.ts`.

**Web Channel (Default):**
- Implementation: `src/channels/web/channel.ts`
- Protocol: HTTP + WebSocket (ws library)
- Binds to: `127.0.0.1` only (local access)
- Port: `WEB_CHANNEL_PORT` (default: 3000)
- Static files: `src/channels/web/static/`
- Rate limiting: 20 messages per 10 seconds per WebSocket connection
- Features: Streaming, rich messaging, interactive confirmations

**Telegram:**
- SDK: `grammy` ^1.35.0
- Implementation: `src/channels/telegram/bot.ts`
- Auth: `TELEGRAM_BOT_TOKEN` env var
- Access control: `ALLOWED_TELEGRAM_USER_IDS` (comma-separated)
- Features: Inline keyboards for confirmations, diff previews

**Discord:**
- SDK: `discord.js` ^14.25.1
- Implementation: `src/channels/discord/bot.ts`
- Auth: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID` env vars
- Access control: `ALLOWED_DISCORD_USER_IDS`, `ALLOWED_DISCORD_ROLE_IDS`
- Features: Slash commands (`src/channels/discord/commands.ts`), embeds, thread support, rate limiting (`src/channels/discord/rate-limiter.ts`)

**Slack:**
- SDK: `@slack/bolt` ^4.6.0, `@slack/types` ^2.20.0
- Implementation: `src/channels/slack/app.ts`
- Auth: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` env vars
- Socket Mode: Enabled by default (`SLACK_SOCKET_MODE=true`)
- Access control: `ALLOWED_SLACK_WORKSPACES`, `ALLOWED_SLACK_USER_IDS`
- Features: Slash commands (`src/channels/slack/commands.ts`), Block Kit UI (`src/channels/slack/blocks.ts`), rate limiting (`src/channels/slack/rate-limiter.ts`)

**WhatsApp:**
- Implementation: `src/channels/whatsapp/client.ts`
- Session persistence: `WHATSAPP_SESSION_PATH` (default: `.whatsapp-session`)
- Access control: `WHATSAPP_ALLOWED_NUMBERS` (comma-separated)
- Features: Auto-reconnect with exponential backoff, session cleanup

**CLI:**
- Implementation: `src/channels/cli/repl.ts`
- No external dependencies, uses Node.js readline
- For local development/testing

## Data Storage

**SQLite Databases (via better-sqlite3):**
- Learning DB: `{MEMORY_DB_PATH}/learning.db` (`src/learning/storage/learning-storage.ts`)
  - Tables: instincts, trajectories, trajectory_steps, error_patterns, observations
  - WAL mode enabled for concurrency
  - Prepared statement caching
- Task DB: `{MEMORY_DB_PATH}/tasks.db` (`src/tasks/task-storage.ts`)
  - Background task persistence and recovery
- Provider Preferences DB: `{MEMORY_DB_PATH}/provider-preferences.db` (`src/agents/providers/provider-preferences.ts`)
  - Per-chat AI provider selection

**File-based Storage:**
- Memory Manager: `src/memory/file-memory-manager.ts`
  - JSON-based conversation memory with TF-IDF text indexing
  - LRU cache for performance
  - Debounced flush to disk
- Vector Store: `src/rag/vector-store.ts`
  - `vectors/chunks.json` - chunk metadata
  - `vectors/vectors.bin` - raw float32 vectors
- HNSW Index: `src/rag/hnsw/hnsw-vector-store.ts`
  - `hnswlib-node` for approximate nearest neighbor search
  - Configurable via `HNSW_M`, `HNSW_EF_CONSTRUCTION`, `HNSW_EF_SEARCH`, `HNSW_MAX_ELEMENTS`
  - Can be disabled via `HNSW_DISABLED=true`

**File Storage:**
- Local filesystem only (no cloud storage)
- Default data path: `.strata-memory/` (configurable via `MEMORY_DB_PATH`)

**Caching:**
- Embedding cache: `src/rag/embeddings/embedding-cache.ts` - persistent to `{MEMORY_DB_PATH}/cache/`
- Config cache: singleton in `src/config/config.ts`
- Provider cache: LRU (max 50 entries) in `src/agents/providers/provider-manager.ts`

## Authentication & Identity

**Auth Provider:**
- Custom implementation: `src/security/auth.ts` and `src/security/auth-hardened.ts`
- Per-channel access control lists (user IDs, role IDs, workspace IDs)
- No external auth provider (no OAuth, no SSO)

**Security Modules:**
- `src/security/rate-limiter.ts` - Message/token/budget rate limiting
- `src/security/path-guard.ts` - File path traversal prevention
- `src/security/read-only-guard.ts` - Read-only mode enforcement
- `src/security/secret-sanitizer.ts` - Secret pattern detection and redaction
- `src/security/browser-security.ts` - URL validation and browser session limits
- `src/security/dm-policy.ts` / `src/security/dm-state.ts` - Destructive modification confirmation policy
- `src/security/rbac.ts` - Role-based access control
- `src/security/filesystem-security.ts` - Filesystem access controls
- `src/security/communication.ts` - Secure communication helpers
- `src/security/dependency-security.ts` - Dependency vulnerability checking
- `src/security/secret-rotation.ts` - Secret rotation lifecycle

**Encryption:**
- `src/encryption/data-protection.ts` - AES-256-GCM encryption at rest, key rotation
- Uses Node.js `node:crypto` (no external crypto library)

**JWT:**
- `JWT_SECRET` env var required
- Used internally for session/auth tokens

## Monitoring & Observability

**Prometheus Metrics:**
- Implementation: `src/dashboard/prometheus.ts`
- SDK: `prom-client` ^15.1.3
- Port: `PROMETHEUS_PORT` (default: 9090, enabled via `ENABLE_PROMETHEUS=true`)
- Metrics: messages_total, tool_calls_total, tokens_total, active_sessions, memory_usage, request/tool/LLM latency histograms
- Grafana datasource config: `monitoring/grafana-datasource.yml`
- Prometheus scrape config: `monitoring/prometheus.yml`

**Dashboard:**
- Implementation: `src/dashboard/server.ts`
- Built-in HTTP dashboard (no external framework, uses `node:http`)
- Port: `DASHBOARD_PORT` (default: 3100, enabled via `DASHBOARD_ENABLED=true`)
- Endpoints: `/` (HTML), `/api/metrics` (JSON), `/health` (liveness), `/ready` (deep health)

**WebSocket Dashboard:**
- Implementation: `src/dashboard/websocket-server.ts`
- Real-time metrics streaming
- Port: `WEBSOCKET_DASHBOARD_PORT` (default: 3101)

**Metrics Collector:**
- Implementation: `src/dashboard/metrics.ts`
- In-memory metrics aggregation

**Logging:**
- Framework: Winston ^3.17.0
- Implementation: `src/utils/logger.ts`
- Outputs: Console (colorized) + File (JSON, 10MB rotation, 3 files max)
- Default log file: `strata-brain.log`
- Levels: error, warn, info, debug

**Alerting:**
- Implementation: `src/alerting/alert-manager.ts`
- Supported alert channels (defined in `src/alerting/types.ts`):
  - Discord webhook
  - Slack webhook
  - Email (SMTP)
  - Telegram bot
  - PagerDuty
  - OpsGenie
  - Custom webhook
  - Console
- Alert monitors: `src/alerting/monitors/`

**Error Tracking:**
- No external error tracking service (Sentry, Datadog, etc.)
- Errors logged via Winston and handled by alerting system

## CI/CD & Deployment

**Docker:**
- Hardened Dockerfile: `docker/Dockerfile.hardened`
- Multi-stage build (deps -> builder -> production)
- Base image: `node:20-alpine`
- Security: non-root user, read-only rootfs, `--cap-drop=ALL`, `dumb-init` for PID 1
- Health check: HTTP GET `/health` every 30s
- Docker Compose: `docker/docker-compose.security.yml` (security-focused)
- Security scanning: `docker/security-scan.sh`

**Nginx:**
- Config: `nginx/nginx.conf`
- SSL certificates: `nginx/ssl/`

**CI Pipeline:**
- No GitHub Actions or CI pipeline configured (user preference to avoid build costs)
- Security testing scripts available: `npm run security:*`

**Hosting:**
- Self-hosted (local or VPS via Docker)
- No cloud platform integration (no Vercel, AWS, GCP)

## External Service Dependencies

**Strada Framework (Unity):**
- `src/config/strada-deps.ts` - Checks for Strada.Core and Strada.Modules in Unity project
- Git clone support for auto-installing dependencies
- Repos: `STRADA_CORE_REPO_URL`, `STRADA_MODULES_REPO_URL` env vars
- Default URLs: `https://github.com/okandemirel/Strata.Core.git`, `https://github.com/okandemirel/Strata.Modules.git`

**Browser Automation:**
- Playwright ^1.58.2 for web scraping/interaction tool
- Implementation: `src/agents/tools/browser-automation.ts`
- Config: `BROWSER_HEADLESS` (default: true), `BROWSER_TIMEOUT_MS` (default: 30000), `BROWSER_MAX_CONCURRENT` (default: 5)

## Environment Configuration

**Required env vars:**
- At least one AI provider API key (or Ollama in provider chain)
- `UNITY_PROJECT_PATH` - path to Unity project

**Critical optional env vars:**
- `JWT_SECRET` - for authentication
- `PROVIDER_CHAIN` - fallback provider order (e.g., `claude,deepseek,ollama`)
- Channel tokens (TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN, etc.)

**Secrets location:**
- `.env` file (not committed to git)
- `.env.example` provides template
- All secrets loaded via `dotenv` into `process.env`
- Secret sanitization applied to all AI responses and logs (`src/security/secret-sanitizer.ts`)

## Webhooks & Callbacks

**Incoming:**
- Web channel: WebSocket connections at `ws://localhost:{WEB_CHANNEL_PORT}`
- Dashboard: HTTP endpoints at `http://localhost:{DASHBOARD_PORT}`
- Prometheus: metrics endpoint at `http://localhost:{PROMETHEUS_PORT}/metrics`
- Slack: Socket Mode (no incoming webhooks needed) or Events API

**Outgoing:**
- Alert webhooks: Discord, Slack, PagerDuty, OpsGenie, custom webhook URLs
- AI provider API calls (12 providers)
- Embedding API calls (7 providers)
- Strada Git repos (clone for dependency installation)

## Plugin System

**Hot-Reload Plugins:**
- Implementation: `src/plugins/hot-reload.ts`
- Registry: `src/plugins/registry.ts`
- File watching: `chokidar` ^5.0.0
- Plugin directories: `PLUGIN_DIRS` env var (comma-separated)
- Plugins can add custom tools to the tool registry

---

*Integration audit: 2026-03-06*
