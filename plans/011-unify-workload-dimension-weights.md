# Plan 011: Make behavioral profiles the authoritative workload scores; demote feature-flag derivation to fallback

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat aea95ad..HEAD -- src/agents/providers/provider-knowledge.ts src/agents/providers/provider-knowledge.test.ts src/agents/providers/provider-behavioral-profiles.ts src/agents/providers/provider-behavioral-profiles.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (provider routing depends on these scores)
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

Two parallel systems score providers per workload. `provider-behavioral-profiles.ts` holds the research-backed 12-provider × 12-dimension scores and the workload→dimension weights (documented as "single source of truth"). But `provider-knowledge.ts:deriveWorkloadScores` ALSO computes scores from a second, hardcoded feature-flag formula table and then blends the two 40/60 — so for known providers the final routing score is partly driven by an undocumented shadow formula, and the two tables can silently disagree. Making the behavioral profile authoritative for known providers (feature-flag derivation only as fallback for unknown providers / unmapped workloads) gives one explainable scoring path and removes the duplicate formula table from the routing-critical path.

Note: an earlier audit claimed the dimension weights themselves were duplicated — that is no longer true (provider-knowledge.ts imports `WORKLOAD_DIMENSION_WEIGHTS` at line 10). What remains duplicated is the parallel *feature-flag* scoring formula plus the blend.

## Current state

- `src/agents/providers/provider-behavioral-profiles.ts` (262 lines):
  - `WorkloadType` (lines 66-72): `planning | implementation | review | analysis | coordination | debugging` — **no `documentation`**.
  - `WORKLOAD_DIMENSION_WEIGHTS` (lines 82-124) — dimension weights per workload, exported, doc comment says single source of truth.
  - `STATIC_BASELINE_PROFILES` (lines 172-185) — 12 providers: claude, openai, kimi, gemini, deepseek, qwen, minimax, mistral, groq, together, fireworks, ollama.
  - `getBaselineProfile(providerId)` (196-198) — lowercase/trim lookup, `undefined` for unknown.
  - `rankProvidersForWorkload` (240-262) — pure behavioral composite, already weight-table-driven.
  - HAS a test file: `provider-behavioral-profiles.test.ts` (369 lines).
- `src/agents/providers/provider-knowledge.ts` (538 lines):
  - `ProviderWorkload` (lines 12-19): the 6 WorkloadTypes PLUS `documentation`.
  - `getBehavioralWorkloadScore` (298-309) — computes the behavioral composite from the shared weight table; returns `undefined` for workloads without a mapping (i.e. `documentation`).
  - Blend constants (311-314):

```ts
/** Weight for existing feature-flag based scores when blending with behavioral profiles. */
const FEATURE_FLAG_WEIGHT = 0.4;
/** Weight for behavioral profile scores when blending. */
const BEHAVIORAL_PROFILE_WEIGHT = 0.6;
```

  - `deriveWorkloadScores` (316-372): builds `featureFlagScores` from capability/feature heuristics (the hardcoded formula table at lines 340-348, e.g. `planning: clamp(0.35*thinking + 0.25*context + 0.15*toolCalling + 0.15*search + 0.10*reviewer)`), then for known providers blends `featureFlag*0.4 + behavioral*0.6` per workload (361-369); unknown providers get pure featureFlagScores (355-357); `documentation` always stays featureFlag (behavioral score undefined).
  - `getProviderIntelligenceSnapshot` (382-458) — the only caller of `deriveWorkloadScores` (line 456).
- Consumers of the resulting `workloadScores` (routing-critical):
  - `src/agent-core/routing/provider-router.ts:580` — `const workloadScore = snapshot.workloadScores[workload] ?? 0.4;` and line 638 (explanation string).
  - `src/agents/multi/delegation/delegation-manager.ts:766` — `const workloadScore = snapshot.workloadScores[workload] ?? 0.5;`
  - Display-only: `src/tasks/command-handler.ts:599`, `src/dashboard/server-provider-routes.ts:217-270`, `src/agents/orchestrator-supervisor-routing.ts:563` (via `buildProviderIntelligence`).
- Tests today: `provider-knowledge.test.ts` (160 lines) — includes "derives workload scores from generic capabilities" (line 95). No characterization of per-provider blended outputs exists yet.

## Target behavior

In `deriveWorkloadScores`:

