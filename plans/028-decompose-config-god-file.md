# Plan 028: Decompose `config.ts` (first god-file) into types + schema modules

> **Executor instructions**: Behavior-preserving refactor. Write the snapshot
> characterization test in Step 1 BEFORE moving code. Keep `config.ts`'s public
> exports identical (re-export moved symbols) so NO import site anywhere changes.
> On any "STOP condition", stop and report. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat cc8f814..HEAD -- src/config/config.ts`
> If changed, re-map the sections (line numbers below will have moved) before proceeding.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: plan 024 pattern (config has `config.test.ts`; this plan adds a snapshot guard too)
- **Category**: tech-debt
- **Planned at**: commit `cc8f814`, 2026-06-19

## Why this matters

`config.ts` is **3684 lines** — type declarations, a giant Zod schema, env-var
name union, the loader, and validation helpers all in one module. It is the
second-largest non-orchestrator file and is imported across the whole codebase,
so every config change risks this monolith. This plan is the **first** god-file
decomposition and establishes the safe pattern (extract behind unchanged public
exports, snapshot-guarded) that the remaining god-files (orchestrator, bootstrap,
learning-storage, web/channel, dashboard/server) will follow in their own plans.

config.ts is chosen first because it splits along clean, mostly-declarative seams
(types, schema) — far lower risk than the orchestrator's control flow.

## Current state — section map (verified)

`src/config/config.ts`:
- **Header/doc**: lines 1–32
- **`EnvVarName` union + `EnvVarMap`** (pure types): lines 37–382
- **Config interfaces/types** (LogLevel, EmbeddingProvider, OpenAI/Anthropic auth modes, AIProviderName, GoalConfig, ReRetrievalConfig, RateLimitConfig, MemoryConfig, RAGConfig, DashboardConfig, PrometheusConfig, ModelIntelligenceConfig, WebSocketDashboardConfig, Slack/Discord/Telegram/WhatsApp/Matrix/IRC/Teams configs, SystemAuthConfig, SecurityConfig, BudgetConfig, … the top-level `Config`): lines 384–984
- **`configSchema`** (Zod object) + validation internals: lines 985–~2510
- **Unity path validation + assembly** (`return { … }`): ~2560–3026
- **`loadConfig(envOverride?)`**: line 3353; **`loadConfigSafe()`**: line 3482; trailing validation helper ~3598–3683

Public surface that MUST keep working unchanged: the `Config` type and all config
interfaces, `EnvVarName`/`EnvVarMap`, `configSchema`, `loadConfig`, `loadConfigSafe`.
Import sites across `src/` do `import { … } from ".../config/config.js"` — they
must not need editing.

Safety net: `src/config/config.test.ts` exists (1059 lines).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck (whole repo) | `npm run typecheck` | exit 0 |
| Config tests | `npx vitest run src/config/config.test.ts` | all pass |
| Full suite | `npm test` | all pass |
| Find import sites | `grep -rn "from \"\.\./.*config/config\(\.js\)\?\"" src \| wc -l` | unchanged before/after |

## Scope

**In scope**:
- New: `src/config/config-types.ts` (the type/interface declarations)
- New: `src/config/config-schema.ts` (the Zod `configSchema` + its local schema helpers)
- `src/config/config.ts` (now: imports the above, re-exports them, keeps `loadConfig`/`loadConfigSafe` + assembly)
- `src/config/config.test.ts` (add the snapshot guard)

**Out of scope** (do NOT touch):
- Any import site outside `src/config/` — re-exports must make this a no-op for them.
- `loadConfig` behavior / env-var reading logic / defaults — values must be identical.
- The OTHER god-files (orchestrator/bootstrap/learning-storage/channel/server) — separate plans.

## Git workflow

- Branch: `refactor/028-config-decomp`
- Commits: `test(config): snapshot loadConfig output` → `refactor(config): extract config-types` → `refactor(config): extract config-schema`.

## Steps

### Step 1: Snapshot characterization test FIRST

In `config.test.ts`, add a test that calls `loadConfig(<a fixed, complete env map>)`
and asserts a deep snapshot of the resulting `Config` (use a stable inline
expected object or `toMatchObject` over the meaningful fields — avoid volatile
fields like absolute paths; normalize them). This proves the refactor changes
nothing observable.

**Verify**: `npx vitest run src/config/config.test.ts` → pass.

### Step 2: Extract types → `config-types.ts`

Move lines 37–984 (the `EnvVarName`/`EnvVarMap` and all config interfaces/types)
into `src/config/config-types.ts`. In `config.ts`, add `export * from "./config-types.js";`
(plus any named re-exports needed for default-style imports). Types are
compile-time only → zero runtime risk.

**Verify**: `npm run typecheck` → 0 (this is the real test — any missing export fails here); import-site count unchanged.

### Step 3: Extract the schema → `config-schema.ts`

Move `configSchema` and its local-only schema helpers (lines ~985–2510, the Zod
parts that do not read process state) into `src/config/config-schema.ts`,
importing types from `config-types.js`. Re-export `configSchema` from `config.ts`.
Keep `loadConfig`/`loadConfigSafe`/the assembly + Unity path validation in
`config.ts` (they orchestrate env reading and belong with the loader).

**Verify**: `npm run typecheck` → 0; `npx vitest run src/config/config.test.ts` → pass incl. the Step-1 snapshot (unchanged); `npm test` → green.

### Step 4: Confirm no import churn

**Verify**: `git diff --name-only` shows only `src/config/*`. The import-site grep count from "Commands" is identical to before.

## Test plan

- Step-1 snapshot test is the contract: identical `Config` from `loadConfig` before/after.
- `config.test.ts` and the full suite must pass unchanged (only additions).

## Done criteria

ALL must hold:

- [ ] `config-types.ts` + `config-schema.ts` exist; `config.ts` re-exports them
- [ ] `config.ts` line count reduced by ~1500+ (`wc -l src/config/config.ts`)
- [ ] `npm run typecheck` exits 0; `npm test` green; snapshot test passes
- [ ] `git diff --name-only` touches only `src/config/` (no import-site edits)
- [ ] `plans/README.md` row updated

## STOP conditions

- Moving a type breaks an import that used a non-re-exported path (e.g. a deep import) — fix by re-exporting; if a consumer deep-imports `config.ts` internals, STOP and report (the public surface assumption is violated).
- The Zod schema references runtime/process state that can't move cleanly into `config-schema.ts` — leave that piece in `config.ts`; report what couldn't move.
- The snapshot test reveals `loadConfig` output is non-deterministic for a fixed env (a latent bug) — STOP and report.

## Maintenance notes

- This establishes the god-file decomposition pattern: snapshot/characterize → move declarations behind unchanged re-exports → verify via typecheck + full suite.
- Follow-up plans (each its own file, each needs plan-024 characterization tests first): orchestrator.ts (7087 — highest risk, split last), bootstrap.ts (1926, stage-DAG), learning-storage.ts (2621, schema/queries/stats), web/channel.ts (2123), dashboard/server.ts (2036). Do NOT attempt those here.
- Reviewer should confirm zero behavior change by reading the snapshot test + the import-site grep, not by re-reading every moved type.
