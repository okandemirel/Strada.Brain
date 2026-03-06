# Technology Stack

**Analysis Date:** 2026-03-06

## Languages

**Primary:**
- TypeScript 5.7+ - All application code in `src/`

**Secondary:**
- HTML/CSS/JS - Web channel static assets in `src/channels/web/static/`
- YAML - Prometheus/Grafana configs in `monitoring/`
- Dockerfile - Container config in `docker/Dockerfile.hardened`
- Shell - Security pentest scripts in `pentest/scripts/`

## Runtime

**Environment:**
- Node.js >= 20.0.0 (enforced via `engines` in `package.json`)
- ESM modules (`"type": "module"` in `package.json`)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present

**TypeScript Configuration:**
- Target: ES2022
- Module: ESNext
- Module Resolution: bundler
- Strict mode: enabled (all strict checks on)
- `noUncheckedIndexedAccess: true`
- `noUnusedLocals: true` / `noUnusedParameters: true`
- `noImplicitReturns: true` / `noFallthroughCasesInSwitch: true`
- `isolatedModules: true`
- Path alias: `@/*` maps to `./src/*`
- Config file: `tsconfig.json`

## Frameworks

**Core:**
- Commander 12.1+ - CLI framework for entry point (`src/index.ts`)
- Zod 3.24+ - Configuration validation schema (`src/config/config.ts`)

**AI Provider SDKs:**
- `@anthropic-ai/sdk` 0.39+ - Claude API (primary provider, `src/agents/providers/claude.ts`)
- Native `fetch` - OpenAI-compatible REST APIs for all other providers (`src/agents/providers/openai.ts`)

**Chat Channel SDKs:**
- grammy 1.35+ - Telegram Bot API (`src/channels/telegram/bot.ts`)
- discord.js 14.25+ - Discord Bot (`src/channels/discord/bot.ts`)
- `@slack/bolt` 4.6+ - Slack App with Socket Mode (`src/channels/slack/app.ts`)
- ws 8.19+ - WebSocket server for web channel (`src/channels/web/channel.ts`)
- Native `node:http` - HTTP server for web channel and dashboard

**Testing:**
- Vitest 2.1+ - Test runner with v8 coverage
- Config: `vitest.config.ts`
- Tests co-located: `src/**/*.test.ts`

**Build/Dev:**
- tsx 4.19+ - Development server with watch mode
- tsc - TypeScript compiler for production builds
- ESLint 9.16+ - Linting with flat config (`eslint.config.js`)
- `@typescript-eslint/eslint-plugin` 8.18+ and `@typescript-eslint/parser` 8.18+

## Key Dependencies

**Critical:**
- `@anthropic-ai/sdk` ^0.39.0 - Primary AI provider SDK (Claude). Native SDK, not OpenAI-compat.
- `better-sqlite3` ^12.6.2 - Embedded SQLite for learning storage, task storage, provider preferences
- `hnswlib-node` ^3.0.0 - HNSW vector index for semantic search in RAG and learning
- `zod` ^3.24.0 - Runtime schema validation for all config

**Infrastructure:**
- `winston` ^3.17.0 - Structured logging with file rotation (`src/utils/logger.ts`)
- `prom-client` ^15.1.3 - Prometheus metrics exposition (`src/dashboard/prometheus.ts`)
- `ws` ^8.19.0 - WebSocket server (web channel, dashboard)
- `dotenv` ^16.4.0 - Environment variable loading from `.env`
- `commander` ^12.1.0 - CLI argument parsing
- `chokidar` ^5.0.0 - File watching for hot-reload plugins (`src/plugins/hot-reload.ts`)
- `glob` ^11.0.0 - File pattern matching for search tools
- `diff` ^8.0.3 - Diff generation for file edit confirmations
- `playwright` ^1.58.2 - Browser automation tool (`src/agents/tools/browser-automation.ts`)

## Configuration

**Environment:**
- All configuration loaded from environment variables via `dotenv`
- Validated through Zod schema in `src/config/config.ts`
- `.env` file present (not committed), `.env.example` for reference
- `.env.docker` for Docker deployments
- `.env.security.example` for security-specific settings
- Config is cached as singleton after first load; `resetConfigCache()` available for reloads

**Required env vars:**
- At least one AI provider API key (e.g., `ANTHROPIC_API_KEY`)
- `UNITY_PROJECT_PATH` - path to Unity project directory

**Key optional env vars:**
- `PROVIDER_CHAIN` - comma-separated fallback provider order
- `{PROVIDER}_MODEL` - per-provider model overrides (12 providers supported)
- `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN` - channel tokens
- `MEMORY_ENABLED`, `RAG_ENABLED`, `DASHBOARD_ENABLED` - feature toggles
- `RATE_LIMIT_*` - rate limiting configuration
- `LOG_LEVEL` - error/warn/info/debug (default: info)

**Build:**
- `tsconfig.json` - TypeScript compiler configuration
- `eslint.config.js` - ESLint flat config with TypeScript plugin
- `vitest.config.ts` - Test configuration with path alias resolution

## Build & Run Commands

```bash
npm run dev          # tsx watch src/index.ts (dev with hot reload)
npm run build        # tsc + copy static assets
npm start            # node dist/index.js
npm run lint         # eslint src/
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run test:watch   # vitest (watch mode)
```

**CLI commands (after build):**
```bash
node dist/index.js start --channel web      # Start with web channel (default)
node dist/index.js start --channel telegram  # Start with Telegram
node dist/index.js start --channel discord   # Start with Discord
node dist/index.js start --channel slack     # Start with Slack
node dist/index.js cli                       # Interactive CLI mode
node dist/index.js daemon --channel web      # Run as daemon with auto-restart
```

## Platform Requirements

**Development:**
- Node.js 20+
- npm
- SQLite3 native bindings (via `better-sqlite3`)
- Playwright browsers (for browser automation tool, installed separately)

**Production:**
- Docker (Alpine-based Node 20 image)
- Multi-stage build via `docker/Dockerfile.hardened`
- Runs as non-root user (UID 1001)
- Read-only filesystem by default in Docker
- Health check endpoint at `/health`

**Data Storage:**
- `.strata-memory/` directory (default) - SQLite databases, vector store, caches
  - `learning.db` - Learning system instincts/trajectories
  - `tasks.db` - Background task persistence
  - `provider-preferences.db` - Per-chat provider selection
  - `vectors/` - RAG vector index files (chunks.json, vectors.bin)
  - `cache/` - Embedding cache

---

*Stack analysis: 2026-03-06*
