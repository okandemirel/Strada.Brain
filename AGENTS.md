# Strada.Brain

AI-powered Unity development assistant for Strada.Core framework projects. It is multi-channel (Web, Telegram, Discord, Slack, CLI, Teams) and multi-provider, with autonomous learning and memory.

Every agent session loads this file: Claude Code reaches it through `CLAUDE.md`, and Codex reads it directly. So it is a **router**. It holds pointers and the few rules that are cheap to state and expensive to miss. **The rules themselves live in [docs/contracts/README.md](docs/contracts/README.md).** Open the contract for an area before you change code in it.

## Build & Test

```bash
npm install                # Install dependencies
npm run bootstrap          # Install + build web portal
npm run dev                # Development mode (tsx watch)
npm test                   # Run all tests (batched vitest)
npm run test:portal        # Run web portal tests
npm run doctor             # Diagnose setup issues
```

- Node.js 20+, ESM (`"type": "module"`), TypeScript strict mode, Zod for config validation.
- Tests run on Vitest, batched by `scripts/run-vitest-batches.mjs`. The web portal (React + Vite, its own package.json) is in `web-portal/` and builds to `src/channels/web/static/`.

## Where things are

- **Contracts**, the rule index with a "read when" column: `docs/contracts/README.md`.
- **Entry point:** `src/index.ts` (Commander CLI), which calls `src/core/bootstrap.ts`. Bootstrap delegates to its `bootstrap-*` stages.
- **Agent loop:** `src/agents/`. The orchestrator runs Plan → Act → Observe → Reflect and delegates to focused helper modules. Shared agent code is in `src/agent-core/`. Subsystems talk over the TypedEventBus.
- **Campaigns** ("GDD in → finished game out"): `src/campaign/`.
- **Goal DAG planning:** `src/goals/`. The planner's rules are in `goal-decomposer.ts`.
- **Conformance gates** (the `[STRADA …]` refusals): `src/agents/autonomy/strada-conformance.ts`. The worker's framework knowledge is in `src/agents/context/strada-knowledge.ts`.
- **Other subsystems:**
  - channels: `src/channels/{web,telegram,discord,slack,cli,teams}/`
  - config (Zod, 90+ env vars): `src/config/`
  - memory (AgentDB, SQLite + HNSW): `src/memory/`
  - learning: `src/learning/`
  - local asset generation: `src/assets-local/`
  - security: `src/security/`
  - dashboard: `src/dashboard/`
- **Shared helpers:** `src/common/`, `src/utils/`. Look there before you write a helper. A second copy of a helper is how the path-containment contract started.
- **Codebase Memory Vault:** `docs/vault.md`.
  - When `config.vault.enabled=true`, prefer `vault_search` over repeated Read/Grep cycles.
  - Use `vault_init`, `vault_sync` and `vault_status` to attach, reindex and check a vault.
  - SelfVault indexes this repo's `src/`, `web-portal/src/`, `tests/`, `docs/`, `AGENTS.md` and `CLAUDE.md`.

## Non-negotiable rules

Each of these was paid for once. This file holds one line per rule. The reason, the single producer and the detector are in the contract.

- **Path containment:** never hand-roll "is X inside Y". Call `isAtOrInside` or `isStrictlyInside` from `src/common/path-containment.ts`, with both sides in the same spelling. → `docs/contracts/path-containment.md`
- **ESM:** no bare `require(` in `src`. Inside a try/catch it is a silent false at run time, and the tests cannot see it. → `docs/contracts/esm-no-require.md`
- **Gates:** a gate that refuses work ships together with the prompt sentence that asks for what it judges. → `docs/contracts/gate-needs-an-asker.md`
- **Tests:** never make a check pass by weakening its test — no removed case or assertion, new skip, commented-out test, or loosened pin without a `Test-Weakened:` line in that commit. CI and the pre-push hook check every commit. → `docs/contracts/test-integrity.md`
- **File size:** no source file grows past 1,000 lines, and the 64 that already have may not grow at all. New code goes into a module beside the file. → `docs/contracts/file-size.md`

## High-traffic router

