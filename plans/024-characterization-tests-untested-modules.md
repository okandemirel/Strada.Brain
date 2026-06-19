# Plan 024: Characterization tests for high-risk untested modules

> **Executor instructions**: This plan adds tests to **capture current behavior**
> of modules that have none. Do NOT change the modules under test. If a test
> reveals a real bug, STOP and report it (do not fix it here). Do the modules in
> the order below; **one commit per module** so each is independently reviewable.
> Update this plan's row in `plans/README.md` when done (or after each module if
> running incrementally).
>
> **Drift check (run first)**: `git diff --stat cc8f814..HEAD -- src/vault/sqlite-vault-store.ts src/dashboard/server-system-routes.ts src/core/bootstrap-stages/stage-agents.ts src/config/config-catalog.ts src/supervisor/supervisor-feedback.ts src/intelligence/framework/framework-drift.ts`
> If a target changed, compare to the line counts below before testing it.

## Status

- **Priority**: P2
- **Effort**: L (split per module; each is S–M)
- **Risk**: LOW (test-only)
- **Depends on**: none. **Unblocks**: plans 027 (channel consolidation) and 028 (config decomposition) — characterization tests must exist before refactoring.
- **Category**: tests
- **Planned at**: commit `cc8f814`, 2026-06-19

## Why this matters

These modules carry real risk (data integrity, startup, secret handling, learning
quality) and have **zero co-located tests**. Without characterization tests, any
refactor (including plans 027/028) is unsafe, and silent regressions ship. The
goal is not coverage % — it is locking the current contract of dangerous code.

## Current state (verified — all have NO `*.test.ts` sibling)

| Order | Module | Lines | Why dangerous | Exemplar test to model after |
|---|---|---|---|---|
| 1 | `src/vault/sqlite-vault-store.ts` | 490 | vault file/chunk/symbol persistence + FTS + schema; data loss on corruption | an existing vault test from plan 006 (`src/vault/path-policy.test.ts` for harness; find the store-level vault test nearest in `src/vault/`) |
| 2 | `src/dashboard/server-system-routes.ts` | 706 | `/api/logs` (secret-sanitized ring buffer), crash telemetry, system info | `src/dashboard/server-vault-routes.test.ts` (664 ln) |
| 3 | `src/core/bootstrap-stages/stage-agents.ts` | 497 | agent/orchestrator init; failure bricks startup | `src/core/bootstrap-stages.test.ts` (exists) |
| 4 | `src/config/config-catalog.ts` | 395 | provider/model catalog load via real fs; silent startup failure | `src/config/config.test.ts` (1059 ln) |
| 5 | `src/supervisor/supervisor-feedback.ts` | 513 | 14 narrative builders feeding dashboard UI | the existing supervisor-verification test in `src/supervisor/` |
| 6 | `src/intelligence/framework/framework-drift.ts` | 313 | drift detection drives learning; high churn | nearest test in `src/intelligence/` |
| 7 | `src/dashboard/server-daemon-routes.ts` | 317 | daemon lifecycle mutations | `server-vault-routes.test.ts` |
| 8 | `src/dashboard/server-personality-routes.ts` | 249 | personality config mutations | `server-settings-routes.test.ts` (709 ln) |
| 9 | `src/vault/symbol-extractor/typescript-extractor.ts` | 196 | TS symbol extraction for code graph | `src/vault/symbol-extractor/markdown-extractor.test.ts` (978 ln) |
| 10 | `src/vault/symbol-extractor/csharp-extractor.ts` | 156 | C# symbol extraction | same as 9 |
| 11 | `src/agents/tools/vault-sync-tool.ts` | 26 | tool registration metadata | any tool-definition test |

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Run one new test | `npx vitest run <path-to-new-test>` | all pass |
| Typecheck | `npm run typecheck:src` | exit 0 |
| Confirm sibling test created | `ls <module-dir>/<module>.test.ts` | exists |

## Scope

**In scope**: create `*.test.ts` next to each module above (co-located, the repo convention). Optional minimal test fixtures (e.g. a tiny `.ts`/`.cs` file for extractors) under the module's directory.

**Out of scope** (do NOT touch): the modules under test, any other source, the test runner config (`scripts/run-vitest-batches.mjs`).

## Git workflow

- Branch: `test/024-characterization`
- One commit per module: `test(<area>): characterize <module>`.

## Per-module recipe (apply to each, top to bottom)

For each module: read it fully → read the named exemplar test to match harness
style (temp DB / mock http / fixture loading) → write tests that assert the
**current** observable behavior on representative + edge inputs.

Concretely, the top 6:

1. **sqlite-vault-store**: temp DB; upsert a file → read back; add chunks/symbols/edges → query; run an FTS search and assert hits; re-open the DB and assert persistence; apply the schema twice and assert idempotence (migration-safe). Assert delete cascades.
2. **server-system-routes**: mock the route context + ring buffer (as `server-vault-routes.test.ts` mocks ctx); GET `/api/logs` returns the buffer; assert a log entry containing a secret-shaped string is already redacted (the buffer sanitizes at write time — assert it stays redacted on read and is valid JSON); hit `/api/identity`/system routes for shape.
3. **stage-agents**: drive the stage with a minimal bootstrap context (model after `bootstrap-stages.test.ts`); assert orchestrator/agents are wired after success; assert a failing dependency surfaces a clear error (no silent partial init).
4. **config-catalog**: load from a fixture catalog file; assert provider/model entries parse; assert behavior on a missing/corrupt catalog file (fallback, not crash).
5. **supervisor-feedback**: call each `buildSupervisor*Narrative` with realistic + boundary inputs (empty arrays, nulls); assert the markdown structure (headings/sections) is well-formed and doesn't throw.
6. **framework-drift**: feed before/after framework snapshots with a known change (field rename / new decorator); assert drift is detected and the expected event/telemetry shape is produced.

Modules 7–11: same approach, lighter (routes → request/response shape + validation; extractors → parse a fixture and assert extracted symbols + line ranges; vault-sync-tool → assert tool name/description/input schema).

**Verify (per module)**: `npx vitest run <new test>` → pass; `npm run typecheck:src` → 0.

## Test plan

- One `*.test.ts` per module, co-located, modeled on the named exemplar.
- Characterization only: tests encode what the code does today; a surprising result is a bug report (STOP), not a test you bend to pass.

## Done criteria

ALL must hold:

- [ ] Each module in scope has a co-located `*.test.ts` that passes
- [ ] `npm run typecheck:src` exits 0; `npm test` (or the targeted batch) green
- [ ] No source module under test was modified (`git diff --name-only` shows only `*.test.ts` + fixtures)
- [ ] `plans/README.md` row updated (note which modules done if partial)

## STOP conditions

- A characterization test exposes a real defect (e.g. `sqlite-vault-store` loses data on re-open, a route leaks an unsanitized secret, an extractor mis-ranges symbols). STOP, write up the repro, report — do not fix in this plan.
- A module cannot be tested without a refactor for testability (no injection seam). Report the seam needed; do not refactor the source here.
- A "fixture" would need to be enormous (e.g. a full Unity project). Use the smallest representative input and note the limit.

## Maintenance notes

- These tests are the safety net for plans 027 and 028 — keep them green through those refactors.
- When a module gains behavior, extend its characterization test in the same PR.
- Lowest-value item (#11, 26-line tool) can be skipped if time-boxed; record that in the index rather than silently dropping it.