1. Known provider (`getBaselineProfile` returns a profile): each workload with a behavioral mapping uses the **pure behavioral composite** (`getBehavioralWorkloadScore`, clamped). No blending.
2. Known provider, workload WITHOUT a behavioral mapping (today: only `documentation`): keep the feature-flag score.
3. Unknown provider: pure feature-flag scores (unchanged fallback).
4. Delete `FEATURE_FLAG_WEIGHT` / `BEHAVIORAL_PROFILE_WEIGHT`.
5. Keep the feature-flag formula table — it is the documented fallback, not dead code. Update the function's doc comment to state the precedence rule explicitly.

This intentionally CHANGES scores for known providers (e.g. claude/planning moves from `0.4*featureFlag + 0.6*0.9365` to `0.9365`). The characterization workflow below makes that drift explicit and reviewed.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck:src` | exit 0 |
| Targeted tests | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/providers/provider-knowledge.test.ts src/agents/providers/provider-behavioral-profiles.test.ts` | all pass |
| Router tests | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agent-core/routing` | all pass |
| Delegation tests | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/multi/delegation` | all pass |
| Lint | `npm run lint:src` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/agents/providers/provider-knowledge.ts` (only `deriveWorkloadScores`, the two blend constants, and doc comments)
- `src/agents/providers/provider-knowledge.test.ts` (characterization + new precedence tests)

**Out of scope** (do NOT touch):
- `src/agents/providers/provider-behavioral-profiles.ts` and its test — the weight table and baseline scores are the source of truth and must not be retuned here.
- `src/agent-core/routing/provider-router.ts`, `src/agents/multi/delegation/delegation-manager.ts` — consumers adapt to new score values automatically; do not adjust their thresholds/fallback constants (0.4 / 0.5) in this plan.
- Adding `documentation` to `WorkloadType`/`WORKLOAD_DIMENSION_WEIGHTS` — separate product decision (see Maintenance notes).
- Dashboard/command-handler display code.

## Git workflow

- Branch: `advisor/011-unify-workload-scores`
- Conventional commits, e.g. `test(providers): characterize current workload score blend` then `refactor(providers): behavioral profiles authoritative for known-provider workload scores`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Characterization test capturing CURRENT blended scores (commit before refactoring)

In `provider-knowledge.test.ts`, add `describe("workload score characterization")`:

- For ALL 12 known providers (`claude, openai, kimi, gemini, deepseek, qwen, minimax, mistral, groq, together, fireworks, ollama`), call `getProviderIntelligenceSnapshot(name, undefined, undefined, FIXED_CAPS, name)` with one fixed capability snapshot, e.g. `{ contextWindow: 200_000, supportsVision: true, supportsThinking: true, supportsToolCalling: true, supportsStreaming: true, specialFeatures: [] }`, and snapshot `workloadScores` for all 7 workloads.
- Generate the expected values by RUNNING the current code (write the test with placeholder expectations, run vitest once, paste actual values rounded via `toBeCloseTo(x, 3)`). Do not hand-compute.
- Add one unknown provider case (e.g. `"someprovider"`) asserting its scores equal the pure feature-flag values (also captured by running).
- Commit this test passing against the CURRENT code.

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/providers/provider-knowledge.test.ts` → all pass (new characterization included), then commit.

### Step 2: Refactor deriveWorkloadScores

Implement "Target behavior" 1-5 above. The diff is confined to lines ~311-372 of provider-knowledge.ts. Sketch:

```ts
function deriveWorkloadScores(snapshot: {...}): Record<ProviderWorkload, number> {
  // ... existing feature computation and featureFlagScores table unchanged ...
  const profile = snapshot.providerName ? getBaselineProfile(snapshot.providerName) : undefined;
  if (!profile) return featureFlagScores;            // fallback: unknown provider
  const scores = { ...featureFlagScores };           // covers unmapped workloads (documentation)
  for (const workload of Object.keys(featureFlagScores) as ProviderWorkload[]) {
    const behavioral = getBehavioralWorkloadScore(profile, workload);
    if (behavioral !== undefined) scores[workload] = clamp(behavioral);
  }
  return scores;
}
```

Update the doc comment on `getBehavioralWorkloadScore`/`deriveWorkloadScores` to state: "Behavioral baseline is authoritative for known providers; feature-flag heuristics are the fallback for unknown providers and for workloads without a behavioral mapping (documentation)."

