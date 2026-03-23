---
trigger: always_on
---

# Strada.Brain — General Rules

AI-powered Unity development assistant. TypeScript, Node.js 20+, ESM modules.

## Build & Test
- `npm test` — All tests (batched Vitest)
- `npm run dev` — Development mode
- `npm run bootstrap` — Install + build web portal
- `npm run doctor` — Diagnose setup issues

## Code Style
- TypeScript strict mode, ESM imports only (no `require`)
- Zod for config/external data validation
- File naming: `kebab-case.ts`, tests: `kebab-case.test.ts` (colocated)
- No `any` — use `unknown` with type guards
- Prefer functional patterns; classes for stateful components only
- Commit format: `type(scope): description`

## Security
- Never hardcode secrets or credentials
- Sanitize file paths against directory traversal
- Web channel binds to 127.0.0.1 only

## Boundaries
- Don't modify `node_modules/`, `dist/`, or test infrastructure
- Don't add npm dependencies without discussion
- Don't skip existing tests to make new code pass
