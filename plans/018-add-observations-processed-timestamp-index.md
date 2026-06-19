# Plan 018: Add composite (processed, timestamp) index for unprocessed-observation scans

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP condition" occurs, stop and report. When done, update this plan's row
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat cc8f814..HEAD -- src/learning/storage/learning-storage.ts`
> If it changed, compare the "Current state" excerpts to live code before proceeding; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `cc8f814`, 2026-06-19

## Why this matters

The learning pipeline drains unprocessed observations on a recurring cadence via
`getUnprocessedObservations`, which runs:

```sql
SELECT * FROM observations WHERE processed = 0 ORDER BY timestamp ASC LIMIT ?
```

Neither existing index serves this query: `idx_observations_type_processed` is
keyed `(type, processed)` (leading column `type`, unusable for a bare
`processed=0` filter) and `idx_observations_timestamp` is `(timestamp DESC)`
(wrong direction, doesn't cover the filter). SQLite therefore scans the
`observations` table and sorts. As the table grows over a long-running agent's
life, every pipeline tick pays an O(n log n) scan+sort. A single composite index
`(processed, timestamp ASC)` turns this into an index range-scan (no sort).

## Current state

- `src/learning/storage/learning-storage.ts`:
  - `SCHEMA_SQL` template literal begins at **line 48** and is executed via `this.db.exec(SCHEMA_SQL)` at **line 265** on every init. All `CREATE INDEX` statements use `IF NOT EXISTS`, so adding one is idempotent and applies to existing DBs on next open.
  - The observations index block, **lines 199–200**:
    ```sql
    CREATE INDEX IF NOT EXISTS idx_observations_type_processed ON observations(type, processed);
    CREATE INDEX IF NOT EXISTS idx_observations_timestamp ON observations(timestamp DESC);
    ```
  - The query, **line 925** (inside the prepared-statement map):
    ```ts
    getUnprocessedObservations: `SELECT * FROM observations WHERE processed = 0 ORDER BY timestamp ASC LIMIT ?`,
    ```
- Test exemplar to model after: `src/learning/storage/learning-storage.test.ts` (exists, ~1312 lines) — uses a temp/in-memory better-sqlite3 DB. Match its setup/teardown harness.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck:src` | exit 0 |
| Targeted test | `npx vitest run src/learning/storage/learning-storage.test.ts` | all pass |
| Grep index | `grep -n "idx_observations_processed_timestamp" src/learning/storage/learning-storage.ts` | 1+ match |

## Scope

**In scope**:
- `src/learning/storage/learning-storage.ts` (add the index to `SCHEMA_SQL`)
- `src/learning/storage/learning-storage.test.ts` (add the verification test)

**Out of scope** (do NOT touch):
- The existing `idx_observations_timestamp` (DESC) — other reads may rely on DESC ordering; leave it in place.
- The query text at line 925 — do not change behavior, only make it index-served.
- Any migration/ALTER logic — `CREATE INDEX IF NOT EXISTS` in `SCHEMA_SQL` covers existing DBs.

## Git workflow

- Branch: `perf/018-observations-index`
- Commit message: `perf(learning): add (processed, timestamp) index for unprocessed-observation scans`

## Steps

### Step 1: Add the composite index

In `SCHEMA_SQL`, directly after line 200 (`idx_observations_timestamp`), add:
```sql
CREATE INDEX IF NOT EXISTS idx_observations_processed_timestamp ON observations(processed, timestamp ASC);
```

**Verify**: `npm run typecheck:src` → exit 0; `grep -n "idx_observations_processed_timestamp"` → 1 match.

### Step 2: Add a test proving the index serves the query

In `learning-storage.test.ts`, following the file's existing temp-DB harness, add a test:
- Insert a mix of processed (`processed=1`) and unprocessed (`processed=0`) observations with varied timestamps.
- Call the storage method that runs `getUnprocessedObservations` and assert it returns only unprocessed rows in ascending-timestamp order, respecting `LIMIT`.
- Assert the index is used: run `db.prepare("EXPLAIN QUERY PLAN SELECT * FROM observations WHERE processed = 0 ORDER BY timestamp ASC LIMIT ?").all(10)` and assert at least one step's `detail` contains `idx_observations_processed_timestamp`.

**Verify**: `npx vitest run src/learning/storage/learning-storage.test.ts` → all pass, including the new test.

## Test plan

- New test cases (in `learning-storage.test.ts`): (1) correct rows + ascending order + LIMIT honored; (2) `EXPLAIN QUERY PLAN` references `idx_observations_processed_timestamp`.
- Model the DB setup after the existing tests in that file.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck:src` exits 0
- [ ] `npx vitest run src/learning/storage/learning-storage.test.ts` passes incl. the new test
- [ ] `grep -n "idx_observations_processed_timestamp" src/learning/storage/learning-storage.ts` → match in `SCHEMA_SQL`
- [ ] No files outside scope modified (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- `EXPLAIN QUERY PLAN` does NOT pick the new index even on a populated table (>1000 rows). SQLite may prefer a scan on tiny tables — if it refuses the index on a large table, STOP and report (the index definition or column order may be wrong).
- The `observations` table or `processed` column name differs from this excerpt (schema drift) — STOP.

## Maintenance notes

- If a future query needs `WHERE processed = 0 AND type = ? ORDER BY timestamp`, revisit — a `(processed, type, timestamp)` index may then dominate and this one could be dropped.
- Reviewer should confirm no behavioral change to `getUnprocessedObservations` results — only the access path changes.
