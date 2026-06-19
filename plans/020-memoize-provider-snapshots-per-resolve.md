# Plan 020: Memoize provider intelligence snapshots within a routing decision

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result. On any "STOP condition", stop and report. When
> done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat cc8f814..HEAD -- src/agent-core/routing/provider-router.ts`
> If changed, compare the excerpts below to live code; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW–MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `cc8f814`, 2026-06-19

## Why this matters

Every routing decision reconstructs each provider's intelligence snapshot
**O(N²) times**. `resolve()` loops over N providers calling `scoreProvider`
(line 224); inside, `costScore` maps over **all** providers calling
`getSnapshot` for each (line 545) plus the entry (line 553), and
`getFeatureFit`/`capabilityScore`/`speedScore` each call `getSnapshot` again
(lines 510, 596, 620). `getSnapshot` builds a fresh snapshot every call (no
cache, line 491) — and `getProviderIntelligenceSnapshot` derives workload
scores, feature tags, and behavioral-profile merges each time. For a typical
4-provider chain that is ~40+ full snapshot constructions per decision, on a
hot path hit on every orchestrator phase. Memoizing snapshots for the duration
of a single `resolve()`/`resolveRanked()` call collapses this to N constructions
with zero behavioral change.

## Current state

`src/agent-core/routing/provider-router.ts`:
- `resolve(...)` (line 177) — synchronous; loops `scoreProvider` (lines 223–246), returns a `RoutingDecision`. No `await` inside the loop.
- `resolveRanked(...)` (line 268) — same scoring over all providers (line 297–300), synchronous.
- `resolveWithCatalog(...)` (line 311) — calls `this.resolve(...)` (line 321), so it inherits any memoization placed in `resolve`.
- The uncached snapshot accessor (lines 491–499):
  ```ts
  private getSnapshot(entry: AvailableProvider) {
    return getProviderIntelligenceSnapshot(
      entry.name,
      entry.defaultModel,
      this.modelIntelligence,
      entry.capabilities ?? this.providerManager.getProviderCapabilities?.(entry.name, entry.defaultModel),
      entry.label,
    );
  }
  ```
  Note: `getProviderIntelligenceSnapshot` can return a falsy/empty snapshot for unknown providers (callers already handle `if (!snapshot)` — see `getFeatureFit` line 511). The memo must therefore distinguish "not yet computed" from "computed null" (use `Map.has`, not a truthiness check).
- `getSnapshot` callers to confirm coverage: lines 510, 545, 553, 596, 620.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck:src` | exit 0 |
| Lint | `npm run lint:src` | exit 0 |
| Targeted test | `npx vitest run src/agent-core/routing/provider-router.test.ts` | all pass |

## Scope

**In scope**:
- `src/agent-core/routing/provider-router.ts`
- `src/agent-core/routing/provider-router.test.ts` (add a regression test; create if absent — first confirm with `ls`)

**Out of scope** (do NOT touch):
- `getProviderIntelligenceSnapshot` itself (`src/agents/providers/provider-knowledge.ts`) — do not add a long-lived cache there; this plan's memo is strictly per-decision to avoid any staleness across catalog/provider changes.
- Scoring formulas — selection output must be byte-for-byte identical.

## Git workflow

- Branch: `perf/020-snapshot-memo`
- Commit: `perf(routing): memoize provider snapshots within a routing decision`

## Steps

### Step 1: Add a per-decision memo field

Add a private field (type it to `getSnapshot`'s return, e.g.
`private snapshotMemo: Map<string, ReturnType<ProviderRouter["getSnapshot"]>> | null = null;`,
or define a local alias if the inline generic is awkward).

### Step 2: Make `getSnapshot` consult the memo

Rewrite `getSnapshot` so that **when `this.snapshotMemo` is non-null** it returns
the memoized value (keyed by `` `${entry.name}:${entry.defaultModel}` ``) using
`has`/`get` to cache even null/empty results; when the memo is null it behaves
exactly as today (constructs and returns without caching).

### Step 3: Open/close the memo around each public scoring entry point

In `resolve()` and `resolveRanked()`, set `this.snapshotMemo = new Map()` at the
start of the scoring work and reset it to `null` in a `finally` so it never
leaks past the call. (`resolveWithCatalog` delegates to `resolve`, so it is
covered.) Because these methods are synchronous, a single shared field is safe —
no concurrent decision can interleave.

**Verify** after 1–3: `npm run typecheck:src` → 0; `npm run lint:src` → 0.

### Step 4: Regression test — selection unchanged + snapshot built once per provider

In `provider-router.test.ts`, add a test that mocks/spies
`getProviderIntelligenceSnapshot` (via `vi.mock` of `provider-knowledge`, or a
counter injected through the existing test harness — match how the file already
constructs a `ProviderRouter`) and asserts:
- For an N-provider `resolve()`, the snapshot factory is invoked **at most N times** (was ~N²).
- The chosen provider (`decision.provider`) is identical with and without the memo for a fixed fixture (guard against behavior change).

**Verify**: `npx vitest run src/agent-core/routing/provider-router.test.ts` → all pass.

## Test plan

- New tests in `provider-router.test.ts`: (1) snapshot-factory call count ≤ N per `resolve`; (2) identical selection on a fixed multi-provider fixture; (3) `resolveRanked` ordering unchanged.
- If no test file exists, create one modeled on a sibling router/provider test for harness shape.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck:src` and `npm run lint:src` exit 0
- [ ] `npx vitest run src/agent-core/routing/provider-router.test.ts` passes incl. new tests
- [ ] Snapshot-factory call count test proves ≤ N constructions per decision
- [ ] `this.snapshotMemo` is reset to `null` in a `finally` in both `resolve` and `resolveRanked`
- [ ] No files outside scope modified; `plans/README.md` row updated

## STOP conditions

- `getProviderIntelligenceSnapshot` cannot be spied/counted with the existing harness (no injection seam). Report rather than refactoring `provider-knowledge.ts`.
- Memoization changes the selected provider on any existing test fixture (indicates a snapshot is being mutated by a caller — investigate, do not paper over).
- `resolve()` turns out to be `async`/contains `await` between memo open and close (drift) — STOP; the single-field memo is only safe for synchronous scoring.

## Maintenance notes

- The memo is intentionally per-call. Do NOT promote it to a long-lived field without wiring invalidation on provider add/remove and catalog refresh — stale economics/capabilities would corrupt routing.
- If scoring becomes async in future, switch from a shared field to a memo object threaded through the call (passed as a parameter) to remain race-free.
