# Strada.Brain — Copilot Instructions

AI-powered Unity development assistant. TypeScript, Node.js 20+, ESM modules.

## Build & Test

- `npm test` — Run all tests (batched Vitest)
- `npm run dev` — Development mode
- `npm run bootstrap` — Install + build web portal
- `npm run doctor` — Diagnose setup issues

## Architecture

- Entry: `src/index.ts` (Commander CLI) → `src/core/bootstrap.ts`
- Agent loop: PAOR (Plan → Act → Observe → Reflect) in `src/agents/`
- 9 channels: web, telegram, discord, slack, whatsapp, cli, matrix, irc, teams
- Memory: AgentDB (SQLite + HNSW vectors) in `src/memory/`
- Config: Zod-validated, 90+ env vars in `src/config/`
- Web portal: React + Vite in `web-portal/` (separate package.json)

## Code Style

- TypeScript strict mode, ESM imports only (no `require`)
- Zod for all config/external data validation
- File naming: `kebab-case.ts`, tests: `kebab-case.test.ts` (colocated)
- No `any` — use `unknown` with type guards
- Prefer `interface` for object shapes, `type` for unions/intersections
- Prefer functional patterns; classes for stateful components only
- Keep functions focused and under ~50 lines
- Test runner: Vitest (not Jest)

## Git Workflow

- Branch naming: `feat/`, `fix/`, `refactor/`, `test/`, `docs/` prefixes
- Commit format: `type(scope): description`
- Never force-push to `main`

## Security

- Never hardcode secrets or credentials
- Sanitize file paths against directory traversal
- Validate user input at system boundaries
- Web channel binds to 127.0.0.1 only
- Prompt injection sanitization in memory/personality systems

## Boundaries

- Don't modify `node_modules/`, `dist/`, or test infrastructure
- Don't add npm dependencies without discussion
- Don't skip existing tests to make new code pass
- Channel code stays in `src/channels/{name}/`
- Core orchestrator changes require careful review