| Area | When you touch it | Contract |
| --- | --- | --- |
| Paths | any inside / under / within check; a realpath compared with a typed path | `docs/contracts/path-containment.md` |
| Module loading | `require`, a lazy or optional import, a try/catch around a load | `docs/contracts/esm-no-require.md` |
| Gates & planning prompts | a `[STRADA …]` gate; a rule in `goal-decomposer.ts` or `strada-knowledge.ts`; a Strada tool description | `docs/contracts/gate-needs-an-asker.md` |
| Tests | editing a failing test; skip/only/todo; a BASELINE or PINNED number | `docs/contracts/test-integrity.md` |
| Large files | adding code to `campaign-manager.ts`, `orchestrator.ts` or any file over 1,000 lines | `docs/contracts/file-size.md` |

## Team skills

When a request matches, load the skill file and follow it in full. The slash wrappers only load it.

- **`ship`** — "commit this", "push", "ship it", "land it": run `node scripts/ci/gates.mjs`, stage explicit paths, push, watch CI. → `docs/skills/ship/SKILL.md`

## Team memory

- **Read:** at the start of a session, read `docs/memory/CORE.md` (40 lines). Before you enter an area, scan `docs/memory/INDEX.md` and open only the entries that match it. Never read `entries/` in bulk.
- **Capture:** an entry is worth writing when you chose between alternatives, found a root cause that was not obvious, were corrected by the owner, or finished a spike. Write it if it will recur, cannot be derived from the code, and is costly not to know. Write it in the format given in `docs/memory/POLICY.md`, run `node scripts/memory-index.mjs`, and say `team-memory: <summary>`.
- Memory is not a status board. A rule that has a detector is a contract, not a memory entry.

## Conventions

- ESM imports only. Zod for all configuration and external data.
- No `any`: use `unknown` with type guards. Use `interface` for object shapes and `type` for unions and intersections.
- Prefer functional patterns. Use classes only for stateful components.
- Name source files `kebab-case.ts` and tests `kebab-case.test.ts`, next to their source.
- Keep functions focused, under ~50 lines where possible.
- Every public function handles its errors. No unhandled promise rejections.

## Git

- Branch prefixes: `feat/`, `fix/`, `refactor/`, `test/`, `docs/`. Commit messages: `type(scope): description`. Make atomic commits, one logical change each.
- Never commit `.env`, credentials or secrets. Never force-push `main`.
- Never amend a commit that is already pushed: CI's Version Bump workflow fails on the rewritten sha.

## Security

- Never hardcode API keys, secrets or credentials. Validate user input at system boundaries with Zod.
- Sanitize every file path against directory traversal. Detect absolute paths with `path.isAbsolute()`, not `startsWith("/")`. For containment, see the path-containment contract.
- Spawning `.cmd` files on Windows requires `shell: true` (Node.js 22+, CVE-2024-27980).
- Listeners bind `127.0.0.1` by default. `BIND_HOST` is the only way to widen that (it is validated; containers set `0.0.0.0`).
- Media processing includes SSRF protection and magic-byte validation. Memory and personality inputs get prompt-injection sanitization.

## Boundaries

- Do NOT modify `node_modules/` or generated `dist/` files.
- Do NOT create files in the project root.
- Do NOT modify test infrastructure (`scripts/run-vitest-batches.mjs`).
- Do NOT add new npm dependencies. The project keeps a minimal dependency policy.
- Do NOT skip or disable existing tests to make new code pass.
- Do NOT name, quote or commit material from any external project Strada.Brain was run against. That covers names, design documents, campaign exports, measured counts and run ids, in code, comments, tests, fixtures, docs and commit messages.
  - Fixtures and examples use invented data from an unrelated domain.
  - Patterns, keyword lists and defaults are written for any project, never tuned to one document's wording or one product's look.
  - Local lists of protected terms or confidential documents, if you keep them, live in the gitignored `tests/fixtures/local/*.txt`. `src/universality.test.ts` checks every publishable file against them, and skips with a stated reason when they are absent.
- Channel-specific code stays in its own `src/channels/{name}/` directory.
- Core orchestrator changes require careful review: the orchestrator coordinates the entire agent lifecycle.

## Maintaining this file

Every session loads this file, so keep it a router and not a reference.

- A new contract gets one row in `docs/contracts/README.md`, and at most one row in the router table above, and only if its area is touched weekly.
- Never copy a contract's text, table or example here. The detail lives in exactly one place: the contract.
- `src/contracts.test.ts` fails if this file names a contract that does not exist.
