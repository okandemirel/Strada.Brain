# Plan 023: Make provider-snapshot DB load resilient to a single corrupt row

> **Executor instructions**: Follow step by step. Run every verification command.
> On any "STOP condition", stop and report. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat cc8f814..HEAD -- src/agents/providers/model-intelligence.ts`
> If changed, compare the excerpt below to live code; on mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `cc8f814`, 2026-06-19

## Why this matters

`ModelIntelligence.loadFromDb()` deserializes provider snapshots inside a single
`try/catch` that wraps the **whole loop**. Because the three `JSON.parse` calls
run per row but the only `catch` is outside the loop, one malformed row throws
and **aborts loading every remaining provider snapshot** — silently (the catch
swallows with a "DB might be empty" comment). The result is a partially-populated
provider-intelligence map with no log, degrading routing/feature decisions until
the next successful refresh, with nothing to point at the cause. A per-row guard
isolates the damage to the one bad row and logs which provider/field failed.

## Current state

`src/agents/providers/model-intelligence.ts`, `loadFromDb()` (lines 1036–1062):

```ts
private loadFromDb(): void {
  if (!this.db) return;

  try {
    const rows = this.stmtGetAll.all() as ModelRow[];
    for (const row of rows) {
      this.models.set(row.id, rowToModelInfo(row));
    }
  } catch {
    // DB might be empty on first run
  }

  try {
    const snapshotRows = this.stmtGetProviderSnapshots.all() as ProviderSnapshotRow[];
    for (const row of snapshotRows) {
      this.providerSnapshots.set(row.provider, {
        provider: row.provider,
        lastUpdated: row.last_updated,
        sourceUrls: JSON.parse(row.source_urls_json) as string[],
        signals: JSON.parse(row.signals_json) as ProviderOfficialSnapshot["signals"],
        featureTags: JSON.parse(row.feature_tags_json) as string[],
      });
    }
  } catch {
    // DB might be empty or older schema on first run
  }
}
```

The bug is the second block: a `JSON.parse` failure on any row exits the entire
loop. First, confirm the logger available in this file (search the top of the
file for the existing logger import, e.g. `getLogger`/`getLoggerSafe`) and reuse
it — do not introduce a new logging dependency.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck:src` | exit 0 |
| Lint | `npm run lint:src` | exit 0 |
| Targeted test | `npx vitest run src/agents/providers/model-intelligence.test.ts` | all pass |

## Scope

**In scope**:
- `src/agents/providers/model-intelligence.ts` (the snapshot-load loop only)
- `src/agents/providers/model-intelligence.test.ts` (add a regression test)

**Out of scope** (do NOT touch):
- The models-load block (lines 1039–1046) — `rowToModelInfo` is a separate concern; leave it unless it too does an unguarded per-row `JSON.parse` (if so, note it for a follow-up, do not expand scope here).
- Schema, prepared statements, or write path (`saveToDb`).

## Git workflow

- Branch: `fix/023-snapshot-load-resilience`
- Commit: `fix(model-intelligence): isolate corrupt provider-snapshot rows on load`

## Steps

### Step 1: Move the try/catch inside the snapshot loop

Keep an outer guard around `this.stmtGetProviderSnapshots.all()` (empty/older
schema is still tolerated), then wrap the per-row body in its own `try/catch`:
on failure, log a `warn` with `{ provider: row.provider, err }` and `continue` to
the next row instead of aborting. A good row must still load even when a sibling
row is corrupt.

### Step 2: Add a regression test

In `model-intelligence.test.ts`, model after the file's existing DB-backed tests:
seed the snapshot table (or its prepared-statement source) with one **valid** row
and one row whose `signals_json` is `"{not json"`; trigger a load (reopen /
re-init the instance against the same DB); assert:
- the valid provider's snapshot **is** present in `providerSnapshots`,
- the corrupt provider's snapshot is **absent** (skipped, not fatal),
- the load did not throw.

**Verify**: `npx vitest run src/agents/providers/model-intelligence.test.ts` → all pass.

## Test plan

- New test: "skips an unparseable provider-snapshot row and still loads the rest".
- Reuse the file's temp-DB / prepared-statement harness; do not invent a new one.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck:src` and `npm run lint:src` exit 0
- [ ] New test passes: a corrupt row no longer drops sibling snapshots
- [ ] Per-row `try/catch` with a `warn` log present in `loadFromDb`
- [ ] No files outside scope modified; `plans/README.md` row updated

## STOP conditions

- The test harness cannot seed a raw snapshot row with controlled JSON (no seam to write `signals_json` directly). Report what seam is needed.
- `rowToModelInfo` in the models block is found to JSON-parse unguarded too — note it and STOP for a scope decision rather than silently widening this plan.

## Maintenance notes

- If a new JSON column is added to `provider_official_snapshot`, include it in the same per-row guard.
- Reviewer should confirm the outer empty-DB tolerance is preserved (first-run with no table must still be a no-op, not a thrown error).
