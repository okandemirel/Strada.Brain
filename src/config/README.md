# src/config/

Single-file, Zod-validated configuration loaded from environment variables via dotenv.

## Configuration (`config.ts`)

Defines all application configuration types, Zod schemas, validation, secret patterns, and loading logic.

### Environment Loading

- Calls `dotenv.config()` at module load time
- `loadFromEnv()` maps `process.env` keys (e.g., `ANTHROPIC_API_KEY`) to camelCase `EnvVars` fields
- `loadConfig()` caches the result in a module-level `cachedConfig`; returns the cached value on subsequent calls
- `loadConfigSafe()` wraps `loadConfig()` in a try/catch and returns `Result<Config, string>`
- `resetConfigCache()` clears the singleton (used in tests)

### Zod Schemas

- `configSchema` is the top-level `z.object()` that validates and transforms raw env strings
- Custom transform schemas:
  - `portSchema` - parses string to int, enforces range 1024..65535
  - `boolFromString(default)` - converts `"true"` string to boolean
  - `commaSeparatedList` - splits on `,`, trims, filters empty
  - `commaSeparatedNumberList` - same as above but parses to `number[]`
- `validateConfig(raw)` calls `configSchema.safeParse()` then restructures the flat Zod output into the nested `Config` interface

### Config Interface

The `Config` type groups settings into nested sub-configs:

| Sub-config | Interface | Key env vars |
|------------|-----------|-------------|
| AI providers | top-level fields | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, etc. At least one usable hosted credential is required unless `PROVIDER_CHAIN` only uses local providers such as `ollama`; OpenAI can also authenticate via `OPENAI_AUTH_MODE=chatgpt-subscription` plus the local Codex auth session file. |
| `telegram` | `TelegramConfig` | `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_IDS` |
| `discord` | `DiscordConfig` | `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `ALLOWED_DISCORD_USER_IDS`, `ALLOWED_DISCORD_ROLE_IDS` |
| `slack` | `SlackConfig` | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`, `SLACK_SOCKET_MODE` |
| `whatsapp` | `WhatsAppConfig` | `WHATSAPP_SESSION_PATH`, `WHATSAPP_ALLOWED_NUMBERS` |
| `matrix` | `MatrixConfig` | `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, `MATRIX_USER_ID`, `MATRIX_ALLOWED_USER_IDS`, `MATRIX_ALLOWED_ROOM_IDS`, `MATRIX_ALLOW_OPEN_ACCESS` |
| `irc` | `IRCConfig` | `IRC_SERVER`, `IRC_NICK`, `IRC_CHANNELS`, `IRC_ALLOWED_USERS`, `IRC_ALLOW_OPEN_ACCESS` |
| `teams` | `TeamsConfig` | `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_ALLOWED_USER_IDS`, `TEAMS_ALLOW_OPEN_ACCESS` |
| `security` | `SecurityConfig` | `REQUIRE_EDIT_CONFIRMATION` (default true), `READ_ONLY_MODE` (default false), `JWT_SECRET` (optional unless internal system auth is used), `REQUIRE_MFA` (default false) |
| `strada` | `StradaDependencyConfig` | `STRADA_CORE_REPO_URL` and `STRADA_MODULES_REPO_URL` (official defaults), optional `STRADA_MCP_PATH` override for a local Strada.MCP checkout |
| `dashboard` | `DashboardConfig` | `DASHBOARD_ENABLED`, `DASHBOARD_PORT` (default 3100) |
| `websocketDashboard` | `WebSocketDashboardConfig` | `ENABLE_WEBSOCKET_DASHBOARD`, `WEBSOCKET_DASHBOARD_PORT` (default 3100), `WEBSOCKET_DASHBOARD_AUTH_TOKEN`, `WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS` (`WEBSOCKET_DASHBOARD_AUTH_TOKEN` also protects dashboard APIs when present) |
| `prometheus` | `PrometheusConfig` | `ENABLE_PROMETHEUS`, `PROMETHEUS_PORT` (default 9090) |
| `modelIntelligence` | `ModelIntelligenceConfig` | `MODEL_INTELLIGENCE_ENABLED`, `MODEL_INTELLIGENCE_REFRESH_HOURS`, `MODEL_INTELLIGENCE_DB_PATH`, `MODEL_INTELLIGENCE_PROVIDER_SOURCES_PATH` |
| `memory` | `MemoryConfig` | `MEMORY_ENABLED` (default true), `MEMORY_DB_PATH` (default `.strada-memory`) |
| `rag` | `RAGConfig` | `RAG_ENABLED` (default true), `EMBEDDING_PROVIDER` (default `auto`), `RAG_CONTEXT_MAX_TOKENS` (default 4000, range 500..16000) |
| `rateLimit` | `RateLimitConfig` | `RATE_LIMIT_ENABLED`, `RATE_LIMIT_MESSAGES_PER_MINUTE`, `RATE_LIMIT_DAILY_BUDGET_USD`, etc. |
| `web` | Web config | `WEB_CHANNEL_PORT` (default 3000) |
| top-level streaming safety | numeric fields | `LLM_STREAM_INITIAL_TIMEOUT_MS` (default 600000), `LLM_STREAM_STALL_TIMEOUT_MS` (default 120000) |
| `agent` | `AgentConfig` | `MULTI_AGENT_ENABLED` (default true), `AGENT_DEFAULT_BUDGET_USD`, `AGENT_MAX_CONCURRENT`, `AGENT_IDLE_TIMEOUT_MS`, `AGENT_MAX_MEMORY_ENTRIES` |
| `delegation` | `DelegationConfig` | `TASK_DELEGATION_ENABLED` (default false), `AGENT_MAX_DELEGATION_DEPTH`, `AGENT_MAX_CONCURRENT_DELEGATIONS`, `DELEGATION_TIER_LOCAL`, `DELEGATION_TIER_CHEAP`, `DELEGATION_TIER_STANDARD`, `DELEGATION_TIER_PREMIUM`, `DELEGATION_VERBOSITY`, `DELEGATION_TYPES`, `DELEGATION_MAX_ITERATIONS_PER_TYPE` |
| `autoUpdate` | auto-update config | `AUTO_UPDATE_ENABLED`, `AUTO_UPDATE_INTERVAL_HOURS`, `AUTO_UPDATE_IDLE_TIMEOUT_MIN`, `AUTO_UPDATE_CHANNEL`, `AUTO_UPDATE_NOTIFY`, `AUTO_UPDATE_AUTO_RESTART` |

- `PROVIDER_CHAIN` - comma-separated provider names for Strada's default orchestration pool and fallback ordering
- `OPENAI_AUTH_MODE` - `api-key` (default) or `chatgpt-subscription`; when set to subscription mode Strada reuses the local Codex/ChatGPT login instead of the OpenAI platform API key
- `OPENAI_CHATGPT_AUTH_FILE` - optional auth session file path for OpenAI subscription mode; defaults to `~/.codex/auth.json`
- `OPENAI_SUBSCRIPTION_ACCESS_TOKEN` / `OPENAI_SUBSCRIPTION_ACCOUNT_ID` - optional manual overrides for the Codex/ChatGPT subscription session
- OpenAI subscription auth is conversation-only. It does not imply OpenAI API quota for embeddings; `EMBEDDING_PROVIDER=openai` still requires `OPENAI_API_KEY`.
- `EMBEDDING_PROVIDER` - system-wide embedding selection for RAG/memory. This is independent from `PROVIDER_CHAIN`; for example, conversation can run on `openai` while embeddings use `gemini`, or vice versa.
- `PLUGIN_DIRS` - comma-separated directory paths for plugin loading
- `STRADA_CORE_REPO_URL` / `STRADA_MODULES_REPO_URL` - official git remotes used when the agent offers to install missing Strada packages
- `STRADA_MCP_PATH` - optional absolute/local path that pins Strada.MCP discovery to a specific checkout before sibling/global detection
- `LLM_STREAM_INITIAL_TIMEOUT_MS` / `LLM_STREAM_STALL_TIMEOUT_MS` - progress-aware stream watchdog thresholds used by interactive and background streaming paths
- `MODEL_INTELLIGENCE_PROVIDER_SOURCES_PATH` - path to the JSON registry of official provider docs/changelog URLs used to mine dynamic feature signals
- `LOG_LEVEL` - one of `error`, `warn`, `info`, `debug` (default `info`)
- `LOG_FILE` - default `strada-brain.log`
- `WEBSOCKET_DASHBOARD_AUTH_TOKEN` - optional; when unset, the embedded same-origin dashboard bootstraps a process-scoped token automatically

### Validation Helpers

- `validateProjectPath(path)` resolves symlinks via `realpathSync`, checks `isDirectory()`, returns `Result<string, string>`
- `hasRequiredApiKeys(config)` checks that at least one usable provider is configured, or that every provider named in `PROVIDER_CHAIN` has its required key/subscription auth
- `checkChannelConfig(config, channelType)` validates channel-specific requirements:
  - Telegram: requires bot token and non-empty allowed user IDs
  - Discord: requires bot token and either user or role allowlists
  - Slack: requires bot token; requires signing secret when not in socket mode
  - WhatsApp: requires a session path (defaults to `.whatsapp-session`)
  - Matrix: requires homeserver, access token, and user ID
  - IRC: requires server
  - Teams: requires app ID and app password
  - CLI: no requirements
  - Web: no requirements

### Secret Patterns

Exports a `secretPatterns: SecretPattern[]` array with 15 regex patterns for sanitizing secrets in output:

| Pattern name | Matches |
|-------------|---------|
| `openai_api_key` | `sk-` followed by 48+ alphanumeric chars |
| `openai_project_key` | `sk-proj-` prefix |
| `github_token` | `gh[pousr]_` prefix |
| `github_pat` | `github_pat_` prefix |
| `slack_token` | `xox[bpas]-` prefix |
| `slack_webhook` | `hooks.slack.com/services/` URLs |
| `bearer_token` | `Bearer` header values |
| `basic_auth` | `Basic` header values |
| `private_key` | PEM-encoded private keys |
| `connection_password` | `password=` or `pwd=` in connection strings |
| `database_url` | postgres/mysql/mongodb/redis URIs with credentials |
| `jwt_token` | `eyJ` base64 JWT structure |
| `env_value` | `KEY=value` lines |
| `discord_token` / `telegram_token` | Platform-specific token formats |
| `aws_access_key` | `AKIA` prefix |
| `secret_value` | Generic `secret/token/password/key` assignments |

### Config Merging

- `createPartialConfig(env)` builds a `PartialConfig` from a subset of env vars
- `mergeConfigs(base, partial)` shallow-merges top-level fields and each nested sub-config object

## Key Files

| File | Purpose |
|------|---------|
| `config.ts` | Zod-validated env-based configuration with types, secret patterns, and validation |
