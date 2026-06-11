# Plan 012: Refresh runtime and toolchain dependencies (six independent, individually-gated bumps)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Each bump is an independent unit: verify and commit it before
> starting the next, so any single failure can be reverted alone. If anything
> in the "STOP conditions" section occurs, stop and report — do not
> improvise. When done, update the status row for this plan in
> `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat aea95ad..HEAD -- package.json package-lock.json web-portal/package.json web-portal/package-lock.json src/agents/providers/claude.ts src/vault/symbol-extractor src/intelligence/csharp-parser.ts src/agents/tools/browser-automation.ts src/daemon/triggers/file-watch-trigger.ts`
> If `package.json` or either lockfile changed since this plan was written,
> re-read them and re-verify every "Current state" version below before
> proceeding; on a mismatch in a version this plan bumps, treat it as a STOP
> condition. **Also**: if plan `plans/001-*.md` (react-router/qs audit fixes)
> exists and is not yet DONE in `plans/README.md`, do that one first — both
> plans rewrite lockfiles and will conflict.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (native module rebuild, parser runtime, provider SDK)
- **Depends on**: plans/001-*.md (lockfile ordering only — run after it lands)
- **Category**: migration
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

The Anthropic SDK is 6 minor versions behind (0.98 → 0.104), the tree-sitter runtime is a minor behind (0.25 → 0.26), and better-sqlite3 / playwright / discord.js / vitest have accumulated patch+minor updates. Staying close to current keeps security patches flowing and avoids a future big-bang migration. Each bump below is small individually; the value of this plan is the per-bump verification gates so a regression is attributable to one package.

## Current state

Verified in `package.json` at `aea95ad` (re-verify with `npm ls <pkg>` before each step):

| Package | Current (root) | Target | Direct consumers |
|---|---|---|---|
| `@anthropic-ai/sdk` | `^0.98.0` | latest `0.104.x` | `src/agents/providers/claude.ts` only (`client.messages.create` line 75, `client.messages.stream` line 110, `client.models.list` lines 133/145, `Anthropic.Tool.InputSchema` / `Anthropic.MessageParam` / `Anthropic.ContentBlockParam` / `Anthropic.Base64ImageSource` / `Anthropic.URLImageSource` types) |
| `web-tree-sitter` | `^0.25.10` | `0.26.x` | `src/vault/symbol-extractor/tree-sitter-loader.ts`, `typescript-extractor.ts`, `csharp-extractor.ts`; `src/intelligence/csharp-parser.ts` |
| `tree-sitter-typescript` | `^0.23.2` | bump together with runtime (executor checks latest compatible) | wasm grammar consumed via the loaders above |
| `tree-sitter-c-sharp` | `^0.23.1` | same | same |
| `better-sqlite3` | `^12.6.2` | `^12.10` (or latest 12.x) | `src/memory/unified/*` (agentdb-sqlite, consolidation-engine, user-profile-store, sqlite-pragmas...), `src/metrics/metrics-storage.ts`, `src/tasks/task-storage.ts`, `src/tasks/task-checkpoint-store.ts`, `src/core/bootstrap*.ts`. Native module — rebuild required. `@types/better-sqlite3` is `^7.6.13`. |
| `playwright` | `^1.58.2` | `^1.60` | `src/agents/tools/browser-automation.ts` (types `Browser, BrowserContext, Page` + `chromium`), `src/core/tool-registry.ts` |
| `discord.js` | `^14.25.1` | `^14.26.4` — **stay on v14, do NOT install v15** | `src/channels/discord/*` |
| `vitest` | root `^4.1.3`, portal `^4.1.0` | `^4.1.8` in BOTH `package.json` and `web-portal/package.json` | test runner |
| `typescript` | root `^6.0.2`, portal `~5.9.3` | portal → `^6.0.2` (align with root; verified both manifests: root devDeps line 113, portal devDeps line 71) | portal compiler only |
| `picomatch` | `^4.0.3` | **KEEP — do not remove.** | DIRECT import at `src/daemon/triggers/file-watch-trigger.ts:18` (`import picomatch from "picomatch"`). An earlier audit suggested removing it as transitive-only; that is wrong. The comment at lines 17-18 ("picomatch is a transitive dep via chokidar") is stale — it IS a declared direct dependency. |

