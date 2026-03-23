---
trigger: glob
globs: "**/*.test.ts,**/*.spec.ts"
---

# Testing Rules

- Runner: Vitest (not Jest) — `npm test`
- Tests colocated next to source files
- Web portal tests: `npm run test:portal`
- Never skip/disable existing tests
- Use `vi.fn()` for mocks, `vi.spyOn()` for spies
- Test files follow `kebab-case.test.ts` naming
- Batched execution via `scripts/run-vitest-batches.mjs`