**Verify**: `npm run typecheck:src` → exit 0. `grep -n "FEATURE_FLAG_WEIGHT\|BEHAVIORAL_PROFILE_WEIGHT" src/` → no matches. The Step-1 characterization test now FAILS for known providers (expected) and still PASSES for the unknown provider and `documentation` rows.

### Step 3: Re-baseline the characterization with documented drift

- Re-run the characterization, update the expected values for known providers to the new pure-behavioral numbers.
- Above the updated expectations add a comment block: `// INTENTIONAL DRIFT (plan 011, 2026-06-11): scores moved from 0.4*featureFlag + 0.6*behavioral to pure behavioral for known providers.` and include 2-3 example before→after pairs taken from the Step-2 failure output (e.g. `claude/planning 0.8x → 0.937`).
- Sanity assertions to keep permanently: for the fixed snapshot, `documentation` score is IDENTICAL before/after for known providers; unknown-provider scores are identical before/after; every score is within [0, 1]; for `claude`, `planning` score now equals the `rankProvidersForWorkload("planning")` composite for claude within 0.001 (cross-system consistency — the whole point of the unification).

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/providers/provider-knowledge.test.ts src/agents/providers/provider-behavioral-profiles.test.ts` → all pass.

### Step 4: Run the routing-side consumers' suites

**Verify**:
`NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agent-core/routing` → all pass.
`NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/multi/delegation` → all pass.
If either suite fails because a test pinned an old blended score, update only score LITERALS in those tests (note each in the commit message); if a failure is about ORDERING of providers changing, treat it as a STOP condition.

### Step 5: Lint and final gate

**Verify**: `npm run lint:src` → exit 0; `npm run typecheck:src` → exit 0.

## Test plan

- Step 1 characterization: 12 known providers × 7 workloads + 1 unknown provider, against the pre-refactor code (committed first).
- Step 3 re-baseline: same matrix against post-refactor code with the intentional-drift comment, plus the 4 permanent invariants (documentation unchanged, unknown-provider unchanged, range [0,1], claude/planning ≡ rankProvidersForWorkload composite).
- New precedence unit tests in `provider-knowledge.test.ts`: known provider + mapped workload → behavioral value; known provider + `documentation` → feature-flag value; unknown provider → feature-flag value.
- Pattern to model: existing tests in `provider-knowledge.test.ts` (`getProviderIntelligenceSnapshot` describes at line 47).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "FEATURE_FLAG_WEIGHT\|BEHAVIORAL_PROFILE_WEIGHT" src/` returns nothing
- [ ] `npm run typecheck:src` exits 0
- [ ] `npx vitest run src/agents/providers/provider-knowledge.test.ts src/agents/providers/provider-behavioral-profiles.test.ts src/agent-core/routing src/agents/multi/delegation` (with `NODE_OPTIONS=--max-old-space-size=8192`) exits 0
- [ ] Characterization test contains the `INTENTIONAL DRIFT (plan 011 ...)` comment with before→after examples
- [ ] `npm run lint:src` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `deriveWorkloadScores` no longer matches the lines-316-372 excerpt (drift since `aea95ad`).
- A routing or delegation test fails because the relative ORDER of providers for a workload changed in a way the test asserts semantically (not just a pinned number) — provider routing behavior change needs human sign-off.
- You find another caller of `deriveWorkloadScores` or a second blend site beyond `getProviderIntelligenceSnapshot:456` (`grep -rn "deriveWorkloadScores" src/` should return exactly the definition + line 456 + this plan).
- Step 1 characterization cannot be made deterministic (scores vary between runs) — that would mean hidden state in snapshot construction.

## Maintenance notes

- Reviewer should scrutinize the Step-3 drift table: the biggest behavioral-vs-blend gaps move routing the most (strong providers get stronger, e.g. claude/planning rises; weak-on-paper providers may drop).
- Known trade-off accepted by this plan: pure-behavioral scores for known providers no longer reflect per-MODEL capability differences (e.g. a claude model without tool calling still scores claude's baseline `implementation`). If that bites, the fix is per-model profiles, not re-adding the blend.
- Deferred follow-ups: (1) add `documentation` to `WorkloadType` + `WORKLOAD_DIMENSION_WEIGHTS` so the last feature-flag path for known providers disappears; (2) `analysis` weights in the behavioral table don't use `toolCallReliability` while the feature-flag formula used `search`/`vision` — flag to the profile owner; (3) the memory note "Workload dimension weights duplicated between behavioral-profiles and provider-knowledge" should be updated/removed once this lands.