Out of THIS plan: `react-router-dom` / `qs` audit fixes (plan 001's scope), `zod` 4.x / TypeScript-next / vitest 4.x-major (tracked as "P3 upgrades pending" elsewhere), `@huggingface/transformers`, `glob`, `grammy`, `@slack/*`.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|--------------------------|---------------------|
| Latest version check | `npm view <pkg> version` | prints latest |
| Install one bump | `npm install <pkg>@<range>` | exit 0, lockfile updated |
| Typecheck (root) | `npm run typecheck:src` | exit 0 |
| Typecheck (portal) | `npm --prefix web-portal run typecheck` | exit 0 |
| Lint | `npm run lint:src` | exit 0 |
| Targeted tests | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run <paths>` | all pass |
| Full suite (final) | `node scripts/run-vitest-batches.mjs` | exit 0 |
| Portal tests | `npm --prefix web-portal run test` | exit 0 |
| Portal build | `npm --prefix web-portal run build` | exit 0 |
| Native rebuild check | `node -e "const db=require('better-sqlite3')(':memory:');db.exec('create table t(a)');console.log('sqlite-ok')"` | prints `sqlite-ok` |

## Scope

**In scope** (the only files you should modify):
- `package.json`, `package-lock.json`
- `web-portal/package.json`, `web-portal/package-lock.json`
- `src/agents/providers/claude.ts` — ONLY if SDK type renames force mechanical fixes
- `src/vault/symbol-extractor/tree-sitter-loader.ts` (and sibling extractors), `src/intelligence/csharp-parser.ts` — ONLY if web-tree-sitter 0.26 API changes force mechanical fixes
- `src/agents/tools/browser-automation.ts` — ONLY if playwright type changes force mechanical fixes
- `src/daemon/triggers/file-watch-trigger.ts` — one comment-line correction (Step 7)

**Out of scope** (do NOT touch):
- Any behavioral change to providers/extractors/tools beyond what the compiler forces.
- `discord.js` v15, `zod` v4, TypeScript > 6.0.x, vitest major versions.
- `react-router-dom`, `qs`, or any other web-portal runtime dependency (plan 001).
- Removing `picomatch` (verified direct import).
- `@types/better-sqlite3` major bump (only patch within ^7.6 if needed).

## Git workflow

- Branch: `advisor/012-dependency-refresh`
- One conventional commit per bump, e.g. `chore(deps): bump @anthropic-ai/sdk to 0.104.x`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: @anthropic-ai/sdk 0.98 → 0.104.x

1. `npm view @anthropic-ai/sdk version` — confirm a 0.104.x (or newer 0.x) exists. Skim the changelog/releases for 0.99→target (https://github.com/anthropics/anthropic-sdk-typescript/releases) specifically for: `messages.create` / `messages.stream` signature changes, `Tool.InputSchema` type renames, `MessageParam`/`ContentBlockParam` changes, `models.list` pagination changes. Record findings in the commit body.
2. `npm install @anthropic-ai/sdk@^0.104.0` (adjust to the actual latest 0.10x).
3. Fix any compile errors in `src/agents/providers/claude.ts` mechanically (type renames only).

**Verify**: `npm run typecheck:src` → exit 0; `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/providers/claude-vision.test.ts src/agents/providers` → all pass. Commit.

### Step 2: web-tree-sitter 0.25 → 0.26 (+ grammar packages together)

1. `npm view web-tree-sitter version`, `npm view tree-sitter-typescript version`, `npm view tree-sitter-c-sharp version`. Check the web-tree-sitter 0.26 release notes for loader API changes (`Parser.init`, `Language.load` paths) and wasm ABI compatibility with the grammar versions you're installing — grammars and runtime must be bumped together.
2. `npm install web-tree-sitter@^0.26.0 tree-sitter-typescript@<latest-compatible> tree-sitter-c-sharp@<latest-compatible>`.
3. Fix mechanical API changes in `src/vault/symbol-extractor/tree-sitter-loader.ts` first (it is the single load point), then the two extractors and `src/intelligence/csharp-parser.ts` if they touch the changed APIs.

**Verify** (this is the gate for this bump — parser behavior, not just compile):
`npm run typecheck:src` → exit 0;
`NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/intelligence/csharp-parser.test.ts src/intelligence/csharp-deep-parser.test.ts src/vault/symbol-summarizer.test.ts` → all pass.
Note: `src/vault/symbol-extractor/` has no colocated `.test.ts` files; the intelligence parser tests + symbol-summarizer test are the closest executable coverage. Additionally run a direct smoke: `npx tsx -e "import('./src/vault/symbol-extractor/index.js').then(m=>console.log('extractor-ok', Object.keys(m).length))"` → prints `extractor-ok` with a non-zero count. Commit.

### Step 3: better-sqlite3 12.6 → 12.10 (native rebuild)

1. `npm view better-sqlite3 version`; `npm install better-sqlite3@^12.10.0` (or latest 12.x). This compiles a native module — expect node-gyp output; failure here is a STOP, not something to work around with `--ignore-scripts`.
2. Run the native smoke: `node -e "const db=require('better-sqlite3')(':memory:');db.exec('create table t(a)');console.log('sqlite-ok')"` → `sqlite-ok`.

**Verify**: `npm run typecheck:src` → exit 0;
`NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/memory/unified src/tasks/task-storage.test.ts src/tasks/task-checkpoint-store.test.ts src/metrics` → all pass (if a listed test file doesn't exist, run the containing directory instead). Commit.

### Step 4: playwright 1.58 → 1.60

1. `npm view playwright version`; `npm install playwright@^1.60.0`.
2. `npx playwright install chromium` ONLY if a browser-dependent test below requires it AND a chromium download is acceptable in this environment; otherwise skip (type-level verification suffices — `browser-automation.ts` lazily launches at runtime).

**Verify**: `npm run typecheck:src` → exit 0; `ls src/agents/tools/browser-automation.test.ts 2>/dev/null && NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/tools/browser-automation.test.ts || echo "no colocated test"` → tests pass or `no colocated test`. Commit.

### Step 5: discord.js 14.25 → 14.26.x (patch-level, stay on v14)

`npm view discord.js version` — if latest is 15.x, install the latest 14.x explicitly: `npm install discord.js@^14.26.4`. Confirm afterwards: `npm ls discord.js` shows `14.x`.

**Verify**: `npm run typecheck:src` → exit 0; `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/channels/discord` → all pass. Commit.

### Step 6: vitest 4.1.x patch + portal TypeScript alignment

1. Root: `npm install -D vitest@^4.1.8`.
2. Portal: `npm --prefix web-portal install -D vitest@^4.1.8 typescript@^6.0.2`.
3. Portal manifest check: `web-portal/package.json` now shows `"typescript": "^6.0.2"` (was `~5.9.3`) and `"vitest": "^4.1.8"`.

**Verify**: `npm --prefix web-portal run typecheck` → exit 0; `npm --prefix web-portal run lint` → exit 0; `npm --prefix web-portal run test` → exit 0; `npm --prefix web-portal run build` → exit 0. If the TS 6 alignment produces more than ~10 portal type errors, revert ONLY the typescript change (`npm --prefix web-portal install -D typescript@~5.9.3`), keep vitest, and record the error list in your final report. Commit.

### Step 7: Correct the stale picomatch comment

In `src/daemon/triggers/file-watch-trigger.ts:17`, the comment says picomatch is "a transitive dep via chokidar" — it is a declared direct dependency (package.json line 87). Update the comment to reflect reality, e.g. `// @ts-ignore -- picomatch ships no bundled types`. Keep the `@ts-ignore` if removing it breaks typecheck (no `@types/picomatch` is installed — do not add one in this plan).

**Verify**: `npm run typecheck:src` → exit 0. Commit (can be folded into the Step 6 commit if preferred).

### Step 8: Full gate

**Verify**: `npm run typecheck:src` → exit 0; `npm run lint:src` → exit 0; `node scripts/run-vitest-batches.mjs` → exit 0; `npm --prefix web-portal run build` → exit 0.

## Test plan

No new tests — this is a migration plan; the gates are the existing suites listed per step, plus the two runtime smokes (better-sqlite3 in-memory open, symbol-extractor import). Final gate is the full batched suite (`node scripts/run-vitest-batches.mjs`).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm ls @anthropic-ai/sdk web-tree-sitter tree-sitter-typescript tree-sitter-c-sharp better-sqlite3 playwright discord.js vitest` shows the bumped versions, no `invalid`/`missing`
- [ ] `grep -n '"typescript"' web-portal/package.json` shows `^6.0.2` (or the Step-6 revert is documented in the final report)
- [ ] `npm run typecheck:src` and `npm --prefix web-portal run typecheck` exit 0
- [ ] `node scripts/run-vitest-batches.mjs` exits 0
- [ ] `npm --prefix web-portal run build` exits 0
- [ ] `package.json` still contains `"picomatch"` in dependencies
- [ ] One commit per bump exists (`git log --oneline` shows ≥6 `chore(deps)` commits)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if — per bump, revert THAT bump (`git checkout -- package.json package-lock.json && npm install`) before stopping so the branch stays green:

- **SDK**: the 0.99→0.104 changelog shows `messages.create`/`messages.stream` behavioral changes (not just type renames), or claude provider tests fail after mechanical type fixes.
- **tree-sitter**: grammar wasm fails to load under the 0.26 runtime (ABI mismatch), or any parser test fails — do NOT pin mixed versions to force it.
- **better-sqlite3**: node-gyp build fails, or any memory/tasks test fails.
- **playwright/discord.js**: typecheck or the listed suites fail after the bump.
- **vitest**: the batched runner (`scripts/run-vitest-batches.mjs`) errors in the harness itself (not in tests).
- **General**: plan 001 is not DONE and its scope (react-router/qs) shows up in your lockfile diff; or any bump pulls a different MAJOR than specified.

## Maintenance notes

- After this lands, the remaining deliberate holdbacks are: discord.js v15, zod v4, TypeScript >6.0.x — tracked as P3 upgrades; do not let a reviewer fold them into this PR.
- The symbol-extractor module still has no direct tests — flagged during planning; a follow-up test plan for `src/vault/symbol-extractor/` would harden future tree-sitter bumps.
- If the portal TS 6 alignment was reverted in Step 6, file the error list as a follow-up — root and portal compilers drifting is what this step was trying to end.
