# Plan 026: Close the Windows CI gap — run lint + cross-platform tests

> **Executor instructions**: Follow step by step. Run every verification command.
> On any "STOP condition", stop and report. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat cc8f814..HEAD -- .github/workflows/ci.yml`
> If changed, compare excerpts to live code; on mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `cc8f814`, 2026-06-19

## Why this matters

The Linux CI job runs the full gate (typecheck + lint + full test + portal +
build). The **Windows job runs only `typecheck:src` + 4 integration tests +
build** — no lint, no security/path tests. Yet Windows is exactly where this
codebase's platform-specific risks live: `AGENTS.md` documents path-containment
that must use `path.sep`/`path.isAbsolute` (not `"/"`/`startsWith("/")`) and
`.cmd` spawning needing `shell:true` (CVE-2024-27980). A path-policy or
lint regression in that area can land on `main` green. This plan adds the
cheap, highest-value Windows coverage without blowing the 30-minute budget.

## Current state

`.github/workflows/ci.yml` — `windows-verify` job (lines 74–108) runs, in order:
checkout → setup-node 22 → `npm ci` → `npm ci --prefix web-portal` →
`npm run typecheck:src` → `npm exec vitest run src/tests/integration/source-launcher.test.ts src/common/runtime-paths.test.ts src/core/setup-doctor.test.ts src/core/terminal-wizard.test.ts` → `npm run build`.

Missing vs Linux: **`npm run lint:src`** and any **path-safety / security /
config** tests. The Linux `verify` job already proves these pass on Linux; the
goal is to catch *platform-divergent* breakage, not to duplicate the whole suite
(which would risk the timeout).

## Commands you will need (locally, to choose the test set)

| Purpose | Command | Expected |
|---|---|---|
| Lint | `npm run lint:src` | exit 0 |
| List candidate path/security tests | `ls src/vault/path-policy.test.ts src/security/*.test.ts src/config/config.test.ts src/common/*.test.ts` | confirm which exist |
| Run a candidate subset locally | `npx vitest run <files>` | all pass (sanity before adding to CI) |

## Scope

**In scope**:
- `.github/workflows/ci.yml` — the `windows-verify` job only.

**Out of scope** (do NOT touch):
- The Linux `verify` job.
- `package.json` scripts, source, or tests.
- Running the **entire** suite on Windows (timeout risk) — add a curated subset only.

## Git workflow

- Branch: `ci/026-windows-parity`
- Commit: `ci(windows): run lint and cross-platform path/security tests`

## Steps

### Step 1: Add a lint step to the Windows job

After the `Typecheck` step (line ~102) add:
```yaml
      - name: Lint
        run: npm run lint:src
```
`eslint src/` is fast and platform-cheap; this closes the largest gap (lint never ran on Windows).

### Step 2: Expand the Windows test subset with platform-sensitive suites

Confirm which of these exist (Step "Commands"), then extend the existing
`npm exec vitest run …` step (line ~105) to add the path/security/config suites
that exercise `path.sep`/`isAbsolute`/`.cmd`-spawn logic. Recommended additions
(keep only those that exist and pass locally):
- `src/vault/path-policy.test.ts`
- `src/security/auth-hardened.test.ts` (or the security path/traversal suite present)
- `src/config/config.test.ts`

Keep them in the **same** `vitest run` invocation (one process) to limit startup
overhead. Do **not** add slow integration/e2e suites.

**Verify (locally, simulating)**: `npx vitest run <the full chosen list>` → all pass; estimate runtime stays well under the 30-min job timeout.

### Step 3: Confirm YAML validity

**Verify**: `grep -n "name: Lint" .github/workflows/ci.yml` shows the new step under `windows-verify`; indentation matches sibling steps (6 spaces for `- name:`). If a YAML linter is available (`npx --no-install yaml-lint` or similar), run it; otherwise visually confirm structure.

## Test plan

- No new test files. The change is CI coverage: lint + a curated cross-platform test set now run on Windows.
- Acceptance is observed on the next Windows CI run (the operator triggers CI); locally, the chosen `vitest run` set must pass.

## Done criteria

ALL must hold:

- [ ] `windows-verify` job contains a `Lint` step running `npm run lint:src`
- [ ] The Windows `vitest run` step includes the path-policy + security + config suites that exist
- [ ] `npm run lint:src` and the chosen `npx vitest run <set>` pass locally
- [ ] YAML is valid; only `ci.yml` changed (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- Adding the chosen test subset pushes the Windows job near the 30-min timeout (measure locally; Windows runners are ~2–3× slower). If so, trim to path-policy + lint only and report the trade-off.
- `npm run lint:src` fails **only conceptually** on Windows because a rule reads platform paths — that is itself a finding; STOP and report rather than disabling the rule.
- A chosen test is flaky/platform-dependent in a way that isn't a real bug — report it; do not add `.skip`.

## Maintenance notes

- This is a curated subset by design. When new path/spawn-sensitive modules are added, extend the Windows `vitest run` list in the same spirit.
- Reviewer should confirm no full-suite run crept onto Windows (timeout protection).
- Follow-up deferred: a shared reusable workflow to DRY the Linux/Windows steps (not in scope).
