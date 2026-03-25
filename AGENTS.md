# Strada.Brain

AI-powered Unity development assistant for Strada.Core framework projects. Multi-channel (Web, Telegram, Discord, Slack, WhatsApp, CLI, Matrix, IRC, Teams), multi-provider (OpenAI, Anthropic, Google, Groq, Ollama, OpenRouter), with autonomous learning and memory.

## Build & Test

```bash
npm install                # Install dependencies
npm run bootstrap          # Install + build web portal
npm run dev                # Development mode (tsx watch)
npm test                   # Run all tests (batched vitest)
npm run test:portal        # Run web portal tests
npm run doctor             # Diagnose setup issues
```

- Node.js 20+ required, ESM modules (`"type": "module"`)
- Test runner: Vitest with batched execution via `scripts/run-vitest-batches.mjs`
- Web portal: React + Vite in `web-portal/`, builds to `src/channels/web/static/`
- TypeScript strict mode, Zod for config validation

## Architecture Overview

- Entry: `src/index.ts` (Commander CLI) → `src/core/bootstrap.ts`
- Agent loop: `src/agents/` — Orchestrator (~5K lines) + 16 helper modules (reflection, intervention pipeline, end-turn, session, consensus, tool execution, loop shared, autonomy tracker, etc.)
- Shared agent utils: `src/agent-core/`
- 9 channel adapters: `src/channels/{web,telegram,discord,slack,whatsapp,cli,matrix,irc,teams}/`
- Config: `src/config/` — Zod-validated, 90+ env vars
- Memory: `src/memory/` — AgentDB (SQLite + HNSW vectors), 3-tier auto-tiering
- Learning: `src/learning/` — event-driven pipeline, instinct lifecycle
- Goals: `src/goals/` — DAG decomposition, wave-based parallel execution
- Security: `src/security/` — input sanitization, autonomy levels, permissions
- Dashboard: `src/dashboard/` — real-time WebSocket monitoring
- Web portal: `web-portal/` — React + Vite (separate package.json)

### Key Patterns

- **PAOR Loop**: Plan → Act → Observe → Reflect — the core agent execution cycle in the orchestrator
- **Modular Decomposition**: Orchestrator delegates to 16 focused modules; bootstrap delegates to bootstrap-providers, bootstrap-memory, bootstrap-channels, bootstrap-wiring
- **TypedEventBus**: All subsystem communication is event-driven
- **Channel Isolation**: Each channel adapter implements a common interface, sessions are isolated per-channel
- **Provider Agnostic**: LLM calls go through a unified provider layer supporting 6+ providers

## Code Style & Conventions

- TypeScript strict mode, ESM imports only (no CommonJS `require`)
- Zod schemas for all configuration and external data validation
- Prefer functional patterns; classes only for stateful components (Orchestrator, AgentManager)
- File naming: `kebab-case.ts` for source, `kebab-case.test.ts` for tests
- Test files live next to their source files, not in a separate directory
- No `any` types — use `unknown` with type guards when type is uncertain
- Prefer `interface` for object shapes, `type` for unions/intersections
- All public functions must handle errors — no unhandled promise rejections
- Max function length: keep functions focused and under ~50 lines where possible

## Git Workflow

- Branch naming: `feat/`, `fix/`, `refactor/`, `test/`, `docs/` prefixes
- Commit messages: `type(scope): description` format (e.g., `feat(agents): add delegation tool`)
- Never commit `.env`, credentials, or secrets
- Never force-push to `main`
- Prefer atomic commits — one logical change per commit

## Security

- Never hardcode API keys, secrets, or credentials
- All file paths must be sanitized against directory traversal
- Path containment checks must use `path.sep` (not hardcoded `"/"`), and absolute path detection must use `path.isAbsolute()` (not `startsWith("/")`) for Windows compatibility
- Spawning `.cmd` files on Windows requires `shell: true` (Node.js 22+, CVE-2024-27980)
- User input validated at system boundaries using Zod schemas
- Web channel binds to `127.0.0.1` only
- Media processing includes SSRF protection and magic byte validation
- Prompt injection sanitization in memory and personality systems

## Boundaries

- Do NOT modify `node_modules/` or generated `dist/` files
- Do NOT create files in the project root
- Do NOT modify test infrastructure (`scripts/run-vitest-batches.mjs`)
- Do NOT add new npm dependencies — the project maintains a minimal dependency policy
- Do NOT skip or disable existing tests to make new code pass
- Channel-specific code stays in its own `src/channels/{name}/` directory
- Core orchestrator changes require careful review — it coordinates the entire agent lifecycle
