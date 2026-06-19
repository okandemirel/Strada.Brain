# Plan 025: Collapse per-entry writes in `archiveOldEntries` into one transaction

> **Executor instructions**: Follow step by step. Run every verification command.
> On any "STOP condition", stop and report. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat cc8f814..HEAD -- src/memory/unified/agentdb-adapter.ts`
> If changed, compare excerpts to live code; on mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `cc8f814`, 2026-06-19

## Why this matters

`archiveOldEntries` issues **one SQLite write per archived entry**. Archiving
during consolidation can touch hundreds/thousands of entries, so this is N
separate write transactions (N fsyncs) where one transaction would do. On a busy
memory store this stalls the consolidation pipeline and amplifies disk I/O.

## Current state

`src/memory/unified/agentdb-adapter.ts`:
- The N+1 loop (lines 712–726):
  ```ts
  async archiveOldEntries(before: TimestampMs): Promise<Result<number, Error>> {
    try {
      let archived = 0;
      for (const original of await this.listRawEntries()) {
        if ((original.createdAt as number) < (before as number) && !original.archived) {
          const entry: AdapterInternalEntry = { ...original, archived: true };
          this.persistMutableEntry(entry);   // ← one write per entry
          archived++;
        }
      }
      return ok(archived);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }
  ```
- `persistMutableEntry` (lines 900–903) delegates to a private agentdb method via cast:
  ```ts
  private persistMutableEntry(entry: AdapterInternalEntry): void {
    const internals = this.agentdb as unknown as AgentDBAdapterInternals;
    internals.persistEntry(entry);
  }
  ```
- `listRawEntries` (line 865) gathers entries across `MEMORY_TIERS` via `this.agentdb.getByTier(tier)`.

The store is `better-sqlite3` (synchronous), which supports `db.transaction(fn)`
to wrap many statements in one commit. The fix is to run the per-entry persists
inside a single transaction.

## Investigation (Step 0 — do this first)

Find the `AgentDBAdapterInternals` type and the agentdb implementation it casts
to. Determine which of these the agentdb exposes (search the agentdb module):
- (A) a `transaction(fn)` / `runInTransaction(fn)` method, or a `db` handle whose `.transaction` can be used, **or**
- (B) a batch method like `persistEntries(entries[])`.

Record which exists. This decides the implementation branch below. If **neither**
exists, STOP and report — adding a transaction API to agentdb itself is a
separate decision, not in this plan's blast radius.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck:src` | exit 0 |
| Lint | `npm run lint:src` | exit 0 |
| Targeted test | `npx vitest run src/memory/unified/agentdb-adapter.test.ts` | all pass |

## Scope

**In scope**:
- `src/memory/unified/agentdb-adapter.ts` (`archiveOldEntries`, and a private batch helper if needed)
- `src/memory/unified/agentdb-adapter.test.ts` (regression test)

**Out of scope** (do NOT touch unless Step 0 proves a one-line seam already exists there):
- The agentdb core implementation / its public interface — if a new method on agentdb is required, STOP and surface it as a follow-up.
- Other callers of `persistMutableEntry` (lines 404, 610) — leave their per-call semantics unchanged.

## Git workflow

- Branch: `perf/025-archive-transaction`
- Commit: `perf(memory): archive old entries in a single transaction`

## Steps

### Step 1: Wrap the archive writes in one transaction

Branch on Step 0's finding:
- **(A)** Wrap the loop body's persists in the agentdb transaction: collect the
  `archived: true` entries first, then commit them inside one
  `transaction(() => { for (const e of toArchive) internals.persistEntry(e); })`.
- **(B)** Build the `toArchive` array, then call the batch persist once.

Preserve the return contract: `ok(archived)` with the same count, and the same
`err(...)` mapping on failure (the whole archive must roll back atomically on a
mid-batch error — that is a behavior improvement, note it).

**Verify**: `npm run typecheck:src` → 0; `npm run lint:src` → 0.

### Step 2: Regression test

In `agentdb-adapter.test.ts` (model after its existing temp-store harness): insert
entries with mixed `createdAt` (some older than `before`, some newer, some already
`archived`); call `archiveOldEntries(before)`; assert:
- returned count equals the number of old, not-yet-archived entries,
- exactly those entries are now `archived` (newer/already-archived untouched),
- the persists happened via the single transaction/batch seam from Step 0 (spy on it and assert it was invoked once, not once-per-entry).

**Verify**: `npx vitest run src/memory/unified/agentdb-adapter.test.ts` → all pass.

## Test plan

- New test: "archiveOldEntries commits in a single transaction and archives only matching entries".
- Assert the batch/transaction seam is called once (the perf contract) and the data outcome is correct.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck:src` and `npm run lint:src` exit 0
- [ ] New test passes; archive seam invoked once (not N times)
- [ ] `archiveOldEntries` still returns `ok(count)` with identical counts to the old behavior on the test fixture
- [ ] No out-of-scope files modified; `plans/README.md` row updated

## STOP conditions

- Step 0 finds **no** transaction or batch seam on agentdb — STOP; do not invent one inline (it changes agentdb's contract).
- Wrapping in a transaction changes the archived **count** or which entries are archived on the test fixture — investigate; the loop's filter must be preserved exactly.
- `getByTier`/`listRawEntries` turns out to be async-paginated such that the full set can't be materialized safely — STOP and report.

## Maintenance notes

- After this lands, archiving is atomic (all-or-nothing). A reviewer should confirm that's acceptable for the consolidation caller (it is generally desirable — partial archives were a latent inconsistency).
- If `persistEntry` ever becomes async, the transaction wrapper must switch to the async-safe form agentdb provides.
