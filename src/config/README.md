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
| AI providers | top-level fields | `ANTHROPIC_API_KEY` (required), `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, etc. |
| `telegram` | `TelegramConfig` | `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_IDS` |
| `discord` | `DiscordConfig` | `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` |
| `slack` | `SlackConfig` | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`, `SLACK_SOCKET_MODE` |
| `security` | `SecurityConfig` | `REQUIRE_EDIT_CONFIRMATION` (default true), `READ_ONLY_MODE` (default false) |
| `dashboard` | `DashboardConfig` | `DASHBOARD_ENABLED`, `DASHBOARD_PORT` (default 3100) |
| `websocketDashboard` | `WebSocketDashboardConfig` | `ENABLE_WEBSOCKET_DASHBOARD`, `WEBSOCKET_DASHBOARD_PORT` (default 3100), `WEBSOCKET_DASHBOARD_AUTH_TOKEN`, `WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS` |
| `prometheus` | `PrometheusConfig` | `ENABLE_PROMETHEUS`, `PROMETHEUS_PORT` (default 9090) |
| `memory` | `MemoryConfig` | `MEMORY_ENABLED` (default true), `MEMORY_DB_PATH` (default `.strada-memory`) |
| `rag` | `RAGConfig` | `RAG_ENABLED` (default true), `EMBEDDING_PROVIDER` (default `openai`), `RAG_CONTEXT_MAX_TOKENS` (default 4000, range 500..16000) |
| `rateLimit` | `RateLimitConfig` | `RATE_LIMIT_ENABLED`, `RATE_LIMIT_MESSAGES_PER_MINUTE`, `RATE_LIMIT_DAILY_BUDGET_USD`, etc. |
| `web` | Web config | `WEB_CHANNEL_PORT` (default 3000) |

- `PROVIDER_CHAIN` - comma-separated provider names for fallback ordering
- `PLUGIN_DIRS` - comma-separated directory paths for plugin loading
- `LOG_LEVEL` - one of `error`, `warn`, `info`, `debug` (default `info`)
- `LOG_FILE` - default `strada-brain.log`

### Validation Helpers

- `validateProjectPath(path)` resolves symlinks via `realpathSync`, checks `isDirectory()`, returns `Result<string, string>`
- `hasRequiredApiKeys(config)` checks for `ANTHROPIC_API_KEY` presence
- `checkChannelConfig(config, channelType)` validates channel-specific requirements:
  - Telegram: requires bot token and non-empty allowed user IDs
  - Discord: requires bot token
  - Slack: requires bot token; requires signing secret when not in socket mode
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
