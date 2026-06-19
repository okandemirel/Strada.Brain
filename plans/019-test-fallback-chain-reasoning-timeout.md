# Plan 019: Characterization tests for fallback-chain reasoning-timeout detection

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result. If a "STOP condition"
> occurs, stop and report. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat cc8f814..HEAD -- src/agents/providers/fallback-chain.ts src/agents/providers/fallback-chain.test.ts`
> If changed, compare the excerpts below to live code before proceeding; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `cc8f814`, 2026-06-19

## Why this matters

`FallbackChainProvider` has subtle, safety-relevant error-classification logic
that is **completely untested**: it distinguishes an external reasoning-model
timeout (CDN/proxy aborting a long thinking request) from a deliberate cancel,
and in single-provider mode it **auto-disables thinking** so the provider can
respond next time. If the regexes or the guard conditions drift, the feature
fails silently — a single-provider reasoning model gets stuck timing out, or
thinking is disabled when it shouldn't be. Tests lock the contract.

## Current state

`src/agents/providers/fallback-chain.ts`:
- Regexes (lines 38–40):
  ```ts
  const ABORT_RE = /abort/i;
  const CANCEL_RE = /cancel/i;
  const TASK_INTERRUPTED_RE = /task\.interrupted/i;
  ```
- Detection + auto-disable (lines 351–371):
  ```ts
  const isReasoningTimeout = ABORT_RE.test(errorMsg)
    && provider.capabilities.thinkingSupported
    && !CANCEL_RE.test(errorMsg)
    && !TASK_INTERRUPTED_RE.test(errorMsg);

  if (isReasoningTimeout) {
    logger.warn(`Possible reasoning model timeout (${label})`, { ... });
    // single-provider mode only:
    if (isSingleProvider && !health.isThinkingDisabled(provider.name)) {
      health.disableThinking(provider.name);
      logger.warn("Auto-disabled thinking for single provider after reasoning timeout", { ... });
    }
  }
  ```
  where `const isSingleProvider = this.providers.length === 1;` (line 312) and
  `health` is the provider-health registry the chain holds.
- Test file: `src/agents/providers/fallback-chain.test.ts` exists (~401 lines).
  `grep -n "ABORT\|CANCEL\|TASK_INTERRUPTED\|disableThinking" fallback-chain.test.ts`
  returns **nothing** today — this path is unexercised.

**Before writing tests, read `fallback-chain.test.ts` fully** to reuse its
existing harness: how it constructs a `FallbackChainProvider`, how it builds mock
providers (with `capabilities.thinkingSupported`), and how it injects/observes
the health registry (it already tests QUOTA cooldowns at a sibling code path, so
a seam for observing health exists — use the same one).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Targeted test | `npx vitest run src/agents/providers/fallback-chain.test.ts` | all pass |
| Typecheck | `npm run typecheck:src` | exit 0 |

## Scope

**In scope**:
- `src/agents/providers/fallback-chain.test.ts` (add tests only)

**Out of scope** (do NOT touch):
- `src/agents/providers/fallback-chain.ts` — this is a characterization plan; capture current behavior, do not change it. If you find a *bug* while testing, STOP and report it rather than fixing it here.
- The provider-health registry implementation.

## Git workflow

- Branch: `test/019-fallback-reasoning-timeout`
- Commit message: `test(providers): cover fallback-chain reasoning-timeout detection`

## Steps

### Step 1: Read the harness

Read `fallback-chain.test.ts` and the QUOTA-cooldown test in it; identify the mock-provider builder and how `health` (disableThinking / isThinkingDisabled) is observed or spied.

**Verify**: you can state which helper builds a provider with `capabilities.thinkingSupported: true` and how to assert `health.disableThinking` was called.

### Step 2: Add a `describe("reasoning-timeout detection")` block

Cover these cases (one `it` each). Use an error whose message contains the trigger word; make the chain fail with that error so the classification path at lines 313–371 runs:

1. **abort + thinkingSupported + single provider** → `health.disableThinking(name)` called exactly once; a "reasoning model timeout" warning is logged.
2. **abort + CANCEL present** (e.g. message `"request abort: cancel"`) → NOT classified as reasoning timeout; `disableThinking` NOT called.
3. **abort + `task.interrupted` present** → NOT classified; `disableThinking` NOT called.
4. **abort + multi-provider** (`providers.length > 1`) → warning may log, but `disableThinking` NOT called (single-provider-only guard).
5. **abort + `thinkingSupported: false`** → NOT classified; `disableThinking` NOT called.
6. **already disabled** (single provider, `isThinkingDisabled` returns true) → `disableThinking` NOT called again (idempotence).

**Verify**: `npx vitest run src/agents/providers/fallback-chain.test.ts` → all pass; the 6 new tests appear in the run.

## Test plan

- 6 new `it` cases as above, in `fallback-chain.test.ts`, modeled on the existing QUOTA-cooldown test's structure.
- Each asserts on `health` interactions (called / not called), not on log strings (logs are incidental).

## Done criteria

ALL must hold:

- [ ] `npx vitest run src/agents/providers/fallback-chain.test.ts` passes, ≥6 new tests
- [ ] `grep -n "disableThinking" src/agents/providers/fallback-chain.test.ts` → matches
- [ ] `npm run typecheck:src` exits 0
- [ ] `src/agents/providers/fallback-chain.ts` unchanged (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- The health registry cannot be observed from the test (no injectable seam / spy point). Report what seam is missing rather than refactoring source.
- Driving the chain to fail with a controlled error message is not possible with the existing mock harness. Report the gap.
- A test reveals the detection logic is actually wrong (e.g. `CANCEL_RE`/`/cancel/i` also matches a legitimate timeout word). STOP and report as a bug — do not "fix" in this test-only plan.

## Maintenance notes

- These regexes are intentionally broad (`/abort/i`, `/cancel/i`). If provider error messages change, update both the source regexes and these tests together.
- If reasoning-timeout handling is extended to multi-provider mode in future, case 4 must be revisited.
